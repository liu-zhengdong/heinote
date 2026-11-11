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
  return page.locator(".sidebar__topbar").getByRole("button", { name: "新建", exact: true });
}

const views = [
  { name: "Files", label: "全部页面" },
  { name: "Favorites", label: "收藏夹" },
  { name: "Shared", label: "共享空间" },
  { name: "Graph", label: "关系图谱" },
  { name: "Trash", label: "回收站" },
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
  const sidebar = page.locator(".sidebar");
  await sidebar.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => {}))));
  const topbar = sidebar.locator(".sidebar__topbar");
  const tabs = sidebar.getByRole("tablist", { name: "Page list", exact: true });
  await expect(tabs).toHaveAttribute("aria-orientation", "vertical");
  await expect(tabs.getByRole("tab")).toHaveCount(5);
  await expect(topbar.getByRole("button", { name: "Search", exact: true })).toBeVisible();
  await expect(createButton(page)).toBeVisible();
  await expect(createButton(page)).toHaveText("");
  await expect(createButton(page).locator("svg")).toHaveCount(1);
  const searchStyle = await topbar.getByRole("button", { name: "Search", exact: true }).evaluate((button) => {
    const style = getComputedStyle(button);
    return { text: button.textContent, border: style.borderTopWidth, shadow: style.boxShadow };
  });
  expect(searchStyle.text?.trim()).toBeTruthy();
  expect(searchStyle.border).toBe("0px");
  expect(searchStyle.shadow).toBe("none");
  const top = await topbar.boundingBox();
  expect(top).not.toBeNull();
  let previousBottom = top!.y + top!.height;
  let previousX: number | undefined;
  for (const view of views) {
    const tab = tabs.getByRole("tab", { name: view.name, exact: true });
    await expect(tab).toContainText(view.label);
    const box = await tab.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(previousBottom - 1);
    expect(Math.abs(box!.height - 32)).toBeLessThanOrEqual(1);
    if (previousX !== undefined) expect(Math.abs(box!.x - previousX)).toBeLessThanOrEqual(1);
    previousX = box!.x;
    previousBottom = box!.y + box!.height;
  }
  const bar = await filesToolbar(page).boundingBox();
  expect(bar).not.toBeNull();
  expect(bar!.y).toBeGreaterThanOrEqual(previousBottom - 1);
  // The resize handle extends 3px beyond the sidebar by design. Check the
  // content regions and control bounds, rather than that intentional handle.
  const sidebarBox = await sidebar.boundingBox();
  expect(sidebarBox).not.toBeNull();
  for (const region of [sidebar.locator(".sidebar__head"), topbar, tabs]) {
    expect(await region.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const bounds = await region.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(sidebarBox!.x);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(sidebarBox!.x + sidebarBox!.width);
  }
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
  const allPages = page.getByRole("button", { name: "All pages", exact: true });
  await expect(allPages).toHaveAttribute("aria-expanded", "false");
  await allPages.click();
  await expect(allPages).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("dialog", { name: "Pages", exact: true })).toBeVisible();
  await expectToolbarLayout(filesToolbar(page));
  await createButton(page).click();
  const menu = newMenu(page);
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText(["页面", "数据库", "小应用"]);
  const bounds = await menu.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const drawerShot = testInfo.outputPath("sidebar-menu-light-mobile-drawer.png");
  await page.screenshot({ path: drawerShot, animations: "disabled" });
  await testInfo.attach("Light mobile drawer and creation menu (2x)", { path: drawerShot, contentType: "image/png" });
  await page.getByRole("button", { name: "Close the page list", exact: true }).click({ position: { x: 330, y: 700 } });
  await expect(menu).toBeHidden();
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
  await expect(files).toHaveText(/全部页面\s*2$/);
  await expect(favorites).toHaveText(/收藏夹\s*0$/);
  await expect(shared).toHaveText(/共享空间\s*0$/);
  await page.getByRole("tree", { name: "Files", exact: true }).getByRole("button", { name: "Alpha reference", exact: true }).hover();
  await page.getByRole("button", { name: "Actions for Alpha reference", exact: true }).click();
  await page.getByRole("menuitem", { name: "Add to favorites", exact: true }).click();
  await expect(favorites).toHaveText(/收藏夹\s*1$/);
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

  await page.locator(".sidebar__topbar").getByRole("button", { name: "Search", exact: true }).click();
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
  await expect(files).toHaveText(/全部页面\s*2$/);
  await expect(favorites).toHaveText(/收藏夹\s*1$/);
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
  const rail = page.getByRole("navigation", { name: "Notes navigation", exact: true });
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
  await expect(createButton(page)).toBeVisible();
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
    await expect(allPages).toHaveAttribute("aria-expanded", "true");
    await expectNavigationLayout(page);
    const toolbar = filesToolbar(page);
    await expect.poll(() => effectiveOpacity(toolbar.getByRole("button", { name: "Change sort order", exact: true }))).toBe(1);
    await attachLayout(page, testInfo, "light-touch-drawer");
    await createButton(page).tap();
    await expect(newMenu(page)).toBeVisible();
    await newMenu(page).getByRole("menuitem", { name: "页面", exact: true }).tap();
    await expect(allPages).toHaveAttribute("aria-expanded", "false");
    await page.getByLabel("Page title", { exact: true }).fill("Mobile document");
    await expect.poll(async () => (await savedPages(page)).map((row) => row.title)).toEqual(["Mobile document"]);
    await page.reload();
    await expect(page.getByLabel("Page title", { exact: true })).toHaveText("Mobile document");
    await page.emulateMedia({ colorScheme: "dark" });
    await allPages.tap();
    await expect(allPages).toHaveAttribute("aria-expanded", "true");
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
  let initialSettings: Array<{ id: string; value: { roots?: string[] } }> | undefined;
  const settingsPattern = "**/api/records/personal/workspace_settings";
  await page.route(settingsPattern, async (route) => {
    if (!firstRead) { await route.continue(); return; }
    firstRead = false;
    const response = await route.fetch();
    initialSettings = await response.json();
    await settingsGate;
    await route.fulfill({ response });
  });

  try {
    // Deliver the real settings response after the page snapshot changes its scope.
    const snapshot = page.waitForResponse((response) => response.url().includes("/api/collaboration/personal/") && response.ok());
    const reloading = page.reload();
    const snapshotResponse = await snapshot;
    await snapshotResponse.finished();
    await page.evaluate(() => new Promise<void>((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))));
    releaseSettings();
    await reloading;
    await expect(page.getByLabel("Page title", { exact: true })).toHaveText("启动前页面");
    expect(initialSettings).toContainEqual({ id: "roots", value: { roots: [existing.id] } });

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
  await expect(trashTab).toContainText("1");
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
  await expect(trashTab).not.toContainText(/[1-9]/);
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
