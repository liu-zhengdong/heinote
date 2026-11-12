import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/index.ts";

test("share suggestions float without pushing the roster", async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), "share-pop-"));
  const server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1" });
  try {
    const password = "share-pop-password-2026";
    for (const handle of ["ownerpop", "candidatea", "candidateb"]) {
      const r = await page.request.post(`${server.url}/api/auth/register`, {
        data: { handle, displayName: handle, password },
      });
      expect(r.status()).toBe(201);
    }
    const login = await page.request.post(`${server.url}/api/auth/login`, {
      data: { handle: "ownerpop", password },
    });
    expect(login.status()).toBe(200);
    const created = await page.request.post(`${server.url}/api/v1/pages`, {
      data: { title: "浮层验证", text: "正文" },
    });
    const pageId = (await created.json()).id;

    await page.goto(server.url);
    await page.goto(`${server.url}/?page=${pageId}`);
    await page.getByRole("button", { name: "Share", exact: true }).click();

    const rosterHeading = page.getByRole("heading", { name: "成员共享", exact: true });
    await expect(rosterHeading).toBeVisible();
    const before = (await rosterHeading.boundingBox())!;

    const input = page.getByLabel("Add people by handle");
    await input.fill("candidate");
    const listbox = page.getByRole("listbox", { name: "People" });
    await expect(listbox.getByRole("option")).toHaveCount(2, { timeout: 8000 });

    const after = (await rosterHeading.boundingBox())!;
    expect(after.y, "roster must not move down when suggestions open").toBe(before.y);

    // The popover floats below the invite field, covering content if needed.
    const fieldBox = (await page.locator(".share__field").boundingBox())!;
    const popBox = (await listbox.boundingBox())!;
    expect(popBox.y).toBeGreaterThanOrEqual(fieldBox.y + fieldBox.height);
    await page.screenshot({ path: "/tmp/share-popover.png" });

    // Outside press (above the field, outside the floating list) hides it
    // but keeps results; the dialog stays open.
    await page.getByText("私有", { exact: true }).click();
    await expect(listbox).toHaveCount(0);
    await expect(page.getByRole("dialog")).toBeVisible();

    // Arrow keys bring it back; Enter invites the highlighted person.
    await input.press("ArrowDown");
    await expect(listbox).toBeVisible();
    await input.press("Escape");
    await expect(listbox).toHaveCount(0);
    await expect(page.getByRole("dialog")).toBeVisible();

    // No-match message also floats, still without moving the roster.
    await input.fill("zzz-nobody");
    const empty = page.getByText("没有匹配的用户");
    await expect(empty).toBeVisible({ timeout: 8000 });
    const afterEmpty = (await rosterHeading.boundingBox())!;
    expect(afterEmpty.y).toBe(before.y);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
