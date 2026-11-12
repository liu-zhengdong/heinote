import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { startServer } from "../server/index.ts";

// Exercise the deployed HTTP boundary. Do not import handlers or database internals.
type Json = any;
type RunningServer = Awaited<ReturnType<typeof startServer>>;
interface Reply {
  status: number;
  body: Json;
  headers: Headers;
}
interface RequestOptions {
  method?: string;
  body?: unknown;
  token?: string;
  raw?: BodyInit;
  contentType?: string;
  rawResponse?: boolean;
}

class Browser {
  cookie = "";

  constructor(private readonly serverUrl: () => string) {}

  async request(path: string, options: RequestOptions = {}): Promise<Reply> {
    const headers: Record<string, string> = { Origin: this.serverUrl() };
    if (this.cookie && !options.token) headers.Cookie = this.cookie;
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    } else if (options.raw !== undefined) {
      headers["Content-Type"] = options.contentType ?? "application/octet-stream";
      body = options.raw;
    }
    const response = await fetch(`${this.serverUrl()}${path}`, {
      method: options.method ?? "GET",
      headers,
      body,
      redirect: "manual",
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) {
      // Browsers send only name=value. Attributes must not enter Cookie.
      const known = new Map(this.cookie.split("; ").filter(Boolean).map((part) => {
        const at = part.indexOf("=");
        return [part.slice(0, at), part.slice(at + 1)];
      }));
      for (const cookie of cookies) {
        const first = cookie.split(";", 1)[0];
        const at = first.indexOf("=");
        const key = first.slice(0, at);
        const value = first.slice(at + 1);
        if (!value || /(?:^|;)\s*max-age=0(?:;|$)/i.test(cookie)) known.delete(key);
        else known.set(key, value);
      }
      this.cookie = [...known].map(([key, value]) => `${key}=${value}`).join("; ");
    }
    const text = await response.text();
    let parsed: Json = null;
    if (text) {
      const isJson = /application\/json/.test(response.headers.get("content-type") ?? "");
      if (options.rawResponse && !isJson) parsed = text;
      else {
        assert.ok(isJson, `${path} returned a non-JSON API response: ${text.slice(0, 200)}`);
        parsed = JSON.parse(text);
      }
    }
    return { status: response.status, body: parsed, headers: response.headers };
  }

  // Only fixture structure gestures use this helper. Preserve every supplied
  // record base; plain request() still sends deliberate stale inputs unchanged.
  async structure(path: string, options: RequestOptions): Promise<Reply> {
    const input = options.body as Json;
    const single = /^\/api\/records\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
    const writes: Json[] = single ? [{ ...input, scope: decodeURIComponent(single[1]), collection: decodeURIComponent(single[2]), id: decodeURIComponent(single[3]) }] : input.writes;
    const expectedPages: Json[] = [];
    const seen = new Set<string>();
    for (const write of writes) {
      const pageId = write.collection === "pages" ? write.id : write.collection === "blocks" ? write.value?.page ?? write.base?.page : undefined;
      if (!pageId) continue;
      const key = JSON.stringify([write.scope, pageId]); if (seen.has(key)) continue; seen.add(key);
      const reply = await this.request(`/api/collaboration/${encodeURIComponent(write.scope)}/${encodeURIComponent(pageId)}`);
      assert.ok([200, 404].includes(reply.status), `Cannot establish the fixture's structure basis: ${JSON.stringify(reply.body)}`);
      if (reply.status === 200) expectedPages.push({ scope: write.scope, pageId, generation: reply.body.generation, revision: reply.body.revision });
    }
    const reply = await this.request("/api/records/batch", { ...options, body: { ...(!single ? input : {}), writes, expectedPages } });
    return single && reply.status === 200 ? { ...reply, body: reply.body[0] } : reply;
  }
}

function status(reply: Reply, expected: number): Json {
  assert.equal(reply.status, expected, JSON.stringify(reply.body));
  return reply.body;
}

function denied(reply: Reply): void {
  assert.ok([401, 403, 404].includes(reply.status), `Expected access refusal, got ${reply.status}: ${JSON.stringify(reply.body)}`);
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "heinote-http-"));
  let server: RunningServer = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false });
  t.after(async () => {
    await server.close();
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("heinote-http-"));
    await rm(target, { recursive: true, force: true });
  });
  return {
    browser: () => new Browser(() => server.url),
    async restart() {
      await server.close();
      server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false });
    },
  };
}

const password = "Correct-horse-battery-2026!";

async function register(browser: Browser, handle: string): Promise<Json> {
  status(await browser.request("/api/auth/register", {
    method: "POST", body: { handle, displayName: handle.toUpperCase(), password },
  }), 201);
  const session = status(await browser.request("/api/session"), 200);
  assert.equal(session.user.handle, handle);
  assert.ok(session.user.id);
  assert.ok(browser.cookie, "Registration must establish a session");
  return session.user;
}

function page(id: string, author: string, fields: Record<string, unknown> = {}) {
  return {
    id, title_content: [{ text: id }], icon: "", kind: "document",
    created_at: "2026-11-03T00:00:00.000Z", updated_at: "2026-11-03T00:00:00.000Z",
    created_by: author, updated_by: author, ...fields,
  };
}

async function put(browser: Browser, scope: string, collection: string, id: string, value: unknown) {
  return status(await browser.structure(`/api/records/${scope}/${collection}/${id}`, {
    method: "POST", body: { action: "put", value },
  }), 200);
}

async function token(browser: Browser, access: "read" | "write", name = `${access} token`) {
  const created = status(await browser.request("/api/tokens", {
    method: "POST", body: { name, access },
  }), 201);
  assert.equal(typeof created.id, "string");
  assert.equal(typeof created.token, "string");
  assert.ok(created.token.length >= 24);
  return created;
}

async function agentPage(browser: Browser, bearer: string, title = "First title", text = "First text") {
  const created = status(await browser.request("/api/v1/pages", {
    method: "POST", token: bearer, body: { title, text },
  }), 201);
  assert.equal(typeof created.id, "string");
  assert.equal(created.title, title);
  assert.equal(created.text, text);
  assert.notEqual(created.revision, undefined);
  return created;
}

test("registration, session cookies, login, and logout invalidate the old session", async (t) => {
  const f = await fixture(t);
  const alice = f.browser();
  assert.equal(status(await alice.request("/api/session"), 200).user, null);
  const user = await register(alice, "alice");
  assert.equal(user.siteRole, "admin");
  const cookieHeader = alice.cookie;
  const sessionCookie = status(await alice.request("/api/auth/login", {
    method: "POST", body: { handle: "alice", password },
  }), 200);
  assert.ok(sessionCookie);
  const cookieBeforeLogout = alice.cookie;
  status(await alice.request("/api/auth/logout", { method: "POST" }), 200);
  assert.equal(status(await alice.request("/api/session"), 200).user, null);
  const stale = f.browser();
  stale.cookie = cookieBeforeLogout;
  assert.equal(status(await stale.request("/api/session"), 200).user, null);
  status(await alice.request("/api/auth/login", {
    method: "POST", body: { handle: "alice", password: "wrong password" },
  }), 401);
  status(await alice.request("/api/auth/login", {
    method: "POST", body: { handle: "alice", password },
  }), 200);
  assert.equal(status(await alice.request("/api/session"), 200).user.id, user.id);
  assert.ok(cookieHeader);
  const duplicate = f.browser();
  const duplicateReply = await duplicate.request("/api/auth/register", {
    method: "POST", body: { handle: "alice", displayName: "Another Alice", password },
  });
  assert.equal(duplicateReply.status, 409);
});

test("two site admins can coexist and concurrent demotion preserves one admin", async (t) => {
  const f = await fixture(t);
  const alice = f.browser();
  const bob = f.browser();
  const a = await register(alice, "alice");
  const b = await register(bob, "bob");
  assert.equal(b.siteRole, "user");
  denied(await bob.request("/api/admin/users"));
  denied(await bob.request(`/api/admin/users/${b.id}`, { method: "PATCH", body: { siteRole: "admin" } }));
  status(await alice.request(`/api/admin/users/${b.id}`, { method: "PATCH", body: { siteRole: "admin" } }), 200);
  const users = status(await bob.request("/api/admin/users"), 200);
  assert.equal(users.filter((user: Json) => user.siteRole === "admin").length, 2);
  const demotions = await Promise.all([
    alice.request(`/api/admin/users/${a.id}`, { method: "PATCH", body: { siteRole: "user" } }),
    bob.request(`/api/admin/users/${b.id}`, { method: "PATCH", body: { siteRole: "user" } }),
  ]);
  assert.deepEqual(demotions.map((reply) => reply.status).sort(), [200, 409]);
  const sessions = await Promise.all([alice.request("/api/session"), bob.request("/api/session")]);
  assert.equal(sessions.filter((reply) => status(reply, 200).user.siteRole === "admin").length, 1);
});

test("private records and files remain private even from another site admin", async (t) => {
  const f = await fixture(t);
  const alice = f.browser();
  const bob = f.browser();
  const a = await register(alice, "alice");
  const b = await register(bob, "bob");
  status(await alice.request(`/api/admin/users/${b.id}`, { method: "PATCH", body: { siteRole: "admin" } }), 200);
  await put(alice, "personal", "pages", "private_a", page("private_a", a.id));
  await put(bob, "personal", "pages", "private_b", page("private_b", b.id));
  const aRows = status(await alice.request("/api/records/personal/pages"), 200);
  const bRows = status(await bob.request("/api/records/personal/pages"), 200);
  assert.deepEqual(aRows.map((row: Json) => row.id), ["private_a"]);
  assert.deepEqual(bRows.map((row: Json) => row.id), ["private_b"]);
  denied(await f.browser().request("/api/records/personal/pages"));
  status(await alice.request("/api/files/personal?path=files%2Fprivate_a%2Fsecret.txt", {
    method: "PUT", raw: "secret bytes", contentType: "text/plain",
  }), 200);
  denied(await bob.request("/api/files/personal?path=files%2Fprivate_a%2Fsecret.txt"));
  const bearer = await token(bob, "write");
  denied(await bob.request("/api/v1/pages/private_a", { token: bearer.token }));
  denied(await bob.request("/api/v1/pages/private_a", {
    method: "PATCH", token: bearer.token, body: { title: "stolen", baseRevision: 1 },
  }));
  assert.equal(status(await alice.request("/api/records/personal/pages"), 200)[0].value.title_content[0].text, "private_a");
});

test("space invitations require acceptance, viewer cannot write, and removal revokes access", async (t) => {
  const f = await fixture(t);
  const owner = f.browser();
  const member = f.browser();
  const ownerUser = await register(owner, "owner");
  const memberUser = await register(member, "member");
  const space = status(await owner.request("/api/spaces", { method: "POST", body: { name: "Shared tree" } }), 201);
  const scope = space.spaceId;
  await put(owner, scope, "pages", "shared_root", page("shared_root", ownerUser.id, { share_space_id: scope }));
  denied(await member.request(`/api/records/${scope}/pages`));
  assert.equal(status(await owner.request(`/api/spaces/${scope}/invitations`, {
    method: "POST", body: { handle: "member", role: "viewer" },
  }), 200).created, true);
  assert.equal(status(await owner.request(`/api/spaces/${scope}/invitations`, {
    method: "POST", body: { handle: "member", role: "viewer" },
  }), 200).created, false);
  denied(await member.request(`/api/records/${scope}/pages`));
  const pending = status(await member.request("/api/invitations"), 200);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].spaceId, scope);
  status(await member.request(`/api/invitations/${pending[0].id}`, { method: "POST", body: { accept: true } }), 200);
  assert.equal(status(await member.request(`/api/records/${scope}/pages`), 200)[0].id, "shared_root");
  const shared = page("shared_root", ownerUser.id, { share_space_id: scope });
  denied(await member.request(`/api/records/${scope}/pages/shared_root`, {
    method: "POST", body: { action: "patch", patch: { icon: "🚫" }, base: shared },
  }));
  denied(await member.request(`/api/spaces/${scope}/members/${memberUser.id}`, {
    method: "PATCH", body: { role: "admin" },
  }));
  const memberToken = await token(member, "write");
  const sharedAgentPage = status(await member.request("/api/v1/pages/shared_root", { token: memberToken.token }), 200);
  denied(await member.request("/api/v1/pages/shared_root", {
    method: "PATCH", token: memberToken.token, body: { title: "forbidden", baseRevision: sharedAgentPage.revision },
  }));
  status(await owner.request(`/api/spaces/${scope}/members/${memberUser.id}`, { method: "PATCH", body: { role: "editor" } }), 200);
  const replayable = { requestId: "member-edit", writes: [{ scope, collection: "pages", id: "shared_root", action: "patch", patch: { icon: "📘" }, base: shared }] };
  status(await member.request("/api/records/batch", { method: "POST", body: replayable }), 200);
  status(await owner.request(`/api/spaces/${scope}/members/${memberUser.id}`, { method: "DELETE" }), 200);
  denied(await member.request("/api/records/batch", { method: "POST", body: replayable }));
  denied(await member.request(`/api/records/${scope}/pages`));
  denied(await member.request("/api/v1/pages/shared_root", { token: memberToken.token }));
  denied(await member.request(`/api/records/${scope}/pages/shared_root`, {
    method: "POST", body: { action: "patch", patch: { icon: "stale write" }, base: shared },
  }));
});

test("request bodies cannot forge site roles, invitation roles, owner identity, or record scopes", async (t) => {
  const f = await fixture(t);
  const owner = f.browser();
  const viewer = f.browser();
  const manager = f.browser();
  const ownerUser = await register(owner, "owner");
  status(await viewer.request("/api/auth/register", {
    method: "POST", body: { handle: "viewer", displayName: "Viewer", password, siteRole: "admin", role: "owner", id: ownerUser.id },
  }), 201);
  const viewerUser = status(await viewer.request("/api/session"), 200).user;
  assert.equal(viewerUser.siteRole, "user");
  assert.notEqual(viewerUser.id, ownerUser.id);
  const managerUser = await register(manager, "manager");
  const space = status(await owner.request("/api/spaces", {
    method: "POST", body: { name: "Role boundaries", ownerId: viewerUser.id, role: "viewer" },
  }), 201);
  const scope = space.spaceId;
  await put(owner, scope, "pages", "role_root", page("role_root", ownerUser.id, { share_space_id: scope }));
  status(await owner.request(`/api/spaces/${scope}/invitations`, { method: "POST", body: { handle: "viewer", role: "viewer" } }), 200);
  status(await owner.request(`/api/spaces/${scope}/invitations`, { method: "POST", body: { handle: "manager", role: "admin" } }), 200);
  const invite = status(await viewer.request("/api/invitations"), 200)[0];
  denied(await manager.request(`/api/invitations/${invite.id}`, { method: "POST", body: { accept: true } }));
  status(await viewer.request(`/api/invitations/${invite.id}`, {
    method: "POST", body: { accept: true, role: "owner", siteRole: "admin", userId: ownerUser.id },
  }), 200);
  const managerInvite = status(await manager.request("/api/invitations"), 200)[0];
  status(await manager.request(`/api/invitations/${managerInvite.id}`, { method: "POST", body: { accept: true } }), 200);
  const roster = status(await viewer.request(`/api/spaces/${scope}/roster`), 200);
  assert.equal(roster.members.find((user: Json) => user.id === ownerUser.id).role, "owner");
  assert.equal(roster.members.find((user: Json) => user.id === viewerUser.id).role, "viewer");
  assert.equal(roster.members.find((user: Json) => user.id === managerUser.id).role, "admin");
  denied(await manager.request(`/api/spaces/${scope}/members/${ownerUser.id}`, { method: "PATCH", body: { role: "viewer" } }));
  denied(await manager.request(`/api/spaces/${scope}/members/${viewerUser.id}`, { method: "PATCH", body: { role: "admin" } }));
  denied(await manager.request(`/api/spaces/${scope}/invitations`, { method: "POST", body: { handle: "unknown_person", role: "admin" } }));
  denied(await viewer.request(`/api/records/${scope}/pages/role_root`, {
    method: "POST", body: { scope: "personal", actor: { user: ownerUser }, action: "patch", patch: { icon: "forged" }, base: roster },
  }));
  assert.equal(status(await owner.request(`/api/records/${scope}/pages`), 200)[0].value.icon, "");
});

test("record patches merge unrelated fields and reject stale writes to the same field", async (t) => {
  const f = await fixture(t);
  const browser = f.browser();
  const user = await register(browser, "alice");
  const base = page("concurrent", user.id);
  await put(browser, "personal", "pages", base.id, base);
  const path = `/api/records/personal/pages/${base.id}`;
  status(await browser.request(path, { method: "POST", body: { action: "patch", patch: { icon: "📘" }, base } }), 200);
  status(await browser.request(path, {
    method: "POST", body: { action: "patch", patch: { title_content: [{ text: "Independent rename" }] }, base },
  }), 200);
  status(await browser.request(path, { method: "POST", body: { action: "patch", patch: { icon: "🚫" }, base } }), 409);
  const stored = status(await browser.request("/api/records/personal/pages"), 200).find((row: Json) => row.id === base.id).value;
  assert.equal(stored.icon, "📘");
  assert.equal(stored.title_content[0].text, "Independent rename");
  status(await browser.request(path, { method: "POST", body: { action: "patch", patch: { full_width: true }, base: stored } }), 200);
  const withWidth = { ...stored, full_width: true };
  status(await browser.request(path, { method: "POST", body: { action: "patch", patch: { full_width: null }, base: withWidth } }), 200);
  const withoutWidth = status(await browser.request("/api/records/personal/pages"), 200).find((row: Json) => row.id === base.id).value;
  assert.equal(Object.hasOwn(withoutWidth, "full_width"), false);
});

test("public links expose only their page tree and revocation stops anonymous reads", async (t) => {
  const f = await fixture(t);
  const owner = f.browser();
  const guest = f.browser();
  const outsider = f.browser();
  const user = await register(owner, "alice");
  await register(outsider, "bob");
  await put(owner, "personal", "pages", "published", page("published", user.id));
  await put(owner, "personal", "pages", "child", page("child", user.id, { parent_id: "published" }));
  await put(owner, "personal", "pages", "unrelated_private", page("unrelated_private", user.id));
  const share = status(await owner.request("/api/shares", { method: "POST", body: { pageId: "published" } }), 201);
  assert.equal(typeof share.id, "string");
  const publicToken = new URL(share.url, "http://unused.invalid").pathname.split("/").filter(Boolean).at(-1);
  assert.ok(publicToken);
  const output = status(await guest.request(`/api/public/${publicToken}`), 200);
  assert.deepEqual(output.pages.map((item: Json) => item.id).sort(), ["child", "published"]);
  // Without pageId the list covers every public link of this user only —
  // the sidebar's 公开链接 section reads it.
  const allLinks = status(await owner.request("/api/shares"), 200);
  assert.deepEqual(allLinks.map((item: Json) => item.pageId), ["published"]);
  denied(await guest.request("/api/shares"));
  assert.equal(status(await outsider.request("/api/shares"), 200).length, 0);
  denied(await guest.request("/api/records/personal/pages"));
  denied(await guest.request(`/api/public/${publicToken}`, { method: "POST", body: { title: "overwrite" } }));
  status(await owner.request(`/api/shares/${share.id}`, { method: "DELETE" }), 200);
  denied(await guest.request(`/api/public/${publicToken}`));
  assert.equal(status(await owner.request("/api/shares?pageId=published"), 200).length, 0);
});

test("Agent tokens enforce read/write scope, owner isolation, API boundaries, and revocation", async (t) => {
  const f = await fixture(t);
  const alice = f.browser();
  const bob = f.browser();
  await register(alice, "alice");
  await register(bob, "bob");
  const writer = await token(alice, "write");
  const reader = await token(alice, "read");
  const outsider = await token(bob, "write");
  const created = await agentPage(alice, writer.token);
  // A separate client has no cookie. Agent access does not require an open app.
  const agent = f.browser();
  assert.equal(status(await agent.request(`/api/v1/pages/${created.id}`, { token: reader.token }), 200).text, "First text");
  denied(await agent.request("/api/v1/pages", { method: "POST", token: reader.token, body: { title: "forbidden" } }));
  denied(await agent.request(`/api/v1/pages/${created.id}`, {
    method: "PATCH", token: reader.token, body: { title: "forbidden", baseRevision: created.revision },
  }));
  denied(await agent.request("/api/admin/users", { token: writer.token }));
  denied(await agent.request("/api/tokens", { method: "POST", token: writer.token, body: { name: "escalation", access: "write" } }));
  denied(await agent.request(`/api/v1/pages/${created.id}`, { token: outsider.token }));
  denied(await agent.request(`/api/v1/pages/${created.id}`, {
    method: "PATCH", token: outsider.token, body: { title: "stolen", baseRevision: created.revision },
  }));
  const updated = status(await agent.request(`/api/v1/pages/${created.id}`, {
    method: "PATCH", token: writer.token, body: { text: "Saved by the agent", baseRevision: created.revision },
  }), 200);
  assert.equal(updated.text, "Saved by the agent");
  assert.notEqual(updated.revision, created.revision);
  const listed = status(await alice.request("/api/tokens"), 200);
  assert.equal(listed.some((item: Json) => Object.hasOwn(item, "token")), false);
  status(await alice.request(`/api/tokens/${reader.id}`, { method: "DELETE" }), 200);
  status(await agent.request(`/api/v1/pages/${created.id}`, { token: reader.token }), 401);
});

test("Agent checkpoints restore the same editor records and reject stale revisions", async (t) => {
  const f = await fixture(t);
  const browser = f.browser();
  await register(browser, "alice");
  const bearer = await token(browser, "write");
  const created = await agentPage(browser, bearer.token, "Before title", "Before text");
  status(await browser.request(`/api/v1/pages/${created.id}/checkpoint`, { method: "POST", token: bearer.token }), 200);
  const versions = status(await browser.request(`/api/v1/pages/${created.id}/versions`, { token: bearer.token }), 200);
  assert.ok(versions.length >= 1);
  const versionId = versions.at(-1).id;
  assert.ok(versionId);
  const changed = status(await browser.request(`/api/v1/pages/${created.id}`, {
    method: "PATCH", token: bearer.token, body: { title: "After title", text: "After text", baseRevision: created.revision },
  }), 200);
  status(await browser.request(`/api/v1/pages/${created.id}`, {
    method: "PATCH", token: bearer.token, body: { text: "stale overwrite", baseRevision: created.revision },
  }), 409);
  status(await browser.request(`/api/v1/pages/${created.id}/restore`, {
    method: "POST", token: bearer.token, body: { versionId },
  }), 200);
  const restored = status(await browser.request(`/api/v1/pages/${created.id}`, { token: bearer.token }), 200);
  assert.equal(restored.title, "Before title");
  assert.equal(restored.text, "Before text");
  assert.notEqual(restored.revision, changed.revision);
  const editorPages = status(await browser.request("/api/records/personal/pages"), 200);
  const editorBlocks = status(await browser.request("/api/records/personal/blocks"), 200);
  assert.equal(editorPages.find((row: Json) => row.id === created.id).value.title_content[0].text, "Before title");
  assert.ok(editorBlocks.some((row: Json) => row.value.page === created.id && row.value.content.some((run: Json) => run.text?.includes("Before text"))));
  const readOnly = await token(browser, "read");
  denied(await browser.request(`/api/v1/pages/${created.id}/restore`, {
    method: "POST", token: readOnly.token, body: { versionId },
  }));
});

test("record batches commit together and roll back when any scope is unauthorized", async (t) => {
  const f = await fixture(t);
  const owner = f.browser();
  const other = f.browser();
  const ownerUser = await register(owner, "owner");
  const otherUser = await register(other, "other");
  const space = status(await owner.request("/api/spaces", { method: "POST", body: { name: "Restricted" } }), 201);
  await put(owner, space.spaceId, "pages", "restricted", page("restricted", ownerUser.id, { share_space_id: space.spaceId }));
  denied(await other.request("/api/records/batch", {
    method: "POST", body: { writes: [
      { scope: "personal", collection: "pages", id: "must_rollback", action: "put", value: page("must_rollback", otherUser.id), base: null },
      { scope: space.spaceId, collection: "pages", id: "intruder", action: "put", value: page("intruder", otherUser.id, { parent_id: "restricted" }), base: null },
    ] },
  }));
  assert.equal(status(await other.request("/api/records/personal/pages"), 200).length, 0);
  const committed = status(await other.request("/api/records/batch", {
    method: "POST", body: { writes: [
      { scope: "personal", collection: "pages", id: "atomic_page", action: "put", value: page("atomic_page", otherUser.id), base: null },
      { scope: "personal", collection: "blocks", id: "11_atomic_page_first", action: "put", value: {
        id: "first", page: "atomic_page", kind: "text", order: 1000, content: [{ text: "Atomic content" }],
      }, base: null },
    ] },
  }), 200);
  assert.equal(committed.length, 2);
  assert.equal(status(await other.request("/api/records/personal/pages"), 200)[0].id, "atomic_page");
  assert.equal(status(await other.request("/api/records/personal/blocks"), 200)[0].value.content[0].text, "Atomic content");
});

test("batch request IDs survive restart, reject changed payloads, and never rewind later edits", async (t) => {
  const f = await fixture(t);
  const alice = f.browser();
  const user = await register(alice, "alice");
  const writes = [{ scope: "personal", collection: "pages", id: "replayed", action: "put", value: page("replayed", user.id), base: null }];
  const requestBody = { requestId: "stable-request", writes };
  const first = status(await alice.request("/api/records/batch", { method: "POST", body: requestBody }), 200);
  assert.deepEqual(status(await alice.request("/api/records/batch", { method: "POST", body: requestBody }), 200), first);
  status(await alice.request("/api/records/personal/pages/replayed", {
    method: "POST", body: { action: "patch", patch: { icon: "📘" }, base: first[0] },
  }), 200);
  await f.restart();
  assert.deepEqual(status(await alice.request("/api/records/batch", { method: "POST", body: requestBody }), 200), first);
  assert.equal(status(await alice.request("/api/records/personal/pages"), 200)[0].value.icon, "📘");
  status(await alice.request("/api/records/batch", {
    method: "POST", body: { ...requestBody, writes: [{ ...writes[0], value: { ...writes[0].value, icon: "different payload" } }] },
  }), 409);
  const bob = f.browser();
  const other = await register(bob, "bob");
  status(await bob.request("/api/records/batch", {
    method: "POST", body: { requestId: requestBody.requestId, writes: [{ ...writes[0], value: page("replayed", other.id) }] },
  }), 200);
});

test("JSON attachments stay raw bytes and immutable paths allow only identical upload retries", async (t) => {
  const f = await fixture(t);
  const owner = f.browser();
  await register(owner, "owner");
  const path = "/api/files/personal?path=files%2Fdata.json";
  const contents = '{"saved":true}\n';
  status(await owner.request(path, { method: "PUT", raw: contents, contentType: "application/json" }), 200);
  status(await owner.request(path, { method: "PUT", raw: contents, contentType: "application/json" }), 200);
  status(await owner.request(path, { method: "PUT", raw: '{"saved":false}', contentType: "application/json" }), 409);
  const read = await owner.request(path, { rawResponse: true });
  assert.deepEqual(status(read, 200), { saved: true });
  assert.match(read.headers.get("content-security-policy") ?? "", /sandbox/);
});

test("public attachments require an actual reference and cannot forge a foreign space scope", async (t) => {
  const f = await fixture(t);
  const owner = f.browser();
  const attacker = f.browser();
  const guest = f.browser();
  const user = await register(owner, "owner");
  const intruder = await register(attacker, "attacker");
  const ownFile = { path: "files/cover.txt", owner: user.id, name: "cover.txt", size: 12, type: "text/plain" };
  await put(owner, "personal", "pages", "public_files", page("public_files", user.id, { cover_image: ownFile }));
  status(await owner.request("/api/files/personal?path=files%2Fcover.txt", { method: "PUT", raw: "public bytes", contentType: "text/plain" }), 200);
  status(await owner.request("/api/files/personal?path=files%2Funreferenced.txt", { method: "PUT", raw: "private bytes", contentType: "text/plain" }), 200);
  const share = status(await owner.request("/api/shares", { method: "POST", body: { pageId: "public_files" } }), 201);
  const shareToken = new URL(share.url, "http://unused.invalid").pathname.split("/").at(-1);
  const publicPath = `/api/public/${shareToken}/files?path=files%2Fcover.txt`;
  assert.equal(status(await guest.request(publicPath, { rawResponse: true }), 200), "public bytes");
  denied(await guest.request(`/api/public/${shareToken}/files?path=files%2Funreferenced.txt`, { rawResponse: true }));
  const foreignSpace = status(await owner.request("/api/spaces", { method: "POST", body: { name: "Victim files" } }), 201);
  status(await owner.request(`/api/files/${foreignSpace.spaceId}?path=files%2Fsecret.txt`, { method: "PUT", raw: "victim secret", contentType: "text/plain" }), 200);
  const forgedFile = { ...ownFile, path: "files/secret.txt", space: foreignSpace.spaceId };
  await put(attacker, "personal", "pages", "forged_reference", page("forged_reference", intruder.id, { cover_image: forgedFile }));
  const attackShare = status(await attacker.request("/api/shares", { method: "POST", body: { pageId: "forged_reference" } }), 201);
  const attackToken = new URL(attackShare.url, "http://unused.invalid").pathname.split("/").at(-1);
  denied(await guest.request(`/api/public/${attackToken}/files?path=files%2Fsecret.txt`, { rawResponse: true }));
  const sharedPage = page("published_shared_root", user.id, { share_space_id: foreignSpace.spaceId });
  await put(owner, foreignSpace.spaceId, "pages", sharedPage.id, sharedPage);
  status(await owner.request(`/api/spaces/${foreignSpace.spaceId}/invitations`, {
    method: "POST", body: { handle: "attacker", role: "editor" },
  }), 200);
  const invitation = status(await attacker.request("/api/invitations"), 200)[0];
  status(await attacker.request(`/api/invitations/${invitation.id}`, { method: "POST", body: { accept: true } }), 200);
  const sharedShare = status(await owner.request("/api/shares", { method: "POST", body: { pageId: sharedPage.id } }), 201);
  const sharedToken = new URL(sharedShare.url, "http://unused.invalid").pathname.split("/").at(-1);
  // An editor must not use the publisher's identity to expose a private file.
  const maliciousReference = await attacker.request(`/api/records/${foreignSpace.spaceId}/pages/${sharedPage.id}`, {
    method: "POST", body: { action: "patch", patch: { cover_image: ownFile }, base: sharedPage },
  });
  if (maliciousReference.status !== 200) denied(maliciousReference);
  denied(await guest.request(`/api/public/${sharedToken}/files?path=files%2Fcover.txt`, { rawResponse: true }));
  status(await owner.request(`/api/shares/${share.id}`, { method: "DELETE" }), 200);
  denied(await guest.request(publicPath, { rawResponse: true }));
});

test("sharing and stopping a full tree migrate records atomically and revoke pending invitations", async (t) => {
  const f = await fixture(t);
  const owner = f.browser();
  const editor = f.browser();
  const pendingUser = f.browser();
  const ownerUser = await register(owner, "owner");
  await register(editor, "editor");
  await register(pendingUser, "pending");
  const root = page("tree_root", ownerUser.id);
  const child = page("tree_child", ownerUser.id, { parent_id: root.id });
  await put(owner, "personal", "pages", root.id, root);
  await put(owner, "personal", "pages", child.id, child);
  for (const item of [root, child]) {
    await put(owner, "personal", "blocks", `${item.id.length}_${item.id}_paragraph`, {
      id: "paragraph", page: item.id, kind: "text", order: 1024, content: [{ text: `Body of ${item.id}` }],
    });
  }
  const ownerToken = await token(owner, "write");
  status(await owner.request(`/api/v1/pages/${root.id}/checkpoint`, { method: "POST", token: ownerToken.token }), 200);
  const oldShare = status(await owner.request("/api/shares", { method: "POST", body: { pageId: root.id } }), 201);
  const oldPublicToken = new URL(oldShare.url, "http://unused.invalid").pathname.split("/").at(-1);
  const space = status(await owner.request("/api/spaces", { method: "POST", body: { name: "Tree collaboration" } }), 201);
  const scope = space.spaceId;
  for (const handle of ["editor", "pending"]) status(await owner.request(`/api/spaces/${scope}/invitations`, {
    method: "POST", body: { handle, role: "editor" },
  }), 200);
  const invitation = status(await editor.request("/api/invitations"), 200)[0];
  status(await editor.request(`/api/invitations/${invitation.id}`, { method: "POST", body: { accept: true } }), 200);
  const pendingInvitation = status(await pendingUser.request("/api/invitations"), 200)[0];
  const writes: Json[] = [];
  for (const collection of ["pages", "blocks", "versions"]) {
    for (const row of status(await owner.request(`/api/records/personal/${collection}`), 200)) {
      const value = collection === "pages" && row.id === root.id ? { ...row.value, share_space_id: scope } : row.value;
      writes.push({ scope, collection, id: row.id, action: "put", value, base: null });
      writes.push(collection === "pages" && row.id === root.id
        ? { scope: "personal", collection, id: row.id, action: "put", value, base: row.value }
        : { scope: "personal", collection, id: row.id, action: "delete", base: row.value });
    }
  }
  status(await owner.structure("/api/records/batch", { method: "POST", body: { requestId: "share-tree", writes } }), 200);
  assert.deepEqual(status(await editor.request(`/api/records/${scope}/pages`), 200).map((row: Json) => row.id).sort(), [root.id, child.id].sort());
  assert.equal(status(await editor.request(`/api/records/${scope}/blocks`), 200).length, 2);
  assert.ok(status(await editor.request(`/api/records/${scope}/versions`), 200).length >= 1);
  denied(await f.browser().request(`/api/public/${oldPublicToken}`));
  const sharedRows = status(await editor.request(`/api/records/${scope}/pages`), 200);
  const sharedRoot = sharedRows.find((row: Json) => row.id === root.id).value;
  const sharedChild = sharedRows.find((row: Json) => row.id === child.id).value;
  status(await editor.structure(`/api/records/${scope}/pages/${child.id}`, {
    method: "POST", body: { action: "patch", patch: { parent_id: null }, base: sharedChild },
  }), 400);
  status(await owner.structure(`/api/records/${scope}/pages/${root.id}`, {
    method: "POST", body: { action: "patch", patch: { share_space_id: null }, base: sharedRoot },
  }), 400);
  status(await editor.request(`/api/records/${scope}/pages/${root.id}`, {
    method: "POST", body: { action: "patch", patch: { icon: "📘" }, base: sharedRoot },
  }), 200);
  const editedRoot = { ...sharedRoot, icon: "📘" };
  denied(await editor.structure(`/api/records/${scope}/pages/${root.id}`, {
    method: "POST", body: { action: "delete", base: editedRoot },
  }));
  const share = status(await owner.request("/api/shares", { method: "POST", body: { pageId: root.id } }), 201);
  const publicToken = new URL(share.url, "http://unused.invalid").pathname.split("/").at(-1);
  const stopWrites: Json[] = [];
  for (const collection of ["pages", "blocks", "versions"]) {
    const personal = status(await owner.request(`/api/records/personal/${collection}`), 200);
    for (const row of status(await owner.request(`/api/records/${scope}/${collection}`), 200)) {
      const value = { ...row.value };
      if (collection === "pages" && row.id === root.id) delete value.share_space_id;
      stopWrites.push({ scope: "personal", collection, id: row.id, action: "put", value, base: personal.find((item: Json) => item.id === row.id)?.value ?? null });
      stopWrites.push({ scope, collection, id: row.id, action: "delete", base: row.value });
    }
  }
  status(await owner.structure("/api/records/batch", { method: "POST", body: { requestId: "stop-tree", writes: stopWrites } }), 200);
  const privatePages = status(await owner.request("/api/records/personal/pages"), 200);
  assert.equal(privatePages.find((row: Json) => row.id === root.id).value.icon, "📘");
  assert.equal(privatePages.find((row: Json) => row.id === child.id).value.parent_id, root.id);
  assert.equal(status(await owner.request("/api/records/personal/blocks"), 200).length, 2);
  assert.ok(status(await owner.request("/api/records/personal/versions"), 200).length >= 1);
  denied(await editor.request(`/api/records/${scope}/pages`));
  denied(await f.browser().request(`/api/public/${publicToken}`));
  assert.equal(status(await pendingUser.request("/api/invitations"), 200).length, 0);
  status(await pendingUser.request(`/api/invitations/${pendingInvitation.id}`, { method: "POST", body: { accept: true } }), 409);
  denied(await pendingUser.request(`/api/records/${scope}/pages`));
});

test("database restart preserves accounts, sessions, tokens, pages, and history", async (t) => {
  const f = await fixture(t);
  const browser = f.browser();
  const user = await register(browser, "alice");
  const bearer = await token(browser, "write");
  const created = await agentPage(browser, bearer.token, "Persistent title", "Persistent text");
  status(await browser.request(`/api/v1/pages/${created.id}/checkpoint`, { method: "POST", token: bearer.token }), 200);
  const before = status(await browser.request(`/api/v1/pages/${created.id}/versions`, { token: bearer.token }), 200);
  await f.restart();
  assert.equal(status(await browser.request("/api/session"), 200).user.id, user.id);
  const reopened = status(await browser.request(`/api/v1/pages/${created.id}`, { token: bearer.token }), 200);
  assert.equal(reopened.title, "Persistent title");
  assert.equal(reopened.text, "Persistent text");
  assert.equal(reopened.revision, created.revision);
  const after = status(await browser.request(`/api/v1/pages/${created.id}/versions`, { token: bearer.token }), 200);
  assert.deepEqual(after.map((item: Json) => item.id), before.map((item: Json) => item.id));
  const login = f.browser();
  status(await login.request("/api/auth/login", { method: "POST", body: { handle: "alice", password } }), 200);
  assert.equal(status(await login.request("/api/session"), 200).user.id, user.id);
});
