import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { startServer } from "../server/index.ts";
import { migrateDatabase } from "../server/migrations/index.ts";
import { Store, type Actor } from "../server/store.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const nowIso = () => new Date().toISOString();

class Browser {
  cookie = "";
  constructor(private readonly baseUrl: () => string) {}
  async request(path: string, options: {
    method?: string; body?: unknown; token?: string; raw?: Buffer; contentType?: string;
  } = {}) {
    const headers: Record<string, string> = {};
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    else if (this.cookie) headers.cookie = this.cookie;
    let body: BodyInit | undefined;
    if (options.raw) {
      headers["content-type"] = options.contentType ?? "application/octet-stream";
      body = new Uint8Array(options.raw);
    } else if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    const response = await fetch(`${this.baseUrl()}${path}`, { method: options.method ?? "GET", headers, body });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      const value = setCookie.split(";")[0];
      this.cookie = value.endsWith("=") ? "" : value;
    }
    const type = response.headers.get("content-type") ?? "";
    const parsed = type.includes("application/json")
      ? await response.json()
      : type.startsWith("text/") ? await response.text() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, body: parsed };
  }
}

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "heinote-uc59-"));
  let server: Awaited<ReturnType<typeof startServer>> | null = await startServer({ dataDir: directory, port: 0, serveClient: false });
  t.after(async () => {
    if (server) await server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    url: () => server!.url,
    browser: () => new Browser(() => server!.url),
    async close() {
      if (server) { await server.close(); server = null; }
    },
    async restart() {
      if (server) await server.close();
      server = await startServer({ dataDir: directory, port: 0, serveClient: false });
    },
  };
}

function ok(reply: { status: number; body: Json }, expected = 200) {
  assert.equal(reply.status, expected, `expected ${expected}, got ${reply.status}: ${JSON.stringify(reply.body)}`);
  return reply.body;
}

async function register(browser: Browser, handle: string) {
  return ok(await browser.request("/api/auth/register", {
    method: "POST",
    body: { handle, displayName: handle, password: `${handle}-password-123` },
  }), 201).user;
}

function pageValue(id: string, title: string, author: string, extra: Record<string, unknown> = {}) {
  const t = nowIso();
  return {
    id,
    title_content: [{ text: title }],
    icon: "",
    kind: "document",
    created_at: t,
    updated_at: t,
    created_by: author,
    updated_by: author,
    ...extra,
  };
}

function blockValue(pageId: string, blockId: string, text: string, order = 1024) {
  return { id: blockId, page: pageId, kind: "text", order, content: [{ text }] };
}

test("UC-59 AC-01: O(1) scope_usage matches raw sums across rollbacks, incremental validatePlane keeps invariants, and 2,000-page writes/checkpoints stay in ms", async (t) => {
  const f = await fixture(t);
  const alice = f.browser();
  const user = await register(alice, "alice");
  const token = ok(await alice.request("/api/tokens", { method: "POST", body: { name: "bench", access: "write" } }), 201).token;

  // Create a database with 2 rows + seed 2,000 pages directly via Store for realistic vault scale.
  const dbPage = ok(await alice.request("/api/v1/databases", {
    method: "POST", token,
    body: { requestId: randomUUID(), title: "Bench DB" },
  }), 201);
  ok(await alice.request(`/api/v1/databases/${dbPage.id}/rows`, {
    method: "POST", token,
    body: { requestId: randomUUID(), baseRevision: dbPage.revision, title: "Row A" },
  }), 201);

  await f.close();
  await migrateDatabase(f.directory);
  const store = new Store(f.directory);
  const actor: Actor = { user: { id: user.id, handle: "alice", displayName: "alice", avatarUrl: null, siteRole: "admin", createdAt: null } };
  const scope = `user:${user.id}`;

  const writes: Array<{ scope: string; collection: "pages" | "blocks"; id: string; action: "put"; value: Record<string, unknown>; base: null }> = [];
  for (let i = 0; i < 2000; i += 1) {
    const pid = `v_${i}`;
    writes.push({
      scope: "personal", collection: "pages", id: pid, action: "put", base: null,
      value: pageValue(pid, `Vault ${i}`, user.id, i > 0 ? { parent_id: `v_${Math.floor((i - 1) / 4)}` } : {}),
    });
    writes.push({
      scope: "personal", collection: "blocks", id: `${pid.length}_${pid}_b1`, action: "put", base: null,
      value: blockValue(pid, "b1", `Paragraph content for page ${i}`),
    });
  }
  store.bulkTransaction(() => store.apply(actor, writes, undefined, [], 5000));

  // Verify scope_usage matches raw SQL SUM(LENGTH(value)) on records to the exact byte (UC-60 single source of truth).
  const assertUsageExact = () => {
    const tracked = store.one("SELECT records_bytes, docs_bytes, archives_bytes FROM scope_usage WHERE scope=?", scope)!;
    const rawRec = Number(store.one("SELECT COALESCE(SUM(LENGTH(value)),0) AS n FROM records WHERE scope=?", scope)?.n ?? 0);
    assert.equal(Number(tracked.records_bytes), rawRec);
    assert.equal(Number(tracked.docs_bytes), 0);
    assert.equal(Number(tracked.archives_bytes), 0);
  };
  assertUsageExact();

  // Verify incremental validatePlane still rejects cycles & orphan deletes and rolls back scope_usage cleanly.
  assert.throws(() => {
    const rootVal = store.record(scope, "pages", "v_0")!;
    store.apply(actor, [{ scope: "personal", collection: "pages", id: "v_0", action: "patch", patch: { parent_id: "v_10" }, base: rootVal }]);
  }, /循环/);
  assertUsageExact();

  assert.throws(() => {
    const parentVal = store.record(scope, "pages", "v_1")!;
    store.apply(actor, [{ scope: "personal", collection: "pages", id: "v_1", action: "delete", base: parentVal }]);
  }, /父页面必须位于同一空间/);
  assertUsageExact();

  // Verify quota rollback leaves scope_usage exact.
  const usedBefore = store.quotas.usage(`user:${user.id}`);
  store.quotas.setUserLimits(user.id, usedBefore + 10, null);
  assert.throws(() => {
    store.apply(actor, [{
      scope: "personal", collection: "blocks", id: `${"v_0".length}_v_0_huge`, action: "put", base: null,
      value: blockValue("v_0", "huge", "x".repeat(500), 2048),
    }]);
  }, /超出存储限额/);
  store.quotas.setUserLimits(user.id, null, null);
  assertUsageExact();

  // Benchmark single structural block write on the 2,000-page vault.
  const tWriteStart = performance.now();
  store.apply(actor, [{
    scope: "personal", collection: "blocks", id: `${"v_1999".length}_v_1999_b2`, action: "put", base: null,
    value: blockValue("v_1999", "b2", "Fast incremental write", 2048),
  }]);
  const writeMs = performance.now() - tWriteStart;
  assertUsageExact();

  store.purge.stop();
  store.maintenance.stop();
  store.db.close();

  // Restart HTTP server and benchmark checkpoint, versions, events, and database query on 2,000-page vault.
  await f.restart();
  const tCpStart = performance.now();
  const cp = ok(await alice.request("/api/v1/pages/v_1999/checkpoint", { method: "POST", token, body: { summary: "bench" } }), 200);
  const cpMs = performance.now() - tCpStart;
  assert.ok(cp.id);

  const tVerStart = performance.now();
  const versions = ok(await alice.request("/api/v1/pages/v_1999/versions", { token }), 200);
  const verMs = performance.now() - tVerStart;
  assert.equal(versions.length, 1);

  const tEvtStart = performance.now();
  const events = ok(await alice.request("/api/v1/pages/v_1999/events", { token }), 200);
  const evtMs = performance.now() - tEvtStart;
  assert.ok(events.length >= 1);

  const tQueryStart = performance.now();
  const queryRes = ok(await alice.request(`/api/v1/databases/${dbPage.id}/query`, { method: "POST", token, body: {} }), 200);
  const queryMs = performance.now() - tQueryStart;
  assert.equal(queryRes.total, 1);

  console.log(`[UC-59 benchmark] 2,000-page vault: structuralWrite=${writeMs.toFixed(2)}ms, checkpoint=${cpMs.toFixed(2)}ms, versions=${verMs.toFixed(2)}ms, events=${evtMs.toFixed(2)}ms, dbQuery=${queryMs.toFixed(2)}ms`);
  assert.ok(writeMs < 200, `structural write too slow: ${writeMs}ms`);
  assert.ok(cpMs < 200, `checkpoint too slow: ${cpMs}ms`);
  assert.ok(verMs < 200, `versions too slow: ${verMs}ms`);
  assert.ok(evtMs < 200, `events too slow: ${evtMs}ms`);
});

test("UC-59 AC-02: server-side POST /api/pages/:id/transfer shares, moves, and stop-shares a 1,200-page subtree with collaboration migration", async (t) => {
  const f = await fixture(t);
  const alice = f.browser();
  const bob = f.browser();
  const aliceUser = await register(alice, "alice");
  await register(bob, "bob");

  // Create KB to verify boundary rejection.
  const kb = ok(await alice.request("/api/knowledge-bases", {
    method: "POST", body: { requestId: randomUUID(), name: "Team KB", description: "" },
  }), 201);

  // Seed a 1,200-page tree + a separate 50-page movable branch directly via Store.
  await f.close();
  await migrateDatabase(f.directory);
  const store = new Store(f.directory);
  const actor: Actor = { user: { id: aliceUser.id, handle: "alice", displayName: "alice", avatarUrl: null, siteRole: "admin", createdAt: null } };
  const writes: Array<{ scope: string; collection: "pages" | "blocks"; id: string; action: "put"; value: Record<string, unknown>; base: null }> = [];
  for (let i = 0; i < 1200; i += 1) {
    const pid = `tr_${i}`;
    writes.push({
      scope: "personal", collection: "pages", id: pid, action: "put", base: null,
      value: pageValue(pid, `Tree ${i}`, aliceUser.id, i > 0 ? { parent_id: `tr_${Math.floor((i - 1) / 3)}` } : {}),
    });
    writes.push({
      scope: "personal", collection: "blocks", id: `${pid.length}_${pid}_b1`, action: "put", base: null,
      value: blockValue(pid, "b1", `Tree body ${i}`),
    });
  }
  for (let i = 0; i < 50; i += 1) {
    const pid = `mv_${i}`;
    writes.push({
      scope: "personal", collection: "pages", id: pid, action: "put", base: null,
      value: pageValue(pid, `Move ${i}`, aliceUser.id, i > 0 ? { parent_id: `mv_${Math.floor((i - 1) / 2)}` } : {}),
    });
    writes.push({
      scope: "personal", collection: "blocks", id: `${pid.length}_${pid}_b1`, action: "put", base: null,
      value: blockValue(pid, "b1", `Move body ${i}`),
    });
  }
  store.bulkTransaction(() => store.apply(actor, writes, undefined, [], 5000));
  store.purge.stop();
  store.maintenance.stop();
  store.db.close();
  await f.restart();

  // Create old personal public share on tr_0 and a share space with bob as editor.
  const oldPublic = ok(await alice.request("/api/shares", { method: "POST", body: { pageId: "tr_0" } }), 201);
  const oldToken = new URL(oldPublic.url, "http://unused.invalid").pathname.split("/").at(-1)!;
  const space = ok(await alice.request("/api/spaces", { method: "POST", body: { name: "Big Share" } }), 201);
  const spaceId = space.spaceId;
  ok(await alice.request(`/api/spaces/${spaceId}/invitations`, { method: "POST", body: { handle: "bob", role: "editor" } }), 200);
  const inv = ok(await bob.request("/api/invitations"), 200)[0];
  ok(await bob.request(`/api/invitations/${inv.id}`, { method: "POST", body: { accept: true } }), 200);

  // Share the 1,200-page tree via POST /api/pages/tr_0/transfer.
  const tShareStart = performance.now();
  const sharedRes = ok(await alice.request("/api/pages/tr_0/transfer", {
    method: "POST", body: { action: "share", spaceId },
  }), 200);
  const shareMs = performance.now() - tShareStart;
  assert.equal(sharedRes.movedPages, 1200);

  // Old personal public link revoked; bob sees all 1,200 pages in spaceId.
  assert.equal((await f.browser().request(`/api/public/${oldToken}`)).status, 404);
  const spacePages = ok(await bob.request(`/api/records/${spaceId}/pages`), 200);
  assert.equal(spacePages.length, 1200);

  // Bob edits tr_0 via semantic OT op in the shared room.
  const sharedSnap = ok(await bob.request(`/api/collaboration/${spaceId}/tr_0`), 200);
  const bodyKey = `blocks/${"tr_0".length}_tr_0_b1/content`;
  ok(await bob.request("/api/records/batch", {
    method: "POST",
    body: {
      requestId: randomUUID(),
      writes: [],
      pageOps: [{
        scope: spaceId,
        pageId: "tr_0",
        epoch: sharedSnap.epoch,
        baseSeq: sharedSnap.seq,
        ops: [{ type: "text", field: bodyKey, ops: [{ insert: "协作者编辑:" }] }],
      }],
      protocol: 2,
    },
  }), 200);

  // Move 50-page personal branch into the shared space under tr_0, and verify KB boundary rejection.
  assert.equal((await alice.request("/api/pages/mv_0/transfer", {
    method: "POST", body: { action: "move", targetParentId: kb.knowledgeBase.homePageId },
  })).status, 403);
  const movedIn = ok(await alice.request("/api/pages/mv_0/transfer", {
    method: "POST", body: { action: "move", targetParentId: "tr_0" },
  }), 200);
  assert.equal(movedIn.movedPages, 50);
  assert.equal(ok(await bob.request(`/api/records/${spaceId}/pages`), 200).length, 1250);

  // Non-owner bob cannot stop-share.
  assert.equal((await bob.request("/api/pages/tr_0/transfer", { method: "POST", body: { action: "stop-share" } })).status, 403);

  // Owner stop-shares the now 1,250-page tree back to personal.
  const tStopStart = performance.now();
  const stoppedRes = ok(await alice.request("/api/pages/tr_0/transfer", {
    method: "POST", body: { action: "stop-share" },
  }), 200);
  const stopMs = performance.now() - tStopStart;
  assert.equal(stoppedRes.movedPages, 1250);

  // Bob loses access immediately; Alice's personal collaboration snapshot retains Bob's edit with a new epoch.
  assert.equal((await bob.request(`/api/collaboration/${spaceId}/tr_0`)).status, 403);
  const personalSnap = ok(await alice.request("/api/collaboration/personal/tr_0"), 200);
  assert.notEqual(personalSnap.epoch, sharedSnap.epoch);
  const movedBlock = personalSnap.records.blocks.find((b: Json) => b.value.id === "b1");
  assert.equal(movedBlock.value.content.map((r: Json) => r.text ?? "").join(""), "协作者编辑:Tree body 0");

  console.log(`[UC-59 benchmark] 1,200-page share=${shareMs.toFixed(2)}ms, 1,250-page stop-share=${stopMs.toFixed(2)}ms`);
  assert.ok(shareMs < 2000, `share transfer too slow: ${shareMs}ms`);
  assert.ok(stopMs < 2000, `stop-share transfer too slow: ${stopMs}ms`);
});

test("UC-59 AC-03 & AC-04: zero-copy attachment clone and grace-period GC reclaim orphaned files while preserving active, in-flight, version, and cross-scope refs", async (t) => {
  const f = await fixture(t);
  const alice = f.browser();
  const aliceUser = await register(alice, "alice");
  const token = ok(await alice.request("/api/tokens", { method: "POST", body: { name: "gc", access: "write" } }), 201).token;

  // Helper to upload bytes via Agent files API.
  const upload = async (name: string, payload: string, space = "personal") => {
    const bytes = Buffer.from(payload);
    const stored = ok(await alice.request(`/api/v1/files/${encodeURIComponent(space)}?name=${encodeURIComponent(name)}`, {
      method: "PUT", token, raw: bytes, contentType: "text/plain",
    }), 201);
    return { stored, bytes };
  };

  // 1. Page with attachment that will be copied zero-copy to a KB, then source deleted -> copy & blob MUST survive!
  const kb = ok(await alice.request("/api/knowledge-bases", {
    method: "POST", body: { requestId: randomUUID(), name: "Copy Dest", description: "" },
  }), 201);
  const copiedFile = await upload("shared-blob.txt", "zero-copy-payload-001");
  const srcPage = ok(await alice.request("/api/v1/pages", { method: "POST", token, body: { title: "Src Copy", text: "hi" } }), 201);
  ok(await alice.request(`/api/v1/pages/${srcPage.id}/operations`, {
    method: "POST", token,
    body: {
      requestId: randomUUID(),
      generation: srcPage.collaboration.generation,
      baseRevision: srcPage.revision,
      operations: [{ type: "insert_block", kind: "file", file: copiedFile.stored, text: "shared-blob.txt" }],
    },
  }), 200);
  const copiedPage = ok(await alice.request(`/api/v1/pages/${srcPage.id}/copy`, {
    method: "POST", token,
    body: { requestId: randomUUID(), spaceId: kb.spaceId },
  }), 201);
  // Check that target KB got a files row with the exact same hash.
  const dbCheck = new DatabaseSync(join(f.directory, "notes.sqlite"), { readOnly: true });
  const copyFileRows = dbCheck.prepare("SELECT scope, path, hash FROM files WHERE scope=?").all(kb.spaceId) as Array<{ scope: string; path: string; hash: string }>;
  dbCheck.close();
  assert.equal(copyFileRows.length, 1);

  // 2. Attachment on a page that will be permanently deleted (should be reclaimed).
  const doomedFile = await upload("doomed.txt", "doomed-unique-content-999");
  const doomedPage = ok(await alice.request("/api/v1/pages", { method: "POST", token, body: { title: "Doomed", text: "bye" } }), 201);
  ok(await alice.request(`/api/v1/pages/${doomedPage.id}/operations`, {
    method: "POST", token,
    body: {
      requestId: randomUUID(),
      generation: doomedPage.collaboration.generation,
      baseRevision: doomedPage.revision,
      operations: [{ type: "insert_block", kind: "file", file: doomedFile.stored, text: "doomed.txt" }],
    },
  }), 200);

  // 3. Attachment referenced ONLY in a historical version snapshot (removed from current page body).
  const histFile = await upload("history-only.txt", "history-snapshot-payload-777");
  const histPage = ok(await alice.request("/api/v1/pages", { method: "POST", token, body: { title: "History Keeper", text: "v1" } }), 201);
  const histWithFile = ok(await alice.request(`/api/v1/pages/${histPage.id}/operations`, {
    method: "POST", token,
    body: {
      requestId: randomUUID(),
      generation: histPage.collaboration.generation,
      baseRevision: histPage.revision,
      operations: [{ type: "insert_block", kind: "file", file: histFile.stored, text: "history-only.txt" }],
    },
  }), 200);
  ok(await alice.request(`/api/v1/pages/${histPage.id}/checkpoint`, { method: "POST", token, body: { summary: "with file" } }), 200);
  // Replace body so current page no longer references histFile.
  ok(await alice.request(`/api/v1/pages/${histPage.id}`, {
    method: "PATCH", token,
    body: { baseRevision: histWithFile.revision, text: "file removed from live body" },
  }), 200);

  // 4. Fresh in-flight upload not yet attached to any page (must survive grace period!).
  const inflightFile = await upload("inflight.txt", "inflight-fresh-upload-555");

  // Archive and purge both srcPage and doomedPage.
  for (const pageObj of [srcPage, doomedPage]) {
    const latest = ok(await alice.request(`/api/v1/pages/${pageObj.id}`, { token }), 200);
    ok(await alice.request("/api/records/batch", {
      method: "POST",
      body: {
        requestId: randomUUID(),
        writes: [{ scope: "personal", collection: "pages", id: pageObj.id, action: "patch", patch: { archived: true, archived_at: nowIso() }, base: latest.page }],
        expectedPages: [{ scope: "personal", pageId: pageObj.id, generation: latest.collaboration.generation, revision: latest.revision }],
      },
    }), 200);
    ok(await alice.request(`/api/pages/${pageObj.id}/purge`, { method: "POST", body: { scope: "personal" } }), 202);
  }

  await f.close();
  await migrateDatabase(f.directory);
  const store = new Store(f.directory);
  store.purge.drainNow();

  // Backdate all files EXCEPT inflightFile so they are past the 10-minute grace period.
  const oldTs = new Date(Date.now() - 30 * 60_000).toISOString();
  store.db.prepare("UPDATE files SET created_at=? WHERE path!=?").run(oldTs, inflightFile.stored.path);

  const usageBeforeGc = store.quotas.usage(`user:${aliceUser.id}`);
  const doomedHash = String(store.one("SELECT hash FROM files WHERE path=?", doomedFile.stored.path)!.hash);
  const copiedHash = String(store.one("SELECT hash FROM files WHERE scope=? AND path=?", kb.spaceId, copyFileRows[0].path)!.hash);

  const sweep = store.maintenance.sweepFiles({ graceMs: 10 * 60_000 });
  assert.equal(sweep.removedRows, 2); // doomedFile + personal copy of copiedFile
  assert.equal(sweep.removedBlobs, 1); // doomedHash unlinked; copiedHash still used by KB copy!

  // Quota decreased after GC!
  assert.ok(store.quotas.usage(`user:${aliceUser.id}`) < usageBeforeGc);
  // Doomed blob is gone from disk; copied blob is still on disk and readable from KB!
  assert.equal(existsSync(join(f.directory, "attachments", doomedHash.slice(0, 2), doomedHash)), false);
  assert.equal(existsSync(join(f.directory, "attachments", copiedHash.slice(0, 2), copiedHash)), true);
  // History-only attachment & in-flight attachment both preserved!
  assert.ok(store.one("SELECT 1 FROM files WHERE path=?", histFile.stored.path));
  assert.ok(store.one("SELECT 1 FROM files WHERE path=?", inflightFile.stored.path));
  assert.ok(copiedPage.id);

  store.purge.stop();
  store.maintenance.stop();
  store.db.close();
});

test("UC-59 AC-05 & AC-06: pruneRequests, tombstone compaction with reset:true, and pageDto.trashed for nested trashed pages", async (t) => {
  const f = await fixture(t);
  const alice = f.browser();
  const aliceUser = await register(alice, "alice");
  const token = ok(await alice.request("/api/tokens", { method: "POST", body: { name: "maint", access: "write" } }), 201).token;

  // AC-06: app & database under an archived parent report trashed: true in /api/v1/pages/:id.
  const folder = ok(await alice.request("/api/v1/pages", { method: "POST", token, body: { title: "Folder", text: "f" } }), 201);
  const nestedApp = ok(await alice.request("/api/v1/pages", { method: "POST", token, body: { title: "Nested App", kind: "app", parentId: folder.id } }), 201);
  assert.equal(ok(await alice.request(`/api/v1/pages/${nestedApp.id}`, { token }), 200).trashed, false);
  const folderLatest = ok(await alice.request(`/api/v1/pages/${folder.id}`, { token }), 200);
  ok(await alice.request("/api/records/batch", {
    method: "POST",
    body: {
      requestId: randomUUID(),
      writes: [{ scope: "personal", collection: "pages", id: folder.id, action: "patch", patch: { archived: true, archived_at: nowIso() }, base: folderLatest.page }],
      expectedPages: [{ scope: "personal", pageId: folder.id, generation: folderLatest.collaboration.generation, revision: folderLatest.revision }],
    },
  }), 200);
  const trashedDto = ok(await alice.request(`/api/v1/pages/${nestedApp.id}`, { token }), 200);
  assert.equal(trashedDto.trashed, true);

  // AC-05: create & delete 40 pages to accumulate tombstones, plus seed expired vs fresh requests.
  await f.close();
  await migrateDatabase(f.directory);
  const store = new Store(f.directory);
  const scope = `user:${aliceUser.id}`;
  const actor: Actor = { user: { id: aliceUser.id, handle: "alice", displayName: "alice", avatarUrl: null, siteRole: "admin", createdAt: null } };

  for (let i = 0; i < 40; i += 1) {
    const pid = `tomb_${i}`;
    store.apply(actor, [{ scope: "personal", collection: "pages", id: pid, action: "put", base: null, value: pageValue(pid, `Tomb ${i}`, aliceUser.id) }]);
    const rec = store.record(scope, "pages", pid)!;
    store.apply(actor, [{ scope: "personal", collection: "pages", id: pid, action: "delete", base: rec }]);
  }

  // UC-60: verify sliding-window pruneCollaborationOps trims old ops and advances pruned_before.
  const oldOpTime = new Date(Date.now() - 2 * 3_600_000).toISOString();
  store.db.prepare("INSERT OR REPLACE INTO collaboration_pages(scope,page_id,epoch,seq,pruned_before) VALUES(?,?,?,?,?)")
    .run(scope, "prune_page", "ep-1", 30, 0);
  for (let seq = 1; seq <= 30; seq += 1) {
    store.db.prepare("INSERT INTO collaboration_ops(scope,page_id,seq,epoch,request_id,actor_id,ops,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(scope, "prune_page", seq, "ep-1", `req-${seq}`, aliceUser.id, "[]", seq <= 25 ? oldOpTime : nowIso());
  }
  const prunedOps = store.maintenance.pruneCollaborationOps({ maxOpsPerPage: 10, minRetentionMs: 3_600_000, hardMaxOpsPerPage: 100 });
  assert.equal(prunedOps, 20);
  const metaAfterPrune = store.one("SELECT seq, pruned_before FROM collaboration_pages WHERE scope=? AND page_id='prune_page'", scope)!;
  assert.equal(Number(metaAfterPrune.pruned_before), 20);
  const opsRemaining = Number(store.one("SELECT count(*) AS n FROM collaboration_ops WHERE scope=? AND page_id='prune_page'", scope)!.n);
  assert.equal(opsRemaining, 10);

  // Backdate 2 requests to 10 days ago, keep 1 fresh.
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
  store.db.prepare("INSERT INTO requests(user_id,request_id,digest,result,created_at) VALUES(?,?,?,?,?)").run(aliceUser.id, "old-1", "d1", "{}", tenDaysAgo);
  store.db.prepare("INSERT INTO requests(user_id,request_id,digest,result,created_at) VALUES(?,?,?,?,?)").run(aliceUser.id, "old-2", "d2", "{}", tenDaysAgo);
  store.db.prepare("INSERT INTO requests(user_id,request_id,digest,result,created_at) VALUES(?,?,?,?,?)").run(aliceUser.id, "fresh-1", "d3", "{}", nowIso());

  const prunedReq = store.maintenance.pruneRequests({ ttlMs: 7 * 86_400_000 });
  assert.equal(prunedReq, 2);
  assert.ok(store.one("SELECT 1 FROM requests WHERE request_id='fresh-1'"));
  assert.equal(store.one("SELECT 1 FROM requests WHERE request_id='old-1'"), undefined);

  const compacted = store.maintenance.compactTombstones({ maxTombstones: 10 });
  assert.ok(compacted >= 30, `expected at least 30 compacted tombstones, got ${compacted}`);
  const leftTombs = Number(store.one("SELECT count(*) AS n FROM record_changes WHERE scope=? AND collection='pages' AND deleted=1", scope)!.n);
  const leftEventTombs = Number(store.one("SELECT count(*) AS n FROM record_changes WHERE scope=? AND collection='page_events' AND deleted=1", scope)!.n);
  assert.equal(leftTombs, 10);
  assert.ok(leftEventTombs <= 10);

  const seqRow = store.one("SELECT seq, pruned_before FROM record_seq WHERE scope=? AND collection='pages'", scope)!;
  assert.ok(Number(seqRow.pruned_before) > 0);

  store.purge.stop();
  store.maintenance.stop();
  store.db.close();
  await f.restart();

  // Stale watermark (after=1 <= pruned_before) gets reset: true; latest watermark gets normal empty delta.
  const staleDelta = ok(await alice.request("/api/records/personal/pages?after=1"), 200);
  assert.equal(staleDelta.reset, true);
  assert.deepEqual(staleDelta.rows, []);

  const freshDelta = ok(await alice.request(`/api/records/personal/pages?after=${Number(seqRow.seq)}`), 200);
  assert.equal(freshDelta.reset, undefined);
  assert.deepEqual(freshDelta.rows, []);
});
