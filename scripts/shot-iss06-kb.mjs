import { chromium } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/index.ts";

const out = process.argv[2] ?? "docs/evidence/iss06";
const directory = await mkdtemp(join(tmpdir(), "notes-iss06-kb-"));
const server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1" });
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 })).newPage();
try {
  await page.goto(server.url);
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.locator('input[name="handle"]').fill("iss06kb");
  await page.locator('input[name="displayName"]').fill("iss06kb");
  await page.locator('input[name="password"]').fill("Iss06-password-2026!");
  await page.getByRole("button", { name: "注册", exact: true }).click();
  const switcher = page.getByRole("button", { name: "切换空间", exact: true });
  await switcher.waitFor();

  // Create a knowledge base through the UI.
  await switcher.click();
  await page.locator('.menu[role="menu"], .space-switcher-popover').last().getByRole("menuitem", { name: "新建团队知识库", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "新建团队知识库", exact: true });
  await modal.getByLabel("知识库名称", { exact: true }).fill("工程知识库");
  await modal.getByRole("button", { name: "创建团队知识库", exact: true }).click();
  await page.getByRole("dialog", { name: "新建团队知识库" }).waitFor({ state: "hidden" });
  await page.locator("article[data-page-id]").first().waitFor();

  // Inside the KB: no Shared tab, row menu has 拷贝到个人空间.
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.locator('.menu[role="menu"]').getByRole("menuitem", { name: "页面", exact: true }).click();
  const title = page.getByLabel("Page title", { exact: true });
  await title.fill("团队页面");
  const files = page.getByRole("tree", { name: "Files", exact: true });
  await files.getByRole("button", { name: "团队页面", exact: true }).hover();
  await page.getByRole("button", { name: "Actions for 团队页面", exact: true }).click();
  await page.getByRole("menuitem", { name: "拷贝到个人空间", exact: true }).waitFor();
  await page.screenshot({ path: `${out}/kb-row-menu@2x.png` });
  await page.getByRole("menuitem", { name: "拷贝到个人空间", exact: true }).click();
  await page.getByText("已拷贝到个人空间").first().waitFor();

  // Back in the personal space the copy is a normal private page.
  await switcher.click();
  await page.locator('.space-switcher-popover, .menu[role="menu"]').last().getByRole("menuitem").filter({ hasText: "个人空间" }).click();
  await files.getByRole("button", { name: "团队页面", exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.locator(".sidebar").screenshot({ path: `${out}/kb-sidebar-tabs@2x.png`, animations: "disabled", scale: "device" });
} finally {
  await browser.close();
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
