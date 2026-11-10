import { test as base, expect, type Page, type Route, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";

type App = Awaited<ReturnType<typeof startServer>>;
type Json = any;
const password = "Knowledge-base-browser-acceptance-2026!";
const test = base.extend<{ app: App }>({
  app: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "notes-knowledge-bases-browser-"));
    let server: App | undefined;
    try {
      server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", github: null, dev: process.env.NOTES_TEST_DEV === "1" });
      await use(server);
    } finally {
      await server?.close();
      const target = resolve(directory);
      expect(dirname(target)).toBe(resolve(tmpdir()));
      expect(basename(target)).toMatch(/^notes-knowledge-bases-browser-/);
      await rm(target, { recursive: true, force: true });
    }
  },
});

function switcher(page: Page) { return page.getByRole("button", { name: "切换空间", exact: true }); }
function spaceMenu(page: Page) { return page.getByRole("menu", { name: "切换空间", exact: true }).last(); }
function settings(page: Page) { return page.getByRole("dialog", { name: "账号设置", exact: true }); }
function files(page: Page) { return page.getByRole("tree", { name: "Notes", exact: true }); }
function sidebar(page: Page) {
  return page.getByRole("complementary", { name: "Pages", exact: true }).or(page.getByRole("dialog", { name: "Pages", exact: true }));
}
function newPageButton(page: Page) { return sidebar(page).getByRole("button", { name: "新建", exact: true }); }
function title(page: Page) { return page.getByRole("textbox", { name: "Page title", exact: true }); }
function body(page: Page) { return page.getByRole("main").getByRole("textbox", { name: "Text", exact: true }).and(page.locator('[contenteditable="true"]')).first(); }
async function api(page: Page, app: App, path: string, method = "GET", data?: unknown, status = 200): Promise<Json> {
  const response = await page.request.fetch(`${app.url}${path}`, { method, headers: { Origin: app.url }, ...(data === undefined ? {} : { data }) });
  expect(response.status(), `${method} ${path}: ${await response.text()}`).toBe(status);
  return response.json();
}
async function register(page: Page, app: App, handle: string, displayName = handle) {
  await page.goto(app.url);
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.locator('input[name="handle"]').fill(handle);
  await page.locator('input[name="displayName"]').fill(displayName);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await expect(switcher(page)).toBeVisible();
  await expect(switcher(page).locator(".space-switcher__user")).toHaveText(displayName);
  return (await api(page, app, "/api/session")).user;
}
async function records(page: Page, app: App, scope: string, collection = "pages"): Promise<Json[]> {
  return api(page, app, `/api/records/${scope}/${collection}`);
}
async function summaries(page: Page, app: App): Promise<Json[]> { return api(page, app, "/api/spaces"); }
async function summary(page: Page, app: App, spaceId: string) {
  const kb = (await summaries(page, app)).find((item) => item.spaceId === spaceId); expect(kb).toBeTruthy(); return kb;
}
async function seedLibrary(page: Page, app: App, name: string) {
  return api(page, app, "/api/knowledge-bases", "POST", { requestId: randomUUID(), name }, 201);
}
async function seedMembership(owner: Page, member: Page, app: App, kb: Json, handle: string, role = "editor") {
  await api(owner, app, `/api/spaces/${kb.spaceId}/invitations`, "POST", { handle, role });
  const invitations = await api(member, app, "/api/invitations");
  const invitation = invitations.find((item: Json) => item.spaceId === kb.spaceId); expect(invitation).toBeTruthy();
  await api(member, app, `/api/invitations/${invitation.id}`, "POST", { accept: true });
}
async function openDrawer(page: Page) {
  if (!await switcher(page).isVisible()) await page.getByRole("button", { name: "All pages", exact: true }).click();
  await expect(switcher(page)).toBeVisible();
}
async function switchSpace(page: Page, name: string) {
  await openDrawer(page); await switcher(page).click();
  await expect(spaceMenu(page)).toBeVisible();
  await spaceMenu(page).getByRole("menuitem").filter({ hasText: name }).click();
  await expect(spaceMenu(page)).toBeHidden();
}
async function createThroughUI(page: Page, app: App, name: string) {
  await openDrawer(page); await switcher(page).click();
  await spaceMenu(page).getByRole("menuitem", { name: "新建团队知识库", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "新建团队知识库", exact: true });
  await modal.getByLabel("知识库名称", { exact: true }).fill(name);
  await modal.getByRole("button", { name: "创建团队知识库", exact: true }).click();
  await expect(modal).toBeHidden();
  const kb = (await summaries(page, app)).find((space) => space.name === name); expect(kb).toBeTruthy();
  await expect(page.locator(`article[data-page-id="${kb.knowledgeBase.homePageId}"]`)).toBeVisible();
  await expect(title(page)).toBeVisible(); return kb;
}
async function createPage(page: Page, app: App, scope: string, name: string, text = `正文 ${name}`) {
  const previous = new URL(page.url()).searchParams.get("page");
  await openDrawer(page); await newPageButton(page).click();
  await page.locator('.menu[role="menu"][aria-label="新建"]').getByRole("menuitem", { name: "页面", exact: true }).click();
  await expect.poll(() => { const id = new URL(page.url()).searchParams.get("page"); return Boolean(id && id !== previous); }).toBe(true);
  const pageId = new URL(page.url()).searchParams.get("page")!;
  const document = page.locator(`article[data-page-id="${pageId}"]`);
  const newTitle = document.getByRole("textbox", { name: "Page title", exact: true });
  await expect(document).toBeVisible(); await expect(newTitle).toBeVisible();
  await newTitle.focus(); await newTitle.fill(name); await expect(newTitle).toHaveText(name);
  await body(page).fill(text);
  await expect.poll(async () => JSON.stringify(await records(page, app, scope))).toContain(name);
  await expect.poll(() => savedBody(page, app, scope, pageId)).toContain(text);
  const saved = (await records(page, app, scope)).find((row) => row.id === pageId);
  expect(saved?.value.title_content.map((run: Json) => run.text ?? "").join("")).toBe(name);
  return saved;
}
async function savedBody(page: Page, app: App, scope: string, pageId: string) {
  return (await records(page, app, scope, "blocks")).filter((row) => row.value.page === pageId).map((row) => JSON.stringify(row.value)).join("\n");
}
async function search(page: Page, query: string) {
  await openDrawer(page);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Search pages", exact: true });
  await dialog.getByRole("textbox", { name: "Search pages", exact: true }).fill(query);
  return dialog;
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

test("UC-13 browser: create from the username menu and keep the four Notes views and original settings", async ({ page, app }, info) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await register(page, app, "creator", "创建验收用户");
  await expect(page.getByRole("tablist", { name: "Page list", exact: true }).getByRole("tab")).toHaveCount(4);
  for (const name of ["Files", "Favorites", "Shared", "Graph"]) await expect(page.getByRole("tab", { name, exact: true })).toBeVisible();
  await switcher(page).click();
  await expect(spaceMenu(page)).toContainText("个人空间"); await expect(spaceMenu(page)).toContainText("团队");
  await expect(spaceMenu(page).getByRole("menuitem").last()).toHaveText("新建团队知识库");
  await spaceMenu(page).getByRole("menuitem", { name: "新建团队知识库", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "新建团队知识库", exact: true });
  const name = modal.getByLabel("知识库名称", { exact: true }); await expect(name).toBeFocused();
  await name.fill("   ");
  const submit = modal.getByRole("button", { name: "创建团队知识库", exact: true });
  if (await submit.isEnabled()) await submit.click();
  await expect(modal).toBeVisible(); expect(await summaries(page, app)).toEqual([]);
  await page.keyboard.press("Escape"); await expect(modal).toBeHidden();
  const kb = await createThroughUI(page, app, "工程知识库");
  expect(kb.role).toBe("owner"); expect(kb.knowledgeBase.homePageId).toBeTruthy();
  expect((await records(page, app, kb.spaceId)).filter((row) => !row.value.parent_id)).toHaveLength(1);
  await expect(page.getByRole("button", { name: "成员", exact: true })).toBeVisible();
  const created = await createPage(page, app, kb.spaceId, "团队主题", "通过真实编辑器保存团队内容");
  expect(created.value.parent_id).toBe(kb.knowledgeBase.homePageId);
  await page.reload(); await expect(title(page)).toHaveText("团队主题");
  await expect(body(page)).toHaveText("通过真实编辑器保存团队内容");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(settings(page)).toBeVisible();
  for (const section of ["我的账号", "偏好", "邀请", "Agent 令牌", "账号管理"]) await expect(settings(page).getByRole("tab", { name: section, exact: true })).toBeVisible();
  await settings(page).getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(title(page)).toHaveText("团队主题");
  await screenshot(page, info, "knowledge-base-desktop"); expect(errors).toEqual([]);
});

test("UC-13 browser: invite in reused member dialog, accept in settings, and refresh editor/viewer/removal permissions", async ({ page: owner, browser, app }) => {
  const memberContext = await browser.newContext(); const member = await memberContext.newPage();
  try {
    await register(owner, app, "owner"); const user = await register(member, app, "member");
    const kb = await createThroughUI(owner, app, "协作知识库");
    const created = await createPage(owner, app, kb.spaceId, "共享内容", "只有成员可阅读");
    await owner.getByRole("button", { name: "成员", exact: true }).click();
    await expect(owner.getByRole("button", { name: "创建链接", exact: true })).toHaveCount(0);
    await expect(owner.getByRole("button", { name: "Stop sharing", exact: true })).toHaveCount(0);
    await owner.getByLabel("Add people by handle", { exact: true }).fill("member");
    await owner.getByRole("button", { name: "Can edit", exact: true }).click();
    await owner.getByRole("menuitem", { name: "Can view", exact: true }).click();
    await owner.getByRole("button", { name: "Invite", exact: true }).click();
    await expect(owner.getByText("Waiting to accept").first()).toBeVisible();
    const denied = await member.request.get(`${app.url}/api/records/${kb.spaceId}/pages`); expect([403, 404]).toContain(denied.status());
    await switcher(member).click(); await expect(spaceMenu(member)).not.toContainText(kb.name); await member.keyboard.press("Escape");
    await member.getByRole("button", { name: "设置", exact: true }).click();
    await settings(member).getByRole("tab", { name: "邀请", exact: true }).click();
    await settings(member).getByRole("button", { name: /^接受「/ }).click();
    await settings(member).getByRole("button", { name: "关闭设置", exact: true }).click();
    await switchSpace(member, kb.name);
    await member.getByRole("navigation", { name: "知识库目录", exact: true }).getByRole("button", { name: "共享内容", exact: true }).click();
    await expect(member.getByText("只有成员可阅读", { exact: true }).first()).toBeVisible();
    await expect(member.locator('.block__editable[contenteditable="true"]')).toHaveCount(0);
    await expect(newPageButton(member)).toBeDisabled();
    const memberRow = owner.locator(".share__member").filter({ hasText: "@member" });
    await memberRow.getByRole("button", { name: "Can view", exact: true }).click();
    await owner.getByRole("menuitem", { name: "Can edit", exact: true }).click();
    await expect(body(member)).toBeVisible(); await body(member).fill("成员通过浏览器提交内容");
    await expect.poll(() => savedBody(owner, app, kb.spaceId, created.id)).toContain("成员通过浏览器提交内容");
    await memberRow.getByRole("button", { name: "Can edit", exact: true }).click();
    await owner.getByRole("menuitem", { name: "Can view", exact: true }).click();
    await expect(member.locator('.block__editable[contenteditable="true"]')).toHaveCount(0);
    await api(owner, app, `/api/spaces/${kb.spaceId}/members/${user.id}`, "DELETE");
    await expect(member.getByText("成员通过浏览器提交内容", { exact: true })).toHaveCount(0);
    await switcher(member).click(); await expect(spaceMenu(member)).not.toContainText(kb.name); await member.keyboard.press("Escape");
    await switchSpace(member, "个人空间");
    await createPage(member, app, "personal", "移除后仍可写个人笔记");
    expect(await savedBody(owner, app, kb.spaceId, created.id)).toContain("成员通过浏览器提交内容");
  } finally { await memberContext.close(); }
});

test("UC-13 browser: restore last pages and scope files, favorites, search, graph, and new content per library", async ({ page, browser, app }) => {
  const peerContext = await browser.newContext(); const peer = await peerContext.newPage();
  try {
    await register(page, app, "multi"); await register(peer, app, "peer");
    const privatePage = await createPage(page, app, "personal", "独有词个人", "个人正文独有词");
    const own = await createThroughUI(page, app, "自有工程库");
    const owned = await createPage(page, app, own.spaceId, "独有词工程", "工程正文独有词");
    await page.getByRole("button", { name: "Add to favorites", exact: true }).click();
    const editable = await createThroughUI(peer, app, "加入产品库");
    await createPage(peer, app, editable.spaceId, "独有词产品", "产品正文独有词");
    const viewer = await createThroughUI(peer, app, "只读资料库");
    await createPage(peer, app, viewer.spaceId, "独有词只读", "只读正文独有词");
    await seedMembership(peer, page, app, editable, "multi"); await seedMembership(peer, page, app, viewer, "multi", "viewer");
    await switchSpace(page, editable.name);
    const edited = await createPage(page, app, editable.spaceId, "编辑者新页", "编辑者正文"); expect(edited.value.parent_id).toBe(editable.knowledgeBase.homePageId);
    await switchSpace(page, viewer.name);
    await expect(page.locator('.block__editable[contenteditable="true"]')).toHaveCount(0);
    await expect(newPageButton(page)).toBeDisabled();
    await switchSpace(page, own.name); await expect(title(page)).toHaveText("独有词工程");
    await expect(files(page)).not.toContainText("独有词个人"); await expect(files(page)).not.toContainText("独有词产品");
    await page.getByRole("tab", { name: "Favorites", exact: true }).click();
    const favorites = page.getByRole("tree", { name: "Favorites", exact: true });
    await expect(favorites).toContainText("独有词工程"); await expect(favorites).not.toContainText("独有词个人");
    await page.getByRole("tab", { name: "Graph", exact: true }).click();
    await expect(page.locator(".graph").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Open 独有词工程", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open 独有词个人", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open 独有词产品", exact: true })).toHaveCount(0);
    const found = await search(page, "独有词");
    await expect(found.getByRole("option").filter({ has: page.locator(".menu__label").filter({ hasText: /^独有词工程$/ }) })).toBeVisible();
    await expect(found.getByRole("option").filter({ hasText: "独有词个人" })).toHaveCount(0);
    await expect(found.getByRole("option").filter({ hasText: "独有词产品" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    const bodyFound = await search(page, "工程正文独有词");
    await expect(bodyFound.getByRole("option").filter({ has: page.locator(".menu__label").filter({ hasText: /^独有词工程$/ }) })).toBeVisible(); await page.keyboard.press("Escape");
    await switchSpace(page, editable.name); await expect(title(page)).toHaveText("编辑者新页");
    await switchSpace(page, "个人空间"); await expect(title(page)).toHaveText("独有词个人");
    const newPrivate = await createPage(page, app, "personal", "只读切回后个人新页");
    expect(newPrivate.value.parent_id ?? null).toBe(null);
    await switchSpace(page, viewer.name);
    const newLibrary = await createThroughUI(page, app, "只读身份不影响创建"); expect(newLibrary.role).toBe("owner");
    expect((await records(page, app, own.spaceId)).some((row) => row.id === owned.id)).toBe(true);
    expect((await records(page, app, "personal")).some((row) => row.id === privatePage.id)).toBe(true);
  } finally { await peerContext.close(); }
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function targets(request: { method(): string; postDataJSON(): Json }, scope: string, pageId: string) {
  if (request.method() !== "POST") return false;
  const data = request.postDataJSON();
  return Boolean(data?.textUpdates?.some((update: Json) => update.scope === scope && update.pageId === pageId)
    || data?.writes?.some((write: Json) => write.scope === scope && (write.id === pageId || write.value?.page === pageId || write.base?.page === pageId)));
}

for (const revocation of ["remove", "archive"] as const) {
  test(`UC-13 browser: ${revocation} rejects an in-flight A edit without blocking personal or writable B saves`, async ({ page, browser, app }) => {
    const ownerContext = await browser.newContext(); const owner = await ownerContext.newPage();
    const pending = gate(); const arrived = gate(); let held = false;
    try {
      const user = await register(page, app, "member"); await register(owner, app, "owner");
      const personal = await createPage(page, app, "personal", "个人独立写入", "个人原始正文");
      const a = await seedLibrary(owner, app, "团队A"); const b = await seedLibrary(owner, app, "团队B");
      await seedMembership(owner, page, app, a, "member"); await seedMembership(owner, page, app, b, "member");
      await switchSpace(page, b.name); const bPage = await createPage(page, app, b.spaceId, "B独立写入", "B原始正文");
      await switchSpace(page, a.name); const aPage = await createPage(page, app, a.spaceId, "A在途写入", "A最后已确认正文");
      const handler = async (route: Route) => {
        if (!held && targets(route.request(), a.spaceId, aPage.id)) {
          held = true; arrived.release(); await pending.promise;
        }
        await route.continue();
      };
      await page.route("**/api/records/batch", handler);
      await body(page).fill("A撤权后的拒绝草稿");
      await arrived.promise;
      if (revocation === "remove") await api(owner, app, `/api/spaces/${a.spaceId}/members/${user.id}`, "DELETE");
      else {
        const current = await summary(owner, app, a.spaceId);
        await api(owner, app, `/api/knowledge-bases/${a.spaceId}/archive`, "POST", { requestId: randomUUID(), revision: current.knowledgeBase.revision, archived: true });
      }
      const rejected = page.waitForResponse((response) => response.url().endsWith("/api/records/batch") && targets(response.request(), a.spaceId, aPage.id));
      pending.release(); const refusal = await rejected;
      expect([403, 409]).toContain(refusal.status());
      await page.unroute("**/api/records/batch", handler);
      expect(await savedBody(owner, app, a.spaceId, aPage.id)).toContain("A最后已确认正文");
      expect(await savedBody(owner, app, a.spaceId, aPage.id)).not.toContain("A撤权后的拒绝草稿");
      await switchSpace(page, "个人空间"); await expect(title(page)).toHaveText("个人独立写入");
      await body(page).fill("A拒绝后个人空间真正保存成功");
      await expect.poll(() => savedBody(page, app, "personal", personal.id)).toContain("A拒绝后个人空间真正保存成功");
      await page.reload(); await expect(body(page)).toHaveText("A拒绝后个人空间真正保存成功");
      await switchSpace(page, b.name); await expect(title(page)).toHaveText("B独立写入");
      await body(page).fill("A拒绝后B空间真正保存成功");
      await expect.poll(() => savedBody(owner, app, b.spaceId, bPage.id)).toContain("A拒绝后B空间真正保存成功");
      await page.reload(); await expect(body(page)).toHaveText("A拒绝后B空间真正保存成功");
      expect(await savedBody(page, app, "personal", personal.id)).not.toContain("A撤权后的拒绝草稿");
      expect(await savedBody(owner, app, b.spaceId, bPage.id)).not.toContain("A撤权后的拒绝草稿");
    } finally { pending.release(); await ownerContext.close(); }
  });
}

test("UC-13 browser: space identity uses the real uploaded avatar and mobile settings retain focus", async ({ page, app }, info) => {
  await register(page, app, "avatar_mobile", "真实头像验收");
  const { default: sharp } = await import("sharp");
  const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#bf5138" } }).png().toBuffer();
  const upload = await page.request.put(`${app.url}/api/account/avatar`, { headers: { Origin: app.url, "Content-Type": "image/png" }, data: image });
  expect(upload.status()).toBe(200); const user = (await upload.json()).user;
  expect(user.avatarUrl).toBeTruthy(); await page.reload();
  const photo = switcher(page).getByRole("img", { name: user.displayName, exact: true });
  await expect(photo).toHaveAttribute("src", user.avatarUrl);
  await expect.poll(() => photo.evaluate((element) => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0)).toBe(true);
  await createThroughUI(page, app, "头像保持团队身份");
  await expect(photo).toHaveAttribute("src", user.avatarUrl);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "All pages", exact: true })).toBeVisible();
  await openDrawer(page); await switcher(page).click();
  await expect(spaceMenu(page)).toBeVisible(); await page.keyboard.press("Escape");
  await expect(spaceMenu(page)).toBeHidden(); await expect(switcher(page)).toBeFocused();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(settings(page)).toBeVisible();
  await screenshot(page, info, "knowledge-base-mobile-account-settings");
  await settings(page).getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(page.getByRole("button", { name: "设置", exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await switcher(page).click(); await screenshot(page, info, "knowledge-base-mobile-space-menu");
  await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
  await expect(switcher(page)).toBeHidden();
  await expect(page.getByRole("button", { name: "All pages", exact: true })).toBeFocused();
});

test("UC-13 browser: a lost creation response queries its operation and does not create a second home", async ({ page, app }) => {
  await register(page, app, "lost_create"); let intercepted = false; let requestId = "";
  await page.route("**/api/knowledge-bases", async (route) => {
    if (route.request().method() !== "POST" || intercepted) return route.continue();
    intercepted = true; requestId = route.request().postDataJSON().requestId;
    const committed = await route.fetch(); expect(committed.status()).toBe(201);
    await route.abort("connectionfailed");
  });
  const queried = page.waitForRequest((request) => request.method() === "GET" && request.url().includes("/api/knowledge-bases/operations/"));
  await createThroughUI(page, app, "响应丢失只创建一次");
  const lookup = await queried; expect(lookup.url()).toBe(`${app.url}/api/knowledge-bases/operations/${requestId}`);
  const matches = (await summaries(page, app)).filter((space) => space.name === "响应丢失只创建一次");
  expect(matches).toHaveLength(1); expect((await records(page, app, matches[0].spaceId)).length).toBe(1);
  await page.reload(); expect((await summaries(page, app)).filter((space) => space.name === "响应丢失只创建一次")).toHaveLength(1);
});

async function searchAllSpaces(page: Page, query: string) {
  const dialog = await search(page, query);
  await dialog.getByRole("combobox", { name: "搜索范围", exact: true }).selectOption("all");
  return dialog;
}

test("UC-13 browser: a late initial Plane 200 cannot resurrect a newly joined library after real revocation", async ({ page, browser, app }) => {
  const ownerContext = await browser.newContext(); const owner = await ownerContext.newPage();
  const release = gate(); const initialRead = gate(); const delivered = gate(); let captured = false;
  try {
    // Keep this app loaded before membership exists. Do not reload for the race.
    const user = await register(page, app, "late_member"); await register(owner, app, "late_owner");
    await createPage(page, app, "personal", "原有个人入口", "个人正文保持可用");
    const kb = await createThroughUI(owner, app, "迟到响应知识库");
    await createPage(owner, app, kb.spaceId, "撤权后不可复现旧页面", "撤权后不可复现旧正文");
    await page.route(`**/api/records/${kb.spaceId}/pages`, async (route) => {
      if (route.request().method() !== "GET" || captured) return route.continue();
      captured = true;
      const authorized = await route.fetch();
      expect(authorized.status()).toBe(200);
      const oldBody = await authorized.text(); expect(oldBody).toContain("撤权后不可复现旧页面");
      initialRead.release(); await release.promise;
      await route.fulfill({ response: authorized, body: oldBody }); delivered.release();
    });
    await seedMembership(owner, page, app, kb, "late_member");
    // Some clients load membership Planes eagerly; others open on selection.
    // Both paths must keep the same revocation boundary.
    await openDrawer(page); await switcher(page).click();
    await spaceMenu(page).getByRole("menuitem").filter({ hasText: kb.name }).click();
    await initialRead.promise;
    const revokedSpaces = page.waitForResponse(async (response) => response.url() === `${app.url}/api/spaces`
      && response.request().method() === "GET" && response.status() === 200
      && !(await response.json()).some((space: Json) => space.spaceId === kb.spaceId));
    await api(owner, app, `/api/spaces/${kb.spaceId}/members/${user.id}`, "DELETE");
    await revokedSpaces;
    await openDrawer(page); await switcher(page).click();
    await expect(spaceMenu(page)).not.toContainText(kb.name); await page.keyboard.press("Escape");
    // Deliver the genuine pre-revocation response only after the app saw removal.
    const nextPersonalPoll = page.waitForResponse((response) => response.url() === `${app.url}/api/records/personal/pages` && response.request().method() === "GET");
    release.release(); await delivered.promise; await nextPersonalPoll;
    await expect(files(page)).not.toContainText("撤权后不可复现旧页面");
    await expect(page.getByText("撤权后不可复现旧正文", { exact: true })).toHaveCount(0);
    const global = await searchAllSpaces(page, "撤权后不可复现");
    await expect(global.getByRole("option").filter({ hasText: "撤权后不可复现旧页面" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await switcher(page).click(); await expect(spaceMenu(page)).not.toContainText(kb.name); await page.keyboard.press("Escape");
    await expect(title(page)).toHaveText("原有个人入口");
    const denied = await page.request.get(`${app.url}/api/records/${kb.spaceId}/pages`); expect([403, 404]).toContain(denied.status());
  } finally { release.release(); await ownerContext.close(); }
});

test("UC-13 browser: library settings rename, archive with confirmation, and restore actual editor writes", async ({ page, app }) => {
  await register(page, app, "lifecycle_owner");
  const kb = await createThroughUI(page, app, "生命周期知识库");
  const created = await createPage(page, app, kb.spaceId, "归档前页面", "归档前已保存正文");
  const entry = page.getByRole("button", { name: "知识库设置", exact: true });
  await entry.click();
  const dialog = page.getByRole("dialog", { name: "知识库设置", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("知识库名称", { exact: true }).fill("更新后的知识库");
  await dialog.getByLabel(/简介/).fill("设置中保存的团队简介");
  await dialog.getByRole("button", { name: /^保存/ }).click();
  await expect.poll(async () => (await summary(page, app, kb.spaceId)).name).toBe("更新后的知识库");
  expect((await summary(page, app, kb.spaceId)).knowledgeBase.description).toBe("设置中保存的团队简介");
  await page.keyboard.press("Escape");
  await entry.click(); await dialog.getByRole("button", { name: "归档知识库", exact: true }).click();
  await page.getByRole("button", { name: /^确认归档/ }).click();
  await expect.poll(async () => (await summary(page, app, kb.spaceId)).knowledgeBase.archived).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.locator('.block__editable[contenteditable="true"]')).toHaveCount(0);
  await expect(page.getByText("归档前已保存正文", { exact: true }).first()).toBeVisible();
  await entry.click(); await dialog.getByRole("button", { name: "恢复知识库", exact: true }).click();
  await expect.poll(async () => (await summary(page, app, kb.spaceId)).knowledgeBase.archived).toBe(false);
  await page.keyboard.press("Escape");
  await expect(body(page)).toBeVisible(); await body(page).fill("从知识库设置恢复后实际保存");
  await expect.poll(() => savedBody(page, app, kb.spaceId, created.id)).toContain("从知识库设置恢复后实际保存");
  await page.reload(); await expect(body(page)).toHaveText("从知识库设置恢复后实际保存");
});
