import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { startServer } from "../server/index.ts";

// UC-14 acceptance uses HTTP only. The server import only starts the fixture.
// Expected values come from the UC, the HTTP contract, and existing UI behavior.
type Json = any;
type Server = Awaited<ReturnType<typeof startServer>>;
interface Reply { status: number; body: Json }
interface Options { method?: string; body?: unknown; token?: string; raw?: BodyInit; contentType?: string }

class Browser {
  cookie = "";
  constructor(private readonly url: () => string) {}
  async request(path: string, options: Options = {}): Promise<Reply> {
    const response = await fetch(this.url() + path, {
      method: options.method ?? "GET",
      headers: {
        Origin: this.url(),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : this.cookie ? { Cookie: this.cookie } : {}),
        ...(options.body !== undefined ? { "Content-Type": "application/json" }
          : options.raw !== undefined ? { "Content-Type": options.contentType ?? "application/octet-stream" } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : options.raw,
      redirect: "manual",
    });
    if (!options.token) for (const entry of response.headers.getSetCookie()) {
      const first = entry.split(";", 1)[0];
      if (first.startsWith("notes_session=")) this.cookie = /max-age=0/i.test(entry) ? "" : first;
    }
    const raw = await response.text();
    if (raw) assert.match(response.headers.get("content-type") ?? "", /application\/json/, `${path}: ${raw.slice(0, 200)}`);
    return { status: response.status, body: raw ? JSON.parse(raw) : null };
  }
}

function ok(reply: Reply, expected = 200): Json {
  assert.equal(reply.status, expected, JSON.stringify(reply.body));
  return reply.body;
}
function denied(reply: Reply): void {
  assert.ok([401, 403, 404].includes(reply.status), `Expected access refusal, got ${reply.status}: ${JSON.stringify(reply.body)}`);
}
function invalid(reply: Reply): void {
  const body = ok(reply, 400);
  assert.equal(typeof body.error, "string");
  assert.ok(body.error.length > 0, "Invalid input must have an error message");
}
function dto(value: Json): Json {
  assert.equal(typeof value.id, "string");
  assert.ok(value.id);
  assert.equal(typeof value.title, "string");
  assert.equal(typeof value.text, "string");
  assert.equal(typeof value.revision, "string");
  assert.ok(value.revision);
  assert.equal(value.page.id, value.id);
  assert.equal(value.collaboration.pageId, value.id);
  assert.equal(value.collaboration.revision, value.revision);
  assert.equal(typeof value.collaboration.generation, "string");
  assert.ok(value.collaboration.generation);
  return value;
}
function database(value: Json): Json {
  dto(value);
  assert.equal(value.page.kind, "database");
  assert.ok(Array.isArray(value.page.database.properties));
  assert.ok(Array.isArray(value.page.database.views));
  return value;
}
function row(value: Json, databaseId: string): Json {
  dto(value);
  assert.equal(value.page.kind, "document");
  assert.equal(value.page.parent_id, databaseId);
  assert.ok(value.values && typeof value.values === "object");
  assert.ok(Object.values(value.values).every((entry) => typeof entry === "string"));
  return value;
}

class Agent {
  constructor(readonly browser: Browser, readonly token: string) {}
  request(path: string, options: Omit<Options, "token"> = {}) {
    return this.browser.request(`/api/v1${path}`, { ...options, token: this.token });
  }
  async create(input: Json = {}) {
    return database(ok(await this.request("/databases", { method: "POST", body: { requestId: randomUUID(), ...input } }), 201));
  }
  async get(id: string) { return database(ok(await this.request(`/databases/${id}`))); }
  async addRow(db: Json, input: Json = {}) {
    return row(ok(await this.request(`/databases/${db.id}/rows`, {
      method: "POST", body: { requestId: randomUUID(), baseRevision: db.revision, ...input },
    }), 201), db.id);
  }
  async updateRow(db: Json, current: Json, input: Json) {
    return row(ok(await this.request(`/databases/${db.id}/rows/${current.id}`, {
      method: "PATCH", body: { requestId: randomUUID(), baseRevision: current.revision, databaseRevision: db.revision, ...input },
    })), db.id);
  }
  async query(id: string, input: Json = {}) {
    const result = ok(await this.request(`/databases/${id}/query`, { method: "POST", body: input }));
    assert.equal(result.databaseId, id);
    assert.equal(typeof result.revision, "string");
    assert.ok(result.revision);
    assert.ok(Array.isArray(result.rows));
    result.rows.forEach((entry: Json) => row(entry, id));
    assert.equal(Number.isInteger(result.total), true);
    assert.equal(typeof result.hasMore, "boolean");
    assert.ok(result.nextOffset === null || Number.isInteger(result.nextOffset));
    return result;
  }
  async addProperty(db: Json, property: Json) {
    return database(ok(await this.request(`/databases/${db.id}/properties`, {
      method: "POST", body: { requestId: randomUUID(), baseRevision: db.revision, property },
    }), 201));
  }
  async patchProperty(db: Json, id: string, property: Json) {
    return database(ok(await this.request(`/databases/${db.id}/properties/${id}`, {
      method: "PATCH", body: { requestId: randomUUID(), baseRevision: db.revision, property },
    })));
  }
  async addView(db: Json, view: Json) {
    return database(ok(await this.request(`/databases/${db.id}/views`, {
      method: "POST", body: { requestId: randomUUID(), baseRevision: db.revision, view },
    }), 201));
  }
  async patchView(db: Json, id: string, view: Json) {
    return database(ok(await this.request(`/databases/${db.id}/views/${id}`, {
      method: "PATCH", body: { requestId: randomUUID(), baseRevision: db.revision, view },
    })));
  }
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "notes-agent-databases-http-"));
  let server: Server | undefined;
  t.after(async () => {
    try { await server?.close(); }
    finally {
      const target = resolve(directory);
      assert.equal(dirname(target), resolve(tmpdir()));
      assert.ok(basename(target).startsWith("notes-agent-databases-http-"));
      await rm(target, { recursive: true, force: true });
    }
  });
  server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false });
  const browser = () => new Browser(() => server!.url);
  const owner = browser();
  const user = await register(owner, "owner");
  const writer = await makeToken(owner, "write");
  // The Agent has no browser session cookie.
  const agent = new Agent(browser(), writer.token);
  return {
    browser, owner, user, writer, agent,
    async restart() {
      await server!.close();
      server = undefined;
      server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false });
    },
  };
}
async function register(browser: Browser, handle: string) {
  ok(await browser.request("/api/auth/register", {
    method: "POST", body: { handle, displayName: handle, password: "Independent-database-acceptance-2026!" },
  }), 201);
  return ok(await browser.request("/api/session")).user;
}
async function makeToken(browser: Browser, access: "read" | "write") {
  return ok(await browser.request("/api/tokens", { method: "POST", body: { name: `UC-14 ${access}`, access } }), 201);
}
async function invite(owner: Browser, member: Browser, scope: string, handle: string, role: string) {
  ok(await owner.request(`/api/spaces/${scope}/invitations`, { method: "POST", body: { handle, role } }));
  const invitation = ok(await member.request("/api/invitations")).find((entry: Json) => entry.spaceId === scope);
  assert.ok(invitation);
  ok(await member.request(`/api/invitations/${invitation.id}`, { method: "POST", body: { accept: true } }));
}
async function document(agent: Agent, input: Json = {}) {
  return dto(ok(await agent.request("/pages", { method: "POST", body: { title: "Parent", text: "Existing document", ...input } }), 201));
}
async function archive(browser: Browser, current: Json) {
  const scope = current.collaboration.scope;
  ok(await browser.request("/api/records/batch", {
    method: "POST", body: {
      requestId: randomUUID(),
      expectedPages: [{ scope, pageId: current.id, generation: current.collaboration.generation, revision: current.revision }],
      writes: [{ scope, collection: "pages", id: current.id, action: "patch", base: current.page, patch: { archived: true } }],
    },
  }));
}
const ids = (result: Json): string[] => result.rows.map((entry: Json) => entry.id);
const config = (db: Json): Json => db.page.database;
const property = (db: Json, id: string): Json => config(db).properties.find((entry: Json) => entry.id === id);
const view = (db: Json, id: string): Json => config(db).views.find((entry: Json) => entry.id === id);
const UC = "property_uc";
const STATUS = "property_status";
const PRIORITY = "property_priority";
const DATE = "property_date";
const PERSON = "property_person";
const IMAGE = "property_image";
const TABLE = "view_table";
function ucConfig(): Json {
  return {
    title_name: "用例", title_icon: "text",
    properties: [
      { id: UC, name: "UC 编号", type: "text" },
      { id: STATUS, name: "状态", type: "status" },
      // The order differs from lexical order to expose a wrong HTTP sort.
      { id: PRIORITY, name: "优先级", type: "select", options: ["P2", "P1", "P3"] },
      { id: DATE, name: "日期", type: "date" },
      { id: PERSON, name: "负责人", type: "person" },
      { id: IMAGE, name: "图片", type: "image" },
    ],
    views: [{ id: TABLE, name: "UC 表格", kind: "table", sorts: [{ property_id: PRIORITY, direction: "asc" }] }],
  };
}

// AC-01/02/08: three real UC records, editable body, effective values and UI order.
test("UC-14: creates a UC database and three rows, then queries UI order and pagination", async (t) => {
  const f = await fixture(t); const a = f.agent;
  const parent = await document(a);
  let db = await a.create({ title: "Use Cases", parentId: parent.id, database: ucConfig() });
  assert.equal(db.title, "Use Cases");
  assert.equal(db.page.parent_id, parent.id);
  assert.equal(db.collaboration.scope, "personal");
  assert.deepEqual(config(db), ucConfig());
  const first = await a.addRow(db, {
    title: "UC-14：Agent 管理 Database", text: "参与者：Agent\n结果：创建并维护数据库。",
    properties: { [UC]: "UC-14", [STATUS]: "In progress", [PRIORITY]: "P1", [DATE]: "2026-11-10", [PERSON]: "刘政东" },
  });
  db = await a.get(db.id);
  const second = await a.addRow(db, {
    title: "UC-13：维护团队知识库", text: "参与者：编辑者。", properties: { [UC]: "UC-13", [PRIORITY]: "P2" },
  });
  assert.equal(second.values[STATUS], "Not started");
  assert.equal(second.page.properties?.[STATUS] ?? "", "");
  assert.equal(second.values[DATE], "");
  assert.equal(Object.hasOwn(second.values, IMAGE), false);
  db = await a.get(db.id);
  const third = await a.addRow(db, {
    title: "UC-06：接入 Agent", text: "令牌由用户提供。", properties: { [UC]: "UC-06", [STATUS]: "In progress", [PRIORITY]: "P2" },
  });
  const read = dto(ok(await a.request(`/pages/${first.id}`)));
  assert.equal(read.text, first.text);
  assert.deepEqual(read.page.properties, first.page.properties);
  assert.equal(first.values[PERSON], "刘政东");
  assert.equal(first.values[STATUS], "In progress");
  const block = Object.values(read.page.block_tree.by_id).find((entry: Json) => entry.kind === "text") as Json;
  assert.ok(block, "A created row must have a normal editable document body");
  const appended = dto(ok(await a.request(`/pages/${first.id}/operations`, {
    method: "POST", body: { requestId: randomUUID(), generation: read.collaboration.generation, mode: "apply", operations: [{ type: "insert_text", blockId: block.id, index: "end", text: "\n验收入口：HTTP。" }] },
  })));
  assert.match(appended.text, /验收入口：HTTP。/);
  db = await a.get(db.id);
  const sorted = await a.query(db.id, { viewId: TABLE });
  assert.deepEqual(ids(sorted), [second.id, third.id, first.id]);
  assert.equal(sorted.revision, db.revision);
  assert.equal(sorted.total, 3); assert.equal(sorted.hasMore, false); assert.equal(sorted.nextOffset, null);
  assert.equal(sorted.rows.find((entry: Json) => entry.id === first.id).text, appended.text);
  const active = await a.query(db.id, { viewId: TABLE, filter: { property_id: STATUS, value: "In progress" }, limit: 1 });
  assert.deepEqual(ids(active), [third.id]);
  assert.equal(active.total, 2); assert.equal(active.hasMore, true); assert.equal(active.nextOffset, 1);
  const next = await a.query(db.id, { viewId: TABLE, filter: { property_id: STATUS, value: "In progress" }, offset: active.nextOffset, limit: 1 });
  assert.deepEqual(ids(next), [first.id]);
  assert.equal(next.total, 2); assert.equal(next.hasMore, false); assert.equal(next.nextOffset, null);
  const searched = await a.query(db.id, { query: " uc-14 ", filter: null, sorts: [{ property_id: "name", direction: "desc" }] });
  assert.deepEqual(ids(searched), [first.id]);
  const empty = await a.query(db.id, { query: "does not exist" });
  assert.deepEqual(empty.rows, []); assert.equal(empty.total, 0); assert.equal(empty.hasMore, false); assert.equal(empty.nextOffset, null);
  const beyond = await a.query(db.id, { viewId: TABLE, offset: 30, limit: 2 });
  assert.deepEqual(beyond.rows, []); assert.equal(beyond.total, 3); assert.equal(beyond.nextOffset, null);
});

test("UC-14: query uses option ranks, numeric titles, empty-last dates and explicit view overrides", async (t) => {
  const { agent: a } = await fixture(t);
  let db = await a.create({ database: ucConfig() });
  const ten = await a.addRow(db, { title: "Row 10", properties: { [PRIORITY]: "P1", [STATUS]: "Done", [DATE]: "2026-11-20" } });
  db = await a.get(db.id);
  const two = await a.addRow(db, { title: "Row 2", properties: { [PRIORITY]: "P2", [STATUS]: "In progress", [DATE]: "2026-11-05" } });
  db = await a.get(db.id);
  const one = await a.addRow(db, { title: "Row 1", properties: { [PRIORITY]: "P2" } });
  db = await a.get(db.id);
  const three = await a.addRow(db, { title: "Row 3" });
  const sorted = (sorts: Json) => a.query(db.id, { viewId: TABLE, filter: null, sorts });
  assert.deepEqual(ids(await sorted([{ property_id: "name", direction: "asc" }])), [one.id, two.id, three.id, ten.id]);
  assert.deepEqual(ids(await sorted([{ property_id: STATUS, direction: "asc" }])), [one.id, three.id, two.id, ten.id]);
  assert.deepEqual(ids(await sorted([{ property_id: PRIORITY, direction: "desc" }])), [ten.id, two.id, one.id, three.id]);
  assert.deepEqual(ids(await sorted([{ property_id: DATE, direction: "asc" }])), [two.id, ten.id, one.id, three.id]);
  assert.deepEqual(ids(await sorted([{ property_id: DATE, direction: "desc" }])), [ten.id, two.id, one.id, three.id]);
  assert.deepEqual(ids(await sorted([{ property_id: PRIORITY, direction: "asc" }, { property_id: "name", direction: "desc" }])), [two.id, one.id, ten.id, three.id]);
  db = await a.patchView(await a.get(db.id), TABLE, { filter: { property_id: STATUS, value: "In progress" }, sorts: [{ property_id: DATE, direction: "desc" }] });
  assert.deepEqual(ids(await a.query(db.id, { viewId: TABLE })), [two.id]);
  assert.deepEqual(ids(await a.query(db.id, { viewId: TABLE, filter: { property_id: STATUS, value: "Done" } })), [ten.id]);
  assert.deepEqual(ids(await a.query(db.id, { viewId: TABLE, filter: null, sorts: [{ property_id: "name", direction: "asc" }] })), [one.id, two.id, three.id, ten.id]);
  assert.deepEqual(await a.get(db.id), db, "Query overrides must not change a saved view");
});

test("UC-14: query defaults to 100 rows and returns the final page without duplicates", async (t) => {
  const { agent: a } = await fixture(t);
  let db = await a.create({ title: "Pagination" });
  const created: string[] = [];
  for (let index = 0; index < 101; index += 1) {
    if (index) db = await a.get(db.id);
    created.push((await a.addRow(db, { title: `Entry ${index + 1}` })).id);
  }
  db = await a.get(db.id);
  const first = await a.query(db.id);
  assert.equal(first.rows.length, 100); assert.equal(first.total, 101);
  assert.equal(first.hasMore, true); assert.equal(first.nextOffset, 100);
  assert.deepEqual(ids(first), created.slice(0, 100));
  const last = await a.query(db.id, { offset: first.nextOffset, limit: 1 });
  assert.deepEqual(ids(last), [created[100]]); assert.equal(last.total, 101);
  assert.equal(last.hasMore, false); assert.equal(last.nextOffset, null);
  assert.equal(new Set([...ids(first), ...ids(last)]).size, 101);
  assert.equal(first.revision, db.revision); assert.equal(last.revision, db.revision);
});

test("UC-14: defaults to an empty Table database and rejects reading a document as a database", async (t) => {
  const { agent: a } = await fixture(t);
  const db = await a.create();
  assert.deepEqual(config(db).properties, []);
  assert.equal(config(db).views.length, 1);
  assert.equal(config(db).views[0].kind, "table");
  assert.equal(config(db).views[0].name, "Table");
  assert.ok(config(db).views[0].id);
  const configured = await a.create({ database: { properties: [{ id: UC, name: "UC", type: "text" }] } });
  assert.equal(config(configured).views.length, 1);
  assert.equal(config(configured).views[0].kind, "table");
  assert.equal(property(configured, UC).type, "text");
  const doc = await document(a);
  invalid(await a.request(`/databases/${doc.id}`));
});

// AC-03: targeted changes retain IDs, row values and every other view.
test("UC-14: adds and patches properties and snake_case view configurations without replacing other views", async (t) => {
  const { agent: a } = await fixture(t);
  let db = await a.create({ database: ucConfig() });
  const entry = await a.addRow(db, { title: "Keep me", properties: { [UC]: "UC-14", [PRIORITY]: "P1" } });
  db = await a.get(db.id);
  const original = structuredClone(view(db, TABLE));
  db = await a.addProperty(db, { id: "property_note", name: "备注", type: "text", icon: "text" });
  assert.equal(property(db, "property_note").name, "备注");
  db = await a.patchProperty(db, UC, { name: "用例编号", icon: "hash" });
  assert.equal(property(db, UC).name, "用例编号");
  assert.equal(property(db, UC).id, UC);
  db = await a.patchProperty(db, PRIORITY, { options: ["P2", "P1", "P3", "P4"] });
  assert.deepEqual(property(db, PRIORITY).options, ["P2", "P1", "P3", "P4"]);
  const board = { id: "view_board", name: "进行中", kind: "board", group_by: STATUS, filter: { property_id: STATUS, value: "Not started" }, sorts: [{ property_id: PRIORITY, direction: "desc" }] };
  db = await a.addView(db, board);
  assert.deepEqual(view(db, "view_board"), board);
  assert.deepEqual(view(db, TABLE), original);
  db = await a.addView(db, { id: "view_calendar", name: "日期", kind: "calendar", date_by: DATE });
  db = await a.addView(db, { id: "view_gallery", name: "图片", kind: "gallery", card_preview: IMAGE, card_properties: [UC, PRIORITY] });
  db = await a.patchView(db, TABLE, { name: "精简列表", kind: "list", filter: { property_id: PRIORITY, value: "P1" }, sorts: [{ property_id: "name", direction: "asc" }] });
  assert.equal(view(db, TABLE).id, TABLE);
  assert.equal(view(db, TABLE).kind, "list");
  assert.deepEqual(view(db, "view_board"), board);
  assert.equal(view(db, "view_calendar").date_by, DATE);
  assert.deepEqual(view(db, "view_gallery").card_properties, [UC, PRIORITY]);
  db = await a.patchView(db, TABLE, { filter: null });
  assert.equal(view(db, TABLE).filter ?? null, null);
  assert.equal(config(db).views.length, 4);
  const found = (await a.query(db.id, { viewId: TABLE })).rows[0];
  assert.equal(found.id, entry.id); assert.equal(found.values[UC], "UC-14"); assert.equal(found.values[PRIORITY], "P1");
  const before = await a.get(db.id);
  invalid(await a.request(`/databases/${db.id}/views/${TABLE}`, { method: "PATCH", body: { requestId: randomUUID(), baseRevision: before.revision, view: { name: "Must roll back", sorts: [{ property_id: "missing", direction: "asc" }] } } }));
  assert.deepEqual(await a.get(db.id), before);
});

test("UC-14: renames a status by stable option ID and migrates rows and saved filters atomically", async (t) => {
  const { agent: a } = await fixture(t);
  const options = [
    { id: "todo", name: "待开发", color: "default", group: "todo" },
    { id: "doing", name: "开发中", color: "blue", group: "progress" },
    { id: "done", name: "已完成", color: "green", group: "complete" },
  ];
  let db = await a.create({ database: { properties: [{ id: STATUS, name: "状态", type: "status", status_options: options, default_status: "todo" }], views: [
    { id: TABLE, name: "开发中", kind: "table", filter: { property_id: STATUS, value: "开发中" } },
    { id: "view_other", name: "已完成", kind: "board", group_by: STATUS, filter: { property_id: STATUS, value: "已完成" } },
  ] } });
  const changed = await a.addRow(db, { title: "Rename target", properties: { [STATUS]: "开发中" } });
  db = await a.get(db.id);
  const untouched = await a.addRow(db, { title: "Already done", properties: { [STATUS]: "已完成" } });
  db = await a.get(db.id);
  const fallback = await a.addRow(db, { title: "Uses default" });
  db = await a.get(db.id);
  db = await a.patchProperty(db, STATUS, { status_options: options.map((option) => option.id === "doing" ? { ...option, name: "实现中" } : option) });
  assert.equal(property(db, STATUS).status_options.find((entry: Json) => entry.id === "doing").name, "实现中");
  assert.equal(view(db, TABLE).filter.value, "实现中");
  assert.equal(view(db, "view_other").filter.value, "已完成");
  const migrated = await a.query(db.id, { viewId: TABLE });
  assert.deepEqual(ids(migrated), [changed.id]);
  assert.equal(migrated.rows[0].values[STATUS], "实现中");
  assert.equal(migrated.rows[0].page.properties[STATUS], "实现中");
  assert.notEqual(migrated.rows[0].revision, changed.revision);
  db = await a.patchProperty(db, STATUS, { default_status: "doing" });
  const all = await a.query(db.id, { viewId: TABLE, filter: null });
  assert.equal(all.rows.find((entry: Json) => entry.id === fallback.id).values[STATUS], "实现中");
  assert.equal(all.rows.find((entry: Json) => entry.id === untouched.id).values[STATUS], "已完成");
  const before = await a.get(db.id); const rowsBefore = await a.query(db.id, { viewId: TABLE, filter: null });
  invalid(await a.request(`/databases/${db.id}/properties/${STATUS}`, { method: "PATCH", body: { requestId: randomUUID(), baseRevision: before.revision, property: { name: "Must roll back", status_options: options.map((option) => ({ ...option, name: "duplicate" })) } } }));
  assert.deepEqual(await a.get(db.id), before);
  assert.deepEqual(await a.query(db.id, { viewId: TABLE, filter: null }), rowsBefore);
});

test("UC-14: swaps status names by ID and removes a default without cascading the renames", async (t) => {
  const { agent: a } = await fixture(t);
  const options = [
    { id: "option_a", name: "Alpha", color: "default", group: "todo" },
    { id: "option_b", name: "Beta", color: "blue", group: "progress" },
    { id: "option_c", name: "Complete", color: "green", group: "complete" },
  ];
  let db = await a.create({ database: {
    properties: [{ id: STATUS, name: "Status", type: "status", status_options: options, default_status: "option_a" }],
    views: [
      { id: TABLE, name: "Alpha rows", kind: "table", filter: { property_id: STATUS, value: "Alpha" } },
      { id: "view_beta", name: "Beta rows", kind: "list", filter: { property_id: STATUS, value: "Beta" } },
    ],
  } });
  const alpha = await a.addRow(db, { title: "Was Alpha", properties: { [STATUS]: "Alpha" } });
  db = await a.get(db.id);
  const beta = await a.addRow(db, { title: "Was Beta", properties: { [STATUS]: "Beta" } });
  db = await a.get(db.id);
  const implicit = await a.addRow(db, { title: "Uses default" });
  const swapped = options.map((option) => ({ ...option, name: option.id === "option_a" ? "Beta" : option.id === "option_b" ? "Alpha" : option.name }));
  db = await a.patchProperty(await a.get(db.id), STATUS, { status_options: swapped });
  assert.equal(property(db, STATUS).default_status, "option_a");
  assert.equal(view(db, TABLE).filter.value, "Beta");
  assert.equal(view(db, "view_beta").filter.value, "Alpha");
  let all = await a.query(db.id, { viewId: TABLE, filter: null });
  assert.equal(all.rows.find((entry: Json) => entry.id === alpha.id).page.properties[STATUS], "Beta");
  assert.equal(all.rows.find((entry: Json) => entry.id === beta.id).page.properties[STATUS], "Alpha");
  assert.equal(all.rows.find((entry: Json) => entry.id === implicit.id).values[STATUS], "Beta");
  db = await a.patchProperty(db, STATUS, { status_options: swapped.filter((option) => option.id !== "option_a") });
  assert.equal(property(db, STATUS).default_status, undefined);
  assert.equal(view(db, TABLE).filter ?? null, null);
  assert.equal(view(db, "view_beta").filter.value, "Alpha");
  all = await a.query(db.id, { viewId: TABLE });
  assert.equal(all.total, 3);
  assert.equal(all.rows.find((entry: Json) => entry.id === alpha.id).page.properties?.[STATUS] ?? "", "");
  assert.ok(all.rows.every((entry: Json) => entry.values[STATUS] === "Alpha"));
});

test("UC-14: property type changes preserve raw values, discover options and clear unusable filters", async (t) => {
  const { agent: a } = await fixture(t);
  let db = await a.create({ database: { properties: [{ id: UC, name: "Custom label", type: "text", icon: "hash" }], views: [{ id: TABLE, name: "Table", kind: "table" }] } });
  const first = await a.addRow(db, { title: "First", properties: { [UC]: "Needs review" } });
  db = await a.get(db.id);
  const second = await a.addRow(db, { title: "Second", properties: { [UC]: "Blocked" } });
  db = await a.get(db.id);
  db = await a.patchProperty(db, UC, { type: "select" });
  assert.deepEqual(new Set(property(db, UC).options), new Set(["Needs review", "Blocked"]));
  assert.equal(property(db, UC).name, "Custom label"); assert.equal(property(db, UC).icon, "hash");
  db = await a.patchView(db, TABLE, { filter: { property_id: UC, value: "Needs review" } });
  assert.deepEqual(ids(await a.query(db.id, { viewId: TABLE })), [first.id]);
  db = await a.patchProperty(db, UC, { type: "status" });
  assert.ok(property(db, UC).status_options.some((option: Json) => option.name === "Needs review"));
  assert.ok(property(db, UC).status_options.some((option: Json) => option.name === "Blocked"));
  const options = structuredClone(property(db, UC).status_options);
  assert.deepEqual(ids(await a.query(db.id, { viewId: TABLE })), [first.id]);
  db = await a.patchProperty(db, UC, { type: "text" });
  assert.equal(view(db, TABLE).filter ?? null, null);
  const all = await a.query(db.id, { viewId: TABLE });
  assert.deepEqual(ids(all), [first.id, second.id]);
  assert.deepEqual(all.rows.map((entry: Json) => entry.page.properties[UC]), ["Needs review", "Blocked"]);
  db = await a.patchProperty(db, UC, { type: "status" });
  assert.deepEqual(property(db, UC).status_options, options);
  assert.deepEqual((await a.query(db.id)).rows.map((entry: Json) => entry.values[UC]), ["Needs review", "Blocked"]);
});

// AC-07: reject stale metadata and both stale row bases without partial writes.
test("UC-14: checks database and row revisions and preserves concurrent body edits", async (t) => {
  const { agent: a } = await fixture(t);
  let db = await a.create({ database: ucConfig() });
  let entry = await a.addRow(db, { title: "Original", text: "Original body", properties: { [UC]: "UC-14" } });
  db = await a.get(db.id);
  const oldDb = db;
  db = await a.patchProperty(db, UC, { name: "Renamed" });
  const staleRequests: Array<[string, Json]> = [
    [`/databases/${db.id}/properties`, { property: { id: "property_stale", name: "Stale", type: "text" } }],
    [`/databases/${db.id}/properties/${UC}`, { property: { name: "Stale" } }],
    [`/databases/${db.id}/views`, { view: { id: "view_stale", name: "Stale", kind: "list" } }],
    [`/databases/${db.id}/views/${TABLE}`, { view: { name: "Stale" } }],
    [`/databases/${db.id}/rows`, { title: "Must not exist" }],
  ];
  for (const [path, body] of staleRequests) ok(await a.request(path, { method: path.endsWith(`/${UC}`) || path.endsWith(`/${TABLE}`) ? "PATCH" : "POST", body: { requestId: randomUUID(), baseRevision: oldDb.revision, ...body } }), 409);
  ok(await a.request(`/databases/${db.id}/rows/${entry.id}`, { method: "PATCH", body: { requestId: randomUUID(), baseRevision: entry.revision, databaseRevision: oldDb.revision, title: "Must roll back", properties: { [UC]: "Stale database" } } }), 409);
  assert.deepEqual(await a.get(db.id), db);
  const bodyRead = dto(ok(await a.request(`/pages/${entry.id}`)));
  const block = Object.values(bodyRead.page.block_tree.by_id).find((value: Json) => value.kind === "text") as Json;
  const bodyEdit = dto(ok(await a.request(`/pages/${entry.id}/operations`, { method: "POST", body: { requestId: randomUUID(), generation: bodyRead.collaboration.generation, mode: "apply", operations: [{ type: "insert_text", blockId: block.id, index: "end", text: " + concurrent" }] } })));
  db = await a.get(db.id);
  ok(await a.request(`/databases/${db.id}/rows/${entry.id}`, { method: "PATCH", body: { requestId: randomUUID(), baseRevision: entry.revision, databaseRevision: db.revision, title: "Stale row", properties: { [UC]: "Lost update" } } }), 409);
  entry = await a.updateRow(db, bodyEdit, { title: "Current title", properties: { [UC]: "UC-15" } });
  assert.equal(entry.text, "Original body + concurrent");
  assert.equal(entry.title, "Current title"); assert.equal(entry.values[UC], "UC-15");
  assert.equal((await a.query(db.id)).total, 1);
});

test("UC-14: every new write requires requestId and rejects unknown fields without content changes", async (t) => {
  const { agent: a, owner } = await fixture(t);
  const db = await a.create({ database: ucConfig() });
  const entry = await a.addRow(db, { title: "Existing" });
  const current = await a.get(db.id);
  const before = ok(await owner.request("/api/records/personal/pages"));
  const writes: Array<[string, string, Json]> = [
    ["POST", "/databases", { title: "Missing ID" }],
    ["POST", `/databases/${db.id}/properties`, { baseRevision: current.revision, property: { id: "property_new", name: "New", type: "text" } }],
    ["PATCH", `/databases/${db.id}/properties/${UC}`, { baseRevision: current.revision, property: { name: "Changed" } }],
    ["POST", `/databases/${db.id}/views`, { baseRevision: current.revision, view: { id: "view_new", name: "New", kind: "list" } }],
    ["PATCH", `/databases/${db.id}/views/${TABLE}`, { baseRevision: current.revision, view: { name: "Changed" } }],
    ["POST", `/databases/${db.id}/rows`, { baseRevision: current.revision, title: "New" }],
    ["PATCH", `/databases/${db.id}/rows/${entry.id}`, { baseRevision: entry.revision, databaseRevision: current.revision, title: "Changed" }],
  ];
  for (const [method, path, body] of writes) {
    invalid(await a.request(path, { method, body }));
    invalid(await a.request(path, { method, body: { ...body, requestId: randomUUID(), unsupported: true } }));
  }
  assert.deepEqual(ok(await owner.request("/api/records/personal/pages")), before);
});

// AC-05: this guards the original silent downgrade through /pages.
test("UC-14: pages rejects database fields strictly and retains normal document creation and patch", async (t) => {
  const { agent: a, owner } = await fixture(t);
  for (const extra of [{ kind: "database", database: ucConfig() }, { properties: { [UC]: "UC-14" } }, { unsupported: true }]) {
    invalid(await a.request("/pages", { method: "POST", body: { title: "Must not downgrade", ...extra } }));
  }
  assert.deepEqual(ok(await owner.request("/api/records/personal/pages")), []);
  let doc = await document(a, { title: "Normal", text: "Before" });
  const before = structuredClone(doc);
  for (const extra of [{ kind: "database" }, { database: ucConfig() }, { properties: { [UC]: "UC-14" } }, { unsupported: true }]) {
    invalid(await a.request(`/pages/${doc.id}`, { method: "PATCH", body: { baseRevision: doc.revision, title: "Must roll back", ...extra } }));
  }
  assert.deepEqual(ok(await a.request(`/pages/${doc.id}`)), before);
  doc = dto(ok(await a.request(`/pages/${doc.id}`, { method: "PATCH", body: { baseRevision: doc.revision, title: "After", text: "Still a document" } })));
  assert.equal(doc.page.kind, "document"); assert.equal(doc.title, "After"); assert.equal(doc.text, "Still a document");
});

test("UC-14: invalid definitions, references and typed values are atomic and preserve earlier rows", async (t) => {
  const { agent: a, owner } = await fixture(t);
  for (const databaseInput of [
    { properties: [{ id: "name", name: "Reserved", type: "text" }] },
    { properties: [{ id: UC, name: "A", type: "text" }, { id: UC, name: "B", type: "text" }] },
    { properties: [{ id: UC, name: "Bad type", type: "formula" }] },
    { properties: [], views: [{ id: TABLE, name: "Bad", kind: "timeline" }] },
    { properties: [], views: [{ id: TABLE, name: "A", kind: "table" }, { id: TABLE, name: "B", kind: "list" }] },
    { properties: [], unsupported: true },
  ]) invalid(await a.request("/databases", { method: "POST", body: { requestId: randomUUID(), title: "Rejected", database: databaseInput } }));
  assert.deepEqual(ok(await owner.request("/api/records/personal/pages")), []);
  let db = await a.create({ database: ucConfig() });
  const saved = await a.addRow(db, { title: "Keep this row", text: "Keep this body", properties: { [UC]: "UC-14", [DATE]: "2024-02-29", [PERSON]: "王小明（外部顾问）" } });
  assert.equal(saved.values[PERSON], "王小明（外部顾问）");
  db = await a.get(db.id);
  const before = await a.query(db.id);
  const pagesBefore = ok(await owner.request("/api/records/personal/pages"));
  const blocksBefore = ok(await owner.request("/api/records/personal/blocks"));
  for (const properties of [
    { missing: "not a column" }, { [PRIORITY]: "P9" }, { [STATUS]: "not-started" },
    { [DATE]: "2026-02-29" }, { [DATE]: "2026-04-31" }, { [DATE]: "2026-1-01" },
    { [PERSON]: { id: "not-a-display-name" } }, { [IMAGE]: "files/picture.png" },
  ]) {
    invalid(await a.request(`/databases/${db.id}/rows`, { method: "POST", body: { requestId: randomUUID(), baseRevision: db.revision, title: "Rejected", text: "No orphan body", properties } }));
    invalid(await a.request(`/databases/${db.id}/rows/${saved.id}`, { method: "PATCH", body: { requestId: randomUUID(), baseRevision: saved.revision, databaseRevision: db.revision, title: "Must roll back", properties: { [UC]: "Must roll back", ...properties } } }));
  }
  invalid(await a.request(`/databases/${db.id}/properties`, { method: "POST", body: { requestId: randomUUID(), baseRevision: db.revision, property: { id: UC, name: "Duplicate", type: "text" } } }));
  invalid(await a.request(`/databases/${db.id}/views`, { method: "POST", body: { requestId: randomUUID(), baseRevision: db.revision, view: { id: TABLE, name: "Duplicate", kind: "table" } } }));
  invalid(await a.request(`/databases/${db.id}/properties/${UC}`, { method: "PATCH", body: { requestId: randomUUID(), baseRevision: db.revision, property: { id: "replacement", name: "Must roll back" } } }));
  invalid(await a.request(`/databases/${db.id}/rows/${saved.id}`, { method: "PATCH", body: { requestId: randomUUID(), baseRevision: saved.revision, databaseRevision: db.revision, text: "Use operations instead" } }));
  for (const query of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { viewId: "missing" }, { filter: { property_id: "missing", value: "x" } }, { sorts: [{ property_id: "missing", direction: "asc" }] }]) {
    const reply = await a.request(`/databases/${db.id}/query`, { method: "POST", body: query });
    // A missing view may use the existing resource-not-found convention.
    if (query.viewId) assert.ok([400, 404].includes(reply.status), JSON.stringify(reply.body));
    else invalid(reply);
  }
  assert.deepEqual(await a.get(db.id), db);
  assert.deepEqual(await a.query(db.id), before);
  assert.deepEqual(ok(await owner.request("/api/records/personal/pages")), pagesBefore);
  assert.deepEqual(ok(await owner.request("/api/records/personal/blocks")), blocksBefore);
  const cleared = await a.updateRow(db, saved, { properties: { [DATE]: null, [PERSON]: "", [UC]: null } });
  assert.equal(cleared.values[DATE], ""); assert.equal(cleared.values[PERSON], ""); assert.equal(cleared.values[UC], "");
  assert.equal(cleared.text, "Keep this body");
});

// AC-06: replay keeps the first response, including 201, across all write routes.
test("UC-14: account-wide request IDs replay every write, conflict across endpoints and survive restart", async (t) => {
  const f = await fixture(t); const a = f.agent;
  const createBody = { requestId: "stable-create", title: "Replay database", database: ucConfig() };
  const createdReply = await a.request("/databases", { method: "POST", body: createBody });
  let db = database(ok(createdReply, 201));
  const accepted: Array<{ path: string; method: string; body: Json; reply: Reply }> = [{ path: "/databases", method: "POST", body: createBody, reply: createdReply }];
  const perform = async (path: string, method: string, body: Json, expected: number): Promise<Json> => {
    const reply = await a.request(path, { method, body }); const value = ok(reply, expected);
    assert.deepEqual(await a.request(path, { method, body }), reply);
    accepted.push({ path, method, body, reply });
    return value;
  };
  db = database(await perform(`/databases/${db.id}/properties`, "POST", { requestId: "stable-property", baseRevision: db.revision, property: { id: "property_note", name: "Note", type: "text" } }, 201));
  db = database(await perform(`/databases/${db.id}/properties/property_note`, "PATCH", { requestId: "stable-property-patch", baseRevision: db.revision, property: { name: "Renamed note" } }, 200));
  db = database(await perform(`/databases/${db.id}/views`, "POST", { requestId: "stable-view", baseRevision: db.revision, view: { id: "view_new", name: "New", kind: "list" } }, 201));
  db = database(await perform(`/databases/${db.id}/views/view_new`, "PATCH", { requestId: "stable-view-patch", baseRevision: db.revision, view: { name: "Renamed view" } }, 200));
  let entry = row(await perform(`/databases/${db.id}/rows`, "POST", { requestId: "stable-row", baseRevision: db.revision, title: "One row", properties: { [UC]: "UC-14" } }, 201), db.id);
  db = await a.get(db.id);
  entry = row(await perform(`/databases/${db.id}/rows/${entry.id}`, "PATCH", { requestId: "stable-row-patch", baseRevision: entry.revision, databaseRevision: db.revision, title: "Later title", properties: { [UC]: "UC-15" } }, 200), db.id);
  ok(await a.request("/databases", { method: "POST", body: { ...createBody, title: "Different content" } }), 409);
  db = await a.get(db.id);
  ok(await a.request(`/databases/${db.id}/rows`, { method: "POST", body: { requestId: createBody.requestId, baseRevision: db.revision, title: "Cross endpoint" } }), 409);
  const otherDb = await a.create({ title: "Other database" });
  ok(await a.request(`/databases/${otherDb.id}/rows`, { method: "POST", body: { requestId: "stable-row", baseRevision: otherDb.revision, title: "Cross target" } }), 409);
  const before = await a.get(db.id); const rowsBefore = await a.query(db.id);
  await f.restart();
  for (const request of accepted) assert.deepEqual(await a.request(request.path, { method: request.method, body: request.body }), request.reply);
  assert.deepEqual(await a.get(db.id), before);
  assert.deepEqual(await a.query(db.id), rowsBefore);
  assert.equal(rowsBefore.total, 1); assert.equal(rowsBefore.rows[0].title, "Later title");
  assert.equal((await a.query(otherDb.id)).total, 0);
  const pages = ok(await a.request("/pages"));
  assert.equal(pages.filter((entry: Json) => entry.id === db.id).length, 1);
  const bob = f.browser(); await register(bob, "bob");
  const bobToken = await makeToken(bob, "write");
  const otherAccount = new Agent(f.browser(), bobToken.token);
  const own = await otherAccount.create(createBody);
  assert.notEqual(own.id, db.id, "Request IDs are scoped to the account");
});

test("UC-14: concurrent identical retries create one database and one row", async (t) => {
  const { agent: a } = await fixture(t);
  const input = { requestId: "raced-create", title: "One database" };
  const replies = await Promise.all(Array.from({ length: 3 }, () => a.request("/databases", { method: "POST", body: input })));
  replies.forEach((reply) => { database(ok(reply, 201)); assert.deepEqual(reply, replies[0]); });
  const db = replies[0].body;
  const rowInput = { requestId: "raced-row", baseRevision: db.revision, title: "One row" };
  const rows = await Promise.all(Array.from({ length: 3 }, () => a.request(`/databases/${db.id}/rows`, { method: "POST", body: rowInput })));
  rows.forEach((reply) => { row(ok(reply, 201), db.id); assert.deepEqual(reply, rows[0]); });
  assert.equal((await a.query(db.id)).total, 1);
});

// AC-04/08: read-only POST query remains read-only, with no browser cookie.
test("UC-14: read-only tokens may GET and POST query but cannot use any database write route", async (t) => {
  const f = await fixture(t); const a = f.agent;
  let db = await a.create({ database: ucConfig() });
  const entry = await a.addRow(db, { title: "Visible row", properties: { [UC]: "UC-14" } });
  db = await a.get(db.id);
  const readToken = await makeToken(f.owner, "read");
  const reader = new Agent(f.browser(), readToken.token);
  const before = await a.query(db.id);
  assert.deepEqual(await reader.get(db.id), db);
  assert.deepEqual(await reader.query(db.id, { viewId: TABLE }), before);
  const writes: Array<[string, string, Json]> = [
    ["POST", "/databases", { title: "Forbidden" }],
    ["POST", `/databases/${db.id}/properties`, { property: { id: "property_forbidden", name: "Forbidden", type: "text" } }],
    ["PATCH", `/databases/${db.id}/properties/${UC}`, { property: { name: "Forbidden" } }],
    ["POST", `/databases/${db.id}/views`, { view: { id: "view_forbidden", name: "Forbidden", kind: "list" } }],
    ["PATCH", `/databases/${db.id}/views/${TABLE}`, { view: { name: "Forbidden" } }],
    ["POST", `/databases/${db.id}/rows`, { title: "Forbidden" }],
    ["PATCH", `/databases/${db.id}/rows/${entry.id}`, { title: "Forbidden", databaseRevision: db.revision }],
  ];
  for (const [method, path, body] of writes) denied(await reader.request(path, { method, body: { requestId: randomUUID(), ...(path === "/databases" ? {} : { baseRevision: method === "PATCH" && path.includes("/rows/") ? entry.revision : db.revision }), ...body } }));
  assert.deepEqual(await a.get(db.id), db);
  assert.deepEqual(await a.query(db.id), before);
  ok(await f.owner.request(`/api/tokens/${readToken.id}`, { method: "DELETE" }));
  ok(await reader.request(`/databases/${db.id}/query`, { method: "POST", body: {} }), 401);
});

test("UC-14: private databases and rows stay isolated even from another site admin", async (t) => {
  const f = await fixture(t); const a = f.agent;
  const db = await a.create({ database: ucConfig() });
  const entry = await a.addRow(db, { title: "Private row", properties: { [UC]: "Secret" } });
  const other = f.browser(); const otherUser = await register(other, "other");
  ok(await f.owner.request(`/api/admin/users/${otherUser.id}`, { method: "PATCH", body: { siteRole: "admin" } }));
  const bearer = await makeToken(other, "write"); const intruder = new Agent(f.browser(), bearer.token);
  denied(await intruder.request(`/databases/${db.id}`));
  denied(await intruder.request(`/databases/${db.id}/query`, { method: "POST", body: {} }));
  denied(await intruder.request(`/pages/${entry.id}`));
  denied(await intruder.request(`/databases/${db.id}/rows`, { method: "POST", body: { requestId: randomUUID(), baseRevision: db.revision, title: "Intruder" } }));
  denied(await intruder.request(`/databases/${db.id}/rows/${entry.id}`, { method: "PATCH", body: { requestId: randomUUID(), baseRevision: entry.revision, databaseRevision: db.revision, title: "Stolen" } }));
  denied(await intruder.request("/databases", { method: "POST", body: { requestId: randomUUID(), parentId: db.id, title: "Foreign child" } }));
  assert.equal((await intruder.query((await intruder.create({ title: "Own" })).id)).total, 0);
  assert.equal((await a.query(db.id)).rows[0].values[UC], "Secret");
});

test("UC-14: shared editors create under an existing parent, viewers cannot write, and revoked replays fail", async (t) => {
  const f = await fixture(t); const a = f.agent;
  const editor = f.browser(); const editorUser = await register(editor, "editor");
  const space = ok(await f.owner.request("/api/spaces", { method: "POST", body: { name: "Shared UC" } }), 201);
  const scope = space.spaceId;
  const parent = await document(a, { title: "Shared parent", spaceId: scope });
  await invite(f.owner, editor, scope, "editor", "editor");
  const bearer = await makeToken(editor, "write"); const e = new Agent(f.browser(), bearer.token);
  const createBody = { requestId: "shared-create", title: "Shared database", parentId: parent.id, database: ucConfig() };
  const created = await e.request("/databases", { method: "POST", body: createBody });
  let db = database(ok(created, 201));
  assert.equal(db.collaboration.scope, scope); assert.equal(db.page.parent_id, parent.id);
  assert.deepEqual(await a.get(db.id), db);
  const rowBody = { requestId: "shared-row", baseRevision: db.revision, title: "Shared row", properties: { [UC]: "UC-14" } };
  const first = await e.request(`/databases/${db.id}/rows`, { method: "POST", body: rowBody });
  let entry = row(ok(first, 201), db.id); assert.equal(entry.collaboration.scope, scope);
  db = await e.get(db.id);
  entry = await e.updateRow(db, entry, { title: "Editor updated", properties: { [UC]: "UC-15" } });
  denied(await editor.request(`/api/spaces/${scope}/members/${editorUser.id}`, { method: "PATCH", body: { role: "admin" } }));
  denied(await e.browser.request(`/api/spaces/${scope}/members/${editorUser.id}`, { method: "PATCH", token: e.token, body: { role: "admin" } }));
  ok(await f.owner.request(`/api/spaces/${scope}/members/${editorUser.id}`, { method: "PATCH", body: { role: "viewer" } }));
  assert.equal((await e.query(db.id)).total, 1);
  denied(await e.request("/databases", { method: "POST", body: createBody }));
  denied(await e.request(`/databases/${db.id}/rows`, { method: "POST", body: rowBody }));
  db = await a.get(db.id);
  denied(await e.request(`/databases/${db.id}/properties/${UC}`, { method: "PATCH", body: { requestId: randomUUID(), baseRevision: db.revision, property: { name: "Viewer edit" } } }));
  denied(await e.request(`/databases/${db.id}/rows/${entry.id}`, { method: "PATCH", body: { requestId: randomUUID(), baseRevision: entry.revision, databaseRevision: db.revision, title: "Viewer edit" } }));
  ok(await f.owner.request(`/api/spaces/${scope}/members/${editorUser.id}`, { method: "DELETE" }));
  denied(await e.request(`/databases/${db.id}`));
  denied(await e.request(`/databases/${db.id}/query`, { method: "POST", body: {} }));
  denied(await e.request("/databases", { method: "POST", body: createBody }));
  denied(await e.request(`/databases/${db.id}/rows`, { method: "POST", body: rowBody }));
  const kept = await a.query(db.id);
  assert.equal(kept.total, 1); assert.equal(kept.rows[0].title, "Editor updated"); assert.equal(kept.rows[0].values[UC], "UC-15");
});

test("UC-14: revoked tokens cannot replay a previously successful database creation", async (t) => {
  const f = await fixture(t);
  const input = { requestId: "revoke-token-create", title: "Kept database" };
  const first = database(ok(await f.agent.request("/databases", { method: "POST", body: input }), 201));
  ok(await f.owner.request(`/api/tokens/${f.writer.id}`, { method: "DELETE" }));
  ok(await f.agent.request("/databases", { method: "POST", body: input }), 401);
  const replacement = await makeToken(f.owner, "write"); const a = new Agent(f.browser(), replacement.token);
  assert.deepEqual(await a.get(first.id), first);
  assert.deepEqual(ok(await a.request("/databases", { method: "POST", body: input }), 201), first);
});

test("UC-14: row updates reject another database's row without changing either database", async (t) => {
  const { agent: a } = await fixture(t);
  const left = await a.create({ database: ucConfig() }); const right = await a.create({ database: ucConfig() });
  const entry = await a.addRow(left, { title: "Left row", properties: { [UC]: "UC-14" } });
  const before = await a.query(left.id);
  const reply = await a.request(`/databases/${right.id}/rows/${entry.id}`, { method: "PATCH", body: { requestId: randomUUID(), baseRevision: entry.revision, databaseRevision: right.revision, title: "Moved by mistake", properties: { [UC]: "Wrong database" } } });
  assert.ok([400, 404].includes(reply.status), `Row membership must be checked: ${JSON.stringify(reply.body)}`);
  assert.deepEqual(await a.query(left.id), before);
  assert.equal((await a.query(right.id)).total, 0);
  assert.deepEqual(await a.get(right.id), right);
});

test("UC-14: archived rows and content below an archived ancestor cannot be edited", async (t) => {
  const f = await fixture(t); const a = f.agent;
  const root = await document(a);
  let db = await a.create({ parentId: root.id, database: ucConfig() });
  const hidden = await a.addRow(db, { title: "Archived row", properties: { [UC]: "Old" } });
  db = await a.get(db.id);
  const live = await a.addRow(db, { title: "Still live", properties: { [UC]: "Current" } });
  await archive(f.owner, dto(ok(await a.request(`/pages/${hidden.id}`))));
  assert.deepEqual(ids(await a.query(db.id)), [live.id]);
  const archivedReply = await a.request(`/databases/${db.id}/rows/${hidden.id}`, { method: "PATCH", body: { requestId: randomUUID(), baseRevision: hidden.revision, databaseRevision: (await a.get(db.id)).revision, title: "Resurrected" } });
  assert.ok([400, 403, 404, 409].includes(archivedReply.status), JSON.stringify(archivedReply.body));
  db = await a.get(db.id);
  await archive(f.owner, dto(ok(await a.request(`/pages/${root.id}`))));
  const writes: Array<[string, string, Json]> = [
    ["POST", "/databases", { parentId: db.id, title: "Under archived ancestor" }],
    ["POST", `/databases/${db.id}/properties`, { property: { id: "property_archived", name: "Forbidden", type: "text" } }],
    ["PATCH", `/databases/${db.id}/properties/${UC}`, { property: { name: "Forbidden" } }],
    ["POST", `/databases/${db.id}/views`, { view: { id: "view_archived", name: "Forbidden", kind: "list" } }],
    ["PATCH", `/databases/${db.id}/views/${TABLE}`, { view: { name: "Forbidden" } }],
    ["POST", `/databases/${db.id}/rows`, { title: "Forbidden" }],
    ["PATCH", `/databases/${db.id}/rows/${live.id}`, { title: "Forbidden", databaseRevision: db.revision }],
  ];
  const before = ok(await f.owner.request("/api/records/personal/pages"));
  for (const [method, path, body] of writes) {
    const reply = await a.request(path, { method, body: { requestId: randomUUID(), ...(path === "/databases" ? {} : { baseRevision: path.includes("/rows/") ? live.revision : db.revision }), ...body } });
    assert.ok([400, 403, 404, 409].includes(reply.status), `Archived ancestor must prevent writing: ${JSON.stringify(reply.body)}`);
  }
  assert.deepEqual(ok(await f.owner.request("/api/records/personal/pages")), before);
});

// Image references use browser-uploaded fixtures. No new Agent upload route is assumed.
test("UC-14: image cells bind existing same-scope files and reject forged or missing metadata atomically", async (t) => {
  const f = await fixture(t); const a = f.agent;
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");
  const path = "files/uc-image.png";
  ok(await f.owner.request(`/api/files/personal?path=${encodeURIComponent(path)}`, { method: "PUT", raw: bytes, contentType: "image/png" }));
  const file = { path, owner: f.user.id, name: "uc-image.png", size: bytes.length, type: "image/png" };
  let db = await a.create({ database: ucConfig() });
  let entry = await a.addRow(db, { title: "With image", properties: { [UC]: "UC-14" }, propertyFiles: { [IMAGE]: [file] } });
  assert.deepEqual(entry.page.property_files[IMAGE], [file]);
  assert.equal(Object.hasOwn(entry.values, IMAGE), false);
  db = await a.get(db.id);
  assert.deepEqual((await a.query(db.id)).rows[0].page.property_files[IMAGE], [file]);
  const stranger = f.browser(); const strangerUser = await register(stranger, "stranger");
  const space = ok(await f.owner.request("/api/spaces", { method: "POST", body: { name: "Other file scope" } }), 201);
  ok(await f.owner.request(`/api/files/${space.spaceId}?path=${encodeURIComponent(path)}`, { method: "PUT", raw: bytes, contentType: "image/png" }));
  const attempts = [
    { [IMAGE]: [{ ...file, path: "files/missing.png" }] },
    { [IMAGE]: [{ ...file, owner: strangerUser.id }] },
    { [IMAGE]: [{ ...file, size: file.size + 1 }] },
    { [IMAGE]: [{ ...file, type: "image/jpeg" }] },
    { [IMAGE]: [{ ...file, width: 10 }] },
    { [IMAGE]: [{ ...file, space: space.spaceId }] },
    { [UC]: [file] }, { missing: [file] },
  ];
  const before = await a.query(db.id);
  for (const propertyFiles of attempts) {
    const created = await a.request(`/databases/${db.id}/rows`, { method: "POST", body: { requestId: randomUUID(), baseRevision: db.revision, title: "Must not exist", propertyFiles } });
    assert.ok([400, 403, 404].includes(created.status), JSON.stringify(created.body));
    const changed = await a.request(`/databases/${db.id}/rows/${entry.id}`, { method: "PATCH", body: { requestId: randomUUID(), baseRevision: entry.revision, databaseRevision: db.revision, title: "Must roll back", properties: { [UC]: "Must roll back" }, propertyFiles } });
    assert.ok([400, 403, 404].includes(changed.status), JSON.stringify(changed.body));
  }
  assert.deepEqual(await a.query(db.id), before);
  assert.deepEqual(await a.get(db.id), db);
  entry = await a.updateRow(db, entry, { propertyFiles: { [IMAGE]: [] } });
  assert.deepEqual(entry.page.property_files?.[IMAGE] ?? [], []);
  assert.equal(entry.values[UC], "UC-14");
  const sharedParent = await document(a, { spaceId: space.spaceId });
  const shared = await a.create({ parentId: sharedParent.id, database: ucConfig() });
  const sharedFile = { ...file, space: space.spaceId };
  const sharedRow = await a.addRow(shared, { title: "Shared image", propertyFiles: { [IMAGE]: [sharedFile] } });
  assert.deepEqual(sharedRow.page.property_files[IMAGE], [sharedFile]);
  const strangerToken = await makeToken(stranger, "write"); const outsider = new Agent(f.browser(), strangerToken.token);
  const strangerDb = await outsider.create({ database: ucConfig() });
  const unauthorized = await outsider.request(`/databases/${strangerDb.id}/rows`, { method: "POST", body: { requestId: randomUUID(), baseRevision: strangerDb.revision, title: "Foreign image", propertyFiles: { [IMAGE]: [file] } } });
  assert.ok([400, 403, 404].includes(unauthorized.status), JSON.stringify(unauthorized.body));
  assert.equal((await outsider.query(strangerDb.id)).total, 0);
});

// UC-22 batch 1: new property types, option colors, multi-select, date
// ranges, read-only meta columns and per-type value validation.
test("UC-22: adds each new property type, colors options and validates per-type row values", async (t) => {
  const { agent: a } = await fixture(t);
  let db = await a.create({ database: {
    title_name: "项目",
    properties: [
      { id: "property_amount", name: "金额", type: "number" },
      { id: "property_done", name: "完成", type: "checkbox" },
      { id: "property_tags", name: "标签", type: "multi_select", options: ["急", "发版"], option_colors: { "急": "red" } },
      { id: "property_site", name: "站点", type: "url" },
      { id: "property_mail", name: "邮箱", type: "email" },
      { id: "property_tel", name: "电话", type: "phone" },
      { id: "property_span", name: "排期", type: "date" },
      { id: "property_created", name: "创建时间", type: "created_time" },
      { id: "property_edited", name: "编辑时间", type: "last_edited_time" },
      { id: "property_maker", name: "创建者", type: "created_by" },
      { id: "property_editor", name: "编辑者", type: "last_edited_by" },
      { id: "property_id", name: "编号", type: "id" },
    ],
  } });
  assert.equal(property(db, "property_tags").type, "multi_select");
  assert.deepEqual(property(db, "property_tags").option_colors, { "急": "red" });

  // Each remaining type is also addable after creation.
  db = await a.addProperty(db, { id: "property_note", name: "备注", type: "text" });
  assert.equal(property(db, "property_note").type, "text");

  // Colors are set and read back; an unknown option name is refused.
  db = await a.patchProperty(db, "property_tags", { option_colors: { "急": "orange", "发版": "green" } });
  assert.deepEqual(property(db, "property_tags").option_colors, { "急": "orange", "发版": "green" });
  const stale = await a.get(db.id);
  invalid(await a.request(`/databases/${db.id}/properties/property_tags`, { method: "PATCH", body: { requestId: randomUUID(), baseRevision: stale.revision, property: { option_colors: { "不存在": "blue" } } } }));
  assert.deepEqual(property(await a.get(db.id), "property_tags").option_colors, { "急": "orange", "发版": "green" });
  invalid(await a.request(`/databases/${db.id}/properties`, { method: "POST", body: { requestId: randomUUID(), baseRevision: stale.revision, property: { id: "property_bad", name: "错色", type: "multi_select", options: ["A"], option_colors: { "B": "blue" } } } }));

  // A row exercising every new type; stored formats are the canonical ones.
  const row1 = await a.addRow(db, {
    title: "发布项目",
    properties: {
      property_amount: "12.5", property_done: "true",
      property_tags: JSON.stringify(["急", "发版"]),
      property_site: "https://notes.example", property_mail: "a@b.cc", property_tel: "+86 138",
      property_span: "2026-11-20/2026-11-28",
    },
  });
  assert.equal(row1.page.properties?.property_amount, "12.5");
  assert.equal(row1.page.properties?.property_done, "true");
  assert.equal(row1.page.properties?.property_tags, JSON.stringify(["急", "发版"]));
  assert.equal(row1.values.property_tags, JSON.stringify(["急", "发版"]));
  assert.equal(row1.page.properties?.property_span, "2026-11-20/2026-11-28");

  // Meta columns resolve from the row record: set, and the same set.
  assert.ok(row1.values.property_created);
  assert.ok(row1.values.property_edited);
  assert.ok(row1.values.property_maker);
  assert.ok(row1.values.property_editor);
  assert.equal(row1.values.property_id, row1.id);
  assert.equal(row1.page.properties?.property_created ?? undefined, undefined);

  // Comma-separated input normalizes to the JSON array; dedupe applies.
  db = await a.get(db.id);
  const row2 = await a.updateRow(db, row1, { properties: { property_tags: "发版,急,急" } });
  assert.equal(row2.page.properties?.property_tags, JSON.stringify(["发版", "急"]));

  // Per-type rejections: bad number, bad checkbox, unknown multi-select
  // option, bogus date, meta write — nothing lands.
  const attempts = [
    { property_amount: "abc" }, { property_amount: "12.5.3" },
    { property_done: "yes" }, { property_done: "1" },
    { property_tags: "不存在的选项" }, { property_tags: JSON.stringify(["急", "不存在的选项"]) },
    { property_span: "2026-02-30" }, { property_span: "2026-11-20/2026-13-40" }, { property_span: "2026-11-20/12-01" },
    { property_created: "2026-11-20" }, { property_id: "forged" }, { property_maker: "someone" },
  ];
  const before = await a.query(db.id);
  for (const properties of attempts) {
    const changed = await a.request(`/databases/${db.id}/rows/${row1.id}`, { method: "PATCH", body: { requestId: randomUUID(), baseRevision: row2.revision, databaseRevision: db.revision, properties } });
    assert.ok([400, 403, 404].includes(changed.status), `Expected rejection: ${JSON.stringify(properties)} got ${JSON.stringify(changed.body)}`);
  }
  assert.deepEqual(await a.query(db.id), before);

  // false normalizes to empty (unchecked); a reversed range is kept in order.
  const row3 = await a.updateRow(db, row2, { properties: { property_done: "false", property_span: "2026-11-28/2026-11-20" } });
  assert.equal(row3.page.properties?.property_done, "");
  assert.equal(row3.page.properties?.property_span, "2026-11-20/2026-11-28");
  const cleared = await a.updateRow(db, row3, { properties: { property_tags: "", property_amount: "" } });
  assert.equal(cleared.values.property_tags, "");
  assert.equal(cleared.values.property_amount, "");

  // JSON scalars coerce to the stored strings: apps write booleans,
  // numbers and arrays as values, not pre-flattened strings.
  const coerced = await a.updateRow(db, cleared, { properties: {
    property_done: true, property_amount: 7.5, property_tags: ["急", "发版"], property_note: 2026,
  } });
  assert.equal(coerced.page.properties?.property_done, "true");
  assert.equal(coerced.page.properties?.property_amount, "7.5");
  assert.equal(coerced.page.properties?.property_tags, JSON.stringify(["急", "发版"]));
  assert.equal(coerced.page.properties?.property_note, "2026");
  const unchecked = await a.updateRow(db, coerced, { properties: { property_done: false } });
  assert.equal(unchecked.page.properties?.property_done, "");
  const posted = await a.addRow(db, { title: "app 写入", properties: { property_done: true, property_amount: 42 } });
  assert.equal(posted.page.properties?.property_done, "true");
  assert.equal(posted.page.properties?.property_amount, "42");
});

// Issue #1: a schema rejection names the field and the reason in `error`,
// not only in `details` — apps surface `error` to their users directly.
test("bad_request carries the first field path in error", async (t) => {
  const { agent: a } = await fixture(t);
  const db = await a.create({ database: {
    properties: [{ id: "property_done", name: "完成", type: "checkbox" }],
    views: [{ id: TABLE, name: "表", kind: "table" }],
  } });
  // A nested object has no string reading; it still fails — but `error`
  // itself says where and why.
  const reply = await a.request(`/databases/${db.id}/rows`, {
    method: "POST",
    body: { requestId: randomUUID(), baseRevision: db.revision, title: "x", properties: { property_done: { nested: true } } },
  });
  const body = ok(reply, 400);
  assert.equal(body.code, "bad_request");
  assert.match(body.error, /properties\.property_done/);
  assert.ok(Array.isArray(body.details) && body.details.length > 0);
  // A missing required field names it too.
  const missing = ok(await a.request(`/databases/${db.id}/rows`, {
    method: "POST", body: { requestId: randomUUID(), title: "x" },
  }), 400);
  assert.match(missing.error, /baseRevision/);
});

// UC-22 batch 1: sorting follows each new type's own order.
test("UC-22: sorts numbers numerically, ranges by start day and unchecked before checked", async (t) => {
  const { agent: a } = await fixture(t);
  let db = await a.create({ database: {
    properties: [
      // Text first, so a word can live where a number will: typed before the
      // column had a type, it stays — and sorts after every number.
      { id: "property_amount", name: "金额", type: "text" },
      { id: "property_done", name: "完成", type: "checkbox" },
      { id: "property_span", name: "排期", type: "date" },
    ],
    views: [{ id: TABLE, name: "表", kind: "table" }],
  } });
  const high = await a.addRow(db, { title: "High", properties: { property_amount: "30", property_done: "true", property_span: "2026-11-25/2026-11-28" } });
  db = await a.get(db.id);
  const low = await a.addRow(db, { title: "Low", properties: { property_amount: "4", property_span: "2026-11-01/2026-11-03" } });
  db = await a.get(db.id);
  const text = await a.addRow(db, { title: "Text", properties: { property_amount: "soon", property_done: "true" } });
  db = await a.get(db.id);
  const empty = await a.addRow(db, { title: "Empty" });
  db = await a.patchProperty(db, "property_amount", { type: "number" });
  assert.equal(property(db, "property_amount").type, "number");
  // Numbers: 4 < 30, the non-numeric "soon" trails, empty stays last.
  assert.deepEqual(ids(await a.query(db.id, { sorts: [{ property_id: "property_amount", direction: "asc" }] })), [low.id, high.id, text.id, empty.id]);
  assert.deepEqual(ids(await a.query(db.id, { sorts: [{ property_id: "property_amount", direction: "desc" }] })), [high.id, low.id, text.id, empty.id]);
  // Ranges sit on their start day; unchecked sorts before checked.
  assert.deepEqual(ids(await a.query(db.id, { sorts: [{ property_id: "property_span", direction: "asc" }] })), [low.id, high.id, text.id, empty.id]);
  assert.deepEqual(ids(await a.query(db.id, { sorts: [{ property_id: "property_done", direction: "asc" }] })), [low.id, empty.id, high.id, text.id]);
});

// UC-22 batch 2: multi-condition filters AND together; the one group keeps
// its own or. Saved on a view they replace the old single `filter`.
test("UC-22: filters combine conditions and groups, save to the view and clear", async (t) => {
  const { agent: a } = await fixture(t);
  const stage = [
    { id: "option_design", name: "设计", color: "blue", group: "todo" },
    { id: "option_dev", name: "开发", color: "orange", group: "progress" },
    { id: "option_ship", name: "发布", color: "green", group: "complete" },
  ];
  let db = await a.create({ database: {
    properties: [
      { id: "property_stage", name: "阶段", type: "status", status_options: stage },
      { id: "property_amount", name: "金额", type: "number" },
      { id: "property_done", name: "完成", type: "checkbox" },
      { id: "property_tags", name: "标签", type: "multi_select", options: ["急", "发版"] },
      { id: "property_day", name: "排期", type: "date" },
      { id: "property_who", name: "负责人", type: "person" },
    ],
    views: [{ id: TABLE, name: "表", kind: "table" }],
  } });
  const small = await a.addRow(db, { title: "Small", properties: {
    property_stage: "设计", property_amount: "4", property_tags: JSON.stringify(["急"]),
    property_day: "2026-11-01/2026-11-03", property_who: "刘政东",
  } });
  db = await a.get(db.id);
  const big = await a.addRow(db, { title: "Big", properties: {
    property_stage: "开发", property_amount: "30", property_done: "true",
    property_tags: JSON.stringify(["急", "发版"]), property_day: "2026-11-25/2026-11-28",
  } });
  db = await a.get(db.id);
  const plain = await a.addRow(db, { title: "Plain" });
  db = await a.get(db.id);

  // Conditions on separate types AND: number gt AND stage is.
  assert.deepEqual(ids(await a.query(db.id, { filters: [
    { property_id: "property_amount", op: "gt", value: "10" },
    { property_id: "property_stage", op: "is", value: "开发" },
  ] })), [big.id]);
  // Checkbox holds only is; unchecked is value "false".
  assert.deepEqual(ids(await a.query(db.id, { filters: [{ property_id: "property_done", op: "is", value: "true" }] })), [big.id]);
  assert.deepEqual(ids(await a.query(db.id, { filters: [{ property_id: "property_done", op: "is", value: "false" }] })), [small.id, plain.id]);
  // Multi-select contains any one option; not_contains keeps unset rows.
  assert.deepEqual(ids(await a.query(db.id, { filters: [{ property_id: "property_tags", op: "contains", value: "发版" }] })), [big.id]);
  assert.deepEqual(ids(await a.query(db.id, { filters: [{ property_id: "property_tags", op: "not_contains", value: "急" }] })), [plain.id]);
  // Dates compare by day, a range on its start day.
  assert.deepEqual(ids(await a.query(db.id, { filters: [{ property_id: "property_day", op: "on_or_before", value: "2026-11-10" }] })), [small.id]);
  assert.deepEqual(ids(await a.query(db.id, { filters: [{ property_id: "property_day", op: "after", value: "2026-11-10" }] })), [big.id]);
  // Words: person matches contains; the empties ask for no value.
  assert.deepEqual(ids(await a.query(db.id, { filters: [{ property_id: "property_who", op: "contains", value: "刘" }] })), [small.id]);
  assert.deepEqual(ids(await a.query(db.id, { filters: [{ property_id: "property_amount", op: "is_empty" }] })), [plain.id]);
  assert.deepEqual(ids(await a.query(db.id, { filters: [{ property_id: "property_amount", op: "is_not_empty" }] })), [small.id, big.id]);
  // An absent operator keeps the empty row, as Notion's does: unchecked and
  // unset count as "not that"; a non-numeric cell still fails every number
  // comparison, even neq.
  assert.deepEqual(ids(await a.query(db.id, { filters: [{ property_id: "property_amount", op: "neq", value: "4" }] })), [big.id, plain.id]);
  // The group or-s inside; everything else still ANDs around it — the
  // default-staged unchecked row belongs to both sides of it.
  assert.deepEqual(ids(await a.query(db.id, { filters: [
    { logic: "or", conditions: [
      { property_id: "property_stage", op: "is", value: "设计" },
      { property_id: "property_amount", op: "gt", value: "10" },
    ] },
    { property_id: "property_done", op: "is", value: "false" },
  ] })), [small.id, plain.id]);
  // A saved filter is what a plain query uses; the old field is gone.
  db = await a.patchView(db, TABLE, { filters: [{ property_id: "property_stage", op: "is", value: "开发" }] });
  assert.deepEqual(view(db, TABLE).filters, [{ property_id: "property_stage", op: "is", value: "开发" }]);
  assert.equal(view(db, TABLE).filter ?? null, null);
  assert.deepEqual(ids(await a.query(db.id, { viewId: TABLE })), [big.id]);
  // A query's own filters outvote the saved ones; an empty list means none.
  assert.deepEqual(ids(await a.query(db.id, { viewId: TABLE, filters: [{ property_id: "property_amount", op: "is_empty" }] })), [plain.id]);
  assert.equal((await a.query(db.id, { viewId: TABLE, filters: [] })).total, 3);
  // The legacy field still writes and reads as one is — and clears both.
  db = await a.patchView(db, TABLE, { filter: { property_id: "property_stage", value: "设计" } });
  assert.equal(view(db, TABLE).filter.value, "设计");
  assert.equal(view(db, TABLE).filters ?? null, null);
  // The unchecked row fell to the stage's default — "设计" — so it matches.
  assert.deepEqual(ids(await a.query(db.id, { viewId: TABLE })), [small.id, plain.id]);
  db = await a.patchView(db, TABLE, { filter: null });
  assert.equal(view(db, TABLE).filter ?? null, null);
  assert.equal((await a.query(db.id, { viewId: TABLE })).total, 3);
});

test("UC-22: rejects malformed filter conditions and nested groups", async (t) => {
  const { agent: a } = await fixture(t);
  const db = await a.create({ database: {
    properties: [
      { id: "property_stage", name: "阶段", type: "status" },
      { id: "property_amount", name: "金额", type: "number" },
      { id: "property_done", name: "完成", type: "checkbox" },
      { id: "property_tags", name: "标签", type: "multi_select", options: ["急", "发版"] },
      { id: "property_pic", name: "图", type: "image" },
    ],
    views: [{ id: TABLE, name: "表", kind: "table" }],
  } });
  const attempts = [
    // An operator the type does not take.
    [{ property_id: "property_amount", op: "contains", value: "4" }],
    [{ property_id: "property_tags", op: "is", value: "急" }],
    [{ property_id: "property_done", op: "is_not", value: "true" }],
    // A value-hungry operator with nothing to compare to.
    [{ property_id: "property_amount", op: "gt" }],
    // The value is not one of the options, or not the checkbox's true/false.
    [{ property_id: "property_tags", op: "contains", value: "不存在的" }],
    [{ property_id: "property_done", op: "is", value: "yes" }],
    // A property that is not there, or holds no words — and the name column.
    [{ property_id: "property_missing", op: "is", value: "x" }],
    [{ property_id: "property_pic", op: "contains", value: "x" }],
    [{ property_id: "name", op: "contains", value: "x" }],
    // A group inside a group; two groups.
    [{ logic: "and", conditions: [{ logic: "and", conditions: [{ property_id: "property_amount", op: "gt", value: "0" }] }] }],
    [
      { logic: "and", conditions: [{ property_id: "property_amount", op: "gt", value: "0" }] },
      { logic: "or", conditions: [{ property_id: "property_amount", op: "lt", value: "9" }] },
    ],
  ];
  for (const filters of attempts) {
    invalid(await a.request(`/databases/${db.id}/query`, { method: "POST", body: { filters } }));
    invalid(await a.request(`/databases/${db.id}/views/${TABLE}`, { method: "PATCH", body: { requestId: randomUUID(), baseRevision: db.revision, view: { filters } } }));
  }
});

test("UC-22: views keep hidden columns, footer calcs and extended group_by", async (t) => {
  const { agent: a } = await fixture(t);
  let db = await a.create({ database: {
    properties: [
      { id: "property_amount", name: "金额", type: "number" },
      { id: "property_done", name: "完成", type: "checkbox" },
      { id: "property_tags", name: "标签", type: "multi_select", options: ["急", "发版"] },
      { id: "property_day", name: "排期", type: "date" },
      { id: "property_who", name: "负责人", type: "person" },
    ],
    views: [{ id: TABLE, name: "表", kind: "table" }],
  } });
  db = await a.patchView(db, TABLE, { hidden: ["property_amount", "property_who"], calcs: { name: "count", property_amount: "sum", property_done: "percent_checked" }, group_by: "property_who" });
  assert.deepEqual(view(db, TABLE).hidden, ["property_amount", "property_who"]);
  assert.deepEqual(view(db, TABLE).calcs, { name: "count", property_amount: "sum", property_done: "percent_checked" });
  assert.equal(view(db, TABLE).group_by, "property_who");
  // Empty collections and an empty group_by take the fields away.
  db = await a.patchView(db, TABLE, { hidden: [], calcs: {}, group_by: "" });
  assert.equal(view(db, TABLE).hidden ?? null, null);
  assert.equal(view(db, TABLE).calcs ?? null, null);
  assert.equal(view(db, TABLE).group_by ?? null, null);
  // Table and list group by the new types; not by the name column, nothing,
  // or an image — and a board still only takes status or select.
  for (const by of ["property_done", "property_tags", "property_day"]) {
    db = await a.patchView(db, TABLE, { group_by: by });
    assert.equal(view(db, TABLE).group_by, by);
  }
  for (const body of [{ group_by: "name" }, { group_by: "property_missing" }, { calcs: { name: "sum" } }, { calcs: { property_amount: "contains" } }, { calcs: { property_missing: "count" } }, { hidden: ["name"] }, { hidden: ["property_missing"] }]) {
    invalid(await a.request(`/databases/${db.id}/views/${TABLE}`, { method: "PATCH", body: { requestId: randomUUID(), baseRevision: db.revision, view: body } }));
  }
  db = await a.addProperty(db, { id: "property_pic", name: "图", type: "image" });
  invalid(await a.request(`/databases/${db.id}/views/${TABLE}`, { method: "PATCH", body: { requestId: randomUUID(), baseRevision: db.revision, view: { group_by: "property_pic" } } }));
  invalid(await a.request(`/databases/${db.id}/views`, { method: "POST", body: { requestId: randomUUID(), baseRevision: db.revision, view: { id: "view_board", name: "板", kind: "board", group_by: "property_done" } } }));
});

// UC-22 batch 2: renaming a status option rewrites the conditions naming it;
// removing the option drops them — a group shrinks to what remains.
test("UC-22: status option edits rewrite filter conditions, removals drop them", async (t) => {
  const { agent: a } = await fixture(t);
  const options = [
    { id: "option_a", name: "Alpha", color: "default", group: "todo" },
    { id: "option_b", name: "Beta", color: "blue", group: "progress" },
  ];
  let db = await a.create({ database: {
    properties: [
      { id: STATUS, name: "Status", type: "status", status_options: options },
      { id: "property_tags", name: "标签", type: "multi_select", options: ["急"] },
    ],
    views: [{ id: TABLE, name: "表", kind: "table", filters: [
      { property_id: STATUS, op: "is", value: "Beta" },
      { logic: "or", conditions: [
        { property_id: STATUS, op: "is", value: "Beta" },
        { property_id: "property_tags", op: "contains", value: "急" },
      ] },
    ] }],
  } });
  // Rename by stable id: both the plain condition's and the group's value.
  db = await a.patchProperty(db, STATUS, { status_options: options.map((option) => ({ ...option, name: option.id === "option_b" ? "Gamma" : option.name })) });
  const filters = view(db, TABLE).filters;
  assert.equal(filters[0].value, "Gamma");
  assert.equal(filters[1].conditions[0].value, "Gamma");
  assert.equal(filters[1].conditions[1].value, "急");
  // Remove the option: its conditions go; the group keeps what remains.
  db = await a.patchProperty(db, STATUS, { status_options: options.filter((option) => option.id === "option_a") });
  assert.deepEqual(view(db, TABLE).filters, [{ logic: "or", conditions: [{ property_id: "property_tags", op: "contains", value: "急" }] }]);
});

// UC-22 batch 3 (AC-03): a two-way relation keeps both sides' values in
// step — every write lands the mirror's links in the same request, and the
// mirror answers to its backlink name.
test("UC-22: a two-way relation syncs both sides, renames and drops its mirror", async (t) => {
  const { agent: a } = await fixture(t);
  let projects = await a.create({ title: "Projects", database: {
    properties: [{ id: UC, name: "代号", type: "text" }],
    views: [{ id: TABLE, name: "全部", kind: "table" }],
  } });
  let tasks = await a.create({ title: "Tasks", database: {
    properties: [{ id: UC, name: "编号", type: "text" }],
    views: [{ id: TABLE, name: "全部", kind: "table" }],
  } });
  // Add the forward property two-way: the mirror appears on the target,
  // named by relation_backlink_name, pointing back with relation_origin.
  tasks = await a.addProperty(tasks, {
    id: "property_rel", name: "项目", type: "relation",
    relation_database: projects.id, relation_two_way: true, relation_backlink_name: "任务",
  });
  const mirror = config(await a.get(projects.id)).properties.find((entry: Json) => entry.relation_origin === "property_rel");
  assert.ok(mirror);
  assert.equal(mirror.type, "relation");
  assert.equal(mirror.name, "任务");
  assert.equal(mirror.relation_database, tasks.id);
  assert.equal(mirror.relation_two_way, undefined);
  // POST /databases cannot start two-way: the mirror has no page to land on.
  invalid(await a.request("/databases", { method: "POST", body: { requestId: randomUUID(), database: {
    properties: [{ id: "property_rel", name: "R", type: "relation", relation_database: tasks.id, relation_two_way: true }],
  } } }));
  // Link from the forward side: the target row's mirror cell is written in
  // the same request. The mirror write moved the target's revision.
  projects = await a.get(projects.id);
  const alpha = await a.addRow(projects, { title: "Alpha", properties: { [UC]: "P-1" } });
  const beta = await a.addRow(await a.get(projects.id), { title: "Beta", properties: { [UC]: "P-2" } });
  let task = await a.addRow(tasks, { title: "第一任务", properties: { property_rel: JSON.stringify([alpha.id, beta.id]) } });
  assert.equal(task.values.property_rel, JSON.stringify([alpha.id, beta.id]));
  const alphaPage = dto(ok(await a.request(`/pages/${alpha.id}`)));
  assert.equal(alphaPage.page.properties[mirror.id], JSON.stringify([task.id]));
  // The mirror sees the link from the other side — read through query so
  // the row's effective values are checked, not only its record.
  const seen = await a.query(projects.id, { filters: [{ property_id: mirror.id, op: "contains", value: task.id }] });
  assert.deepEqual(ids(seen).sort(), [alpha.id, beta.id].sort());
  // Drop one link: the mirror cell shrinks with it.
  tasks = await a.get(tasks.id);
  task = await a.updateRow(tasks, await a.query(tasks.id, { query: "第一任务" }).then((result) => result.rows[0]), {
    properties: { property_rel: JSON.stringify([beta.id]) },
  });
  assert.equal(task.values.property_rel, JSON.stringify([beta.id]));
  const peerAlpha = await a.query(projects.id, { filters: [{ property_id: mirror.id, op: "contains", value: task.id }] });
  assert.deepEqual(ids(peerAlpha), [beta.id]);
  // The mirror answers back the same way: set it, and the forward cell follows.
  projects = await a.get(projects.id);
  const alphaCurrent = (await a.query(projects.id, { query: "Alpha" })).rows[0];
  const taskCurrent = (await a.query(tasks.id, { query: "第一任务" })).rows[0];
  const gamma = await a.addRow(projects, { title: "Gamma" });
  const updated = await a.updateRow(await a.get(tasks.id), taskCurrent, { properties: { property_rel: JSON.stringify([beta.id, gamma.id]) } });
  assert.equal(updated.values.property_rel, JSON.stringify([beta.id, gamma.id]));
  // Rename the mirror from the forward property; then turn two-way off:
  // the mirror goes, values stay.
  tasks = await a.get(tasks.id);
  tasks = await a.patchProperty(tasks, "property_rel", { relation_two_way: true, relation_backlink_name: "相关任务" });
  assert.equal(config(await a.get(projects.id)).properties.find((entry: Json) => entry.relation_origin === "property_rel").name, "相关任务");
  tasks = await a.patchProperty(await a.get(tasks.id), "property_rel", { relation_two_way: false });
  assert.equal(config(await a.get(projects.id)).properties.some((entry: Json) => entry.relation_origin === "property_rel"), false);
  // Relation skeleton is immutable: target and origin cannot change.
  invalid(await a.request(`/databases/${tasks.id}/properties/property_rel`, {
    method: "PATCH", body: { requestId: randomUUID(), baseRevision: (await a.get(tasks.id)).revision,
      property: { relation_database: tasks.id } },
  }));
  // Self-relation is legal: a row links rows of its own database.
  let self = await a.addProperty(await a.get(tasks.id), {
    id: "property_self", name: "前置", type: "relation", relation_database: tasks.id, relation_limit: "1",
  });
  const first = (await a.query(tasks.id, { query: "第一任务" })).rows[0];
  const second = await a.addRow(await a.get(tasks.id), { title: "第二任务", properties: { property_self: JSON.stringify([first.id]) } });
  assert.equal(second.values.property_self, JSON.stringify([first.id]));
  // The limit is enforced; a page outside the database is refused.
  invalid(await a.request(`/databases/${tasks.id}/rows/${second.id}`, {
    method: "PATCH", body: { requestId: randomUUID(), baseRevision: second.revision,
      databaseRevision: (await a.get(tasks.id)).revision, properties: { property_self: JSON.stringify([first.id, second.id]) } },
  }));
  invalid(await a.request(`/databases/${tasks.id}/rows/${second.id}`, {
    method: "PATCH", body: { requestId: randomUUID(), baseRevision: second.revision,
      databaseRevision: (await a.get(tasks.id)).revision, properties: { property_self: JSON.stringify([projects.id]) } },
  }));
  // A mirror property cannot change its type: make a fresh two-way pair
  // (one-way at create, then two-way on) and patch the mirror it made.
  let linked = await a.create({ title: "Linked", database: {
    properties: [{ id: "property_rel2", name: "回链", type: "relation", relation_database: tasks.id }],
  } });
  linked = await a.patchProperty(linked, "property_rel2", { relation_two_way: true });
  const mirror2 = config(await a.get(tasks.id)).properties.find((entry: Json) => entry.relation_origin === "property_rel2");
  assert.ok(mirror2);
  invalid(await a.request(`/databases/${tasks.id}/properties/${mirror2.id}`, {
    method: "PATCH", body: { requestId: randomUUID(), baseRevision: (await a.get(tasks.id)).revision,
      property: { type: "text" } },
  }));
});

// UC-22 batch 3 (AC-04): a relation pointing at a database the caller
// cannot write still writes its own side — the read-only side just does
// not move, over HTTP the missing write right fails the whole request.
test("UC-22: relation filters, sort and calcs follow the page-id encoding", async (t) => {
  const { agent: a } = await fixture(t);
  let targets = await a.create({ title: "目标库", database: {
    properties: [{ id: UC, name: "代号", type: "text" }],
    views: [{ id: TABLE, name: "全部", kind: "table" }],
  } });
  // A relation whose target does not resolve is rejected at create.
  assert.equal((await a.request("/databases", { method: "POST", body: { requestId: randomUUID(), database: {
    properties: [{ id: "property_rel", name: "关联", type: "relation", relation_database: "placeholder" }],
  } } })).status, 404);
  let db = await a.create({ title: "任务库", database: {
    properties: [{ id: UC, name: "编号", type: "text" }],
    views: [{ id: TABLE, name: "全部", kind: "table" }],
  } });
  db = await a.addProperty(db, { id: "property_rel", name: "关联", type: "relation", relation_database: targets.id });
  const one = await a.addRow(targets, { title: "Bravo" });
  const two = await a.addRow(await a.get(targets.id), { title: "Alpha" });
  await a.addRow(db, { title: "no-link" });
  const linkedTwo = await a.addRow(await a.get(db.id), { title: "two-link", properties: { property_rel: JSON.stringify([two.id, one.id]) } });
  // A bare id normalizes to the one-element array.
  const linkedOne = await a.addRow(await a.get(db.id), { title: "one-link", properties: { property_rel: one.id } });
  assert.equal(linkedOne.values.property_rel, JSON.stringify([one.id]));
  // contains / is_empty / is_not_empty, by page id.
  const contains = await a.query(db.id, { filters: [{ property_id: "property_rel", op: "contains", value: one.id }] });
  assert.deepEqual(ids(contains).sort(), [linkedTwo.id, linkedOne.id].sort());
  const empty = await a.query(db.id, { filters: [{ property_id: "property_rel", op: "is_empty" }] });
  assert.deepEqual(empty.rows.map((entry: Json) => entry.page.title), ["no-link"]);
  // Sort by the first linked page's title: Alpha's linker before Bravo's.
  const sorted = await a.query(db.id, { sorts: [{ property_id: "property_rel", direction: "asc" }] });
  assert.deepEqual(sorted.rows.map((entry: Json) => entry.page.title), ["two-link", "one-link", "no-link"]);
  // group_by refuses a relation.
  invalid(await a.request(`/databases/${db.id}/views`, {
    method: "POST", body: { requestId: randomUUID(), baseRevision: db.revision,
      view: { id: "view_grouped", name: "分组", kind: "table", group_by: "property_rel" } },
  }));
  // Calcs count links: count totals the linked ids, count_unique the
  // distinct ones — checked through the view the table renders.
  db = await a.patchView(await a.get(db.id), TABLE, { calcs: { property_rel: "count" } });
  const counted = await a.query(db.id, {});
  assert.equal(counted.rows.length, 3);
  db = await a.patchView(db, TABLE, { calcs: { property_rel: "count_unique" } });
  assert.equal(view(db, TABLE).calcs.property_rel, "count_unique");
  invalid(await a.request(`/databases/${db.id}/views/${TABLE}`, {
    method: "PATCH", body: { requestId: randomUUID(), baseRevision: db.revision,
      view: { calcs: { property_rel: "sum" } } },
  }));
});
