import { test as base, expect, type Page, type TestInfo } from "@playwright/test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";
import { ZipStream } from "../src/core/zip.ts";

// UC-20: the 导入 group exposes Obsidian / Notion entries that open a
// pick → confirm → upload wizard; a finished import creates a real page tree.
type App = Awaited<ReturnType<typeof startServer>>;
const password = "Import-browser-password-2026!";
const evidence = resolve("docs/evidence/data-import");

const test = base.extend<{ app: App; scratch: string }>({
  app: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "notes-import-browser-"));
    let server: App | undefined;
    try {
      server = await startServer({ dataDir: directory, host: "127.0.0.1", port: 0, github: null });
      await use(server);
    } finally {
      await server?.close();
      const target = resolve(directory);
      expect(dirname(target)).toBe(resolve(tmpdir()));
      expect(basename(target)).toMatch(/^notes-import-browser-/);
      await rm(target, { recursive: true, force: true });
    }
  },
  scratch: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "import-scratch-"));
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

async function openData(page: Page) {
  const entry = page.getByRole("button", { name: "设置", exact: true });
  const pages = page.getByRole("button", { name: "All pages", exact: true });
  await expect.poll(async () => await entry.isVisible() || await pages.isVisible()).toBe(true);
  if (!await entry.isVisible()) await pages.click();
  await entry.click();
  await expect(settings(page)).toBeVisible();
  const dialog = settings(page);
  await dialog.getByRole("tab", { name: "数据", exact: true }).or(dialog.getByRole("button", { name: "数据", exact: true })).click();
}

async function screenshot(page: Page, name: string) {
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, `${name}@2x.png`), fullPage: true, animations: "disabled" });
}

async function notionZip(path: string) {
  const chunks: Uint8Array[] = [];
  const zip = new ZipStream({ write: (chunk) => chunks.push(chunk) });
  await zip.add("Notion导出/Inbox [aaaabbbbcccc].md", "# Inbox\n\n<page url=\"https://app.notion.com/p/xxxxxxxxxxxxxxxxxxxxxdddddddddddd\">\n子页面\n</page>\n");
  await zip.add("Notion导出/子页面 [dddddddddddd].md", "# 子页面\n\n- [x] 已完成\n\n<table header-row=\"true\">\n<tr><td>\n列\n</td></tr>\n</table>\n");
  zip.finish();
  await writeFile(path, Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))));
}

test("导入组呈现品牌行，Notion 向导跑完并建立页面树", async ({ page, app, scratch }) => {
  await register(page, app, "importer");
  await openData(page);

  const dialog = settings(page);
  await expect(dialog.getByRole("heading", { name: "导出", exact: true })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "导入", exact: true })).toBeVisible();
  const obsidian = dialog.locator('[data-setting="import-obsidian"]');
  const notion = dialog.locator('[data-setting="import-notion"]');
  await expect(obsidian).toBeVisible();
  await expect(notion).toBeVisible();
  await screenshot(page, "import-rows-light-1440x900");

  await obsidian.click();
  await expect(dialog.getByRole("group", { name: "从 Obsidian 导入", exact: true })).toBeVisible();
  await expect(dialog.getByText("选择 Obsidian 库文件夹", { exact: true })).toBeVisible();
  await screenshot(page, "import-wizard-obsidian-pick");
  await dialog.getByRole("button", { name: "关闭导入", exact: true }).click();

  const zipPath = join(scratch, "notion.zip");
  await notionZip(zipPath);
  await notion.click();
  await page.locator('input[type="file"][accept*=".zip"]').setInputFiles(zipPath);
  await expect(dialog.getByText("notion.zip", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/2 篇笔记/)).toBeVisible();
  await screenshot(page, "import-wizard-notion-confirm");
  await dialog.getByRole("button", { name: "开始导入", exact: true }).click();

  await expect(dialog.getByText(/导入完成：3 个页面/)).toBeVisible({ timeout: 20000 });
  await screenshot(page, "import-wizard-done");
  await dialog.getByRole("button", { name: /打开「Notion 导入」/ }).click();
  await expect(dialog).toBeHidden();

  const pagesResponse = await page.request.get(`${app.url}/api/records/personal/pages`);
  const titles = (await pagesResponse.json()).map((row: { value: { title_content?: { text?: string }[] } }) => row.value.title_content?.map((run) => run.text ?? "").join(""));
  expect(titles).toContain("Notion 导入");
  expect(titles).toContain("Inbox");
  expect(titles).toContain("子页面");
});

test("深色与窄屏下导入行不破版", async ({ page, app }) => {
  await register(page, app, "importer_dark");
  const entry = page.getByRole("button", { name: "设置", exact: true });
  const pagesButton = page.getByRole("button", { name: "All pages", exact: true });
  await expect.poll(async () => await entry.isVisible() || await pagesButton.isVisible()).toBe(true);
  if (!await entry.isVisible()) await pagesButton.click();
  await entry.click();
  await expect(settings(page)).toBeVisible();
  const dialog = settings(page);
  await dialog.getByRole("tab", { name: "偏好", exact: true }).or(dialog.getByRole("button", { name: "偏好", exact: true })).click();
  await expect(dialog.getByRole("combobox", { name: "外观", exact: true })).toBeEnabled();
  await dialog.getByRole("combobox", { name: "外观", exact: true }).click();
  await page.getByRole("listbox", { name: "外观", exact: true }).getByRole("option", { name: "深色", exact: true }).click();
  await dialog.getByRole("tab", { name: "数据", exact: true }).or(dialog.getByRole("button", { name: "数据", exact: true })).click();
  await expect(dialog.locator('[data-setting="import-obsidian"]')).toBeVisible();
  await screenshot(page, "import-rows-dark-1440x900");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.locator('[data-setting="import-notion"]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await screenshot(page, "import-rows-mobile-390x844");
});
