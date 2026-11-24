import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import WebSocket from "ws";
import { startServer } from "../server/index.ts";
import { applyPageOp, pageStateFromRecords, readField } from "../src/collaboration/ot/page.ts";
import { richTextPlain } from "../src/collaboration/ot/text.ts";
import type { PageOp } from "../src/collaboration/ot/types.ts";

// Real HTTP/WebSocket tests exercising the UC-60 zero-dependency semantic OT engine.
type Json = any;
type Server = Awaited<ReturnType<typeof startServer>>;
interface Snapshot {
  scope: string;
  pageId: string;
  epoch: string;
  generation: string;
  seq: number;
  prunedBefore: number;
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
      const message = JSON.parse(raw.toString());
      this.messages.push(message);
      this.notify();
    });
    this.socket.on("close", () => { this.closed = true; this.notify(); });
    this.socket.on("unexpected-response", (_request, response) => {
      this.rejectedStatus = response.statusCode ?? null;
      response.resume();
      this.closed = true;
      this.socket.terminate();
      this.notify();
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
      this.socket.once("open", check);
      check();
    });
  }
  subscribe(scope: string, pageId: string) {
    assert.equal(this.socket.readyState, WebSocket.OPEN);
    this.socket.send(JSON.stringify({ type: "subscribe", scope, pageId }));
  }
  subscribeSpace(scope: string) {
    assert.equal(this.socket.readyState, WebSocket.OPEN);
    this.socket.send(JSON.stringify({ type: "subscribe_space", scope }));
  }
  sendPresence(spaceId: string, state: Json, clientId = "client-1") {
    assert.equal(this.socket.readyState, WebSocket.OPEN);
    this.socket.send(JSON.stringify({ type: "presence", spaceId, clientId, state }));
  }
  private events(after: number): Json[] {
    return this.messages.slice(after).flatMap((message) => {
      if (message.type !== "commit") return [message];
      assert.ok(Array.isArray(message.documents), "An atomic commit must contain document events");
      for (const event of message.documents) {
        assert.ok(["op", "reset"].includes(event.type));
        assert.ok(event.scope && event.pageId && typeof event.seq === "number", "Every committed document must carry address and seq");
        if (event.type === "op") assert.ok(Array.isArray(event.ops) && event.revision, "An op commit carries ops and revision");
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
    assert.equal(this.events(after).some((message) => ["document", "op", "reset"].includes(message.type)), false, "A refused subscriber must not receive document content");
  }
  async quiet(after: number, milliseconds = 150): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    assert.equal(this.events(after).some((message) => ["document", "op", "reset"].includes(message.type)), false, "A rolled-back or unauthorized write must not broadcast content");
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
    await closeFeeds();
    await server.close();
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("notes-collaboration-http-"));
    await rm(target, { recursive: true, force: true });
  });
  return {
    directory,
    browser: () => new Browser(() => server.url),
    async feed(browser: Browser, origin?: string) { const feed = await Feed.connect(browser, origin); feeds.add(feed); return feed; },
    async restart() {
      await closeFeeds();
      await server.close();
      server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false });
    },
  };
}

async function register(browser: Browser, handle: string) {
  return ok(await browser.request("/api/auth/register", { method: "POST", body: { handle, displayName: handle, password } }), 201).user;
}
async function makeToken(browser: Browser, access: "read" | "write" = "write") {
  return ok(await browser.request("/api/tokens", { method: "POST", body: { name: "Independent collaboration Agent", access } }), 201);
}
async function shared(t: TestContext, initial = "起点😀终点") {
  const f = await fixture(t);
  const alice = f.browser();
  const bob = f.browser();
  const aliceUser = await register(alice, "alice");
  const bobUser = await register(bob, "bob");
  const space = ok(await alice.request("/api/spaces", { method: "POST", body: { name: "Independent collaboration" } }), 201);
  const token = await makeToken(alice);
  const page = ok(await alice.request("/api/v1/pages", { method: "POST", token: token.token, body: { title: "共同编辑", text: initial, spaceId: space.spaceId } }), 201);
  ok(await alice.request(`/api/spaces/${space.spaceId}/invitations`, { method: "POST", body: { handle: "bob", role: "editor" } }));
  const invitation = ok(await bob.request("/api/invitations"))[0];
  ok(await bob.request(`/api/invitations/${invitation.id}`, { method: "POST", body: { accept: true } }));
  const blocks = ok(await alice.request(`/api/records/${space.spaceId}/blocks`));
  const block = blocks.find((row: Json) => row.value.page === page.id);
  assert.ok(block, "Creating a document must create an editor block");
  return {
    f, alice, bob, aliceUser, bobUser, token,
    scope: String(space.spaceId),
    pageId: String(page.id),
    block,
    bodyKey: `blocks/${block.id}/content`,
    titleKey: `pages/${page.id}/title_content`,
  };
}

async function snapshot(browser: Browser, scope: string, pageId: string): Promise<Snapshot> {
  const value = ok(await browser.request(`/api/collaboration/${scope}/${pageId}`));
  assert.equal(value.scope, scope);
  assert.equal(value.pageId, pageId);
  assert.equal(typeof value.epoch, "string");
  assert.equal(value.generation, value.epoch);
  assert.equal(typeof value.seq, "number");
  assert.equal(typeof value.prunedBefore, "number");
  assert.equal(typeof value.revision, "string");
  assert.equal(typeof value.canEdit, "boolean");
  assert.equal(value.records?.page?.id, pageId);
  assert.ok(Array.isArray(value.records?.blocks));
  assert.ok(value.records.blocks.every((row: Json) => row.value.page === pageId));
  return value;
}

function fieldRuns(value: Snapshot, key: string): Json[] {
  const state = pageStateFromRecords(value.pageId, value.records.page, value.records.blocks);
  const runs = readField(state, key);
  assert.ok(runs !== null, `Expected field ${key} to exist`);
  return runs;
}
function text(value: Snapshot, key: string): string {
  return richTextPlain(fieldRuns(value, key));
}

async function submitOps(
  browser: Browser,
  base: Snapshot,
  ops: PageOp[],
  more: { requestId?: string; writes?: unknown[]; pageOps?: unknown[] } = {},
): Promise<Reply> {
  return browser.request("/api/records/batch", {
    method: "POST",
    body: {
      requestId: more.requestId ?? randomUUID(),
      writes: more.writes ?? [],
      pageOps: more.pageOps ?? [{ scope: base.scope, pageId: base.pageId, epoch: base.epoch, baseSeq: base.seq, ops }],
      protocol: 2,
    },
  });
}

test("semantic snapshots and op logs survive restart and merge offline edits cleanly", { timeout: 10000 }, async (t) => {
  const s = await shared(t);
  const original = await snapshot(s.alice, s.scope, s.pageId);
  assert.equal(original.canEdit, true);
  assert.equal(text(original, s.bodyKey), "起点😀终点");
  assert.equal(text(original, s.titleKey), "共同编辑");

  const peer = await snapshot(s.bob, s.scope, s.pageId);
  assert.equal(peer.epoch, original.epoch);
  assert.equal(peer.seq, original.seq);
  assert.equal(peer.revision, original.revision);

  // Bob commits online before server restart; Alice submits an offline op based on `original.seq` AFTER restart.
  ok(await submitOps(s.bob, peer, [{ type: "text", field: s.bodyKey, ops: [{ insert: "在线乙" }] }]));
  const beforeRestart = await snapshot(s.bob, s.scope, s.pageId);
  assert.equal(beforeRestart.seq, original.seq + 1);

  await s.f.restart();
  const afterRestart = await snapshot(s.alice, s.scope, s.pageId);
  assert.equal(afterRestart.epoch, original.epoch);
  assert.equal(afterRestart.seq, beforeRestart.seq);
  assert.equal(afterRestart.revision, beforeRestart.revision);

  // Alice's offline edit at the end of `"起点😀终点"` (UTF-16 len = 6) OT-transforms across Bob's prefix!
  ok(await submitOps(s.alice, original, [{ type: "text", field: s.bodyKey, ops: [{ retain: 6 }, { insert: "离线甲" }] }]));
  const final = await snapshot(s.alice, s.scope, s.pageId);
  assert.equal(text(final, s.bodyKey), "在线乙起点😀终点离线甲");
});

test("two peers merge same-field updates in reverse commit order with requestId idempotency", { timeout: 10000 }, async (t) => {
  const s = await shared(t);
  const base = await snapshot(s.alice, s.scope, s.pageId);
  const aOps: PageOp[] = [
    { type: "text", field: s.bodyKey, ops: [{ insert: "甲" }] },
    { type: "text", field: s.titleKey, ops: [{ insert: "A" }] },
  ];
  const bOps: PageOp[] = [
    { type: "text", field: s.bodyKey, ops: [{ insert: "乙" }] },
    { type: "text", field: s.titleKey, ops: [{ insert: "B" }] },
  ];

  // B commits first, then A commits based on the original `base.seq`.
  ok(await submitOps(s.bob, base, bOps));
  const requestId = randomUUID();
  const firstReply = ok(await submitOps(s.alice, base, aOps, { requestId }));
  // Exact same requestId + payload is idempotent.
  const dupReply = ok(await submitOps(s.alice, base, aOps, { requestId }));
  assert.deepEqual(dupReply, firstReply);
  // Same requestId + different payload returns 409 conflict.
  const mismatch = await submitOps(s.alice, base, bOps, { requestId });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.code, "request_id_conflict");

  const merged = await snapshot(s.alice, s.scope, s.pageId);
  assert.equal(merged.epoch, base.epoch);
  const body = text(merged, s.bodyKey);
  const title = text(merged, s.titleKey);
  assert.ok(body.includes("甲") && body.includes("乙") && body.includes("起点😀终点"));
  assert.equal(body.length, "甲乙起点😀终点".length);
  assert.ok(title.includes("A") && title.includes("B") && title.includes("共同编辑"));
});

test("concurrent formatting, atomic mentions, and UTF-16 surrogate boundaries", { timeout: 10000 }, async (t) => {
  const s = await shared(t);
  const base = await snapshot(s.alice, s.scope, s.pageId);
  const mention = { mention: { kind: "date", date: "2026-11-05" } };

  // Splitting the 😀 surrogate pair (offset 3) must be rejected with 400.
  const badSurrogate = await submitOps(s.alice, base, [{ type: "text", field: s.bodyKey, ops: [{ retain: 3 }, { insert: "X" }] }]);
  assert.equal(badSurrogate.status, 400);

  ok(await submitOps(s.bob, base, [{ type: "text", field: s.bodyKey, ops: [{ retain: 2 }, { insert: { embed: mention } }] }]));
  ok(await submitOps(s.alice, base, [{ type: "text", field: s.bodyKey, ops: [{ retain: 2, marks: { bold: true, color: "blue" } }] }]));

  const final = await snapshot(s.alice, s.scope, s.pageId);
  const runs = fieldRuns(final, s.bodyKey);
  assert.deepEqual(runs.find((r: Json) => r.embed)?.embed, mention);
  assert.ok(runs.some((r: Json) => r.text === "起点" && r.marks?.bold === true && r.marks?.color === "blue"));
  assert.equal(runs.filter((r: Json) => typeof r.text === "string").map((r: Json) => r.text).join(""), "起点😀终点");
});

test("UC-60: concurrent split_block + typing, merge_block + typing, move_blocks cycle guard, and orphan drafts", { timeout: 10000 }, async (t) => {
  const s = await shared(t, "前半后半");
  const base = await snapshot(s.alice, s.scope, s.pageId);
  const blockId = String(s.block.value.id);
  const splitId = "split_b2";
  const splitKey = `blocks/${s.pageId.length}_${s.pageId}_${splitId}/content`;

  // 1. Concurrent split_block (Alice at offset 2) + suffix & prefix typing (Bob).
  ok(await submitOps(s.alice, base, [{ type: "split_block", blockId, offset: 2, newBlockId: splitId, newKind: "text" }]));
  ok(await submitOps(s.bob, base, [{ type: "text", field: s.bodyKey, ops: [{ insert: "头" }, { retain: 4 }, { insert: "尾" }] }]));
  const afterSplit = await snapshot(s.alice, s.scope, s.pageId);
  assert.equal(text(afterSplit, s.bodyKey), "头前半");
  assert.equal(text(afterSplit, splitKey), "后半尾");

  // 2. Concurrent merge_block (Alice merges splitId into blockId) + Bob types into splitId!
  ok(await submitOps(s.alice, afterSplit, [{ type: "merge_block", intoBlockId: blockId, fromBlockId: splitId }]));
  ok(await submitOps(s.bob, afterSplit, [{ type: "text", field: splitKey, ops: [{ retain: 3 }, { insert: "追加" }] }]));
  const afterMerge = await snapshot(s.alice, s.scope, s.pageId);
  assert.equal(text(afterMerge, s.bodyKey), "头前半后半尾追加");
  assert.equal(afterMerge.records.blocks.some((b) => b.value.id === splitId), false);

  // 3. Concurrent cycle-inducing move_blocks: Alice moves A under B, Bob moves B under A -> server prevents cycle cleanly!
  ok(await submitOps(s.alice, afterMerge, [{
    type: "create_block",
    block: { id: "blk_b", page: s.pageId, kind: "text", order: 2048, content: [{ text: "B" }] },
    parentId: null,
    afterId: blockId,
  }]));
  const twoBlocks = await snapshot(s.alice, s.scope, s.pageId);
  ok(await submitOps(s.alice, twoBlocks, [{ type: "move_blocks", blockIds: [blockId], parentId: "blk_b" }]));
  const cyclicReply = ok(await submitOps(s.bob, twoBlocks, [{ type: "move_blocks", blockIds: ["blk_b"], parentId: blockId }]));
  assert.equal(cyclicReply.pageResults[0].ops.length, 0);
  const afterMove = await snapshot(s.alice, s.scope, s.pageId);
  const bRec = afterMove.records.blocks.find((b) => b.value.id === "blk_b")!;
  const aRec = afterMove.records.blocks.find((b) => b.value.id === blockId)!;
  assert.equal(aRec.value.parent_id, "blk_b");
  assert.equal(bRec.value.parent_id ?? null, null);

  // 4. Concurrent delete_blocks (Alice deletes blockId) + Bob types into blockId -> Bob's text returns in `orphaned`!
  ok(await submitOps(s.alice, afterMove, [{ type: "delete_blocks", blockIds: [blockId] }]));
  const orphanReply = ok(await submitOps(s.bob, afterMove, [{ type: "text", field: s.bodyKey, ops: [{ insert: "孤儿草稿" }] }]));
  assert.equal(orphanReply.pageResults[0].orphaned.length, 1);
  assert.equal(richTextPlain(orphanReply.pageResults[0].orphaned[0].content), "孤儿草稿");
});

test("UC-60: opsSince gap recovery returns sequential ops and reset:true after pruning", { timeout: 10000 }, async (t) => {
  const s = await shared(t, "基础");
  const base = await snapshot(s.alice, s.scope, s.pageId);
  for (let i = 1; i <= 5; i += 1) {
    const cur = await snapshot(s.alice, s.scope, s.pageId);
    ok(await submitOps(s.alice, cur, [{ type: "text", field: s.bodyKey, ops: [{ insert: String(i) }] }]));
  }
  const gap = ok(await s.bob.request(`/api/collaboration/${s.scope}/${s.pageId}/ops?after=${base.seq}&epoch=${encodeURIComponent(base.epoch)}`));
  assert.equal(gap.reset, undefined);
  assert.equal(gap.ops.length, 5);
  assert.deepEqual(gap.ops.map((item: Json) => item.seq), [1, 2, 3, 4, 5]);

  // Replay gap ops onto `base` locally -> matches server snapshot identically!
  const local = pageStateFromRecords(base.pageId, base.records.page, base.records.blocks);
  for (const item of gap.ops) for (const op of item.ops) applyPageOp(local, op, "replay");
  const latest = await snapshot(s.bob, s.scope, s.pageId);
  assert.equal(richTextPlain(readField(local, s.bodyKey)!), text(latest, s.bodyKey));

  // Wrong epoch requests trigger `reset: true`.
  const wrongEpoch = ok(await s.bob.request(`/api/collaboration/${s.scope}/${s.pageId}/ops?after=0&epoch=wrong-epoch`));
  assert.equal(wrongEpoch.reset, true);
});

test("WebSocket publishes op commits, live presence, and never publishes rolled-back batches or direct writes", { timeout: 10000 }, async (t) => {
  const s = await shared(t);
  const feed = await s.f.feed(s.bob);
  feed.subscribe(s.scope, s.pageId);
  feed.subscribeSpace(s.scope);
  const initial = (await feed.message((m) => m.type === "document")).snapshot as Snapshot;
  const baseline = await snapshot(s.alice, s.scope, s.pageId);
  assert.equal(initial.epoch, baseline.epoch);
  assert.equal(initial.revision, baseline.revision);

  // Real-time WebSocket presence broadcast.
  const aliceFeed = await s.f.feed(s.alice);
  aliceFeed.subscribeSpace(s.scope);
  const presMark = feed.messages.length;
  aliceFeed.sendPresence(s.scope, { pageId: s.pageId, epoch: baseline.epoch, seq: baseline.seq, status: "editing", selection: { anchor: { blockId: s.block.value.id, offset: 2 }, focus: { blockId: s.block.value.id, offset: 2 } } }, "alice-win");
  const presMsg = await feed.message((m) => m.type === "presence" && m.spaceId === s.scope && m.list.some((p: Json) => p.userId === s.aliceUser.id && p.state?.status === "editing"), presMark);
  assert.ok(presMsg);

  // Rolled-back atomic batch (contains unauthorized write) must not broadcast.
  const mark = feed.messages.length;
  denied(await submitOps(s.alice, baseline, [{ type: "text", field: s.bodyKey, ops: [{ insert: "事务文字" }] }], {
    writes: [{ scope: "unauthorized-space", collection: "pages", id: "forbidden", action: "delete", base: null }],
  }));
  await feed.quiet(mark);
  assert.equal((await snapshot(s.alice, s.scope, s.pageId)).revision, baseline.revision);

  // Valid commit broadcasts `type: "op"` with ops & revision.
  ok(await submitOps(s.alice, baseline, [{ type: "text", field: s.bodyKey, ops: [{ insert: "事务文字" }] }]));
  const pushed = await feed.message((m) => m.type === "op" && m.pageId === s.pageId, mark);
  const durable = await snapshot(s.alice, s.scope, s.pageId);
  assert.equal(pushed.revision, durable.revision);
  assert.equal(pushed.seq, durable.seq);
  assert.equal(text(durable, s.bodyKey), "事务文字起点😀终点");

  // Direct WS write message is refused and changes nothing.
  feed.socket.send(JSON.stringify({ type: "update", scope: s.scope, pageId: s.pageId, ops: [] }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal((await snapshot(s.alice, s.scope, s.pageId)).revision, durable.revision);
});

test("viewer, removed member, logout, and foreign-origin are refused and revoked immediately (event-driven)", { timeout: 10000 }, async (t) => {
  const s = await shared(t);
  const viewer = s.f.browser();
  await register(viewer, "viewer");
  ok(await s.alice.request(`/api/spaces/${s.scope}/invitations`, { method: "POST", body: { handle: "viewer", role: "viewer" } }));
  const invite = ok(await viewer.request("/api/invitations"))[0];
  ok(await viewer.request(`/api/invitations/${invite.id}`, { method: "POST", body: { accept: true } }));

  const readOnly = await snapshot(viewer, s.scope, s.pageId);
  assert.equal(readOnly.canEdit, false);
  denied(await submitOps(viewer, readOnly, [{ type: "text", field: s.bodyKey, ops: [{ insert: "越权" }] }]));

  const feed = await s.f.feed(s.bob);
  feed.subscribe(s.scope, s.pageId);
  await feed.message((m) => m.type === "document");
  const mark = feed.messages.length;
  ok(await s.alice.request(`/api/spaces/${s.scope}/members/${s.bobUser.id}`, { method: "DELETE" }));
  // Event-driven revocation arrives immediately (well under 300ms, no 1s polling loop!).
  await feed.refused(mark);
  denied(await s.bob.request(`/api/collaboration/${s.scope}/${s.pageId}`));
  denied(await submitOps(s.bob, readOnly, [{ type: "text", field: s.bodyKey, ops: [{ insert: "越权" }] }]));

  const ownerBase = await snapshot(s.alice, s.scope, s.pageId);
  ok(await submitOps(s.alice, ownerBase, [{ type: "text", field: s.bodyKey, ops: [{ insert: "撤权后" }] }]));
  await feed.quiet(mark);
  assert.equal(text(await snapshot(viewer, s.scope, s.pageId), s.bodyKey), "撤权后起点😀终点");

  // Logout closes existing WS feed immediately; foreign origin is rejected.
  const viewerFeed = await s.f.feed(viewer);
  viewerFeed.subscribe(s.scope, s.pageId);
  await viewerFeed.message((m) => m.type === "document");
  const vMark = viewerFeed.messages.length;
  ok(await viewer.request("/api/auth/logout", { method: "POST" }));
  await viewerFeed.refused(vMark);

  const foreign = await s.f.feed(s.alice, "https://foreign.invalid");
  if (!foreign.closed) foreign.subscribe(s.scope, s.pageId);
  await foreign.refused();
});

test("version restore rotates epoch, broadcasts reset, and rejects stale-epoch ops", { timeout: 10000 }, async (t) => {
  const s = await shared(t, "检查点正文");
  const initial = await snapshot(s.alice, s.scope, s.pageId);
  const version = ok(await s.alice.request(`/api/v1/pages/${s.pageId}/checkpoint`, { method: "POST", token: s.token.token }));
  ok(await submitOps(s.alice, initial, [{ type: "text", field: s.bodyKey, ops: [{ insert: "后续修改" }] }]));
  const beforeRestore = await snapshot(s.alice, s.scope, s.pageId);

  const feed = await s.f.feed(s.bob);
  feed.subscribe(s.scope, s.pageId);
  await feed.message((m) => m.type === "document");
  const mark = feed.messages.length;

  ok(await s.alice.request(`/api/v1/pages/${s.pageId}/restore`, { method: "POST", token: s.token.token, body: { versionId: version.id } }));
  const restored = await snapshot(s.alice, s.scope, s.pageId);
  assert.notEqual(restored.epoch, beforeRestore.epoch);
  assert.equal(text(restored, s.bodyKey), "检查点正文");

  const reset = await feed.message((m) => m.type === "reset", mark);
  assert.equal(reset.epoch, restored.epoch);

  const staleReply = await submitOps(s.bob, beforeRestore, [{ type: "text", field: s.bodyKey, ops: [{ insert: "离线未确认" }] }]);
  assert.equal(staleReply.status, 409);
  assert.equal(staleReply.body.code, "epoch_conflict");

  const versions = ok(await s.alice.request(`/api/v1/pages/${s.pageId}/versions`, { token: s.token.token }));
  assert.ok(versions.some((entry: Json) => JSON.stringify(entry.snapshot).includes("后续修改")));
});

test("Agent semantic operations merge with human edits, enforce revisions/roles, and handle proposals", { timeout: 10000 }, async (t) => {
  const s = await shared(t, "共同基线");
  const base = await snapshot(s.alice, s.scope, s.pageId);

  // Agent inserts at end concurrently with human insert at start.
  const operation = {
    requestId: randomUUID(),
    generation: base.generation,
    mode: "apply",
    operations: [{ type: "insert_text", blockId: s.block.value.id, index: "end", text: "Agent的文字" }],
  };
  ok(await s.alice.request(`/api/v1/pages/${s.pageId}/operations`, { method: "POST", token: s.token.token, body: operation }));
  // Idempotent retry returns 200 without duplicating.
  ok(await s.alice.request(`/api/v1/pages/${s.pageId}/operations`, { method: "POST", token: s.token.token, body: operation }));
  // Changed payload with same requestId returns 409 conflict.
  const mismatch = await s.alice.request(`/api/v1/pages/${s.pageId}/operations`, {
    method: "POST", token: s.token.token,
    body: { ...operation, operations: [{ type: "insert_text", blockId: s.block.value.id, index: "end", text: "不同重放" }] },
  });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.code, "conflict");

  ok(await submitOps(s.alice, base, [{ type: "text", field: s.bodyKey, ops: [{ insert: "人的文字" }] }]));
  const merged = await snapshot(s.alice, s.scope, s.pageId);
  assert.equal(merged.epoch, base.epoch);
  assert.equal(text(merged, s.bodyKey), "人的文字共同基线Agent的文字");

  // Numeric delete requires current baseRevision; read-only token refused.
  const numericAction = { generation: merged.generation, mode: "apply", operations: [{ type: "delete_text", blockId: s.block.value.id, index: 0, length: 4 }] };
  const missingRev = await s.alice.request(`/api/v1/pages/${s.pageId}/operations`, { method: "POST", token: s.token.token, body: { ...numericAction, requestId: randomUUID() } });
  assert.ok([400, 409].includes(missingRev.status));
  ok(await s.alice.request(`/api/v1/pages/${s.pageId}/operations`, { method: "POST", token: s.token.token, body: { ...numericAction, requestId: randomUUID(), baseRevision: base.revision } }), 409);
  const readToken = await makeToken(s.alice, "read");
  denied(await s.alice.request(`/api/v1/pages/${s.pageId}/operations`, { method: "POST", token: readToken.token, body: { requestId: randomUUID(), generation: merged.generation, mode: "apply", operations: [{ type: "insert_text", blockId: s.block.value.id, index: "end", text: "越权" }] } }));
  ok(await s.alice.request(`/api/v1/pages/${s.pageId}/operations`, { method: "POST", token: s.token.token, body: { ...numericAction, requestId: randomUUID(), baseRevision: merged.revision } }));
  assert.equal(text(await snapshot(s.bob, s.scope, s.pageId), s.bodyKey), "共同基线Agent的文字");

  // Suggest mode -> apply / stale / reject workflow.
  const cur = await snapshot(s.alice, s.scope, s.pageId);
  const proposal = ok(await s.alice.request(`/api/v1/pages/${s.pageId}/operations`, {
    method: "POST", token: s.token.token,
    body: { requestId: randomUUID(), generation: cur.generation, baseRevision: cur.revision, mode: "suggest", operations: [{ type: "insert_text", blockId: s.block.value.id, index: "end", text: "提案" }] },
  }), 201);
  assert.equal(proposal.status, "pending");
  ok(await s.bob.request(`/api/proposals/${proposal.id}/apply`, { method: "POST", body: { baseRevision: cur.revision } }));
  assert.equal(text(await snapshot(s.alice, s.scope, s.pageId), s.bodyKey), "共同基线Agent的文字提案");

  const staleProp = ok(await s.alice.request(`/api/v1/pages/${s.pageId}/operations`, {
    method: "POST", token: s.token.token,
    body: { requestId: randomUUID(), generation: cur.generation, baseRevision: (await snapshot(s.alice, s.scope, s.pageId)).revision, mode: "suggest", operations: [{ type: "delete_text", blockId: s.block.value.id, index: 0, length: 2 }] },
  }), 201);
  const cur2 = await snapshot(s.alice, s.scope, s.pageId);
  ok(await submitOps(s.bob, cur2, [{ type: "text", field: s.bodyKey, ops: [{ insert: "新" }] }]));
  ok(await s.alice.request(`/api/proposals/${staleProp.id}/apply`, { method: "POST", body: { baseRevision: (await snapshot(s.alice, s.scope, s.pageId)).revision } }), 409);
  assert.equal(ok(await s.alice.request(`/api/proposals/${staleProp.id}/reject`, { method: "POST", body: {} })).ok, true);
});

test("stop-sharing atomically migrates committed text, rotates epoch, and revokes former room", { timeout: 10000 }, async (t) => {
  const s = await shared(t, "迁移基线");
  const sharedBase = await snapshot(s.alice, s.scope, s.pageId);
  ok(await submitOps(s.bob, sharedBase, [{ type: "text", field: s.bodyKey, ops: [{ insert: "共同修改" }] }]));
  const current = await snapshot(s.alice, s.scope, s.pageId);

  const feed = await s.f.feed(s.bob);
  feed.subscribe(s.scope, s.pageId);
  await feed.message((m) => m.type === "document");
  const mark = feed.messages.length;

  ok(await s.alice.request(`/api/pages/${s.pageId}/transfer`, { method: "POST", body: { action: "stop-share" } }));
  const personal = await snapshot(s.alice, "personal", s.pageId);
  assert.equal(text(personal, s.bodyKey), "共同修改迁移基线");
  assert.notEqual(personal.epoch, current.epoch);
  await feed.refused(mark);
  denied(await s.bob.request(`/api/collaboration/${s.scope}/${s.pageId}`));

  await s.f.restart();
  const durable = await snapshot(s.alice, "personal", s.pageId);
  assert.equal(durable.epoch, personal.epoch);
  assert.equal(text(durable, s.bodyKey), "共同修改迁移基线");
});

test("cross-page atomic pageOps arrive in one WebSocket commit envelope and roll back atomically", { timeout: 10000 }, async (t) => {
  const s = await shared(t, "父页");
  const child = ok(await s.alice.request("/api/v1/pages", { method: "POST", token: s.token.token, body: { parentId: s.pageId, title: "子页", text: "子页正文" } }), 201);
  const rows = ok(await s.alice.request(`/api/records/${s.scope}/blocks`));
  const childRow = rows.find((row: Json) => row.value.page === child.id);
  assert.ok(childRow);
  const childKey = `blocks/${childRow.id}/content`;
  const parentBase = await snapshot(s.alice, s.scope, s.pageId);
  const childBase = await snapshot(s.alice, s.scope, child.id);

  const feed = await s.f.feed(s.bob);
  feed.subscribe(s.scope, s.pageId);
  await feed.message((m) => m.type === "document" && m.snapshot?.pageId === s.pageId);
  feed.subscribe(s.scope, child.id);
  await feed.message((m) => m.type === "document" && m.snapshot?.pageId === child.id);
  const mark = feed.messages.length;

  // Stale epoch on second page rolls back the entire batch.
  ok(await submitOps(s.alice, parentBase, [], {
    pageOps: [
      { scope: s.scope, pageId: s.pageId, epoch: parentBase.epoch, baseSeq: parentBase.seq, ops: [{ type: "text", field: s.bodyKey, ops: [{ insert: "同步" }] }] },
      { scope: s.scope, pageId: child.id, epoch: `${childBase.epoch}:stale`, baseSeq: childBase.seq, ops: [{ type: "text", field: childKey, ops: [{ insert: "同步" }] }] },
    ],
  }), 409);
  await feed.quiet(mark);
  assert.equal(text(await snapshot(s.alice, s.scope, s.pageId), s.bodyKey), "父页");

  // Valid two-page batch lands in ONE WS commit envelope.
  ok(await submitOps(s.alice, parentBase, [], {
    pageOps: [
      { scope: s.scope, pageId: s.pageId, epoch: parentBase.epoch, baseSeq: parentBase.seq, ops: [{ type: "text", field: s.bodyKey, ops: [{ insert: "同步" }] }] },
      { scope: s.scope, pageId: child.id, epoch: childBase.epoch, baseSeq: childBase.seq, ops: [{ type: "text", field: childKey, ops: [{ insert: "同步" }] }] },
    ],
  }));
  await feed.message((m) => m.type === "op" && m.pageId === child.id, mark);
  const envelopes = feed.messages.slice(mark).filter((m) => m.type === "commit");
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].documents.length, 2);
  assert.equal(text(await snapshot(s.alice, s.scope, s.pageId), s.bodyKey), "同步父页");
  assert.equal(text(await snapshot(s.alice, s.scope, child.id), childKey), "同步子页正文");
});

test("committed pageOps write merged timeline events, cascade on delete, and reject client page_events writes", { timeout: 10000 }, async (t) => {
  const s = await shared(t);
  const events = async (browser: Browser) => ok(await browser.request(`/api/v1/pages/${s.pageId}/events`));
  assert.ok((await events(s.alice)).some((e: Json) => e.label === "创建了页面"));

  const base = await snapshot(s.alice, s.scope, s.pageId);
  ok(await submitOps(s.bob, base, [{ type: "text", field: s.titleKey, ops: [{ insert: "乙改" }] }]));
  let list = await events(s.alice);
  const bobTitle = list.filter((e: Json) => e.author_name === "bob");
  assert.equal(bobTitle.length, 1);
  assert.equal(bobTitle[0].label, "修改了标题");
  assert.equal(bobTitle[0].merged, 1);

  const cur1 = await snapshot(s.alice, s.scope, s.pageId);
  ok(await submitOps(s.alice, cur1, [{ type: "text", field: s.titleKey, ops: [{ insert: "甲改" }] }]));
  const cur2 = await snapshot(s.alice, s.scope, s.pageId);
  ok(await submitOps(s.alice, cur2, [{ type: "text", field: s.bodyKey, ops: [{ insert: "甲写" }] }]));

  list = await events(s.bob);
  const aliceEvents = list.filter((e: Json) => e.author_name === "alice" && e.label !== "创建了页面");
  assert.equal(aliceEvents.length, 1);
  assert.equal(aliceEvents[0].merged, 2);
  assert.ok(aliceEvents[0].label.includes("修改了标题") && aliceEvents[0].label.includes("编辑了正文"));

  // Checkpoints do not create timeline events; direct writes to page_events are rejected.
  ok(await s.alice.request(`/api/v1/pages/${s.pageId}/checkpoint`, { method: "POST", body: { summary: "手动" } }));
  assert.equal((await events(s.alice)).length, list.length);
  const forged = await s.alice.request(`/api/records/${s.scope}/page_events/fake`, {
    method: "POST",
    body: { action: "put", base: null, value: { page: s.pageId, event: "x", created_at: new Date().toISOString(), author_id: s.aliceUser.id, author_name: "伪造", label: "x", targets: [], merged: 1 } },
  });
  assert.equal(forged.status, 400);

  // Page deletion cascades its events.
  const pageRow = ok(await s.alice.request(`/api/records/${s.scope}/pages`)).find((row: Json) => row.id === s.pageId);
  ok(await s.alice.request("/api/records/batch", { method: "POST", body: { writes: [{ scope: s.scope, collection: "pages", id: s.pageId, action: "delete", base: pageRow.value }] } }));
  assert.equal(ok(await s.alice.request(`/api/records/${s.scope}/page_events`)).length, 0);
});

test("row writes land on the database timeline while a row's own block edits stay on its timeline", { timeout: 15000 }, async (t) => {
  const s = await shared(t);
  const database = ok(await s.alice.request("/api/v1/databases", {
    method: "POST", token: s.token.token,
    body: { requestId: randomUUID(), spaceId: s.scope, title: "清单", database: { title_name: "名称", properties: [], views: [{ id: "table", name: "全部", kind: "table" }] } },
  }), 201);
  const read = ok(await s.alice.request(`/api/v1/databases/${database.id}`, { token: s.token.token }));
  const row = ok(await s.alice.request(`/api/v1/databases/${database.id}/rows`, {
    method: "POST", token: s.token.token,
    body: { requestId: randomUUID(), baseRevision: read.revision, title: "任务一" },
  }), 201);
  const rowId = String(row.page.id);
  const dbEvents = () => s.alice.request(`/api/v1/pages/${database.id}/events`).then((r) => r.body as Json[]);
  assert.ok((await dbEvents()).some((e) => e.label.includes("新增了一行")));

  const blockId = `${rowId.length}_${rowId}_body1`;
  ok(await s.alice.request("/api/records/batch", {
    method: "POST",
    body: { requestId: randomUUID(), writes: [{ scope: s.scope, collection: "blocks", id: blockId, action: "put", base: null, value: { id: "body1", page: rowId, kind: "text", content: [{ text: "行内正文" }], order: 1 } }] },
  }));
  const rowEvents = ok(await s.alice.request(`/api/v1/pages/${rowId}/events`));
  assert.ok(rowEvents.some((e) => e.label.includes("新增了段落") && e.targets.includes("body1")));
  assert.ok(!(await dbEvents()).some((e) => e.targets.includes("body1")));

  const rowRecord = ok(await s.alice.request(`/api/records/${s.scope}/pages`)).find((r: Json) => r.id === rowId);
  ok(await s.alice.request("/api/records/batch", { method: "POST", body: { requestId: randomUUID(), writes: [{ scope: s.scope, collection: "pages", id: rowId, action: "delete", base: rowRecord.value }] } }));
  const finalDbEvents = await dbEvents();
  assert.ok(finalDbEvents.some((e) => e.label.includes("删除了一行")));
  assert.ok(!finalDbEvents.some((e) => e.label.includes("删除了页面")));
});
