import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";

let server: Awaited<ReturnType<typeof startServer>>;
let directory: string;
const password = "Table-test-password-2026";

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-table-browser-"));
  server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1" });
});
test.afterAll(async () => {
  await server?.close();
  if (directory) {
    const target = resolve(directory);
    expect(dirname(target)).toBe(resolve(tmpdir()));
    expect(basename(target)).toMatch(/^notes-table-browser-/);
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

async function makeTable(page: Page, handle: string) {
  await register(page, handle);
  await page.getByRole("button", { name: "New page", exact: true }).first().click();
  const paragraph = page.locator('.block__editable[contenteditable="true"]').first();
  await paragraph.click();
  await paragraph.pressSequentially("/table");
  await page.getByRole("option", { name: "Table", exact: true }).click();
  const table = page.locator(".stbl__table").first();
  await expect(table).toBeVisible();
  const cell = (row: number, column: number) =>
    table.locator(`td[data-row-index="${row}"][data-column-index="${column}"] .stbl__text`);
  const words = ["alpha one", "beta two", "gamma three", "delta four", "epsilon five", "zeta six"];
  let at = 0;
  for (let row = 0; row < 2; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      await cell(row, column).click();
      await page.keyboard.type(words[at]);
      at += 1;
    }
  }
  return { table, cell };
}

/* The DOM selection the browser paints mid-drag — the table's cell selection
   is its own tint, not a text range, so any non-empty text selection here is
   the browser's drag fighting ours. A recorder on `selectionchange` catches
   a selection that lives only a frame, which sampling between moves cannot. */
async function watchNativeSelection(page: Page) {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __seen: string[] }).__seen = seen;
    const record = () => {
      const selection = window.getSelection();
      if (selection && selection.rangeCount && selection.toString()) seen.push(selection.toString());
    };
    document.addEventListener("selectionchange", record);
  });
}
const paintedSelections = (page: Page) =>
  page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);

test("dragging across cells selects them without a flickering text selection", async ({ page }) => {
  const { table, cell } = await makeTable(page, "table_drag");
  await watchNativeSelection(page);
  const from = await cell(0, 0).boundingBox();
  const to = await cell(1, 1).boundingBox();
  expect(from && to).toBeTruthy();
  // Press in the cell's padding: the drag is a cell selection from its
  // first pixel, so no text selection may paint along the way.
  await page.mouse.move(from!.x + 4, from!.y + from!.height - 2);
  await page.mouse.down();
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(
      from!.x + 4 + (to!.x - from!.x) * (i / steps) + to!.width / 2,
      from!.y + from!.height - 2 + (to!.y - from!.y) * (i / steps) + to!.height / 2,
    );
  }
  // While the drag runs, the browser's text selection stays out of it.
  expect((await paintedSelections(page)).join("")).toBe("");
  await expect(table.locator("td.is-selected")).toHaveCount(4);
  await page.mouse.up();
  await expect(table.locator("td.is-selected")).toHaveCount(4);
  expect((await paintedSelections(page)).join("")).toBe("");
});

test("a drag on a cell's words selects them as text", async ({ page }) => {
  const { table, cell } = await makeTable(page, "table_words");
  const box = await cell(0, 0).boundingBox();
  const y = box!.y + box!.height / 2;
  await page.mouse.move(box!.x + 10, y);
  await page.mouse.down();
  await page.mouse.move(box!.x + 42, y, { steps: 4 });
  await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected.length).toBeGreaterThan(0);
  expect("alpha one").toContain(selected);
  // A text selection, not a cell selection.
  await expect(table.locator("td.is-selected")).toHaveCount(0);
});

test("a drag from a cell's padding selects the cell itself", async ({ page }) => {
  const { table, cell } = await makeTable(page, "table_pad");
  const box = await cell(0, 0).boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height - 2);
  await page.mouse.down();
  // A short drag that stays inside the cell still selects the cell: the
  // press began on the padding, not on the words.
  await page.mouse.move(box!.x + box!.width / 2 + 10, box!.y + box!.height - 2, { steps: 2 });
  await expect(table.locator("td.is-selected")).toHaveCount(1);
  await page.mouse.up();
  await expect(table.locator("td.is-selected")).toHaveCount(1);
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
});

test("a drag that leaves its starting cell clears the text selection", async ({ page }) => {
  const { table, cell } = await makeTable(page, "table_cross");
  const from = await cell(0, 0).boundingBox();
  const to = await cell(0, 1).boundingBox();
  const y = from!.y + from!.height / 2;
  await page.mouse.move(from!.x + 10, y);
  await page.mouse.down();
  // The first steps stay on the word: a text selection stands.
  await page.mouse.move(from!.x + 40, y, { steps: 4 });
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 4 });
  await expect(table.locator("td.is-selected")).toHaveCount(2);
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
});

test("double-clicking a word in a cell selects it as text", async ({ page }) => {
  const { cell } = await makeTable(page, "table_dblclick");
  const word = await cell(0, 0).boundingBox();
  await page.mouse.dblclick(word!.x + 8, word!.y + word!.height / 2);
  await expect.poll(async () => page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("alpha");
});

test("clicking a cell still takes the caret and typing lands there", async ({ page }) => {
  const { cell } = await makeTable(page, "table_click");
  await cell(1, 2).click();
  await expect(cell(1, 2)).toBeFocused();
  await page.keyboard.type("tail");
  await expect(cell(1, 2)).toHaveText("zeta sixtail");
});

test("a drag that grazes column borders keeps the cell selection", async ({ page }) => {
  const { table, cell } = await makeTable(page, "table_border");
  await watchNativeSelection(page);
  const from = await cell(0, 0).boundingBox();
  const to = await cell(0, 2).boundingBox();
  expect(from && to).toBeTruthy();
  // Walk the top edge of the row, right over the resize handles on each
  // column border.
  const y = from!.y + 2;
  await page.mouse.move(from!.x + 4, y);
  await page.mouse.down();
  for (let x = from!.x + 4; x <= to!.x + to!.width - 4; x += 6) {
    await page.mouse.move(x, y);
  }
  expect((await paintedSelections(page)).join("")).toBe("");
  await expect(table.locator("td.is-selected")).toHaveCount(3);
  await page.mouse.up();
});

/** Drag a cell selection from one corner cell to another. */
async function dragCells(page: Page, from: ReturnType<Page["locator"]>, to: ReturnType<Page["locator"]>) {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  expect(a && b).toBeTruthy();
  await page.mouse.move(a!.x + a!.width / 2, a!.y + a!.height / 2);
  await page.mouse.down();
  await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2, { steps: 6 });
  await page.mouse.up();
}

test("cells merge into one through the toolbar and split back", async ({ page }) => {
  const { table, cell } = await makeTable(page, "table_merge");
  await dragCells(page, cell(0, 0), cell(1, 1));
  await expect(table.locator("td.is-selected")).toHaveCount(4);
  // The floating toolbar carries Merge over the selection.
  const merge = page.getByRole("button", { name: "Merge cells", exact: true });
  await expect(merge).toBeVisible();
  await merge.click();
  // Six cells become three drawn cells; the anchor carries every word.
  await expect(table.locator("td")).toHaveCount(3);
  const anchor = table.locator("td[data-row-index='0'][data-column-index='0']");
  await expect(anchor).toHaveAttribute("colspan", "2");
  await expect(anchor).toHaveAttribute("rowspan", "2");
  await expect(anchor.locator(".stbl__text")).toHaveText("alpha one\nbeta two\ndelta four\nepsilon five");
  // Split brings the rectangle back — the words stay in the anchor.
  await dragCells(page, anchor.locator(".stbl__text"), anchor.locator(".stbl__text"));
  const split = page.getByRole("button", { name: "Split cells", exact: true });
  await expect(split).toBeVisible();
  await split.click();
  await expect(table.locator("td")).toHaveCount(6);
  await expect(cell(0, 0)).toHaveText("alpha one\nbeta two\ndelta four\nepsilon five");
  await expect(cell(1, 1)).toHaveText("");
});

test("a right-press on cells offers Merge and Split in a menu", async ({ page }) => {
  const { table, cell } = await makeTable(page, "table_menu");
  await dragCells(page, cell(0, 0), cell(0, 1));
  const over = await cell(0, 0).boundingBox();
  await page.mouse.click(over!.x + over!.width / 2, over!.y + over!.height / 2, { button: "right" });
  const item = page.getByRole("menuitem", { name: /Merge 2×1 cells/ });
  await expect(item).toBeVisible();
  await item.click();
  await expect(table.locator("td")).toHaveCount(5);
  await expect(table.locator("td[data-row-index='0'][data-column-index='0']")).toHaveAttribute("colspan", "2");
});

test("the cell toolbar paints a text colour over the selection", async ({ page }) => {
  const { table, cell } = await makeTable(page, "table_color");
  await dragCells(page, cell(0, 0), cell(0, 1));
  await page.getByRole("button", { name: "Text color", exact: true }).click();
  await page.getByRole("menuitem", { name: "Red", exact: true }).click();
  const text = cell(0, 0).locator("[data-color='red']");
  await expect(text).toHaveCount(1);
  // The colour must reach the painted text, in either theme — a cell's
  // words live outside .block__editable, which is where the rule once ended.
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    const painted = await text.evaluate((el) => getComputedStyle(el).color);
    const ink = await cell(1, 2).evaluate((el) => getComputedStyle(el).color);
    expect(painted, `${theme}: the coloured run should differ from plain cell text`).not.toBe(ink);
  }
  await expect(text).toHaveText("alpha one");
});

test("the alignment picker centers and lowers a cell's words", async ({ page }) => {
  const { table, cell } = await makeTable(page, "table_align");
  await dragCells(page, cell(0, 0), cell(1, 1));
  await page.getByRole("button", { name: "Cell alignment", exact: true }).click();
  await page.getByRole("radio", { name: "middle center", exact: true }).click();
  const first = table.locator("td[data-row-index='0'][data-column-index='0']");
  await expect(first).toHaveCSS("text-align", "center");
  await expect(first).toHaveCSS("vertical-align", "middle");
  // The whole selection took it; a neighbour the drag left out did not.
  await expect(table.locator("td[data-row-index='1'][data-column-index='1']")).toHaveCSS("text-align", "center");
  await expect(table.locator("td[data-row-index='0'][data-column-index='2']")).not.toHaveCSS("text-align", "center");
});

test("a row added inside a merge stretches it; deleting its anchor row lets it go", async ({ page }) => {
  const { table, cell } = await makeTable(page, "table_spans_grow");
  // Merge the 2×2 at the top-left.
  await dragCells(page, cell(0, 0), cell(1, 1));
  await page.getByRole("button", { name: "Merge cells", exact: true }).click();
  const anchor = table.locator("td[data-row-index='0'][data-column-index='0']");
  await expect(anchor).toHaveAttribute("rowspan", "2");
  // Insert a row *inside* the span (below row 0) — the merge grows over it.
  await cell(0, 2).hover();
  await page.getByRole("button", { name: "Row 1 options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Insert below", exact: true }).click();
  await expect(anchor).toHaveAttribute("rowspan", "3");
  // Delete the anchor's row — the merge lets go entirely.
  await cell(0, 2).hover();
  await page.getByRole("button", { name: "Row 1 options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await expect(table.locator("td[rowspan]")).toHaveCount(0);
  await expect(table.locator("td[colspan]")).toHaveCount(0);
});
