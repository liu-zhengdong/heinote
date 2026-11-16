import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";

/* UC-44 browser acceptance: an agent builds a database over the HTTP API,
   then the Columns panel reorders it — by drag and by keyboard — and the
   new order holds after a reload, in the table and in the stored record. */
let server: Awaited<ReturnType<typeof startServer>>;
let directory: string;
const password = "UC-44-columns-reorder-password-2026!";
const evidence = resolve(".evidence/uc44-columns-reorder");

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-uc44-columns-reorder-"));
  server = await startServer({ dataDir: directory, host: "127.0.0.1", port: 0 });
});
test.afterAll(async () => {
  await server?.close();
  if (directory) {
    const target = resolve(directory);
    expect(dirname(target)).toBe(resolve(tmpdir()));
    expect(basename(target)).toMatch(/^notes-uc44-columns-reorder-/);
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
async function propertyOrder(token: string, databaseId: string): Promise<string[]> {
  const response = await agent(token, "GET", `/api/v1/databases/${databaseId}`);
  expect(response.status).toBe(200);
  return response.body.page.database.properties.map((property: { id: string }) => property.id);
}

function columnsPanel(page: Page) { return page.locator(".cols-panel"); }
async function openColumns(page: Page) {
  await page.getByRole("button", { name: /Columns|\d+ columns hidden/ }).click();
  await expect(columnsPanel(page)).toBeVisible();
}
/** The column heads the table draws, as `data-column` ids, name first. */
function headOrder(page: Page) {
  return page.locator("table.db__table thead th[data-column]").evaluateAll(
    (heads) => heads.map((head) => (head as HTMLElement).dataset.column));
}
/** The panel's property rows in order — the locked name row carries no id. */
function panelOrder(page: Page) {
  return columnsPanel(page).locator(".cols-panel__row[data-column]").evaluateAll(
    (rows) => rows.map((row) => (row as HTMLElement).dataset.column));
}
function rowOf(page: Page, propertyId: string): Locator {
  return columnsPanel(page).locator(`.cols-panel__row[data-column="${propertyId}"]`);
}
/** An HTML5 drag from a column's grip onto a target row's upper or lower
 *  half, dropped there. The drop lands on the row's group; a row that is
 *  not a drop group's takes no drop at all. */
async function dragColumn(page: Page, sourceId: string, target: Locator, upper: boolean) {
  const grip = rowOf(page, sourceId).locator(".cols-panel__grip");
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await grip.dispatchEvent("dragstart", { dataTransfer: transfer });
  await target.dispatchEvent("dragover", { dataTransfer: transfer, clientY: box!.y + box!.height * (upper ? 0.2 : 0.8) });
  await target.dispatchEvent("drop", { dataTransfer: transfer });
  await grip.dispatchEvent("dragend", { dataTransfer: transfer });
}
/** A table head pulled by its name onto the left or right half of another
 *  head — the panel's drag, started from the header itself. */
async function dragColumnHead(page: Page, sourceId: string, targetId: string, left: boolean) {
  const head = page.locator(`table.db__table thead th[data-column="${sourceId}"]`);
  const target = page.locator(`table.db__table thead th[data-column="${targetId}"]`);
  const button = head.getByRole("button");
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await button.dispatchEvent("dragstart", { dataTransfer: transfer });
  await target.dispatchEvent("dragover", { dataTransfer: transfer, clientX: box!.x + box!.width * (left ? 0.25 : 0.75) });
  await target.dispatchEvent("drop", { dataTransfer: transfer });
  await button.dispatchEvent("dragend", { dataTransfer: transfer });
}
async function shot(page: Page, path: string, locator = page.locator("main").first()) {
  await page.evaluate(async () => { await document.fonts.ready; });
  await locator.screenshot({ path, animations: "disabled" });
}

test("columns panel reorders a database's columns", async ({ page }) => {
  await mkdir(evidence, { recursive: true });
  await register(page, "uc44-tester");
  const token = await createToken(page, "UC-44 验收");

  const created = await agent(token, "POST", "/api/v1/databases", {
    requestId: "uc44-tasks",
    title: "任务",
    database: {
      properties: [
        { id: "prop_num", name: "估点", type: "number" },
        { id: "prop_done", name: "完成", type: "checkbox" },
        { id: "prop_url", name: "链接", type: "url" },
        { id: "prop_due", name: "窗口", type: "date" },
        { id: "prop_created", name: "创建于", type: "created_time" },
        { id: "prop_id", name: "标识", type: "id" },
      ],
      views: [{ id: "view_all", name: "全部", kind: "table", hidden: ["prop_url"], calcs: { prop_num: "sum" } }],
    },
  });
  expect(created.status).toBe(201);
  const databaseId = created.body.id;
  const row = await agent(token, "POST", `/api/v1/databases/${databaseId}/rows`, {
    requestId: "uc44-r1",
    baseRevision: created.body.revision,
    title: "样例行",
    properties: { prop_num: "3", prop_done: "true", prop_url: "https://example.com", prop_due: "2026-11-16" },
  });
  expect(row.status).toBe(201);

  await page.locator(".tree-row__main").filter({ hasText: "任务" }).first().click();
  await expect(page.locator("table.db__table")).toBeVisible();
  expect(await headOrder(page)).toEqual(["name", "prop_num", "prop_done", "prop_due", "prop_created", "prop_id"]);

  /* ── The panel: hidden row still listed and tagged, system grouped ─── */
  await openColumns(page);
  expect(await panelOrder(page)).toEqual(["prop_num", "prop_done", "prop_url", "prop_due", "prop_created", "prop_id"]);
  await expect(rowOf(page, "prop_url")).toHaveClass(/is-hidden/);
  await expect(columnsPanel(page).locator(".cols-panel__section")).toHaveText("System");
  await expect(rowOf(page, "prop_created").locator(".cols-panel__tag")).toHaveText("Auto");
  await shot(page, join(evidence, "uc44-columns-panel@2x.png"));

  /* Drag 链接 (hidden — its order is a list position, not a drawn head)
     up before 估点; the panel order and the stored order move with it. */
  await dragColumn(page, "prop_url", rowOf(page, "prop_num"), true);
  expect(await panelOrder(page)).toEqual(["prop_url", "prop_num", "prop_done", "prop_due", "prop_created", "prop_id"]);
  expect(await headOrder(page)).toEqual(["name", "prop_num", "prop_done", "prop_due", "prop_created", "prop_id"]);

  /* A drop on the locked name row is no drop at all. */
  await dragColumn(page, "prop_done", columnsPanel(page).locator(".cols-panel__row.is-locked"), true);
  expect(await panelOrder(page)).toEqual(["prop_url", "prop_num", "prop_done", "prop_due", "prop_created", "prop_id"]);

  /* The keyboard step lands in the same stored order a drag would. */
  await rowOf(page, "prop_due").getByRole("button", { name: "Move 窗口 up" }).click();
  expect(await panelOrder(page)).toEqual(["prop_url", "prop_num", "prop_due", "prop_done", "prop_created", "prop_id"]);
  await rowOf(page, "prop_url").getByRole("button", { name: "Move 链接 down" }).click();
  expect(await panelOrder(page)).toEqual(["prop_num", "prop_url", "prop_due", "prop_done", "prop_created", "prop_id"]);
  await rowOf(page, "prop_url").getByRole("button", { name: "Move 链接 up" }).click();
  /* …and a meta column stays inside its own group. */
  await rowOf(page, "prop_id").getByRole("button", { name: "Move 标识 up" }).click();
  expect(await panelOrder(page)).toEqual(["prop_url", "prop_num", "prop_due", "prop_done", "prop_id", "prop_created"]);
  await shot(page, join(evidence, "uc44-columns-reordered@2x.png"));

  /* A filtered list is not an order: the grip and the steps rest while
     the search box holds text. */
  await columnsPanel(page).locator(".cols-panel__search").fill("链");
  await expect(rowOf(page, "prop_url").locator(".cols-panel__grip")).toHaveCount(0);
  await expect(rowOf(page, "prop_url").getByRole("button", { name: "Move 链接 up" })).toHaveCount(0);
  await columnsPanel(page).locator(".cols-panel__search").fill("");
  await page.keyboard.press("Escape");

  /* The new order is the database's: it survives a reload, it is what the
     API returns, and a hidden column's place is kept on the record. */
  expect(await propertyOrder(token, databaseId)).toEqual(["prop_url", "prop_num", "prop_due", "prop_done", "prop_id", "prop_created"]);
  expect(await headOrder(page)).toEqual(["name", "prop_num", "prop_due", "prop_done", "prop_id", "prop_created"]);

  /* ── The table head itself drags a column, to a head's left or right ── */
  /* 窗口, pulled onto 估点's right, lands behind it; its column washes and
     the ghost head's fades while it is held. The hidden 链接 keeps its
     place on the record — the head it never drew does not move it. */
  await dragColumnHead(page, "prop_due", "prop_num", false);
  expect(await headOrder(page)).toEqual(["name", "prop_num", "prop_due", "prop_done", "prop_id", "prop_created"]);
  expect(await propertyOrder(token, databaseId)).toEqual(["prop_url", "prop_num", "prop_due", "prop_done", "prop_id", "prop_created"]);

  /* A meta head only moves among meta: onto 完成 it does not land. */
  await dragColumnHead(page, "prop_id", "prop_done", true);
  expect(await headOrder(page)).toEqual(["name", "prop_num", "prop_due", "prop_done", "prop_id", "prop_created"]);
  /* …but 创建于 onto 标识's left swaps them inside their own group. */
  await dragColumnHead(page, "prop_created", "prop_id", true);
  expect(await headOrder(page)).toEqual(["name", "prop_num", "prop_due", "prop_done", "prop_created", "prop_id"]);
  /* The name column's head is never a drag's — its press stays the menu's;
     every other head carries the draggable mark. */
  await expect(page.locator(`table.db__table thead th[data-column="name"]`).getByRole("button")).not.toHaveAttribute("draggable", "true");
  await expect(page.locator(`table.db__table thead th[data-column="prop_num"]`).getByRole("button")).toHaveAttribute("draggable", "true");
  await shot(page, join(evidence, "uc44-columns-head-drag@2x.png"));

  await page.reload();
  await page.locator(".tree-row__main").filter({ hasText: "任务" }).first().click();
  await expect(page.locator("table.db__table")).toBeVisible();
  expect(await headOrder(page)).toEqual(["name", "prop_num", "prop_due", "prop_done", "prop_created", "prop_id"]);
});
