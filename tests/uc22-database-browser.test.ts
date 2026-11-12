import { test, expect, type Page } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";

/* UC-22 browser acceptance: an agent builds the databases over the HTTP
   API — every new property type, a two-way relation, filtered and grouped
   views, calcs — and the browser renders them. Each surface the use case
   adds is asserted visible, then captured into .evidence. */
let server: Awaited<ReturnType<typeof startServer>>;
let directory: string;
const password = "UC-22-database-browser-password-2026!";
const evidence = resolve(".evidence/uc22-database");

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-uc22-database-browser-"));
  server = await startServer({ dataDir: directory, host: "127.0.0.1", port: 0 });
});
test.afterAll(async () => {
  await server?.close();
  if (directory) {
    const target = resolve(directory);
    expect(dirname(target)).toBe(resolve(tmpdir()));
    expect(basename(target)).toMatch(/^notes-uc22-database-browser-/);
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
async function revision(token: string, dbId: string) {
  const response = await agent(token, "GET", `/api/v1/databases/${dbId}`);
  expect(response.status).toBe(200);
  return response.body.revision as string;
}
async function addRow(token: string, dbId: string, requestId: string, row: { title: string; properties?: Record<string, string> }) {
  const created = await agent(token, "POST", `/api/v1/databases/${dbId}/rows`, {
    requestId, baseRevision: await revision(token, dbId), ...row,
  });
  expect(created.status).toBe(201);
  return created.body;
}

const TABLE = "table.db__table";
function databaseTable(page: Page) { return page.locator(TABLE).first(); }
async function openTreePage(page: Page, title: string) {
  await page.locator(".tree-row__main").filter({ hasText: title }).first().click();
}
async function shot(page: Page, path: string, locator = page.locator("main").first()) {
  await page.evaluate(async () => { await document.fonts.ready; });
  await locator.screenshot({ path, animations: "disabled" });
}

test("UC-22: new property types, relation, views and linked view render and are captured", async ({ page }) => {
  await register(page, "uc22_owner");
  const token = await createToken(page, "UC-22 验收");

  /* 项目: the relation's target — three rows the chips name. */
  const projects = await agent(token, "POST", "/api/v1/databases", {
    requestId: "uc22-projects",
    title: "项目",
    database: {
      properties: [{ id: "prop_code", name: "代号", type: "text" }],
      views: [{ id: "view_all", name: "全部", kind: "table" }],
    },
  });
  expect(projects.status).toBe(201);
  const projectsId = projects.body.id;
  const alpha = await addRow(token, projectsId, "uc22-p1", { title: "Alpha 项目", properties: { prop_code: "P-01" } });
  const beta = await addRow(token, projectsId, "uc22-p2", { title: "Beta 项目", properties: { prop_code: "P-02" } });
  await addRow(token, projectsId, "uc22-p3", { title: "Gamma 项目", properties: { prop_code: "P-03" } });

  /* 任务: every new property type in one table. The relation starts
     one-way — POST cannot land a mirror — then goes two-way by PATCH. */
  const tasks = await agent(token, "POST", "/api/v1/databases", {
    requestId: "uc22-tasks",
    title: "任务",
    database: {
      properties: [
        { id: "prop_num", name: "估点", type: "number" },
        { id: "prop_done", name: "完成", type: "checkbox" },
        { id: "prop_url", name: "链接", type: "url" },
        { id: "prop_mail", name: "邮箱", type: "email" },
        { id: "prop_phone", name: "电话", type: "phone" },
        { id: "prop_priority", name: "优先级", type: "select", options: ["P1", "P2", "P3"], option_colors: { P1: "red", P2: "yellow", P3: "gray" } },
        { id: "prop_tags", name: "标签", type: "multi_select", options: ["紧急", "后端", "前端"], option_colors: { "紧急": "red", "后端": "blue", "前端": "green" } },
        { id: "prop_owner", name: "负责人", type: "person" },
        { id: "prop_due", name: "窗口", type: "date" },
        { id: "prop_rel", name: "项目", type: "relation", relation_database: projectsId },
        { id: "prop_created", name: "创建于", type: "created_time" },
        { id: "prop_editor", name: "更新者", type: "last_edited_by" },
        { id: "prop_id", name: "标识", type: "id" },
      ],
      views: [
        { id: "view_table", name: "全部任务", kind: "table", calcs: { prop_num: "sum", prop_tags: "count_unique", prop_rel: "count" } },
        { id: "view_filtered", name: "进行中", kind: "table",
          filters: [
            { property_id: "prop_done", op: "is", value: "false" },
            { logic: "or", conditions: [
              { property_id: "prop_priority", op: "is", value: "P1" },
              { property_id: "prop_tags", op: "contains", value: "紧急" },
            ] },
          ],
          hidden: ["prop_phone"] },
        { id: "view_grouped", name: "按负责人", kind: "table", group_by: "prop_owner" },
      ],
    },
  });
  expect(tasks.status).toBe(201);
  const tasksId = tasks.body.id;
  const twoWay = await agent(token, "PATCH", `/api/v1/databases/${tasksId}/properties/prop_rel`, {
    requestId: "uc22-twoway",
    baseRevision: tasks.body.revision,
    property: { relation_two_way: true, relation_backlink_name: "任务" },
  });
  expect(twoWay.status).toBe(200);

  /* Rows that exercise every cell: a range on the date, two links on the
     relation, colored options. */
  const first = await addRow(token, tasksId, "uc22-t1", {
    title: "修复登录抖动",
    properties: {
      prop_num: "5", prop_done: "true", prop_url: "https://example.com/login",
      prop_mail: "dev@example.com", prop_phone: "13800001111",
      prop_priority: "P1", prop_tags: JSON.stringify(["紧急", "后端"]), prop_owner: "刘工",
      prop_due: "2026-11-10/2026-11-15", prop_rel: JSON.stringify([alpha.id, beta.id]),
    },
  });
  const second = await addRow(token, tasksId, "uc22-t2", {
    title: "编写验收脚本",
    properties: {
      prop_num: "3", prop_url: "https://example.com/tests", prop_priority: "P2",
      /* 紧急 keeps the row inside the filtered view's OR group. */
      prop_tags: JSON.stringify(["紧急", "前端"]), prop_owner: "刘工", prop_due: "2026-11-20",
      prop_rel: JSON.stringify([beta.id]),
    },
  });
  const third = await addRow(token, tasksId, "uc22-t3", {
    title: "整理数据库文档",
    properties: { prop_num: "2", prop_priority: "P3", prop_tags: JSON.stringify(["紧急"]), prop_owner: "王工", prop_due: "2026-11-30" },
  });

  /* ── The table: all new cell types, footer calcs ──────────────────── */
  await page.setViewportSize({ width: 1720, height: 1000 });
  await openTreePage(page, "任务");
  const table = databaseTable(page);
  await expect(table).toBeVisible();
  await expect(page.getByRole("tab", { name: "全部任务", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "进行中", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "按负责人", exact: true })).toBeVisible();
  await expect(table.locator("thead")).toContainText("估点");
  await expect(table.locator("thead")).toContainText("项目");
  await expect(table.locator("thead")).toContainText("创建于");
  await expect(table.locator("thead")).toContainText("标识");
  // The meta columns read the row's own record: the author name, a
  // creation time and the row's id.
  const firstRow = table.locator(`tbody tr[data-page-id="${first.id}"]`);
  // Rows were written by the agent token, so the author names the token.
  await expect(firstRow.locator("[data-meta='last_edited_by']")).toContainText("UC-22 验收");
  await expect(firstRow.locator("[data-meta='id']")).toHaveText(first.id);
  // Relation chips name the linked pages.
  const relCell = firstRow.locator(".db-rel-cell");
  await expect(relCell).toContainText("Alpha 项目");
  await expect(relCell).toContainText("Beta 项目");
  // Footer calcs: the sum of 5+3+2, unique tag names, linked ids.
  await expect(table.locator("tfoot .db__calc-val").first()).toBeVisible();
  await expect(table.locator("tfoot")).toContainText("10");
  await mkdir(evidence, { recursive: true });
  // The whole table, every column: size the window to its laid-out width.
  const tableWidth = await table.evaluate((element) => element.scrollWidth);
  await page.setViewportSize({ width: Math.ceil(tableWidth) + 80, height: 1000 });
  await shot(page, join(evidence, "uc22-table-all-types@2x.png"), page.locator(".dbv").first());
  await page.setViewportSize({ width: 1440, height: 1000 });

  /* ── The property-type chooser (one screen) ────────────────────────── */
  await table.locator("thead").getByRole("button", { name: "Add property", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Relation", exact: true })).toBeVisible();
  await shot(page, join(evidence, "uc22-property-types@2x.png"));
  await page.keyboard.press("Escape");

  /* ── The filter panel: two conditions and a group ──────────────────── */
  await page.getByRole("tab", { name: "进行中", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await page.getByRole("button", { name: /^Filtered by/ }).click();
  await expect(page.locator(".filter-panel")).toBeVisible();
  await expect(page.locator(".filter-panel .group-box")).toBeVisible();
  await shot(page, join(evidence, "uc22-filter-panel@2x.png"));
  await page.keyboard.press("Escape");

  /* ── The columns panel, with a hidden column ───────────────────────── */
  await page.getByRole("button", { name: "1 columns hidden" }).click();
  const colsPanel = page.locator(".cols-panel");
  await expect(colsPanel).toBeVisible();
  await expect(colsPanel.locator(".cols-panel__row.is-hidden")).toContainText("电话");
  await shot(page, join(evidence, "uc22-columns-panel@2x.png"));
  await page.keyboard.press("Escape");

  /* ── Grouped view: headers carry counts, calcs subtotal per group ──── */
  await page.getByRole("tab", { name: "按负责人", exact: true }).click();
  // The picker open may have scrolled the wrap; bring back the head.
  await page.locator(".db__table-wrap").evaluate((element) => { element.scrollLeft = 0; });
  await expect(table.locator("tr.grp-row")).toHaveCount(2);
  await expect(table.locator(".grp-h__label").first()).toContainText("刘工");
  await expect(table.locator(".grp-h__count").first()).toHaveText("2");
  await shot(page, join(evidence, "uc22-grouped-view@2x.png"), page.locator(".dbv").first());

  /* ── Relation cell: chips, then the picker ─────────────────────────── */
  await page.getByRole("tab", { name: "全部任务", exact: true }).click();
  const cell = table.locator(`tbody tr[data-page-id="${third.id}"]`).locator(".db__multi-cell[aria-label='项目']");
  await cell.click();
  const picker = page.getByRole("listbox", { name: "Link a page" });
  await expect(picker).toBeVisible();
  await expect(picker.locator(".db-multi-menu__option")).toHaveCount(3);
  await expect(picker.locator(".db-multi-menu__new")).toContainText("New page");
  await shot(page, join(evidence, "uc22-relation-picker@2x.png"));
  // Pick Gamma through the picker: the mirror side must follow.
  await picker.getByRole("option", { name: "Gamma 项目", exact: true }).click();
  await expect(table.locator(`tbody tr[data-page-id="${third.id}"]`).locator(".db-rel-cell")).toContainText("Gamma 项目");
  const gammaRow = await agent(token, "GET", `/api/v1/pages/${(await agent(token, "POST", `/api/v1/databases/${projectsId}/query`, { query: "Gamma" })).body.rows[0].id}`);
  const mirrorId = (await agent(token, "GET", `/api/v1/databases/${projectsId}`)).body.page.database.properties.find((entry: any) => entry.relation_origin === "prop_rel").id;
  expect(gammaRow.body.page.properties[mirrorId]).toBe(JSON.stringify([third.id]));

  /* ── Linked view: /linked, the two-step picker, the rendered view ──── */
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByRole("menuitem", { name: "页面", exact: true }).click();
  const editable = page.locator(".block__editable[contenteditable='true']").first();
  await editable.click();
  await page.keyboard.type("/linked");
  const linkedCommand = page.getByRole("option", { name: "Linked view" });
  await expect(linkedCommand).toBeVisible();
  await linkedCommand.click();
  // Step one names the database; the shot holds it before the pick.
  const linkMenu = page.locator(".popover").filter({ hasText: "Search databases" });
  await expect(page.getByRole("menuitem", { name: "任务" })).toBeVisible();
  await shot(page, join(evidence, "uc22-linkview-pick@2x.png"));
  await page.getByRole("menuitem", { name: "任务" }).click();
  // Step two names the view.
  await expect(page.getByRole("menuitem", { name: "按负责人", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "按负责人", exact: true }).click();
  // The link renders the pinned view read-only, captioned, no tabs.
  const cap = page.locator(".block-cap");
  await expect(cap).toContainText("Linked to 任务");
  await expect(cap).toContainText("按负责人");
  await expect(cap.getByRole("button", { name: "Open" })).toBeVisible();
  const linkedFrame = page.locator(".page-frame").filter({ has: page.locator(".db__table") }).last().locator(".dbv").first();
  await expect(linkedFrame.locator("tr.grp-row").first()).toBeVisible();
  await expect(linkedFrame.getByRole("tablist")).toHaveCount(0);
  await expect(linkedFrame.locator(".view-tab--pinned")).toContainText("按负责人");
  await shot(page, join(evidence, "uc22-linked-view@2x.png"));
  // Dark theme, same block — the caption and chips hold.
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await shot(page, join(evidence, "uc22-linked-view-dark@2x.png"));
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
});
