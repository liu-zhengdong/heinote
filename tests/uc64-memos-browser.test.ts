import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";

let server: Awaited<ReturnType<typeof startServer>>;
let directory: string;
const password = "Memo-browser-password-2026";

test.use({ colorScheme: "light", deviceScaleFactor: 2 });

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-uc64-memos-"));
  server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1" });
});

test.afterAll(async () => {
  await server?.close();
  if (directory) {
    const target = resolve(directory);
    expect(dirname(target)).toBe(resolve(tmpdir()));
    expect(basename(target)).toMatch(/^notes-uc64-memos-/);
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
}

function memoRailTab(page: Page) {
  return page.getByRole("navigation", { name: "HeiNote navigation", exact: true })
    .getByRole("tablist", { name: "Page list", exact: true })
    .getByRole("tab", { name: "Memos", exact: true });
}

test("UC-64 desktop: memos capture, nested #tags, comment stability, promote, QuickFind, trash/restore & space isolation", async ({ page }) => {
  await register(page, "uc64_desktop");

  // Create one normal document first so Files / Graph baseline exists.
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.locator('.menu[role="menu"][aria-label="新建"]').getByRole("menuitem", { name: "页面", exact: true }).click();
  const titleInput = page.getByLabel("Page title", { exact: true });
  await expect(titleInput).toBeEmpty();
  await titleInput.fill("基线普通页面");
  await expect(page.getByRole("status", { name: "All changes saved", exact: true })).toHaveCount(1);

  // Switch to Memos view via left rail.
  await memoRailTab(page).click();
  await expect(page.getByRole("main", { name: "闪念卡片流", exact: true })).toBeVisible();

  const composer = page.locator('.memo-composer .block__editable[contenteditable="true"]').first();
  await composer.click();
  await page.keyboard.type("较早闪念 咖啡豆实验 #灵感 #工作/咖啡");
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".memo-entry")).toHaveCount(1);

  await composer.click();
  await page.keyboard.type("最新闪念 **粗体亮点** #工作/设计");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await expect(page.getByRole("listbox", { name: "Blocks", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("[] 检查排版间距");
  await page.locator(".memo-composer__foot").getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".memo-entry")).toHaveCount(2);

  // Newest card is first and preserves live Markdown formatting + todo checkbox.
  await expect(page.locator(".memo-entry").nth(0)).toContainText("最新闪念");
  await expect(page.locator(".memo-entry").nth(0).locator("strong")).toContainText("粗体亮点");
  await expect(page.locator(".memo-entry").nth(0).locator(".checkbox")).toHaveCount(1);
  await expect(page.locator(".memo-entry").nth(1)).toContainText("较早闪念");

  // Parent tag filter matches both children; child tag narrows to 1.
  await page.locator(".memo-tag-row .tree-row__main", { hasText: /^工作/ }).first().click();
  await expect(page.locator(".memo-entry")).toHaveCount(2);
  await page.locator(".memo-tag-row .tree-row__main", { hasText: /^设计/ }).first().click();
  await expect(page.locator(".memo-entry")).toHaveCount(1);
  await expect(page.locator(".memo-entry").first()).toContainText("最新闪念");
  await page.locator(".memo-tag-row .tree-row__main", { hasText: /^设计/ }).first().click();
  await expect(page.locator(".memo-entry")).toHaveCount(2);

  // Pin, rename, and delete tag from left tag tree.
  const workTagRow = page.locator(".memo-tag-row", { hasText: /^工作/ }).first();
  await workTagRow.hover();
  await workTagRow.getByRole("button", { name: "置顶标签 工作", exact: true }).click();
  await expect(page.getByLabel("置顶标签", { exact: true })).toContainText("工作");

  const ideaTagRow = page.locator(".memo-tag-row", { hasText: /^灵感/ }).first();
  await ideaTagRow.hover();
  await ideaTagRow.getByRole("button", { name: "重命名标签 灵感", exact: true }).click();
  const renameModal = page.getByRole("dialog", { name: "重命名标签", exact: true });
  await renameModal.locator("input").fill("好点子");
  await renameModal.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".memo-entry").nth(1)).toContainText("#好点子");

  const renamedTagRow = page.locator(".memo-tag-row", { hasText: /^好点子/ }).first();
  await renamedTagRow.hover();
  await renamedTagRow.getByRole("button", { name: "移除标签 好点子", exact: true }).click();
  await expect(page.locator(".memo-entry").nth(1)).toContainText("较早闪念 咖啡豆实验");
  await expect(page.locator(".memo-entry").nth(1)).not.toContainText("#好点子");

  // Click-to-edit on memo body + auto-save on blur (and Escape cancel); tags still filter on click.
  const latestCard = page.locator(".memo-entry").nth(0);
  await latestCard.locator(".memo-tag-chip", { hasText: "#工作/设计" }).click();
  await expect(page.locator(".memo-entry")).toHaveCount(1);
  await latestCard.locator(".memo-tag-chip", { hasText: "#工作/设计" }).click();
  await expect(page.locator(".memo-entry")).toHaveCount(2);

  await latestCard.locator(".memo-body").click();
  const inlineMemoBox = latestCard.getByLabel("编辑闪念", { exact: true });
  const inlineMemoEditable = inlineMemoBox.locator('.block__editable[contenteditable="true"]').first();
  await expect(inlineMemoEditable).toBeFocused();
  await page.keyboard.type("误操作取消测试 ");
  await page.keyboard.press("Escape");
  await expect(inlineMemoBox).toHaveCount(0);
  await expect(latestCard).not.toContainText("误操作取消测试");
  await expect(latestCard).toContainText("最新闪念");

  await latestCard.locator(".memo-body").click();
  const inlineMemoBox2 = latestCard.getByLabel("编辑闪念", { exact: true });
  const inlineMemoEditable2 = inlineMemoBox2.locator('.block__editable[contenteditable="true"]').first();
  await expect(inlineMemoEditable2).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(" 点击即改");
  await page.locator(".memo-head__title").click();
  await expect(inlineMemoBox2).toHaveCount(0);
  await expect(latestCard).toContainText("点击即改");
  await expect(latestCard.locator("strong")).toContainText("粗体亮点");

  // Comment on older memo -> stays below newer memo, and comment body also supports click-to-edit + blur save.
  const olderCard = page.locator(".memo-entry").nth(1);
  await olderCard.hover();
  await olderCard.getByRole("button", { name: "批注", exact: true }).click();
  await olderCard.getByLabel("添加批注", { exact: true }).fill("老卡片的独有批注");
  await olderCard.locator(".memo-comment-composer").getByRole("button", { name: "发送", exact: true }).click();
  await expect(olderCard).toContainText("老卡片的独有批注");

  await olderCard.locator(".memo-comment-item__body").click();
  const inlineCommentBox = olderCard.getByLabel("编辑批注内容", { exact: true });
  const inlineCommentEditable = inlineCommentBox.locator('.block__editable[contenteditable="true"]').first();
  await expect(inlineCommentEditable).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type("关键词");
  await page.locator(".memo-head__title").click();
  await expect(inlineCommentBox).toHaveCount(0);
  await expect(olderCard).toContainText("老卡片的独有批注关键词");
  await expect(page.locator(".memo-entry").nth(0)).toContainText("最新闪念");
  await expect(page.locator(".memo-entry").nth(1)).toContainText("较早闪念");

  // Jump via Quick Find (⌘K) from Files view to comment hit -> switches to Memos & expands comments.
  await page.getByRole("navigation", { name: "HeiNote navigation", exact: true })
    .getByRole("tab", { name: "Files", exact: true }).click();
  // Memos stay excluded from normal Files tree and Graph view.
  await expect(page.getByRole("tree", { name: "Files", exact: true })).not.toContainText("最新闪念");
  await page.getByRole("navigation", { name: "HeiNote navigation", exact: true })
    .getByRole("tab", { name: "Graph", exact: true }).click();
  await expect(page.locator(".sidebar .graph")).not.toContainText("最新闪念");

  await page.locator(".rail__tab--search, button[aria-label='Search']").first().click();
  const qf = page.locator(".quickfind");
  await qf.getByLabel("Search pages", { exact: true }).fill("独有批注关键词");
  const commentHit = qf.locator('[role="option"]').filter({ hasText: "批注" }).first();
  await expect(commentHit).toBeVisible();
  await commentHit.click();
  await expect(qf).toBeHidden();
  await expect(page.getByRole("main", { name: "闪念卡片流", exact: true })).toBeVisible();
  await expect(page.locator(".memo-comment-item", { hasText: "老卡片的独有批注关键词" })).toBeVisible();

  // Promote older memo (with comment) to formal page -> preserves content & appends 批注记录.
  const promoteSource = page.locator(".memo-entry", { hasText: "较早闪念 咖啡豆实验" });
  await promoteSource.hover();
  await promoteSource.getByRole("button", { name: "转为正式页面", exact: true }).click();
  const promoteModal = page.getByRole("dialog", { name: "转为正式页面", exact: true });
  await promoteModal.getByRole("button", { name: "确认转正", exact: true }).click();
  await expect(page.getByLabel("Page title", { exact: true })).toHaveText(/较早闪念 咖啡豆实验/);
  await expect(page.getByRole("main")).toContainText("批注记录");
  await expect(page.getByRole("main")).toContainText("老卡片的独有批注关键词");

  // Back to Memos -> trash & restore remaining memo through Trash view.
  await memoRailTab(page).click();
  await expect(page.locator(".memo-entry")).toHaveCount(1);
  const lastCard = page.locator(".memo-entry").first();
  await lastCard.hover();
  await lastCard.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.locator(".memo-entry")).toHaveCount(0);

  await page.getByRole("navigation", { name: "HeiNote navigation", exact: true })
    .getByRole("tab", { name: "Trash", exact: true }).click();
  const trashedMemoRow = page.getByRole("listbox", { name: "Pages in the trash", exact: true }).getByRole("option", { name: /最新闪念/ });
  await expect(trashedMemoRow).toBeVisible();
  await trashedMemoRow.hover();
  await expect(page.getByRole("button", { name: /恢复闪念 .*最新闪念/ })).toBeVisible();
  await page.getByRole("button", { name: /恢复闪念 .*最新闪念/ }).click();
  await memoRailTab(page).click();
  await expect(page.locator(".memo-entry")).toHaveCount(1);

  // Create team KB -> switching into KB hides the Memos tab automatically.
  const kbRes = await page.request.post(`${server.url}/api/knowledge-bases`, {
    data: { requestId: crypto.randomUUID(), name: "研发知识库" },
    headers: { Origin: server.url },
  });
  expect(kbRes.status()).toBe(201);
  const kb = await kbRes.json();
  await page.reload();
  await page.getByRole("button", { name: "切换空间", exact: true }).click();
  await page.getByRole("menu", { name: "切换空间", exact: true }).getByRole("menuitem", { name: kb.name }).click();
  await expect(memoRailTab(page)).toHaveCount(0);
});

test("UC-64 mobile (390px): MobileDock memo pill & + focus with zero horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await register(page, "uc64_mobile");

  const dock = page.getByRole("navigation", { name: "移动端命令坞", exact: true });
  await expect(dock).toBeVisible();
  const memoBtn = dock.getByRole("button", { name: "Memos", exact: true });
  await expect(memoBtn).toBeVisible();

  await memoBtn.click();
  await expect(page.getByRole("main", { name: "闪念卡片流", exact: true })).toBeVisible();

  // Tapping + in Memos view focuses composer instead of opening New sheet.
  await dock.getByRole("button", { name: "新建", exact: true }).click();
  const composer = page.locator('.memo-composer .block__editable[contenteditable="true"]').first();
  await expect(composer).toBeFocused();
  await page.keyboard.type("手机随手记一条 #移动端");
  await page.locator(".memo-composer__foot").getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".memo-entry").first()).toContainText("手机随手记一条");

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
