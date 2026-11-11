import { test as base, expect, type Page, type Request } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";
import { githubConfig, startGithubStub, type GithubStub } from "./helpers/github.ts";

// UC-12 recovery: real Notes storage, browser sessions, editor, and OAuth redirects.
type App = { url: string; github: GithubStub };
type User = { id: string; handle: string; displayName: string; siteRole: "admin" | "user" };
type RecordRow = { id: string; value: Record<string, unknown> };
type Invitation = { id: string; spaceId: string; spaceName: string; expiresAt: string };
type Batch = {
  writes?: Array<{ collection: string; id: string; value?: { page?: string }; patch?: { page?: string } }>;
  textUpdates?: Array<{ pageId: string }>;
  expectedPages?: Array<{ pageId: string }>;
};
const password = "Account-settings-recovery-password-2026!";
const batchPath = "**/api/records/batch";

const test = base.extend<{ app: App; account: User }>({
  app: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "notes-settings-recovery-browser-"));
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    let github: GithubStub | undefined;
    try {
      github = await startGithubStub();
      server = await startServer({ dataDir: directory, host: "127.0.0.1", port: 0, registrationOpen: true, github: githubConfig(github) });
      await use({ url: server.url, github });
    } finally {
      try { await server?.close(); }
      finally {
        await github?.close();
        const target = resolve(directory);
        expect(dirname(target)).toBe(resolve(tmpdir()));
        expect(basename(target)).toMatch(/^notes-settings-recovery-browser-/);
        await rm(target, { recursive: true, force: true });
      }
    }
  },
  account: [async ({ page, app }, use) => {
    await use(await register(page, app, "recovery_owner", "恢复验收账号"));
  }, { auto: true }],
});

// Secret values must not enter screenshots, video, or trace response bodies.
test.use({ trace: "off", screenshot: "off", video: "off" });

function settings(page: Page) { return page.getByRole("dialog", { name: "账号设置", exact: true }); }
function category(page: Page, name: string) { return settings(page).getByRole("tab", { name, exact: true }); }
function noteBody(page: Page) { return page.getByRole("main").locator('[contenteditable="true"][data-collaboration-field^="blocks/"]').first(); }
async function api<T>(page: Page, app: App, path: string, options: { method?: string; data?: unknown; status?: number; token?: string } = {}): Promise<T> {
  const response = await page.request.fetch(`${app.url}${path}`, {
    method: options.method ?? "GET",
    headers: { Origin: app.url, ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
    ...(options.data === undefined ? {} : { data: options.data }),
  });
  expect(response.status(), path).toBe(options.status ?? 200);
  return response.json();
}
async function sessionUser(page: Page, app: App) {
  return (await api<{ user: User | null }>(page, app, "/api/session")).user;
}
async function expectIdentity(page: Page, displayName: string) {
  const identity = page.getByRole("button", { name: "切换空间", exact: true });
  const pages = page.getByRole("button", { name: "All pages", exact: true });
  await expect.poll(async () => await identity.isVisible() || await pages.isVisible()).toBe(true);
  if (!await identity.isVisible()) await pages.click();
  await expect(identity).toBeVisible();
  await expect(identity.locator(".space-switcher__user")).toHaveText(displayName);
}
async function register(page: Page, app: App, handle: string, displayName: string): Promise<User> {
  await page.goto(app.url);
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.locator('input[name="handle"]').fill(handle);
  await page.locator('input[name="displayName"]').fill(displayName);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await expectIdentity(page, displayName);
  const user = await sessionUser(page, app);
  expect(user).not.toBeNull();
  return user!;
}
async function login(page: Page, user: User) {
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible();
  await page.locator('input[name="handle"]').fill(user.handle);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expectIdentity(page, user.displayName);
}
async function openSettings(page: Page) {
  const gear = page.getByRole("button", { name: "设置", exact: true });
  const pages = page.getByRole("button", { name: "All pages", exact: true });
  await expect.poll(async () => await gear.isVisible() || await pages.isVisible()).toBe(true);
  if (!await gear.isVisible()) await pages.click();
  await gear.click();
  await expect(settings(page)).toBeVisible();
}
async function savedBlocks(page: Page, app: App, pageId: string) {
  const rows = await api<RecordRow[]>(page, app, "/api/records/personal/blocks");
  return JSON.stringify(rows.filter((row) => row.value.page === pageId));
}
function containsPageWrite(request: Request, pageId: string) {
  if (request.method() !== "POST") return false;
  const body = request.postDataJSON() as Batch;
  return Boolean(body.textUpdates?.some((update) => update.pageId === pageId)
    || body.expectedPages?.some((page) => page.pageId === pageId)
    || body.writes?.some((write) => (write.collection === "pages" && write.id === pageId)
      || (write.collection === "blocks" && (write.value?.page === pageId || write.patch?.page === pageId || write.id.startsWith(`${pageId}/`)))));
}
async function secretAbsentFromStorage(page: Page, secret: string) {
  expect(await page.evaluate((value) => [localStorage, sessionStorage].every((storage) =>
    Object.values(storage).every((item) => !String(item).includes(value))), secret)).toBe(true);
}

test("AC-10/E8: session expiry hides a new token and keeps old account drafts out of the next account", async ({ page, app, account, browser }) => {
  const otherContext = await browser.newContext();
  try {
    const otherPage = await otherContext.newPage();
    const other = await register(otherPage, app, "recovery_next_user", "切换后的账号");
    await openSettings(page);
    await settings(page).getByLabel("显示名", { exact: true }).fill("只能属于旧账号的草稿");
    await category(page, "Agent 令牌").click();
    await settings(page).getByRole("button", { name: "新建令牌", exact: true }).click();
    await settings(page).locator('input[name="tokenName"]').fill("会话失效前创建的 Agent");
    await settings(page).getByRole("button", { name: "创建", exact: true }).click();
    const raw = settings(page).getByLabel("令牌", { exact: true });
    await expect(raw).toBeVisible();
    const secret = await raw.inputValue();
    expect(secret.startsWith("notes_")).toBe(true);
    await secretAbsentFromStorage(page, secret);
    await api(page, app, "/api/auth/logout", { method: "POST" });
    expect(await sessionUser(page, app)).toBeNull();
    expect((await page.context().cookies(app.url)).some((cookie) => cookie.name === "notes_session")).toBe(false);
    await page.evaluate(() => window.dispatchEvent(new Event("notes:session-expired")));
    await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible();
    await expect(page.getByLabel("令牌", { exact: true })).toHaveCount(0);
    await secretAbsentFromStorage(page, secret);
    await login(page, other);
    expect((await sessionUser(page, app))?.id).toBe(other.id);
    await openSettings(page);
    await expect(settings(page).getByLabel("显示名", { exact: true })).toHaveValue(other.displayName);
    await category(page, "Agent 令牌").click();
    await expect(settings(page).getByLabel("令牌", { exact: true })).toHaveCount(0);
    await expect(settings(page).getByText("暂无令牌", { exact: true })).toBeVisible();
    expect(await api<unknown[]>(page, app, "/api/tokens")).toEqual([]);
    await secretAbsentFromStorage(page, secret);
    // Session expiry clears the display. The created token stays valid.
    await api(page, app, "/api/v1/pages", { token: secret });
    expect((await sessionUser(otherPage, app))?.id).toBe(other.id);
    expect(account.id).not.toBe(other.id);
  } finally { await otherContext.close(); }
});

test("AC-10/V4: unconfirmed note writes block logout, preserve editing, and save before a later logout", async ({ page, app, account }) => {
  test.setTimeout(60000);
  await page.getByRole("button", { name: "New page", exact: true }).first().click();
  await page.getByRole("textbox", { name: "Page title", exact: true }).fill("退出前需要保存的笔记");
  const body = noteBody(page);
  await body.fill("已确认的原正文");
  const pageId = new URL(page.url()).searchParams.get("page")!;
  await expect.poll(() => savedBlocks(page, app, pageId)).toContain("已确认的原正文");
  let rejectedWrites = 0;
  let logoutCalls = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url() === `${app.url}/api/auth/logout`) logoutCalls++;
  });
  await page.route(batchPath, async (route) => {
    if (!containsPageWrite(route.request(), pageId)) return route.continue();
    rejectedWrites++;
    await route.fulfill({ status: 503, json: { error: "笔记保存暂时不可用" } });
  });
  const draft = "退出失败后仍应保留的未保存正文";
  try {
    await body.fill(draft);
    await expect.poll(() => rejectedWrites).toBeGreaterThan(0);
    await openSettings(page);
    await settings(page).getByRole("button", { name: "退出登录", exact: true }).click();
    await expect(settings(page).getByRole("button", { name: "退出登录", exact: true })).toBeDisabled();
    await expect(settings(page).getByRole("alert")).toContainText(/not saved|not confirmed|refused|未.*保存|尚未保存|保存.*失败/i, { timeout: 15000 });
    expect(logoutCalls).toBe(0);
    expect((await sessionUser(page, app))?.id).toBe(account.id);
    expect(await savedBlocks(page, app, pageId)).not.toContain(draft);
    await expect(settings(page).getByRole("button", { name: "退出登录", exact: true })).toBeEnabled();
    await category(page, "偏好").click();
    await expect(settings(page).getByRole("combobox", { name: "外观", exact: true })).toBeEnabled();
    await settings(page).getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(body).toHaveText(draft);
  } finally { await page.unroute(batchPath); }
  await expect.poll(() => savedBlocks(page, app, pageId), { timeout: 20000 }).toContain(draft);
  const continued = `${draft}，恢复后继续编辑。`;
  await body.fill(continued);
  await expect.poll(() => savedBlocks(page, app, pageId)).toContain(continued);
  await openSettings(page);
  await settings(page).getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible();
  expect(logoutCalls).toBe(1);
  expect(await sessionUser(page, app)).toBeNull();
  await login(page, account);
  await page.goto(`${app.url}/?page=${pageId}`);
  await expect(noteBody(page)).toHaveText(continued);
});

test("AC-05/E3: expired invitations cannot join, and a failed acceptance retains its item until a real retry succeeds", async ({ page, app, account, browser }) => {
  const ownerContext = await browser.newContext();
  try {
    const owner = await ownerContext.newPage();
    await register(owner, app, "recovery_inviter", "恢复流程邀请者");
    const spaces: Array<{ spaceId: string; name: string }> = [];
    for (const name of ["过期邀请界面验收空间", "失败后重试加入空间"]) {
      const space = await api<{ spaceId: string; name: string }>(owner, app, "/api/spaces", { method: "POST", status: 201, data: { name } });
      spaces.push(space);
      await api(owner, app, `/api/spaces/${space.spaceId}/invitations`, { method: "POST", data: { handle: account.handle, role: "viewer" } });
    }
    const invitations = await api<Invitation[]>(page, app, "/api/invitations");
    const expired = invitations.find((item) => item.spaceId === spaces[0].spaceId)!;
    const retry = invitations.find((item) => item.spaceId === spaces[1].spaceId)!;
    let expiredPosts = 0;
    page.on("request", (request) => { if (request.method() === "POST" && request.url() === `${app.url}/api/invitations/${expired.id}`) expiredPosts++; });
    await page.route("**/api/invitations", async (route) => {
      const response = await route.fetch();
      const current = await response.json() as Invitation[];
      await route.fulfill({ response, json: current.map((item) => item.id === expired.id ? { ...item, expiresAt: new Date(Date.now() - 60000).toISOString() } : item) });
    });
    const retryPath = `**/api/invitations/${retry.id}`;
    await page.route(retryPath, (route) => route.fulfill({ status: 409, json: { error: "邀请提交失败，请重试" } }));
    await openSettings(page);
    await category(page, "邀请").click();
    const list = settings(page).getByRole("list", { name: "空间邀请", exact: true });
    const expiredRow = list.getByRole("listitem").filter({ hasText: expired.spaceName });
    await expect(expiredRow.getByText("已过期", { exact: true })).toBeVisible();
    await expect(expiredRow.getByRole("button", { name: `接受「${expired.spaceName}」的邀请`, exact: true })).toBeDisabled();
    expect(expiredPosts).toBe(0);
    await api(page, app, `/api/spaces/${expired.spaceId}/roster`, { status: 403 });
    await settings(page).getByRole("button", { name: `接受「${retry.spaceName}」的邀请`, exact: true }).click();
    await expect(settings(page).getByRole("alert")).toContainText("邀请提交失败，请重试");
    await expect(list.getByRole("listitem").filter({ hasText: retry.spaceName })).toBeVisible();
    await expect(settings(page).getByRole("status").filter({ hasText: /已加入/ })).toHaveCount(0);
    expect((await api<Invitation[]>(page, app, "/api/invitations")).some((item) => item.id === retry.id)).toBe(true);
    expect(await api<unknown[]>(page, app, "/api/spaces")).toEqual([]);
    await api(page, app, `/api/spaces/${retry.spaceId}/roster`, { status: 403 });
    await page.unroute(retryPath);
    await settings(page).getByRole("button", { name: `接受「${retry.spaceName}」的邀请`, exact: true }).click();
    await expect(settings(page).getByRole("status").filter({ hasText: `已加入「${retry.spaceName}」` })).toBeVisible();
    await expect(list.getByRole("listitem").filter({ hasText: retry.spaceName })).toHaveCount(0);
    expect((await api<Array<{ spaceId: string }>>(page, app, "/api/spaces")).map((space) => space.spaceId)).toEqual([retry.spaceId]);
    const roster = await api<{ members: Array<{ id: string; role: string }> }>(page, app, `/api/spaces/${retry.spaceId}/roster`);
    expect(roster.members.find((member) => member.id === account.id)?.role).toBe("viewer");
    await expect(expiredRow.getByRole("button", { name: `接受「${expired.spaceName}」的邀请`, exact: true })).toBeDisabled();
    expect(expiredPosts).toBe(0);
    await api(page, app, `/api/spaces/${expired.spaceId}/roster`, { status: 403 });
  } finally { await ownerContext.close(); }
});

test("AC-12/E5: GitHub binding guards an unsaved profile before any OAuth request, then returns to the same account", async ({ page, app, account }) => {
  await openSettings(page);
  const field = settings(page).getByLabel("显示名", { exact: true });
  await field.fill("绑定外跳前的未保存名字");
  let linkPosts = 0;
  let authorizeVisits = 0;
  let profilePatches = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url() === `${app.url}/api/auth/github/link`) linkPosts++;
    if (request.url().startsWith(`${app.github.url}/authorize?`)) authorizeVisits++;
    if (request.method() === "PATCH" && request.url() === `${app.url}/api/account/profile`) profilePatches++;
  });
  app.github.queue.push({ id: 81201, login: "settings-recovery-octocat", name: "外部 GitHub 名字" });
  const location = page.url();
  await settings(page).getByRole("button", { name: "绑定 GitHub", exact: true }).click();
  const prompt = page.getByRole("alertdialog");
  await expect(prompt).toBeVisible();
  expect(linkPosts).toBe(0);
  expect(authorizeVisits).toBe(0);
  expect(app.github.queue).toHaveLength(1);
  await prompt.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(field).toHaveValue("绑定外跳前的未保存名字");
  expect(page.url()).toBe(location);
  expect(linkPosts).toBe(0);
  expect(authorizeVisits).toBe(0);
  expect((await sessionUser(page, app))?.displayName).toBe(account.displayName);
  await settings(page).getByRole("button", { name: "绑定 GitHub", exact: true }).click();
  await expect(prompt).toBeVisible();
  expect(linkPosts).toBe(0);
  await prompt.getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(settings(page).getByRole("button", { name: "解除绑定", exact: true })).toBeVisible();
  expect(linkPosts).toBe(1);
  expect(authorizeVisits).toBe(1);
  expect(profilePatches).toBe(0);
  expect(app.github.queue).toHaveLength(0);
  expect(app.github.tokenRequests).toHaveLength(1);
  const githubAvatar = "https://avatars.githubusercontent.com/u/81201?s=96";
  expect(await sessionUser(page, app)).toEqual({ ...account, avatarUrl: githubAvatar });
  await expect(page.getByRole("button", { name: "切换空间", exact: true }).getByRole("img", { name: account.displayName, exact: true })).toHaveAttribute("src", githubAvatar);
  await expect(category(page, "我的账号")).toHaveAttribute("aria-selected", "true");
  await expect(field).toHaveValue(account.displayName);
  const github = await api<{ identity: { login: string } | null }>(page, app, "/api/auth/github/status");
  expect(github.identity?.login).toBe("settings-recovery-octocat");
  expect(new URL(page.url()).origin).toBe(app.url);
  let deletes = 0;
  await page.route("**/api/auth/github/link", async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    deletes++;
    const committed = await route.fetch({ maxRetries: 0 });
    expect(committed.status()).toBe(200);
    await committed.dispose();
    await route.abort("connectionreset");
  });
  await settings(page).getByRole("button", { name: "解除绑定", exact: true }).click();
  await expect(settings(page).getByRole("button", { name: "绑定 GitHub", exact: true })).toBeVisible();
  expect(deletes).toBe(1);
  expect((await api<{ identity: null }>(page, app, "/api/auth/github/status")).identity).toBeNull();
});

test("AC-10/E9: preserve a long document's real scroll position and refresh externally revoked administrator access", async ({ page, app, account, browser }) => {
  const adminContext = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    const other = await register(adminPage, app, "recovery_external_admin", "外部管理员");
    await api(page, app, `/api/admin/users/${other.id}`, { method: "PATCH", data: { siteRole: "admin" } });
    expect((await sessionUser(adminPage, app))?.siteRole).toBe("admin");
    const fixtureToken = await api<{ token: string }>(page, app, "/api/tokens", { method: "POST", status: 201, data: { name: "长文阅读验收 fixture", access: "write" } });
    const text = Array.from({ length: 140 }, (_, index) => `第 ${index + 1} 段：这是一篇真实笔记。用户打开设置后仍需回到原阅读位置。`).join("\n\n");
    const note = await api<{ id: string }>(page, app, "/api/v1/pages", { method: "POST", status: 201, token: fixtureToken.token, data: { title: "长文设置恢复验收", text } });
    await page.goto(`${app.url}/?page=${note.id}`);
    await expect(noteBody(page)).toContainText("第 140 段");
    const main = page.getByRole("main");
    expect(await main.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(1800);
    await main.hover();
    await page.mouse.wheel(0, 1800);
    await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBeGreaterThan(1000);
    const readingPosition = await main.evaluate((element) => element.scrollTop);
    const location = page.url();
    await openSettings(page);
    await category(page, "偏好").click();
    await settings(page).getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(settings(page)).toBeHidden();
    await expect.poll(async () => Math.abs(await main.evaluate((element) => element.scrollTop) - readingPosition)).toBeLessThanOrEqual(1);
    expect(page.url()).toBe(location);
    await expect(page.getByRole("button", { name: "设置", exact: true })).toBeFocused();
    await expectIdentity(page, account.displayName);
    await openSettings(page);
    await category(page, "账号管理").click();
    await expect(settings(page).getByRole("combobox", { name: `${account.displayName}的站点角色`, exact: true })).toBeVisible();
    await api(adminPage, app, `/api/admin/users/${account.id}`, { method: "PATCH", data: { siteRole: "user" } });
    // Window focus is the public session-refresh trigger used by settings.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(category(page, "账号管理")).toHaveCount(0);
    await expect(category(page, "我的账号")).toHaveAttribute("aria-selected", "true");
    await expect(settings(page).getByLabel("显示名", { exact: true })).toHaveValue(account.displayName);
    expect((await sessionUser(page, app))?.siteRole).toBe("user");
    await api(page, app, "/api/admin/users", { status: 403 });
    const privateRead = await adminPage.request.get(`${app.url}/api/collaboration/personal/${note.id}`);
    expect([403, 404]).toContain(privateRead.status());
    await settings(page).getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(settings(page)).toBeHidden();
    await expect.poll(async () => Math.abs(await main.evaluate((element) => element.scrollTop) - readingPosition)).toBeLessThanOrEqual(1);
    expect(page.url()).toBe(location);
    await expect(noteBody(page)).toContainText("第 140 段");
  } finally { await adminContext.close(); }
});
