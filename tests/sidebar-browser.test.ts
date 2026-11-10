import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  await expect(page.getByRole("button", { name: "切换空间", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "切换空间", exact: true }).locator(".space-switcher__user")).toHaveText(handle);
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

async function expectToolbarLayout(toolbar: Locator) {
  const create = toolbar.getByRole("button", { name: "新建", exact: true });
  const sort = toolbar.getByRole("button", { name: "Change sort order", exact: true });
  const collapse = toolbar.getByRole("button", { name: "Collapse all", exact: true });
  await expect(create).toBeVisible();
  await expect(sort).toBeVisible();
  await expect(collapse).toBeVisible();
  await expect(toolbar.getByRole("button")).toHaveCount(3);
  const [bar, left, middle, right, padding, views] = await Promise.all([
    toolbar.boundingBox(), create.boundingBox(), sort.boundingBox(), collapse.boundingBox(),
    toolbar.evaluate((element) => {
      const style = getComputedStyle(element);
      return { left: Number.parseFloat(style.paddingLeft), right: Number.parseFloat(style.paddingRight) };
    }),
    toolbar.evaluate((element) => {
      const views = element.closest(".sidebar")!.querySelector(".sidebar__views")!;
      const button = element.querySelector(".sidebar__new")!;
      const box = views.getBoundingClientRect();
      return { x: box.x, width: box.width, height: box.height, background: getComputedStyle(views).backgroundColor, buttonBackground: getComputedStyle(button).backgroundColor };
    }),
  ]);
  expect(bar).not.toBeNull();
  expect(left).not.toBeNull();
  expect(middle).not.toBeNull();
  expect(right).not.toBeNull();
  expect(Math.abs(left!.x - bar!.x - padding.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(left!.x - views.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(left!.width - views.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(left!.height - views.height)).toBeLessThanOrEqual(1);
  expect(views.buttonBackground).toBe(views.background);
  expect(middle!.x - left!.x - left!.width).toBeGreaterThanOrEqual(0);
  expect(middle!.x + middle!.width).toBeLessThanOrEqual(right!.x);
  expect(right!.x - middle!.x - middle!.width).toBeLessThanOrEqual(8);
  expect(Math.abs(bar!.x + bar!.width - padding.right - right!.x - right!.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(left!.y + left!.height / 2 - right!.y - right!.height / 2)).toBeLessThanOrEqual(1);
  expect(await toolbar.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
}

test("files toolbar opens one dark creation menu and dismisses without creating", async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await register(page, "sidebar_menu");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const baseline = await savedPages(page);
  const toolbar = filesToolbar(page);
  const create = toolbar.getByRole("button", { name: "新建", exact: true });
  const menu = newMenu(page);
  await expectToolbarLayout(toolbar);
  await expect(create).toHaveText("新建");
  await expect(create.locator("svg")).toHaveCount(1);
  await expect(create).toHaveAttribute("aria-haspopup", "menu");
  await expect(create).toHaveAttribute("aria-expanded", "false");
  await page.evaluate(() => document.fonts.ready);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".sidebar__new span" });
  const platformFonts = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  const typography = await create.evaluate((element) => {
    const style = getComputedStyle(element);
    return { fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight };
  });
  const fontsPath = testInfo.outputPath("sidebar-toolbar-fonts.json");
  await writeFile(fontsPath, JSON.stringify({ ...platformFonts, typography }, null, 2));
  await testInfo.attach("Toolbar actual fonts", { path: fontsPath, contentType: "application/json" });
  await cdp.detach();
  const restingShot = testInfo.outputPath("sidebar-toolbar-dark-resting.png");
  await toolbar.screenshot({ path: restingShot, animations: "disabled" });
  await testInfo.attach("Dark resting toolbar button (2x)", { path: restingShot, contentType: "image/png" });

  await create.click();
  await expect(create).toHaveAttribute("aria-expanded", "true");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText(["页面", "数据库"]);
  expect(await savedPages(page)).toEqual(baseline);
  const darkShot = testInfo.outputPath("sidebar-toolbar-menu-dark.png");
  await page.screenshot({ path: darkShot, animations: "disabled", clip: { x: 0, y: 0, width: 240, height: 200 } });
  await testInfo.attach("Dark toolbar and creation menu (2x)", { path: darkShot, contentType: "image/png" });

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
  await page.getByRole("main").click({ position: { x: 50, y: 100 } });
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
    await filesToolbar(page).getByRole("button", { name: "新建", exact: true }).click();
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
  await expectToolbarLayout(filesToolbar(page));
  await filesToolbar(page).getByRole("button", { name: "新建", exact: true }).click();
  await expect(newMenu(page)).toBeVisible();
  const lightShot = testInfo.outputPath("sidebar-menu-light-168px.png");
  await page.screenshot({ path: lightShot, animations: "disabled" });
  await testInfo.attach("Light creation menu at 168px (2x)", { path: lightShot, contentType: "image/png" });
  await page.keyboard.press("Escape");
  await expect(newMenu(page)).toBeHidden();

  await page.setViewportSize({ width: 390, height: 844 });
  const allPages = page.getByRole("button", { name: "All pages", exact: true });
  await expect(allPages).toHaveAttribute("aria-expanded", "false");
  await allPages.click();
  await expect(allPages).toHaveAttribute("aria-expanded", "true");
  await expect(sidebar).toBeVisible();
  await expectToolbarLayout(filesToolbar(page));
  await filesToolbar(page).getByRole("button", { name: "新建", exact: true }).click();
  const menu = newMenu(page);
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText(["页面", "数据库"]);
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

test("a collaborative startup snapshot preserves the initial workspace settings read", async ({ page }) => {
  await register(page, "sidebar_startup");
  await filesToolbar(page).getByRole("button", { name: "新建", exact: true }).click();
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
    await filesToolbar(page).getByRole("button", { name: "新建", exact: true }).click();
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
