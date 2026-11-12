import { chromium } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/index.ts";

const out = process.argv[2] ?? ".evidence/iss06";
const directory = await mkdtemp(join(tmpdir(), "notes-iss06-shot-"));
const server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1" });
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 })).newPage();
try {
  await page.goto(server.url);
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.locator('input[name="handle"]').fill("iss06");
  await page.locator('input[name="displayName"]').fill("iss06");
  await page.locator('input[name="password"]').fill("Iss06-password-2026!");
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await page.getByRole("button", { name: "切换空间", exact: true }).waitFor();

  // A page with a public link.
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.locator('.menu[role="menu"]').getByRole("menuitem", { name: "页面", exact: true }).click();
  const title = page.getByLabel("Page title", { exact: true });
  await title.fill("发布笔记");
  await page.getByRole("button", { name: "Share", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: /^Share / });
  await dialog.getByRole("button", { name: "创建链接", exact: true }).click();
  await dialog.locator(".public-links__url").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${out}/share-dialog-status@2x.png` });
  await dialog.getByRole("button", { name: "Close sharing", exact: true }).click();

  // The shared view: 与我共享 / 我共享的 / 公开链接.
  await page.getByRole("tab", { name: "Shared", exact: true }).click();
  await page.getByRole("tree", { name: "Shared", exact: true }).getByRole("button", { name: "新建共享页面", exact: true }).first().click();
  const created = page.getByRole("dialog", { name: /^Share / });
  await created.locator(".share__status").waitFor();
  await page.screenshot({ path: `${out}/share-dialog-shared@2x.png` });
  await created.getByRole("button", { name: "Close sharing", exact: true }).click();
  const tree = page.getByRole("tree", { name: "Shared", exact: true });
  await tree.getByRole("heading", { name: "公开链接" }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.locator(".sidebar").screenshot({ path: `${out}/sidebar-shared-view@2x.png`, animations: "disabled", scale: "device" });
} finally {
  await browser.close();
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
