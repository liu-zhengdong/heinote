import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";

let server: Awaited<ReturnType<typeof startServer>>;
let directory: string;
const password = "Math-browser-password-2026";

test.use({ colorScheme: "light", deviceScaleFactor: 2 });

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-uc65-math-"));
  server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1" });
});

test.afterAll(async () => {
  await server?.close();
  if (directory) {
    const target = resolve(directory);
    expect(dirname(target)).toBe(resolve(tmpdir()));
    expect(basename(target)).toMatch(/^notes-uc65-math-/);
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

test("UC-65: inline & block KaTeX equations, popover editing, currency safety, reload & public share", async ({ page, browser }) => {
  await register(page, "uc65_page");

  await page.getByRole("button", { name: "New page", exact: true }).first().click();
  await expect(page).toHaveURL(/page=/);
  const pageId = new URL(page.url()).searchParams.get("page")!;

  const firstEditable = page.locator('.block__editable[contenteditable="true"]').first();
  await firstEditable.click();
  await page.keyboard.type("能量 $E = mc^2$ 质能方程，价格 $50 到 $100");

  // Inline $...$ collapses into atomic equation mention & currency stays plain text.
  const inlineToken = page.locator('.mention[data-mention="equation"]').first();
  await expect(inlineToken).toHaveCount(1);
  await expect(inlineToken).toHaveAttribute("data-expression", "E = mc^2");
  await expect(firstEditable).toContainText("能量");
  await expect(firstEditable).toContainText("质能方程，价格 $50 到 $100");

  // Wait for lazy KaTeX Shadow DOM inside the inline token.
  await expect.poll(async () => (
    page.evaluate(() => {
      const el = document.querySelector('.mention[data-mention="equation"]');
      return Boolean(el?.shadowRoot?.querySelector(".katex"));
    })
  ), { timeout: 15000 }).toBe(true);

  // Click inline equation -> popover opens -> edit with live preview -> Enter saves.
  await inlineToken.click();
  const popover = page.locator(".equation-popover");
  await expect(popover).toBeVisible();
  const latexInput = popover.getByLabel("LaTeX 公式", { exact: true });
  await expect(latexInput).toBeFocused();
  await expect(latexInput).toHaveValue("E = mc^2");
  await latexInput.fill("E = \\gamma mc^2");
  await expect(popover.locator(".equation-popover__preview .katex")).toBeVisible();
  await latexInput.press("Enter");
  await expect(popover).toBeHidden();
  await expect(inlineToken).toHaveAttribute("data-expression", "E = \\gamma mc^2");

  // Block equation via $$ + Enter -> opens popover -> ⌘Enter commits.
  await firstEditable.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("$$");
  await page.keyboard.press("Enter");

  const blockEq = page.locator(".block__equation").first();
  await expect(blockEq).toBeVisible();
  await expect(popover).toBeVisible();
  await latexInput.fill("\\frac{1}{2}");
  await expect(popover.locator(".equation-popover__preview .katex-display")).toBeVisible();
  await latexInput.press("Meta+Enter");
  await expect(popover).toBeHidden();
  await expect(blockEq.locator(".katex-display")).toBeVisible();

  // Wait for persistence & reload page cleanly.
  await expect.poll(async () => {
    const rows = await (await page.request.get(`${server.url}/api/records/personal/blocks`)).json();
    const ofPage = rows.filter((r: { value: { page?: string } }) => r.value.page === pageId);
    return ofPage.some((r: { value: { kind?: string } }) => r.value.kind === "equation")
      && ofPage.some((r: { value: { content?: Array<{ embed?: { mention?: { expression?: string } } }> } }) =>
        r.value.content?.some((run) => run.embed?.mention?.expression === "E = \\gamma mc^2"));
  }, { timeout: 15000 }).toBe(true);

  await page.reload();
  await expect(page.locator('.mention[data-mention="equation"]').first()).toHaveAttribute("data-expression", "E = \\gamma mc^2");
  await expect(page.locator(".block__equation .katex-display").first()).toBeVisible({ timeout: 15000 });

  // Public share renders both inline and block KaTeX equations cleanly.
  const shareReply = await page.request.post(`${server.url}/api/shares`, { data: { pageId } });
  expect(shareReply.status()).toBe(201);
  const { url } = await shareReply.json() as { url: string };

  const guest = await browser.newContext();
  const reader = await guest.newPage();
  await reader.goto(`${server.url}${url}`);
  await expect(reader.locator(".public-reader__math-inline .katex").first()).toBeVisible({ timeout: 15000 });
  await expect(reader.locator(".public-reader__equation .katex-display").first()).toBeVisible({ timeout: 15000 });
  await expect(reader.locator(".public-reader__content")).toContainText("价格 $50 到 $100");
  await guest.close();
});

test("UC-65: Memos compose, render, and click-to-edit inline & block formulas", async ({ page }) => {
  await register(page, "uc65_memo");

  await page.getByRole("navigation", { name: "HeiNote navigation", exact: true })
    .getByRole("tablist", { name: "Page list", exact: true })
    .getByRole("tab", { name: "Memos", exact: true })
    .click();
  await expect(page.getByRole("main", { name: "闪念卡片流", exact: true })).toBeVisible();

  const composerEditable = page.locator('.memo-composer .block__editable[contenteditable="true"]').first();
  await composerEditable.click();
  await page.keyboard.type("勾股定理 $a^2 + b^2 = c^2$ #数学");
  await expect(page.locator('.memo-composer .mention[data-mention="equation"]').first()).toHaveAttribute("data-expression", "a^2 + b^2 = c^2");

  await page.keyboard.press("Enter");
  await page.keyboard.type("$$");
  await page.keyboard.press("Enter");
  const popover = page.locator(".equation-popover");
  await expect(popover).toBeVisible();
  await popover.getByLabel("LaTeX 公式", { exact: true }).fill("x = 42");
  await popover.getByLabel("LaTeX 公式", { exact: true }).press("Meta+Enter");
  await expect(popover).toBeHidden();

  await page.locator(".memo-composer__foot").getByRole("button", { name: "发送", exact: true }).click();
  const card = page.locator(".memo-entry").first();
  await expect(card).toContainText("勾股定理");
  await expect(card.locator(".memo-math-inline .katex").first()).toBeVisible({ timeout: 15000 });
  await expect(card.locator(".memo-math-block .katex-display").first()).toBeVisible({ timeout: 15000 });

  // Click card body -> inline editor preserves both inline and block equations and supports popover edit.
  await card.locator(".memo-body").click();
  const inlineBox = card.getByLabel("编辑闪念", { exact: true });
  await expect(inlineBox.locator('.mention[data-mention="equation"]').first()).toHaveAttribute("data-expression", "a^2 + b^2 = c^2");
  await expect(inlineBox.locator(".block__equation").first()).toBeVisible();

  // Clicking block equation inside memo opens popover; Escape closes only popover, not memo edit.
  await inlineBox.locator(".block__equation").first().click();
  await expect(popover).toBeVisible();
  await popover.getByLabel("LaTeX 公式", { exact: true }).press("Escape");
  await expect(popover).toBeHidden();
  await expect(inlineBox).toBeVisible();
});

test("UC-65: pasting single-line & multi-line Markdown with math renders KaTeX formulas immediately", async ({ page }) => {
  await register(page, "uc65_paste");

  await page.getByRole("button", { name: "New page", exact: true }).first().click();
  await expect(page).toHaveURL(/page=/);

  const pasteInto = async (selector: string, text: string) => {
    await page.locator(selector).first().evaluate((el, value) => {
      const data = new DataTransfer();
      data.setData("text/plain", value);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, text);
  };

  // 1. Single-line paste containing $...$ and \(...\) parses inline equations
  const firstEditable = page.locator('.block__editable[contenteditable="true"]').first();
  await firstEditable.click();
  await pasteInto('.block__editable[contenteditable="true"]', "粘贴行内 $E = mc^2$ 与 \\(a_1 + b_1\\) 公式");
  await expect(page.locator('.mention[data-mention="equation"]')).toHaveCount(2);
  await expect.poll(async () => (
    page.evaluate(() => {
      const tokens = [...document.querySelectorAll('.mention[data-mention="equation"]')];
      return tokens.length === 2 && tokens.every((el) => Boolean(el.shadowRoot?.querySelector(".katex")));
    })
  ), { timeout: 15000 }).toBe(true);

  // 2. Single-line $$...$$ display math pastes as an equation block
  await firstEditable.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await pasteInto('.block--text:last-of-type .block__editable[contenteditable="true"]', "$$\\sum_{i=1}^n i = \\frac{n(n+1)}{2}$$");
  await expect(page.locator(".block__equation .katex-display").first()).toBeVisible({ timeout: 15000 });

  // 3. Multi-line Markdown paste (inline math + multiline $$...$$ + \[...\]) in Memos composer
  await page.getByRole("navigation", { name: "HeiNote navigation", exact: true })
    .getByRole("tablist", { name: "Page list", exact: true })
    .getByRole("tab", { name: "Memos", exact: true })
    .click();
  await expect(page.getByRole("main", { name: "闪念卡片流", exact: true })).toBeVisible();

  const memoEditable = page.locator('.memo-composer .block__editable[contenteditable="true"]').first();
  await memoEditable.click();
  await pasteInto('.memo-composer .block__editable[contenteditable="true"]', [
    "粘贴笔记 $f(x) = x^2$ #数学",
    "",
    "$$ \\begin{aligned}",
    "y &= 2x",
    "\\end{aligned} $$",
    "",
    "\\[",
    "\\alpha + \\beta",
    "\\]",
  ].join("\n"));

  await expect(page.locator('.memo-composer .mention[data-mention="equation"]')).toHaveCount(1);
  await expect(page.locator(".memo-composer .block__equation")).toHaveCount(2);
  await page.locator(".memo-composer__foot").getByRole("button", { name: "发送", exact: true }).click();

  const card = page.locator(".memo-entry").first();
  await expect(card).toContainText("粘贴笔记");
  await expect(card.locator(".memo-math-inline .katex")).toHaveCount(1, { timeout: 15000 });
  await expect(card.locator(".memo-math-block .katex-display")).toHaveCount(2, { timeout: 15000 });
});
