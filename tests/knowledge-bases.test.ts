import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import * as Y from "yjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { startServer } from "../server/index.ts";
import { Browser, type Json, type Reply } from "./helpers/github.ts";

// UC-13: use real HTTP boundaries and temporary data only.
type Server = Awaited<ReturnType<typeof startServer>>;
const password = "Independent-knowledge-base-acceptance-2026!";
function ok(reply: Reply, expected = 200): Json {
  assert.equal(reply.status, expected, JSON.stringify(reply.body));
  return reply.body;
}
function denied(reply: Reply): void {
  assert.ok([401, 403, 404].includes(reply.status), `Expected access refusal, got ${reply.status}: ${JSON.stringify(reply.body)}`);
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "notes-knowledge-bases-http-"));
  let server: Server | undefined;
  t.after(async () => {
    try { await server?.close(); }
    finally {
      const target = resolve(directory);
      assert.equal(dirname(target), resolve(tmpdir()));
      assert.ok(basename(target).startsWith("notes-knowledge-bases-http-"));
      await rm(target, { recursive: true, force: true });
    }
  });
  server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false });
  return {
    directory,
    browser: () => new Browser(() => server!.url),
    url: () => server!.url,
    async restart() {
      await server!.close(); server = undefined;
      server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false });
    },
  };
}
async function register(browser: Browser, handle: string): Promise<Json> {
  ok(await browser.request("/api/auth/register", { method: "POST", body: { handle, displayName: handle, password } }), 201);
  return ok(await browser.request("/api/session")).user;
}
async function create(browser: Browser, name = "工程知识库", description = "团队共同维护", requestId = randomUUID()) {
  return ok(await browser.request("/api/knowledge-bases", { method: "POST", body: { requestId, name, description } }), 201);
}
async function spaces(browser: Browser): Promise<Json[]> { return ok(await browser.request("/api/spaces")); }
async function summary(browser: Browser, spaceId: string) {
  const found = (await spaces(browser)).find((space) => space.spaceId === spaceId);
  assert.ok(found, `Missing space ${spaceId}`);
  return found;
}
async function pages(browser: Browser, scope: string): Promise<Json[]> { return ok(await browser.request(`/api/records/${scope}/pages`)); }
async function makeToken(browser: Browser, access: "read" | "write" = "write") {
  return ok(await browser.request("/api/tokens", { method: "POST", body: { name: `UC-13 ${access}`, access } }), 201).token as string;
}
async function agentPage(browser: Browser, token: string, scope: string, title: string, extra: Json = {}) {
  return ok(await browser.request("/api/v1/pages", { method: "POST", token, body: { scope, title, text: `正文 ${title}`, ...extra } }), 201);
}
async function invite(owner: Browser, member: Browser, spaceId: string, handle: string, role = "editor") {
  ok(await owner.request(`/api/spaces/${spaceId}/invitations`, { method: "POST", body: { handle, role } }));
  const invitation = ok(await member.request("/api/invitations")).find((item: Json) => item.spaceId === spaceId);
  assert.ok(invitation);
  return invitation;
}
async function joinMember(owner: Browser, member: Browser, spaceId: string, handle: string, role = "editor") {
  const invitation = await invite(owner, member, spaceId, handle, role);
  ok(await member.request(`/api/invitations/${invitation.id}`, { method: "POST", body: { accept: true } }));
  return invitation;
}

// Keep these three minimal scenarios first. They establish the initial red bar.
test("UC-13 minimum: create one knowledge base, owner, and unique scoped home", async (t) => {
  const f = await fixture(t); const owner = f.browser(); const user = await register(owner, "owner");
  const kb = await create(owner);
  assert.equal(kb.name, "工程知识库"); assert.equal(kb.role, "owner");
  assert.equal(kb.canInvite, true); assert.equal(kb.canLeave, false);
  const metadata = kb.knowledgeBase;
  assert.ok(metadata.homePageId); assert.equal(metadata.description, "团队共同维护");
  assert.equal(metadata.archived, false); assert.ok(metadata.sort);
  assert.equal(Number.isInteger(metadata.revision), true);
  assert.equal(new Date(metadata.createdAt).toISOString(), metadata.createdAt);
  const rows = await pages(owner, kb.spaceId);
  assert.equal(rows.length, 1); assert.equal(rows[0].id, metadata.homePageId);
  assert.equal(rows[0].value.parent_id ?? null, null);
  assert.equal(rows[0].value.share_space_id, kb.spaceId);
  assert.equal(rows[0].value.created_by, user.id);
  assert.deepEqual(await summary(owner, kb.spaceId), kb);
  assert.equal((await pages(owner, "personal")).some((row) => row.id === metadata.homePageId), false);
});

test("UC-13 minimum: pending invitations grant no content or metadata access, including site admins", async (t) => {
  const f = await fixture(t); const siteAdmin = f.browser(); const owner = f.browser(); const pending = f.browser();
  assert.equal((await register(siteAdmin, "site_admin")).siteRole, "admin");
  await register(owner, "owner"); await register(pending, "pending");
  const kb = await create(owner); const invitation = await invite(owner, pending, kb.spaceId, "pending", "viewer");
  for (const outsider of [siteAdmin, pending, f.browser()]) {
    denied(await outsider.request(`/api/records/${kb.spaceId}/pages`));
    denied(await outsider.request(`/api/collaboration/${kb.spaceId}/${kb.knowledgeBase.homePageId}`));
    denied(await outsider.request(`/api/spaces/${kb.spaceId}/roster`));
  }
  assert.equal((await spaces(siteAdmin)).some((item) => item.spaceId === kb.spaceId), false);
  assert.equal((await spaces(pending)).some((item) => item.spaceId === kb.spaceId), false);
  ok(await pending.request(`/api/invitations/${invitation.id}`, { method: "POST", body: { accept: true } }));
  assert.equal((await summary(pending, kb.spaceId)).role, "viewer");
  assert.equal((await pages(pending, kb.spaceId))[0].id, kb.knowledgeBase.homePageId);
});

test("UC-13 minimum: one account keeps independent personal, owner, editor, and viewer permissions", async (t) => {
  const f = await fixture(t); const alice = f.browser(); const bob = f.browser();
  await register(alice, "alice"); await register(bob, "bob");
  const own = await create(alice, "Alice owned"); const editable = await create(bob, "Editor library"); const readable = await create(bob, "Viewer library");
  await joinMember(bob, alice, editable.spaceId, "alice", "editor");
  await joinMember(bob, alice, readable.spaceId, "alice", "viewer");
  const bearer = await makeToken(alice);
  const roles = new Map((await spaces(alice)).map((space) => [space.spaceId, space.role]));
  assert.equal(roles.get(own.spaceId), "owner"); assert.equal(roles.get(editable.spaceId), "editor"); assert.equal(roles.get(readable.spaceId), "viewer");
  const privatePage = await agentPage(alice, bearer, "personal", "Private");
  const ownerPage = await agentPage(alice, bearer, own.spaceId, "Owned");
  const editorPage = await agentPage(alice, bearer, editable.spaceId, "Editable");
  assert.equal(ownerPage.page.parent_id, own.knowledgeBase.homePageId);
  assert.equal(editorPage.page.parent_id, editable.knowledgeBase.homePageId);
  denied(await alice.request("/api/v1/pages", { method: "POST", token: bearer, body: { scope: readable.spaceId, title: "Forbidden" } }));
  assert.equal((await pages(alice, readable.spaceId)).length, 1);
  const afterViewer = await agentPage(alice, bearer, "personal", "Still private and writable");
  assert.ok((await pages(alice, "personal")).some((row) => row.id === afterViewer.id));
  denied(await bob.request(`/api/v1/pages/${privatePage.id}`, { token: await makeToken(bob) }));
  assert.equal((await create(alice, "Created after reading")).role, "owner");
});

function rejected(reply: Reply): void {
  assert.ok([400, 403, 409].includes(reply.status), `Expected mutation refusal, got ${reply.status}: ${JSON.stringify(reply.body)}`);
  assert.equal(typeof reply.body.error, "string");
}
async function patchLibrary(browser: Browser, kb: Json, patch: Json, requestId = randomUUID()) {
  return browser.request(`/api/knowledge-bases/${kb.spaceId}`, {
    method: "PATCH", body: { requestId, revision: kb.knowledgeBase.revision, ...patch },
  });
}
async function archive(browser: Browser, kb: Json, archived = true, requestId = randomUUID()) {
  return browser.request(`/api/knowledge-bases/${kb.spaceId}/archive`, {
    method: "POST", body: { requestId, revision: kb.knowledgeBase.revision, archived },
  });
}
async function transfer(browser: Browser, kb: Json, userId: string, requestId = randomUUID()) {
  return browser.request(`/api/knowledge-bases/${kb.spaceId}/transfer`, {
    method: "POST", body: { requestId, revision: kb.knowledgeBase.revision, userId },
  });
}
async function pageRecord(browser: Browser, scope: string, id: string) {
  const row = (await pages(browser, scope)).find((item) => item.id === id);
  assert.ok(row, `Missing page ${id}`); return row.value;
}
async function changePage(browser: Browser, scope: string, id: string, patch: Json) {
  const base = await pageRecord(browser, scope, id);
  return browser.structure(`/api/records/${scope}/pages/${id}`, { method: "POST", body: { action: "patch", base, patch } });
}
const filePath = (scope: string, path = "files/knowledge.txt") => `/api/files/${scope}?path=${encodeURIComponent(path)}`;
const readAgent = (browser: Browser, token: string, id: string) => browser.request(`/api/v1/pages/${id}`, { token });

// AC-01/E9: operation results are durable and account scoped.
test("UC-13: create validation is atomic and successful request IDs replay across restart", async (t) => {
  const f = await fixture(t); const owner = f.browser(); const other = f.browser();
  await register(owner, "owner"); await register(other, "other");
  for (const body of [{ requestId: randomUUID(), name: "   " }, { name: "Missing request ID" }, { requestId: "not-a-uuid", name: "Invalid ID" }]) {
    ok(await owner.request("/api/knowledge-bases", { method: "POST", body }), 400);
  }
  assert.deepEqual(await spaces(owner), []);
  assert.deepEqual(await pages(owner, "personal"), []);
  const requestId = randomUUID(); const body = { requestId, name: "Durable", description: "One home" };
  const responses = await Promise.all([owner.request("/api/knowledge-bases", { method: "POST", body }), owner.request("/api/knowledge-bases", { method: "POST", body })]);
  const first = ok(responses[0], 201); assert.deepEqual(ok(responses[1], 201), first);
  assert.equal((await spaces(owner)).length, 1); assert.equal((await pages(owner, first.spaceId)).length, 1);
  assert.deepEqual(ok(await owner.request(`/api/knowledge-bases/operations/${requestId}`)), { status: "committed", result: first });
  ok(await other.request(`/api/knowledge-bases/operations/${requestId}`), 404);
  ok(await owner.request(`/api/knowledge-bases/operations/${randomUUID()}`), 404);
  await f.restart();
  assert.deepEqual(ok(await owner.request("/api/knowledge-bases", { method: "POST", body }), 201), first);
  assert.deepEqual(ok(await owner.request(`/api/knowledge-bases/operations/${requestId}`)), { status: "committed", result: first });
  ok(await owner.request("/api/knowledge-bases", { method: "POST", body: { ...body, description: "Changed payload" } }), 409);
  // Another account can use the same identifier without seeing the first result.
  const second = await create(other, body.name, body.description, requestId);
  assert.notEqual(second.spaceId, first.spaceId);
  const ordinary = ok(await owner.request("/api/spaces", { method: "POST", body: { name: "Ordinary share" } }), 201);
  assert.equal(Object.hasOwn(await summary(owner, ordinary.spaceId), "knowledgeBase"), false);
});

test("UC-13: metadata follows per-library roles, shared sort, and revision conflicts", async (t) => {
  const f = await fixture(t); const owner = f.browser(); const admin = f.browser(); const editor = f.browser(); const viewer = f.browser();
  await register(owner, "owner"); await register(admin, "admin"); await register(editor, "editor"); await register(viewer, "viewer");
  let kb = await create(owner);
  await joinMember(owner, admin, kb.spaceId, "admin", "admin");
  await joinMember(owner, editor, kb.spaceId, "editor"); await joinMember(owner, viewer, kb.spaceId, "viewer", "viewer");
  denied(await patchLibrary(viewer, kb, { name: "Stolen name" }));
  denied(await patchLibrary(viewer, kb, { sort: "name-desc" }));
  denied(await patchLibrary(editor, kb, { name: "Editor rename" }));
  denied(await patchLibrary(editor, kb, { description: "Editor description" }));
  kb = ok(await patchLibrary(admin, kb, { name: "Renamed", description: "Shared description" }));
  assert.equal(kb.name, "Renamed"); assert.equal(kb.knowledgeBase.description, "Shared description");
  const previous = kb; const requestId = randomUUID();
  kb = ok(await patchLibrary(editor, kb, { sort: "name-desc" }, requestId));
  assert.equal(kb.knowledgeBase.sort, "name-desc");
  assert.ok(kb.knowledgeBase.revision > previous.knowledgeBase.revision);
  for (const member of [owner, admin, editor, viewer]) assert.equal((await summary(member, kb.spaceId)).knowledgeBase.sort, "name-desc");
  assert.deepEqual(ok(await patchLibrary(editor, previous, { sort: "name-desc" }, requestId)), kb);
  ok(await patchLibrary(editor, previous, { sort: "created" }, requestId), 409);
  ok(await patchLibrary(owner, previous, { name: "Stale rename" }), 409);
  ok(await patchLibrary(owner, kb, { sort: "unsupported-sort" }), 400);
  assert.equal((await summary(owner, kb.spaceId)).name, "Renamed");
});

test("UC-13: invitation decline, expiry, revocation, and peer-admin boundaries never grant membership", async (t) => {
  const f = await fixture(t); const owner = f.browser(); const admin = f.browser(); const peer = f.browser(); const pending = f.browser();
  const ownerUser = await register(owner, "owner"); const adminUser = await register(admin, "admin");
  await register(peer, "peer"); await register(pending, "pending"); const kb = await create(owner);
  await joinMember(owner, admin, kb.spaceId, "admin", "admin");
  const adminInvite = await invite(owner, peer, kb.spaceId, "peer", "admin");
  denied(await admin.request(`/api/spaces/${kb.spaceId}/invitations/${adminInvite.id}`, { method: "DELETE" }));
  denied(await admin.request(`/api/spaces/${kb.spaceId}/members/${ownerUser.id}`, { method: "PATCH", body: { role: "viewer" } }));
  denied(await admin.request(`/api/spaces/${kb.spaceId}/members/${adminUser.id}`, { method: "DELETE" }));
  denied(await admin.request(`/api/spaces/${kb.spaceId}/invitations`, { method: "POST", body: { handle: "pending", role: "admin" } }));
  assert.deepEqual(ok(await owner.request(`/api/spaces/${kb.spaceId}/invitations/${adminInvite.id}`, { method: "DELETE" })), { ok: true });
  ok(await peer.request(`/api/invitations/${adminInvite.id}`, { method: "POST", body: { accept: true } }), 409);
  const declined = await invite(admin, pending, kb.spaceId, "pending");
  ok(await pending.request(`/api/invitations/${declined.id}`, { method: "POST", body: { accept: false } }));
  ok(await pending.request(`/api/invitations/${declined.id}`, { method: "POST", body: { accept: true } }), 409);
  const revoked = await invite(admin, pending, kb.spaceId, "pending", "viewer");
  ok(await admin.request(`/api/spaces/${kb.spaceId}/invitations`, { method: "POST", body: { handle: "pending", role: "viewer" } }));
  assert.equal(ok(await pending.request("/api/invitations")).filter((item: Json) => item.spaceId === kb.spaceId).length, 1);
  ok(await admin.request(`/api/spaces/${kb.spaceId}/invitations/${revoked.id}`, { method: "DELETE" }));
  ok(await pending.request(`/api/invitations/${revoked.id}`, { method: "POST", body: { accept: true } }), 409);
  const expires = await invite(owner, pending, kb.spaceId, "pending");
  assert.ok(Math.abs(Date.parse(expires.expiresAt) - Date.now() - 7 * 86400000) < 10000);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 8 * 86400000 });
  ok(await pending.request(`/api/invitations/${expires.id}`, { method: "POST", body: { accept: true } }), 409);
  denied(await pending.request(`/api/records/${kb.spaceId}/pages`));
  assert.equal((await spaces(pending)).length, 0);
});

test("UC-13: home is immutable as root and illegal tree changes roll back the whole batch", async (t) => {
  const f = await fixture(t); const owner = f.browser(); const user = await register(owner, "owner"); const bearer = await makeToken(owner);
  const kb = await create(owner); const other = await create(owner, "Other library");
  const home = kb.knowledgeBase.homePageId;
  const first = await agentPage(owner, bearer, kb.spaceId, "First");
  const child = await agentPage(owner, bearer, kb.spaceId, "Child", { parentId: first.id });
  for (const item of [first, child]) ok(await owner.request(`/api/v1/pages/${item.id}/checkpoint`, { method: "POST", token: bearer }));
  const before = await pages(owner, kb.spaceId);
  for (const patch of [{ archived: true }, { parent_id: first.id }, { share_space_id: null }, { share_space_id: other.spaceId }]) {
    rejected(await changePage(owner, kb.spaceId, home, patch));
  }
  rejected(await owner.structure(`/api/records/${kb.spaceId}/pages/${home}`, { method: "POST", body: { action: "delete", base: await pageRecord(owner, kb.spaceId, home) } }));
  for (const patch of [{ parent_id: null }, { parent_id: other.knowledgeBase.homePageId }, { parent_id: child.id }, { share_space_id: other.spaceId }]) {
    rejected(await changePage(owner, kb.spaceId, first.id, patch));
  }
  const rootId = randomUUID(); const now = new Date().toISOString();
  rejected(await owner.structure(`/api/records/${kb.spaceId}/pages/${rootId}`, {
    method: "POST", body: { action: "put", base: null, value: { id: rootId, title_content: [{ text: "Illegal second root" }], icon: "", kind: "document", created_at: now, updated_at: now, created_by: user.id, updated_by: user.id } },
  }));
  const page = await pageRecord(owner, kb.spaceId, first.id);
  // The unrelated personal write must not survive a failed team migration.
  rejected(await owner.structure("/api/records/batch", { method: "POST", body: { requestId: randomUUID(), writes: [
    { scope: "personal", collection: "pages", id: "must_rollback", action: "put", base: null, value: { ...page, id: "must_rollback", parent_id: null } },
    { scope: kb.spaceId, collection: "pages", id: first.id, action: "patch", base: page, patch: { parent_id: null } },
  ] } }));
  assert.equal((await pages(owner, "personal")).some((row) => row.id === "must_rollback"), false);
  // Move the whole non-home subtree. Both final trees are structurally valid.
  // Include blocks and history so an orphan cannot be the refusal reason.
  const subtree = new Set([first.id, child.id]);
  for (const destination of ["personal", other.spaceId]) {
    const writes: Json[] = []; const originals = new Map<string, Json[]>(); const targets = new Map<string, Json[]>();
    for (const collection of ["pages", "blocks", "versions"]) {
      const sourceRows: Json[] = ok(await owner.request(`/api/records/${kb.spaceId}/${collection}`));
      const destinationRows: Json[] = ok(await owner.request(`/api/records/${destination}/${collection}`));
      originals.set(collection, sourceRows); targets.set(collection, destinationRows);
      const selected = sourceRows.filter((row) => subtree.has(collection === "pages" ? row.id : row.value.page));
      assert.ok(selected.length >= 2, `The migration must include both pages' ${collection}`);
      for (const row of selected) {
        const value = { ...row.value };
        if (collection === "pages") {
          delete value.share_space_id;
          if (row.id === first.id) {
            if (destination === "personal") delete value.parent_id;
            else value.parent_id = other.knowledgeBase.homePageId;
          }
        }
        writes.push({ scope: destination, collection, id: row.id, action: "put", base: null, value });
        writes.push({ scope: kb.spaceId, collection, id: row.id, action: "delete", base: row.value });
      }
    }
    rejected(await owner.structure("/api/records/batch", { method: "POST", body: { requestId: randomUUID(), writes } }));
    for (const collection of ["pages", "blocks", "versions"]) {
      assert.deepEqual(ok(await owner.request(`/api/records/${kb.spaceId}/${collection}`)), originals.get(collection));
      assert.deepEqual(ok(await owner.request(`/api/records/${destination}/${collection}`)), targets.get(collection));
    }
  }
  assert.deepEqual(await pages(owner, kb.spaceId), before);
  assert.equal((await pages(owner, other.spaceId)).length, 1);
});

test("UC-13: editors can trash and restore ordinary pages but only owner/admin can permanently delete", async (t) => {
  const f = await fixture(t); const owner = f.browser(); const editor = f.browser(); const admin = f.browser();
  await register(owner, "owner"); await register(editor, "editor"); await register(admin, "admin"); const kb = await create(owner);
  await joinMember(owner, editor, kb.spaceId, "editor"); await joinMember(owner, admin, kb.spaceId, "admin", "admin");
  const bearer = await makeToken(editor); const parent = await agentPage(editor, bearer, kb.spaceId, "Parent");
  const child = await agentPage(editor, bearer, kb.spaceId, "Child", { parentId: parent.id });
  ok(await changePage(editor, kb.spaceId, parent.id, { archived: true }));
  ok(await changePage(editor, kb.spaceId, parent.id, { archived: false }));
  assert.equal((await pageRecord(editor, kb.spaceId, child.id)).parent_id, parent.id);
  for (const manager of [admin, owner]) {
    const removable = await agentPage(editor, bearer, kb.spaceId, "Removable leaf");
    ok(await editor.request(`/api/v1/pages/${removable.id}/checkpoint`, { method: "POST", token: bearer }));
    ok(await changePage(editor, kb.spaceId, removable.id, { archived: true }));
    const originals = new Map<string, Json[]>(); const writes: Json[] = [];
    for (const collection of ["pages", "blocks", "versions"]) {
      const rows: Json[] = ok(await editor.request(`/api/records/${kb.spaceId}/${collection}`));
      originals.set(collection, rows);
      const selected = rows.filter((row) => collection === "pages" ? row.id === removable.id : row.value.page === removable.id);
      assert.ok(selected.length > 0, `The deletion must exercise existing ${collection}`);
      for (const row of selected) writes.push({ scope: kb.spaceId, collection, id: row.id, action: "delete", base: row.value });
    }
    // Both roles submit the same valid explicit leaf transaction.
    const deletion = { requestId: randomUUID(), writes };
    denied(await editor.structure("/api/records/batch", { method: "POST", body: deletion }));
    for (const collection of ["pages", "blocks", "versions"]) {
      assert.deepEqual(ok(await editor.request(`/api/records/${kb.spaceId}/${collection}`)), originals.get(collection));
    }
    ok(await manager.structure("/api/records/batch", { method: "POST", body: deletion }));
    for (const collection of ["pages", "blocks", "versions"]) {
      const rows: Json[] = ok(await owner.request(`/api/records/${kb.spaceId}/${collection}`));
      assert.equal(rows.some((row) => collection === "pages" ? row.id === removable.id : row.value.page === removable.id), false, `Deleted leaf must leave no ${collection}`);
    }
  }
});

test("UC-13: Agent tokens intersect account roles and cannot manage libraries or members", async (t) => {
  const f = await fixture(t); const owner = f.browser(); const member = f.browser(); const stranger = f.browser();
  await register(owner, "owner"); const memberUser = await register(member, "member"); await register(stranger, "stranger");
  const creationId = randomUUID(); const kb = await create(owner, "Token library", "Token boundary", creationId);
  await joinMember(owner, member, kb.spaceId, "member");
  const ownerToken = await makeToken(owner); const writer = await makeToken(member); const reader = await makeToken(member, "read");
  const created = await agentPage(member, writer, kb.spaceId, "Member contribution");
  ok(await member.request(`/api/v1/pages/${created.id}/checkpoint`, { method: "POST", token: writer }));
  const versions = ok(await member.request(`/api/v1/pages/${created.id}/versions`, { token: reader })); assert.ok(versions.length);
  ok(await owner.request(filePath("personal"), { method: "PUT", raw: "Private bytes with same path", contentType: "text/plain" }));
  ok(await owner.request(filePath("personal", "files/personal-only.txt"), { method: "PUT", raw: "Never fall back to private storage", contentType: "text/plain" }));
  ok(await owner.request(filePath(kb.spaceId), { method: "PUT", raw: "Team attachment", contentType: "text/plain" }));
  ok(await owner.request(filePath(kb.spaceId, "files/personal-only.txt")), 404);
  assert.equal(ok(await readAgent(member, reader, created.id)).text, "正文 Member contribution");
  denied(await member.request(`/api/v1/pages/${created.id}`, { method: "PATCH", token: reader, body: { text: "Reader write", baseRevision: created.revision } }));
  const management: Array<[string, string, Json]> = [
    ["POST", "/api/knowledge-bases", { requestId: randomUUID(), name: "Token library" }],
    ["PATCH", `/api/knowledge-bases/${kb.spaceId}`, { requestId: randomUUID(), revision: kb.knowledgeBase.revision, name: "Token rename" }],
    ["POST", `/api/knowledge-bases/${kb.spaceId}/archive`, { requestId: randomUUID(), revision: kb.knowledgeBase.revision, archived: true }],
    ["POST", `/api/knowledge-bases/${kb.spaceId}/transfer`, { requestId: randomUUID(), revision: kb.knowledgeBase.revision, userId: memberUser.id }],
    ["POST", `/api/spaces/${kb.spaceId}/invitations`, { handle: "stranger", role: "editor" }],
    ["PATCH", `/api/spaces/${kb.spaceId}/members/${memberUser.id}`, { role: "admin" }],
  ];
  // Even a token owned by the library owner has no management capability.
  for (const [method, path, body] of management) denied(await f.browser().request(path, { method, token: ownerToken, body }));
  denied(await f.browser().request(`/api/spaces/${kb.spaceId}/members/${memberUser.id}`, { method: "DELETE", token: ownerToken }));
  denied(await f.browser().request(`/api/spaces/${kb.spaceId}/leave`, { method: "POST", token: writer }));
  denied(await f.browser().request(`/api/knowledge-bases/operations/${creationId}`, { token: ownerToken }));
  const pending = await invite(owner, stranger, kb.spaceId, "stranger");
  denied(await f.browser().request(`/api/spaces/${kb.spaceId}/invitations/${pending.id}`, { method: "DELETE", token: ownerToken }));
  ok(await owner.request(`/api/spaces/${kb.spaceId}/members/${memberUser.id}`, { method: "PATCH", body: { role: "viewer" } }));
  assert.equal(ok(await readAgent(member, writer, created.id)).title, "Member contribution");
  assert.equal(ok(await member.request(`/api/collaboration/${kb.spaceId}/${created.id}`)).canEdit, false);
  denied(await member.request(`/api/v1/pages/${created.id}`, { method: "PATCH", token: writer, body: { text: "Downgraded write", baseRevision: created.revision } }));
  denied(await member.request(`/api/v1/pages/${created.id}/restore`, { method: "POST", token: writer, body: { versionId: versions[0].id } }));
  denied(await member.request(filePath(kb.spaceId, "files/forbidden.txt"), { method: "PUT", raw: "forbidden" }));
  ok(await owner.request(`/api/spaces/${kb.spaceId}/members/${memberUser.id}`, { method: "DELETE" }));
  for (const path of [
    `/api/records/${kb.spaceId}/pages`, `/api/records/${kb.spaceId}/blocks`, `/api/records/${kb.spaceId}/versions`,
    `/api/collaboration/${kb.spaceId}/${created.id}`, `/api/spaces/${kb.spaceId}/roster`, `/api/spaces/${kb.spaceId}/presence`,
  ]) denied(await member.request(path));
  denied(await member.request(filePath(kb.spaceId), { rawResponse: true }));
  for (const path of [`/api/v1/pages/${created.id}`, `/api/v1/pages/${created.id}/versions`]) denied(await member.request(path, { token: writer }));
  denied(await member.request(`/api/v1/pages/${created.id}`, { method: "PATCH", token: writer, body: { text: "Removed write", baseRevision: created.revision } }));
  denied(await stranger.request(filePath(kb.spaceId), { rawResponse: true }));
  assert.equal(ok(await readAgent(owner, ownerToken, created.id)).text, "正文 Member contribution");
  assert.equal(ok(await owner.request(filePath(kb.spaceId), { rawResponse: true })), "Team attachment");
  assert.equal((await spaces(member)).length, 0);
});

test("UC-13: library archive freezes all content, invalidates invitations, and permits removal/transfer", async (t) => {
  const f = await fixture(t); const owner = f.browser(); const admin = f.browser(); const editor = f.browser(); const pending = f.browser();
  const ownerUser = await register(owner, "owner"); const adminUser = await register(admin, "admin"); const editorUser = await register(editor, "editor"); await register(pending, "pending");
  let kb = await create(owner); await joinMember(owner, admin, kb.spaceId, "admin", "admin"); await joinMember(owner, editor, kb.spaceId, "editor");
  const invitation = await invite(owner, pending, kb.spaceId, "pending"); const bearer = await makeToken(owner);
  const created = await agentPage(owner, bearer, kb.spaceId, "Saved before archive");
  const trashed = await agentPage(owner, bearer, kb.spaceId, "Trash before archive");
  ok(await changePage(owner, kb.spaceId, trashed.id, { archived: true }));
  ok(await owner.request(`/api/v1/pages/${created.id}/checkpoint`, { method: "POST", token: bearer }));
  const versions = ok(await owner.request(`/api/v1/pages/${created.id}/versions`, { token: bearer }));
  ok(await owner.request(filePath(kb.spaceId), { method: "PUT", raw: "saved bytes", contentType: "text/plain" }));
  denied(await archive(admin, kb)); denied(await archive(editor, kb));
  const requestId = randomUUID(); const before = kb;
  kb = ok(await archive(owner, kb, true, requestId)); assert.equal(kb.knowledgeBase.archived, true);
  assert.deepEqual(ok(await archive(owner, before, true, requestId)), kb);
  ok(await archive(owner, before, false, requestId), 409);
  assert.equal(ok(await owner.request(filePath(kb.spaceId), { rawResponse: true })), "saved bytes");
  assert.equal(ok(await readAgent(owner, bearer, created.id)).title, "Saved before archive");
  assert.equal(ok(await editor.request(`/api/collaboration/${kb.spaceId}/${created.id}`)).canEdit, false);
  rejected(await owner.request("/api/v1/pages", { method: "POST", token: bearer, body: { scope: kb.spaceId, title: "After archive" } }));
  rejected(await owner.request(`/api/v1/pages/${created.id}`, { method: "PATCH", token: bearer, body: { text: "After archive", baseRevision: created.revision } }));
  rejected(await owner.request(`/api/v1/pages/${created.id}/restore`, { method: "POST", token: bearer, body: { versionId: versions[0].id } }));
  rejected(await owner.request(filePath(kb.spaceId, "files/new.txt"), { method: "PUT", raw: "after archive" }));
  rejected(await changePage(owner, kb.spaceId, created.id, { parent_id: trashed.id }));
  rejected(await changePage(owner, kb.spaceId, trashed.id, { archived: false }));
  rejected(await patchLibrary(owner, kb, { sort: "created" }));
  rejected(await owner.request(`/api/spaces/${kb.spaceId}/invitations`, { method: "POST", body: { handle: "pending", role: "editor" } }));
  assert.equal(ok(await pending.request("/api/invitations")).length, 0);
  ok(await pending.request(`/api/invitations/${invitation.id}`, { method: "POST", body: { accept: true } }), 409);
  ok(await admin.request(`/api/spaces/${kb.spaceId}/members/${editorUser.id}`, { method: "DELETE" }));
  kb = ok(await transfer(owner, await summary(owner, kb.spaceId), adminUser.id));
  assert.equal(kb.role, "admin"); assert.equal(kb.knowledgeBase.archived, true);
  assert.equal((await summary(admin, kb.spaceId)).role, "owner");
  denied(await archive(owner, kb, false));
  await f.restart();
  assert.equal((await summary(admin, kb.spaceId)).knowledgeBase.archived, true);
  assert.equal((await summary(owner, kb.spaceId)).role, "admin");
  const roster = ok(await owner.request(`/api/spaces/${kb.spaceId}/roster`));
  assert.equal(roster.members.find((member: Json) => member.id === ownerUser.id).role, "admin");
  kb = ok(await archive(admin, await summary(admin, kb.spaceId), false));
  assert.equal(kb.knowledgeBase.archived, false);
  assert.equal(ok(await pending.request("/api/invitations")).length, 0);
  ok(await pending.request(`/api/invitations/${invitation.id}`, { method: "POST", body: { accept: true } }), 409);
  assert.equal(ok(await owner.request(`/api/collaboration/${kb.spaceId}/${created.id}`)).canEdit, true);
  const durable = ok(await readAgent(owner, bearer, created.id));
  assert.equal(ok(await owner.request(`/api/v1/pages/${created.id}`, { method: "PATCH", token: bearer, body: { text: "Writable after restore", baseRevision: durable.revision } })).text, "Writable after restore");
});

test("UC-13: ownership transfer is atomic, unique, replayable, and preserves content after former owner leaves", async (t) => {
  const f = await fixture(t); const owner = f.browser(); const successor = f.browser(); const outsider = f.browser();
  const ownerUser = await register(owner, "owner"); const successorUser = await register(successor, "successor"); const outsiderUser = await register(outsider, "outsider");
  let kb = await create(owner); const bearer = await makeToken(owner); const contribution = await agentPage(owner, bearer, kb.spaceId, "Stable content");
  const before = await pages(owner, kb.spaceId);
  rejected(await transfer(owner, kb, outsiderUser.id));
  assert.equal((await summary(owner, kb.spaceId)).role, "owner");
  assert.equal((await spaces(outsider)).length, 0);
  denied(await owner.request(`/api/spaces/${kb.spaceId}/leave`, { method: "POST" }));
  await joinMember(owner, successor, kb.spaceId, "successor");
  denied(await transfer(successor, kb, ownerUser.id));
  // A member that left is no longer an eligible successor.
  ok(await successor.request(`/api/spaces/${kb.spaceId}/leave`, { method: "POST" }));
  rejected(await transfer(owner, kb, successorUser.id));
  assert.equal((await summary(owner, kb.spaceId)).role, "owner");
  await joinMember(owner, successor, kb.spaceId, "successor");
  kb = await summary(owner, kb.spaceId); const requestId = randomUUID(); const basis = kb;
  kb = ok(await transfer(owner, kb, successorUser.id, requestId));
  assert.equal(kb.role, "admin"); assert.equal(kb.knowledgeBase.homePageId, basis.knowledgeBase.homePageId);
  assert.deepEqual(ok(await transfer(owner, basis, successorUser.id, requestId)), kb);
  ok(await transfer(owner, basis, outsiderUser.id, requestId), 409);
  const roster = ok(await successor.request(`/api/spaces/${kb.spaceId}/roster`)).members;
  assert.equal(roster.filter((member: Json) => member.role === "owner").length, 1);
  assert.equal(roster.find((member: Json) => member.id === successorUser.id).role, "owner");
  assert.equal(roster.find((member: Json) => member.id === ownerUser.id).role, "admin");
  assert.deepEqual(await pages(successor, kb.spaceId), before);
  ok(await owner.request(`/api/spaces/${kb.spaceId}/leave`, { method: "POST" }));
  denied(await readAgent(owner, bearer, contribution.id));
  assert.equal((await pages(successor, kb.spaceId)).some((row) => row.id === contribution.id), true);
  assert.equal((await pageRecord(successor, kb.spaceId, contribution.id)).created_by, ownerUser.id);
  await f.restart();
  assert.equal((await summary(successor, kb.spaceId)).role, "owner");
  assert.equal((await summary(successor, kb.spaceId)).knowledgeBase.homePageId, basis.knowledgeBase.homePageId);
});

test("UC-13: public publishing and stop-sharing reject team pages while ordinary sharing still works", async (t) => {
  const f = await fixture(t); const owner = f.browser(); const guest = f.browser(); await register(owner, "owner");
  const kb = await create(owner); const bearer = await makeToken(owner); const child = await agentPage(owner, bearer, kb.spaceId, "Team child");
  const before = await pages(owner, kb.spaceId);
  for (const pageId of [kb.knowledgeBase.homePageId, child.id]) {
    rejected(await owner.request("/api/shares", { method: "POST", body: { pageId } }));
    assert.equal(ok(await owner.request(`/api/shares?pageId=${pageId}`)).length, 0);
  }
  // Use the existing stop-sharing gesture, including every persisted collection.
  const stopWrites: Json[] = [];
  for (const collection of ["pages", "blocks", "versions"]) {
    for (const row of ok(await owner.request(`/api/records/${kb.spaceId}/${collection}`))) {
      const value = { ...row.value }; if (collection === "pages" && row.id === kb.knowledgeBase.homePageId) delete value.share_space_id;
      stopWrites.push({ scope: "personal", collection, id: row.id, action: "put", base: null, value });
      stopWrites.push({ scope: kb.spaceId, collection, id: row.id, action: "delete", base: row.value });
    }
  }
  rejected(await owner.structure("/api/records/batch", { method: "POST", body: { requestId: randomUUID(), writes: stopWrites } }));
  assert.deepEqual(await pages(owner, kb.spaceId), before);
  assert.equal((await pages(owner, "personal")).some((row) => before.some((item) => item.id === row.id)), false);
  const ordinary = ok(await owner.request("/api/spaces", { method: "POST", body: { name: "Ordinary" } }), 201);
  const ordinaryPage = ok(await owner.request("/api/v1/pages", { method: "POST", token: bearer, body: { spaceId: ordinary.spaceId, title: "Ordinary public", text: "Ordinary body" } }), 201);
  const link = ok(await owner.request("/api/shares", { method: "POST", body: { pageId: ordinaryPage.id } }), 201);
  const publicToken = new URL(link.url, f.url()).pathname.split("/").at(-1);
  ok(await guest.request(`/api/public/${publicToken}`));
  ok(await owner.request(`/api/shares/${link.id}`, { method: "DELETE" }));
  denied(await guest.request(`/api/public/${publicToken}`));
  const writes: Json[] = [];
  for (const collection of ["pages", "blocks", "versions"]) for (const row of ok(await owner.request(`/api/records/${ordinary.spaceId}/${collection}`))) {
    const value = { ...row.value }; if (collection === "pages") delete value.share_space_id;
    writes.push({ scope: "personal", collection, id: row.id, action: "put", base: null, value });
    writes.push({ scope: ordinary.spaceId, collection, id: row.id, action: "delete", base: row.value });
  }
  ok(await owner.structure("/api/records/batch", { method: "POST", body: { requestId: randomUUID(), writes } }));
  assert.ok((await pages(owner, "personal")).some((row) => row.id === ordinaryPage.id));
  assert.deepEqual(await pages(owner, kb.spaceId), before);
});

// AC-04/06/10: database and history keep the same knowledge-base boundary.
test("UC-13: database rows and restored versions stay under home and lose access with membership", async (t) => {
  const f = await fixture(t); const owner = f.browser(); const editor = f.browser();
  await register(owner, "owner"); const user = await register(editor, "editor");
  const kb = await create(owner); await joinMember(owner, editor, kb.spaceId, "editor");
  const token = await makeToken(editor); const ownerToken = await makeToken(owner);
  const parent = await agentPage(editor, token, kb.spaceId, "Topic");
  const database = ok(await editor.request("/api/v1/databases", { method: "POST", token, body: { requestId: randomUUID(), title: "Library table", parentId: parent.id } }), 201);
  const row = ok(await editor.request(`/api/v1/databases/${database.id}/rows`, { method: "POST", token, body: { requestId: randomUUID(), baseRevision: database.revision, title: "Team row", text: "Table body" } }), 201);
  assert.equal(row.page.parent_id, database.id);
  assert.ok((await pages(owner, kb.spaceId)).some((item) => item.id === row.id));
  ok(await editor.request(`/api/v1/pages/${parent.id}/checkpoint`, { method: "POST", token }));
  const versions = ok(await editor.request(`/api/v1/pages/${parent.id}/versions`, { token }));
  ok(await editor.request(`/api/v1/pages/${parent.id}`, { method: "PATCH", token, body: { text: "Changed text", baseRevision: parent.revision } }));
  ok(await editor.request(`/api/v1/pages/${parent.id}/restore`, { method: "POST", token, body: { versionId: versions.at(-1).id } }));
  const restored = ok(await readAgent(editor, token, parent.id));
  assert.equal(restored.text, "正文 Topic");
  const block = Object.values(restored.page.block_tree.by_id).find((item: Json) => item.kind === "text") as Json;
  assert.ok(block);
  const operation = { requestId: randomUUID(), generation: restored.collaboration.generation, mode: "apply", operations: [{ type: "insert_text", blockId: block.id, index: "end", text: "\nAgent真实操作" }] };
  assert.match(ok(await editor.request(`/api/v1/pages/${parent.id}/operations`, { method: "POST", token, body: operation })).text, /Agent真实操作/);
  assert.equal((await pageRecord(editor, kb.spaceId, parent.id)).parent_id, kb.knowledgeBase.homePageId);
  assert.ok(ok(await editor.request(`/api/v1/pages/${parent.id}/versions`, { token })).length > versions.length, "Restore must keep a pre-restore checkpoint");
  ok(await owner.request(`/api/spaces/${kb.spaceId}/members/${user.id}`, { method: "PATCH", body: { role: "viewer" } }));
  const current = ok(await editor.request(`/api/v1/databases/${database.id}`, { token }));
  denied(await editor.request(`/api/v1/pages/${parent.id}/operations`, { method: "POST", token, body: { ...operation, requestId: randomUUID() } }));
  denied(await editor.request(`/api/v1/databases/${database.id}/rows`, { method: "POST", token, body: { requestId: randomUUID(), baseRevision: current.revision, title: "Downgraded row" } }));
  ok(await owner.request(`/api/spaces/${kb.spaceId}/members/${user.id}`, { method: "DELETE" }));
  denied(await editor.request(`/api/v1/databases/${database.id}`, { token }));
  denied(await editor.request(`/api/v1/databases/${database.id}/query`, { method: "POST", token, body: {} }));
  assert.equal(ok(await owner.request(`/api/v1/databases/${database.id}/query`, { method: "POST", token: ownerToken, body: {} })).rows[0].id, row.id);
});

test("UC-13: restart and a complete backup preserve home, ownership, members, sort, history, and attachment bytes", async (t) => {
  const f = await fixture(t); const owner = f.browser(); const member = f.browser();
  await register(owner, "owner"); const memberUser = await register(member, "member");
  let kb = await create(owner); await joinMember(owner, member, kb.spaceId, "member");
  const token = await makeToken(member); const created = await agentPage(member, token, kb.spaceId, "Durable body");
  ok(await member.request(`/api/v1/pages/${created.id}/checkpoint`, { method: "POST", token }));
  ok(await owner.request(filePath(kb.spaceId), { method: "PUT", raw: "persistent attachment\n", contentType: "text/plain" }));
  kb = ok(await patchLibrary(owner, await summary(owner, kb.spaceId), { sort: "created-asc" }));
  kb = ok(await transfer(owner, kb, memberUser.id));
  kb = ok(await archive(member, await summary(member, kb.spaceId)));
  const records = await pages(member, kb.spaceId);
  const versions = ok(await member.request(`/api/v1/pages/${created.id}/versions`, { token }));
  await f.restart();
  assert.deepEqual(await summary(member, kb.spaceId), kb);
  assert.deepEqual(await pages(member, kb.spaceId), records);
  assert.equal(ok(await member.request(filePath(kb.spaceId), { rawResponse: true })), "persistent attachment\n");
  const backupRoot = await mkdtemp(join(tmpdir(), "notes-knowledge-bases-backup-"));
  let restored: Server | undefined;
  t.after(async () => {
    try { await restored?.close(); }
    finally {
      const target = resolve(backupRoot); assert.equal(dirname(target), resolve(tmpdir()));
      assert.ok(basename(target).startsWith("notes-knowledge-bases-backup-"));
      await rm(target, { recursive: true, force: true });
    }
  });
  const target = join(backupRoot, "complete-copy");
  execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/backup.mjs", import.meta.url)), target], { env: { ...process.env, DATA_DIR: f.directory }, stdio: "pipe" });
  restored = await startServer({ dataDir: target, port: 0, host: "127.0.0.1", serveStatic: false });
  const restoredMember = new Browser(() => restored!.url); restoredMember.cookie = member.cookie;
  assert.deepEqual(await summary(restoredMember, kb.spaceId), kb);
  assert.deepEqual(await pages(restoredMember, kb.spaceId), records);
  assert.deepEqual(ok(await restoredMember.request(`/api/v1/pages/${created.id}/versions`, { token })), versions);
  assert.equal(ok(await restoredMember.request(filePath(kb.spaceId), { rawResponse: true })), "persistent attachment\n");
});

class Feed {
  readonly socket: WebSocket;
  readonly messages: Json[] = [];
  private changed = new Set<() => void>();
  constructor(url: string, cookie: string) {
    this.socket = new WebSocket(url.replace(/^http/, "ws") + "/api/collaboration", { headers: { Origin: url, Cookie: cookie } });
    this.socket.on("message", (raw) => { this.messages.push(JSON.parse(raw.toString())); for (const callback of this.changed) callback(); });
    this.socket.on("error", () => {});
  }
  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => { this.socket.once("open", resolve); this.socket.once("error", reject); });
  }
  events(after = 0): Json[] { return this.messages.slice(after).flatMap((message) => message.type === "commit" ? message.documents : [message]); }
  async wait(predicate: (message: Json) => boolean, after = 0): Promise<Json> {
    const found = () => this.events(after).find(predicate);
    if (found()) return found();
    return new Promise((resolve, reject) => {
      const check = () => { const value = found(); if (value) { cleanup(); resolve(value); } };
      const cleanup = () => { clearTimeout(timer); this.changed.delete(check); };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`WebSocket did not send expected event: ${JSON.stringify(this.events(after))}`)); }, 3000);
      this.changed.add(check); check();
    });
  }
  subscribe(scope: string, pageId: string) { this.socket.send(JSON.stringify({ type: "subscribe", scope, pageId })); }
  async barrier() {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket ping timed out")), 3000);
      this.socket.once("pong", () => { clearTimeout(timer); resolve(); }); this.socket.ping();
    });
  }
}
async function snapshot(browser: Browser, scope: string, pageId: string) { return ok(await browser.request(`/api/collaboration/${scope}/${pageId}`)); }
function textUpdate(value: Json, key: string, text: string) {
  const doc = new Y.Doc(); Y.applyUpdate(doc, Buffer.from(value.state, "base64"));
  try {
    const field = doc.getMap<Y.Text>("fields").get(key); assert.ok(field instanceof Y.Text);
    const before = Y.encodeStateVector(doc); field.insert(0, text);
    return Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString("base64");
  } finally { doc.destroy(); }
}
function submitText(browser: Browser, base: Json, update: string) {
  return browser.request("/api/records/batch", { method: "POST", body: { requestId: randomUUID(), writes: [], textUpdates: [{ scope: base.scope, pageId: base.pageId, generation: base.generation, update }] } });
}

test("UC-13: concurrent team edits merge and removed WebSocket subscribers receive no later content", { timeout: 15000 }, async (t) => {
  const f = await fixture(t); const owner = f.browser(); const editor = f.browser(); const outsider = f.browser();
  await register(owner, "owner"); const member = await register(editor, "editor"); await register(outsider, "outsider");
  const kb = await create(owner); await joinMember(owner, editor, kb.spaceId, "editor");
  const token = await makeToken(owner); const page = await agentPage(owner, token, kb.spaceId, "Shared CRDT");
  const feeds = [new Feed(f.url(), owner.cookie), new Feed(f.url(), editor.cookie), new Feed(f.url(), outsider.cookie)];
  t.after(() => { for (const feed of feeds) feed.socket.terminate(); });
  await Promise.all(feeds.map((feed) => feed.open()));
  const [ownerFeed, memberFeed, outsiderFeed] = feeds;
  for (const feed of feeds) feed.subscribe(kb.spaceId, page.id);
  await ownerFeed.wait((message) => message.type === "document");
  await memberFeed.wait((message) => message.type === "document");
  await outsiderFeed.wait((message) => message.type === "error");
  assert.equal(outsiderFeed.events().some((message) => message.snapshot), false);
  const base = await snapshot(owner, kb.spaceId, page.id); const block = base.records.blocks[0];
  const key = `blocks/${block.id}/content`;
  const left = textUpdate(base, key, "Owner edit "); const right = textUpdate(base, key, "Member edit ");
  for (const reply of await Promise.all([submitText(owner, base, left), submitText(editor, base, right)])) ok(reply);
  const merged = ok(await readAgent(owner, token, page.id));
  assert.match(merged.text, /Owner edit /); assert.match(merged.text, /Member edit /);
  const stale = await snapshot(editor, kb.spaceId, page.id); const forbidden = textUpdate(stale, key, "Forbidden after removal ");
  const mark = memberFeed.messages.length;
  ok(await owner.request(`/api/spaces/${kb.spaceId}/members/${member.id}`, { method: "DELETE" }));
  await memberFeed.wait((message) => message.type === "revoked", mark);
  denied(await submitText(editor, stale, forbidden));
  const current = await snapshot(owner, kb.spaceId, page.id); const ownerMark = ownerFeed.messages.length;
  ok(await submitText(owner, current, textUpdate(current, key, "Secret after removal ")));
  await ownerFeed.wait((message) => message.snapshot?.pageId === page.id, ownerMark);
  await memberFeed.barrier();
  assert.equal(memberFeed.events(mark).some((message) => message.snapshot), false, "Removed subscriber must not receive content nested in commit events");
  memberFeed.subscribe(kb.spaceId, page.id);
  await memberFeed.wait((message) => message.type === "error", mark);
  assert.equal(memberFeed.events(mark).some((message) => message.snapshot), false);
});

test("UC-13: archival and viewer downgrade reject already-prepared CRDT updates", async (t) => {
  const f = await fixture(t); const owner = f.browser(); const editor = f.browser();
  await register(owner, "owner"); const user = await register(editor, "editor");
  const kb = await create(owner); await joinMember(owner, editor, kb.spaceId, "editor");
  const token = await makeToken(owner); const page = await agentPage(owner, token, kb.spaceId, "Frozen CRDT");
  const base = await snapshot(editor, kb.spaceId, page.id); const key = `blocks/${base.records.blocks[0].id}/content`;
  const update = textUpdate(base, key, "Must not be saved ");
  ok(await owner.request(`/api/spaces/${kb.spaceId}/members/${user.id}`, { method: "PATCH", body: { role: "viewer" } }));
  denied(await submitText(editor, base, update));
  ok(await archive(owner, await summary(owner, kb.spaceId)));
  rejected(await submitText(owner, base, update));
  assert.equal(ok(await readAgent(owner, token, page.id)).text, "正文 Frozen CRDT");
});
