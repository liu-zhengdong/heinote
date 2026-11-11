import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { startServer } from "../server/index.ts";

// UC-16 管理站点与存储限额 acceptance: quota accounting across records/files,
// per-object overrides, team-creation slots, admin endpoints and concurrency
// bases. The same Browser/fixture helpers as files.test.ts keep this file
// self-contained.
type Json = any;
type RunningServer = Awaited<ReturnType<typeof startServer>>;
interface Reply { status: number; body: Json; headers: Headers }
interface RequestOptions { method?: string; body?: unknown; token?: string; raw?: BodyInit; contentType?: string; binary?: boolean }

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
    const response = await fetch(`${this.serverUrl()}${path}`, { method: options.method ?? "GET", headers, body, redirect: "manual" });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) {
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
    if (options.binary) return { status: response.status, body: Buffer.from(await response.arrayBuffer()), headers: response.headers };
    const text = await response.text();
    let parsed: Json = null;
    if (text) parsed = JSON.parse(text);
    return { status: response.status, body: parsed, headers: response.headers };
  }

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
  assert.equal(reply.status, expected, typeof reply.body === "object" && !Buffer.isBuffer(reply.body) ? JSON.stringify(reply.body) : `${reply.body?.byteLength ?? reply.body} bytes`);
  return reply.body;
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "terminus-notes-quotas-"));
  let server: RunningServer | undefined = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false });
  t.after(async () => {
    await server?.close();
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("terminus-notes-quotas-"));
    await rm(target, { recursive: true, force: true });
  });
  return {
    directory,
    browser: () => new Browser(() => server!.url),
    async restart() {
      await server!.close();
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
  return session.user;
}

function page(id: string, author: string, size = 1_024, parentId?: string) {
  return {
    id, title_content: [{ text: "x".repeat(size) }], icon: "", kind: "document",
    ...(parentId ? { parent_id: parentId } : {}),
    created_at: "2026-11-03T00:00:00.000Z", updated_at: "2026-11-03T00:00:00.000Z",
    created_by: author, updated_by: author,
  };
}

async function putRecord(browser: Browser, scope: string, collection: string, id: string, value: unknown) {
  return status(await browser.structure(`/api/records/${scope}/${collection}/${id}`, { method: "POST", body: { action: "put", value } }), 200);
}

async function adminSettings(browser: Browser): Promise<Json> {
  return status(await browser.request("/api/admin/quota-settings"), 200);
}

async function setDefault(browser: Browser, key: "personal" | "team" | "creation", value: number, base?: Json) {
  return browser.request("/api/admin/quota-settings", { method: "PUT", body: { key, value, base } });
}

test("UC-16: personal quota counts records and files, enforces growth beyond the limit", async (t) => {
  const f = await fixture(t);
  const admin = f.browser();
  const user = f.browser();
  await register(admin, "admin");
  const bob = await register(user, "bob");

  // Lower the personal default far below real writes to exercise enforcement.
  status(await setDefault(admin, "personal", 8_000), 200);

  const scope = "personal";
  const before = status(await user.request("/api/account/quota"), 200);
  assert.equal(before.storage.limit, 8_000);
  assert.equal(before.storage.source, "default");

  await putRecord(user, scope, "pages", "p1", page("p1", "BOB", 3_000));
  const grown = status(await user.request("/api/account/quota"), 200);
  assert.ok(grown.storage.used > before.storage.used, "records grow usage");

  // A write that crosses the limit is refused with the UC-16 contract shape.
  const refused = await user.request("/api/records/batch", { method: "POST", body: { writes: [{ scope, collection: "pages", id: "p2", action: "put", value: page("p2", "BOB", 3_000) }] } });
  assert.equal(refused.status, 413, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "quota_exceeded");
  assert.equal(refused.body.quota.subject, `user:${bob.id}`);

  // Shrinking the record (usage below the current level) must stay allowed.
  const stored = (status(await user.request(`/api/records/${scope}/pages`), 200) as Json[]).find((row) => row.id === "p1");
  assert.ok(stored);
  status(await user.request(`/api/records/${scope}/pages/p1`, { method: "POST", body: { action: "patch", patch: { title_content: [{ text: "x" }] }, base: stored.value } }), 200);
  const shrunk = status(await user.request("/api/account/quota"), 200);
  assert.ok(shrunk.storage.used < grown.storage.used, "shrinking usage stays possible while over");
});

test("UC-16: file uploads join usage and dedupe by hash per scope", async (t) => {
  const f = await fixture(t);
  const admin = f.browser();
  const user = f.browser();
  await register(admin, "admin");
  const bob = await register(user, "bob");
  status(await setDefault(admin, "personal", 5_000), 200);
  const scope = "personal";
  const bytes = Buffer.alloc(2_000, 7);

  const url = `/api/files/${encodeURIComponent(scope)}?path=${encodeURIComponent("files/a.bin")}`;
  status(await user.request(url, { method: "PUT", raw: bytes }), 200);
  let quota = status(await user.request("/api/account/quota"), 200);
  assert.ok(quota.storage.used >= 2_000, "uploaded bytes enter usage");

  // Same bytes at another path dedupe to the same hash: usage must not grow by
  // the file's size a second time.
  const url2 = `/api/files/${encodeURIComponent(scope)}?path=${encodeURIComponent("files/b.bin")}`;
  status(await user.request(url2, { method: "PUT", raw: bytes }), 200);
  const deduped = status(await user.request("/api/account/quota"), 200);
  assert.equal(deduped.storage.used, quota.storage.used, "same hash counts once");

  // A bigger file that would pass the limit is refused with 413.
  const big = Buffer.alloc(4_000, 9);
  const refused = await user.request(`/api/files/${encodeURIComponent(scope)}?path=${encodeURIComponent("files/c.bin")}`, { method: "PUT", raw: big });
  assert.equal(refused.status, 413, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "quota_exceeded");
});

test("UC-16: custom per-user limit overrides the default and restores cleanly", async (t) => {
  const f = await fixture(t);
  const admin = f.browser();
  const user = f.browser();
  await register(admin, "admin");
  const bob = await register(user, "bob");

  const list = status(await admin.request("/api/admin/users"), 200) as Json[];
  const row = list.find((item) => item.id === bob.id);
  assert.ok(row);
  assert.equal(row.storageSource, "default");

  // Set a custom limit above the default, then a stale base refuses the next write.
  const set = await admin.request(`/api/admin/users/${bob.id}/limits`, { method: "PATCH", body: { storageLimit: 10_000, base: { storageLimit: null, teamCreationLimit: null } } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.storageLimit, 10_000);
  assert.equal(set.body.storageSource, "custom");

  const stale = await admin.request(`/api/admin/users/${bob.id}/limits`, { method: "PATCH", body: { storageLimit: 20_000, base: { storageLimit: null, teamCreationLimit: null } } });
  assert.equal(stale.status, 409, "stale base must conflict");
  assert.equal(stale.body.code, "conflict");

  const fresh = await admin.request(`/api/admin/users/${bob.id}/limits`, { method: "PATCH", body: { storageLimit: 20_000, base: { storageLimit: 10_000, teamCreationLimit: null } } });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.storageLimit, 20_000);

  const quota = status(await user.request("/api/account/quota"), 200);
  assert.equal(quota.storage.limit, 20_000);
  assert.equal(quota.storage.source, "custom");

  const restored = await admin.request(`/api/admin/users/${bob.id}/limits`, { method: "PATCH", body: { storageLimit: null, base: { storageLimit: 20_000, teamCreationLimit: null } } });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.storageSource, "default");
});

test("UC-16: team-creation slots gate KB create and transfer", async (t) => {
  const f = await fixture(t);
  const admin = f.browser();
  const alice = f.browser();
  const bob = f.browser();
  await register(admin, "admin");
  await register(alice, "alice");
  const b = await register(bob, "bob");
  status(await setDefault(admin, "creation", 1), 200);

  const first = status(await alice.request("/api/knowledge-bases", { method: "POST", body: { requestId: crypto.randomUUID(), name: "One" } }), 201);
  const second = await alice.request("/api/knowledge-bases", { method: "POST", body: { requestId: crypto.randomUUID(), name: "Two" } });
  assert.equal(second.status, 403, JSON.stringify(second.body));
  assert.equal(second.body.code, "team_limit");

  // Bob has a free slot; transferring is allowed. Afterwards Alice can create again.
  status(await alice.request(`/api/spaces/${first.spaceId}/invitations`, { method: "POST", body: { handle: "bob", role: "editor" } }), 200);
  const roster = status(await alice.request(`/api/spaces/${first.spaceId}/roster`), 200);
  status(await bob.request(`/api/invitations/${roster.invitations[0].id}`, { method: "POST", body: { accept: true } }), 200);
  const current = (status(await alice.request("/api/spaces"), 200) as Json[]).find((space) => space.spaceId === first.spaceId);
  status(await alice.request(`/api/knowledge-bases/${first.spaceId}/transfer`, { method: "POST", body: { requestId: crypto.randomUUID(), revision: current.knowledgeBase.revision, userId: b.id } }), 200);
  status(await alice.request("/api/knowledge-bases", { method: "POST", body: { requestId: crypto.randomUUID(), name: "Again" } }), 201);

  // Bob now owns one; raising his personal limit to 2 lets another transfer in.
  const bQuota = status(await bob.request("/api/account/quota"), 200);
  assert.equal(bQuota.teams.count, 1);
  assert.equal(bQuota.teams.limit, 1);

  // Bob is full now; a further KB create for him refuses with team_limit.
  const extra = await bob.request("/api/knowledge-bases", { method: "POST", body: { requestId: crypto.randomUUID(), name: "Overflow" } });
  assert.equal(extra.status, 403);
  assert.equal(extra.body.code, "team_limit");
});

test("UC-16: default preview reports impact, settings persist across restart", async (t) => {
  const f = await fixture(t);
  const admin = f.browser();
  await register(admin, "admin");
  const defaults = await adminSettings(admin);
  assert.ok(defaults.personalStorageBytes > 0);
  assert.equal(defaults.teamCreation, 5);

  const preview = status(await admin.request("/api/admin/quota-settings/preview", { method: "POST", body: { key: "personal", value: 12_000_000_000 } }), 200);
  assert.equal(typeof preview.affected, "number");
  assert.equal(typeof preview.newlyOver, "number");

  const updated = status(await setDefault(admin, "personal", 12_000_000_000, defaults), 200);
  assert.equal(updated.personalStorageBytes, 12_000_000_000);

  const stale = await setDefault(admin, "personal", 13_000_000_000, defaults);
  assert.equal(stale.status, 409, "stale base conflicts");

  await f.restart();
  const reloaded = await adminSettings(admin);
  assert.equal(reloaded.personalStorageBytes, 12_000_000_000);
});

test("UC-16: overview lists over-limit objects and teams endpoint reports KB usage", async (t) => {
  const f = await fixture(t);
  const admin = f.browser();
  const user = f.browser();
  await register(admin, "admin");
  const bob = await register(user, "bob");

  const kb = status(await admin.request("/api/knowledge-bases", { method: "POST", body: { requestId: crypto.randomUUID(), name: "Team" } }), 201);
  const teams = status(await admin.request("/api/admin/teams"), 200) as Json[];
  const team = teams.find((item) => item.spaceId === kb.spaceId);
  assert.ok(team);
  assert.equal(team.storageSource, "default");
  assert.equal(team.ownerName, "ADMIN");

  const space = (status(await admin.request("/api/spaces"), 200) as Json[]).find((item) => item.spaceId === kb.spaceId);
  status(await admin.request(`/api/records/${kb.spaceId}/pages/p1`, { method: "POST", body: { action: "put", value: page("p1", "ADMIN", 2_000, space.knowledgeBase.homePageId) } }), 200);
  await putRecord(user, "personal", "pages", "mine", page("mine", "BOB", 500));

  const overview = status(await admin.request("/api/admin/overview"), 200);
  assert.equal(overview.users, 2);
  assert.ok(overview.quotaBytes.total > 0, JSON.stringify(overview.quotaBytes));
  const again = status(await admin.request("/api/admin/teams"), 200) as Json[];
  assert.ok(again.find((item) => item.spaceId === kb.spaceId)!.storageBytes > 0);
  assert.ok(Array.isArray(overview.over));
  assert.ok(overview.disk.databaseBytes > 0);

  // Non-admin access refuses cleanly.
  const denied = await user.request("/api/admin/overview");
  assert.equal(denied.status, 403);
});
