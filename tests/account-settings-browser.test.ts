import { test as base, expect, type Locator, type Page, type Route, type TestInfo } from "@playwright/test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";

// UC-12: drive the production bundle and verify results through public HTTP APIs.
type App = Awaited<ReturnType<typeof startServer>>;
type User = { id: string; handle: string; displayName: string; siteRole: "admin" | "user" };
type RecordRow = { id: string; value: Record<string, unknown> };
type TokenMetadata = { id: string; name: string; access: "read" | "write" };
const password = "Account-settings-browser-password-2026!";
const evidence = resolve("docs/evidence/account-settings");
const profilePath = "**/api/account/profile";
const tokenPath = "**/api/tokens";

const test = base.extend<{ app: App; account: User }>({
  app: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "notes-account-settings-browser-"));
    let server: App | undefined;
    try {
      server = await startServer({ dataDir: directory, host: "127.0.0.1", port: 0, github: null });
      await use(server);
    } finally {
      await server?.close();
      const target = resolve(directory);
      expect(dirname(target)).toBe(resolve(tmpdir()));
      expect(basename(target)).toMatch(/^notes-account-settings-browser-/);
      await rm(target, { recursive: true, force: true });
    }
  },
  account: [async ({ page, app }, use) => {
    await use(await register(page, app, "settings_owner", "设置验收用户"));
  }, { auto: true }],
});

// Traces include response bodies and DOM snapshots. Use only masked evidence.
test.use({ trace: "off", screenshot: "off", video: "off" });

function settings(page: Page) { return page.getByRole("dialog", { name: "账号设置", exact: true }); }
async function expectIdentity(page: Page, displayName: string) {
  const identity = page.getByRole("button", { name: "切换空间", exact: true });
  const pages = page.getByRole("button", { name: "All pages", exact: true });
  await expect.poll(async () => await identity.isVisible() || await pages.isVisible()).toBe(true);
  if (!await identity.isVisible()) await pages.click();
  await expect(identity).toBeVisible();
  await expect(identity.locator(".space-switcher__user")).toHaveText(displayName);
}
function category(page: Page, name: string) {
  const dialog = settings(page);
  return dialog.getByRole("tab", { name, exact: true }).or(dialog.getByRole("button", { name, exact: true }));
}
async function register(page: Page, app: App, handle: string, displayName = handle): Promise<User> {
  await page.goto(app.url);
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.locator('input[name="handle"]').fill(handle);
  await page.locator('input[name="displayName"]').fill(displayName);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await expectIdentity(page, displayName);
  return sessionUser(page, app);
}
async function sessionUser(page: Page, app: App): Promise<User> {
  const response = await page.request.get(`${app.url}/api/session`);
  expect(response.status()).toBe(200);
  return (await response.json()).user;
}
async function records(page: Page, app: App, collection: string): Promise<RecordRow[]> {
  const response = await page.request.get(`${app.url}/api/records/personal/${collection}`);
  expect(response.status()).toBe(200);
  return response.json();
}
async function savedTheme(page: Page, app: App) {
  return (await records(page, app, "workspace_settings")).find((row) => row.id === "preferences")?.value.theme;
}
async function tokens(page: Page, app: App): Promise<TokenMetadata[]> {
  const response = await page.request.get(`${app.url}/api/tokens`);
  expect(response.status()).toBe(200);
  return response.json();
}
async function openSettings(page: Page) {
  const entry = page.getByRole("button", { name: "设置", exact: true });
  const pages = page.getByRole("button", { name: "All pages", exact: true });
  await expect.poll(async () => await entry.isVisible() || await pages.isVisible()).toBe(true);
  if (!await entry.isVisible()) await pages.click();
  await entry.click();
  await expect(settings(page)).toBeVisible();
}
async function chooseTheme(page: Page, theme: "system" | "light" | "dark") {
  await settings(page).getByRole("combobox", { name: "外观", exact: true }).click();
  const label = { system: "跟随系统", light: "浅色", dark: "深色" }[theme];
  await page.getByRole("listbox", { name: "外观", exact: true }).getByRole("option", { name: label, exact: true }).click();
}
async function noSavedNotice(page: Page) {
  await expect(settings(page).getByRole("status").filter({ hasText: /^已保存$/ })).toHaveCount(0);
}
async function tryAction(control: Locator) {
  if (await control.isEnabled()) await control.click();
}
async function submitProfile(page: Page) {
  const save = settings(page).getByRole("button", { name: "保存", exact: true });
  if (await save.isVisible() && await save.isEnabled()) await save.click();
  else await settings(page).getByLabel("显示名", { exact: true }).press("Enter");
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await settings(page).evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  const box = await settings(page).boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
}
async function readableSecondaryText(page: Page) {
  const ratios = await settings(page).evaluate((root) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    const luminance = (rgb: number[]) => rgb.map((value) => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const pairs = [[".settings-heading p", ".settings-main"], [".settings-nav__group", ".settings-nav"]];
    return pairs.map(([textSelector, backgroundSelector]) => {
      const text = root.querySelector(textSelector)!;
      const background = root.querySelector(backgroundSelector)!;
      const color = getComputedStyle(background).backgroundColor;
      const paper = getComputedStyle(root).backgroundColor;
      context.fillStyle = paper;
      context.fillRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const bg = luminance([...context.getImageData(0, 0, 1, 1).data].slice(0, 3));
      context.fillStyle = getComputedStyle(text).color;
      context.fillRect(0, 0, 1, 1);
      const fg = luminance([...context.getImageData(0, 0, 1, 1).data].slice(0, 3));
      return (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
    });
  });
  for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
  return ratios;
}
async function photo(page: Page, testInfo: TestInfo, name: string) {
  await mkdir(evidence, { recursive: true });
  await page.evaluate(async () => { await document.fonts.ready; });
  expect(await page.evaluate(() => devicePixelRatio)).toBe(2);
  const path = join(evidence, `${name}@2x.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled", mask: [page.getByLabel("令牌", { exact: true })] });
  await testInfo.attach(name, { path, contentType: "image/png" });
}
async function createToken(page: Page, name: string, access: "read" | "write" = "read") {
  const openForm = !await settings(page).locator('input[name="tokenName"]').count();
  if (openForm) await settings(page).getByRole("button", { name: "新建令牌", exact: true }).click();
  await settings(page).locator('input[name="tokenName"]').fill(name);
  await settings(page).getByRole("combobox", { name: "权限", exact: true }).click();
  await page.getByRole("option", { name: access === "write" ? "读写" : "只读", exact: true }).click();
  await settings(page).getByRole("button", { name: "创建", exact: true }).click();
  await expect(settings(page).getByLabel("令牌", { exact: true })).toBeVisible();
  return settings(page).getByLabel("令牌", { exact: true }).inputValue();
}
async function revokeToken(page: Page, name: string) {
  await settings(page).getByRole("button", { name: `撤销令牌「${name}」`, exact: true }).click();
  await settings(page).getByRole("button", { name: `确认撤销令牌「${name}」`, exact: true }).click();
  await expect(settings(page).getByRole("button", { name: `撤销令牌「${name}」`, exact: true })).toHaveCount(0);
}
function isThemeWrite(route: Route) {
  if (route.request().method() !== "POST") return false;
  const body = route.request().postDataJSON() as { writes?: Array<{ collection: string; id: string; value?: { theme?: string }; patch?: { theme?: string } }> };
  return Boolean(body.writes?.some((write) => write.collection === "workspace_settings" && write.id === "preferences" && (write.value?.theme || write.patch?.theme)));
}

test("AC-01/02: save a trimmed display name with Enter, refresh identity and future authors, and reload", async ({ page, app, account }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("button", { name: "New page", exact: true }).first().click();
  const title = page.getByRole("textbox", { name: "Page title", exact: true });
  await title.fill("设置前的笔记");
  await expect.poll(async () => JSON.stringify(await records(page, app, "pages"))).toContain("设置前的笔记");
  const originalPages = await records(page, app, "pages");
  const originalId = new URL(page.url()).searchParams.get("page")!;
  const originalAuthor = originalPages.find((row) => row.id === originalId)!.value.created_by;
  const originalHistory = await records(page, app, "versions");
  const location = page.url();
  await openSettings(page);
  const dialog = settings(page);
  await expect(dialog.getByRole("heading", { name: "账号", exact: true })).toBeVisible();
  await expect(category(page, "我的账号")).toHaveAttribute("aria-selected", "true");
  await expect(category(page, "我的账号")).toBeFocused();
  await expect(dialog.getByRole("tab", { name: "登录方式", exact: true })).toHaveCount(0);
  await expect(dialog.getByText(`@${account.handle}`, { exact: true })).toBeVisible();
  const field = dialog.getByLabel("显示名", { exact: true });
  await expect(field).toHaveValue(account.displayName);
  await expect(dialog.getByRole("button", { name: "保存", exact: true }).and(dialog.locator(":enabled"))).toHaveCount(0);
  await field.fill("  新的显示名  ");
  const responsePromise = page.waitForResponse((response) => response.url() === `${app.url}/api/account/profile` && response.request().method() === "PATCH");
  await field.press("Enter");
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const body = response.request().postDataJSON();
  expect(Object.keys(body)).toEqual(["displayName"]);
  expect(body.displayName.trim()).toBe("新的显示名");
  expect((await response.json()).user).toMatchObject({ ...account, displayName: "新的显示名" });
  await expect(dialog.getByRole("status").filter({ hasText: /^已保存$/ })).toBeVisible();
  await expect(field).toHaveValue("新的显示名");
  await dialog.getByRole("button", { name: "关闭设置", exact: true }).click();
  const entry = page.getByRole("button", { name: "设置", exact: true });
  await expectIdentity(page, "新的显示名");
  await expect(entry).toBeFocused();
  expect(page.url()).toBe(location);
  await expect(title).toHaveText("设置前的笔记");
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByRole("menuitem", { name: "页面", exact: true }).click();
  await title.fill("设置后的笔记");
  const newId = new URL(page.url()).searchParams.get("page")!;
  await expect.poll(async () => (await records(page, app, "pages")).find((row) => row.id === newId)?.value.created_by).toBe("新的显示名");
  expect((await records(page, app, "pages")).find((row) => row.id === originalId)?.value.created_by).toBe(originalAuthor);
  for (const row of originalHistory) expect((await records(page, app, "versions")).find((current) => current.id === row.id)?.value).toEqual(row.value);
  await page.reload();
  await expectIdentity(page, "新的显示名");
  expect(await sessionUser(page, app)).toEqual({ ...account, displayName: "新的显示名" });
  await openSettings(page);
  await expect(settings(page).getByLabel("显示名", { exact: true })).toHaveValue("新的显示名");
  expect(errors).toEqual([]);
});

test("AC-02: invalid names and explicit save failure retain input; cancel restores the confirmed value", async ({ page, app, account }) => {
  await openSettings(page);
  const field = settings(page).getByLabel("显示名", { exact: true });
  const patches: unknown[] = [];
  await page.route(profilePath, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    patches.push(route.request().postDataJSON());
    await route.fulfill({ status: 503, json: { error: "显示名暂时无法保存" } });
  });
  await field.fill("   ");
  await submitProfile(page);
  await expect(settings(page).getByText(/请输入显示名|不能为空|1.{0,6}100|显示名.*为空/).first()).toBeVisible();
  await expect(field).toHaveValue("   ");
  expect(await field.evaluate((element) => element.closest("form")?.contains(document.activeElement))).toBe(true);
  const tooLong = "名".repeat(101);
  await field.fill(tooLong);
  await submitProfile(page);
  await expect(settings(page).getByText(/100/).first()).toBeVisible();
  await expect(field).toHaveValue(tooLong);
  expect(patches).toHaveLength(0);
  await field.fill("失败后保留的名字");
  await submitProfile(page);
  await expect(settings(page).getByRole("alert")).toContainText("显示名暂时无法保存");
  await expect(field).toHaveValue("失败后保留的名字");
  await expect(field).toBeEditable();
  await noSavedNotice(page);
  expect((await sessionUser(page, app)).displayName).toBe(account.displayName);
  await settings(page).getByRole("button", { name: "取消", exact: true }).click();
  await expect(field).toHaveValue(account.displayName);
  expect(patches).toHaveLength(1);
  await page.unroute(profilePath);
  await field.fill("取消之后可以保存");
  await submitProfile(page);
  await expect(settings(page).getByRole("status").filter({ hasText: /^已保存$/ })).toBeVisible();
  expect((await sessionUser(page, app)).displayName).toBe("取消之后可以保存");
});

test("AC-09: category changes retain profile and token drafts; close and logout require an explicit choice", async ({ page, app, account }) => {
  await openSettings(page);
  await settings(page).getByLabel("显示名", { exact: true }).fill("尚未保存的名字");
  await category(page, "Agent 令牌").click();
  await settings(page).getByRole("button", { name: "新建令牌", exact: true }).click();
  await settings(page).locator('input[name="tokenName"]').fill("尚未创建的 Agent");
  await settings(page).getByRole("combobox", { name: "权限", exact: true }).click();
  await page.getByRole("option", { name: "读写", exact: true }).click();
  await category(page, "偏好").click();
  await category(page, "Agent 令牌").click();
  await expect(settings(page).locator('input[name="tokenName"]')).toHaveValue("尚未创建的 Agent");
  await expect(settings(page).getByRole("combobox", { name: "权限", exact: true })).toHaveText("读写");
  await category(page, "我的账号").click();
  await expect(settings(page).getByLabel("显示名", { exact: true })).toHaveValue("尚未保存的名字");
  await settings(page).getByRole("button", { name: "关闭设置", exact: true }).click();
  const prompt = page.getByRole("alertdialog");
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(settings(page).getByLabel("显示名", { exact: true })).toHaveValue("尚未保存的名字");
  await settings(page).getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "继续编辑", exact: true }).click();
  expect((await sessionUser(page, app)).id).toBe(account.id);
  await settings(page).getByRole("button", { name: "关闭设置", exact: true }).click();
  await prompt.getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(settings(page)).toBeHidden();
  await expect(page.getByRole("button", { name: "设置", exact: true })).toBeFocused();
  await expectIdentity(page, account.displayName);
  await openSettings(page);
  await expect(settings(page).getByLabel("显示名", { exact: true })).toHaveValue(account.displayName);
  await category(page, "Agent 令牌").click();
  await settings(page).getByRole("button", { name: "新建令牌", exact: true }).click();
  await expect(settings(page).locator('input[name="tokenName"]')).toHaveValue("");
  expect(await tokens(page, app)).toEqual([]);
});

test("AC-09: pending profile save blocks navigation, Escape, close, logout, and duplicate submission", async ({ page, app }) => {
  await openSettings(page);
  await settings(page).getByLabel("显示名", { exact: true }).fill("等待服务端确认");
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let patches = 0;
  await page.route(profilePath, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    patches++;
    entered();
    await gate;
    await route.continue();
  });
  try {
    await submitProfile(page);
    await started;
    await expect(settings(page).getByRole("button", { name: /保存中|正在保存/ })).toBeDisabled();
    await tryAction(category(page, "偏好"));
    await tryAction(settings(page).getByRole("button", { name: "关闭设置", exact: true }));
    await tryAction(settings(page).getByRole("button", { name: "退出登录", exact: true }));
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await expect(category(page, "我的账号")).toHaveAttribute("aria-selected", "true");
    await expect(settings(page).getByLabel("显示名", { exact: true })).toHaveValue("等待服务端确认");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(patches).toBe(1);
  } finally { release(); }
  await expect(settings(page).getByRole("status").filter({ hasText: /^已保存$/ })).toBeVisible();
  expect((await sessionUser(page, app)).displayName).toBe("等待服务端确认");
  expect(patches).toBe(1);
  await category(page, "偏好").click();
  await expect(settings(page).getByRole("combobox", { name: "外观", exact: true })).toBeEnabled();
  await settings(page).getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(settings(page)).toBeHidden();
});

test("AC-04: all themes persist, follow the OS, and use preferences from the sidebar settings gear", async ({ page, app, account }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await openSettings(page);
  await category(page, "偏好").click();
  for (const theme of ["dark", "light", "system"] as const) {
    await chooseTheme(page, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme === "system" ? "light" : theme);
    await expect.poll(() => savedTheme(page, app)).toBe(theme);
    await page.reload();
    await expectIdentity(page, account.displayName);
    await openSettings(page);
    await category(page, "偏好").click();
    await expect(settings(page).getByRole("combobox", { name: "外观", exact: true })).toHaveText({ dark: "深色", light: "浅色", system: "跟随系统" }[theme]);
  }
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await settings(page).getByRole("button", { name: "关闭设置", exact: true }).click();
  await openSettings(page);
  await category(page, "偏好").click();
  await chooseTheme(page, "dark");
  await expect.poll(() => savedTheme(page, app)).toBe("dark");
  await settings(page).getByRole("button", { name: "关闭设置", exact: true }).click();
  await openSettings(page);
  await category(page, "偏好").click();
  await expect(settings(page).getByRole("combobox", { name: "外观", exact: true })).toHaveText("深色");
  await chooseTheme(page, "light");
  await expect.poll(() => savedTheme(page, app)).toBe("light");
  await settings(page).getByRole("button", { name: "关闭设置", exact: true }).click();
  await openSettings(page);
  await category(page, "偏好").click();
  await chooseTheme(page, "system");
  await expect.poll(() => savedTheme(page, app)).toBe("system");
  await settings(page).getByRole("button", { name: "关闭设置", exact: true }).click();
  await openSettings(page);
  await category(page, "偏好").click();
  await expect(settings(page).getByRole("combobox", { name: "外观", exact: true })).toHaveText("跟随系统");
});

test("AC-04: preference write failure is visible and does not become a confirmed save", async ({ page, app }) => {
  await openSettings(page);
  await category(page, "偏好").click();
  await chooseTheme(page, "light");
  await expect.poll(() => savedTheme(page, app)).toBe("light");
  let rejected = 0;
  await page.route("**/api/records/batch", async (route) => {
    if (!isThemeWrite(route)) return route.continue();
    rejected++;
    await route.fulfill({ status: 503, json: { error: "主题暂时无法保存" } });
  });
  await chooseTheme(page, "dark");
  await expect(settings(page).getByRole("alert")).toContainText(/外观未确认保存|尚未保存/, { timeout: 15000 });
  await noSavedNotice(page);
  expect(rejected).toBeGreaterThan(0);
  expect(await savedTheme(page, app)).toBe("light");
  await expect(category(page, "偏好")).toHaveAttribute("aria-selected", "true");
  await expect(settings(page).getByRole("combobox", { name: "外观", exact: true })).toBeEnabled();
  await page.unroute("**/api/records/batch");
  await chooseTheme(page, "light");
  await chooseTheme(page, "dark");
  await expect.poll(() => savedTheme(page, app)).toBe("dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("AC-01/08: search locates appearance, restores empty results, and hides administration from a normal user", async ({ page, app, account, browser }) => {
  await openSettings(page);
  for (const name of ["我的账号", "偏好", "邀请", "Agent 令牌", "账号管理"]) await expect(category(page, name)).toBeVisible();
  for (const name of ["邮箱", "修改密码", "通行密钥", "双重身份验证", "通知", "计费"]) await expect(settings(page).getByRole("tab", { name, exact: true })).toHaveCount(0);
  const search = settings(page).getByPlaceholder("搜索设置", { exact: true });
  await search.fill("主题");
  await category(page, "偏好").click();
  await expect(settings(page).getByRole("combobox", { name: "外观", exact: true })).toBeFocused();
  await search.fill("不存在的设置xyz");
  await expect(settings(page).getByText("未找到设置", { exact: true })).toBeVisible();
  await settings(page).getByRole("button", { name: /清空/ }).first().click();
  await expect(search).toHaveValue("");
  for (const name of ["我的账号", "偏好", "邀请", "Agent 令牌", "账号管理"]) await expect(category(page, name)).toBeVisible();
  expect((await sessionUser(page, app)).id).toBe(account.id);
  const memberContext = await browser.newContext();
  try {
    const member = await memberContext.newPage();
    await register(member, app, "settings_member", "普通设置用户");
    await openSettings(member);
    await expect(category(member, "账号管理")).toHaveCount(0);
    await settings(member).getByPlaceholder("搜索设置", { exact: true }).fill("账号管理");
    await expect(settings(member).getByText("未找到设置", { exact: true })).toBeVisible();
    await expect(category(member, "账号管理")).toHaveCount(0);
    expect((await member.request.get(`${app.url}/api/admin/users`)).status()).toBe(403);
  } finally { await memberContext.close(); }
});

test("AC-07: preserve the last administrator and return to account after self-demotion", async ({ page, app, account, browser }) => {
  const memberContext = await browser.newContext();
  try {
    const member = await memberContext.newPage();
    const other = await register(member, app, "settings_admin_peer", "另一位管理员");
    await openSettings(page);
    await category(page, "账号管理").click();
    const ownRole = settings(page).getByRole("combobox", { name: `${account.displayName}的站点角色`, exact: true });
    await ownRole.click();
    await page.getByRole("option", { name: "用户", exact: true }).click();
    await expect(settings(page).getByRole("alert")).toContainText(/至少保留/);
    await expect(ownRole).toHaveText("管理员");
    expect((await sessionUser(page, app)).siteRole).toBe("admin");
    await settings(page).getByRole("combobox", { name: `${other.displayName}的站点角色`, exact: true }).click();
    await page.getByRole("option", { name: "管理员", exact: true }).click();
    await expect.poll(async () => (await sessionUser(member, app)).siteRole).toBe("admin");
    await ownRole.click();
    await page.getByRole("option", { name: "用户", exact: true }).click();
    await expect(category(page, "账号管理")).toHaveCount(0);
    await expect(category(page, "我的账号")).toHaveAttribute("aria-selected", "true");
    await expect(settings(page).getByLabel("显示名", { exact: true })).toHaveValue(account.displayName);
    expect((await sessionUser(page, app)).siteRole).toBe("user");
    expect((await page.request.get(`${app.url}/api/admin/users`)).status()).toBe(403);
  } finally { await memberContext.close(); }
});

test("AC-05: invitation errors retry in place; acceptance and rejection update real memberships", async ({ page, app, account, browser }) => {
  const ownerContext = await browser.newContext();
  try {
    const owner = await ownerContext.newPage();
    await register(owner, app, "settings_inviter", "空间邀请者");
    const tokenResponse = await owner.request.post(`${app.url}/api/tokens`, { headers: { Origin: app.url }, data: { name: "邀请验收数据", access: "write" } });
    expect(tokenResponse.status()).toBe(201);
    const bearer = (await tokenResponse.json()).token;
    for (const name of ["接受的设置空间", "拒绝的设置空间"]) {
      const created = await owner.request.post(`${app.url}/api/spaces`, { headers: { Origin: app.url }, data: { name } });
      expect(created.status()).toBe(201);
      const space = await created.json();
      const note = await owner.request.post(`${app.url}/api/v1/pages`, { headers: { Authorization: `Bearer ${bearer}` }, data: { title: name, text: "邀请后可见的页面", spaceId: space.spaceId } });
      expect(note.status()).toBe(201);
      expect((await owner.request.post(`${app.url}/api/spaces/${space.spaceId}/invitations`, { headers: { Origin: app.url }, data: { handle: account.handle, role: "viewer" } })).status()).toBe(200);
    }
    await page.route("**/api/invitations", (route) => route.fulfill({ status: 503, json: { error: "邀请暂时无法读取" } }));
    await openSettings(page);
    await category(page, "邀请").click();
    await expect(settings(page).getByRole("alert")).toContainText("邀请暂时无法读取");
    await page.unroute("**/api/invitations");
    await settings(page).getByRole("button", { name: "重试", exact: true }).click();
    await expect(settings(page).getByText("空间邀请者 · 只读", { exact: true }).first()).toBeVisible();
    await settings(page).getByRole("button", { name: "接受「接受的设置空间」的邀请", exact: true }).click();
    await expect(settings(page).getByRole("status")).toContainText("已加入「接受的设置空间」");
    await settings(page).getByRole("button", { name: "拒绝「拒绝的设置空间」的邀请", exact: true }).click();
    await expect(settings(page).getByText("暂无邀请", { exact: true })).toBeVisible();
    const spaces = await (await page.request.get(`${app.url}/api/spaces`)).json();
    expect(spaces.map((space: { name: string }) => space.name)).toEqual(["接受的设置空间"]);
    await settings(page).getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(page.getByText("接受的设置空间", { exact: true }).first()).toBeVisible();
  } finally { await ownerContext.close(); }
});

test.describe("one-time Agent secrets", () => {
  test("AC-06: create, copy, guard category/search/close exits, hide, and revoke a working token", async ({ page, app, account }, testInfo) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: app.url });
    await openSettings(page);
    await category(page, "Agent 令牌").click();
    const name = "一次性原文验收 Agent";
    const secret = await createToken(page, name, "write");
    expect(secret.startsWith("notes_")).toBe(true);
    const metadata = await tokens(page, app);
    expect(metadata.map((item) => ({ name: item.name, access: item.access }))).toEqual([{ name, access: "write" }]);
    expect(metadata.every((item) => !Object.hasOwn(item, "token"))).toBe(true);
    const authorization = { Authorization: `Bearer ${secret}` };
    expect((await page.request.get(`${app.url}/api/v1/pages`, { headers: authorization })).status()).toBe(200);
    await settings(page).getByRole("button", { name: "复制令牌", exact: true }).click();
    await expect(settings(page).getByRole("status")).toContainText("已复制令牌");
    expect(await page.evaluate(async (value) => await navigator.clipboard.readText() === value, secret)).toBe(true);
    expect(await page.evaluate((value) => [localStorage, sessionStorage].every((storage) => Object.values(storage).every((item) => !String(item).includes(value))), secret)).toBe(true);
    await photo(page, testInfo, "token-created-masked-desktop");
    await category(page, "偏好").click();
    const prompt = page.getByRole("alertdialog");
    await expect(prompt).toContainText(/离开后无法再次查看令牌/);
    await expect(prompt).toContainText(/令牌仍有效/);
    await prompt.getByRole("button", { name: "继续保存", exact: true }).click();
    expect(await settings(page).getByLabel("令牌", { exact: true }).inputValue() === secret).toBe(true);
    await settings(page).getByPlaceholder("搜索设置", { exact: true }).fill("主题");
    await category(page, "偏好").click();
    await expect(prompt).toBeVisible();
    await prompt.getByRole("button", { name: "继续保存", exact: true }).click();
    await settings(page).getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(prompt).toBeVisible();
    await prompt.getByRole("button", { name: "离开并隐藏", exact: true }).click();
    await expect(settings(page)).toBeHidden();
    await expect(page.getByRole("button", { name: "设置", exact: true })).toBeFocused();
    await expectIdentity(page, account.displayName);
    expect((await page.request.get(`${app.url}/api/v1/pages`, { headers: authorization })).status()).toBe(200);
    await openSettings(page);
    await category(page, "Agent 令牌").click();
    await expect(settings(page).getByLabel("令牌", { exact: true })).toHaveCount(0);
    await expect(settings(page).getByRole("button", { name: `撤销令牌「${name}」`, exact: true })).toBeVisible();
    await page.reload();
    await openSettings(page);
    await category(page, "Agent 令牌").click();
    await expect(settings(page).getByLabel("令牌", { exact: true })).toHaveCount(0);
    await revokeToken(page, name);
    expect(await tokens(page, app)).toEqual([]);
    expect((await page.request.get(`${app.url}/api/v1/pages`, { headers: authorization })).status()).toBe(401);
  });

  test("AC-06/E4: a committed create with a lost response reloads metadata without creating twice", async ({ page, app }) => {
    await openSettings(page);
    await category(page, "Agent 令牌").click();
    let creates = 0;
    let metadataReads = 0;
    let lost = false;
    await page.route(tokenPath, async (route) => {
      if (route.request().method() === "GET") {
        if (lost) metadataReads++;
        return route.continue();
      }
      if (route.request().method() !== "POST") return route.continue();
      creates++;
      const committed = await route.fetch({ maxRetries: 0 });
      expect(committed.status()).toBe(201);
      await committed.dispose();
      lost = true;
      await route.abort("connectionreset");
    });
    const name = "响应丢失的 Agent";
    await settings(page).getByRole("button", { name: "新建令牌", exact: true }).click();
    await settings(page).locator('input[name="tokenName"]').fill(name);
    await settings(page).getByRole("button", { name: "创建", exact: true }).click();
    await expect.poll(() => metadataReads).toBeGreaterThan(0);
    await expect(settings(page).getByRole("alert")).toContainText(/原文.*(无法|不能)|无法.*(找回|恢复).*原文/);
    await expect(settings(page).getByLabel("令牌", { exact: true })).toHaveCount(0);
    expect(creates).toBe(1);
    const metadata = await tokens(page, app);
    expect(metadata.map((item) => item.name)).toEqual([name]);
    await expect(settings(page).getByRole("button", { name: `撤销令牌「${name}」`, exact: true })).toBeVisible();
    await category(page, "偏好").click();
    await category(page, "Agent 令牌").click();
    expect(creates).toBe(1);
    expect((await tokens(page, app)).map((item) => item.id)).toEqual(metadata.map((item) => item.id));
    await revokeToken(page, name);
    await page.unroute(tokenPath);
    const recovered = await createToken(page, "撤销后重新创建");
    expect(recovered.startsWith("notes_")).toBe(true);
    await settings(page).getByRole("button", { name: "已保存", exact: true }).click();
    await expect(settings(page).getByLabel("令牌", { exact: true })).toHaveCount(0);
    expect((await tokens(page, app)).map((item) => item.name)).toEqual(["撤销后重新创建"]);
  });
});

test("AC-09: vertical tab keys and Select Escape preserve the parent and restore entry focus", async ({ page, account }) => {
  await openSettings(page);
  const own = category(page, "我的账号");
  await expect(own).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(category(page, "偏好")).toBeFocused();
  await expect(category(page, "偏好")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(category(page, "账号管理")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(own).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(category(page, "账号管理")).toBeFocused();
  await category(page, "Agent 令牌").click();
  await settings(page).getByRole("button", { name: "新建令牌", exact: true }).click();
  const field = settings(page).getByRole("combobox", { name: "权限", exact: true });
  await field.click();
  await expect(page.getByRole("listbox", { name: "权限", exact: true })).toBeVisible();
  await page.keyboard.press("End");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox", { name: "权限", exact: true })).toBeHidden();
  await expect(settings(page)).toBeVisible();
  await expect(field).toHaveText("只读");
  await expect(field).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(settings(page)).toBeHidden();
  await expect(page.getByRole("button", { name: "设置", exact: true })).toBeFocused();
  await expectIdentity(page, account.displayName);
});

test("AC-09: native IME Enter does not save and IME Escape does not close settings", async ({ page, app, account }) => {
  await openSettings(page);
  const field = settings(page).getByLabel("显示名", { exact: true });
  await field.focus();
  let patches = 0;
  page.on("request", (request) => { if (request.method() === "PATCH" && request.url() === `${app.url}/api/account/profile`) patches++; });
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.imeSetComposition", { text: "ming", selectionStart: 4, selectionEnd: 4 });
    await page.keyboard.press("Enter");
    expect((await sessionUser(page, app)).displayName).toBe(account.displayName);
    expect(patches).toBe(0);
    await cdp.send("Input.imeSetComposition", { text: "zi", selectionStart: 2, selectionEnd: 2 });
    await page.keyboard.press("Escape");
    await expect(settings(page)).toBeVisible();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
  } finally { await cdp.detach(); }
});

test("AC-11: mobile opens navigation first and returns without losing long-name drafts", async ({ page, app, account }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.getByRole("button", { name: "All pages", exact: true })).toBeVisible();
  await openSettings(page);
  await expect(settings(page).getByLabel("显示名", { exact: true })).toBeHidden();
  for (const name of ["我的账号", "偏好", "邀请", "Agent 令牌", "账号管理"]) await expect(category(page, name)).toBeVisible();
  await noOverflow(page);
  await photo(page, testInfo, "mobile-navigation-light");
  await category(page, "我的账号").click();
  const field = settings(page).getByLabel("显示名", { exact: true });
  const longName = "长名称用于检查手机设置的阅读与操作边界".repeat(6).slice(0, 100);
  await field.fill(longName);
  await expect(settings(page).getByRole("button", { name: "返回设置", exact: true })).toBeInViewport();
  await noOverflow(page);
  await photo(page, testInfo, "mobile-account-long-name-light");
  await settings(page).getByRole("button", { name: "返回设置", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await category(page, "偏好").click();
  await settings(page).getByRole("button", { name: "返回设置", exact: true }).click();
  await category(page, "我的账号").click();
  await expect(field).toHaveValue(longName);
  await submitProfile(page);
  await expect(settings(page).getByRole("status").filter({ hasText: /^已保存$/ })).toBeVisible();
  expect((await sessionUser(page, app)).displayName).toBe(longName);
  await settings(page).getByRole("button", { name: "返回设置", exact: true }).click();
  await category(page, "Agent 令牌").click();
  await settings(page).getByRole("button", { name: "新建令牌", exact: true }).click();
  await settings(page).locator('input[name="tokenName"]').fill("很长的 Agent 名称".repeat(8));
  await noOverflow(page);
  await settings(page).getByRole("combobox", { name: "权限", exact: true }).click();
  const list = page.getByRole("listbox", { name: "权限", exact: true });
  await expect(list).toBeInViewport({ ratio: 1 });
  await photo(page, testInfo, "mobile-token-select-light");
  await page.keyboard.press("Escape");
  await expect(settings(page)).toBeVisible();
  await settings(page).getByRole("button", { name: "创建", exact: true }).click();
  await expect(settings(page).getByLabel("令牌", { exact: true })).toBeInViewport();
  await noOverflow(page);
  await photo(page, testInfo, "mobile-token-created-masked-light");
  await settings(page).getByRole("button", { name: "返回设置", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "继续保存", exact: true }).click();
  await expect(settings(page).getByLabel("令牌", { exact: true })).toBeVisible();
  await settings(page).getByRole("button", { name: "返回设置", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "离开并隐藏", exact: true }).click();
  await expect(settings(page).getByRole("button", { name: "退出登录", exact: true })).toBeInViewport();
  await settings(page).getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(settings(page)).toBeHidden();
  await expectIdentity(page, longName);
  expect((await sessionUser(page, app)).id).toBe(account.id);
});

test("AC-11: capture 2x light/dark desktop, short-window, and 200 percent layout evidence", async ({ page, app }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSettings(page);
  for (const theme of ["light", "dark"] as const) {
    await category(page, "偏好").click();
    await chooseTheme(page, theme);
    await expect.poll(() => savedTheme(page, app)).toBe(theme);
    await category(page, "我的账号").click();
    await noOverflow(page);
    const contrast = await readableSecondaryText(page);
    await testInfo.attach(`secondary-contrast-${theme}`, { body: JSON.stringify({ detail: contrast[0], navigation: contrast[1] }), contentType: "application/json" });
    await expect(settings(page).getByRole("button", { name: "关闭设置", exact: true })).toBeInViewport();
    await expect(settings(page).getByRole("button", { name: "退出登录", exact: true })).toBeInViewport();
    await photo(page, testInfo, `desktop-account-${theme}-1440x900`);
    await page.setViewportSize({ width: 1280, height: 720 });
    await noOverflow(page);
    await photo(page, testInfo, `desktop-account-${theme}-1280x720`);
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  await page.setViewportSize({ width: 1280, height: 400 });
  await category(page, "Agent 令牌").click();
  await noOverflow(page);
  await expect(settings(page).getByRole("button", { name: "关闭设置", exact: true })).toBeInViewport();
  await expect(settings(page).getByRole("button", { name: "退出登录", exact: true })).toBeInViewport();
  await settings(page).getByRole("button", { name: "新建令牌", exact: true }).click();
  await settings(page).getByRole("combobox", { name: "权限", exact: true }).click();
  await expect(page.getByRole("listbox", { name: "权限", exact: true })).toBeInViewport({ ratio: 1 });
  await photo(page, testInfo, "short-window-token-select-dark");
  await page.keyboard.press("Escape");
  await settings(page).getByRole("button", { name: "关闭设置", exact: true }).click();
  // Browser zoom halves the CSS viewport. Exercise the same 200% reflow boundary.
  await page.setViewportSize({ width: 720, height: 450 });
  await openSettings(page);
  await category(page, "我的账号").click();
  await noOverflow(page);
  await expect(settings(page).getByLabel("显示名", { exact: true })).toBeInViewport();
  await expect(settings(page).getByRole("button", { name: "关闭设置", exact: true })).toBeInViewport();
  await photo(page, testInfo, "reflow-200-percent-equivalent-dark");
});

test("AC-11: record settings transitions and preserve feedback with reduced motion", async ({ browser, app }, testInfo) => {
  await mkdir(evidence, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2,
    reducedMotion: "no-preference", recordVideo: { dir: testInfo.outputPath("motion"), size: { width: 1280, height: 720 } } });
  const page = await context.newPage();
  const video = page.video()!;
  try {
    await register(page, app, "motion_settings", "设置交互用户");
    await openSettings(page);
    await category(page, "偏好").click();
    await chooseTheme(page, "dark");
    await expect(settings(page).getByRole("status").filter({ hasText: /^已保存$/ })).toBeVisible();
    await category(page, "我的账号").click();
    await settings(page).getByLabel("显示名", { exact: true }).fill("修改后的交互用户");
    await submitProfile(page);
    await expect(settings(page).getByRole("status").filter({ hasText: /^已保存$/ })).toBeVisible();
    await settings(page).getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(settings(page)).toBeHidden();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openSettings(page);
    const durations = await settings(page).evaluate((element) => getComputedStyle(element).transitionDuration.split(",").map(parseFloat));
    expect(Math.max(...durations)).toBeLessThanOrEqual(0.001);
    await category(page, "偏好").click();
    await chooseTheme(page, "light");
    await expect(settings(page).getByRole("status").filter({ hasText: /^已保存$/ })).toBeVisible();
    await settings(page).getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(settings(page)).toBeHidden();
  } finally { await context.close(); }
  const path = join(evidence, "settings-interaction.webm");
  await video.saveAs(path);
  await testInfo.attach("settings-interaction", { path, contentType: "video/webm" });
});
