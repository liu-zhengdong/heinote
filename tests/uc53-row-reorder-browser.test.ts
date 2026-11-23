import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";

/* UC-53 browser acceptance: an agent builds a database over the HTTP API,
   then a user drags its rows into order — in the table, across a grouped
   table's groups, and between a board's cards — steps them by keyboard, and
   sees the grips rest while a sort or a search holds the order. */
let server: Awaited<ReturnType<typeof startServer>>;
let directory: string;
const password = "UC-53-row-reorder-password-2026!";
const evidence = resolve(".evidence/uc53-row-reorder");

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-uc53-row-reorder-"));
  server = await startServer({ dataDir: directory, host: "127.0.0.1", port: 0 });
});
test.afterAll(async () => {
  await server?.close();
  if (directory) {
    const target = resolve(directory);
    expect(dirname(target)).toBe(resolve(tmpdir()));
    expect(basename(target)).toMatch(/^notes-uc53-row-reorder-/);
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
async function createToken(page: Page, name: string) {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "Agent 令牌", exact: true }).click();
  await page.getByRole("button", { name: "新建令牌", exact: true }).click();
  await page.locator('input[name="tokenName"]').fill(name);
  await page.getByRole("radio", { name: "读写", exact: true }).click();
  await page.getByRole("button", { name: "创建", exact: true }).click();
  const value = await page.getByLabel("令牌", { exact: true }).inputValue();
  await page.getByRole("button", { name: "已保存", exact: true }).click();
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  return value;
}
async function agent(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${server.url}${path}`, {
    method,
    headers: { "authorization": `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
/** Every write needs the database's current revision — read it fresh. */
async function dbRevision(token: string, databaseId: string): Promise<string> {
  const response = await agent(token, "GET", `/api/v1/databases/${databaseId}`);
  expect(response.status).toBe(200);
  return response.body.revision;
}
/** The rows' titles in the order the API's query answers them — the view's
 *  own order, the `row_order` a drag writes. */
async function rowOrder(token: string, databaseId: string): Promise<string[]> {
  const response = await agent(token, "POST", `/api/v1/databases/${databaseId}/query`, {});
  expect(response.status).toBe(200);
  return response.body.rows.map((row: { title: string }) => row.title);
}
async function rowValues(token: string, databaseId: string, rowId: string): Promise<Record<string, string>> {
  const response = await agent(token, "POST", `/api/v1/databases/${databaseId}/query`, {});
  expect(response.status).toBe(200);
  return response.body.rows.find((row: { id: string }) => row.id === rowId)?.values ?? {};
}

/** A table row's visible order, by the title cell's words. */
function tableOrder(page: Page) {
  return page.locator("table.db__table tbody tr[data-page-id] .db__row-title").evaluateAll(
    (cells) => cells.map((cell) => cell.textContent?.trim() || "Untitled"));
}
function rowOf(page: Page, title: string): Locator {
  return page.locator("table.db__table tbody tr[data-page-id]").filter({ has: page.locator(".db__row-title", { hasText: title }) }).first();
}
/** An HTML5 drag from a row's grip onto a target row's upper or lower half,
 *  dropped there — the same synthetic DataTransfer the column drag uses. */
async function dragRow(page: Page, source: Locator, target: Locator, upper: boolean) {
  const grip = source.locator(".row-grip");
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await grip.dispatchEvent("dragstart", { dataTransfer: transfer });
  await target.dispatchEvent("dragover", { dataTransfer: transfer, clientY: box!.y + box!.height * (upper ? 0.2 : 0.8) });
  await target.dispatchEvent("drop", { dataTransfer: transfer });
  await grip.dispatchEvent("dragend", { dataTransfer: transfer });
}
/** A board card dragged onto another card's upper or lower half — or onto
 *  a column's open space, landing last in it. The card may have moved by
 *  the time dragend lands, so it is dispatched on its new element. */
async function dragCard(page: Page, sourceId: string, target: Locator, upper?: boolean) {
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  const source = () => page.locator(`.board__card[data-page-id="${sourceId}"]`);
  await source().dispatchEvent("dragstart", { dataTransfer: transfer });
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  await target.dispatchEvent("dragover", { dataTransfer: transfer, ...(upper === undefined ? {} : { clientY: box!.y + box!.height * (upper ? 0.2 : 0.8) }) });
  await target.dispatchEvent("drop", { dataTransfer: transfer });
  await source().dispatchEvent("dragend", { dataTransfer: transfer });
}
async function shot(page: Page, path: string, locator = page.locator("main").first()) {
  await page.evaluate(async () => { await document.fonts.ready; });
  await locator.screenshot({ path, animations: "disabled" });
}

test("rows reorder by drag and keyboard, rest under sorts and search", async ({ page }) => {
  await mkdir(evidence, { recursive: true });
  await register(page, "uc53-tester");
  const token = await createToken(page, "UC-53 验收");

  const created = await agent(token, "POST", "/api/v1/databases", {
    requestId: "uc53-tasks",
    title: "任务",
    database: {
      properties: [
        { id: "prop_status", name: "状态", type: "status", status_options: [
          { id: "s_todo", name: "待办", color: "default", group: "todo" },
          { id: "s_doing", name: "进行中", color: "blue", group: "progress" },
          { id: "s_done", name: "已完成", color: "green", group: "complete" },
        ] },
        { id: "prop_pri", name: "优先级", type: "select", options: ["P1", "P2", "P3"] },
        { id: "prop_num", name: "估点", type: "number" },
      ],
      views: [
        { id: "view_table", name: "表格", kind: "table" },
        { id: "view_board", name: "看板", kind: "board", group_by: "prop_status" },
      ],
    },
  });
  expect(created.status).toBe(201);
  const databaseId = created.body.id;
  const rowIds: Record<string, string> = {};
  /* Omega has no priority — the no-value group needs a row to draw. A
     status always shows its default, so the grouping tests use a select. */
  for (const [index, [title, status, pri, num]] of ([
    ["Alpha", "待办", "P1", "1"], ["Beta", "待办", "P1", "2"], ["Gamma", "进行中", "P2", "3"], ["Delta", "进行中", "P2", "4"], ["Omega", "已完成", "", "5"],
  ] as const).entries()) {
    const made = await agent(token, "POST", `/api/v1/databases/${databaseId}/rows`, {
      requestId: `uc53-r${index}`,
      baseRevision: await dbRevision(token, databaseId),
      title,
      properties: { prop_status: status, prop_num: num, ...(pri ? { prop_pri: pri } : {}) },
    });
    expect(made.status).toBe(201);
    rowIds[title] = made.body.id;
  }

  await page.locator(".tree-row__main").filter({ hasText: "任务" }).first().click();
  await expect(page.locator("table.db__table")).toBeVisible();
  expect(await tableOrder(page)).toEqual(["Alpha", "Beta", "Gamma", "Delta", "Omega"]);

  /* ── A dragged row lands where the line was drawn ──────────────────── */
  await rowOf(page, "Omega").hover();
  await dragRow(page, rowOf(page, "Omega"), rowOf(page, "Alpha"), true);
  expect(await tableOrder(page)).toEqual(["Omega", "Alpha", "Beta", "Gamma", "Delta"]);
  await dragRow(page, rowOf(page, "Beta"), rowOf(page, "Delta"), false);
  expect(await tableOrder(page)).toEqual(["Omega", "Alpha", "Gamma", "Delta", "Beta"]);
  await shot(page, join(evidence, "uc53-table-reordered@2x.png"));

  /* ── A focused grip steps its row with the arrow keys ───────────────── */
  const gammaGrip = rowOf(page, "Gamma").locator(".row-grip");
  await gammaGrip.focus();
  await page.keyboard.press("ArrowUp");
  expect(await tableOrder(page)).toEqual(["Omega", "Gamma", "Alpha", "Delta", "Beta"]);
  await page.keyboard.press("ArrowDown");
  expect(await tableOrder(page)).toEqual(["Omega", "Alpha", "Gamma", "Delta", "Beta"]);

  /* ── A sort overrules the manual order: the grips rest, the stored
        order keeps what the drags wrote ──────────────────────────────── */
  const sorted = await agent(token, "PATCH", `/api/v1/databases/${databaseId}/views/view_table`, {
    requestId: "uc53-sort",
    baseRevision: await dbRevision(token, databaseId),
    view: { sorts: [{ property_id: "prop_num", direction: "asc" }] },
  });
  expect(sorted.status).toBe(200);
  await expect(rowOf(page, "Alpha").locator(".row-grip")).toHaveCount(0);
  expect(await tableOrder(page)).toEqual(["Alpha", "Beta", "Gamma", "Delta", "Omega"]);
  /* Sorted rows cannot be a drop's boundary either. */
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await page.locator("table.db__table tbody tr[data-page-id]").first().dispatchEvent("dragover", { dataTransfer: transfer });
  await expect(page.locator("table.db__table tr.is-rdrop-before, table.db__table tr.is-rdrop-after")).toHaveCount(0);

  const unsorted = await agent(token, "PATCH", `/api/v1/databases/${databaseId}/views/view_table`, {
    requestId: "uc53-unsort",
    baseRevision: await dbRevision(token, databaseId),
    view: { sorts: [] },
  });
  expect(unsorted.status).toBe(200);
  await expect(rowOf(page, "Alpha").locator(".row-grip")).toHaveCount(1);
  expect(await tableOrder(page)).toEqual(["Omega", "Alpha", "Gamma", "Delta", "Beta"]);

  /* ── A search hides part of the sequence — the grips rest ───────────── */
  await page.getByRole("button", { name: "Search this database" }).click();
  await page.locator(".db__search").fill("Alpha");
  await expect(rowOf(page, "Alpha").locator(".row-grip")).toHaveCount(0);
  await page.locator(".db__search").fill("");
  await page.keyboard.press("Escape");

  /* ── Grouped, a drop across a group's line reseeds the row ──────────── */
  const grouped = await agent(token, "PATCH", `/api/v1/databases/${databaseId}/views/view_table`, {
    requestId: "uc53-group",
    baseRevision: await dbRevision(token, databaseId),
    view: { group_by: "prop_pri" },
  });
  expect(grouped.status).toBe(200);
  /* P1、P2、P3 stay even empty; No 优先级 exists for Omega — and only
     while Omega is in it, so its drop comes first. */
  await expect(page.locator("tr.grp-row")).toHaveCount(4);

  /* A drop on the no-value group's header lands the row after its last —
     Omega — and clears the property. In the flat order it sits right after
     Omega; the groups are what move it to the table's end. */
  const noValueHead = page.locator("tr.grp-row").filter({ hasText: "No 优先级" });
  await expect(noValueHead).toBeVisible();
  await dragRow(page, rowOf(page, "Alpha"), noValueHead, false);
  expect((await rowValues(token, databaseId, rowIds["Alpha"]))["prop_pri"] ?? "").toBe("");
  expect(await rowOrder(token, databaseId)).toEqual(["Omega", "Alpha", "Gamma", "Delta", "Beta"]);
  expect(await tableOrder(page)).toEqual(["Beta", "Gamma", "Delta", "Omega", "Alpha"]);

  /* Omega (no value) onto Gamma's upper half lands before it, in P2 —
     order and group value in one write. */
  await dragRow(page, rowOf(page, "Omega"), rowOf(page, "Gamma"), true);
  expect(await rowOrder(token, databaseId)).toEqual(["Alpha", "Omega", "Gamma", "Delta", "Beta"]);
  expect(await tableOrder(page)).toEqual(["Beta", "Omega", "Gamma", "Delta", "Alpha"]);
  expect((await rowValues(token, databaseId, rowIds["Omega"]))["prop_pri"]).toBe("P2");

  /* An empty option group still draws its header: Delta onto P3's lands
     last of the whole view, reseeded. */
  const p3Head = page.locator("tr.grp-row").filter({ hasText: "P3" });
  await expect(p3Head).toBeVisible();
  await dragRow(page, rowOf(page, "Delta"), p3Head, false);
  expect((await rowValues(token, databaseId, rowIds["Delta"]))["prop_pri"]).toBe("P3");
  expect(await rowOrder(token, databaseId)).toEqual(["Alpha", "Omega", "Gamma", "Beta", "Delta"]);
  expect(await tableOrder(page)).toEqual(["Beta", "Omega", "Gamma", "Delta", "Alpha"]);
  await shot(page, join(evidence, "uc53-grouped-drop@2x.png"));

  const ungrouped = await agent(token, "PATCH", `/api/v1/databases/${databaseId}/views/view_table`, {
    requestId: "uc53-ungroup",
    baseRevision: await dbRevision(token, databaseId),
    view: { group_by: "" },
  });
  expect(ungrouped.status).toBe(200);

  /* ── The order is the database's: a reload draws it again ───────────── */
  await page.reload();
  await page.locator(".tree-row__main").filter({ hasText: "任务" }).first().click();
  await expect(page.locator("table.db__table")).toBeVisible();
  await expect.poll(() => tableOrder(page)).toEqual(["Alpha", "Omega", "Gamma", "Beta", "Delta"]);
});

test("board drops between cards order the column", async ({ page }) => {
  await register(page, "uc53-board");
  const token = await createToken(page, "UC-53 看板");

  const created = await agent(token, "POST", "/api/v1/databases", {
    requestId: "uc53-board",
    title: "看板库",
    database: {
      properties: [
        { id: "prop_status", name: "状态", type: "status", status_options: [
          { id: "s_todo", name: "待办", color: "default", group: "todo" },
          { id: "s_done", name: "已完成", color: "green", group: "complete" },
        ] },
      ],
      views: [{ id: "view_board", name: "看板", kind: "board", group_by: "prop_status" }],
    },
  });
  expect(created.status).toBe(201);
  const databaseId = created.body.id;
  const rowIds: Record<string, string> = {};
  for (const [index, [title, status]] of ([["一", "待办"], ["二", "待办"], ["三", "待办"], ["完", "已完成"]] as const).entries()) {
    const made = await agent(token, "POST", `/api/v1/databases/${databaseId}/rows`, {
      requestId: `uc53-b${index}`,
      baseRevision: await dbRevision(token, databaseId),
      title,
      properties: { prop_status: status },
    });
    expect(made.status).toBe(201);
    rowIds[title] = made.body.id;
  }

  await page.locator(".tree-row__main").filter({ hasText: "看板库" }).first().click();
  const todo = page.locator(".board__column").filter({ hasText: "待办" });
  await expect(todo.locator(".board__card")).toHaveCount(3);

  /** The cards' titles in one column, top to bottom. */
  const columnOrder = (column: Locator) => column.locator(".board__card .card-open__name").evaluateAll(
    (names) => names.map((name) => name.textContent?.trim() || "Untitled"));

  /* 三 onto 一's upper half lands first in the column — order and column
     value both written. */
  await dragCard(page, rowIds["三"], todo.locator(".board__card").filter({ hasText: "一" }), true);
  expect(await columnOrder(todo)).toEqual(["三", "一", "二"]);

  /* 一 onto the 已完成 column's open space lands last there, its status
     reseeded. */
  const done = page.locator(".board__column").filter({ hasText: "已完成" });
  await dragCard(page, rowIds["一"], done);
  expect(await columnOrder(done)).toEqual(["完", "一"]);
  expect(await rowOrder(token, databaseId)).toEqual(["三", "二", "完", "一"]);
  await shot(page, join(evidence, "uc53-board-reordered@2x.png"));
});
