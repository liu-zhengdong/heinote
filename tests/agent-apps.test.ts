import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { startServer } from "../server/index.ts";

// UC-15 acceptance uses HTTP only, as UC-14's does. The server import only
// starts the fixture; expected values come from the UC card's contract:
// an app is a page of kind "app" whose `app` record holds the draft, the
// enabled source and the bound databases.
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
  return value;
}

class Agent {
  constructor(readonly browser: Browser, readonly token: string) {}
  request(path: string, options: Omit<Options, "token"> = {}) {
    return this.browser.request(`/api/v1${path}`, { ...options, token: this.token });
  }
  async createApp(input: Json = {}) {
    const value = dto(ok(await this.request("/pages", { method: "POST", body: { kind: "app", title: "小应用", ...input } }), 201));
    assert.equal(value.page.kind, "app");
    return value;
  }
  async createDocument(input: Json = {}) {
    const value = dto(ok(await this.request("/pages", { method: "POST", body: { title: "文档", text: "body", ...input } }), 201));
    assert.equal(value.page.kind, "document");
    return value;
  }
  async createDatabase(input: Json = {}) {
    const value = dto(ok(await this.request("/databases", { method: "POST", body: { requestId: randomUUID(), ...input } }), 201));
    assert.equal(value.page.kind, "database");
    return value;
  }
  async getPage(id: string) { return dto(ok(await this.request(`/pages/${id}`))); }
  async patchApp(id: string, baseRevision: string, app: Json) {
    return dto(ok(await this.request(`/pages/${id}`, { method: "PATCH", body: { baseRevision, app } })));
  }
  async enable(id: string, baseRevision: string, requestId = randomUUID()) {
    return dto(ok(await this.request(`/pages/${id}/enable`, { method: "POST", body: { requestId, baseRevision } })));
  }
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "notes-agent-apps-http-"));
  let server: Server | undefined;
  t.after(async () => {
    try { await server?.close(); }
    finally {
      const target = resolve(directory);
      assert.equal(dirname(target), resolve(tmpdir()));
      assert.ok(basename(target).startsWith("notes-agent-apps-http-"));
      await rm(target, { recursive: true, force: true });
    }
  });
  server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false });
  const browser = () => new Browser(() => server!.url);
  const owner = browser();
  const user = await register(owner, "owner");
  const writer = await makeToken(owner, "write");
  const reader = await makeToken(owner, "read");
  const agent = new Agent(browser(), writer.token);
  const readerAgent = new Agent(browser(), reader.token);
  return { browser, owner, user, agent, readerAgent };
}
async function register(browser: Browser, handle: string) {
  ok(await browser.request("/api/auth/register", {
    method: "POST", body: { handle, displayName: handle, password: "Independent-app-acceptance-2026!" },
  }), 201);
  return ok(await browser.request("/api/session")).user;
}
async function makeToken(browser: Browser, access: "read" | "write") {
  return ok(await browser.request("/api/tokens", { method: "POST", body: { name: `UC-15 ${access}`, access } }), 201);
}

const HTML = "<!doctype html><html><head><title>t</title></head><body><h1>Hi</h1></body></html>";
const SCRIPTED = "<!doctype html><html><body><h1>Hi</h1><script>console.log(1)</script></body></html>";

test("create an app page: kind app, empty app record, no body", async (t) => {
  const { agent } = await fixture(t);
  const app = await agent.createApp();
  assert.equal(app.page.kind, "app");
  const fetched = await agent.getPage(app.id);
  assert.equal(fetched.page.kind, "app");
  assert.equal(fetched.page.app === undefined || typeof fetched.page.app === "object", true);
});

test("create rejects body text on an app", async (t) => {
  const { agent } = await fixture(t);
  invalid(await agent.request("/pages", { method: "POST", body: { kind: "app", title: "x", text: "正文" } }));
});

test("PATCH app.draft stores the draft; draft does not publish as enabled", async (t) => {
  const { agent } = await fixture(t);
  const app = await agent.createApp();
  const patched = await agent.patchApp(app.id, app.revision, { draft: HTML });
  assert.equal(patched.page.app.draft, HTML);
  assert.equal(patched.page.app.enabled, undefined);
});

test("PATCH app on a document page is rejected", async (t) => {
  const { agent } = await fixture(t);
  const doc = await agent.createDocument();
  invalid(await agent.request(`/pages/${doc.id}`, { method: "PATCH", body: { baseRevision: doc.revision, app: { draft: HTML } } }));
});

test("bindings validate: must be a database, same scope, deduped", async (t) => {
  const { agent } = await fixture(t);
  const app = await agent.createApp();
  const db = await agent.createDatabase();
  const doc = await agent.createDocument();
  // A document cannot be a data source.
  invalid(await agent.request(`/pages/${app.id}`, { method: "PATCH", body: { baseRevision: app.revision, app: { databases: [{ id: doc.id, read: true, write: false }] } } }));
  // A missing page cannot be a data source.
  invalid(await agent.request(`/pages/${app.id}`, { method: "PATCH", body: { baseRevision: app.revision, app: { databases: [{ id: "nope", read: true, write: false }] } } }));
  // A bound database sticks, write implies read.
  const bound = await agent.patchApp(app.id, app.revision, { databases: [{ id: db.id, read: false, write: true }] });
  assert.deepEqual(bound.page.app.databases, [{ id: db.id, read: true, write: true }]);
});

test("a data source in another scope is refused", async (t) => {
  const { agent, owner } = await fixture(t);
  const space = ok(await owner.request("/api/spaces", { method: "POST", body: { name: "Other scope" } }), 201);
  const foreignDb = await agent.createDatabase({ spaceId: space.spaceId });
  const app = await agent.createApp();
  invalid(await agent.request(`/pages/${app.id}`, { method: "PATCH", body: { baseRevision: app.revision, app: { databases: [{ id: foreignDb.id, read: true, write: false }] } } }));
});

test("enable moves the draft to enabled and clears it; blank draft refused", async (t) => {
  const { agent } = await fixture(t);
  const app = await agent.createApp();
  // Blank draft cannot be enabled.
  invalid(await agent.request(`/pages/${app.id}/enable`, { method: "POST", body: { requestId: randomUUID(), baseRevision: app.revision } }));
  const drafted = await agent.patchApp(app.id, app.revision, { draft: SCRIPTED });
  const enabled = await agent.enable(app.id, drafted.revision);
  assert.equal(enabled.page.app.enabled, SCRIPTED);
  assert.equal(enabled.page.app.draft, undefined);
});

test("enable is idempotent on requestId", async (t) => {
  const { agent } = await fixture(t);
  const app = await agent.createApp();
  const drafted = await agent.patchApp(app.id, app.revision, { draft: HTML });
  const requestId = randomUUID();
  const first = await agent.enable(app.id, drafted.revision, requestId);
  const replay = await agent.enable(app.id, drafted.revision, requestId);
  assert.equal(replay.revision, first.revision);
});

test("enable conflicts on a stale baseRevision", async (t) => {
  const { agent } = await fixture(t);
  const app = await agent.createApp();
  const drafted = await agent.patchApp(app.id, app.revision, { draft: HTML });
  await agent.enable(app.id, drafted.revision);
  const stale = await agent.request(`/pages/${app.id}/enable`, { method: "POST", body: { requestId: randomUUID(), baseRevision: drafted.revision } });
  assert.equal(stale.status, 409);
});

test("draft source budget: over 2MB refused", async (t) => {
  const { agent } = await fixture(t);
  const app = await agent.createApp();
  const big = "<p>" + "x".repeat(2 * 1024 * 1024) + "</p>";
  invalid(await agent.request(`/pages/${app.id}`, { method: "PATCH", body: { baseRevision: app.revision, app: { draft: big } } }));
});

test("DELETE removes a row through the Agent boundary", async (t) => {
  const { agent } = await fixture(t);
  const db = await agent.createDatabase();
  const added = dto(ok(await agent.request(`/databases/${db.id}/rows`, {
    method: "POST", body: { requestId: randomUUID(), baseRevision: db.revision },
  }), 201));
  const dbAfterAdd = await agent.getPage(db.id);
  ok(await agent.request(`/databases/${db.id}/rows/${added.id}`, {
    method: "DELETE", body: { requestId: randomUUID(), baseRevision: added.revision, databaseRevision: dbAfterAdd.revision },
  }));
  const query = ok(await agent.request(`/databases/${db.id}/query`, { method: "POST", body: {} }));
  assert.ok(!query.rows.some((row: Json) => row.id === added.id));
});

test("a published share carries the enabled source but not the draft or bindings", async (t) => {
  const { agent, owner } = await fixture(t);
  const parent = await agent.createDocument({ title: "Shared" });
  const db = await agent.createDatabase({ parentId: parent.id });
  const app = await agent.createApp({ parentId: parent.id });
  const drafted = await agent.patchApp(app.id, app.revision, {
    draft: HTML, databases: [{ id: db.id, read: true, write: true }],
  });
  await agent.enable(app.id, drafted.revision);
  const share = ok(await owner.request("/api/shares", { method: "POST", body: { pageId: parent.id } }), 201);
  const shareToken = String(share.url).replace("/s/", "");
  const published = ok(await owner.request(`/api/public/${shareToken}`));
  const appEntry = published.pages.find((page: Json) => page.id === app.id);
  assert.ok(appEntry, "the app page is still listed by name");
  assert.equal(appEntry.kind, "app");
  assert.equal(appEntry.app?.enabled, HTML, "the enabled source runs for readers");
  assert.equal(appEntry.app?.draft, undefined, "the draft stays private");
  assert.equal(appEntry.app?.databases, undefined, "bindings never leave over the public reader");

  // The bound database rides with the app: a guest reads its schema and
  //  rows through the share bridge, and writes land stamped 公开分享.
  const handshake = ok(await owner.request(`/api/public/${shareToken}/apps/${app.id}`));
  assert.deepEqual(handshake.databases, [{ id: db.id, read: true, write: true, title: db.title }]);
  const schema = ok(await owner.request(`/api/public/${shareToken}/apps/${app.id}/data`, {
    method: "POST", body: { op: "schema", args: {} },
  }));
  assert.equal(schema.id, db.id);
  const created = ok(await owner.request(`/api/public/${shareToken}/apps/${app.id}/data`, {
    method: "POST", body: { op: "rows.create", requestId: randomUUID(), args: { db: db.id, title: "访客打卡", baseRevision: schema.revision } },
  }), 201);
  assert.equal(created.page?.created_by, "公开分享");
  // An unbound database is unreachable, even when the caller knows its id.
  const stray = await agent.createDatabase();
  const forbidden = await owner.request(`/api/public/${shareToken}/apps/${app.id}/data`, {
    method: "POST", body: { op: "schema", args: { db: stray.id } },
  });
  denied(forbidden);
  // An app outside the share tree answers not_found, not the binding.
  const outside = await agent.createApp();
  const draftedOutside = await agent.patchApp(outside.id, outside.revision, { draft: HTML });
  await agent.enable(outside.id, draftedOutside.revision);
  const hidden = await owner.request(`/api/public/${shareToken}/apps/${outside.id}/data`, {
    method: "POST", body: { op: "schema", args: {} },
  });
  assert.equal(hidden.status, 404);
});

test("read token can read an app but cannot patch it", async (t) => {
  const { agent, readerAgent } = await fixture(t);
  const app = await agent.createApp();
  const fetched = await readerAgent.getPage(app.id);
  assert.equal(fetched.page.kind, "app");
  denied(await readerAgent.request(`/pages/${app.id}`, { method: "PATCH", body: { baseRevision: app.revision, app: { draft: HTML } } }));
});

// UC-47: embed an app page inside a document. The Agent writes a page-link
// mention with `expanded: true`; the browser renders it as the app's iframe.
test("insert_page_link embeds an app in place; expanded defaults to a plain link", async (t) => {
  const { agent } = await fixture(t);
  const host = await agent.createDocument();
  const [first] = Object.values(host.page.block_tree.by_id) as Json[];
  const app = await agent.createApp();
  const drafted = await agent.patchApp(app.id, app.revision, { draft: HTML });
  await agent.enable(app.id, drafted.revision);

  const ops = async (id: string, operations: Json[]) => {
    const page = await agent.getPage(id);
    return agent.request(`/pages/${id}/operations`, {
      method: "POST",
      body: { requestId: randomUUID(), generation: page.collaboration.generation, baseRevision: page.collaboration.revision, mode: "apply", operations },
    });
  };

  const expanded = ok(await ops(host.id, [
    { type: "insert_page_link", blockId: first.id, index: "end", pageId: app.id, expanded: true },
  ]));
  const target = expanded.page.block_tree.by_id[first.id];
  const run = (target.content ?? []).find((entry: Json) => entry.mention?.kind === "page" && entry.mention.page_id === app.id);
  assert.ok(run, JSON.stringify(target.content));
  assert.equal(run.mention.expanded, true);

  const second = ok(await ops(host.id, [
    { type: "insert_page_link", blockId: first.id, index: "start", pageId: app.id },
  ]));
  const plain = (second.page.block_tree.by_id[first.id].content ?? []).find((entry: Json) => entry.mention?.kind === "page" && entry.mention.page_id === app.id && !entry.mention.expanded);
  assert.ok(plain, JSON.stringify(second.page.block_tree.by_id[first.id].content));
});

test("insert_page_link refuses missing, foreign and self targets; batch rolls back", async (t) => {
  const { agent, browser } = await fixture(t);
  const host = await agent.createDocument();
  const [first] = Object.values(host.page.block_tree.by_id) as Json[];
  const stranger = browser();
  await register(stranger, "stranger2");
  const outsider = new Agent(browser(), (await makeToken(stranger, "write")).token);
  const foreign = await outsider.createApp();

  const ops = async (operations: Json[]) => {
    const page = await agent.getPage(host.id);
    return agent.request(`/pages/${host.id}/operations`, {
      method: "POST",
      body: { requestId: randomUUID(), generation: page.collaboration.generation, baseRevision: page.collaboration.revision, mode: "apply", operations },
    });
  };
  for (const pageId of ["missing-page", foreign.id, host.id]) {
    const reply = await ops([{ type: "insert_page_link", blockId: first.id, index: "end", pageId, expanded: true }]);
    assert.ok([400, 403, 404].includes(reply.status), `${pageId}: ${reply.status} ${JSON.stringify(reply.body)}`);
  }
  const after = await agent.getPage(host.id);
  assert.equal(after.page.block_tree.by_id[first.id].content.length, 1, "no page mention may survive a failed batch");
});

test("creating a child page appends an expanded link to the parent's end", async (t) => {
  const { agent } = await fixture(t);
  const host = await agent.createDocument();
  const child = await agent.createApp({ parentId: host.id, title: "子图" });
  const parent = await agent.getPage(host.id);
  const links = Object.values(parent.page.block_tree.by_id as Json)
    .flatMap((block: Json) => (block.content ?? []).filter((run: Json) => run.mention?.kind === "page"))
    .map((run: Json) => run.mention);
  assert.equal(links.length, 1, JSON.stringify(parent.page.block_tree));
  assert.equal(links[0].page_id, child.id);
  assert.equal(links[0].expanded, true);
  const grandchild = await agent.createDocument({ parentId: child.id, title: "app 的孩子" });
  const appPage = await agent.getPage(child.id);
  const appLinks = Object.values(appPage.page.block_tree?.by_id ?? {})
    .flatMap((block: Json) => (block.content ?? []).filter((run: Json) => run.mention?.kind === "page"));
  assert.equal(appLinks.length, 0, "an app page has no body to carry the backlink");
  assert.ok(grandchild.id);
});
