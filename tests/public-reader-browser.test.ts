import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/index.ts";

/* ISS-14: the public reader colours a code block by its language, like the
 *  editor — before the fix the block was plain text. Pages seed over the
 *  real HTTP boundary; a guest reads the public link in a real browser. */

const password = "public-reader-password-2026";

test("the public reader highlights a code block by its language", async ({ page, browser }) => {
  const directory = await mkdtemp(join(tmpdir(), "public-reader-"));
  const server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1" });
  try {
    const r = await page.request.post(`${server.url}/api/auth/register`, {
      data: { handle: "readerowner", displayName: "readerowner", password },
    });
    expect(r.status()).toBe(201);
    const login = await page.request.post(`${server.url}/api/auth/login`, {
      data: { handle: "readerowner", password },
    });
    expect(login.status()).toBe(200);

    const created = await page.request.post(`${server.url}/api/v1/pages`, {
      data: {
        title: "代码页",
        markdown: "正文一行。\n\n```ts\nconst message: string = \"hi\";\n```\n\n```\nplain words <not-coloured>\n```",
      },
    });
    expect(created.status()).toBe(201);
    const pageId = (await created.json()).id;
    const share = await page.request.post(`${server.url}/api/shares`, { data: { pageId } });
    expect(share.status()).toBe(201);
    const token = String((await share.json()).url).replace("/s/", "");

    const guest = await browser.newContext();
    const reader = await guest.newPage();
    await reader.goto(`${server.url}/s/${token}`);

    const blocks = reader.locator(".public-reader__content pre");
    await expect(blocks).toHaveCount(2);

    // The TypeScript block carries hljs-coloured tokens.
    const typed = blocks.first().locator("code");
    await expect(typed.locator("span.hljs-keyword")).toContainText("const", { timeout: 8000 });
    await expect(typed).toContainText("const message: string = \"hi\";");

    // A block with no language stays uncoloured — readable text, no spans.
    const plain = blocks.nth(1).locator("code");
    await expect(plain.locator("span")).toHaveCount(0);
    await expect(plain).toContainText("plain words <not-coloured>");

    await reader.screenshot({ path: "test-results/public-reader-code.png" });
    await guest.close();
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
