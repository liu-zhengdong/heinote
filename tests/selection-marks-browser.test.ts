import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";

let server: Awaited<ReturnType<typeof startServer>>;
let directory: string;
const password = "Selection-marks-password-2026";

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-selection-marks-"));
  server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1" });
});
test.afterAll(async () => {
  await server?.close();
  if (directory) {
    const target = resolve(directory);
    expect(dirname(target)).toBe(resolve(tmpdir()));
    expect(basename(target)).toMatch(/^notes-selection-marks-/);
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

async function openPage(page: Page, handle: string, title: string) {
  await register(page, handle);
  await page.getByRole("button", { name: "New page", exact: true }).first().click();
  const titleField = page.getByRole("textbox", { name: "Page title", exact: true });
  await titleField.fill(title);
}

/** A DOM selection over a plain-text span of one editable. */
const selectIn = (editable: Locator, start: number, end: number) =>
  editable.evaluate((element, { start, end }) => {
    const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let at = 0;
    let started = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0;
      if (!started && start <= at + length) { range.setStart(node, start - at); started = true; }
      if (end <= at + length) { range.setEnd(node, end - at); break; }
      at += length;
    }
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { start, end });

/** A DOM selection from inside `from` to inside `to` — across the two blocks. */
const selectBetween = async (page: Page, from: Locator, fromOffset: number, to: Locator, toOffset: number) => {
  const fromHandle = await from.elementHandle();
  const toHandle = await to.elementHandle();
  await page.evaluate(([a, offA, b, offB]) => {
    const position = (element: Element, wanted: number) => {
      const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let at = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const length = node.textContent?.length ?? 0;
        if (wanted <= at + length) return { node, offset: wanted - at };
        at += length;
      }
      return { node: element, offset: 0 };
    };
    const range = document.createRange();
    const start = position(a as Element, offA);
    const end = position(b as Element, offB);
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [fromHandle, fromOffset, toHandle, toOffset]);
};

test("typing a delimiter over selected words applies and toggles the mark", async ({ page }) => {
  await openPage(page, "selmarks", "Marks");
  const paragraph = page.locator('.block__editable[contenteditable="true"]').first();
  await paragraph.click();
  await paragraph.pressSequentially("hello world here");

  // ` over "world" → inline code, no bracket left behind.
  await selectIn(paragraph, 6, 11);
  await page.keyboard.type("`");
  await expect(paragraph.locator("code")).toHaveText("world");
  await expect(paragraph).toHaveText("hello world here");

  // The selection stays: typing ` again takes the mark off (AC-04 + AC-01's
  // no-residue check in one).
  await page.keyboard.type("`");
  await expect(paragraph.locator("code")).toHaveCount(0);
  await expect(paragraph).toHaveText("hello world here");
});

test("the IME-committed delimiters ·, ＊, ～ mark the selection too", async ({ page }) => {
  await openPage(page, "selmarks-ime", "Marks IME");
  const paragraph = page.locator('.block__editable[contenteditable="true"]').first();
  await paragraph.click();
  await paragraph.pressSequentially("one two three four");

  // A Chinese keyboard's `·` reaches the page as beforeinput insertText, not
  // a keydown — insertText models exactly that path.
  await selectIn(paragraph, 0, 3);
  await page.keyboard.insertText("·");
  await expect(paragraph.locator("code")).toHaveText("one");

  await selectIn(paragraph, 4, 7);
  await page.keyboard.insertText("＊");
  await expect(paragraph.locator("em")).toHaveText("two");

  await selectIn(paragraph, 8, 13);
  await page.keyboard.insertText("～");
  await expect(paragraph.locator("s")).toHaveText("three");
  await expect(paragraph).toHaveText("one two three four");
});

test("a delimiter marks a selection spanning blocks", async ({ page }) => {
  await openPage(page, "selmarks-cross", "Marks Across");
  const first = page.locator('.block__editable[contenteditable="true"]').first();
  await first.click();
  await first.pressSequentially("first line of text");
  await page.keyboard.press("Enter");
  const blocks = page.locator('.block__editable[contenteditable="true"]');
  const second = blocks.nth(1);
  await expect(second).toHaveCount(1);
  await second.pressSequentially("second line of text");

  await selectBetween(page, first, 6, second, 6);
  await page.keyboard.type("~");
  await expect(first.locator("s")).toHaveText("line of text");
  await expect(second.locator("s")).toHaveText("second");
  await expect(first).toHaveText("first line of text");
  await expect(second).toHaveText("second line of text");
});

test("an unmapped character still replaces the selection, and a code block keeps typing plain", async ({ page }) => {
  await openPage(page, "selmarks-plain", "Marks Plain");
  const paragraph = page.locator('.block__editable[contenteditable="true"]').first();
  await paragraph.click();
  await paragraph.pressSequentially("hello world");
  await selectIn(paragraph, 6, 11);
  await page.keyboard.type("x");
  await expect(paragraph).toHaveText("hello x");

  // A ` inside a code block is a backtick, not a mark.
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  const blocks = page.locator('.block__editable[contenteditable="true"]');
  const codeLine = blocks.nth(1);
  await codeLine.pressSequentially("``` ");
  const code = page.locator(".block--code").first();
  const editable = code.locator('.block__editable[contenteditable="true"]');
  await editable.pressSequentially("plain code");
  await selectIn(editable, 0, 5);
  await page.keyboard.type("`");
  await expect(editable).toHaveText("` code");
  await expect(editable.locator("code")).toHaveCount(0);
});

test("⌘Z undoes the mark in one step", async ({ page }) => {
  await openPage(page, "selmarks-undo", "Marks Undo");
  const paragraph = page.locator('.block__editable[contenteditable="true"]').first();
  await paragraph.click();
  await paragraph.pressSequentially("undo me please");
  await selectIn(paragraph, 0, 7);
  await page.keyboard.type("`");
  await expect(paragraph.locator("code")).toHaveText("undo me");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(paragraph.locator("code")).toHaveCount(0);
  await expect(paragraph).toHaveText("undo me please");
});

test("a selected cell in a simple table marks like a paragraph", async ({ page }) => {
  await openPage(page, "selmarks-cell", "Marks Cell");
  const paragraph = page.locator('.block__editable[contenteditable="true"]').first();
  await paragraph.click();
  await paragraph.pressSequentially("/table");
  await page.getByRole("option", { name: "Table", exact: true }).click();
  const table = page.locator(".stbl__table").first();
  await expect(table).toBeVisible();
  const cell = table.locator('td[data-row-index="0"][data-column-index="0"] .stbl__text');
  await cell.click();
  await page.keyboard.type("cell words");
  await selectIn(cell, 0, 4);
  await page.keyboard.type("`");
  await expect(cell.locator("code")).toHaveText("cell");

  // The input-method path works in a cell too.
  await selectIn(cell, 5, 10);
  await page.keyboard.insertText("·");
  await expect(cell.locator("code")).toHaveCount(2);
});

test("[ and 【 turn selected words into a [[ page-mention query", async ({ page }) => {
  await register(page, "selmarks-link");
  // The link's target made through the API — one browser page stays the one
  // written in.
  const created = await page.request.post(`${server.url}/api/v1/pages`, { data: { title: "link target" } });
  expect(created.status()).toBe(201);
  await page.getByRole("button", { name: "New page", exact: true }).first().click();
  const paragraph = page.locator('.block__editable[contenteditable="true"]').first();
  await paragraph.click();
  await paragraph.pressSequentially("see link target please");

  await selectIn(paragraph, 4, 15);
  await page.keyboard.type("[");
  const menu = page.locator(".mention-menu");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Enter");
  // `[[link target` becomes the page's mention in place — its label rides on
  // `data-label`; the span's own text is the invisible separator.
  const mention = paragraph.locator(".mention");
  await expect(mention).toHaveAttribute("data-label", "link target");
  await expect(paragraph).toContainText("see ⁣ please");

  // 【 over new words: Escape leaves the literal [[ behind, like Obsidian.
  await secondLine(page);
  const blocks = page.locator('.block__editable[contenteditable="true"]');
  const second = blocks.nth(1);
  await second.click();
  await second.pressSequentially("more words here");
  await selectIn(second, 0, 4);
  await page.keyboard.insertText("【");
  await expect(page.locator(".mention-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".mention-menu")).toHaveCount(0);
  await expect(second).toHaveText("[[more words here");
});

async function secondLine(page: Page) {
  await page.keyboard.press("Escape");
  const first = page.locator('.block__editable[contenteditable="true"]').first();
  await first.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
}

test("[ over a selection spanning blocks just replaces it", async ({ page }) => {
  await openPage(page, "selmarks-linkcross", "Link Across");
  const first = page.locator('.block__editable[contenteditable="true"]').first();
  await first.click();
  await first.pressSequentially("first part");
  await page.keyboard.press("Enter");
  const blocks = page.locator('.block__editable[contenteditable="true"]');
  const second = blocks.nth(1);
  await second.pressSequentially("second part");
  await selectBetween(page, first, 6, second, 6);
  await page.keyboard.type("[");
  // A plain replace: the bracket stands for everything selected and the two
  // blocks' remainders merge, as any typed character would have it.
  await expect(first).toHaveText("first [ part");
  await expect(page.locator(".mention-menu")).toHaveCount(0);
});
