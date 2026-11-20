import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";

/* UC-54: a member exports a page or a database from the ··· menu — Markdown
   for a document, CSV for a database's view, a zip once children ride along.
   UC-19 AC-03 rides too: the account export downloads through its button. */

let server: Awaited<ReturnType<typeof startServer>>;
let directory: string;
const password = "Export-browser-password-2026!";

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-export-browser-"));
  server = await startServer({ dataDir: directory, host: "127.0.0.1", port: 0 });
});
test.afterAll(async () => {
  await server?.close();
  if (directory) {
    const target = resolve(directory);
    expect(dirname(target)).toBe(resolve(tmpdir()));
    expect(basename(target)).toMatch(/^notes-export-browser-/);
    await rm(target, { recursive: true, force: true });
  }
});

async function register(page: Page, handle: string) {
  await page.goto(server.url);
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.locator('input[name="handle"]').fill(handle);
  await page.locator('input[name="displayName"]').fill(handle);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await expect(page.getByRole("button", { name: "切换空间", exact: true })).toBeVisible();
}

/* A write token for shaping pages and databases without clicks. */
async function createToken(page: Page): Promise<string> {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "Agent 令牌", exact: true }).click();
  await page.getByRole("button", { name: "新建令牌", exact: true }).click();
  await page.locator('input[name="tokenName"]').fill("export-test");
  await page.getByRole("radio", { name: "读写", exact: true }).click();
  await page.getByRole("button", { name: "创建", exact: true }).click();
  const value = await page.getByLabel("令牌", { exact: true }).inputValue();
  await page.getByRole("button", { name: "已保存", exact: true }).click();
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  return value;
}

async function agent(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${server.url}${path}`, {
    method,
    headers: { "authorization": `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

/** Opens the page and its ··· menu, picks a format, downloads. When the
 *  row sits under a folded branch, `under` expands that parent first. */
async function exportFormat(page: Page, title: string, format: string, under?: string): Promise<string> {
  if (under) {
    const expand = page.getByRole("button", { name: `Expand ${under}`, exact: true });
    if (await expand.count()) await expand.click();
  }
  await page.locator(".tree-row__main").filter({ hasText: title }).first().click();
  await page.getByRole("button", { name: "More page actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "导出…", exact: true }).click();
  await page.getByRole("radio", { name: format }).click();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).last().click();
  const download = await downloaded;
  const path = await download.path();
  expect(path).not.toBeNull();
  return download.suggestedFilename() ? readFile(path!, "utf-8") : "";
}

async function zipNames(buffer: Buffer): Promise<string[]> {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.length);
  // End of central directory: its count bounds how many records to walk back.
  let eocd = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 22 - 65536); at--) {
    if (view.getUint32(at, true) === 0x06054b50) { eocd = at; break; }
  }
  expect(eocd).toBeGreaterThanOrEqual(0);
  const count = view.getUint16(eocd + 10, true);
  const offset = view.getUint32(eocd + 16, true);
  const names: string[] = [];
  let at = offset;
  for (let index = 0; index < count; index++, at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    names.push(buffer.subarray(at + 46, at + 46 + view.getUint16(at + 28, true)).toString("utf-8"));
  }
  return names;
}

test("UC-54: a document exports as Markdown, a subtree as a zip of pages", async ({ page }) => {
  await register(page, "export_doc");
  const token = await createToken(page);
  const parent = await agent(token, "POST", "/api/v1/pages", { title: "导出父页", markdown: "# 父页标题\n\n父页正文。" });
  expect(parent.status).toBe(201);
  const child = await agent(token, "POST", "/api/v1/pages", { title: "导出子页", text: "子页正文。", parentId: parent.body.id });
  expect(child.status).toBe(201);
  await page.reload();

  const markdown = await exportFormat(page, "导出子页", "Markdown", "导出父页");
  expect(markdown).toContain("# 导出子页");
  expect(markdown).toContain("子页正文。");

  const html = await exportFormat(page, "导出子页", "HTML");
  expect(html).toContain("<article");
  expect(html).toContain("子页正文。");

  await page.locator(".tree-row__main").filter({ hasText: "导出父页" }).first().click();
  await page.getByRole("button", { name: "More page actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "导出…", exact: true }).click();
  await page.getByRole("radio", { name: "Markdown" }).click();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).last().click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("导出父页.zip");
  const names = await zipNames(await readFile(await download.path()!));
  expect(names).toContain("导出父页.md");
  expect(names).toContain("导出父页/导出子页.md");
});

test("UC-54: a database exports its view as CSV and rows as Markdown in a zip", async ({ page }) => {
  await register(page, "export_db");
  const token = await createToken(page);
  const db = await agent(token, "POST", "/api/v1/databases", {
    requestId: "export-db-1",
    title: "导出清单",
    database: {
      title_name: "名称",
      properties: [
        { id: "status", name: "状态", type: "status" },
        { id: "note", name: "备注", type: "text" },
      ],
      views: [{ id: "table", name: "全部", kind: "table" }],
    },
  });
  expect(db.status).toBe(201);
  const row = await agent(token, "POST", `/api/v1/databases/${db.body.id}/rows`, {
    requestId: "export-db-row-1",
    baseRevision: db.body.revision,
    title: "第一行",
    text: "行的正文。",
    properties: { status: "In progress", note: "a,b" },
  });
  expect(row.status).toBe(201);
  await page.reload();

  const csv = await exportFormat(page, "导出清单", "CSV");
  expect(csv).toContain("名称,状态,备注");
  expect(csv).toContain('第一行,In progress,"a,b"');

  await page.locator(".tree-row__main").filter({ hasText: "导出清单" }).first().click();
  await page.getByRole("button", { name: "More page actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "导出…", exact: true }).click();
  await page.getByRole("radio", { name: "Markdown" }).click();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).last().click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("导出清单.zip");
  const names = await zipNames(await readFile(await download.path()!));
  expect(names).toContain("导出清单.md");
  expect(names).toContain("导出清单/第一行.md");
});

test("UC-19 AC-03: the account export downloads a zip through its button", async ({ page }) => {
  await register(page, "export_account");
  await agent(await createToken(page), "POST", "/api/v1/pages", { title: "账号导出页", text: "正文。" });
  await page.reload();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "数据", exact: true }).click();
  const downloaded = page.waitForEvent("download");
  await page.locator('[data-setting="export-download"]').click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  const names = await zipNames(await readFile(await download.path()!));
  expect(names).toContain("export.json");
  expect(names.some((name) => name.endsWith("账号导出页.md"))).toBe(true);
});
