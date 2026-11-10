import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import WebSocket from "ws";
import * as Y from "yjs";
import { startServer } from "../server/index.ts";

// These tests use the real HTTP/WebSocket service. Yjs operations are generated
// independently of the application's editor adapter and server implementation.
type Json = any;
type Server = Awaited<ReturnType<typeof startServer>>;
interface Snapshot {
  scope: string;
  pageId: string;
  generation: string;
  state: string;
  revision: string;
  canEdit: boolean;
  records: { page: Json; blocks: Array<{ id: string; value: Json }> };
}
interface Reply { status: number; body: Json }
interface Options { method?: string; body?: unknown; token?: string }
const password = "Independent-collaboration-test-2026!";

class Browser {
  cookie = "";
  constructor(readonly url: () => string) {}
  async request(path: string, { method = "GET", body, token }: Options = {}): Promise<Reply> {
    const response = await fetch(this.url() + path, {
      method,
      headers: {
        Origin: this.url(),
        ...(token ? { Authorization: `Bearer ${token}` } : this.cookie ? { Cookie: this.cookie } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
    });
    if (!token) for (const entry of response.headers.getSetCookie()) {
      const first = entry.split(";", 1)[0];
      if (first.startsWith("notes_session=")) this.cookie = /max-age=0/i.test(entry) ? "" : first;
    }
    const raw = await response.text();
    if (raw) assert.match(response.headers.get("content-type") ?? "", /application\/json/, `${path} returned HTML instead of an API response`);
    return { status: response.status, body: raw ? JSON.parse(raw) : null };
  }
}
const ok = (reply: Reply, expected = 200): Json => {
  assert.equal(reply.status, expected, JSON.stringify(reply.body));
  return reply.body;
};
const denied = (reply: Reply): void => {
  assert.ok([401, 403, 404].includes(reply.status), `Expected authorization refusal, received ${reply.status}: ${JSON.stringify(reply.body)}`);
};

class Feed {
  readonly socket: WebSocket;
  readonly messages: Json[] = [];
  closed = false;
  rejectedStatus: number | null = null;
  private watchers = new Set<() => void>();
  private constructor(browser: Browser, origin: string) {
    this.socket = new WebSocket(browser.url().replace(/^http/, "ws") + "/api/collaboration", {
      headers: { Origin: origin, ...(browser.cookie ? { Cookie: browser.cookie } : {}) },
    });
    this.socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()); this.messages.push(message); this.notify();
    });
    this.socket.on("close", () => { this.closed = true; this.notify(); });
    this.socket.on("unexpected-response", (_request, response) => {
      this.rejectedStatus = response.statusCode ?? null; response.resume(); this.closed = true; this.socket.terminate(); this.notify();
    });
    this.socket.on("error", () => this.notify());
  }
  private notify() { for (const watcher of this.watchers) watcher(); }
  static async connect(browser: Browser, origin = browser.url()): Promise<Feed> {
    const feed = new Feed(browser, origin);
    await feed.waitUntil(() => feed.socket.readyState === WebSocket.OPEN || feed.closed, 3000);
    return feed;
  }
  private async waitUntil(predicate: () => boolean, milliseconds = 3000): Promise<void> {
    if (predicate()) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.watchers.delete(check); this.socket.removeListener("open", check); };
      const check = () => { if (predicate()) { cleanup(); resolve(); } };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`WebSocket condition not met; messages=${JSON.stringify(this.messages)}`)); }, milliseconds);
      this.watchers.add(check);
      // Opening a socket is not an incoming document message.
      this.socket.once("open", check);
      check();
    });
  }
  subscribe(scope: string, pageId: string) {
    assert.equal(this.socket.readyState, WebSocket.OPEN);
    this.socket.send(JSON.stringify({ type: "subscribe", scope, pageId }));
  }
  private events(after: number): Json[] {
    return this.messages.slice(after).flatMap((message) => {
      if (message.type !== "commit") return [message];
      assert.ok(Array.isArray(message.documents), "An atomic commit must contain document events");
      for (const event of message.documents) {
        assert.ok(["document", "reset"].includes(event.type));
        assert.ok(event.snapshot, "Every committed document must include its snapshot");
      }
      return message.documents;
    });
  }
  async message(predicate: (message: Json) => boolean, after = 0, milliseconds = 3000): Promise<Json> {
    await this.waitUntil(() => this.events(after).some(predicate), milliseconds);
    return this.events(after).find(predicate);
  }
  async refused(after = 0): Promise<void> {
    await this.waitUntil(() => this.closed || this.events(after).some((message) => ["revoked", "error"].includes(message.type)));
    assert.equal(this.events(after).some((message) => ["document", "update", "reset"].includes(message.type)), false, "A refused subscriber must not receive document content, including content nested in a commit");
  }
  async quiet(after: number, milliseconds = 150): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    assert.equal(this.events(after).some((message) => ["document", "update", "reset"].includes(message.type)), false, "A rolled-back or unauthorized write must not broadcast document content, including content nested in a commit");
  }
  async close() {
    if (this.socket.readyState === WebSocket.CLOSED || this.closed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.socket.terminate(); resolve(); }, 500);
      this.socket.once("close", () => { clearTimeout(timer); resolve(); });
      this.socket.close();
    });
  }
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "notes-collaboration-http-"));
  let server: Server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false });
  const feeds = new Set<Feed>();
  const closeFeeds = async () => { await Promise.all([...feeds].map((feed) => feed.close())); feeds.clear(); };
  t.after(async () => {
    await closeFeeds(); await server.close();
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("notes-collaboration-http-"));
    await rm(target, { recursive: true, force: true });
  });
  return {
    browser: () => new Browser(() => server.url),
    async feed(browser: Browser, origin?: string) { const feed = await Feed.connect(browser, origin); feeds.add(feed); return feed; },
    async restart() { await closeFeeds(); await server.close(); server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false }); },
  };
}
async function register(browser: Browser, handle: string) {
  return ok(await browser.request("/api/auth/register", { method: "POST", body: { handle, displayName: handle, password } }), 201).user;
}
async function makeToken(browser: Browser, access: "read" | "write" = "write") {
  return ok(await browser.request("/api/tokens", { method: "POST", body: { name: "Independent collaboration Agent", access } }), 201);
}
async function shared(t: TestContext, initial = "起点😀终点") {
  const f = await fixture(t); const alice = f.browser(); const bob = f.browser();
  const aliceUser = await register(alice, "alice"); const bobUser = await register(bob, "bob");
  const space = ok(await alice.request("/api/spaces", { method: "POST", body: { name: "Independent collaboration" } }), 201);
  const token = await makeToken(alice);
  const page = ok(await alice.request("/api/v1/pages", { method: "POST", token: token.token, body: { title: "共同编辑", text: initial, spaceId: space.spaceId } }), 201);
  ok(await alice.request(`/api/spaces/${space.spaceId}/invitations`, { method: "POST", body: { handle: "bob", role: "editor" } }));
  const invitation = ok(await bob.request("/api/invitations"))[0];
  ok(await bob.request(`/api/invitations/${invitation.id}`, { method: "POST", body: { accept: true } }));
  const blocks = ok(await alice.request(`/api/records/${space.spaceId}/blocks`));
  const block = blocks.find((row: Json) => row.value.page === page.id);
  assert.ok(block, "Creating a document must create an editor block");
  return { f, alice, bob, aliceUser, bobUser, token, scope: String(space.spaceId), pageId: String(page.id), block, bodyKey: `blocks/${block.id}/content`, titleKey: `pages/${page.id}/title_content` };
}
async function snapshot(browser: Browser, scope: string, pageId: string): Promise<Snapshot> {
  const value = ok(await browser.request(`/api/collaboration/${scope}/${pageId}`));
  assert.equal(value.scope, scope); assert.equal(value.pageId, pageId);
  assert.equal(typeof value.generation, "string"); assert.ok(value.generation);
  assert.equal(typeof value.state, "string"); assert.ok(value.state);
  assert.equal(typeof value.revision, "string"); assert.ok(value.revision);
  assert.equal(typeof value.canEdit, "boolean");
  assertSnapshotProjection(value);
  return value;
}
function fork(value: Snapshot): Y.Doc {
  const doc = new Y.Doc(); Y.applyUpdate(doc, Buffer.from(value.state, "base64")); return doc;
}
function field(doc: Y.Doc, key: string): Y.Text {
  const value = doc.getMap<Y.Text>("fields").get(key);
  assert.ok(value instanceof Y.Text, `The persisted CRDT field ${key} must be Y.Text`);
  return value;
}
function update(doc: Y.Doc, work: () => void, origin: unknown = "independent-test"): string {
  const before = Y.encodeStateVector(doc); doc.transact(work, origin);
  return Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString("base64");
}
function historyUpdate(doc: Y.Doc, work: () => void): string {
  const before = Y.encodeStateVector(doc);
  // UndoManager must own its transaction until its undo/redo flags are cleared.
  work();
  return Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString("base64");
}
const expected = (value: Snapshot) => ({ scope: value.scope, pageId: value.pageId, generation: value.generation, revision: value.revision });
async function submit(browser: Browser, value: Snapshot, bytes: string, more: Record<string, unknown> = {}): Promise<Reply> {
  return browser.request("/api/records/batch", { method: "POST", body: { requestId: randomUUID(), writes: [], textUpdates: [{ scope: value.scope, pageId: value.pageId, generation: value.generation, update: bytes }], ...more } });
}
function text(value: Snapshot, key: string): string { const doc = fork(value); try { return field(doc, key).toString(); } finally { doc.destroy(); } }
function assertSnapshotProjection(value: Snapshot): void {
  assert.equal(value.records?.page?.id, value.pageId, "A snapshot must include its matching page record");
  assert.ok(Array.isArray(value.records.blocks));
  assert.ok(value.records.blocks.every((row) => row.value.page === value.pageId), "A document snapshot cannot include another page's blocks");
  const doc = fork(value);
  try {
    for (const [key, shared] of doc.getMap<Y.Text>("fields")) {
      assert.ok(shared instanceof Y.Text);
      const [collection, encodedId, ...encodedPath] = key.split("/");
      const id = decodeURIComponent(encodedId);
      let projected = collection === "pages" && id === value.pageId ? value.records.page : value.records.blocks.find((row) => row.id === id)?.value;
      for (const segment of encodedPath) projected = projected?.[decodeURIComponent(segment)];
      assert.ok(Array.isArray(projected), `The snapshot must project its shared field ${key}`);
      const words = projected.filter((run: Json) => typeof run.text === "string").map((run: Json) => run.text).join("");
      assert.equal(words, shared.toString(), "The snapshot's SQL records and binary text must describe the same committed state");
      assert.equal(projected.filter((run: Json) => run.embed !== undefined).length, shared.toDelta().filter((part: Json) => typeof part.insert === "object").length);
    }
  } finally { doc.destroy(); }
}
function messageSnapshot(message: Json): Snapshot {
  assert.ok(message.snapshot, "Document WebSocket messages must carry a committed snapshot");
  assertSnapshotProjection(message.snapshot);
  return message.snapshot;
}


test("binary snapshots retain shared Y.Text identities and capabilities across restart", { timeout: 10000 }, async (t) => {
  const s = await shared(t);
  const original = await snapshot(s.alice, s.scope, s.pageId);
  assert.equal(original.canEdit, true);
  assert.equal(text(original, s.bodyKey), "起点😀终点");
  assert.equal(text(original, s.titleKey), "共同编辑");
  const peer = await snapshot(s.bob, s.scope, s.pageId);
  assert.equal(peer.generation, original.generation); assert.equal(peer.state, original.state); assert.equal(peer.revision, original.revision);
  const offline = fork(original);
  const offlineBytes = update(offline, () => field(offline, s.bodyKey).insert(field(offline, s.bodyKey).length, "离线甲"));
  const remote = fork(peer);
  const remoteBytes = update(remote, () => field(remote, s.bodyKey).insert(0, "在线乙"));
  ok(await submit(s.bob, peer, remoteBytes));
  const beforeRestart = await snapshot(s.bob, s.scope, s.pageId);
  await s.f.restart();
  const afterRestart = await snapshot(s.alice, s.scope, s.pageId);
  assert.equal(afterRestart.generation, original.generation);
  const beforeDoc = fork(beforeRestart); const afterDoc = fork(afterRestart);
  assert.deepEqual(Y.encodeStateVector(afterDoc), Y.encodeStateVector(beforeDoc), "Loading a database must preserve CRDT identities, not seed new ones from JSON");
  const anchor = Y.createRelativePositionFromTypeIndex(field(beforeDoc, s.bodyKey), 2);
  const restoredAnchor = Y.createAbsolutePositionFromRelativePosition(anchor, afterDoc);
  assert.ok(restoredAnchor); assert.equal(restoredAnchor.index, 2); assert.equal(restoredAnchor.type, field(afterDoc, s.bodyKey));
  beforeDoc.destroy(); afterDoc.destroy();
  assert.equal(afterRestart.revision, beforeRestart.revision);
  ok(await submit(s.alice, original, offlineBytes));
  const final = await snapshot(s.alice, s.scope, s.pageId);
  assert.equal(text(final, s.bodyKey), "在线乙起点😀终点离线甲");
  offline.destroy(); remote.destroy();
});

test("two peers merge same-field updates released in reverse order and duplicate updates stay idempotent", { timeout: 10000 }, async (t) => {
  const s = await shared(t);
  const base = await snapshot(s.alice, s.scope, s.pageId);
  const a = fork(base); const b = fork(base);
  const aUpdate = update(a, () => { field(a, s.bodyKey).insert(0, "甲"); field(a, s.titleKey).insert(0, "A"); });
  const bUpdate = update(b, () => { field(b, s.bodyKey).insert(0, "乙"); field(b, s.titleKey).insert(0, "B"); });
  // Both operations are made before either request. B arrives before A.
  ok(await submit(s.bob, base, bUpdate));
  const intermediate = await snapshot(s.bob, s.scope, s.pageId);
  assert.notEqual(intermediate.revision, base.revision);
  const requestId = randomUUID();
  ok(await submit(s.alice, base, aUpdate, { requestId }));
  ok(await submit(s.alice, base, aUpdate, { requestId }));
  ok(await submit(s.alice, base, bUpdate, { requestId }), 409);
  const merged = await snapshot(s.alice, s.scope, s.pageId);
  assert.equal(merged.generation, base.generation, "Ordinary typing must not rotate the generation");
  const body = text(merged, s.bodyKey); const title = text(merged, s.titleKey);
  assert.ok(body.includes("甲") && body.includes("乙") && body.includes("起点😀终点"));
  assert.equal(body.length, "甲乙起点😀终点".length);
  assert.ok(title.includes("A") && title.includes("B") && title.includes("共同编辑"));
  ok(await submit(s.alice, base, aUpdate));
  ok(await submit(s.bob, base, bUpdate));
  const replayed = await snapshot(s.bob, s.scope, s.pageId);
  assert.equal(text(replayed, s.bodyKey), body); assert.equal(text(replayed, s.titleKey), title);
  Y.applyUpdate(a, Buffer.from(replayed.state, "base64")); Y.applyUpdate(b, Buffer.from(replayed.state, "base64"));
  assert.deepEqual(field(a, s.bodyKey).toDelta(), field(b, s.bodyKey).toDelta());
  const blocks = ok(await s.alice.request(`/api/records/${s.scope}/blocks`));
  const projection = blocks.find((row: Json) => row.id === s.block.id).value.content;
  assert.equal(projection.filter((run: Json) => typeof run.text === "string").map((run: Json) => run.text).join(""), body);
  a.destroy(); b.destroy();
});

test("concurrent formatting and atomic mentions preserve rich runs and UTF-16 emoji", { timeout: 10000 }, async (t) => {
  const s = await shared(t);
  const base = await snapshot(s.alice, s.scope, s.pageId);
  const a = fork(base); const b = fork(base);
  const format = update(a, () => field(a, s.bodyKey).format(0, 2, { bold: true, color: "blue" }));
  const mention = { mention: { kind: "date", date: "2026-11-05" } };
  const embed = update(b, () => field(b, s.bodyKey).insertEmbed(2, mention));
  ok(await submit(s.bob, base, embed)); ok(await submit(s.alice, base, format));
  const final = await snapshot(s.alice, s.scope, s.pageId); const doc = fork(final);
  const delta = field(doc, s.bodyKey).toDelta();
  assert.equal(field(doc, s.bodyKey).length, "起点😀终点".length + 1, "A mention is exactly one shared-text element");
  assert.equal(delta.filter((entry: Json) => typeof entry.insert === "string").map((entry: Json) => entry.insert).join(""), "起点😀终点");
  assert.equal(delta.filter((entry: Json) => typeof entry.insert === "object").length, 1);
  assert.deepEqual(delta.find((entry: Json) => typeof entry.insert === "object")?.insert, mention);
  assert.ok(delta.some((entry: Json) => typeof entry.insert === "string" && entry.insert.includes("起点") && entry.attributes?.bold === true && entry.attributes?.color === "blue"));
  const rows = ok(await s.alice.request(`/api/records/${s.scope}/blocks`));
  const projection = rows.find((row: Json) => row.id === s.block.id).value.content;
  assert.deepEqual(projection.find((run: Json) => run.embed)?.embed, mention);
  assert.ok(projection.some((run: Json) => run.text?.includes("起点") && run.marks?.bold === true));
  a.destroy(); b.destroy(); doc.destroy();
});

test("selective undo and redo submitted as binary updates preserve the other peer's text", { timeout: 10000 }, async (t) => {
  const s = await shared(t, "基线");
  const base = await snapshot(s.alice, s.scope, s.pageId);
  const a = fork(base); const b = fork(base); const origin = { session: "alice-only" };
  const undo = new Y.UndoManager(a.getMap("fields"), { trackedOrigins: new Set([origin]) });
  const aUpdate = update(a, () => field(a, s.bodyKey).insert(field(a, s.bodyKey).length, "甲的修改"), origin);
  const bUpdate = update(b, () => field(b, s.bodyKey).insert(0, "乙的修改"), { session: "bob-only" });
  ok(await submit(s.alice, base, aUpdate)); ok(await submit(s.bob, base, bUpdate));
  const merged = await snapshot(s.alice, s.scope, s.pageId);
  Y.applyUpdate(a, Buffer.from(merged.state, "base64"), { remote: true });
  assert.equal(undo.undoStack.length, 1);
  const inverse = historyUpdate(a, () => { undo.undo(); });
  ok(await submit(s.alice, merged, inverse));
  const undone = await snapshot(s.bob, s.scope, s.pageId);
  assert.equal(text(undone, s.bodyKey), "乙的修改基线");
  const redo = historyUpdate(a, () => { undo.redo(); });
  ok(await submit(s.alice, undone, redo));
  const redone = await snapshot(s.bob, s.scope, s.pageId);
  assert.equal(text(redone, s.bodyKey), "乙的修改基线甲的修改");
  undo.destroy(); a.destroy(); b.destroy();
});

test("structural writes reject a stale complete revision and reset rejects old-generation text", { timeout: 10000 }, async (t) => {
  const s = await shared(t);
  const base = await snapshot(s.alice, s.scope, s.pageId);
  const offline = fork(base);
  const oldUpdate = update(offline, () => field(offline, s.bodyKey).insert(0, "陈旧草稿"));
  const peer = fork(base);
  const accepted = update(peer, () => field(peer, s.bodyKey).insert(0, "已落盘文字"));
  ok(await submit(s.bob, base, accepted));
  const newBlockId = "new_block"; const recordId = `${s.pageId.length}_${s.pageId}_${newBlockId}`;
  const currentBlock = ok(await s.alice.request(`/api/records/${s.scope}/blocks`)).find((row: Json) => row.id === s.block.id).value;
  const writes = [
    { scope: s.scope, collection: "blocks", id: s.block.id, action: "patch", base: currentBlock, patch: { content: [{ text: "已落盘文字" }] } },
    { scope: s.scope, collection: "blocks", id: recordId, action: "put", value: { id: newBlockId, page: s.pageId, kind: "text", order: 2048, content: [{ text: "起点😀终点" }] } },
  ];
  const stale = await s.alice.request("/api/records/batch", { method: "POST", body: { requestId: randomUUID(), writes, textUpdates: [], expectedPages: [expected(base)] } });
  ok(stale, 409);
  const afterRefusal = await snapshot(s.alice, s.scope, s.pageId);
  assert.equal(text(afterRefusal, s.bodyKey), "已落盘文字起点😀终点");
  assert.equal(ok(await s.alice.request(`/api/records/${s.scope}/blocks`)).some((row: Json) => row.id === recordId), false);
  ok(await s.alice.request("/api/records/batch", { method: "POST", body: { requestId: randomUUID(), writes, textUpdates: [], expectedPages: [expected(afterRefusal)] } }));
  const reset = await snapshot(s.alice, s.scope, s.pageId);
  assert.notEqual(reset.generation, base.generation);
  assert.equal(text(reset, s.bodyKey), "已落盘文字");
  assert.equal(text(reset, `blocks/${recordId}/content`), "起点😀终点");
  ok(await submit(s.alice, base, oldUpdate), 409);
  assert.equal(text(await snapshot(s.alice, s.scope, s.pageId), s.bodyKey), "已落盘文字");
  offline.destroy(); peer.destroy();
});

test("existing-page structure requires a full basis while blank insertion and movement preserve text undo", { timeout: 10000 }, async (t) => {
  const s = await shared(t, "保留基线");
  const base = await snapshot(s.alice, s.scope, s.pageId); const local = fork(base); const origin = { window: "alice" };
  const undo = new Y.UndoManager(local.getMap("fields"), { trackedOrigins: new Set([origin]) });
  ok(await submit(s.alice, base, update(local, () => field(local, s.bodyKey).insert(0, "甲"), origin)));
  const typed = await snapshot(s.alice, s.scope, s.pageId);
  const blockId = "empty_block"; const id = `${s.pageId.length}_${s.pageId}_${blockId}`;
  const value = { id: blockId, page: s.pageId, kind: "text", order: 2048, content: [] };
  const writes = [{ scope: s.scope, collection: "blocks", id, action: "put", value }];
  ok(await s.alice.request("/api/records/batch", { method: "POST", body: { requestId: randomUUID(), writes } }), 409);
  assert.equal((await snapshot(s.alice, s.scope, s.pageId)).state, typed.state);
  ok(await s.alice.request("/api/records/batch", { method: "POST", body: { requestId: randomUUID(), writes, expectedPages: [expected(typed)] } }));
  const inserted = await snapshot(s.alice, s.scope, s.pageId);
  assert.equal(inserted.generation, typed.generation, "Adding an empty block must retain existing text identities and undo");
  const row = ok(await s.alice.request(`/api/records/${s.scope}/blocks`)).find((record: Json) => record.id === id).value;
  ok(await s.alice.request("/api/records/batch", { method: "POST", body: { requestId: randomUUID(), expectedPages: [expected(inserted)], writes: [{ scope: s.scope, collection: "blocks", id, action: "patch", base: row, patch: { order: 4096 } }] } }));
  const moved = await snapshot(s.alice, s.scope, s.pageId);
  assert.equal(moved.records.blocks.find((record) => record.id === id)?.value.order, 4096, "A metadata snapshot must include the committed block movement");
  assert.equal(moved.generation, typed.generation, "Moving a block must retain existing text identities and undo");
  Y.applyUpdate(local, Buffer.from(moved.state, "base64"), { remoteStructure: true });
  assert.equal(undo.undoStack.length, 1);
  ok(await submit(s.alice, moved, historyUpdate(local, () => { undo.undo(); })));
  assert.equal(text(await snapshot(s.bob, s.scope, s.pageId), s.bodyKey), "保留基线");
  assert.equal(ok(await s.alice.request(`/api/records/${s.scope}/blocks`)).find((record: Json) => record.id === id).value.order, 4096);
  undo.destroy(); local.destroy();
});

test("WebSocket publishes committed snapshots and never publishes a rolled-back text batch", { timeout: 10000 }, async (t) => {
  const s = await shared(t);
  const feed = await s.f.feed(s.bob); feed.subscribe(s.scope, s.pageId);
  const initial = messageSnapshot(await feed.message((message) => message.type === "document"));
  const baseline = await snapshot(s.alice, s.scope, s.pageId);
  assert.equal(initial.generation, baseline.generation); assert.equal(initial.revision, baseline.revision);
  const a = fork(baseline); const bytes = update(a, () => field(a, s.bodyKey).insert(0, "事务文字"));
  const mark = feed.messages.length;
  denied(await submit(s.alice, baseline, bytes, { writes: [{ scope: "unauthorized-space", collection: "pages", id: "forbidden", action: "delete", base: null }] }));
  await feed.quiet(mark);
  const unchanged = await snapshot(s.alice, s.scope, s.pageId);
  assert.equal(unchanged.state, baseline.state); assert.equal(unchanged.revision, baseline.revision);
  ok(await submit(s.alice, baseline, bytes));
  const pushed = messageSnapshot(await feed.message((message) => message.type === "document", mark));
  const durable = await snapshot(s.alice, s.scope, s.pageId);
  assert.equal(pushed.revision, durable.revision); assert.equal(text(pushed, s.bodyKey), "事务文字起点😀终点");
  // A WebSocket client cannot bypass the transactional HTTP update boundary.
  const beforeDirectWrite = durable.state;
  const direct = fork(durable);
  const bypass = update(direct, () => field(direct, s.bodyKey).insert(0, "绕过HTTP"));
  feed.socket.send(JSON.stringify({ type: "update", scope: s.scope, pageId: s.pageId, generation: durable.generation, update: bypass }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal((await snapshot(s.alice, s.scope, s.pageId)).state, beforeDirectWrite);
  a.destroy(); direct.destroy();
});

test("viewer and removed member cannot submit CRDT changes and revoked feeds stop receiving content", { timeout: 10000 }, async (t) => {
  const s = await shared(t);
  const viewer = s.f.browser(); await register(viewer, "viewer");
  ok(await s.alice.request(`/api/spaces/${s.scope}/invitations`, { method: "POST", body: { handle: "viewer", role: "viewer" } }));
  const invite = ok(await viewer.request("/api/invitations"))[0];
  ok(await viewer.request(`/api/invitations/${invite.id}`, { method: "POST", body: { accept: true } }));
  const readOnly = await snapshot(viewer, s.scope, s.pageId); assert.equal(readOnly.canEdit, false);
  const viewerDoc = fork(readOnly); const forged = update(viewerDoc, () => field(viewerDoc, s.bodyKey).insert(0, "越权"));
  denied(await submit(viewer, readOnly, forged));
  const feed = await s.f.feed(s.bob); feed.subscribe(s.scope, s.pageId);
  await feed.message((message) => message.type === "document"); const mark = feed.messages.length;
  ok(await s.alice.request(`/api/spaces/${s.scope}/members/${s.bobUser.id}`, { method: "DELETE" }));
  await feed.refused(mark);
  denied(await s.bob.request(`/api/collaboration/${s.scope}/${s.pageId}`));
  denied(await submit(s.bob, readOnly, forged));
  const ownerBase = await snapshot(s.alice, s.scope, s.pageId); const ownerDoc = fork(ownerBase);
  ok(await submit(s.alice, ownerBase, update(ownerDoc, () => field(ownerDoc, s.bodyKey).insert(0, "撤权后"))));
  await feed.quiet(mark);
  assert.equal(text(await snapshot(viewer, s.scope, s.pageId), s.bodyKey), "撤权后起点😀终点");
  const newFeed = await s.f.feed(s.bob); if (!newFeed.closed) newFeed.subscribe(s.scope, s.pageId); await newFeed.refused();
  viewerDoc.destroy(); ownerDoc.destroy();
});

test("logout invalidates an existing feed and stale-cookie or foreign-origin subscriptions are refused", { timeout: 10000 }, async (t) => {
  const s = await shared(t);
  const feed = await s.f.feed(s.bob); feed.subscribe(s.scope, s.pageId);
  await feed.message((message) => message.type === "document"); const mark = feed.messages.length;
  const staleCookie = s.bob.cookie;
  ok(await s.bob.request("/api/auth/logout", { method: "POST" }));
  await feed.refused(mark);
  const stale = s.f.browser(); stale.cookie = staleCookie;
  denied(await stale.request(`/api/collaboration/${s.scope}/${s.pageId}`));
  const retry = await s.f.feed(stale); if (!retry.closed) retry.subscribe(s.scope, s.pageId); await retry.refused();
  const foreign = await s.f.feed(s.alice, "https://foreign.invalid");
  if (!foreign.closed) foreign.subscribe(s.scope, s.pageId);
  await foreign.refused();
});

test("version restore creates a new generation and rejects disconnected edits from the restored generation", { timeout: 10000 }, async (t) => {
  const s = await shared(t, "检查点正文");
  const initial = await snapshot(s.alice, s.scope, s.pageId);
  const version = ok(await s.alice.request(`/api/v1/pages/${s.pageId}/checkpoint`, { method: "POST", token: s.token.token }));
  const a = fork(initial); ok(await submit(s.alice, initial, update(a, () => field(a, s.bodyKey).insert(0, "后续修改"))));
  const beforeRestore = await snapshot(s.alice, s.scope, s.pageId); const offline = fork(beforeRestore);
  const stale = update(offline, () => field(offline, s.bodyKey).insert(0, "离线未确认"));
  const feed = await s.f.feed(s.bob); feed.subscribe(s.scope, s.pageId);
  await feed.message((message) => message.type === "document"); const mark = feed.messages.length;
  ok(await s.alice.request(`/api/v1/pages/${s.pageId}/restore`, { method: "POST", token: s.token.token, body: { versionId: version.id } }));
  const restored = await snapshot(s.alice, s.scope, s.pageId);
  assert.notEqual(restored.generation, beforeRestore.generation); assert.equal(text(restored, s.bodyKey), "检查点正文");
  const reset = messageSnapshot(await feed.message((message) => message.type === "reset", mark));
  assert.equal(reset.generation, restored.generation);
  ok(await submit(s.bob, beforeRestore, stale), 409);
  const versions = ok(await s.alice.request(`/api/v1/pages/${s.pageId}/versions`, { token: s.token.token }));
  assert.ok(versions.some((entry: Json) => JSON.stringify(entry.snapshot).includes("后续修改")), "Restoring must preserve the pre-restore content in history");
  assert.equal(text(await snapshot(s.bob, s.scope, s.pageId), s.bodyKey), "检查点正文");
  a.destroy(); offline.destroy();
});

test("split and merge compensation batches retain both halves and reject a stale structural undo", { timeout: 10000 }, async (t) => {
  const s = await shared(t, "前半后半");
  const base = await snapshot(s.alice, s.scope, s.pageId);
  const newId = "split_suffix"; const newRecordId = `${s.pageId.length}_${s.pageId}_${newId}`;
  const newKey = `blocks/${newRecordId}/content`;
  const rows = async (): Promise<Json[]> => ok(await s.alice.request(`/api/records/${s.scope}/blocks`));
  const split = async (basis: Snapshot) => {
    const current = (await rows()).find((row: Json) => row.id === s.block.id).value;
    return s.alice.request("/api/records/batch", { method: "POST", body: {
      requestId: randomUUID(), expectedPages: [expected(basis)], textUpdates: [], writes: [
        { scope: s.scope, collection: "blocks", id: s.block.id, action: "patch", base: current, patch: { content: [{ text: "前半" }] } },
        { scope: s.scope, collection: "blocks", id: newRecordId, action: "put", value: { id: newId, page: s.pageId, kind: "text", order: 2048, content: [{ text: "后半" }] } },
      ],
    } });
  };
  const mergeRequest = (basis: Snapshot, body: Json, suffix: Json, combined: string) => ({
    requestId: randomUUID(), expectedPages: [expected(basis)], textUpdates: [], writes: [
      { scope: s.scope, collection: "blocks", id: s.block.id, action: "patch", base: body, patch: { content: [{ text: combined }] } },
      { scope: s.scope, collection: "blocks", id: newRecordId, action: "delete", base: suffix },
    ],
  });
  ok(await split(base));
  const afterSplit = await snapshot(s.alice, s.scope, s.pageId);
  assert.notEqual(afterSplit.generation, base.generation);
  assert.equal(text(afterSplit, s.bodyKey), "前半"); assert.equal(text(afterSplit, newKey), "后半");
  let parts = await rows();
  const receipt = mergeRequest(afterSplit, parts.find((row: Json) => row.id === s.block.id).value, parts.find((row: Json) => row.id === newRecordId).value, "前半后半");
  ok(await s.alice.request("/api/records/batch", { method: "POST", body: receipt }));
  const afterUndo = await snapshot(s.alice, s.scope, s.pageId);
  assert.notEqual(afterUndo.generation, afterSplit.generation); assert.equal(text(afterUndo, s.bodyKey), "前半后半");
  assert.equal((await rows()).some((row: Json) => row.id === newRecordId), false);
  // Redo the split, then let another participant edit its suffix before undo.
  ok(await split(afterUndo));
  const redone = await snapshot(s.alice, s.scope, s.pageId);
  parts = await rows();
  const staleUndo = mergeRequest(redone, parts.find((row: Json) => row.id === s.block.id).value, parts.find((row: Json) => row.id === newRecordId).value, "前半后半");
  const peer = fork(redone);
  ok(await submit(s.bob, redone, update(peer, () => field(peer, newKey).insert(field(peer, newKey).length, "乙"))));
  ok(await s.alice.request("/api/records/batch", { method: "POST", body: staleUndo }), 409);
  const kept = await snapshot(s.alice, s.scope, s.pageId);
  assert.equal(text(kept, s.bodyKey), "前半"); assert.equal(text(kept, newKey), "后半乙");
  // An explicit fresh compensation can include both current halves. It cannot
  // silently replay the older whole-content value over the peer's edit.
  parts = await rows();
  const safeMerge = mergeRequest(kept, parts.find((row: Json) => row.id === s.block.id).value, parts.find((row: Json) => row.id === newRecordId).value, text(kept, s.bodyKey) + text(kept, newKey));
  ok(await s.alice.request("/api/records/batch", { method: "POST", body: safeMerge }));
  assert.equal(text(await snapshot(s.bob, s.scope, s.pageId), s.bodyKey), "前半后半乙");
  peer.destroy();
});

test("Agent semantic inserts merge with a human update, remain idempotent, and stay out of personal undo", { timeout: 10000 }, async (t) => {
  const s = await shared(t, "共同基线");
  const base = await snapshot(s.alice, s.scope, s.pageId);
  const human = fork(base); const origin = { localWindow: "human" };
  const undo = new Y.UndoManager(human.getMap("fields"), { trackedOrigins: new Set([origin]) });
  const humanBytes = update(human, () => field(human, s.bodyKey).insert(0, "人的文字"), origin);
  const operation = { requestId: randomUUID(), generation: base.generation, mode: "apply", operations: [{ type: "insert_text", blockId: s.block.value.id, index: "end", text: "Agent的文字" }] };
  ok(await s.alice.request(`/api/v1/pages/${s.pageId}/operations`, { method: "POST", token: s.token.token, body: operation }));
  // Repeat a committed request without reading a newer revision.
  ok(await s.alice.request(`/api/v1/pages/${s.pageId}/operations`, { method: "POST", token: s.token.token, body: operation }));
  ok(await submit(s.alice, base, humanBytes));
  const merged = await snapshot(s.alice, s.scope, s.pageId);
  assert.equal(merged.generation, base.generation);
  assert.equal(text(merged, s.bodyKey), "人的文字共同基线Agent的文字");
  Y.applyUpdate(human, Buffer.from(merged.state, "base64"), { remoteAgentAndPeer: true });
  ok(await submit(s.alice, merged, historyUpdate(human, () => { undo.undo(); })));
  assert.equal(text(await snapshot(s.bob, s.scope, s.pageId), s.bodyKey), "共同基线Agent的文字");
  ok(await s.alice.request(`/api/v1/pages/${s.pageId}/operations`, { method: "POST", token: s.token.token, body: { ...operation, operations: [{ type: "insert_text", blockId: s.block.value.id, index: "end", text: "不同重放" }] } }), 409);
  undo.destroy(); human.destroy();
});

test("Agent numeric edits require a current full revision and read-only tokens cannot write", { timeout: 10000 }, async (t) => {
  const s = await shared(t, "基础文字");
  const stale = await snapshot(s.alice, s.scope, s.pageId);
  const doc = fork(stale);
  ok(await submit(s.bob, stale, update(doc, () => field(doc, s.bodyKey).insert(0, "新"))));
  const current = await snapshot(s.alice, s.scope, s.pageId);
  const action = { generation: current.generation, mode: "apply", operations: [{ type: "delete_text", blockId: s.block.value.id, index: 0, length: 1 }] };
  const missing = await s.alice.request(`/api/v1/pages/${s.pageId}/operations`, { method: "POST", token: s.token.token, body: { ...action, requestId: randomUUID() } });
  assert.ok([400, 409].includes(missing.status), `A numeric edit without baseRevision must be refused: ${JSON.stringify(missing)}`);
  ok(await s.alice.request(`/api/v1/pages/${s.pageId}/operations`, { method: "POST", token: s.token.token, body: { ...action, requestId: randomUUID(), baseRevision: stale.revision } }), 409);
  const readToken = await makeToken(s.alice, "read");
  denied(await s.alice.request(`/api/v1/pages/${s.pageId}/operations`, { method: "POST", token: readToken.token, body: { requestId: randomUUID(), generation: current.generation, mode: "apply", operations: [{ type: "insert_text", blockId: s.block.value.id, index: "end", text: "越权" }] } }));
  const unchanged = await snapshot(s.alice, s.scope, s.pageId);
  assert.equal(unchanged.state, current.state); assert.equal(unchanged.revision, current.revision);
  ok(await s.alice.request(`/api/v1/pages/${s.pageId}/operations`, { method: "POST", token: s.token.token, body: { ...action, requestId: randomUUID(), baseRevision: current.revision } }));
  assert.equal(text(await snapshot(s.bob, s.scope, s.pageId), s.bodyKey), "基础文字");
  doc.destroy();
});

test("stop-sharing atomically migrates committed text, changes generation, and revokes the former room", { timeout: 10000 }, async (t) => {
  const s = await shared(t, "迁移基线");
  const sharedBase = await snapshot(s.alice, s.scope, s.pageId); const doc = fork(sharedBase);
  ok(await submit(s.bob, sharedBase, update(doc, () => field(doc, s.bodyKey).insert(0, "共同修改"))));
  const current = await snapshot(s.alice, s.scope, s.pageId);
  const root = ok(await s.alice.request(`/api/records/${s.scope}/pages`)).find((row: Json) => row.id === s.pageId).value;
  const blocks = ok(await s.alice.request(`/api/records/${s.scope}/blocks`)).filter((row: Json) => row.value.page === s.pageId);
  const { share_space_id: _space, ...privateRoot } = root;
  const feed = await s.f.feed(s.bob); feed.subscribe(s.scope, s.pageId);
  await feed.message((message) => message.type === "document"); const mark = feed.messages.length;
  const writes = [
    { scope: "personal", collection: "pages", id: s.pageId, action: "put", value: privateRoot },
    ...blocks.map((row: Json) => ({ scope: "personal", collection: "blocks", id: row.id, action: "put", value: row.value })),
    ...blocks.map((row: Json) => ({ scope: s.scope, collection: "blocks", id: row.id, action: "delete", base: row.value })),
    { scope: s.scope, collection: "pages", id: s.pageId, action: "delete", base: root },
  ];
  ok(await s.alice.request("/api/records/batch", { method: "POST", body: { requestId: randomUUID(), writes, textUpdates: [], expectedPages: [expected(current)] } }));
  const personal = await snapshot(s.alice, "personal", s.pageId);
  assert.equal(text(personal, s.bodyKey), "共同修改迁移基线"); assert.notEqual(personal.generation, current.generation);
  await feed.refused(mark);
  denied(await s.bob.request(`/api/collaboration/${s.scope}/${s.pageId}`));
  const staleReply = await submit(s.alice, current, update(doc, () => field(doc, s.bodyKey).insert(0, "旧空间")));
  assert.ok([403, 404, 409].includes(staleReply.status), `The old room cannot accept text after migration: ${JSON.stringify(staleReply)}`);
  await s.f.restart();
  const durable = await snapshot(s.alice, "personal", s.pageId);
  assert.equal(durable.generation, personal.generation); assert.equal(text(durable, s.bodyKey), "共同修改迁移基线");
  doc.destroy();
});

test("CRDT binary updates cannot add or delete fields or introduce structural and ACL maps", { timeout: 10000 }, async (t) => {
  const s = await shared(t);
  const base = await snapshot(s.alice, s.scope, s.pageId);
  const mutations: Array<(doc: Y.Doc) => void> = [
    (doc) => doc.getMap("fields").set("blocks/foreign/content", new Y.Text("伪造字段")),
    (doc) => { doc.getMap("fields").delete(s.bodyKey); },
    (doc) => doc.getMap("fields").set(s.bodyKey, "not-shared-text"),
    (doc) => doc.getMap("fields").set(s.bodyKey, new Y.Text("replacement-shared-type")),
    (doc) => doc.getMap("acl").set("share_space_id", "foreign-space"),
    (doc) => doc.getMap("blocks").set("forged-block", { parent_id: "foreign" }),
  ];
  for (const mutation of mutations) {
    const doc = fork(base); const bytes = update(doc, () => mutation(doc));
    const refused = await submit(s.alice, base, bytes);
    assert.ok([400, 403, 409, 422].includes(refused.status), `A raw update must only edit known rich-text fields: ${JSON.stringify(refused)}`);
    const unchanged = await snapshot(s.alice, s.scope, s.pageId);
    assert.equal(unchanged.generation, base.generation); assert.equal(unchanged.state, base.state);
    doc.destroy();
  }
});

test("one cross-page text transaction arrives in one atomic WebSocket commit envelope", { timeout: 10000 }, async (t) => {
  const s = await shared(t, "父页");
  const child = ok(await s.alice.request("/api/v1/pages", { method: "POST", token: s.token.token, body: { parentId: s.pageId, title: "子页", text: "子页正文" } }), 201);
  const rows = ok(await s.alice.request(`/api/records/${s.scope}/blocks`));
  const childRow = rows.find((row: Json) => row.value.page === child.id); assert.ok(childRow);
  const childKey = `blocks/${childRow.id}/content`;
  const parentBase = await snapshot(s.alice, s.scope, s.pageId); const childBase = await snapshot(s.alice, s.scope, child.id);
  const feed = await s.f.feed(s.bob);
  feed.subscribe(s.scope, s.pageId); await feed.message((message) => message.type === "document" && message.snapshot?.pageId === s.pageId);
  feed.subscribe(s.scope, child.id); await feed.message((message) => message.type === "document" && message.snapshot?.pageId === child.id);
  const mark = feed.messages.length;
  const parentDoc = fork(parentBase); const childDoc = fork(childBase);
  const parentUpdate = update(parentDoc, () => field(parentDoc, s.bodyKey).insert(0, "同步"));
  const childUpdate = update(childDoc, () => field(childDoc, childKey).insert(0, "同步"));
  ok(await s.alice.request("/api/records/batch", { method: "POST", body: { requestId: randomUUID(), writes: [], textUpdates: [
    { scope: s.scope, pageId: s.pageId, generation: parentBase.generation, update: parentUpdate },
    { scope: s.scope, pageId: child.id, generation: `${childBase.generation}:stale`, update: childUpdate },
  ] } }), 409);
  await feed.quiet(mark);
  assert.equal((await snapshot(s.alice, s.scope, s.pageId)).state, parentBase.state, "A later page's refused update must roll back earlier pages in the same batch");
  assert.equal((await snapshot(s.alice, s.scope, child.id)).state, childBase.state);
  ok(await s.alice.request("/api/records/batch", { method: "POST", body: { requestId: randomUUID(), writes: [], textUpdates: [
    { scope: s.scope, pageId: s.pageId, generation: parentBase.generation, update: parentUpdate },
    { scope: s.scope, pageId: child.id, generation: childBase.generation, update: childUpdate },
  ] } }));
  await feed.message((message) => message.type === "document" && message.snapshot?.pageId === child.id, mark);
  const envelopes = feed.messages.slice(mark).filter((message) => message.type === "commit");
  assert.equal(envelopes.length, 1, "One atomic HTTP batch must not expose partial per-page WebSocket commits");
  assert.equal(envelopes[0].documents.length, 2);
  const documents = new Map<string, Snapshot>(envelopes[0].documents.map((event: Json) => [event.snapshot.pageId, messageSnapshot(event)]));
  assert.equal(text(documents.get(s.pageId)!, s.bodyKey), "同步父页");
  assert.equal(text(documents.get(child.id)!, childKey), "同步子页正文");
  assert.equal(documents.get(s.pageId)!.revision, (await snapshot(s.alice, s.scope, s.pageId)).revision);
  assert.equal(documents.get(child.id)!.revision, (await snapshot(s.alice, s.scope, child.id)).revision);
  parentDoc.destroy(); childDoc.destroy();
});

test("Agent suggestions remain pending until a permitted user reviews and applies them", { timeout: 10000 }, async (t) => {
  const s = await shared(t, "审核基线");
  const base = await snapshot(s.alice, s.scope, s.pageId);
  const request = { requestId: randomUUID(), generation: base.generation, baseRevision: base.revision, mode: "suggest", operations: [{ type: "insert_text", blockId: s.block.value.id, index: "end", text: "已审核提案" }] };
  const proposal = ok(await s.alice.request(`/api/v1/pages/${s.pageId}/operations`, { method: "POST", token: s.token.token, body: request }), 201);
  assert.equal(typeof proposal.id, "string"); assert.equal(proposal.pageId, s.pageId);
  assert.equal(proposal.status, "pending"); assert.equal(proposal.baseRevision, base.revision); assert.equal(proposal.generation, base.generation);
  assert.deepEqual(proposal.operations, request.operations); assert.ok(proposal.author); assert.ok(proposal.createdAt);
  const replay = ok(await s.alice.request(`/api/v1/pages/${s.pageId}/operations`, { method: "POST", token: s.token.token, body: request }), 201);
  assert.equal(replay.id, proposal.id, "A repeated suggestion request cannot create another proposal");
  assert.equal(text(await snapshot(s.bob, s.scope, s.pageId), s.bodyKey), "审核基线");
  const agentList = ok(await s.alice.request(`/api/v1/pages/${s.pageId}/proposals`, { token: s.token.token }));
  const browserList = ok(await s.bob.request(`/api/proposals?scope=${encodeURIComponent(s.scope)}&pageId=${encodeURIComponent(s.pageId)}`));
  assert.equal(agentList.filter((item: Json) => item.id === proposal.id).length, 1);
  assert.equal(browserList.find((item: Json) => item.id === proposal.id)?.status, "pending");
  const applied = ok(await s.bob.request(`/api/proposals/${proposal.id}/apply`, { method: "POST", body: { baseRevision: base.revision } }));
  assert.equal(applied.id, s.pageId);
  assert.equal(text(await snapshot(s.alice, s.scope, s.pageId), s.bodyKey), "审核基线已审核提案");
  const repeated = await s.bob.request(`/api/proposals/${proposal.id}/apply`, { method: "POST", body: { baseRevision: base.revision } });
  assert.ok([200, 409].includes(repeated.status));
  assert.equal(text(await snapshot(s.alice, s.scope, s.pageId), s.bodyKey), "审核基线已审核提案");
});

test("a stale proposal cannot overwrite accepted text by supplying a newer review revision", { timeout: 10000 }, async (t) => {
  const s = await shared(t, "提案基线");
  const base = await snapshot(s.alice, s.scope, s.pageId);
  const proposal = ok(await s.alice.request(`/api/v1/pages/${s.pageId}/operations`, { method: "POST", token: s.token.token, body: { requestId: randomUUID(), generation: base.generation, baseRevision: base.revision, mode: "suggest", operations: [{ type: "delete_text", blockId: s.block.value.id, index: 0, length: 2 }] } }), 201);
  const peer = fork(base);
  ok(await submit(s.bob, base, update(peer, () => field(peer, s.bodyKey).insert(0, "已接受修改"))));
  const current = await snapshot(s.alice, s.scope, s.pageId);
  ok(await s.alice.request(`/api/proposals/${proposal.id}/apply`, { method: "POST", body: { baseRevision: current.revision } }), 409);
  const kept = await snapshot(s.bob, s.scope, s.pageId);
  assert.equal(kept.state, current.state); assert.equal(text(kept, s.bodyKey), "已接受修改提案基线");
  peer.destroy();
});

test("viewers cannot approve proposals and explicit rejection changes no document content", { timeout: 10000 }, async (t) => {
  const s = await shared(t, "拒绝基线");
  const base = await snapshot(s.alice, s.scope, s.pageId);
  const proposal = ok(await s.alice.request(`/api/v1/pages/${s.pageId}/operations`, { method: "POST", token: s.token.token, body: { requestId: randomUUID(), generation: base.generation, mode: "suggest", operations: [{ type: "insert_text", blockId: s.block.value.id, index: "start", text: "待审核" }] } }), 201);
  ok(await s.alice.request(`/api/spaces/${s.scope}/members/${s.bobUser.id}`, { method: "PATCH", body: { role: "viewer" } }));
  denied(await s.bob.request(`/api/proposals/${proposal.id}/apply`, { method: "POST", body: { baseRevision: base.revision } }));
  assert.equal(text(await snapshot(s.alice, s.scope, s.pageId), s.bodyKey), "拒绝基线");
  assert.equal(ok(await s.alice.request(`/api/proposals/${proposal.id}/reject`, { method: "POST", body: {} })).ok, true);
  const after = await snapshot(s.alice, s.scope, s.pageId);
  assert.equal(after.state, base.state); assert.equal(after.generation, base.generation); assert.equal(after.revision, base.revision);
  ok(await s.alice.request(`/api/proposals/${proposal.id}/apply`, { method: "POST", body: { baseRevision: base.revision } }), 409);
});
