import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";

let server: Awaited<ReturnType<typeof startServer>>;
let directory: string;
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-select-browser-"));
  server = await startServer({ dataDir: directory, host: "127.0.0.1", port: 0 });
});
test.afterAll(async () => {
  await server?.close();
  if (directory) {
    const target = resolve(directory);
    expect(dirname(target)).toBe(resolve(tmpdir()));
    expect(basename(target)).toMatch(/^notes-select-browser-/);
    await rm(target, { recursive: true, force: true });
  }
});
test.beforeEach(async ({ page }) => { await page.goto(`${server.url}/components/select.html`); });

test("mouse selection keeps focus and submits the controlled value", async ({ page }) => {
  const field = page.getByRole("combobox", { name: "权限", exact: true });
  await field.click();
  const list = page.getByRole("listbox", { name: "权限", exact: true });
  await expect(list.getByRole("option", { name: "只读", exact: true })).toHaveAttribute("aria-selected", "true");
  await list.getByRole("option", { name: "读写", exact: true }).click();
  await expect(list).toBeHidden();
  await expect(field).toHaveText("读写");
  await expect(field).toBeFocused();
  await expect(page.getByRole("status")).toHaveText("");
  await page.getByRole("button", { name: "创建预览", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("已选择：读写");
  await expect(page.getByRole("combobox", { name: "禁用权限", exact: true })).toBeDisabled();
});

test("keyboard navigation skips disabled options and Escape cancels", async ({ page }, testInfo) => {
  const field = page.getByRole("combobox", { name: "站点角色", exact: true });
  await field.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  const list = page.getByRole("listbox", { name: "站点角色", exact: true });
  await expect(list.getByRole("option", { name: "访客（不可用）", exact: true })).toHaveAttribute("aria-disabled", "true");
  await page.screenshot({ path: testInfo.outputPath("select-disabled-option.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
  await expect(field).toHaveText("用户");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(field).toHaveText("管理员");
  await expect(field).toBeFocused();
});

test("typeahead reaches a long-list option and Tab advances without selecting", async ({ page }) => {
  const field = page.getByRole("combobox", { name: "代码语言", exact: true });
  await field.click();
  await page.keyboard.type("typescript");
  await page.keyboard.press("Enter");
  await expect(field).toHaveText("TypeScript");
  await field.click();
  await expect(page.getByRole("option", { name: "TypeScript", exact: true })).toBeInViewport();
  await page.keyboard.press("Home");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("listbox", { name: "代码语言", exact: true })).toBeHidden();
  await expect(field).toHaveText("TypeScript");
  await expect(field).not.toBeFocused();
});

test("groups preserve selection and clicking the trigger or outside closes", async ({ page }, testInfo) => {
  const field = page.getByRole("combobox", { name: "状态", exact: true });
  await field.click();
  const list = page.getByRole("listbox", { name: "状态", exact: true });
  await expect(list.getByRole("group")).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath("select-groups.png"), animations: "disabled" });
  await list.getByRole("option", { name: "已完成", exact: true }).click();
  await expect(field).toHaveText("已完成");
  await field.click();
  await field.click();
  await expect(list).toBeHidden();
  await field.click();
  await page.getByRole("heading", { name: "下拉选择", exact: true }).click();
  await expect(list).toBeHidden();
  await expect(field).toHaveAttribute("aria-expanded", "false");
});

test("Select closes before its parent dialog and parent popover", async ({ page }) => {
  await page.getByRole("button", { name: "在对话框中查看", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Select 对话框", exact: true });
  await dialog.getByRole("combobox").click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "在排序面板中查看", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "排序预览", exact: true });
  await panel.getByRole("combobox", { name: "Sort 1: direction", exact: true }).click();
  await page.getByRole("option", { name: "Sort descending", exact: true }).click();
  await expect(panel).toBeVisible();
  await panel.getByRole("combobox", { name: "Sort 1: direction", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

test("real account panel uses the shared field in both themes", async ({ page }, testInfo) => {
  await page.goto(server.url);
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.locator('input[name="handle"]').fill("select_owner");
  await page.locator('input[name="displayName"]').fill("Select 示例");
  await page.locator('input[name="password"]').fill("Select-example-password-2026!");
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await expect(page.getByRole("button", { name: "切换空间", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "切换空间", exact: true }).locator(".space-switcher__user")).toHaveText("Select 示例");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "偏好", exact: true }).click();
  const field = page.getByRole("combobox", { name: "外观", exact: true });
  await field.click();
  const list = page.getByRole("listbox", { name: "外观", exact: true });
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((next) => { document.documentElement.dataset.theme = next; }, theme);
    await expect(list).toHaveCSS("background-color", theme === "dark" ? "rgb(37, 37, 37)" : "rgb(255, 255, 255)");
    await page.screenshot({ path: testInfo.outputPath(`notes-account-select-${theme}.png`), animations: "disabled" });
  }
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tab", { name: "偏好", exact: true })).toBeVisible();
});

test("short-window lists scroll internally and close on viewport changes", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 400 });
  const field = page.getByRole("combobox", { name: "代码语言", exact: true });
  await field.click();
  const list = page.getByRole("listbox", { name: "代码语言", exact: true });
  await expect(list).toHaveCSS("opacity", "1");
  await expect(list).toHaveCSS("transform", "none");
  const box = (await list.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(400);
  await list.evaluate((element) => { element.scrollTop = 100; });
  await expect(field).toHaveAttribute("aria-expanded", "true");
  await page.setViewportSize({ width: 650, height: 420 });
  await expect(field).toHaveAttribute("aria-expanded", "false");
});

for (const theme of ["light", "dark"] as const) {
  test(`renders ${theme} desktop and mobile without clipping`, async ({ page }, testInfo) => {
    await page.getByRole("button", { name: theme === "light" ? "浅色" : "深色", exact: true }).click();
    const field = page.getByRole("combobox", { name: "权限", exact: true });
    await field.click();
    await expect(page.getByRole("listbox", { name: "权限", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`select-${theme}-desktop.png`), animations: "disabled" });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("combobox", { name: "代码语言", exact: true }).click();
    const list = page.getByRole("listbox", { name: "代码语言", exact: true });
    await expect(list).toBeVisible();
    await expect(list).toHaveCSS("opacity", "1");
    await expect(list).toHaveCSS("transform", "none");
    const box = (await list.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(844);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`select-${theme}-mobile.png`), animations: "disabled" });
  });
}
