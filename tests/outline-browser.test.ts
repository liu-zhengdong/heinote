import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/index.ts";

const password = "outline-test-password-2026";

function fillerParagraphs(label: string, count: number): string {
  return Array.from({ length: count }, (_, idx) =>
    `${label} 第 ${idx + 1} 段正文内容，用来撑开足够的阅读高度，确保页面大纲的滚动高亮、平滑跳转以及右侧布局留白都能在真实视口下被完整验证。`,
  ).join("\n\n");
}

const LONG_DOC_MARKDOWN = [
  "# 项目背景与目标",
  fillerParagraphs("背景", 4),
  "## 核心架构设计",
  fillerParagraphs("架构", 4),
  "### 数据存储与事务",
  fillerParagraphs("存储", 3),
  "#### SQLite 事务边界",
  fillerParagraphs("事务边界", 3),
  "##### 冲突重试细节",
  fillerParagraphs("冲突重试", 3),
  "### 实时同步机制",
  fillerParagraphs("同步", 4),
  "## 验收与发布计划",
  fillerParagraphs("发布", 5),
  "# 附录与参考资料",
  fillerParagraphs("附录", 5),
].join("\n\n");

test("document editor shows Notion-style outline rail, hover popover, scroll jump, live updates, and wide pin", async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), "outline-edit-"));
  const server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1" });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });

    const reg = await page.request.post(`${server.url}/api/auth/register`, {
      data: { handle: "outlineowner", displayName: "outlineowner", password },
    });
    expect(reg.status()).toBe(201);
    const login = await page.request.post(`${server.url}/api/auth/login`, {
      data: { handle: "outlineowner", password },
    });
    expect(login.status()).toBe(200);

    const plainRes = await page.request.post(`${server.url}/api/v1/pages`, {
      data: { title: "无标题纯正文页", markdown: "只有普通段落，没有任何一二三级标题。" },
    });
    expect(plainRes.status()).toBe(201);

    const longRes = await page.request.post(`${server.url}/api/v1/pages`, {
      data: { title: "架构设计总览", markdown: LONG_DOC_MARKDOWN },
    });
    expect(longRes.status()).toBe(201);

    await page.goto(server.url);
    await page.locator(".tree-row", { hasText: "无标题纯正文页" }).click();
    await expect(page.locator(".doc__title")).toContainText("无标题纯正文页");
    await expect(page.locator(".page-outline")).toHaveCount(0);

    // Switch to the long page with headings.
    await page.locator(".tree-row", { hasText: "架构设计总览" }).click();
    await expect(page.locator(".doc__title")).toContainText("架构设计总览");

    const rail = page.locator(".page-outline__rail");
    await expect(rail).toBeVisible();
    await expect(rail.locator(".page-outline__tick")).toHaveCount(8);
    await expect(page.locator(".page-outline__card")).toHaveCount(0);

    await page.screenshot({ path: "test-results/outline-edit-rail.png" });

    // Hover opens the floating outline card with hierarchical indentation across H1–H5.
    await rail.hover();
    const card = page.locator(".page-outline__card");
    await expect(card).toBeVisible();
    const items = card.locator(".page-outline__item");
    await expect(items).toHaveCount(8);
    await expect(items.nth(0)).toContainText("项目背景与目标");
    await expect(items.nth(0)).toHaveClass(/page-outline__item--d0/);
    await expect(items.nth(1)).toHaveClass(/page-outline__item--d1/);
    await expect(items.nth(2)).toHaveClass(/page-outline__item--d2/);
    await expect(items.nth(3)).toHaveClass(/page-outline__item--d3/);
    await expect(items.nth(4)).toHaveClass(/page-outline__item--d4/);

    await page.screenshot({ path: "test-results/outline-edit-popover.png" });

    // Clicking a lower heading smoothly scrolls the page surface to it and marks it active.
    await items.nth(6).click();
    await expect(items.nth(6)).toHaveAttribute("aria-current", "location");
    await expect.poll(async () => {
      return page.locator(".page-surface").evaluate((el) => el.scrollTop);
    }).toBeGreaterThan(400);

    // Pin the outline on wide screen and verify no collision with the text column.
    const pinBtn = card.locator(".page-outline__pin");
    await expect(pinBtn).toBeVisible();
    await pinBtn.click();
    await expect(page.locator(".page-outline--pinned")).toBeVisible();
    await expect(page.locator(".page-outline__rail")).toHaveCount(0);

    // Scroll to H3/H4/H5 section to verify typography hierarchy in the pinned screenshot.
    await page.locator(".page-outline__item").nth(2).click();
    await expect(page.locator(".block--heading4 h4.block__editable")).toContainText("SQLite 事务边界");
    await expect(page.locator(".block--heading5 h5.block__editable")).toContainText("冲突重试细节");

    const overlap = await page.evaluate(() => {
      const inner = document.querySelector(".doc__inner")?.getBoundingClientRect();
      const outline = document.querySelector(".page-outline__card")?.getBoundingClientRect();
      if (!inner || !outline) return { ok: false, inner, outline };
      return { ok: inner.right <= outline.left + 1, innerRight: inner.right, outlineLeft: outline.left };
    });
    expect(overlap.ok).toBe(true);

    await page.screenshot({ path: "test-results/outline-edit-pinned.png" });

    // Live typing #### and ##### shortcuts creates H4/H5 blocks and updates the outline live.
    const firstHeading = page.locator('.block--heading1 [contenteditable="true"]').first();
    await firstHeading.click();
    await page.keyboard.press("End");
    await page.keyboard.type("（已修订）");
    await expect(page.locator(".page-outline__item").first()).toContainText("项目背景与目标（已修订）");

    await page.keyboard.press("Enter");
    await page.keyboard.type("#### 动态四级标题");
    await expect(page.locator(".block--heading4 h4.block__editable").first()).toContainText("动态四级标题");
    await page.keyboard.press("Enter");
    await page.keyboard.type("##### 动态五级标题");
    await expect(page.locator(".block--heading5 h5.block__editable").first()).toContainText("动态五级标题");
    await expect(page.locator(".page-outline__item")).toHaveCount(10);

    // Reloading preserves the pinned state.
    await page.reload();
    await expect(page.locator(".doc__title")).toContainText("架构设计总览");
    await expect(page.locator(".page-outline--pinned")).toBeVisible();

    // Narrowing below wide threshold falls back to tick rail; mobile width hides it.
    await page.setViewportSize({ width: 960, height: 900 });
    await expect(page.locator(".page-outline--pinned")).toHaveCount(0);
    await expect(page.locator(".page-outline__rail")).toBeVisible();

    await page.setViewportSize({ width: 500, height: 900 });
    await expect(page.locator(".page-outline")).toHaveCount(0);

    // Widening again restores pinned state and unpinning collapses back to tick rail.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator(".page-outline--pinned")).toBeVisible();
    await page.locator(".page-outline__pin").click();
    await expect(page.locator(".page-outline--pinned")).toHaveCount(0);
    await expect(page.locator(".page-outline__rail")).toBeVisible();
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("public share page renders the shared outline without corrupting page hash navigation", async ({ page, browser }) => {
  const directory = await mkdtemp(join(tmpdir(), "outline-public-"));
  const server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1" });
  try {
    const reg = await page.request.post(`${server.url}/api/auth/register`, {
      data: { handle: "puboutline", displayName: "puboutline", password },
    });
    expect(reg.status()).toBe(201);
    const login = await page.request.post(`${server.url}/api/auth/login`, {
      data: { handle: "puboutline", password },
    });
    expect(login.status()).toBe(200);

    const rootRes = await page.request.post(`${server.url}/api/v1/pages`, {
      data: { title: "公开文档首页", markdown: "# 首页说明\n\n首页正文。" },
    });
    expect(rootRes.status()).toBe(201);
    const rootId = (await rootRes.json()).id;

    const childRes = await page.request.post(`${server.url}/api/v1/pages`, {
      data: { parentId: rootId, title: "详细规格书", markdown: LONG_DOC_MARKDOWN },
    });
    expect(childRes.status()).toBe(201);
    const childId = (await childRes.json()).id;

    const shareRes = await page.request.post(`${server.url}/api/shares`, { data: { pageId: rootId } });
    expect(shareRes.status()).toBe(201);
    const token = String((await shareRes.json()).url).replace("/s/", "");

    const guest = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const reader = await guest.newPage();
    await reader.goto(`${server.url}/s/${token}#page=${encodeURIComponent(childId)}`);
    await expect(reader.locator(".public-reader__content h1")).toContainText("详细规格书");

    const rail = reader.locator(".page-outline__rail");
    await expect(rail).toBeVisible();
    await rail.click();

    const card = reader.locator(".page-outline__card");
    await expect(card).toBeVisible();
    const items = card.locator(".page-outline__item");
    await expect(items).toHaveCount(8);
    await expect(reader.locator(".public-reader__content h5")).toContainText("SQLite 事务边界");
    await expect(reader.locator(".public-reader__content h6")).toContainText("冲突重试细节");

    // Jumping to a heading scrolls the public reader AND preserves the #page= hash.
    const beforeHash = await reader.evaluate(() => window.location.hash);
    await items.nth(6).click();
    await expect.poll(async () => {
      return reader.locator(".public-reader").evaluate((el) => el.scrollTop);
    }).toBeGreaterThan(300);
    expect(await reader.evaluate(() => window.location.hash)).toBe(beforeHash);

    // Pin on wide public share and verify zero overlap with document content.
    await reader.locator(".page-outline__pin").click();
    await expect(reader.locator(".page-outline--pinned")).toBeVisible();

    const layoutCheck = await reader.evaluate(() => {
      const content = document.querySelector(".public-reader__content")?.getBoundingClientRect();
      const outline = document.querySelector(".page-outline__card")?.getBoundingClientRect();
      if (!content || !outline) return { ok: false };
      return { ok: content.right <= outline.left + 1, contentRight: content.right, outlineLeft: outline.left };
    });
    expect(layoutCheck.ok).toBe(true);

    await reader.screenshot({ path: "test-results/outline-public-pinned.png" });

    // Also verify dark theme contrast.
    await reader.emulateMedia({ colorScheme: "dark" });
    await reader.screenshot({ path: "test-results/outline-public-dark.png" });
    await guest.close();
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
