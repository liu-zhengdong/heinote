import { test, expect, type Page } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";

/* UC-14: an agent builds a database over real HTTP; the browser shows the
   same rows, filters and sorts; edits made in either direction reach the
   other side. */
let server: Awaited<ReturnType<typeof startServer>>;
let directory: string;
const password = "Agent-databases-browser-password-2026!";
const evidence = resolve("docs/evidence/agent-databases");

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-agent-databases-browser-"));
  server = await startServer({ dataDir: directory, host: "127.0.0.1", port: 0 });
});
test.afterAll(async () => {
  await server?.close();
  if (directory) {
    const target = resolve(directory);
    expect(dirname(target)).toBe(resolve(tmpdir()));
    expect(basename(target)).toMatch(/^notes-agent-databases-browser-/);
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
  await expect(page.getByRole("button", { name: `账号：${handle}`, exact: true })).toBeVisible();
}

async function createToken(page: Page, name: string, access: "read" | "write") {
  await page.getByRole("tab", { name: "Agent 令牌", exact: true }).click();
  await page.locator('input[name="tokenName"]').fill(name);
  await page.getByRole("combobox", { name: "权限", exact: true }).click();
  await page.getByRole("option", { name: access === "write" ? "读写" : "只读", exact: true }).click();
  await page.getByRole("button", { name: "创建", exact: true }).click();
  const value = await page.getByLabel("令牌", { exact: true }).inputValue();
  // The one-time value stays dismissable before the next token is made.
  await page.getByRole("button", { name: "已保存", exact: true }).click();
  return value;
}
async function closeSettings(page: Page) {
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
}

/* The Agent HTTP API: Bearer only, never the browser session cookie. */
async function agent(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${server.url}${path}`, {
    method,
    headers: { "authorization": `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

interface Db {
  id: string;
  revision: string;
  config: { title_name?: string; properties: Array<{ id: string; name: string; type: string }>; views: Array<{ id: string; name: string; kind: string }> };
}

async function buildDatabase(token: string, requestPrefix: string): Promise<Db> {
  const created = await agent(token, "POST", "/api/v1/databases", {
    requestId: `${requestPrefix}-db`,
    title: "UC 清单",
    database: {
      title_name: "UC 名称",
      properties: [
        { id: "number", name: "UC 编号", type: "text" },
        { id: "status", name: "状态", type: "status" },
        { id: "priority", name: "优先级", type: "select", options: ["P1", "P2", "P3"] },
      ],
      views: [{ id: "table", name: "全部 UC", kind: "table" }],
    },
  });
  expect(created.status).toBe(201);
  expect(created.body.page.kind).toBe("database");

  const withProperty = await agent(token, "POST", `/api/v1/databases/${created.body.id}/properties`, {
    requestId: `${requestPrefix}-property`,
    baseRevision: created.body.revision,
    property: { id: "due", name: "截止日期", type: "date" },
  });
  expect(withProperty.status).toBe(201);

  const withView = await agent(token, "POST", `/api/v1/databases/${created.body.id}/views`, {
    requestId: `${requestPrefix}-view`,
    baseRevision: withProperty.body.revision,
    view: { id: "board", name: "状态看板", kind: "board", group_by: "status" },
  });
  expect(withView.status).toBe(201);

  const read = await agent(token, "GET", `/api/v1/databases/${created.body.id}`);
  expect(read.status).toBe(200);
  return {
    id: created.body.id,
    revision: read.body.revision,
    config: read.body.page.database,
  };
}

async function addRow(token: string, db: Db, requestId: string, row: { title: string; text?: string; properties: Record<string, string> }) {
  const created = await agent(token, "POST", `/api/v1/databases/${db.id}/rows`, {
    requestId,
    baseRevision: db.revision,
    ...row,
  });
  expect(created.status).toBe(201);
  return created.body as { id: string; revision: string; values: Record<string, string> };
}

async function queryRows(token: string, dbId: string, body: object) {
  const response = await agent(token, "POST", `/api/v1/databases/${dbId}/query`, body);
  expect(response.status).toBe(200);
  return response.body.rows as Array<{ id: string; title: string; values: Record<string, string> }>;
}

function table(page: Page) { return page.locator("table.db__table"); }
function row(page: Page, pageId: string) { return table(page).locator(`tbody tr[data-page-id="${pageId}"]`); }
async function rowTitles(page: Page) {
  return table(page).locator("tbody tr .db__row-title").allInnerTexts();
}
async function openDatabase(page: Page, title: string) {
  // A database page holds rows, so its tree row is a branch: its label, not
  // the expand arrow, opens it.
  await page.locator(".tree-row__main").filter({ hasText: title }).first().click();
  await expect(table(page)).toBeVisible();
}

/* UI edits of the view raise the database revision; always re-read it. */
async function currentRevision(token: string, db: Db) {
  const response = await agent(token, "GET", `/api/v1/databases/${db.id}`);
  expect(response.status).toBe(200);
  db.revision = response.body.revision;
  return response;
}

test("UC-14: agent-built database renders, filters and sorts like HTTP, and edits round-trip", async ({ page }, testInfo) => {
  await register(page, "db_owner");
  await page.getByRole("button", { name: /^账号：/ }).click();
  const token = await createToken(page, "验收 Agent", "write");
  await closeSettings(page);

  /* The agent builds schema and rows without the browser. */
  const db = await buildDatabase(token, "uc14a");
  // Insert order differs from priority order, so a sort visibly reorders.
  const first = await addRow(token, db, "uc14a-row-1", { title: "修改笔记", text: "浏览器要改这行。", properties: { number: "UC-02", status: "In progress", priority: "P1" } });
  const second = await addRow(token, db, "uc14a-row-2", { title: "创建笔记", text: "参与者：Notes 用户。", properties: { number: "UC-01", status: "Not started", priority: "P2" } });
  const third = await addRow(token, db, "uc14a-row-3", { title: "查询笔记", properties: { priority: "P3" } });
  expect(second.values).toMatchObject({ number: "UC-01", status: "Not started", priority: "P2" });
  // An unset status reads as the property's default, as the cell does.
  expect(third.values.status).toBe("Not started");

  await openDatabase(page, "UC 清单");

  /* UC-01..AC: the page is a database with the agent's schema and rows. */
  await expect(page.getByRole("tab", { name: "全部 UC", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "状态看板", exact: true })).toBeVisible();
  await expect(table(page).locator("thead")).toContainText("UC 名称");
  await expect(table(page).locator("thead")).toContainText("UC 编号");
  await expect(table(page).locator("thead")).toContainText("状态");
  await expect(table(page).locator("thead")).toContainText("优先级");
  await expect(table(page).locator("thead")).toContainText("截止日期");
  await expect.poll(() => rowTitles(page)).toEqual(["修改笔记", "创建笔记", "查询笔记"]);
  await expect(row(page, first.id).getByLabel("UC 编号")).toHaveValue("UC-02");
  await expect(row(page, second.id).getByLabel("UC 编号")).toHaveValue("UC-01");
  await expect(row(page, first.id).getByRole("combobox", { name: "状态" })).toContainText("In progress");
  await expect(row(page, second.id).getByRole("combobox", { name: "优先级" })).toContainText("P2");

  /* The UI filter behaves like the same filter over /query. */
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByRole("menuitem", { name: "Not started", exact: true }).click();
  await expect(page.getByRole("button", { name: "Filtered by 状态: Not started", exact: true })).toBeVisible();
  await expect.poll(() => rowTitles(page)).toEqual(["创建笔记", "查询笔记"]);
  expect((await queryRows(token, db.id, { filter: { property_id: "status", value: "Not started" } })).map((row) => row.title))
    .toEqual(await rowTitles(page));

  /* Clearing and re-setting the view over HTTP drives the same view. The
     UI filter write already raised the database revision, so re-read it. */
  const filtered = await agent(token, "PATCH", `/api/v1/databases/${db.id}/views/table`, {
    requestId: "uc14a-view-filter",
    baseRevision: (await currentRevision(token, db)).body.revision,
    view: { filter: { property_id: "status", value: "In progress" }, sorts: [] },
  });
  expect(filtered.status).toBe(200);
  await expect(page.getByRole("button", { name: "Filtered by 状态: In progress", exact: true })).toBeVisible();
  await expect.poll(() => rowTitles(page)).toEqual(["修改笔记"]);
  const cleared = await agent(token, "PATCH", `/api/v1/databases/${db.id}/views/table`, {
    requestId: "uc14a-view-clear",
    baseRevision: filtered.body.revision,
    view: { filter: null },
  });
  expect(cleared.status).toBe(200);
  await expect.poll(() => rowTitles(page)).toEqual(["修改笔记", "创建笔记", "查询笔记"]);

  /* The UI sort behaves like the same sorts over /query. */
  await page.getByRole("button", { name: "Sort", exact: true }).click();
  await page.getByRole("menuitem", { name: "优先级", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sorted by 优先级", exact: true })).toBeVisible();
  await expect.poll(() => rowTitles(page)).toEqual(["修改笔记", "创建笔记", "查询笔记"]);
  expect((await queryRows(token, db.id, { sorts: [{ property_id: "priority", direction: "asc" }] })).map((row) => row.title))
    .toEqual(await rowTitles(page));

  /* Agent writes land in a browser that already has the table open. The UI
     sort write raised the database revision again. */
  await currentRevision(token, db);
  const extra = await addRow(token, db, "uc14a-row-4", { title: "删除笔记", properties: { number: "UC-04", status: "Done" } });
  await expect.poll(() => rowTitles(page)).toEqual(["修改笔记", "创建笔记", "查询笔记", "删除笔记"]);
  await expect(row(page, extra.id).getByRole("combobox", { name: "状态" })).toContainText("Done");
  const updated = await agent(token, "PATCH", `/api/v1/databases/${db.id}/rows/${second.id}`, {
    requestId: "uc14a-row-2-status",
    baseRevision: second.revision,
    databaseRevision: db.revision,
    properties: { status: "In progress" },
  });
  expect(updated.status).toBe(200);
  await expect(row(page, second.id).getByRole("combobox", { name: "状态" })).toContainText("In progress");

  /* The user edits the table and the row body; the agent reads both back. */
  await row(page, third.id).getByRole("combobox", { name: "状态" }).click();
  await page.getByRole("listbox", { name: "状态" }).getByRole("option", { name: "In progress", exact: true }).click();
  await expect(row(page, third.id).getByRole("combobox", { name: "状态" })).toContainText("In progress");
  await row(page, first.id).locator(".db__open").click();
  await expect(page.locator(".side-peek")).toBeVisible();
  const paragraph = page.locator(".side-peek .block__editable[contenteditable='true']").first();
  await paragraph.fill("正文由浏览器更新。");
  await expect.poll(async () => {
    const response = await agent(token, "GET", `/api/v1/pages/${first.id}`);
    return { status: response.body.page.properties?.status, text: response.body.text };
  }, { timeout: 15000 }).toEqual({ status: "In progress", text: "正文由浏览器更新。" });
  const savedThird = await agent(token, "GET", `/api/v1/pages/${third.id}`);
  expect(savedThird.status).toBe(200);
  expect(savedThird.body.page.properties.status).toBe("In progress");

  /* One evidence shot of the live table. */
  await mkdir(evidence, { recursive: true });
  await page.evaluate(async () => { await document.fonts.ready; });
  const shot = join(evidence, "agent-databases-table@2x.png");
  await table(page).screenshot({ path: shot, animations: "disabled" });
  await testInfo.attach("agent-databases-table", { path: shot, contentType: "image/png" });
});

test("UC-14: a read-only token queries but cannot write", async ({ page }) => {
  await register(page, "db_reader");
  await page.getByRole("button", { name: /^账号：/ }).click();
  const writeToken = await createToken(page, "验收写入", "write");
  const readToken = await createToken(page, "验收只读", "read");
  await closeSettings(page);

  const db = await buildDatabase(writeToken, "uc14b");
  await addRow(writeToken, db, "uc14b-row-1", { title: "只读可见", properties: { status: "In progress", priority: "P1" } });

  const read = await agent(readToken, "GET", `/api/v1/databases/${db.id}`);
  expect(read.status).toBe(200);
  expect(read.body.page.database.title_name).toBe("UC 名称");
  const rows = await queryRows(readToken, db.id, { filter: { property_id: "status", value: "In progress" } });
  expect(rows.map((row) => row.title)).toEqual(["只读可见"]);

  const denied = await agent(readToken, "POST", `/api/v1/databases/${db.id}/rows`, {
    requestId: "uc14b-denied",
    baseRevision: db.revision,
    title: "越权",
  });
  expect(denied.status).toBe(403);
  const deniedCreate = await agent(readToken, "POST", "/api/v1/databases", { requestId: "uc14b-denied-db", title: "越权" });
  expect(deniedCreate.status).toBe(403);
});
