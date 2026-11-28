import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";

let server: Awaited<ReturnType<typeof startServer>>;
let directory: string;
const password = "Uc67-tabs-split-password-2026!";
const SHOT_DIR = process.env.UC67_SHOT_DIR ?? "";

test.use({ colorScheme: "light", deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } });

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-uc67-tabs-"));
  server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", github: null, dev: process.env.HEINOTE_TEST_DEV === "1" });
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
    expect(basename(target)).toMatch(/^notes-uc67-tabs-/);
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
  await expect(identity).toBeVisible();
  await expect(identity.locator(".space-switcher__user")).toHaveText(handle);
}

async function waitPageSaved(page: Page, title: string) {
  await expect.poll(async () => {
    const response = await page.request.get(`${server.url}/api/records/personal/pages`);
    if (response.status() !== 200) return false;
    const rows = (await response.json()) as Array<{ value: { title_content?: Array<{ text: string }> } }>;
    return rows.some((row) => (row.value.title_content ?? []).map((run) => run.text).join("") === title);
  }).toBe(true);
}

function mainBody(page: Page) {
  return page.getByRole("main").getByRole("textbox", { name: "Text", exact: true }).and(page.locator('[contenteditable="true"]')).first();
}

async function createRootDocument(page: Page, title: string, body?: string) {
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.locator('.menu[role="menu"][aria-label="新建"]').getByRole("menuitem", { name: "页面", exact: true }).click();
  const titleInput = page.getByRole("main").getByLabel("Page title", { exact: true });
  await expect(titleInput).toBeEmpty();
  await titleInput.fill(title);
  if (body) {
    const editor = mainBody(page);
    await editor.click();
    await editor.fill(body);
  }
  await waitPageSaved(page, title);
}

function rowByTitle(page: Page, title: string): Locator {
  return page
    .getByRole("tree", { name: "Files", exact: true })
    .locator(".tree-row")
    .filter({ has: page.locator(".tree-row__label", { hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) })
    .first();
}

function paneLocator(page: Page, paneId: "left" | "right") {
  return page.locator(`.workspace-pane[data-pane-id="${paneId}"]`);
}

function tabLocator(page: Page, paneId: "left" | "right", title: string) {
  return paneLocator(page, paneId).locator(".pane-tab").filter({
    has: page.locator(".pane-tab__title", { hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }),
  });
}

test("UC-67 AC-01/02/05: single-pane tabs, pin protection, shortcut guard & context menu bulk close", async ({ page }) => {
  await register(page, "uc67_tabs_1");
  await createRootDocument(page, "Alpha", "Alpha body");
  await createRootDocument(page, "Beta", "Beta body");
  await createRootDocument(page, "Gamma", "Gamma body");
  await createRootDocument(page, "Delta", "Delta body");

  // Default click reuses active unpinned tab.
  await rowByTitle(page, "Alpha").locator(".tree-row__main").click();
  await expect(paneLocator(page, "left").locator(".pane-tab")).toHaveCount(1);
  await expect(tabLocator(page, "left", "Alpha")).toHaveClass(/is-active/);

  await rowByTitle(page, "Beta").locator(".tree-row__main").click();
  await expect(paneLocator(page, "left").locator(".pane-tab")).toHaveCount(1);
  await expect(tabLocator(page, "left", "Beta")).toHaveClass(/is-active/);

  // Explicit new tab via middle click & row context menu, and deduplication.
  await rowByTitle(page, "Alpha").locator(".tree-row__main").click({ button: "middle" });
  await expect(paneLocator(page, "left").locator(".pane-tab")).toHaveCount(2);
  await expect(tabLocator(page, "left", "Alpha")).toHaveClass(/is-active/);

  await rowByTitle(page, "Gamma").click({ button: "right" });
  await page.getByRole("menuitem", { name: "在新标签页打开", exact: true }).click();
  await expect(paneLocator(page, "left").locator(".pane-tab")).toHaveCount(3);

  // Re-opening already open Beta focuses existing tab instead of duplicating.
  await rowByTitle(page, "Beta").locator(".tree-row__main").click({ button: "middle" });
  await expect(paneLocator(page, "left").locator(".pane-tab")).toHaveCount(3);
  await expect(tabLocator(page, "left", "Beta")).toHaveClass(/is-active/);

  // Pin Alpha: moves to leftmost slot, hides close button, shows sidebar pin indicator.
  await tabLocator(page, "left", "Alpha").locator(".pane-tab__pin").click();
  await expect(paneLocator(page, "left").locator(".pane-tab").first()).toContainText("Alpha");
  await expect(tabLocator(page, "left", "Alpha")).toHaveAttribute("data-pinned", "true");
  await expect(tabLocator(page, "left", "Alpha").locator(".pane-tab__close")).toHaveCount(0);
  await expect(rowByTitle(page, "Alpha").locator(".tree-row__pinned")).toBeVisible();

  // Clicking Delta while pinned Alpha is active preserves Alpha and opens a new tab.
  await tabLocator(page, "left", "Alpha").locator(".pane-tab__main").click();
  await rowByTitle(page, "Delta").locator(".tree-row__main").click();
  await expect(tabLocator(page, "left", "Alpha")).toBeVisible();
  await expect(tabLocator(page, "left", "Delta")).toHaveClass(/is-active/);
  await expect(paneLocator(page, "left").locator(".pane-tab")).toHaveCount(4);

  await captureShot(page, "real-single-tabs.png");

  // Shortcut guard on pinned tab.
  await tabLocator(page, "left", "Alpha").locator(".pane-tab__main").click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+w" : "Control+w");
  await expect(tabLocator(page, "left", "Alpha")).toBeVisible();

  // Bulk close right & close others always preserve pinned Alpha.
  await tabLocator(page, "left", "Gamma").click({ button: "right" });
  await page.getByRole("menuitem", { name: /关闭右侧页签/ }).click();
  await expect(tabLocator(page, "left", "Alpha")).toBeVisible();
  await expect(tabLocator(page, "left", "Gamma")).toBeVisible();
  await expect(tabLocator(page, "left", "Delta")).toHaveCount(0);

  await tabLocator(page, "left", "Beta").click({ button: "right" });
  await page.getByRole("menuitem", { name: /关闭其他页签/ }).click();
  await expect(tabLocator(page, "left", "Alpha")).toBeVisible();
  await expect(tabLocator(page, "left", "Beta")).toBeVisible();
  await expect(tabLocator(page, "left", "Gamma")).toHaveCount(0);
});

test("UC-67 AC-03/04: split panes, same-page dual view isolation, seam resize, drag reorder/cross-pane & lossless merge", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await register(page, "uc67_split_2");
  const longLines = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: reference paragraph for scroll isolation`).join("\n");
  await createRootDocument(page, "SharedDoc", longLines);
  await createRootDocument(page, "NoteTwo", "Note two content");
  await createRootDocument(page, "NoteThree", "Note three content");

  // Open NoteTwo and pin SharedDoc on left pane.
  await rowByTitle(page, "SharedDoc").locator(".tree-row__main").click();
  await tabLocator(page, "left", "SharedDoc").locator(".pane-tab__pin").click();
  await rowByTitle(page, "NoteTwo").locator(".tree-row__main").click();

  // Open SharedDoc in right split via sidebar menu.
  await rowByTitle(page, "SharedDoc").click({ button: "right" });
  await page.getByRole("menuitem", { name: "在右侧分屏打开", exact: true }).click();
  await expect(page.locator(".workspace-pane")).toHaveCount(2);
  await expect(paneLocator(page, "right").locator(".pane-focus-pill")).toContainText("当前焦点");
  await expect(page.getByRole("status", { name: "All changes saved", exact: true })).toHaveCount(1);

  // Switch left pane to SharedDoc too so both panes display the same document simultaneously.
  await tabLocator(page, "left", "SharedDoc").locator(".pane-tab__main").click();
  await expect(paneLocator(page, "left").locator(".doc__title")).toHaveText("SharedDoc");
  await expect(paneLocator(page, "right").locator(".doc__title")).toHaveText("SharedDoc");

  // Independent scrolling across both panes showing the same document.
  await paneLocator(page, "left").locator(".page-surface").evaluate((el) => { el.scrollTop = 500; });
  await expect.poll(async () => paneLocator(page, "left").locator(".page-surface").evaluate((el) => el.scrollTop)).toBeGreaterThan(200);
  const rightScroll = await paneLocator(page, "right").locator(".page-surface").evaluate((el) => el.scrollTop);
  expect(rightScroll).toBe(0);

  // Capture real light split screenshot, then switch dark theme briefly for dark split screenshot.
  await captureShot(page, "real-light-split.png");

  // Seam resize changes pane widths.
  const leftBefore = (await paneLocator(page, "left").boundingBox())!.width;
  const seamBox = (await page.locator(".split-seam").boundingBox())!;
  await page.mouse.move(seamBox.x + seamBox.width / 2, seamBox.y + seamBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(seamBox.x + 110, seamBox.y + seamBox.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await paneLocator(page, "left").boundingBox())!.width).toBeGreaterThan(leftBefore + 60);

  // Re-open NoteThree on right pane and drag NoteTwo from left pane to right pane.
  await paneLocator(page, "right").click();
  await rowByTitle(page, "NoteThree").locator(".tree-row__main").click();
  await tabLocator(page, "left", "NoteTwo").dragTo(paneLocator(page, "right").locator(".tabbar__list"));
  await expect(tabLocator(page, "right", "NoteTwo")).toBeVisible();
  await expect(tabLocator(page, "left", "NoteTwo")).toHaveCount(0);

  // Pin NoteTwo in right pane, then merge split and verify pinned NoteTwo is preserved in left pane.
  await tabLocator(page, "right", "NoteTwo").locator(".pane-tab__pin").click();
  await paneLocator(page, "right").getByRole("button", { name: "合并为单栏", exact: true }).click();
  await expect(page.locator(".workspace-pane")).toHaveCount(1);
  await expect(tabLocator(page, "left", "NoteTwo")).toHaveAttribute("data-pinned", "true");
  await expect(tabLocator(page, "left", "SharedDoc")).toHaveAttribute("data-pinned", "true");

  // Re-split and close last unpinned right tab collapses back to single pane automatically.
  await paneLocator(page, "left").getByRole("button", { name: "左右分屏", exact: true }).click();
  await expect(page.locator(".workspace-pane")).toHaveCount(2);
  await paneLocator(page, "right").locator(".pane-tab__close").first().click();
  await expect(page.locator(".workspace-pane")).toHaveCount(1);
  await expect(page.getByText("Something went wrong")).toHaveCount(0);
  const appErrors = errors.filter((message) => !(process.env.HEINOTE_TEST_DEV === "1" && message === "WebSocket closed without opened."));
  expect(appErrors).toEqual([]);
});

test("UC-67 AC-06/08: per-space persistence across reload, trash cleanup & corrupt storage recovery", async ({ page }) => {
  await register(page, "uc67_persist_3");
  await createRootDocument(page, "PersonalOne", "P1");
  await createRootDocument(page, "PersonalTwo", "P2");
  await createRootDocument(page, "PersonalTrash", "P3");

  await rowByTitle(page, "PersonalOne").locator(".tree-row__main").click();
  await tabLocator(page, "left", "PersonalOne").locator(".pane-tab__pin").click();
  await rowByTitle(page, "PersonalTwo").click({ button: "right" });
  await page.getByRole("menuitem", { name: "在右侧分屏打开", exact: true }).click();
  await rowByTitle(page, "PersonalTrash").locator(".tree-row__main").click({ button: "middle" });
  await expect(page.locator(".workspace-pane")).toHaveCount(2);

  // Create a knowledge base space and switch there to verify independent tab state.
  const createdKb = await page.evaluate(async () => {
    const res = await fetch("/api/knowledge-bases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: crypto.randomUUID(), name: "测试知识库" }),
    });
    return res.json();
  });
  expect(createdKb.spaceId).toBeTruthy();

  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator(".workspace-pane")).toHaveCount(2);
  await expect(tabLocator(page, "left", "PersonalOne")).toHaveAttribute("data-pinned", "true");
  await expect(tabLocator(page, "right", "PersonalTwo")).toBeVisible();

  // Switch to dark theme via colorScheme media query and capture real dark split screenshot.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await captureShot(page, "real-dark-split.png");
  await page.emulateMedia({ colorScheme: "light" });

  // Switch to KB space -> single pane; switch back -> split restored.
  await page.getByRole("button", { name: "切换空间", exact: true }).click();
  await page.getByRole("menu", { name: "切换空间", exact: true }).getByRole("menuitem", { name: /^测试知识库/ }).click();
  await expect(page.locator(".workspace-pane")).toHaveCount(1);

  await page.getByRole("button", { name: "切换空间", exact: true }).click();
  await page.getByRole("menu", { name: "切换空间", exact: true }).getByRole("menuitem", { name: /^个人空间/ }).click();
  await expect(page.locator(".workspace-pane")).toHaveCount(2);

  // Trash inactive PersonalTrash -> automatically pruned from right pane tabs.
  await tabLocator(page, "right", "PersonalTwo").locator(".pane-tab__main").click();
  await rowByTitle(page, "PersonalTrash").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to trash", exact: true }).click();
  await expect(tabLocator(page, "right", "PersonalTrash")).toHaveCount(0);

  // Corrupt localStorage layout string -> reload gracefully falls back to single pane without crash.
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("notes:tabs:")) localStorage.setItem(key, "{corrupt-json");
    }
  });
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator(".workspace-pane")).toHaveCount(1);
  await expect(page.getByRole("main")).toBeVisible();
});

test("UC-67 AC-07: narrow desktop folds split without losing state and mobile keeps native shell", async ({ page }) => {
  await register(page, "uc67_narrow_4");
  await createRootDocument(page, "NarrowLeft", "L");
  await createRootDocument(page, "NarrowRight", "R");

  await rowByTitle(page, "NarrowLeft").locator(".tree-row__main").click();
  await rowByTitle(page, "NarrowRight").click({ button: "right" });
  await page.getByRole("menuitem", { name: "在右侧分屏打开", exact: true }).click();
  await expect(page.locator(".workspace-pane")).toHaveCount(2);

  // Narrow desktop (< 720px workspace width) collapses second pane visually without losing split state.
  await page.setViewportSize({ width: 780, height: 800 });
  await expect(page.locator(".workspace-pane")).toHaveCount(1);

  // Widen back -> split panes reappear intact.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator(".workspace-pane")).toHaveCount(2);

  // Mobile (< 560px) hides desktop tabbar and uses mobile topbar.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".tabbar")).toHaveCount(0);
  await expect(page.locator(".topbar--mobile")).toBeVisible();
});
