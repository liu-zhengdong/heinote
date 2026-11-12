import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { startServer } from "../server/index.ts";
import { ZipStream } from "../src/core/zip.ts";

/* Obsidian .base 导入验收：.base 文件转 database 页面，filters 求值出
   行集合，frontmatter 与 file.* 派生列落成 properties，views 映射
   table/board/gallery。真实库的语法形态按 14 个 .base 抽样覆盖。 */

type Json = any;
type RunningServer = Awaited<ReturnType<typeof startServer>>;
interface Reply { status: number; body: Json; headers: Headers }

class Browser {
  cookie = "";
  constructor(private readonly url: () => string) {}
  async request(path: string, options: { method?: string; body?: unknown; raw?: BodyInit; contentType?: string; binary?: boolean } = {}): Promise<Reply> {
    const headers: Record<string, string> = { Origin: this.url() };
    if (this.cookie) headers.Cookie = this.cookie;
    let body: BodyInit | undefined;
    if (options.body !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(options.body); }
    else if (options.raw !== undefined) { headers["Content-Type"] = options.contentType ?? "application/octet-stream"; body = options.raw; }
    const response = await fetch(`${this.url()}${path}`, { method: options.method ?? "GET", headers, body, redirect: "manual" });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) {
      const known = new Map(this.cookie.split("; ").filter(Boolean).map((part) => { const at = part.indexOf("="); return [part.slice(0, at), part.slice(at + 1)]; }));
      for (const cookie of cookies) { const first = cookie.split(";", 1)[0]; const at = first.indexOf("="); const key = first.slice(0, at); const value = first.slice(at + 1); if (!value || /(?:^|;)\s*max-age=0(?:;|$)/i.test(cookie)) known.delete(key); else known.set(key, value); }
      this.cookie = [...known].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    const text = await response.text();
    let parsed: Json = null;
    if (text && /application\/json/.test(response.headers.get("content-type") ?? "")) parsed = JSON.parse(text);
    if (options.binary) return { status: response.status, body: text ? Buffer.from(text) : parsed, headers: response.headers };
    return { status: response.status, body: parsed, headers: response.headers };
  }
}

const password = "Correct-horse-battery-2026!";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "heinote-import-base-"));
  let server: RunningServer | undefined = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false });
  t.after(async () => {
    await server?.close();
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("heinote-import-base-"));
    await rm(target, { recursive: true, force: true });
  });
  return { browser: () => new Browser(() => server!.url) };
}

async function register(browser: Browser, handle: string): Promise<Json> {
  const r = await browser.request("/api/auth/register", { method: "POST", body: { handle, displayName: handle, password } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const session = await browser.request("/api/session");
  assert.equal(session.status, 200);
  return session.body.user;
}

async function zipOf(entries: Record<string, string | Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const zip = new ZipStream({ write: (chunk) => chunks.push(chunk) });
  for (const [name, body] of Object.entries(entries)) await zip.add(name, body);
  zip.finish();
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
}

async function runImport(browser: Browser, source: string, zip: Buffer): Promise<Json> {
  const started = await browser.request(`/api/account/import/${source}`, { method: "POST", raw: zip, contentType: "application/zip" });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  for (let i = 0; i < 100; i += 1) {
    const job = await browser.request(`/api/account/import/${started.body.id}`);
    assert.equal(job.status, 200);
    if (job.body.status === "done" || job.body.status === "failed") return job.body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("导入任务未结束。");
}

const records = async (browser: Browser, collection: string): Promise<Json[]> =>
  ((await browser.request(`/api/records/personal/${collection}`)).body ?? []).map((row: Json) => row.value ?? row);
const pages = (browser: Browser) => records(browser, "pages");
const titleOf = (page: Json): string => page.title_content?.map((run: Json) => run.text ?? "").join("") ?? "";

/* The vault the tests share: three notes in 候选/ carrying frontmatter
 * (created/status/priority/类型/依赖/来源), one note outside, and a
 * mix of tags in frontmatter and inline. */
const VAULT: Record<string, string> = {
  "vault/.obsidian/app.json": "{}",
  "vault/候选/卡A.md": "---\ncreated: 2026-10-21\nstatus: 候选\npriority: P1\n类型: 上下文\n来源: 甲\n---\n卡A 正文 #待复盘",
  "vault/候选/卡B.md": "---\ncreated: 2026-10-20\nstatus: 已排期\npriority: P2\n类型: 交互\n来源: 乙\n---\n卡B 正文",
  "vault/候选/卡C.md": "---\ncreated: 2026-10-19\nstatus: 已完成\npriority: P3\n类型: 上下文\n来源: 丙\n---\n卡C 正文",
  "vault/其它/散页.md": "---\ncreated: 2026-10-01\nstatus: 草稿\n---\n不在 base 范围。",
};

test("base：inFolder + 视图级过滤 + 排序 + 列类型", async (t) => {
  const { browser } = await fixture(t);
  const b = browser();
  await register(b, "basetest1");

  const zip = await zipOf({
    ...VAULT,
    "vault/候选清单.base": `filters:
  and:
    - file.inFolder("候选")
    - file.ext == "md"
    - file.name != "候选清单"
properties:
  status:
    displayName: 状态
  note.priority:
    displayName: 优先级
  file.mtime:
    displayName: 更新于
views:
  - type: table
    name: 全部
    order:
      - file.name
      - priority
      - status
      - created
    sort:
      - property: priority
        direction: ASC
      - property: created
        direction: DESC
  - type: table
    name: P1 接着做
    filters:
      and:
        - priority == "P1"
    order:
      - file.name
      - priority
      - status
    sort:
      - property: priority
        direction: ASC
`,
  });
  const job = await runImport(b, "obsidian", zip);
  assert.equal(job.status, "done", JSON.stringify(job));

  const all = await pages(b);
  const byTitle = new Map(all.map((p) => [titleOf(p), p]));
  const db = byTitle.get("候选清单");
  assert.ok(db, JSON.stringify(all.map(titleOf)));
  assert.equal(db.kind, "database");

  // Rows: 卡A/卡B/卡C matched inFolder("候选") — 散页 not matched.
  const rowOf = (name: string) => all.find((p) => titleOf(p) === name && p.parent_id === db.id);
  const rowA = rowOf("卡A");
  const rowB = rowOf("卡B");
  const rowC = rowOf("卡C");
  assert.ok(rowA && rowB && rowC, JSON.stringify(all.map((p) => [titleOf(p), p.parent_id])));
  assert.ok(!all.some((p) => titleOf(p) === "散页" && p.parent_id === db.id));
  const 散页 = byTitle.get("散页");
  assert.ok(散页);
  assert.notEqual(散页.parent_id, db.id);

  // Columns: only the keys the base references (order/sort/properties).
  // 类型/来源 are frontmatter the base does not use — not columns.
  const properties = db.database?.properties ?? [];
  const nameOf = (prop: Json) => String(prop.name);
  const names = properties.map(nameOf);
  assert.ok(names.includes("优先级"), JSON.stringify(names));
  assert.ok(names.includes("状态"), JSON.stringify(names));
  assert.ok(names.includes("更新于"), JSON.stringify(names));
  assert.ok(names.includes("created"), JSON.stringify(names));
  assert.ok(!names.includes("类型") && !names.includes("来源"), JSON.stringify(names));

  // Property types: priority/status/类型/来源 are small domains → select;
  // created is a date.
  const propByName = (name: string) => properties.find((prop: Json) => nameOf(prop) === name);
  assert.equal(propByName("优先级")?.type, "select");
  assert.equal(propByName("状态")?.type, "select");
  assert.equal(propByName("created")?.type, "date");
  assert.deepEqual(propByName("优先级")?.options?.sort(), ["P1", "P2", "P3"].sort());
  assert.deepEqual(propByName("状态")?.options?.sort(), ["候选", "已排期", "已完成"].sort());

  // Row values.
  const priorityId = propByName("优先级")?.id;
  const statusId = propByName("状态")?.id;
  assert.ok(priorityId && statusId);
  assert.equal(rowA.properties?.[priorityId], "P1");
  assert.equal(rowB.properties?.[priorityId], "P2");
  assert.equal(rowC.properties?.[priorityId], "P3");
  assert.equal(rowA.properties?.[statusId], "候选");

  // Views: 「全部」 table, sort priority ASC + created DESC.
  const views = db.database?.views ?? [];
  assert.equal(views.length, 2);
  const viewAll = views.find((v: Json) => String(v.name) === "全部");
  const viewP1 = views.find((v: Json) => String(v.name) === "P1 接着做");
  assert.ok(viewAll && viewP1, JSON.stringify(views));
  assert.equal(viewAll.kind, "table");
  assert.equal(viewAll.sorts?.[0]?.property_id, priorityId);
  assert.equal(viewAll.sorts?.[0]?.direction, "asc");
  assert.equal(viewP1.kind, "table");
  assert.equal(viewP1.filter?.property_id, priorityId);
  assert.equal(viewP1.filter?.value, "P1");
});

test("base：cards + groupBy + groupOrder 转 board，columnSize 转列宽", async (t) => {
  const { browser } = await fixture(t);
  const b = browser();
  await register(b, "basetest2");

  const zip = await zipOf({
    ...VAULT,
    "vault/看板.base": `filters:
  and:
    - file.inFolder("候选")
properties:
  status:
    displayName: 状态
views:
  - type: cards
    name: 看板
    filters:
      and:
        - status != "已完成"
    groupBy:
      property: status
      direction: ASC
    groupOrder:
      - 候选
      - 已排期
    order:
      - file.name
      - status
`,
  });
  const job = await runImport(b, "obsidian", zip);
  assert.equal(job.status, "done", JSON.stringify(job));

  const all = await pages(b);
  const db = all.find((p) => titleOf(p) === "看板");
  assert.ok(db && db.kind === "database");

  const views = db.database?.views ?? [];
  assert.equal(views.length, 1);
  const board = views[0];
  assert.equal(board.kind, "board");
  const statusProp = (db.database?.properties ?? []).find((p: Json) => String(p.name) === "状态");
  assert.ok(statusProp);
  assert.equal(board.group_by, statusProp.id);
  assert.equal(board.filter, undefined); // `status != "已完成"` 不是 `==`，不映射
});

test("base：公式列物化为静态值", async (t) => {
  const { browser } = await fixture(t);
  const b = browser();
  await register(b, "basetest3");

  const zip = await zipOf({
    ...VAULT,
    "vault/候选清单.base": `filters:
  and:
    - file.inFolder("候选")
formulas:
  多久没动: '(now() - file.mtime).days.round()'
properties:
  formula.多久没动:
    displayName: 多久没动
views:
  - type: table
    name: 主线
    order:
      - file.name
      - formula.多久没动
`,
  });
  const job = await runImport(b, "obsidian", zip);
  assert.equal(job.status, "done", JSON.stringify(job));

  const all = await pages(b);
  const db = all.find((p) => titleOf(p) === "候选清单");
  assert.ok(db);
  const prop = (db.database?.properties ?? []).find((p: Json) => String(p.name) === "多久没动");
  assert.ok(prop, JSON.stringify(db.database?.properties?.map((p: Json) => p.name)));
  assert.equal(prop.type, "text");
  const rowA = all.find((p) => titleOf(p) === "卡A" && p.parent_id === db.id);
  assert.ok(rowA);
  const value = Number(rowA.properties?.[prop.id]);
  assert.ok(!Number.isNaN(value) && value >= 0, JSON.stringify(rowA.properties));
});

test("base：YAML 解析失败降级为普通页面，整库不受影响", async (t) => {
  const { browser } = await fixture(t);
  const b = browser();
  await register(b, "basetest4");

  const zip = await zipOf({
    ...VAULT,
    "vault/坏.base": "this is not: [valid\n  - yaml\n    broken",
  });
  const job = await runImport(b, "obsidian", zip);
  assert.equal(job.status, "done", JSON.stringify(job));
  // 三条笔记照常入库；坏 base 不阻塞，报告注明。
  const all = await pages(b);
  const names = all.map(titleOf);
  assert.ok(names.includes("卡A") && names.includes("散页"), JSON.stringify(names));
  assert.ok(job.result.warnings.some((w: string) => w.includes("坏.base")), JSON.stringify(job.result.warnings));
});

test("base：tags.contains 与 hasProperty", async (t) => {
  const { browser } = await fixture(t);
  const b = browser();
  await register(b, "basetest5");

  const zip = await zipOf({
    "vault/有key.md": "---\ncreated: 2026-10-21\nkey: abc\n---\n有 key 的页 #待复盘",
    "vault/无key.md": "---\ncreated: 2026-10-21\nstatus: 草稿\n---\n没有 key。",
    "vault/查询.base": `filters:
  and:
    - tags.contains("待复盘")
    - file.hasProperty("key")
views:
  - type: table
    name: 全部
    order:
      - file.name
      - key
`,
  });
  const job = await runImport(b, "obsidian", zip);
  assert.equal(job.status, "done", JSON.stringify(job));

  const all = await pages(b);
  const db = all.find((p) => titleOf(p) === "查询");
  assert.ok(db);
  const rows = all.filter((p) => p.parent_id === db.id);
  assert.equal(rows.length, 1);
  assert.equal(titleOf(rows[0]), "有key");
});
