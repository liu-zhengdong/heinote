import { test, expect, type Page } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";

let server: Awaited<ReturnType<typeof startServer>>;
let directory: string;
const password = "Uc68-width-fullscreen-password-2026!";
const SHOT_DIR = process.env.UC68_SHOT_DIR ?? "";

const STATEFUL_APP = `<!doctype html>
<html>
<head>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; padding: 24px; background: linear-gradient(135deg, #f8fafc, #eef2ff); color: #1e293b; }
  html[data-theme="dark"] body { background: linear-gradient(135deg, #0f172a, #1e1b4b); color: #e2e8f0; }
  .panel { max-width: 1120px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 20px; border-radius: 12px; background: rgba(255,255,255,0.72); border: 1px solid rgba(148,163,184,0.3); }
  html[data-theme="dark"] .panel { background: rgba(15,23,42,0.75); border-color: rgba(148,163,184,0.2); }
  button { padding: 8px 14px; border-radius: 8px; border: 0; background: #2563eb; color: #fff; font-weight: 600; cursor: pointer; }
</style>
</head>
<body>
  <div class="panel">
    <div>
      <strong>Interactive Canvas</strong>
      <div id="cnt">count:0</div>
    </div>
    <button id="inc" type="button">Increment</button>
  </div>
  <script>
    let n = 0;
    document.getElementById("inc").addEventListener("click", () => {
      n += 1;
      document.getElementById("cnt").textContent = "count:" + n;
    });
  </script>
</body>
</html>`;

test.use({ colorScheme: "light", deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } });

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-uc68-"));
  server = await startServer({
    dataDir: directory,
    port: 0,
    host: "127.0.0.1",
    github: null,
    dev: process.env.HEINOTE_TEST_DEV === "1",
  });
  if (SHOT_DIR) await mkdir(SHOT_DIR, { recursive: true }).catch(() => undefined);
});

async function captureShot(page: Page, name: string) {
  if (!SHOT_DIR) return;
  await page.screenshot({ path: join(SHOT_DIR, name) });
}

test.afterAll(async () => {
  await server?.close();
  if (directory) {
    const target = resolve(directory);
    expect(dirname(target)).toBe(resolve(tmpdir()));
    expect(basename(target)).toMatch(/^notes-uc68-/);
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
}

async function createToken(page: Page): Promise<string> {
  const res = await page.request.post(`${server.url}/api/tokens`, {
    headers: { Origin: server.url },
    data: { name: "uc68-token", access: "write" },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

async function createRootDocument(page: Page, title: string, bodyText: string) {
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.locator('.menu[role="menu"][aria-label="新建"]').getByRole("menuitem", { name: "页面", exact: true }).click();
  const titleInput = page.getByRole("main").getByLabel("Page title", { exact: true });
  await expect(titleInput).toBeEmpty();
  await titleInput.fill(title);
  const editor = page.getByRole("main").getByRole("textbox", { name: "Text", exact: true }).and(page.locator('[contenteditable="true"]')).first();
  await editor.click();
  await editor.fill(bodyText);
  await expect.poll(async () => {
    const res = await page.request.get(`${server.url}/api/records/personal/pages`);
    if (res.status() !== 200) return false;
    const rows = (await res.json()) as Array<{ value: { title_content?: Array<{ text: string }> } }>;
    return rows.some((row) => (row.value.title_content ?? []).map((r) => r.text).join("") === title);
  }).toBe(true);
}

test("UC-68 AC-01: global default full-width preference + per-page TopBar override persist across reload", async ({ page }) => {
  await register(page, "uc68_pref_user");

  // Open Preferences -> set default page width to "全宽铺满".
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "账号设置", exact: true });
  await dialog.getByRole("tab", { name: "偏好", exact: true }).click();
  await dialog.getByRole("combobox", { name: "默认页面宽度", exact: true }).click();
  await page.getByRole("listbox", { name: "默认页面宽度", exact: true }).getByRole("option", { name: "全宽铺满", exact: true }).click();
  await expect(dialog.locator(".settings-saved")).toHaveText("已保存");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await createRootDocument(page, "WideDefaultPage", "Paragraph inheriting global full-width");
  await createRootDocument(page, "NarrowOverridePage", "Paragraph overridden back to standard width");

  // Default full-width applies immediately to WideDefaultPage, and override flips NarrowOverridePage to standard width.
  await expect(page.getByRole("main").locator("article.doc")).toHaveClass(/doc--full/);
  const fullInnerWidth = await page.getByRole("main").locator(".doc__inner").evaluate((el) => el.getBoundingClientRect().width);
  expect(fullInnerWidth).toBeGreaterThan(900);

  await page.getByRole("button", { name: "切换为标准宽度", exact: true }).click();
  await expect(page.getByRole("main").locator("article.doc")).not.toHaveClass(/doc--full/);
  const standardInnerWidth = await page.getByRole("main").locator(".doc__inner").evaluate((el) => el.getBoundingClientRect().width);
  expect(standardInnerWidth).toBeLessThanOrEqual(720);

  // Switch back to WideDefaultPage -> still full width; reload -> both preference and per-page override survive.
  await page.getByRole("tree", { name: "Files", exact: true }).getByRole("button", { name: "WideDefaultPage", exact: true }).click();
  await expect(page.getByRole("main").locator("article.doc")).toHaveClass(/doc--full/);

  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByRole("main").locator("article.doc")).toHaveClass(/doc--full/);
  await page.getByRole("tree", { name: "Files", exact: true }).getByRole("button", { name: "NarrowOverridePage", exact: true }).click();
  await expect(page.getByRole("main").locator("article.doc")).not.toHaveClass(/doc--full/);
});

test("UC-68 AC-02/03/04: App full-width unlocks 920px cap, App & Page fullscreen preserve state without reload, Escape exits cleanly", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));

  await register(page, "uc68_app_fs");
  const token = await createToken(page);

  // Create stateful App via Agent API and open it in UI.
  const created = await page.request.post(`${server.url}/api/v1/pages`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { kind: "app", title: "FullViewApp" },
  });
  expect(created.status()).toBe(201);
  const appDto = await created.json();
  const patched = await page.request.patch(`${server.url}/api/v1/pages/${appDto.id}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { baseRevision: appDto.revision, app: { draft: STATEFUL_APP } },
  });
  expect(patched.status()).toBe(200);

  // Enable global full-width first, or toggle TopBar full width directly on the App page.
  await page.goto(`${server.url}/?page=${appDto.id}`);
  await page.getByRole("button", { name: "管理", exact: true }).click();
  await page.getByRole("tab", { name: "源码", exact: true }).click();
  await page.getByRole("button", { name: "启用", exact: true }).click();
  await page.getByRole("button", { name: "收起管理面板", exact: true }).click();

  const appFrame = page.frameLocator("iframe.app-surface__frame");
  await expect(appFrame.locator("#cnt")).toHaveText("count:0");
  await appFrame.locator("#inc").click();
  await expect(appFrame.locator("#cnt")).toHaveText("count:1");

  // Default width respects <= 920px stage cap; toggling TopBar full width removes 920px cap.
  const narrowBox = await page.locator(".app-surface--grow").boundingBox();
  expect(narrowBox!.width).toBeLessThanOrEqual(922);

  await page.getByRole("button", { name: "切换为全宽", exact: true }).click();
  await expect(page.locator(".app-page")).toHaveClass(/app-page--full/);
  await expect.poll(async () => (await page.locator(".app-surface--grow").boundingBox())!.width).toBeGreaterThan(1000);
  await captureShot(page, "app-fullwidth-light.png");

  // Enter App fullscreen via strip button -> fills 1440x900, hides tabbar/topbar/strip, preserves iframe state.
  await page.getByRole("button", { name: "全屏", exact: true }).click();
  await expect(page.locator(".workspace-pane--fullscreen.is-app")).toBeVisible();
  await expect(page.locator(".app-strip")).toBeHidden();
  await expect(page.locator(".workspace-pane--fullscreen .topbar")).toBeHidden();
  await expect(page.getByRole("button", { name: "退出全屏", exact: true })).toBeVisible();

  const fsRect = await page.locator("iframe.app-surface__frame").boundingBox();
  expect(Math.abs(fsRect!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(fsRect!.y)).toBeLessThanOrEqual(1);
  expect(fsRect!.width).toBeGreaterThanOrEqual(1438);
  expect(fsRect!.height).toBeGreaterThanOrEqual(898);

  // State preserved (count:1 -> count:2 without iframe reload).
  await expect(appFrame.locator("#cnt")).toHaveText("count:1");
  await appFrame.locator("#inc").click();
  await expect(appFrame.locator("#cnt")).toHaveText("count:2");

  // Escape exits App fullscreen and keeps iframe state intact.
  await page.keyboard.press("Escape");
  await expect(page.locator(".workspace-pane--fullscreen")).toHaveCount(0);
  await expect(page.locator(".app-strip")).toBeVisible();
  await expect(appFrame.locator("#cnt")).toHaveText("count:2");

  // Re-enter fullscreen under dark theme for visual verification screenshot.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.getByRole("button", { name: "全屏", exact: true }).click();
  await expect(page.locator(".workspace-pane--fullscreen.is-app")).toBeVisible();
  await captureShot(page, "app-fullscreen-dark.png");
  await page.keyboard.press("Escape");
  await page.emulateMedia({ colorScheme: "light" });

  // AC-04: Ordinary Page fullscreen covers viewport while keeping TopBar tools accessible.
  await createRootDocument(page, "DocFullscreen", "Fullscreen document body");
  await page.getByRole("button", { name: "全屏视图", exact: true }).click();
  await expect(page.locator(".workspace-pane--fullscreen")).toBeVisible();
  const docPaneRect = await page.locator(".workspace-pane--fullscreen").boundingBox();
  expect(docPaneRect!.width).toBeGreaterThanOrEqual(1438);
  expect(docPaneRect!.height).toBeGreaterThanOrEqual(898);
  await expect(page.getByRole("button", { name: "退出全屏", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".workspace-pane--fullscreen")).toHaveCount(0);

  const appErrors = errors.filter((message) => !(process.env.HEINOTE_TEST_DEV === "1" && message === "WebSocket closed without opened."));
  expect(appErrors).toEqual([]);
});

test("UC-68 AC-05: public share supports header Fullscreen toggle and ?fullscreen=1 direct immersive mode without reload", async ({ page }) => {
  await register(page, "uc68_public_fs");
  const token = await createToken(page);

  const created = await page.request.post(`${server.url}/api/v1/pages`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { kind: "app", title: "PublicFullApp" },
  });
  const appDto = await created.json();
  await page.request.patch(`${server.url}/api/v1/pages/${appDto.id}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { baseRevision: appDto.revision, app: { draft: STATEFUL_APP } },
  });
  await page.goto(`${server.url}/?page=${appDto.id}`);
  await page.getByRole("button", { name: "管理", exact: true }).click();
  await page.getByRole("tab", { name: "源码", exact: true }).click();
  await page.getByRole("button", { name: "启用", exact: true }).click();
  await expect.poll(async () => (await (await page.request.get(`${server.url}/api/v1/pages/${appDto.id}`, { headers: { Authorization: `Bearer ${token}` } })).json()).page.app?.enabled).toBeTruthy();

  const share = await page.request.post(`${server.url}/api/shares`, {
    headers: { Origin: server.url },
    data: { pageId: appDto.id },
  });
  expect(share.status()).toBe(201);
  const shareUrl = new URL((await share.json()).url as string, server.url);

  // 1. Open normal public share -> click 全屏 without reloading iframe state.
  await page.goto(shareUrl.toString());
  const guestFrame = page.frameLocator("iframe.app-surface__frame");
  await expect(page.locator(".public-reader__head")).toBeVisible();
  await guestFrame.locator("#inc").click();
  await expect(guestFrame.locator("#cnt")).toHaveText("count:1");

  await page.getByRole("button", { name: "全屏视图", exact: true }).click();
  await expect(page.locator(".public-reader--fullscreen")).toBeVisible();
  await expect(page.locator(".public-reader__head")).toBeHidden();
  const rect = await page.locator("iframe.app-surface__frame").boundingBox();
  expect(Math.abs(rect!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(rect!.y)).toBeLessThanOrEqual(1);
  expect(rect!.width).toBeGreaterThanOrEqual(1438);
  expect(rect!.height).toBeGreaterThanOrEqual(898);
  await expect(guestFrame.locator("#cnt")).toHaveText("count:1");
  await captureShot(page, "public-fullscreen-light.png");

  // Exit via Escape restores header cleanly without losing iframe state.
  await page.keyboard.press("Escape");
  await expect(page.locator(".public-reader--fullscreen")).toHaveCount(0);
  await expect(page.locator(".public-reader__head")).toBeVisible();
  await expect(guestFrame.locator("#cnt")).toHaveText("count:1");

  // 2. Open with ?fullscreen=1 directly enters fullscreen view.
  shareUrl.searchParams.set("fullscreen", "1");
  await page.goto(shareUrl.toString());
  await expect(page.locator(".public-reader--fullscreen")).toBeVisible();
  await expect(page.locator(".public-reader__head")).toBeHidden();
  const directRect = await page.locator("iframe.app-surface__frame").boundingBox();
  expect(directRect!.width).toBeGreaterThanOrEqual(1438);
  expect(directRect!.height).toBeGreaterThanOrEqual(898);
});
