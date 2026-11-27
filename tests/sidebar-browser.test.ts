import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";

let server: Awaited<ReturnType<typeof startServer>>;
let directory: string;
const password = "Sidebar-browser-password-2026";

test.use({ colorScheme: "light", deviceScaleFactor: 2 });

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-sidebar-browser-"));
  server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1" });
});

test.afterAll(async () => {
  await server?.close();
  if (directory) {
    const target = resolve(directory);
    expect(dirname(target)).toBe(resolve(tmpdir()));
    expect(basename(target)).toMatch(/^notes-sidebar-browser-/);
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
  const identity = page.getByRole("button", { name: "切换空间", exact: true });
  const allPages = page.getByRole("button", { name: "All pages", exact: true });
  await expect.poll(async () => await identity.isVisible() || await allPages.isVisible()).toBe(true);
  const openedDrawer = !await identity.isVisible();
  if (openedDrawer) await allPages.click();
  await expect(identity).toBeVisible();
  await expect(identity.locator(".space-switcher__user")).toHaveText(handle);
  if (openedDrawer) {
    const drawer = page.getByRole("dialog", { name: "Pages", exact: true });
    await expect.poll(() => drawer.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(allPages).toHaveAttribute("aria-expanded", "false");
  }
}

interface PageRow {
  id: string;
  value: {
    kind: "document" | "database";
    title_content: Array<{ text: string }>;
    database?: unknown;
    parent_id?: string;
  };
}

async function savedPages(page: Page) {
  // The page request context uses the registered browser's session cookie.
  const response = await page.request.get(`${server.url}/api/records/personal/pages`);
  expect(response.status()).toBe(200);
  const rows: PageRow[] = await response.json();
  return rows.map(({ id, value }) => ({
    id,
    kind: value.kind,
    title: value.title_content.map((run) => run.text).join(""),
    hasDatabase: value.database !== undefined,
    parentId: value.parent_id,
  })).sort((left, right) => left.id.localeCompare(right.id));
}

function filesToolbar(page: Page) {
  return page.getByRole("toolbar", { name: "Files", exact: true });
}

function newMenu(page: Page) {
  // Select the keyboard menu independently of its popover wrapper.
  return page.locator('.menu[role="menu"][aria-label="新建"]');
}

function createButton(page: Page) {
  return page.getByRole("button", { name: "新建", exact: true });
}

const views = [
  { name: "Files", label: "全部页面", mobileLabel: "全部" },
  { name: "Favorites", label: "收藏夹", mobileLabel: "收藏" },
  { name: "Shared", label: "已分享", mobileLabel: "已分享" },
  { name: "Graph", label: "关系图谱", mobileLabel: "图谱" },
  { name: "Trash", label: "回收站", mobileLabel: "回收站" },
] as const;

async function expectToolbarLayout(toolbar: Locator) {
  await expect(toolbar).toBeVisible();
  await expect(toolbar).toContainText("笔记");
  await expect(toolbar.getByRole("button", { name: "Change sort order", exact: true })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Collapse all", exact: true })).toBeVisible();
  await expect(toolbar.getByRole("button")).toHaveCount(2);
  const boxes = await toolbar.getByRole("button").evaluateAll((buttons) => buttons.map((button) => {
    const rect = button.getBoundingClientRect();
    return { x: rect.x, right: rect.right, y: rect.y, height: rect.height };
  }));
  const bar = await toolbar.boundingBox();
  expect(bar).not.toBeNull();
  expect(boxes[0].x).toBeGreaterThanOrEqual(bar!.x);
  expect(boxes[0].right).toBeLessThanOrEqual(boxes[1].x);
  expect(boxes[1].right).toBeLessThanOrEqual(bar!.x + bar!.width);
  expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThanOrEqual(1);
  expect(await toolbar.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
}

async function expectNavigationLayout(page: Page) {
  const mobile = (page.viewportSize()?.width ?? 1280) < 560;
  const sidebar = page.locator(".sidebar");
  await sidebar.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => {}))));
  if (mobile) {
    const topbar = sidebar.locator(".sidebar__topbar");
    const tabs = sidebar.getByRole("tablist", { name: "Page list", exact: true });
    await expect(tabs).toHaveAttribute("aria-orientation", "horizontal");
    await expect(tabs.getByRole("tab")).toHaveCount(5);
    await expect(topbar.getByRole("button", { name: "Search", exact: true })).toBeVisible();
    await expect(topbar.locator("kbd")).toHaveCount(0);
    await expect(createButton(page)).toBeVisible();
    await expect(createButton(page)).toHaveText("");
    await expect(createButton(page).locator("svg")).toHaveCount(1);
    const top = await topbar.boundingBox();
    expect(top).not.toBeNull();
    const topBottom = top!.y + top!.height;
    let previousRight: number | undefined;
    let firstY: number | undefined;
    for (const view of views) {
      const tab = tabs.getByRole("tab", { name: view.name, exact: true });
      await expect(tab).toContainText(view.mobileLabel);
      const box = await tab.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y).toBeGreaterThanOrEqual(topBottom - 1);
      expect(box!.height).toBeGreaterThanOrEqual(42);
      if (firstY !== undefined) expect(Math.abs(box!.y - firstY)).toBeLessThanOrEqual(1);
      else firstY = box!.y;
      if (previousRight !== undefined) expect(box!.x).toBeGreaterThanOrEqual(previousRight - 1);
      previousRight = box!.x + box!.width;
    }
    const tabsBox = await tabs.boundingBox();
    expect(tabsBox).not.toBeNull();
    expect(tabsBox!.height).toBeLessThanOrEqual(52);
    const bar = await filesToolbar(page).boundingBox();
    expect(bar).not.toBeNull();
    expect(bar!.y).toBeGreaterThanOrEqual(tabsBox!.y + tabsBox!.height - 1);
    const sidebarBox = await sidebar.boundingBox();
    expect(sidebarBox).not.toBeNull();
    for (const region of [sidebar.locator(".sidebar__head"), topbar]) {
      expect(await region.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    for (const region of [sidebar.locator(".sidebar__head"), topbar, tabs]) {
      const bounds = await region.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(sidebarBox!.x);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(sidebarBox!.x + sidebarBox!.width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expectToolbarLayout(filesToolbar(page));
    return;
  }

  // Desktop B3-A dual-track floating island: stationary left verb rail + docked directory pane.
  const rail = page.getByRole("navigation", { name: "HeiNote navigation", exact: true });
  await expect(rail).toBeVisible();
  const tabs = rail.getByRole("tablist", { name: "Page list", exact: true });
  await expect(tabs).toHaveAttribute("aria-orientation", "vertical");
  await expect(tabs.getByRole("tab")).toHaveCount(5);
  await expect(rail.getByRole("button", { name: "Search", exact: true })).toBeVisible();
  await expect(createButton(page)).toBeVisible();
  await expect(createButton(page)).toHaveText("");
  await expect(createButton(page).locator("svg")).toHaveCount(1);

  const railBox = await rail.boundingBox();
  const sidebarBox = await sidebar.boundingBox();
  expect(railBox).not.toBeNull();
  expect(sidebarBox).not.toBeNull();
  expect(sidebarBox!.x).toBeGreaterThanOrEqual(railBox!.x + railBox!.width - 1);

  let previousBottom = 0;
  let previousX: number | undefined;
  for (const view of views) {
    const tab = tabs.getByRole("tab", { name: view.name, exact: true });
    const box = await tab.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(previousBottom - 1);
    expect(Math.abs(box!.height - 30)).toBeLessThanOrEqual(2);
    if (previousX !== undefined) expect(Math.abs(box!.x - previousX)).toBeLessThanOrEqual(1);
    previousX = box!.x;
    previousBottom = box!.y + box!.height;
  }

  const head = sidebar.locator(".sidebar__head--pane");
  await expect(head.getByRole("button", { name: "切换空间", exact: true })).toBeVisible();
  await expect(head.getByRole("button", { name: "Collapse to rail", exact: true })).toBeVisible();
  expect(await head.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const headBox = await head.boundingBox();
  const bar = await filesToolbar(page).boundingBox();
  expect(headBox).not.toBeNull();
  expect(bar).not.toBeNull();
  expect(bar!.y).toBeGreaterThanOrEqual(headBox!.y + headBox!.height - 1);
  await expectToolbarLayout(filesToolbar(page));
}

async function attachLayout(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(700, 500);
  const sidebarPath = testInfo.outputPath(`${name}-sidebar-2x.png`);
  await page.locator(".sidebar").screenshot({ path: sidebarPath, animations: "disabled", scale: "device" });
  await testInfo.attach(`${name}: complete sidebar (2x)`, { path: sidebarPath, contentType: "image/png" });
  const pagePath = testInfo.outputPath(`${name}-page-2x.png`);
  await page.screenshot({ path: pagePath, fullPage: true, animations: "disabled", scale: "device" });
  await testInfo.attach(`${name}: full page (2x)`, { path: pagePath, contentType: "image/png" });
}

async function createDocument(page: Page, title: string) {
  await createButton(page).click();
  await newMenu(page).getByRole("menuitem", { name: "页面", exact: true }).click();
  const heading = page.getByLabel("Page title", { exact: true });
  await expect(heading).toBeEmpty();
  await heading.fill(title);
  await expect.poll(async () => (await savedPages(page)).filter((row) => row.title === title)).toHaveLength(1);
  await expect(page.getByRole("status", { name: "All changes saved", exact: true })).toHaveCount(1);
}

test("files toolbar opens one dark creation menu and dismisses without creating", async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await register(page, "sidebar_menu");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const baseline = await savedPages(page);
  const create = createButton(page);
  const menu = newMenu(page);
  await expectNavigationLayout(page);
  await expect(create).toHaveAttribute("aria-haspopup", "menu");
  await expect(create).toHaveAttribute("aria-expanded", "false");
  await attachLayout(page, testInfo, "dark-resting");

  await create.click();
  await expect(create).toHaveAttribute("aria-expanded", "true");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText(["页面", "数据库", "小应用"]);
  expect(await savedPages(page)).toEqual(baseline);
  await attachLayout(page, testInfo, "dark-creation-menu");

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(create).toHaveAttribute("aria-expanded", "false");
  await expect(create).toBeFocused();
  expect(await savedPages(page)).toEqual(baseline);

  await create.press("Enter");
  await expect(menu).toBeVisible();
  await expect(create).toHaveAttribute("aria-expanded", "true");
  await expect(menu).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(create).toBeFocused();

  await create.click();
  await expect(menu).toBeVisible();
  await create.click();
  await expect(menu).toBeHidden();
  await expect(create).toHaveAttribute("aria-expanded", "false");
  expect(await savedPages(page)).toEqual(baseline);

  await create.click();
  await expect(menu).toBeVisible();
  await expect(menu.locator("..")).toHaveClass(/\bis-shown\b/);
  await page.getByRole("main").click({ position: { x: 300, y: 300 } });
  await expect(menu).toBeHidden();
  await expect(create).toHaveAttribute("aria-expanded", "false");
  expect(await savedPages(page)).toEqual(baseline);
  await page.reload();
  expect(await savedPages(page)).toEqual(baseline);
  await expect(page.getByLabel("Page title", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Database title", { exact: true })).toHaveCount(0);
});

test("both creation choices save the correct page kind and title across reload", async ({ page }) => {
  await register(page, "sidebar_create");
  const baseline = await savedPages(page);
  const created: Array<{ id: string; kind: "document" | "database"; title: string; hasDatabase: boolean }> = [];
  const choices = [
    { item: "页面", label: "Page title", kind: "document", title: "工具栏页面" },
    { item: "数据库", label: "Database title", kind: "database", title: "工具栏数据库" },
  ] as const;

  for (const choice of choices) {
    await createButton(page).click();
    if (choice.kind === "database") {
      await newMenu(page).press("ArrowDown");
      await newMenu(page).press("Enter");
    } else {
      await newMenu(page).getByRole("menuitem", { name: choice.item, exact: true }).click();
    }
    await expect(newMenu(page)).toBeHidden();
    const title = page.getByLabel(choice.label, { exact: true });
    await expect(title).toBeVisible();
    await title.fill(choice.title);
    await expect.poll(async () => (await savedPages(page)).filter((row) => row.title === choice.title)).toEqual([
      expect.objectContaining({ kind: choice.kind, title: choice.title, hasDatabase: choice.kind === "database" }),
    ]);
    const saved = (await savedPages(page)).find((row) => row.title === choice.title)!;
    created.push(saved);
    expect(await savedPages(page)).toHaveLength(baseline.length + created.length);
    await page.reload();
    await expect(page.getByLabel(choice.label, { exact: true })).toHaveText(choice.title);
    expect(await savedPages(page)).toEqual([...baseline, ...created].sort((left, right) => left.id.localeCompare(right.id)));
  }
});

test("toolbar fits a 168px sidebar and a 390px light mobile drawer", async ({ page }, testInfo) => {
  await register(page, "sidebar_narrow");
  const sidebar = page.getByRole("complementary", { name: "Pages", exact: true });
  const separator = page.getByRole("separator", { name: "Resize the page list", exact: true });
  const seam = await separator.boundingBox();
  expect(seam).not.toBeNull();
  await page.mouse.move(seam!.x + seam!.width / 2, 300);
  await page.mouse.down();
  await page.mouse.move(120, 300, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(168);
  await expectNavigationLayout(page);
  await attachLayout(page, testInfo, "light-168px-resting");
  await createButton(page).click();
  await expect(newMenu(page)).toBeVisible();
  await attachLayout(page, testInfo, "light-168px-menu");
  await page.keyboard.press("Escape");
  await expect(newMenu(page)).toBeHidden();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".rail")).toHaveCount(0);
  const allPages = page.getByRole("button", { name: "All pages", exact: true });
  await expect(allPages).toHaveAttribute("aria-expanded", "false");
  await allPages.click();
  await expect(page.getByRole("dialog", { name: "Pages", exact: true })).toBeVisible();
  await expectToolbarLayout(filesToolbar(page));
  await createButton(page).click();
  const menu = newMenu(page);
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText(["页面", "数据库", "小应用"]);
  const sheet = page.locator(".bottom-sheet.pop--sheet.is-shown");
  await expect(sheet).toBeVisible();
  await sheet.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => {}))));
  const bounds = await menu.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const drawerShot = testInfo.outputPath("sidebar-menu-light-mobile-drawer.png");
  await page.screenshot({ path: drawerShot, animations: "disabled" });
  await testInfo.attach("Light mobile drawer and creation menu (2x)", { path: drawerShot, contentType: "image/png" });
  await page.getByRole("button", { name: "关闭 新建 浮层", exact: true }).click({ position: { x: 195, y: 40 } });
  await expect(menu).toBeHidden();
  await page.getByRole("button", { name: "Close the page list", exact: true }).click({ position: { x: 195, y: 40 } });
  await expect(allPages).toHaveAttribute("aria-expanded", "false");
  expect(await savedPages(page)).toEqual([]);
});

test("vertical navigation keeps live counts, keyboard selection, and search", async ({ page }, testInfo) => {
  await register(page, "sidebar_navigation");
  await createDocument(page, "Alpha reference");
  await createDocument(page, "Beta reference");
  const tabs = page.getByRole("tablist", { name: "Page list", exact: true });
  const files = tabs.getByRole("tab", { name: "Files", exact: true });
  const favorites = tabs.getByRole("tab", { name: "Favorites", exact: true });
  const shared = tabs.getByRole("tab", { name: "Shared", exact: true });
  await expect(files).toHaveAttribute("data-count", "2");
  await expect(favorites).toHaveAttribute("data-count", "0");
  await expect(shared).toHaveAttribute("data-count", "0");
  await expect(filesToolbar(page).locator(".sidebar__section-count")).toHaveText("2");
  await page.getByRole("tree", { name: "Files", exact: true }).getByRole("button", { name: "Alpha reference", exact: true }).hover();
  await page.getByRole("button", { name: "Actions for Alpha reference", exact: true }).click();
  await page.getByRole("menuitem", { name: "Add to favorites", exact: true }).click();
  await expect(favorites).toHaveAttribute("data-count", "1");
  await expectNavigationLayout(page);
  const rowHeights = await page.locator(".sidebar .tree-row").evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
  expect(rowHeights).toHaveLength(2);
  for (const height of rowHeights) expect(Math.abs(height - 31)).toBeLessThanOrEqual(1);

  await files.focus();
  await files.press("ArrowDown");
  await expect(favorites).toBeFocused();
  await expect(favorites).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tree", { name: "Favorites", exact: true }).locator(".tree-row__label")).toHaveText(["Alpha reference"]);
  await favorites.press("End");
  const trash = tabs.getByRole("tab", { name: "Trash", exact: true });
  await expect(trash).toBeFocused();
  await expect(trash).toHaveAttribute("aria-selected", "true");
  await trash.press("ArrowUp");
  const graph = tabs.getByRole("tab", { name: "Graph", exact: true });
  await expect(graph).toBeFocused();
  await expect(graph).toHaveAttribute("aria-selected", "true");
  await graph.press("ArrowUp");
  await expect(shared).toBeFocused();
  await expect(shared).toHaveAttribute("aria-selected", "true");
  await shared.press("Home");
  await expect(files).toBeFocused();
  await expect(files).toHaveAttribute("aria-selected", "true");
  await expect(tabs.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);

  await page.getByRole("navigation", { name: "HeiNote navigation", exact: true }).getByRole("button", { name: "Search", exact: true }).click();
  const search = page.getByRole("dialog", { name: "Search pages", exact: true });
  const input = search.getByRole("textbox", { name: "Search pages", exact: true });
  await expect(input).toBeFocused();
  await input.fill("Alpha reference");
  await expect(search.getByRole("listbox", { name: "Results", exact: true }).getByRole("option")).toHaveText(["Alpha reference"]);
  await input.press("Enter");
  await expect(search).toBeHidden();
  await expect(page.getByLabel("Page title", { exact: true })).toHaveText("Alpha reference");
  await expect(page.getByRole("tree", { name: "Files", exact: true }).getByRole("button", { name: "Alpha reference", exact: true })).toHaveAttribute("aria-current", "page");
  await attachLayout(page, testInfo, "light-populated");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await attachLayout(page, testInfo, "dark-populated");
  await page.reload();
  await expect(files).toHaveAttribute("data-count", "2");
  await expect(favorites).toHaveAttribute("data-count", "1");
});

test("topbar creation works from every view and from the desktop rail", async ({ page }) => {
  await register(page, "sidebar_views");
  for (const [index, view] of views.entries()) {
    const tab = page.getByRole("tab", { name: view.name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(createButton(page)).toBeVisible();
    const baseline = await savedPages(page);
    await createButton(page).click();
    await expect(newMenu(page)).toBeVisible();
    await newMenu(page).press("Escape");
    await expect(newMenu(page)).toBeHidden();
    await expect(createButton(page)).toBeFocused();
    expect(await savedPages(page)).toEqual(baseline);
    await createDocument(page, `View ${index + 1} document`);
    await expect(page.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tree", { name: "Files", exact: true }).getByRole("button", { name: `View ${index + 1} document`, exact: true })).toHaveAttribute("aria-current", "page");
    expect(await savedPages(page)).toHaveLength(baseline.length + 1);
  }
  await page.getByRole("button", { name: "Collapse to rail", exact: true }).click();
  const rail = page.getByRole("navigation", { name: "HeiNote navigation", exact: true });
  await expect(rail).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Pages", exact: true })).toHaveCount(0);
  const baseline = await savedPages(page);
  const create = rail.getByRole("button", { name: "新建", exact: true });
  await create.press("Enter");
  await expect(newMenu(page)).toBeFocused();
  await newMenu(page).press("Escape");
  await expect(create).toBeFocused();
  expect(await savedPages(page)).toEqual(baseline);
  await create.click();
  await newMenu(page).getByRole("menuitem", { name: "页面", exact: true }).click();
  await page.getByLabel("Page title", { exact: true }).fill("Rail document");
  await expect.poll(async () => (await savedPages(page)).filter((row) => row.title === "Rail document")).toHaveLength(1);
  await page.reload();
  await expect(rail).toBeVisible();
  await expect(page.getByLabel("Page title", { exact: true })).toHaveText("Rail document");
  await rail.getByRole("button", { name: "All pages", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Pages", exact: true })).toBeVisible();
  await expect(createButton(page)).toBeVisible();

  // Collapsing again and clicking a rail view tab directly expands the docked pane to that view.
  await page.getByRole("button", { name: "Collapse to rail", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Pages", exact: true })).toHaveCount(0);
  await rail.getByRole("tab", { name: "Favorites", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Pages", exact: true })).toBeVisible();
  await expect(rail.getByRole("tab", { name: "Favorites", exact: true })).toHaveAttribute("aria-selected", "true");
});

async function effectiveOpacity(locator: Locator) {
  return locator.evaluate((element) => {
    let opacity = 1;
    for (let current: Element | null = element; current; current = current.parentElement) {
      opacity *= Number(getComputedStyle(current).opacity);
    }
    return opacity;
  });
}

test("tree tools reveal on hover, focus, and open menu; sorting and collapse change the tree", async ({ page }) => {
  await register(page, "sidebar_tree_tools");
  await createDocument(page, "Zulu parent");
  await createDocument(page, "Alpha sibling");
  await page.getByRole("tree", { name: "Files", exact: true }).getByRole("button", { name: "Zulu parent", exact: true }).hover();
  await page.getByRole("button", { name: "New page inside Zulu parent", exact: true }).click();
  await expect(page.getByLabel("Page title", { exact: true })).toBeEmpty();
  await page.getByLabel("Page title", { exact: true }).fill("Nested child");
  await expect.poll(async () => (await savedPages(page)).filter((row) => row.title === "Nested child")).toHaveLength(1);
  const tree = page.getByRole("tree", { name: "Files", exact: true });
  await expect(tree.getByRole("button", { name: "Nested child", exact: true })).toBeVisible();
  const toolbar = filesToolbar(page);
  const sort = toolbar.getByRole("button", { name: "Change sort order", exact: true });
  await page.getByRole("main").click({ position: { x: 50, y: 100 } });
  await page.mouse.move(900, 500);
  await expect.poll(() => effectiveOpacity(sort)).toBeLessThan(0.6);
  expect(await effectiveOpacity(sort)).toBeGreaterThan(0);
  await toolbar.hover();
  await expect.poll(() => effectiveOpacity(sort)).toBe(1);
  await sort.focus();
  await page.mouse.move(900, 500);
  await expect.poll(() => effectiveOpacity(sort)).toBe(1);
  await sort.press("Enter");
  const menu = page.locator('.menu[role="menu"][aria-label="Sort"]');
  await expect(menu).toBeFocused();
  await expect.poll(() => effectiveOpacity(sort)).toBe(1);
  await menu.getByRole("menuitem", { name: "File name (Z to A)", exact: true }).click();
  await expect(menu).toBeHidden();
  const rootLabels = tree.locator(":scope > .tree-branch > .tree-row .tree-row__label");
  await expect(rootLabels).toHaveText(["Zulu parent", "Alpha sibling"]);
  await page.reload();
  await expect(rootLabels).toHaveText(["Zulu parent", "Alpha sibling"]);
  await sort.click();
  await menu.getByRole("menuitem", { name: "File name (A to Z)", exact: true }).click();
  await expect(rootLabels).toHaveText(["Alpha sibling", "Zulu parent"]);
  await toolbar.getByRole("button", { name: "Collapse all", exact: true }).click();
  await expect(tree.getByRole("button", { name: "Nested child", exact: true })).toHaveCount(0);
  await expect(tree.getByRole("button", { name: "Expand Zulu parent", exact: true })).toHaveAttribute("aria-expanded", "false");
  await tree.getByRole("button", { name: "Expand Zulu parent", exact: true }).click();
  await expect(tree.getByRole("button", { name: "Nested child", exact: true })).toBeVisible();
  expect((await savedPages(page)).map((row) => row.title).sort()).toEqual(["Alpha sibling", "Nested child", "Zulu parent"]);
});

test("touch drawer keeps tools visible and saves a new page", async ({ browser }, testInfo) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "light" });
  const page = await context.newPage();
  try {
    await register(page, "sidebar_touch");
    const allPages = page.getByRole("button", { name: "All pages", exact: true });
    await allPages.tap();
    await expect(page.getByRole("dialog", { name: "Pages", exact: true })).toBeVisible();
    await expectNavigationLayout(page);
    const toolbar = filesToolbar(page);
    await expect.poll(() => effectiveOpacity(toolbar.getByRole("button", { name: "Change sort order", exact: true }))).toBe(1);
    await attachLayout(page, testInfo, "light-touch-drawer");
    await createButton(page).tap();
    await expect(newMenu(page)).toBeVisible();
    await newMenu(page).getByRole("menuitem", { name: "页面", exact: true }).tap();
    await expect(page.getByRole("dialog", { name: "Pages", exact: true })).toBeHidden();
    await page.getByLabel("Page title", { exact: true }).fill("Mobile document");
    await expect.poll(async () => (await savedPages(page)).map((row) => row.title)).toEqual(["Mobile document"]);
    await page.reload();
    await expect(page.getByLabel("Page title", { exact: true })).toHaveText("Mobile document");
    await page.emulateMedia({ colorScheme: "dark" });
    await allPages.tap();
    await expect(page.getByRole("dialog", { name: "Pages", exact: true })).toBeVisible();
    await attachLayout(page, testInfo, "dark-touch-drawer");
  } finally {
    await context.close();
  }
});

test("a collaborative startup snapshot preserves the initial workspace settings read", async ({ page }) => {
  await register(page, "sidebar_startup");
  await createButton(page).click();
  await newMenu(page).getByRole("menuitem", { name: "页面", exact: true }).click();
  await page.getByLabel("Page title", { exact: true }).fill("启动前页面");
  await expect.poll(async () => (await savedPages(page)).map((row) => row.title)).toEqual(["启动前页面"]);
  await expect(page.getByRole("status", { name: "All changes saved", exact: true })).toHaveCount(1);
  const [existing] = await savedPages(page);

  let releaseSettings = () => {};
  const settingsGate = new Promise<void>((resolveGate) => { releaseSettings = resolveGate; });
  let firstRead = true;
  let initialSettings: { latest: number; rows: Array<{ id: string; value: { roots?: string[] } }>; deleted: string[] } | undefined;
  const settingsPattern = (url: URL) => url.pathname === "/api/records/personal/workspace_settings" && url.searchParams.get("after") === "0";
  await page.route(settingsPattern, async (route) => {
    if (route.request().method() !== "GET" || !firstRead) { await route.continue(); return; }
    firstRead = false;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    initialSettings = await response.json();
    await settingsGate;
    await route.fulfill({ response });
  });

  try {
    // Startup waits for every collection's first read, so holding the
    // settings response also holds selection — no selectPage, no snapshot
    // fetch. Ask for the snapshot ourselves while the read is still held:
    // that is the overlap this test exists to cover.
    const snapshot = page.waitForResponse((response) => response.url().includes("/api/collaboration/personal/") && response.ok());
    const reloading = page.reload();
    await expect.poll(() => initialSettings !== undefined, { timeout: 10000 }).toBe(true);
    await page.evaluate((pageId) => fetch(`/api/collaboration/personal/${encodeURIComponent(pageId)}`).then((r) => r.text()), existing.id);
    const snapshotResponse = await snapshot;
    await snapshotResponse.finished();
    releaseSettings();
    await reloading;
    await expect(page.getByLabel("Page title", { exact: true })).toHaveText("启动前页面");
    expect(initialSettings?.rows).toContainEqual({ id: "roots", value: { roots: [existing.id] } });

    const creation = page.waitForResponse((response) => {
      if (!response.url().endsWith("/api/records/batch")) return false;
      const body = response.request().postDataJSON() as { writes: Array<{ value?: { kind?: string } }> };
      return body.writes.some((write) => write.value?.kind === "database");
    });
    await createButton(page).click();
    await newMenu(page).getByRole("menuitem", { name: "数据库", exact: true }).click();
    const response = await creation;
    expect(response.status(), JSON.stringify(await response.json())).toBe(200);
    await expect(page.getByLabel("Database title", { exact: true })).toBeVisible();
    await expect.poll(async () => (await savedPages(page)).map((row) => row.kind).sort()).toEqual(["database", "document"]);
    const settings = await page.request.get(`${server.url}/api/records/personal/workspace_settings`);
    expect(settings.status()).toBe(200);
    const rows: Array<{ id: string; value: { roots?: string[] } }> = await settings.json();
    expect(rows.find((row) => row.id === "roots")?.value.roots).toEqual(expect.arrayContaining([existing.id]));
    expect(rows.find((row) => row.id === "roots")?.value.roots).toHaveLength(2);
  } finally {
    releaseSettings();
    await page.unroute(settingsPattern);
  }
});

test("trash tab lists archived pages and asks before deleting permanently", async ({ page }, testInfo) => {
  await register(page, "sidebar_trash");
  await createDocument(page, "Disposable note");
  await createDocument(page, "Keep forever");
  const trashTab = page.getByRole("tab", { name: "Trash", exact: true });
  const files = page.getByRole("tree", { name: "Files", exact: true });

  await files.getByRole("button", { name: "Disposable note", exact: true }).hover();
  await page.getByRole("button", { name: "Actions for Disposable note", exact: true }).click();
  await page.getByRole("menuitem", { name: "Move to trash", exact: true }).click();
  await expect(trashTab).toHaveAttribute("data-count", "1");
  await expect(files.getByRole("button", { name: "Disposable note", exact: true })).toHaveCount(0);

  await trashTab.click();
  const list = page.getByRole("listbox", { name: "Pages in the trash", exact: true });
  await expect(list.getByRole("option")).toHaveCount(1);
  await expect(list.getByRole("option", { name: /Disposable note/ })).toBeVisible();

  // Opening a trashed page keeps it read-only under the banner.
  await list.getByRole("option", { name: /Disposable note/ }).click();
  await expect(page.getByText("In the trash", { exact: true })).toBeVisible();
  await attachLayout(page, testInfo, "trash-tab");

  // Restore returns the page to the tree and empties the tab count.
  await list.getByRole("option", { name: /Disposable note/ }).hover();
  await list.getByRole("button", { name: "Restore Disposable note", exact: true }).click();
  await expect(list).toHaveText(/Trash is empty/);
  await expect(trashTab).toHaveAttribute("data-count", "0");
  await expect.poll(async () => (await savedPages(page)).map((row) => row.title).sort()).toEqual(["Disposable note", "Keep forever"]);

  // Delete permanently asks first; canceling changes nothing, confirming removes it.
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await files.getByRole("button", { name: "Disposable note", exact: true }).hover();
  await page.getByRole("button", { name: "Actions for Disposable note", exact: true }).click();
  await page.getByRole("menuitem", { name: "Move to trash", exact: true }).click();
  await trashTab.click();
  await list.getByRole("option", { name: /Disposable note/ }).hover();
  await list.getByRole("button", { name: "Delete Disposable note permanently", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Delete permanently", exact: true });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(list.getByRole("option", { name: /Disposable note/ })).toBeVisible();

  await list.getByRole("option", { name: /Disposable note/ }).hover();
  await list.getByRole("button", { name: "Delete Disposable note permanently", exact: true }).click();
  await confirm.getByRole("button", { name: "Delete permanently", exact: true }).click();
  await expect(list).toHaveText(/Trash is empty/);
  await expect.poll(async () => (await savedPages(page)).map((row) => row.title)).toEqual(["Keep forever"]);
});

test("the trash banner asks before deleting permanently too", async ({ page }) => {
  await register(page, "sidebar_trash_banner");
  await createDocument(page, "Banner victim");
  const files = page.getByRole("tree", { name: "Files", exact: true });
  await files.getByRole("button", { name: "Banner victim", exact: true }).hover();
  await page.getByRole("button", { name: "Actions for Banner victim", exact: true }).click();
  await page.getByRole("menuitem", { name: "Move to trash", exact: true }).click();
  await page.getByRole("tab", { name: "Trash", exact: true }).click();
  await page.getByRole("listbox", { name: "Pages in the trash", exact: true }).getByRole("option", { name: /Banner victim/ }).click();
  await expect(page.getByText("In the trash", { exact: true })).toBeVisible();

  await page.locator(".trash-banner").getByRole("button", { name: "Delete permanently", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Delete permanently", exact: true });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByText("In the trash", { exact: true })).toBeVisible();

  await page.locator(".trash-banner").getByRole("button", { name: "Delete permanently", exact: true }).click();
  await confirm.getByRole("button", { name: "Delete permanently", exact: true }).click();
  await expect(page.getByText("In the trash", { exact: true })).toBeHidden();
  await expect.poll(async () => (await savedPages(page)).map((row) => row.title)).toEqual([]);
});

test("UC-57: multi-level trashed subpages are excluded from page count and purged cleanly", async ({ page }) => {
  await register(page, "sidebar_nested_trash");
  await createDocument(page, "Keep active");
  await createDocument(page, "Parent folder");

  const filesTab = page.getByRole("tab", { name: "Files", exact: true });
  const trashTab = page.getByRole("tab", { name: "Trash", exact: true });
  const files = page.getByRole("tree", { name: "Files", exact: true });

  // Build 3 nested descendant levels under Parent folder.
  await files.locator(".tree-row", { hasText: "Parent folder" }).hover();
  await page.getByRole("button", { name: "New page inside Parent folder", exact: true }).click();
  await page.getByLabel("Page title", { exact: true }).fill("Child A");

  await files.locator(".tree-row", { hasText: "Child A" }).hover();
  await page.getByRole("button", { name: "New page inside Child A", exact: true }).click();
  await page.getByLabel("Page title", { exact: true }).fill("Grandchild B");

  await files.locator(".tree-row", { hasText: "Grandchild B" }).hover();
  await page.getByRole("button", { name: "New page inside Grandchild B", exact: true }).click();
  await page.getByLabel("Page title", { exact: true }).fill("Great-grandchild C");

  await expect(filesTab).toHaveAttribute("data-count", "5");

  // Move Parent folder to trash: All pages drops immediately to 1 (no ghost descendants).
  await files.locator(".tree-row", { hasText: "Parent folder" }).hover();
  await page.getByRole("button", { name: "Actions for Parent folder", exact: true }).click();
  await page.getByRole("menuitem", { name: "Move to trash", exact: true }).click();

  await expect(filesTab).toHaveAttribute("data-count", "1");
  await expect(trashTab).toHaveAttribute("data-count", "1");
  await expect(files.locator(".tree-row")).toHaveCount(1);

  // Trash row shows descendant count; Delete permanently confirm shows total pages.
  await trashTab.click();
  const list = page.getByRole("listbox", { name: "Pages in the trash", exact: true });
  const parentOption = list.getByRole("option", { name: /Parent folder/ });
  await expect(parentOption).toContainText("含 3 个子页面");
  await parentOption.hover();
  await list.getByRole("button", { name: "Delete Parent folder permanently", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Delete permanently", exact: true });
  await expect(confirm).toContainText("「Parent folder」及底下 3 个子页面（共 4 个页面）将被永久删除");
  await confirm.getByRole("button", { name: "Delete permanently", exact: true }).click();

  await expect(list).toHaveText(/Trash is empty/);
  await expect(trashTab).toHaveAttribute("data-count", "0");

  // Reload and verify only Keep active survives.
  await page.reload();
  await expect(filesTab).toHaveAttribute("data-count", "1");
  await expect.poll(async () => (await savedPages(page)).map((row) => row.title)).toEqual(["Keep active"]);

  // Also verify Empty trash dialog displays total count including descendants.
  await createDocument(page, "Empty root");
  await files.locator(".tree-row", { hasText: "Empty root" }).hover();
  await page.getByRole("button", { name: "New page inside Empty root", exact: true }).click();
  await page.getByLabel("Page title", { exact: true }).fill("Empty child");
  await files.locator(".tree-row", { hasText: "Empty root" }).hover();
  await page.getByRole("button", { name: "Actions for Empty root", exact: true }).click();
  await page.getByRole("menuitem", { name: "Move to trash", exact: true }).click();
  await expect(filesTab).toHaveAttribute("data-count", "1");

  await trashTab.click();
  await page.getByRole("button", { name: "Empty trash", exact: true }).click();
  const emptyConfirm = page.getByRole("dialog", { name: "Empty the trash", exact: true });
  await expect(emptyConfirm).toContainText("回收站中的 1 个页面及底下 1 个子页面（共 2 个页面）将被永久删除");
  await emptyConfirm.getByRole("button", { name: "Empty trash", exact: true }).click();
  await expect(list).toHaveText(/Trash is empty/);
  await expect.poll(async () => (await savedPages(page)).map((row) => row.title)).toEqual(["Keep active"]);
});

test("the shared view lists public links and shares pages at once", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await register(page, "sidebar_shared");
  await createDocument(page, "Published notes");
  await page.getByRole("button", { name: "Share", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: /^Share / });
  await expect(dialog.locator(".share__status")).toHaveText("私有");
  await dialog.getByRole("button", { name: "创建链接", exact: true }).click();
  await expect(dialog.locator(".public-links__url")).toHaveCount(1);
  await expect(dialog.locator(".share__status")).toHaveText("公开链接已开启");
  await dialog.getByRole("button", { name: "Close sharing", exact: true }).click();

  const sharedTab = page.getByRole("tab", { name: "Shared", exact: true });
  await sharedTab.click();
  const tree = page.getByRole("tree", { name: "Shared", exact: true });
  await expect(tree.getByRole("heading", { name: "公开链接", exact: true })).toBeVisible();
  await expect(tree.getByRole("button", { name: "Published notes", exact: true })).toHaveCount(1);
  await expect(sharedTab).toHaveAttribute("data-count", "1");

  // "新建共享页面" makes the page a shared root at once — the page must not
  // stay private until somebody is invited.
  await tree.getByRole("button", { name: "新建共享页面", exact: true }).first().click();
  const created = page.getByRole("dialog", { name: /^Share / });
  await expect(created.locator(".share__status")).toContainText("已共享");
  await created.getByRole("button", { name: "Close sharing", exact: true }).click();
  await expect(tree.getByRole("heading", { name: "我共享的" })).toBeVisible();
  await expect.poll(async () => JSON.stringify(await (await page.request.get(`${server.url}/api/records/personal/pages`)).json())).toContain("share_space_id");
  await expect(sharedTab).toHaveAttribute("data-count", "2");
  expect(errors).toEqual([]);
});

test("copy to… lands a copy under the chosen page and at the top level", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await register(page, "sidebar_copy_to");
  await createDocument(page, "Source notes");
  await createDocument(page, "Target folder");
  const tree = page.getByRole("tree", { name: "Files", exact: true });

  // A copy under another page, from the row menu's picker.
  await tree.getByRole("button", { name: "Source notes", exact: true }).first().hover();
  await tree.getByRole("button", { name: "Actions for Source notes", exact: true }).click();
  const rowMenu = page.locator('.menu[role="menu"][aria-label="Page actions"]');
  await expect(rowMenu.getByRole("menuitem", { name: "拷贝到…", exact: true })).toBeVisible();
  await rowMenu.getByRole("menuitem", { name: "拷贝到…", exact: true }).click();
  await expect(rowMenu).toBeHidden();
  const picker = page.getByRole("dialog", { name: "拷贝到…", exact: true });
  await expect(picker).toBeVisible();
  await picker.locator("input").fill("Target");
  await picker.getByRole("option", { name: "Target folder" }).click();
  await expect.poll(async () => {
    const rows = await savedPages(page);
    const copies = rows.filter((row) => row.title === "Source notes");
    const target = rows.find((row) => row.title === "Target folder");
    return JSON.stringify({ copies: copies.length, nested: copies.filter((row) => row.parentId === target?.id).length });
  }).toContain('"copies":2,"nested":1');
  // Selecting the newly copied child page turns Target folder into a branch and expands it.
  await expect(tree.getByRole("button", { name: "Collapse Target folder", exact: true })).toBeVisible();

  // A copy at the top level through the picker's "Top level".
  await tree.getByRole("button", { name: "Target folder", exact: true }).first().hover();
  await tree.getByRole("button", { name: "Actions for Target folder", exact: true }).first().click();
  await rowMenu.getByRole("menuitem", { name: "拷贝到…", exact: true }).click();
  await picker.getByRole("option", { name: "Top level" }).click();
  await expect.poll(async () => {
    const rows = await savedPages(page);
    return rows.filter((row) => row.title === "Target folder" && !row.parentId).length;
  }).toBe(2);
  expect(errors).toEqual([]);
});

test("collaborator cannot drag or move a personal page into someone else's shared page", async ({ browser }) => {
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();
  const errors: string[] = [];
  alice.on("pageerror", (error) => errors.push(error.message));
  bob.on("pageerror", (error) => errors.push(error.message));

  try {
    await register(alice, "share_owner_drag");
    await register(bob, "share_editor_drag");

    // Alice creates and shares a page with Bob as editor ("Can edit").
    await createDocument(alice, "Alice shared page");
    const alicePages = await savedPages(alice);
    const sharedRoot = alicePages.find((row) => row.title === "Alice shared page")!;
    const createdSpace = await (await alice.request.post(`${server.url}/api/spaces`, { data: { name: "Alice Shared" } })).json();
    const spaceId = createdSpace.spaceId as string;
    expect((await alice.request.post(`${server.url}/api/pages/${sharedRoot.id}/transfer`, { data: { action: "share", spaceId } })).status()).toBe(200);
    expect((await alice.request.post(`${server.url}/api/spaces/${spaceId}/invitations`, { data: { handle: "share_editor_drag", role: "editor" } })).status()).toBe(200);
    const invitations = await (await bob.request.get(`${server.url}/api/invitations`)).json();
    expect((await bob.request.post(`${server.url}/api/invitations/${invitations[0].id}`, { data: { accept: true } })).status()).toBe(200);

    // Bob reloads to see Alice's shared page alongside his own personal note.
    await bob.reload();
    await createDocument(bob, "Bob personal note");
    const bobTree = bob.getByRole("tree", { name: "Files", exact: true });
    const bobNoteBtn = bobTree.getByRole("button", { name: "Bob personal note", exact: true }).first();
    const aliceSharedBtn = bobTree.getByRole("button", { name: "Alice shared page", exact: true }).first();
    await expect(bobNoteBtn).toBeVisible();
    await expect(aliceSharedBtn).toBeVisible();

    // Dragging Bob's personal note onto Alice's shared page is blocked with a clear toast.
    const bobPersonalBefore = await savedPages(bob);
    const bobNote = bobPersonalBefore.find((row) => row.title === "Bob personal note")!;
    const transfer = await bob.evaluateHandle((pageId) => {
      const dt = new DataTransfer();
      dt.setData("text/x-notes-page", pageId);
      return dt;
    }, bobNote.id);
    const bobRow = bobNoteBtn.locator("xpath=ancestor::div[contains(@class,'tree-row')]").first();
    const aliceRow = aliceSharedBtn.locator("xpath=ancestor::div[contains(@class,'tree-row')]").first();
    await bobRow.dispatchEvent("dragstart", { dataTransfer: transfer });
    await aliceRow.dispatchEvent("dragover", { dataTransfer: transfer });
    await aliceRow.dispatchEvent("drop", { dataTransfer: transfer });
    await bobRow.dispatchEvent("dragend", { dataTransfer: transfer });

    await expect(bob.getByText("不能将页面移入他人共享的空间，请使用「拷贝到…」")).toBeVisible();

    // Bob's personal note stays in his personal space and never enters Alice's space.
    const bobPersonalAfter = await savedPages(bob);
    expect(bobPersonalAfter.some((row) => row.id === bobNote.id && !row.parentId)).toBe(true);
    const spaceRows = await (await bob.request.get(`${server.url}/api/records/${spaceId}/pages`)).json();
    expect(spaceRows.some((row: { id: string }) => row.id === bobNote.id)).toBe(false);

    // "Move to" on Bob's personal note also omits Alice's shared page.
    await bobNoteBtn.click();
    await bob.getByRole("button", { name: "More page actions", exact: true }).click();
    await bob.getByRole("menuitem", { name: /^Move to(?! trash)/ }).click();
    const moveDialog = bob.getByRole("dialog", { name: "Move to", exact: true });
    await expect(moveDialog).toBeVisible();
    await expect(moveDialog.getByRole("option", { name: /Alice shared page/ })).toHaveCount(0);
    await bob.keyboard.press("Escape");

    // "拷贝到…" on Bob's personal note CAN copy into Alice's shared page while keeping Bob's original.
    await bob.getByRole("button", { name: "More page actions", exact: true }).click();
    await bob.getByRole("menuitem", { name: "拷贝到…", exact: true }).click();
    const copyDialog = bob.getByRole("dialog", { name: "拷贝到…", exact: true });
    await expect(copyDialog).toBeVisible();
    await copyDialog.getByRole("option", { name: /Alice shared page/ }).click();
    await expect(bob.getByText("已拷贝", { exact: true })).toBeVisible();
    await expect.poll(async () => {
      const spaceAfter = await (await bob.request.get(`${server.url}/api/records/${spaceId}/pages`)).json();
      return spaceAfter.some((row: { id: string; value: { parent_id?: string; title_content?: Array<{ text: string }> } }) =>
        row.id !== bobNote.id
        && row.value.parent_id === sharedRoot.id
        && row.value.title_content?.map((run) => run.text).join("") === "Bob personal note");
    }).toBe(true);
    expect((await savedPages(bob)).some((row) => row.id === bobNote.id && !row.parentId)).toBe(true);

    expect(errors).toEqual([]);
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});
