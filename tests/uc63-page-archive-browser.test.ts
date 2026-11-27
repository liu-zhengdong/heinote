import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";

let server: Awaited<ReturnType<typeof startServer>>;
let directory: string;
const password = "Page-archive-password-2026";

test.use({ colorScheme: "light", deviceScaleFactor: 2 });

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-uc63-archive-"));
  server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1" });
});

test.afterAll(async () => {
  await server?.close();
  if (directory) {
    const target = resolve(directory);
    expect(dirname(target)).toBe(resolve(tmpdir()));
    expect(basename(target)).toMatch(/^notes-uc63-archive-/);
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

function bodyEditor(page: Page) {
  return page.getByRole("main").getByRole("textbox", { name: "Text", exact: true }).and(page.locator('[contenteditable="true"]')).first();
}

async function createRootDocument(page: Page, title: string, body?: string) {
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.locator('.menu[role="menu"][aria-label="新建"]').getByRole("menuitem", { name: "页面", exact: true }).click();
  const titleInput = page.getByLabel("Page title", { exact: true });
  await expect(titleInput).toBeEmpty();
  await titleInput.fill(title);
  if (body) {
    const editor = bodyEditor(page);
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

async function createChildDocument(page: Page, parentTitle: string, title: string, body?: string) {
  const parentRow = rowByTitle(page, parentTitle);
  await parentRow.hover();
  await parentRow.getByRole("button", { name: `New page inside ${parentTitle}`, exact: true }).click();
  const titleInput = page.getByLabel("Page title", { exact: true });
  await expect(titleInput).toBeEmpty();
  await titleInput.fill(title);
  if (body) {
    const editor = bodyEditor(page);
    await editor.click();
    await editor.fill(body);
  }
  await waitPageSaved(page, title);
}

test("UC-63: archive project subtree into collapsible sidebar group, keep editable, fold in Quick Find with zero-hit auto-expand, and unarchive", async ({ page }) => {
  await register(page, "uc63_user");

  // Create an active project and a finished project with a nested UC card.
  await createRootDocument(page, "活跃项目 认证方案", "当前正在做的认证模块");
  await createRootDocument(page, "历史项目 Alpha", "已完成的项目总览");
  await createChildDocument(page, "历史项目 Alpha", "UC-01 认证登录", "旧账本独有记录");

  const tree = page.getByRole("tree", { name: "Files", exact: true });
  const activeRoots = tree.locator(":scope > .tree-branch > .tree-row .tree-row__label");
  await expect(activeRoots).toHaveText(["活跃项目 认证方案", "历史项目 Alpha"]);

  // Archive the finished project via sidebar row menu.
  const oldProjectRow = rowByTitle(page, "历史项目 Alpha");
  await oldProjectRow.hover();
  await oldProjectRow.getByRole("button", { name: "Actions for 历史项目 Alpha", exact: true }).click();
  await page.locator('.menu[role="menu"][aria-label="Page actions"]').getByRole("menuitem", { name: "归档", exact: true }).click();

  // Active sidebar drops the archived subtree; bottom collapsed "已归档" section appears with count 1.
  await expect(activeRoots).toHaveText(["活跃项目 认证方案"]);
  const archivedToggle = tree.locator(".sidebar__archived-toggle");
  await expect(archivedToggle).toBeVisible();
  await expect(archivedToggle).toHaveAttribute("aria-expanded", "false");
  await expect(archivedToggle.locator(".sidebar__archived-count")).toHaveText("1");

  // Expand "已归档", expand the archived project, and open its child UC card.
  await archivedToggle.click();
  await expect(archivedToggle).toHaveAttribute("aria-expanded", "true");
  const archivedProjectRow = tree.locator(".sidebar__archived-list .tree-row").filter({ hasText: "历史项目 Alpha" }).first();
  await expect(archivedProjectRow).toBeVisible();
  const childRowInArchive = tree.locator(".sidebar__archived-list .tree-row").filter({ hasText: "UC-01 认证登录" }).first();
  if (!(await childRowInArchive.isVisible())) {
    await archivedProjectRow.locator(".tree-row__mark").click();
  }
  await childRowInArchive.click();

  // Child page shows inherited archive banner and remains editable.
  const banner = page.locator(".shelved-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("随「历史项目 Alpha」已归档");
  const editor = bodyEditor(page);
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" · 补充备注");
  await expect(editor).toContainText("旧账本独有记录 · 补充备注");

  // Wait for save and verify state + edit survive full reload.
  await expect(page.getByRole("status", { name: "All changes saved", exact: true })).toHaveCount(1);
  await page.reload();
  await expect(page.locator(".shelved-banner")).toContainText("随「历史项目 Alpha」已归档");
  await expect(bodyEditor(page)).toContainText("补充备注");
  await expect(tree.locator(".sidebar__archived-toggle")).toHaveAttribute("aria-expanded", "false");

  // Open Quick Find (⌘K): empty query recent list excludes archived pages.
  await page.locator(".sidebar__search").click();
  const qf = page.locator(".quickfind");
  await expect(qf).toBeVisible();
  const options = qf.locator('[role="option"]');
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText("活跃项目 认证方案");

  // Search shared keyword "认证": active hit shown, archived hit folded behind toggle row.
  const qfInput = qf.getByLabel("Search pages", { exact: true });
  await qfInput.fill("认证");
  await expect(qf.locator(".quickfind__archived-toggle")).toBeVisible();
  await expect(qf.locator(".quickfind__archived-toggle")).toContainText("已归档结果（1）");
  await expect(qf.locator(".quickfind__item--archived")).toHaveCount(0);

  // Click expand toggle -> archived hit appears with "已归档" badge, and can be collapsed again.
  await qf.locator(".quickfind__archived-toggle").click();
  await expect(qf.locator(".quickfind__item--archived")).toHaveCount(1);
  await expect(qf.locator(".quickfind__item--archived").first()).toContainText("UC-01 认证登录");
  await expect(qf.locator(".quickfind__item--archived .quickfind__badge")).toHaveText("已归档");
  await qf.locator(".quickfind__archived-collapse").click();
  await expect(qf.locator(".quickfind__archived-toggle")).toBeVisible();

  // Search archive-only keyword "旧账本" (0 active hits) -> auto-expands archived results.
  await qfInput.fill("旧账本");
  await expect(qf.locator(".quickfind__archived-toggle")).toHaveCount(0);
  await expect(qf.locator(".quickfind__item--archived")).toHaveCount(1);
  await expect(qf.locator(".quickfind__item--archived").first()).toContainText("UC-01 认证登录");

  // Click the auto-expanded archived hit to jump to it, then unarchive from the banner.
  await qf.locator(".quickfind__item--archived").first().click();
  await expect(qf).toBeHidden();
  await page.locator(".shelved-banner").getByRole("button", { name: "取消归档", exact: true }).click();
  await expect(page.locator(".shelved-banner")).toHaveCount(0);
  await expect(tree.locator(".sidebar__archived")).toHaveCount(0);
  await expect(activeRoots).toHaveText(["活跃项目 认证方案", "历史项目 Alpha"]);

  // After unarchiving, searching "认证" shows both pages directly with no folded archived toggle.
  await page.locator(".sidebar__search").click();
  await qf.getByLabel("Search pages", { exact: true }).fill("认证");
  await expect(qf.locator(".quickfind__archived-toggle")).toHaveCount(0);
  await expect(qf.locator(".quickfind__item--archived")).toHaveCount(0);
  await expect(qf.locator('[role="option"]').filter({ hasText: "活跃项目 认证方案" }).first()).toBeVisible();
  await expect(qf.locator('[role="option"]').filter({ hasText: "UC-01 认证登录" }).first()).toBeVisible();
});
