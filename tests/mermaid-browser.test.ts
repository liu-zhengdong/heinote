import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";

let server: Awaited<ReturnType<typeof startServer>>;
let directory: string;

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-mermaid-browser-"));
  server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1" });
});
test.afterAll(async () => {
  await server?.close();
  if (directory) {
    const target = resolve(directory);
    expect(dirname(target)).toBe(resolve(tmpdir()));
    expect(basename(target)).toMatch(/^notes-mermaid-browser-/);
    await rm(target, { recursive: true, force: true });
  }
});

async function register(page: Page, handle: string) {
  await page.goto(server.url);
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.locator('input[name="handle"]').fill(handle);
  await page.locator('input[name="displayName"]').fill(handle);
  await page.locator('input[name="password"]').fill("Mermaid-test-password-2026");
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await expect(page.getByRole("button", { name: "切换空间", exact: true })).toBeVisible();
}

test("a mermaid code block draws its diagram and keeps it in step with the source", async ({ page }) => {
  await register(page, "mermaid-user");
  await page.getByRole("button", { name: "New page", exact: true }).first().click();
  const paragraph = page.locator('.block__editable[contenteditable="true"]').first();
  await paragraph.click();
  await paragraph.pressSequentially("```mermaid ");
  const code = page.locator(".block--code").first();
  await expect(code.getByRole("combobox", { name: "Code language" })).toContainText("Mermaid");

  // Typing into the block: the diagram appears once Pele's chunk lands.
  await code.locator('.block__editable[contenteditable="true"]').pressSequentially("flowchart LR\n  Start --> End");
  const diagram = code.locator(".mermaid svg");
  await expect(diagram).toBeVisible({ timeout: 20000 });
  await expect(diagram).toContainText("Start");

  // Edits redraw: a node renamed shows up in the SVG.
  const editable = code.locator('.block__editable[contenteditable="true"]');
  await editable.click();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("Finish");
  await expect(diagram).toContainText("Finish", { timeout: 20000 });

  // Broken syntax: the mount keeps the block usable and shows its own error.
  await editable.press("End");
  await editable.press("Enter");
  await editable.pressSequentially("this is not : a diagram -->");
  await expect(code.locator(".pele-error")).toBeVisible({ timeout: 20000 });
  await expect(editable).toBeVisible();
});

test("a shared page shows the diagram to a guest", async ({ page, browser }) => {
  await register(page, "mermaid-share");
  await page.getByRole("button", { name: "New page", exact: true }).first().click();
  await expect(page).toHaveURL(/page=/);
  const pageId = new URL(page.url()).searchParams.get("page")!;
  const paragraph = page.locator('.block__editable[contenteditable="true"]').first();
  await paragraph.click();
  await paragraph.pressSequentially("```mermaid ");
  const code = page.locator(".block--code").first();
  await code.locator('.block__editable[contenteditable="true"]').pressSequentially("sequenceDiagram\n  读者->>笔记: 打开分享页\n  笔记-->>读者: 出图");
  await code.locator(".mermaid svg").waitFor({ timeout: 30000 });

  // The editor commits asynchronously in batches: wait for the code
  // block's drawn source — the very text the diagram renders — to sit
  // server-side before sharing, or the guest reads a page with a
  // half-typed diagram. The block's DOM text is what pele drew, so the
  // record matching it means the shareable page is the drawn one.
  const drawn = await code.locator('.block__editable[contenteditable="true"]').innerText();
  await expect.poll(async () => {
    const rows = await (await page.request.get(`${server.url}/api/records/personal/blocks`)).json();
    return rows.some((row: { value: { kind?: string; language?: string; page?: string; content?: { text?: string }[] } }) =>
      row.value.page === pageId && row.value.kind === "code" && row.value.language === "mermaid" &&
      (row.value.content ?? []).map((run) => run.text ?? "").join("") === drawn);
  }, { timeout: 15000 }).toBe(true);

  let status = 0;
  let body: { url?: string } = {};
  await expect.poll(async () => {
    const reply = await page.request.post(`${server.url}/api/shares`, { data: { pageId } });
    status = reply.status();
    body = await reply.json().catch(() => ({}));
    return status;
  }, { timeout: 10000 }).toBe(201);
  const token = String(body.url).replace("/s/", "");

  const guest = await browser.newContext();
  const reader = await guest.newPage();
  await reader.goto(`${server.url}/s/${token}`);
  const diagram = reader.locator(".mermaid svg");
  await expect(diagram).toBeVisible({ timeout: 30000 });
  await expect(diagram).toContainText("读者");
  // The reader gets the picture alone: no editor, no language picker.
  await expect(reader.locator('.block__editable[contenteditable="true"]')).toHaveCount(0);
  await expect(reader.locator(".block__code-lang")).toHaveCount(0);
  await guest.close();
});

test("an unparseable diagram still leaves the source editable", async ({ page }) => {
  await register(page, "mermaid-errors");
  await page.getByRole("button", { name: "New page", exact: true }).first().click();
  const paragraph = page.locator('.block__editable[contenteditable="true"]').first();
  await paragraph.click();
  await paragraph.pressSequentially("```mermaid ");
  const code = page.locator(".block--code").first();
  await code.locator('.block__editable[contenteditable="true"]').pressSequentially("flowchart LR\n  A --> {{(");
  await expect(code.locator(".pele-error")).toBeVisible({ timeout: 20000 });
  await expect(code.locator('.block__editable[contenteditable="true"]')).toBeEditable();
});
