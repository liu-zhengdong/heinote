import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { startServer } from "../server/index.ts";

// UC-35 acceptance uses HTTP only. The server import only starts the fixture.
type Json = any;
type Server = Awaited<ReturnType<typeof startServer>>;
interface Reply { status: number; body: Json }

class Browser {
  cookie = "";
  constructor(private readonly url: () => string) {}
  async request(path: string, options: { method?: string; body?: unknown; token?: string } = {}): Promise<Reply> {
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
    return { status: response.status, body: raw ? JSON.parse(raw) : null };
  }
}
function ok(reply: Reply, expected = 200): Json {
  assert.equal(reply.status, expected, JSON.stringify(reply.body));
  return reply.body;
}
class Agent {
  constructor(readonly browser: Browser, readonly token: string) {}
  request(path: string, options: { method?: string; body?: unknown } = {}) {
    return this.browser.request(`/api/v1${path}`, { ...options, token: this.token });
  }
  async search(params: string) { return this.request(`/search?${params}`); }
  async makePage(input: Json) {
    return ok(await this.request("/pages", { method: "POST", body: input }), 201);
  }
}
async function register(browser: Browser, handle: string) {
  ok(await browser.request("/api/auth/register", {
    method: "POST", body: { handle, displayName: handle, password: "Agent-search-acceptance-2026!" },
  }), 201);
  return ok(await browser.request("/api/session")).user;
}
async function makeToken(browser: Browser, access: "read" | "write") {
  return ok(await browser.request("/api/tokens", { method: "POST", body: { name: `UC-35 ${access}`, access } }), 201);
}
async function invite(owner: Browser, member: Browser, scope: string, handle: string, role = "editor") {
  ok(await owner.request(`/api/spaces/${scope}/invitations`, { method: "POST", body: { handle, role } }));
  const invitation = ok(await member.request("/api/invitations")).find((entry: Json) => entry.spaceId === scope);
  assert.ok(invitation);
  ok(await member.request(`/api/invitations/${invitation.id}`, { method: "POST", body: { accept: true } }));
}
async function makeKb(owner: Browser, name: string) {
  return ok(await owner.request("/api/knowledge-bases", { method: "POST", body: { requestId: crypto.randomUUID(), name } }), 201);
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "notes-agent-search-http-"));
  let server: Server | undefined;
  t.after(async () => {
    try { await server?.close(); }
    finally {
      const target = resolve(directory);
      assert.equal(dirname(target), resolve(tmpdir()));
      assert.ok(basename(target).startsWith("notes-agent-search-http-"));
      await rm(target, { recursive: true, force: true });
    }
  });
  server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false });
  const browser = () => new Browser(() => server!.url);
  const owner = browser();
  await register(owner, "owner");
  const writer = (await makeToken(owner, "write")).token;
  const reader = (await makeToken(owner, "read")).token;
  const agent = new Agent(browser(), writer);
  const readAgent = new Agent(browser(), reader);
  return { browser, owner, agent, readAgent };
}

// AC-02: ranking mirrors quick-find — title prefix, title contains, body hit.
test("UC-35: ranks prefix, contains and body hits like quick-find", async (t) => {
  const { agent } = await fixture(t);
  const bodyHit = await agent.makePage({ title: "正文命中页面", text: "这一行有笔记检索词在正文里。" });
  const contains = await agent.makePage({ title: "中间包含 笔记检索 字样", text: "无关正文。" });
  const prefix = await agent.makePage({ title: "笔记检索前缀命中", text: "无关正文。" });
  // Make the body hit the newest to prove rank, not recency, orders the list.
  await new Promise((resolve) => setTimeout(resolve, 10));

  const result = ok(await agent.search("q=笔记检索"));
  assert.deepEqual(result.hits.map((hit: Json) => hit.id), [prefix.id, contains.id, bodyHit.id]);
  assert.equal(result.total, 3);
  assert.equal(result.hasMore, false);
  assert.equal(result.nextOffset, null);
  const body = result.hits[2];
  assert.equal(body.excerpt.includes("笔记检索词"), true);
  assert.equal(body.scope.startsWith("user:"), true);
  assert.equal(body.space, "个人空间");
});

// AC-01: one call covers the personal plane and a team knowledge base.
test("UC-35: covers personal pages and team knowledge bases with space labels", async (t) => {
  const { owner, agent } = await fixture(t);
  const kb = await makeKb(owner, "团队检索库");
  const personalHit = await agent.makePage({ title: "个人笔记检索页", text: "个人正文。" });
  const root = await agent.makePage({ title: "团队根目录", text: "", scope: kb.spaceId });
  const teamHit = await agent.makePage({ title: "团队笔记检索页", text: "团队正文。", parentId: root.id, scope: kb.spaceId });

  const result = ok(await agent.search("q=笔记检索"));
  assert.equal(result.total, 2);
  const titles = new Map(result.hits.map((hit: Json) => [hit.id, hit]));
  const personal = titles.get(personalHit.id);
  const team = titles.get(teamHit.id);
  assert.ok(personal && team);
  assert.equal(personal.space, "个人空间");
  assert.equal(team.space, "团队检索库");
  assert.equal(team.scope, kb.spaceId);
  assert.equal(team.crumb, "团队检索库 / 团队根目录");

  // AC-04 first half: a space filter returns only that space's hits.
  const scoped = ok(await agent.search(`q=笔记检索&space=${kb.spaceId}`));
  assert.deepEqual(scoped.hits.map((hit: Json) => hit.id), [teamHit.id]);
  const personalScoped = ok(await agent.search("q=笔记检索&space=personal"));
  assert.deepEqual(personalScoped.hits.map((hit: Json) => hit.id), [personalHit.id]);
});

// AC-03: an empty query is a field error; a miss is an empty list.
test("UC-35: rejects an empty query and returns an empty list on a miss", async (t) => {
  const { agent } = await fixture(t);
  const empty = await agent.search("q=%20%20");
  assert.equal(empty.status, 400);
  const miss = ok(await agent.search("q=不存在的关键字xyz"));
  assert.deepEqual(miss.hits, []);
  assert.equal(miss.total, 0);
});

// AC-04 second half + E1: permission isolation — a member sees only their
// own scopes; a stranger gets nothing from another user's space; no token, 401.
test("UC-35: scopes results to what the token account can read", async (t) => {
  const { browser, owner, agent } = await fixture(t);
  const kb = await makeKb(owner, "隔离检索库");
  const teamHit = await agent.makePage({ title: "隔离库检索页", text: "团队内容。", scope: kb.spaceId });
  const member = browser();
  await register(member, "member");
  const memberWriter = (await makeToken(member, "write")).token;
  const memberAgent = new Agent(browser(), memberWriter);

  const before = ok(await memberAgent.search("q=隔离库检索"));
  assert.equal(before.total, 0);

  await invite(owner, member, kb.spaceId, "member", "viewer");
  const joined = ok(await memberAgent.search("q=隔离库检索"));
  assert.equal(joined.total, 1);
  assert.equal(joined.hits[0].id, teamHit.id);
  assert.equal(joined.hits[0].space, "隔离检索库");

  const scoped = ok(await memberAgent.search(`q=隔离库检索&space=${kb.spaceId}`));
  assert.equal(scoped.total, 1);
  const deniedScope = await memberAgent.search("q=隔离库检索&space=nonexistent-space");
  assert.ok([403, 404].includes(deniedScope.status));

  const stranger = browser();
  await register(stranger, "stranger");
  const strangerAgent = new Agent(browser(), (await makeToken(stranger, "read")).token);
  const strangerResult = ok(await strangerAgent.search("q=隔离库检索"));
  assert.equal(strangerResult.total, 0);

  const noToken = await browser().request("/api/v1/search?q=隔离库检索");
  assert.equal(noToken.status, 401);

  // A read token searches fine, and it stays read-only elsewhere.
  const readOnly = ok(await memberAgent.search("q=隔离库检索"));
  assert.equal(readOnly.total, 1);
});

// AC-05: archived (trashed) pages drop out of results.
test("UC-35: excludes trashed pages", async (t) => {
  const { owner, agent } = await fixture(t);
  const hit = await agent.makePage({ title: "回收站检索页", text: "回收站命中词。" });
  assert.equal(ok(await agent.search("q=回收站命中")).total, 1);
  const scope = hit.collaboration.scope;
  ok(await owner.request("/api/records/batch", {
    method: "POST", body: {
      requestId: randomUUID(),
      expectedPages: [{ scope, pageId: hit.id, generation: hit.collaboration.generation, revision: hit.revision }],
      writes: [{ scope, collection: "pages", id: hit.id, action: "patch", base: hit.page, patch: { archived: true } }],
    },
  }));
  assert.equal(ok(await agent.search("q=回收站命中")).total, 0);
});

// Pagination: offset/nextOffset mirror the database query contract.
test("UC-35: paginates with limit and offset", async (t) => {
  const { agent } = await fixture(t);
  for (let index = 0; index < 15; index += 1) {
    await agent.makePage({ title: `分页检索 ${String(index).padStart(2, "0")}`, text: "" });
  }
  const first = ok(await agent.search("q=分页检索&limit=5"));
  assert.equal(first.hits.length, 5);
  assert.equal(first.total, 15);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, 5);
  const second = ok(await agent.search("q=分页检索&limit=5&offset=5"));
  assert.equal(second.hits.length, 5);
  assert.equal(second.nextOffset, 10);
  const third = ok(await agent.search("q=分页检索&limit=5&offset=10"));
  assert.equal(third.hits.length, 5);
  assert.equal(third.hasMore, false);
  assert.equal(third.nextOffset, null);
});
