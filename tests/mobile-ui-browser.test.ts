import { test, expect, type Page } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";

let server: Awaited<ReturnType<typeof startServer>>;
let directory: string;
const password = "Mobile-ui-browser-password-2026!";
const evidence = resolve(".evidence/uc55");

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
  colorScheme: "light",
});

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-mobile-ui-browser-"));
  server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1" });
});

test.afterAll(async () => {
  await server?.close();
  if (directory) {
    const target = resolve(directory);
    expect(dirname(target)).toBe(resolve(tmpdir()));
    expect(basename(target)).toMatch(/^notes-mobile-ui-browser-/);
    await rm(target, { recursive: true, force: true });
  }
});

async function registerMobile(page: Page, handle: string) {
  await page.goto(server.url);
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.locator('input[name="handle"]').fill(handle);
  await page.locator('input[name="displayName"]').fill(handle);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await expect(page.getByRole("button", { name: "All pages", exact: true })).toBeVisible();
}

async function createToken(page: Page, name: string): Promise<string> {
  const res = await page.request.post(`${server.url}/api/tokens`, {
    headers: { Origin: server.url },
    data: { name, access: "write" },
  });
  expect(res.status()).toBe(201);
  return String((await res.json()).token);
}

async function api(page: Page, path: string, method = "GET", data?: unknown, token?: string) {
  const response = await page.request.fetch(`${server.url}${path}`, {
    method,
    headers: {
      Origin: server.url,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(data === undefined ? {} : { data }),
  });
  return response;
}

async function waitCollab(page: Page) {
  await page.waitForFunction(() => {
    const id = new URL(window.location.href).searchParams.get("page");
    return id ? (window as { __collabSession?: (page: string) => boolean }).__collabSession?.(id) : false;
  });
}

async function saveShot(page: Page, name: string) {
  await mkdir(evidence, { recursive: true });
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.screenshot({ path: join(evidence, name), animations: "disabled" });
}

async function waitSheetReady(page: Page, selector = ".bottom-sheet.is-shown") {
  const sheet = page.locator(selector).last();
  await expect(sheet).toBeVisible();
  await sheet.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => {}))));
  return sheet;
}

test("UC-55 AC-01: 手机阅读态无窄条、悬浮命令坞与抽屉/搜索/新建交互正常", async ({ page }) => {
  await registerMobile(page, "uc55_nav");
  const lines = Array.from({ length: 24 }, (_, idx) => `第 ${idx + 1} 段用于测试移动端沉浸阅读与底部命令坞随滚动收起。`).join("\n\n");
  const parent = await (await api(page, "/api/v1/pages", "POST", { title: "移动端架构指南", text: lines })).json();
  await api(page, "/api/v1/pages", "POST", { title: "交互细则", parentId: parent.id, text: "子页面正文" });

  await page.goto(`${server.url}?page=${parent.id}`);
  await expect(page.getByRole("textbox", { name: "Page title", exact: true })).toHaveText("移动端架构指南");
  await expect(page.locator(".rail")).toHaveCount(0);
  await expect(page.locator(".topbar--mobile")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "移动端命令坞", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await saveShot(page, "01-doc-reading.png");

  // Scroll down condenses MobileDock into circular FAB + pill; scroll back restores it.
  const surface = page.locator(".page-surface");
  await surface.evaluate((el) => { el.scrollTop = 260; el.dispatchEvent(new Event("scroll")); });
  await expect(page.locator(".mobile-dock-wrap")).toHaveClass(/is-condensed/);
  await surface.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
  await expect(page.locator(".mobile-dock-wrap")).not.toHaveClass(/is-condensed/);

  // Open All pages BottomSheet and verify 44px touch targets + zero overflow.
  const allPages = page.getByRole("button", { name: "All pages", exact: true });
  await allPages.tap();
  const sheet = await waitSheetReady(page, ".bottom-sheet.sidebar--sheet.is-shown");
  const tabHeights = await sheet.getByRole("tab").evaluateAll((tabs) => tabs.map((t) => t.getBoundingClientRect().height));
  for (const h of tabHeights) expect(h).toBeGreaterThanOrEqual(42);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await saveShot(page, "02-nav-sheet.png");

  // Dismiss drawer via top scrim and confirm focus restores to All pages trigger.
  await page.getByRole("button", { name: "Close the page list", exact: true }).click({ position: { x: 195, y: 40 } });
  await expect(page.getByRole("dialog", { name: "Pages", exact: true })).toBeHidden();
  await expect(allPages).toBeFocused();

  // QuickFind opens in a tall BottomSheet and closes on Escape.
  await page.getByRole("button", { name: "Search", exact: true }).tap();
  await expect(page.getByRole("dialog", { name: "Search pages", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Search pages", exact: true })).toBeHidden();

  // Dock + opens 新建内容 sheet and closes on Escape.
  await page.getByRole("button", { name: "新建", exact: true }).tap();
  const createDialog = page.getByRole("dialog", { name: "新建", exact: true });
  await expect(createDialog).toBeVisible();
  await expect(createDialog.getByRole("menuitem", { name: "页面", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(createDialog).toBeHidden();
});

test("UC-55 AC-02: 既有无标题页不弹键盘；新建页及正文激活 MobileEditBar 与折叠选区样式", async ({ page }) => {
  await registerMobile(page, "uc55_edit");
  const untitled = await (await api(page, "/api/v1/pages", "POST", { title: "", text: "" })).json();
  await page.goto(`${server.url}?page=${untitled.id}`);
  await expect(page.getByRole("textbox", { name: "Page title", exact: true })).toBeVisible();
  await expect(page.locator(".mobile-edit-bar")).toHaveCount(0);
  await expect(page.locator(".topbar__done")).toHaveCount(0);

  // Create a fresh page via MobileDock + -> 页面: auto-focuses title and shows TopBar 完成.
  await page.getByRole("button", { name: "新建", exact: true }).tap();
  await waitSheetReady(page, ".bottom-sheet.is-shown");
  await page.getByRole("menuitem", { name: "页面", exact: true }).tap();
  const titleField = page.getByRole("textbox", { name: "Page title", exact: true });
  await expect(titleField).toBeFocused();
  await expect(page.locator(".topbar__done")).toBeVisible();
  await titleField.fill("手机端编辑验收页");
  await waitCollab(page);

  // Focus first body block -> MobileEditBar mounts, MobileDock yields, desktop FormatToolbar suppressed.
  const firstEditable = page.locator(".block__editable").first();
  await firstEditable.tap();
  await expect(firstEditable).toBeFocused();
  const editBar = page.getByRole("toolbar", { name: "正文编辑栏", exact: true });
  await expect(editBar).toBeVisible();
  await expect(page.locator(".mobile-dock-wrap")).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("toolbar", { name: "Text formatting", exact: true })).toHaveCount(0);

  // Collapsed-caret B toggle: press Bold before typing, verify aria-pressed and rendered <strong>.
  const boldBtn = editBar.getByRole("button", { name: "Bold", exact: true });
  await boldBtn.tap();
  await expect(boldBtn).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.type("加粗片段");
  await expect(firstEditable.locator("strong")).toHaveText("加粗片段");
  await saveShot(page, "03-doc-editing.png");

  // Turn into Heading 2 via 转换为 sheet.
  await editBar.getByRole("button", { name: "转换为", exact: true }).tap();
  await waitSheetReady(page, ".bottom-sheet.pop--sheet.is-shown");
  await page.getByRole("menuitem", { name: "Heading 2", exact: true }).tap();
  await expect(page.locator("h2.block__editable")).toContainText("加粗片段");

  // Insert To-do block via 插入块 sheet.
  await editBar.getByRole("button", { name: "插入块", exact: true }).tap();
  await waitSheetReady(page, ".bottom-sheet.pop--sheet.is-shown");
  await page.getByRole("menuitem", { name: "To-do list", exact: true }).tap();
  await expect(page.locator(".block--todo")).toHaveCount(1);

  // Tapping 完成 in TopBar ends editing and restores MobileDock.
  await page.locator(".topbar__done").tap();
  await expect(editBar).toHaveCount(0);
  await expect(page.locator(".mobile-dock-wrap")).not.toHaveAttribute("aria-hidden", "true");
});

test("UC-55 AC-03: 数据库适配、触摸排序上下移、底部 Filter/Sort 抽屉与两段式 SidePeek", async ({ page }) => {
  await registerMobile(page, "uc55_db");
  const token = await createToken(page, "UC-55 DB Seed");

  const dbRes = await api(page, "/api/v1/databases", "POST", {
    requestId: "uc55-db-create",
    title: "移动端任务看板",
    database: {
      properties: [
        { id: "prop_status", name: "状态", type: "select", options: ["待办", "进行中", "完成"], option_colors: { "待办": "gray", "进行中": "blue", "完成": "green" } },
        { id: "prop_score", name: "优先级", type: "number" },
      ],
      views: [{ id: "view_table", name: "全部任务", kind: "table" }],
    },
  }, token);
  expect(dbRes.status()).toBe(201);
  const db = await dbRes.json();

  const addRow = async (reqId: string, rowTitle: string, status: string, score: string) => {
    const revRes = await api(page, `/api/v1/databases/${db.id}`, "GET", undefined, token);
    const rev = (await revRes.json()).revision;
    const rowRes = await api(page, `/api/v1/databases/${db.id}/rows`, "POST", {
      requestId: reqId,
      baseRevision: rev,
      title: rowTitle,
      properties: { prop_status: status, prop_score: score },
    }, token);
    expect(rowRes.status()).toBe(201);
    return rowRes.json();
  };

  await addRow("uc55-r1", "这是一条特别长的第一列任务名称需要被安全截断在移动端列宽内", "进行中", "10");
  await addRow("uc55-r2", "补充移动端测试", "待办", "20");

  await page.goto(`${server.url}?page=${db.id}`);
  const wrap = page.locator(".db__table-wrap");
  await expect(wrap).toBeVisible();
  await expect(wrap).toHaveAttribute("role", "region");
  await expect(wrap).toHaveAttribute("tabindex", "0");

  const firstColBox = await page.locator("th.db__name").first().boundingBox();
  expect(firstColBox).not.toBeNull();
  expect(firstColBox!.width).toBeLessThanOrEqual(200);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // Filter opens inside a BottomSheet with zero horizontal overflow.
  await page.getByRole("button", { name: "Filter", exact: true }).tap();
  const filterSheet = await waitSheetReady(page, ".bottom-sheet.pop--sheet.is-shown");
  await expect(filterSheet.locator(".filter-panel")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(filterSheet).toBeHidden();

  // Sort opens as a BottomSheet and touch-accessible up/down buttons reorder sort rules.
  await page.getByRole("button", { name: "Sort", exact: true }).tap();
  const sortSheet = await waitSheetReady(page, ".bottom-sheet.pop--sheet.is-shown");
  await sortSheet.getByRole("menuitem", { name: "状态", exact: true }).tap();
  await expect(page.locator(".sort-panel")).toBeVisible();
  await page.locator(".sort-panel").getByRole("menuitem", { name: "Add sort", exact: true }).tap();
  const sortLines = page.locator(".sort-panel__line");
  await expect(sortLines).toHaveCount(2);
  const firstSortBefore = await sortLines.nth(0).getAttribute("data-sort");
  const secondSortBefore = await sortLines.nth(1).getAttribute("data-sort");
  await page.locator(".sort-panel__order button[aria-label$='down']").first().tap();
  expect(await sortLines.nth(0).getAttribute("data-sort")).toBe(secondSortBefore);
  expect(await sortLines.nth(1).getAttribute("data-sort")).toBe(firstSortBefore);
  await page.keyboard.press("Escape");
  await expect(page.locator(".sort-panel")).toBeHidden();

  // Open row into two-stage SidePeek BottomSheet, toggle height stage, edit inside peek.
  await page.getByRole("button", { name: "Open 补充移动端测试", exact: true }).tap();
  const peekSheet = await waitSheetReady(page, ".bottom-sheet.side-peek--sheet.is-shown");
  await expect(peekSheet).toHaveClass(/bottom-sheet--mid/);
  const midHeight = (await peekSheet.boundingBox())!.height;
  await saveShot(page, "04-database-peek.png");

  await peekSheet.getByRole("button", { name: "展开全屏", exact: true }).tap();
  await expect(peekSheet).toHaveClass(/bottom-sheet--expanded/);
  await peekSheet.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished.catch(() => {}))));
  const expandedHeight = (await peekSheet.boundingBox())!.height;
  expect(expandedHeight).toBeGreaterThan(midHeight);

  await peekSheet.getByRole("button", { name: "恢复半屏", exact: true }).tap();
  await expect(peekSheet).toHaveClass(/bottom-sheet--mid/);

  // Focusing body inside peek transitions peek header to editing 完成/Undo/Redo + shows MobileEditBar.
  const peekEditable = peekSheet.locator(".block__editable").first();
  await peekEditable.tap();
  await expect(peekSheet.locator(".side-peek__head--mobile .topbar__done")).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "正文编辑栏", exact: true })).toBeVisible();
  await peekSheet.locator(".side-peek__head--mobile .topbar__done").tap();
  await expect(peekSheet.getByRole("button", { name: "Close side peek", exact: true })).toBeVisible();
  await peekSheet.getByRole("button", { name: "Close side peek", exact: true }).tap();
  await expect(peekSheet).toBeHidden();
});

test("UC-55 AC-04: 公开分享底部目录胶囊、历史 peek 抽屉与全屏账号设置", async ({ page, browser }) => {
  await registerMobile(page, "uc55_sec");
  const root = await (await api(page, "/api/v1/pages", "POST", { title: "公开手册首页", text: "欢迎阅读移动端公开分享页面。" })).json();
  await api(page, "/api/v1/pages", "POST", { title: "第二章 · 安装说明", parentId: root.id, text: "安装步骤正文。" });

  await page.goto(`${server.url}?page=${root.id}`);
  await expect(page.getByRole("textbox", { name: "Page title", exact: true })).toHaveText("公开手册首页");

  // PageActions -> BottomSheet -> Version history (45dvh peek sheet).
  await page.getByRole("button", { name: "More page actions", exact: true }).tap();
  const actionsSheet = await waitSheetReady(page, ".bottom-sheet.pop--sheet.is-shown");
  await expect(actionsSheet.getByRole("menuitem", { name: "Share", exact: true })).toBeVisible();
  await actionsSheet.getByRole("menuitem", { name: "Page history", exact: true }).tap();
  const historySheet = await waitSheetReady(page, ".bottom-sheet--peek.is-shown");
  await expect(historySheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(historySheet).toBeHidden();

  // Fullscreen AccountSettings has zero horizontal overflow.
  await page.getByRole("button", { name: "All pages", exact: true }).tap();
  await waitSheetReady(page, ".bottom-sheet.sidebar--sheet.is-shown");
  await page.getByRole("button", { name: "设置", exact: true }).tap();
  const settingsDialog = page.getByRole("dialog", { name: "账号设置", exact: true });
  await expect(settingsDialog).toBeVisible();
  const settingsBox = await settingsDialog.boundingBox();
  expect(settingsBox!.width).toBe(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await settingsDialog.getByRole("button", { name: "关闭设置", exact: true }).tap();
  await expect(settingsDialog).toBeHidden();
  await page.keyboard.press("Escape");

  // Public share multi-page bottom TOC capsule + sheet.
  const shareRes = await api(page, "/api/shares", "POST", { pageId: root.id });
  expect(shareRes.status()).toBe(201);
  const shareUrl = String((await shareRes.json()).url);

  const guest = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
    colorScheme: "light",
  });
  try {
    const reader = await guest.newPage();
    await reader.goto(`${server.url}${shareUrl}`);
    await expect(reader.locator(".public-reader__nav")).toHaveCount(0);
    const pill = reader.locator(".public-mobile-pill");
    await expect(pill).toBeVisible();
    await pill.tap();
    const tocSheet = await waitSheetReady(reader, ".bottom-sheet.is-shown");
    await saveShot(reader, "05-public-share.png");
    await tocSheet.getByRole("link", { name: "第二章 · 安装说明" }).tap();
    await expect(reader.getByRole("heading", { name: "第二章 · 安装说明", exact: true })).toBeVisible();
    await expect(tocSheet).toBeHidden();
    expect(await reader.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await guest.close();
  }
});
