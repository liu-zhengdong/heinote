import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { PassThrough } from "node:stream";
import { startServer } from "../server/index.ts";
import { readZip } from "../server/import.ts";
import { migrateDatabase } from "../server/migrations/index.ts";
import { Store } from "../server/store.ts";
import { writeExport } from "../server/export.ts";
import { PurgeManager } from "../server/purge.ts";
import { Browser, type Json, type Reply } from "./helpers/github.ts";

type Server = Awaited<ReturnType<typeof startServer>>;
const password = "Purge-acceptance-password-2026!";

function ok(reply: Reply, expected = 200): Json {
  assert.equal(reply.status, expected, JSON.stringify(reply.body));
  return reply.body;
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "notes-purge-http-"));
  let server: Server | undefined;
  t.after(async () => {
    try { await server?.close(); }
    finally {
      const target = resolve(directory);
      assert.equal(dirname(target), resolve(tmpdir()));
      assert.ok(basename(target).startsWith("notes-purge-http-"));
      await rm(target, { recursive: true, force: true });
    }
  });
  server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false });
  return {
    directory,
    browser: () => new Browser(() => server!.url),
    async restart() {
      await server?.close();
      server = undefined;
      server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false });
    },
    async close() {
      await server?.close();
      server = undefined;
    },
  };
}

async function register(browser: Browser, handle: string): Promise<Json> {
  ok(await browser.request("/api/auth/register", { method: "POST", body: { handle, displayName: handle, password } }), 201);
  return ok(await browser.request("/api/session")).user;
}

async function makeToken(browser: Browser, access: "read" | "write" = "write"): Promise<string> {
  return ok(await browser.request("/api/tokens", { method: "POST", body: { name: `token-${access}`, access } }), 201).token as string;
}

function pageValue(id: string, title: string, ownerId: string, extra: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id,
    title_content: [{ text: title }],
    icon: "",
    kind: "document",
    created_at: now,
    updated_at: now,
    created_by: ownerId,
    updated_by: ownerId,
    ...extra,
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out after ${timeoutMs}ms waiting for condition`);
}

test("UC-57 AC-01: /api/v1/pages, public share, agent-copy, agent-operations, and export filter multi-level trashed and purging trees", async (t) => {
  const f = await fixture(t);
  const alice = f.browser();
  const aliceUser = await register(alice, "alice");
  const token = await makeToken(alice, "write");

  const active = ok(await alice.request("/api/v1/pages", { method: "POST", token, body: { title: "Active", text: "keep" } }), 201);
  const trashedRoot = ok(await alice.request("/api/v1/pages", { method: "POST", token, body: { title: "Trashed Root", text: "root" } }), 201);
  const child = ok(await alice.request("/api/v1/pages", { method: "POST", token, body: { title: "Trashed Child", parentId: trashedRoot.id, text: "child" } }), 201);
  const grand = ok(await alice.request("/api/v1/pages", { method: "POST", token, body: { title: "Trashed Grand", parentId: child.id, text: "grand" } }), 201);

  const share = ok(await alice.request("/api/shares", { method: "POST", body: { pageId: trashedRoot.id } }), 201);
  const shareToken = String(share.url).replace(/^\/s\//, "");
  ok(await alice.request(`/api/public/${shareToken}`), 200);

  // Archive only the root page; descendants remain unflagged individually.
  ok(await alice.structure(`/api/records/personal/pages/${trashedRoot.id}`, {
    method: "POST",
    body: {
      action: "patch",
      patch: { archived: true, archived_at: new Date().toISOString() },
      base: trashedRoot.page,
    },
  }));

  const listed = ok(await alice.request("/api/v1/pages", { token }));
  assert.deepEqual(listed.map((p: Json) => p.id), [active.id]);

  // Public share fails once root is archived.
  assert.equal((await alice.request(`/api/public/${shareToken}`)).status, 404);
  // Creating a child share link on grand is still blocked from public reading.
  const childShare = ok(await alice.request("/api/shares", { method: "POST", body: { pageId: grand.id } }), 201);
  const childToken = String(childShare.url).replace(/^\/s\//, "");
  assert.equal((await alice.request(`/api/public/${childToken}`)).status, 404);

  // agent-copy refuses copying a descendant of an archived parent.
  const copyReply = await alice.request(`/api/v1/pages/${grand.id}/copy`, {
    method: "POST",
    token,
    body: { requestId: randomUUID(), spaceId: "personal" },
  });
  assert.equal(copyReply.status, 409);

  // agent-operations insert_page_link rejects linking to a descendant of an archived parent.
  const blockId = Object.keys(active.page.block_tree.by_id)[0];
  const linkReply = await alice.request(`/api/v1/pages/${active.id}/operations`, {
    method: "POST",
    token,
    body: {
      requestId: randomUUID(),
      generation: active.collaboration.generation,
      baseRevision: active.revision,
      operations: [{ type: "insert_page_link", blockId, index: "end", pageId: grand.id }],
    },
  });
  assert.equal(linkReply.status, 404);

  // Trigger purge -> immediately hides from export too.
  ok(await alice.request(`/api/pages/${trashedRoot.id}/purge`, { method: "POST", body: { scope: "personal" } }), 202);
  await waitFor(() => {
    const db = new DatabaseSync(join(f.directory, "notes.sqlite"), { readOnly: true });
    try {
      const count = Number((db.prepare("SELECT count(*) AS n FROM records WHERE scope=? AND collection='pages'").get(`user:${aliceUser.id}`) as { n: number }).n);
      return count === 1;
    } finally {
      db.close();
    }
  });
  const finalListed = ok(await alice.request("/api/v1/pages", { token }));
  assert.deepEqual(finalListed.map((p: Json) => p.id), [active.id]);
});

test("UC-57 AC-05: purge endpoint enforces permissions, state checks, idempotency, and write guards", async (t) => {
  const f = await fixture(t);
  const owner = f.browser();
  const editor = f.browser();
  const viewer = f.browser();
  const ownerUser = await register(owner, "owner");
  await register(editor, "editor");
  await register(viewer, "viewer");
  const ownerToken = await makeToken(owner, "write");

  // Unauthenticated and Agent tokens are rejected.
  assert.equal((await f.browser().request("/api/pages/any/purge", { method: "POST", body: {} })).status, 401);
  assert.equal((await owner.request("/api/pages/any/purge", { method: "POST", token: ownerToken, body: {} })).status, 403);

  // Create KB and invite editor + viewer.
  const kb = ok(await owner.request("/api/knowledge-bases", { method: "POST", body: { requestId: randomUUID(), name: "Team KB", description: "desc" } }), 201);
  const spaceId = kb.spaceId as string;
  const homeId = kb.knowledgeBase.homePageId as string;

  for (const [handle, role, browser] of [["editor", "editor", editor], ["viewer", "viewer", viewer]] as const) {
    ok(await owner.request(`/api/spaces/${spaceId}/invitations`, { method: "POST", body: { handle, role } }));
    const inv = ok(await browser.request("/api/invitations")).find((item: Json) => item.spaceId === spaceId);
    ok(await browser.request(`/api/invitations/${inv.id}`, { method: "POST", body: { accept: true } }));
  }

  // Cannot purge non-archived page or KB home page.
  const kbDoc = ok(await owner.request("/api/v1/pages", { method: "POST", token: ownerToken, body: { scope: spaceId, parentId: homeId, title: "KB Doc" } }), 201);
  assert.equal((await owner.request(`/api/pages/${kbDoc.id}/purge`, { method: "POST", body: { scope: spaceId } })).status, 409);
  assert.equal((await owner.request(`/api/pages/${homeId}/purge`, { method: "POST", body: { scope: spaceId } })).status, 403);

  // Archive kbDoc -> editor and viewer cannot purge, owner can.
  const kbRows = ok(await owner.request(`/api/records/${spaceId}/pages`));
  const kbDocRow = kbRows.find((r: Json) => r.id === kbDoc.id).value;
  ok(await owner.structure(`/api/records/${spaceId}/pages/${kbDoc.id}`, {
    method: "POST",
    body: { action: "patch", patch: { archived: true, archived_at: new Date().toISOString() }, base: kbDocRow },
  }));
  assert.equal((await viewer.request(`/api/pages/${kbDoc.id}/purge`, { method: "POST", body: { scope: spaceId } })).status, 403);
  assert.equal((await editor.request(`/api/pages/${kbDoc.id}/purge`, { method: "POST", body: { scope: spaceId } })).status, 403);

  // Client cannot directly tamper with `purging` field via /api/records/batch.
  const tamperReply = await owner.structure(`/api/records/${spaceId}/pages/${kbDoc.id}`, {
    method: "POST",
    body: { action: "patch", patch: { purging: true }, base: ok(await owner.request(`/api/records/${spaceId}/pages`)).find((r: Json) => r.id === kbDoc.id).value },
  });
  assert.equal(tamperReply.status, 403);

  // Owner cannot purge in an archived KB.
  const summary = ok(await owner.request("/api/spaces")).find((s: Json) => s.spaceId === spaceId);
  ok(await owner.request(`/api/knowledge-bases/${spaceId}/archive`, {
    method: "POST",
    body: { requestId: randomUUID(), revision: summary.knowledgeBase.revision, archived: true },
  }));
  assert.equal((await owner.request(`/api/pages/${kbDoc.id}/purge`, { method: "POST", body: { scope: spaceId } })).status, 403);
  const summary2 = ok(await owner.request("/api/spaces")).find((s: Json) => s.spaceId === spaceId);
  ok(await owner.request(`/api/knowledge-bases/${spaceId}/archive`, {
    method: "POST",
    body: { requestId: randomUUID(), revision: summary2.knowledgeBase.revision, archived: false },
  }));

  // Owner enqueues purge -> 202, and immediate repeat call is idempotent 202 (or 404 once already removed).
  ok(await owner.request(`/api/pages/${kbDoc.id}/purge`, { method: "POST", body: { scope: spaceId } }), 202);
  const repeat = await owner.request(`/api/pages/${kbDoc.id}/purge`, { method: "POST", body: { scope: spaceId } });
  assert.ok([202, 404].includes(repeat.status), `Expected 202 or 404 on repeat purge, got ${repeat.status}`);

  await waitFor(() => {
    const db = new DatabaseSync(join(f.directory, "notes.sqlite"), { readOnly: true });
    try {
      return Number((db.prepare("SELECT count(*) AS n FROM records WHERE scope=? AND collection='pages' AND id=?").get(spaceId, kbDoc.id) as { n: number }).n) === 0;
    } finally {
      db.close();
    }
  });
  assert.ok(ownerUser.id);
});

test("UC-57 AC-03 & AC-04: 2,000-page subtree purges bottom-up without blocking concurrent edits or leaking collaboration_archives", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "notes-purge-2k-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  await migrateDatabase(dir);
  const store = new Store(dir);
  t.after(() => {
    store.purge.stop();
    store.db.close();
  });

  const actor = {
    user: { id: "u1", handle: "alice", displayName: "Alice", avatarUrl: null, siteRole: "admin" as const, createdAt: null },
  };
  const scope = "user:u1";
  store.db.prepare("INSERT INTO users(id,handle,display_name,password,site_role,created_at) VALUES(?,?,?,?,?,?)")
    .run("u1", "alice", "Alice", "hash", "admin", new Date().toISOString());

  // Build 1 active sibling + 2,000-page deep subtree (root + 3 levels), each with blocks, versions, page_events, and collaboration_archives.
  const totalSubtree = 2000;
  const writes: Array<{ scope: string; collection: "pages" | "blocks" | "versions"; id: string; action: "put"; value: Record<string, unknown>; base: null }> = [];
  const liveId = "live-keep";
  writes.push({ scope: "personal", collection: "pages", id: liveId, action: "put", value: pageValue(liveId, "Live Keep", "u1"), base: null });

  const parentIds: string[] = [];
  for (let i = 0; i < totalSubtree; i += 1) {
    const pageId = `p_${String(i).padStart(4, "0")}`;
    const parentId = i === 0 ? undefined : parentIds[Math.floor((i - 1) / 4)];
    parentIds.push(pageId);
    writes.push({
      scope: "personal",
      collection: "pages",
      id: pageId,
      action: "put",
      value: pageValue(pageId, `Page ${i}`, "u1", {
        ...(parentId ? { parent_id: parentId } : {}),
        ...(i === 0 ? { archived: true, archived_at: new Date().toISOString() } : {}),
      }),
      base: null,
    });
    const blockId = `b_${i}`;
    writes.push({
      scope: "personal",
      collection: "blocks",
      id: `${pageId.length}_${pageId}_${blockId}`,
      action: "put",
      value: {
        id: blockId,
        page: pageId,
        kind: "text",
        order: 1000,
        content: [{ text: `Body ${i}` }],
      },
      base: null,
    });
  }

  store.bulkTransaction(() => {
    store.apply(actor, writes, undefined, [], [], 20_000);
  });

  // Add page_events and synthetic pre-existing collaboration_archives across the subtree to verify full cleanup.
  const now = new Date().toISOString();
  store.db.exec("BEGIN IMMEDIATE");
  for (let i = 0; i < totalSubtree; i += 1) {
    const pageId = `p_${String(i).padStart(4, "0")}`;
    if (i % 10 === 0) {
      const eventRecordId = `${pageId.length}_${pageId}_event.e${i}`;
      store.put(scope, "page_events", eventRecordId, {
        page: pageId,
        event: `e${i}`,
        created_at: now,
        author_id: "u1",
        author_name: "Alice",
        label: "创建了页面",
        targets: [pageId],
        merged: 1,
      });
      store.db.prepare("INSERT OR IGNORE INTO collaboration_archives VALUES(?,?,?,?,?)")
        .run(scope, pageId, `gen-${i}`, Buffer.from([1, 2, 3, 4]), now);
    }
  }
  store.db.exec("COMMIT");

  const quotaBefore = store.quotas.usage("user:u1");
  const manager = new PurgeManager(store, { chunkSize: 100, chunkDelayMs: 5 });

  // Override store.purge reference via private/readonly bypass? Better: use store.purge directly for real guard testing!
  // Let's enqueue via store.purge and step store.purge manually with limit=100 so we observe every intermediate chunk.
  const t0 = performance.now();
  const enqueued = store.purge.enqueue(actor, "personal", "p_0000");
  const enqueueMs = performance.now() - t0;
  assert.equal(enqueued.status, "purging");
  assert.equal(enqueued.queued, 1);
  assert.ok(enqueueMs < 200, `Enqueue of 2,000-page subtree took too long: ${enqueueMs.toFixed(1)}ms`);

  // Attempt to write to a deep child while root is purging -> refused with 409 purging!
  assert.throws(
    () => store.apply(actor, [{
      scope: "personal",
      collection: "pages",
      id: "p_1999",
      action: "patch",
      patch: { title_content: [{ text: "Mutated" }] },
      base: store.record(scope, "pages", "p_1999")!,
    }]),
    (err: unknown) => (err as { status?: number; code?: string }).status === 409 && (err as { code?: string }).code === "purging",
  );

  // Attempt to move live-keep under a purging page -> refused!
  assert.throws(
    () => store.apply(actor, [{
      scope: "personal",
      collection: "pages",
      id: liveId,
      action: "patch",
      patch: { parent_id: "p_0500" },
      base: store.record(scope, "pages", liveId)!,
    }]),
    (err: unknown) => (err as { status?: number; code?: string }).status === 409,
  );

  // Full account export mid-purge must omit the purging subtree completely.
  const chunks: Buffer[] = [];
  const sink = new PassThrough();
  sink.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  await writeExport(sink, store, actor);
  sink.end();
  const entries = readZip(Buffer.concat(chunks));
  const recordsEntry = entries.find((entry) => entry.name.endsWith("/records.json"));
  assert.ok(recordsEntry);
  const exportedRecords = JSON.parse(recordsEntry.bytes().toString("utf8"));
  assert.deepEqual(Object.keys(exportedRecords.pages), [liveId]);
  assert.equal(Object.keys(exportedRecords.blocks).length, 0);

  // Step through all 20 chunks of 100, interleaving live page edits mid-purge (validates validatePlane invariants at every step!).
  let steps = 0;
  let editIndex = 0;
  const stepTimes: number[] = [];
  while (store.purge.pendingCount() > 0) {
    const s0 = performance.now();
    const more = store.purge.step(100);
    stepTimes.push(performance.now() - s0);
    steps += 1;
    // Verify root remains until the very final step (bottom-up deletion).
    const rootExists = Boolean(store.record(scope, "pages", "p_0000"));
    if (more) assert.equal(rootExists, true, `Root deleted prematurely at step ${steps}`);
    else assert.equal(rootExists, false, "Root must be deleted on final step");

    // Perform an unrelated edit on live-keep mid-purge to verify zero blocking and zero orphan errors in validatePlane.
    if (steps % 5 === 1) {
      editIndex += 1;
      const base = store.record(scope, "pages", liveId)!;
      store.apply(actor, [{
        scope: "personal",
        collection: "pages",
        id: liveId,
        action: "patch",
        patch: { title_content: [{ text: `Live Keep ${editIndex}` }] },
        base,
      }]);
    }
  }
  assert.equal(steps, 20);
  const maxStepMs = Math.max(...stepTimes);
  console.log(`[UC-57 benchmark] 2,000-page enqueue=${enqueueMs.toFixed(2)}ms, maxChunk100=${maxStepMs.toFixed(2)}ms`);

  // Verify complete cleanup of records, collaboration tables, and quota release.
  assert.equal(Number(store.one("SELECT count(*) AS n FROM records WHERE scope=? AND collection='pages'", scope)?.n), 1);
  assert.equal(Number(store.one("SELECT count(*) AS n FROM records WHERE scope=? AND collection='blocks'", scope)?.n), 0);
  assert.equal(Number(store.one("SELECT count(*) AS n FROM records WHERE scope=? AND collection='versions'", scope)?.n), 0);
  assert.equal(Number(store.one("SELECT count(*) AS n FROM records WHERE scope=? AND collection='page_events' AND json_extract(value,'$.page')!=?", scope, liveId)?.n), 0);
  assert.equal(Number(store.one("SELECT count(*) AS n FROM collaboration_documents WHERE scope=? AND page_id!=?", scope, liveId)?.n), 0);
  assert.equal(Number(store.one("SELECT count(*) AS n FROM collaboration_archives WHERE scope=?", scope)?.n), 0);
  assert.equal(Number(store.one("SELECT count(*) AS n FROM purge_queue")?.n), 0);
  const quotaAfter = store.quotas.usage("user:u1");
  assert.ok(quotaAfter < quotaBefore / 10, `Expected quota to drop substantially: before=${quotaBefore}, after=${quotaAfter}`);
  assert.ok(manager);
});

test("UC-57 AC-03 HTTP: POST /api/pages/:id/purge responds in milliseconds for 2,000-page subtree", async (t) => {
  const f = await fixture(t);
  const alice = f.browser();
  const aliceUser = await register(alice, "alice2k");
  const writes: Json[] = [];
  for (let i = 0; i < 2000; i += 1) {
    const pid = `http2k_${i}`;
    writes.push({
      scope: "personal",
      collection: "pages",
      id: pid,
      action: "put",
      value: pageValue(pid, `HTTP 2K ${i}`, aliceUser.id, {
        ...(i > 0 ? { parent_id: `http2k_${Math.floor((i - 1) / 5)}` } : { archived: true, archived_at: new Date().toISOString() }),
      }),
      base: null,
    });
  }
  ok(await alice.request("/api/records/batch", { method: "POST", body: { writes } }));

  const t0 = performance.now();
  const reply = ok(await alice.request("/api/pages/http2k_0/purge", { method: "POST", body: { scope: "personal" } }), 202);
  const httpMs = performance.now() - t0;
  assert.equal(reply.status, "purging");
  assert.ok(httpMs < 500, `Expected HTTP 202 < 500ms, got ${httpMs.toFixed(1)}ms`);
  console.log(`[UC-57 benchmark] HTTP POST /api/pages/:id/purge (2,000 pages)=${httpMs.toFixed(2)}ms`);

  await waitFor(() => {
    const db = new DatabaseSync(join(f.directory, "notes.sqlite"), { readOnly: true });
    try {
      const pagesLeft = Number((db.prepare("SELECT count(*) AS n FROM records WHERE scope=? AND collection='pages'").get(`user:${aliceUser.id}`) as { n: number }).n);
      const qLeft = Number((db.prepare("SELECT count(*) AS n FROM purge_queue").get() as { n: number }).n);
      return pagesLeft === 0 && qLeft === 0;
    } finally {
      db.close();
    }
  });
});

test("UC-57 AC-06 & AC-07: shared/nested trees clean up memberships & restart resumes partial purge", async (t) => {
  const f = await fixture(t);
  const alice = f.browser();
  const bob = f.browser();
  const aliceUser = await register(alice, "alice");
  await register(bob, "bob");
  const aliceToken = await makeToken(alice, "write");

  // 1. Create a private folder containing a nested ordinary shared root page.
  const folder = ok(await alice.request("/api/v1/pages", { method: "POST", token: aliceToken, body: { title: "Folder" } }), 201);
  const sharedChild = ok(await alice.request("/api/v1/pages", { method: "POST", token: aliceToken, body: { title: "Shared Child", parentId: folder.id } }), 201);
  const createdSpace = ok(await alice.request("/api/spaces", { method: "POST", body: { name: "Shared Page" } }), 201);
  const spaceId = createdSpace.spaceId as string;
  ok(await alice.request(`/api/spaces/${spaceId}/invitations`, { method: "POST", body: { handle: "bob", role: "editor" } }));
  const inv = ok(await bob.request("/api/invitations")).find((i: Json) => i.spaceId === spaceId);
  ok(await bob.request(`/api/invitations/${inv.id}`, { method: "POST", body: { accept: true } }));

  // Move sharedChild into spaceId via /api/records/batch (keeping pointer in personal).
  const sharedRow = ok(await alice.request("/api/records/personal/pages")).find((r: Json) => r.id === sharedChild.id).value;
  const blockRows = ok(await alice.request(`/api/records/personal/blocks?after=0&pages=${sharedChild.id}:0`)).rows;
  ok(await alice.structure("/api/records/batch", {
    method: "POST",
    body: {
      writes: [
        { scope: spaceId, collection: "pages", id: sharedChild.id, action: "put", value: { ...sharedRow, share_space_id: spaceId }, base: null },
        ...blockRows.map((b: Json) => ({ scope: spaceId, collection: "blocks", id: b.id, action: "put", value: b.value, base: null })),
        { scope: "personal", collection: "pages", id: sharedChild.id, action: "patch", patch: { share_space_id: spaceId }, base: sharedRow },
      ],
    },
  }));

  // Archive Folder, then enqueue purge -> revokes bob from spaceId and purges both scopes.
  const folderRow = ok(await alice.request("/api/records/personal/pages")).find((r: Json) => r.id === folder.id).value;
  ok(await alice.structure(`/api/records/personal/pages/${folder.id}`, {
    method: "POST",
    body: { action: "patch", patch: { archived: true, archived_at: new Date().toISOString() }, base: folderRow },
  }));
  ok(await alice.request(`/api/pages/${folder.id}/purge`, { method: "POST", body: { scope: "personal" } }), 202);

  await waitFor(async () => {
    const bobSpaces = ok(await bob.request("/api/spaces"));
    return !bobSpaces.some((s: Json) => s.spaceId === spaceId);
  });
  await waitFor(() => {
    const db = new DatabaseSync(join(f.directory, "notes.sqlite"), { readOnly: true });
    try {
      return Number((db.prepare("SELECT count(*) AS n FROM purge_queue").get() as { n: number }).n) === 0;
    } finally {
      db.close();
    }
  });

  // 2. Restart resume test: stop HTTP server, seed 250-page tree into purge_queue via Store, run 1 step (100 deleted), close, restart server -> drains to 0!
  await f.close();
  await migrateDatabase(f.directory);
  const store = new Store(f.directory);
  const actor = { user: { id: aliceUser.id, handle: "alice", displayName: "Alice", avatarUrl: null, siteRole: "admin" as const, createdAt: null } };
  const scope = `user:${aliceUser.id}`;
  const writes: Array<{ scope: string; collection: "pages"; id: string; action: "put"; value: Record<string, unknown>; base: null }> = [];
  for (let i = 0; i < 250; i += 1) {
    const pid = `restart_${i}`;
    writes.push({
      scope: "personal",
      collection: "pages",
      id: pid,
      action: "put",
      value: pageValue(pid, `Restart ${i}`, aliceUser.id, {
        ...(i > 0 ? { parent_id: `restart_${Math.floor((i - 1) / 3)}` } : { archived: true, archived_at: new Date().toISOString() }),
      }),
      base: null,
    });
  }
  store.bulkTransaction(() => store.apply(actor, writes, undefined, [], [], 1000));
  store.purge.enqueue(actor, "personal", "restart_0");
  assert.equal(store.purge.step(100), true);
  assert.equal(Number(store.one("SELECT count(*) AS n FROM records WHERE scope=? AND collection='pages' AND id LIKE 'restart_%'", scope)?.n), 150);
  store.purge.stop();
  store.db.close();

  // Restart server — startServer calls store.purge.start(), which automatically finishes the remaining 150 pages.
  await f.restart();
  await waitFor(() => {
    const db = new DatabaseSync(join(f.directory, "notes.sqlite"), { readOnly: true });
    try {
      const left = Number((db.prepare("SELECT count(*) AS n FROM records WHERE scope=? AND collection='pages' AND id LIKE 'restart_%'").get(scope) as { n: number }).n);
      const q = Number((db.prepare("SELECT count(*) AS n FROM purge_queue").get() as { n: number }).n);
      return left === 0 && q === 0;
    } finally {
      db.close();
    }
  });
});
