import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { startServer } from "../server/index.ts";

// UC-42 acceptance: the Agent submits Markdown and the server stores the same
// blocks and inline marks a paste or import would produce. HTTP only.

type Json = any;
type Server = Awaited<ReturnType<typeof startServer>>;
interface Reply { status: number; body: Json }
interface Options { method?: string; body?: unknown; token?: string }

class Browser {
  cookie = "";
  constructor(private readonly url: () => string) {}
  async request(path: string, options: Options = {}): Promise<Reply> {
    const response = await fetch(this.url() + path, {
      method: options.method ?? "GET",
      headers: {
        Origin: this.url(),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : this.cookie ? { Cookie: this.cookie } : {}),
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
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
function invalid(reply: Reply): Json {
  const body = ok(reply, 400);
  assert.equal(typeof body.error, "string");
  return body;
}
function dto(value: Json): Json {
  assert.equal(typeof value.id, "string");
  assert.equal(typeof value.revision, "string");
  assert.equal(typeof value.collaboration.generation, "string");
  return value;
}
function blocksOf(dtoValue: Json): Json[] {
  const byId = dtoValue.page.block_tree.by_id as Record<string, Json>;
  const result: Json[] = [];
  const roots = Object.values(byId).filter((block) => !block.parent_id).sort((a, b) => Number(a.order) - Number(b.order));
  const walk = (block: Json) => {
    result.push(block);
    for (const child of Object.values(byId).filter((entry) => entry.parent_id === block.id).sort((a, b) => Number(a.order) - Number(b.order))) walk(child);
  };
  for (const root of roots) walk(root);
  return result;
}
function plain(content: Json[]): string {
  return (content ?? []).map((run: Json) => run.text ?? "").join("");
}

async function register(browser: Browser, handle: string) {
  ok(await browser.request("/api/auth/register", {
    method: "POST", body: { handle, displayName: handle, password: "Independent-markdown-acceptance-2026!" },
  }), 201);
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "notes-agent-markdown-"));
  let server: Server | undefined;
  t.after(async () => {
    try { await server?.close(); }
    finally {
      const target = resolve(directory);
      assert.equal(dirname(target), resolve(tmpdir()));
      assert.ok(basename(target).startsWith("notes-agent-markdown-"));
      await rm(target, { recursive: true, force: true });
    }
  });
  server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false });
  const owner = new Browser(() => server!.url);
  await register(owner, "owner");
  const writer = ok(await owner.request("/api/tokens", { method: "POST", body: { name: "UC-42 write", access: "write" } }), 201);
  const reader = ok(await owner.request("/api/tokens", { method: "POST", body: { name: "UC-42 read", access: "read" } }), 201);
  const agent = new Browser(() => server!.url);
  const request = (path: string, options: Options = {}) => agent.request(`/api/v1${path}`, { ...options, token: writer.token });
  const readOnly = (path: string, options: Options = {}) => agent.request(`/api/v1${path}`, { ...options, token: reader.token });
  return { request, readOnly };
}

const MD = [
  "# 需求记录",
  "",
  "正文 `inline code` 与 **加粗** 以及 [链接](https://example.com)。",
  "",
  "- 列表一",
  "  - 嵌套条目",
  "- [x] 已完成事项",
  "",
  "> 一段引用",
  "",
  "```mermaid",
  "flowchart LR",
  "  A --> B",
  "```",
  "",
  "| 列一 | 列二 |",
  "| --- | --- |",
  "| a | b |",
  "",
  "---",
].join("\n");

test("UC-42: POST /pages accepts markdown and builds the full block tree", async (t) => {
  const { request } = await fixture(t);
  const created = dto(ok(await request("/pages", { method: "POST", body: { title: "UC-42 页", markdown: MD } }), 201));
  const blocks = blocksOf(created);
  const kinds = blocks.map((block) => block.kind);
  assert.deepEqual(kinds, ["heading1", "text", "bullet", "bullet", "todo", "quote", "code", "table", "divider"]);
  const text = blocks[1];
  assert.match(plain(text.content), /inline code/);
  const codeRun = text.content.find((run: Json) => run.text === "inline code");
  assert.equal(codeRun.marks?.code, true);
  const boldRun = text.content.find((run: Json) => run.text === "加粗");
  assert.equal(boldRun.marks?.bold, true);
  const linkRun = text.content.find((run: Json) => run.marks?.link === "https://example.com");
  assert.ok(linkRun, "Inline Markdown links keep their URL mark");
  const nested = blocks[3];
  assert.equal(nested.parent_id, blocks[2].id, "Indented list item nests under its parent");
  assert.equal(blocks[4].checked, true);
  assert.equal(blocks[6].language, "mermaid");
  assert.match(plain(blocks[6].content), /flowchart LR/);
  const table = blocks[7];
  assert.ok(table.table, "Markdown table keeps its grid");
  const header = Object.values(table.table.rows as Record<string, Json>).sort((a, b) => a.order - b.order)[0];
  const firstColumn = table.table.columns[0].id;
  assert.equal(plain(header.cells[firstColumn]), "列一");
  // `text` stays the ordered plain projection.
  assert.match(created.text, /需求记录[\s\S]*一段引用[\s\S]*flowchart LR/);
});

test("UC-42: PATCH /pages markdown replaces the body as blocks", async (t) => {
  const { request } = await fixture(t);
  const created = dto(ok(await request("/pages", { method: "POST", body: { title: "旧页", text: "旧正文" } }), 201));
  const patched = dto(ok(await request(`/pages/${created.id}`, {
    method: "PATCH",
    body: { baseRevision: created.revision, markdown: "## 新标题\n\n- 甲\n- 乙" },
  })));
  const kinds = blocksOf(patched).map((block) => block.kind);
  assert.deepEqual(kinds, ["heading2", "bullet", "bullet"]);
  assert.equal(patched.text, "新标题\n甲\n乙");
});

test("UC-42: text and markdown are mutually exclusive on every body entry", async (t) => {
  const { request } = await fixture(t);
  invalid(await request("/pages", { method: "POST", body: { title: "x", text: "a", markdown: "b" } }));
  const created = dto(ok(await request("/pages", { method: "POST", body: { title: "x", text: "a" } }), 201));
  invalid(await request(`/pages/${created.id}`, { method: "PATCH", body: { baseRevision: created.revision, text: "a", markdown: "b" } }));
  // Database row creation follows the same rule.
  const db = dto(ok(await request("/databases", { method: "POST", body: { requestId: randomUUID(), title: "db" } }), 201));
  invalid(await request(`/databases/${db.id}/rows`, {
    method: "POST", body: { requestId: randomUUID(), baseRevision: db.revision, title: "r", text: "a", markdown: "b" },
  }));
  const row = dto(ok(await request(`/databases/${db.id}/rows`, {
    method: "POST", body: { requestId: randomUUID(), baseRevision: db.revision, title: "r", markdown: "- 项目\n\n`code`" },
  }), 201));
  const rowBlocks = blocksOf(row);
  assert.equal(rowBlocks[0].kind, "bullet");
  const codeRun = rowBlocks[1].content.find((run: Json) => run.text === "code");
  assert.equal(codeRun.marks?.code, true);
});

test("UC-42: insert_blocks expands markdown after the given block", async (t) => {
  const { request } = await fixture(t);
  const created = dto(ok(await request("/pages", { method: "POST", body: { title: "ops", text: "首段" } }), 201));
  const first = blocksOf(created)[0];
  const applied = dto(ok(await request(`/pages/${created.id}/operations`, {
    method: "POST",
    body: {
      requestId: randomUUID(), generation: created.collaboration.generation, baseRevision: created.revision, mode: "apply",
      operations: [{ type: "insert_blocks", afterId: first.id, markdown: "> 引用\n\n- 一\n  - 二\n\n```ts\nconst x = 1\n```" }],
    },
  })));
  const blocks = blocksOf(applied);
  assert.deepEqual(blocks.map((block) => block.kind), ["text", "quote", "bullet", "bullet", "code"]);
  assert.equal(blocks[3].parent_id, blocks[2].id);
  // Structural ops need baseRevision; replay returns the same result.
  const replay = dto(ok(await request(`/pages/${created.id}/operations`, {
    method: "POST",
    body: {
      requestId: randomUUID(), generation: applied.collaboration.generation, baseRevision: applied.revision, mode: "apply",
      operations: [{ type: "insert_blocks", markdown: "| a |\n| --- |\n| 1 |" }],
    },
  })));
  const kinds = blocksOf(replay).map((block) => block.kind);
  assert.equal(kinds.at(-1), "table");
});

test("UC-42: insert_text and insert_block honour format markdown inline", async (t) => {
  const { request } = await fixture(t);
  const created = dto(ok(await request("/pages", { method: "POST", body: { title: "inline", text: "前缀 " } }), 201));
  const first = blocksOf(created)[0];
  const applied = dto(ok(await request(`/pages/${created.id}/operations`, {
    method: "POST",
    body: {
      requestId: randomUUID(), generation: created.collaboration.generation, baseRevision: created.revision, mode: "apply",
      operations: [
        { type: "insert_text", blockId: first.id, index: "end", text: "`code` 与 *斜体*", format: "markdown" },
        { type: "insert_block", text: "**粗** 与 https://example.com", format: "markdown" },
      ],
    },
  })));
  const blocks = blocksOf(applied);
  const codeRun = blocks[0].content.find((run: Json) => run.text === "code");
  assert.equal(codeRun?.marks?.code, true);
  const italic = blocks[0].content.find((run: Json) => run.text === "斜体");
  assert.equal(italic?.marks?.italic, true);
  const bold = blocks[1].content.find((run: Json) => run.text === "粗");
  assert.equal(bold?.marks?.bold, true);
  assert.ok(blocks[1].content.some((run: Json) => run.marks?.link === "https://example.com"), "Bare address links up");
  // Plain text is untouched: backticks stay literal without format.
  const plainApplied = dto(ok(await request(`/pages/${applied.id}/operations`, {
    method: "POST",
    body: {
      requestId: randomUUID(), generation: applied.collaboration.generation, mode: "apply",
      operations: [{ type: "insert_text", blockId: first.id, index: "end", text: " `raw`" }],
    },
  })));
  const rawRun = blocksOf(plainApplied)[0].content.find((run: Json) => run.text === " `raw`");
  assert.equal(rawRun?.marks, undefined, "Without format, backticks stay plain text");
});

test("UC-42: insert_blocks requires baseRevision and suggest mode writes nothing", async (t) => {
  const { request } = await fixture(t);
  const created = dto(ok(await request("/pages", { method: "POST", body: { title: "guard", text: "base" } }), 201));
  invalid(await request(`/pages/${created.id}/operations`, {
    method: "POST",
    body: { requestId: randomUUID(), generation: created.collaboration.generation, mode: "apply", operations: [{ type: "insert_blocks", markdown: "- x" }] },
  }));
  const suggested = ok(await request(`/pages/${created.id}/operations`, {
    method: "POST",
    body: { requestId: randomUUID(), generation: created.collaboration.generation, baseRevision: created.revision, mode: "suggest", operations: [{ type: "insert_blocks", markdown: "- x" }] },
  }), 201);
  assert.equal(suggested.status, "pending");
  const reread = dto(ok(await request(`/pages/${created.id}`)));
  assert.equal(blocksOf(reread).length, 1, "Suggest must not apply the writes");
  assert.equal(reread.revision, created.revision);
});

test("UC-42: read-only tokens cannot use markdown write paths", async (t) => {
  const { request, readOnly } = await fixture(t);
  const denied = await readOnly("/pages", { method: "POST", body: { title: "x", markdown: "- a" } });
  assert.ok([401, 403].includes(denied.status), JSON.stringify(denied.body));
  const created = dto(ok(await request("/pages", { method: "POST", body: { title: "x", text: "a" } }), 201));
  const deniedPatch = await readOnly(`/pages/${created.id}`, { method: "PATCH", body: { baseRevision: created.revision, markdown: "- a" } });
  assert.ok([401, 403].includes(deniedPatch.status), JSON.stringify(deniedPatch.body));
});

test("UC-42: app pages reject markdown like text", async (t) => {
  const { request } = await fixture(t);
  invalid(await request("/pages", { method: "POST", body: { title: "app", kind: "app", markdown: "# x" } }));
});
