import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/index.ts";

/* UC-28: the public reader's left navigation keeps the shared tree's
 *  parent/child levels instead of a flat list. Pages seed over the real
 *  HTTP boundary; a guest reads the public link in a real browser. */

const password = "public-nav-password-2026";

async function makePage(page: Page, url: string, body: Record<string, string>): Promise<{ id: string }> {
  const created = await page.request.post(`${url}/api/v1/pages`, { data: body });
  expect(created.status()).toBe(201);
  return created.json();
}

async function shareToken(page: Page, url: string, pageId: string): Promise<string> {
  const share = await page.request.post(`${url}/api/shares`, { data: { pageId } });
  expect(share.status()).toBe(201);
  return String((await share.json()).url).replace("/s/", "");
}

test("the public reader's navigation shows the shared tree's levels", async ({ page, browser }) => {
  const directory = await mkdtemp(join(tmpdir(), "public-nav-"));
  const server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1" });
  try {
    const r = await page.request.post(`${server.url}/api/auth/register`, {
      data: { handle: "navowner", displayName: "navowner", password },
    });
    expect(r.status()).toBe(201);
    const login = await page.request.post(`${server.url}/api/auth/login`, {
      data: { handle: "navowner", password },
    });
    expect(login.status()).toBe(200);

    const root = await makePage(page, server.url, { title: "母页", text: "根正文" });
    await makePage(page, server.url, { title: "子页B", parentId: root.id, text: "B" });
    const childA = await makePage(page, server.url, { title: "子页A", parentId: root.id, text: "A" });
    const grandchild = await makePage(page, server.url, { title: "孙页", parentId: childA.id, text: "孙" });
    const token = await shareToken(page, server.url, root.id);

    const guest = await browser.newContext();
    const reader = await guest.newPage();
    await reader.goto(`${server.url}/s/${token}`);

    const nav = reader.locator(".public-reader__nav");
    const items = nav.locator("a");
    // Sorted by name under each parent, children after their parent.
    await expect(items).toHaveText(["母页", "子页A", "孙页", "子页B"]);

    const child = nav.getByRole("link", { name: "子页A" });
    const leaf = nav.getByRole("link", { name: "孙页" });
    const childBox = (await child.boundingBox())!;
    const leafBox = (await leaf.boundingBox())!;
    expect(leafBox.x, "a grandchild row sits to the right of its parent row").toBeGreaterThan(childBox.x);

    // Clicking a leaf switches the document and marks the row current.
    await leaf.click();
    await expect(reader.getByRole("heading", { name: "孙页", exact: true })).toBeVisible();
    await expect(leaf).toHaveAttribute("aria-current", "page");

    await reader.screenshot({ path: "test-results/public-nav-tree.png" });

    // A single-page share keeps no navigation at all.
    const lone = await makePage(page, server.url, { title: "单页", text: "alone" });
    const loneToken = await shareToken(page, server.url, lone.id);
    await reader.goto(`${server.url}/s/${loneToken}`);
    await expect(reader.locator(".public-reader__nav")).toHaveCount(0);
    await expect(reader.getByRole("heading", { name: "单页", exact: true })).toBeVisible();

    await guest.close();
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
