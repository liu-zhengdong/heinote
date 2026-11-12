import { test as base, expect, type Page } from "@playwright/test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";
import { ZipStream } from "../src/core/zip.ts";

// UC-21: importing an Obsidian vault turns each .base into a database
// page whose matched notes become rows. This browser flow uploads a
// vault zip through the wizard and opens the imported database in the
// real renderer — board grouped by status with the groupOrder columns.
type App = Awaited<ReturnType<typeof startServer>>;
const password = "Import-base-browser-password-2026!";
const evidence = resolve(".evidence/data-import");

const test = base.extend<{ app: App; scratch: string }>({
  app: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "notes-import-base-browser-"));
    let server: App | undefined;
    try {
      server = await startServer({ dataDir: directory, host: "127.0.0.1", port: 0, github: null });
      await use(server);
    } finally {
      await server?.close();
      const target = resolve(directory);
      expect(dirname(target)).toBe(resolve(tmpdir()));
      expect(basename(target)).toMatch(/^notes-import-base-browser-/);
      await rm(target, { recursive: true, force: true });
    }
  },
  scratch: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "import-base-scratch-"));
    await use(directory);
    await rm(directory, { recursive: true, force: true });
  },
});
test.use({ trace: "off", screenshot: "off", video: "off", deviceScaleFactor: 2 });

function settings(page: Page) { return page.getByRole("dialog", { name: "账号设置", exact: true }); }

async function register(page: Page, app: App, handle: string) {
  await page.goto(app.url);
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.locator('input[name="handle"]').fill(handle);
  await page.locator('input[name="displayName"]').fill(handle);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "注册", exact: true }).click();
  const identity = page.getByRole("button", { name: "切换空间", exact: true });
  const pages = page.getByRole("button", { name: "All pages", exact: true });
  await expect.poll(async () => await identity.isVisible() || await pages.isVisible()).toBe(true);
  if (!await identity.isVisible()) await pages.click();
  await expect(identity).toBeVisible();
}

async function screenshot(page: Page, name: string) {
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, `${name}@2x.png`), fullPage: true, animations: "disabled" });
}

async function vaultZip(path: string) {
  const chunks: Uint8Array[] = [];
  const zip = new ZipStream({ write: (chunk) => chunks.push(chunk) });
  await zip.add("vault/.obsidian/app.json", "{}");
  await zip.add("vault/候选/卡A.md", "---\ncreated: 2026-10-21\nstatus: 候选\npriority: P1\n---\n卡A 正文");
  await zip.add("vault/候选/卡B.md", "---\ncreated: 2026-10-20\nstatus: 已排期\npriority: P2\n---\n卡B 正文");
  await zip.add("vault/候选/卡C.md", "---\ncreated: 2026-10-19\nstatus: 已完成\npriority: P3\n---\n卡C 正文");
  await zip.add("vault/看板.base", `filters:
  and:
    - file.inFolder("候选")
properties:
  status:
    displayName: 状态
views:
  - type: cards
    name: 看板
    groupBy:
      property: status
      direction: ASC
    groupOrder:
      - 候选
      - 已排期
      - 已完成
    order:
      - file.name
      - status
      - priority
      - created
`);
  zip.finish();
  await writeFile(path, Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))));
}

test(".base 转成数据库页，看板按状态分组渲染", async ({ page, app, scratch }) => {
  await register(page, app, "baseimporter");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(settings(page)).toBeVisible();
  const dialog = settings(page);
  await dialog.getByRole("tab", { name: "数据", exact: true }).or(dialog.getByRole("button", { name: "数据", exact: true })).click();
  await dialog.locator('[data-setting="import-obsidian"]').click();
  await expect(dialog.getByRole("group", { name: "从 Obsidian 导入", exact: true })).toBeVisible();

  const zipPath = join(scratch, "vault.zip");
  await vaultZip(zipPath);
  await page.locator('input[type="file"][accept*=".zip"]').setInputFiles(zipPath);
  await expect(dialog.getByText("vault.zip", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "开始导入", exact: true }).click();
  await expect(dialog.getByText(/导入完成：/)).toBeVisible({ timeout: 20000 });
  await dialog.getByRole("button", { name: /打开「/ }).click();

  // Expand the imported root and open the database page in the tree.
  const tree = page.getByRole("tree", { name: "Files", exact: true });
  await tree.getByRole("button", { name: "Expand Obsidian 导入 — vault", exact: true }).click();
  const vaultExpand = tree.getByRole("button", { name: "Expand vault", exact: true });
  if (await vaultExpand.isVisible().catch(() => false)) await vaultExpand.click();
  await tree.getByRole("button", { name: "看板", exact: true }).click();

  // The database page renders as a board: three status columns, one card each.
  await expect(page.locator(".board .board__column").first()).toBeVisible({ timeout: 15000 });
  const columnText = await page.locator(".board__column-head").allInnerTexts();
  const order = ["候选", "已排期", "已完成"].map((name) => columnText.findIndex((text) => text.includes(name)));
  expect(order.every((index) => index >= 0), JSON.stringify(columnText)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b)); // groupOrder preserved
  const cards = page.locator(".board__card-title");
  await expect(cards).toHaveCount(3);
  const cardText = await cards.allInnerTexts();
  expect(cardText.join("|")).toContain("卡A");
  expect(cardText.join("|")).toContain("卡B");
  expect(cardText.join("|")).toContain("卡C");
  await screenshot(page, "import-base-board-1440x900");
});
