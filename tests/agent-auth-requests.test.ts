import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { startServer } from "../server/index.ts";
import { Browser, type Json, type Reply } from "./helpers/github.ts";

// UC-41：匿名 Agent 申请令牌；深链认领；批准签发一次性令牌；拒绝与过期。

type RunningServer = Awaited<ReturnType<typeof startServer>>;

function status(reply: Reply, expected: number): Json {
  assert.equal(reply.status, expected, JSON.stringify(reply.body));
  return reply.body;
}

async function fixture(t: TestContext, opts: Parameters<typeof startServer>[0] = {}) {
  const directory = await mkdtemp(join(tmpdir(), "heinote-auth-request-"));
  let server: RunningServer = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false, ...opts });
  t.after(async () => {
    await server.close();
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("heinote-auth-request-"));
    await rm(target, { recursive: true, force: true });
  });
  return { server, browser: () => new Browser(() => server.url) };
}

const password = "Correct-horse-battery-2026!";

async function register(browser: Browser, handle: string): Promise<Json> {
  status(await browser.request("/api/auth/register", {
    method: "POST", body: { handle, displayName: handle.toUpperCase(), password },
  }), 201);
  return status(await browser.request("/api/session"), 200).user;
}

async function ask(browser: Browser, body: Json = { name: "DeepSeek", access: "write" }): Promise<Json> {
  const reply = await browser.request("/api/v1/auth/requests", { method: "POST", body });
  const created = status(reply, 201);
  assert.equal(created.status, "pending");
  assert.match(created.verificationUrl, new RegExp(`\\?auth_request=${created.id}`));
  return created;
}

test("UC-41: 申请 → 认领 → 批准，令牌只下发一次且可用", async (t) => {
  const f = await fixture(t);
  const agent = f.browser();      // anonymous requester
  const alice = f.browser();
  await register(alice, "alice");

  const created = await ask(agent);

  // Anonymous approval endpoints reject.
  status(await agent.request(`/api/auth/requests/${created.id}/claim`, { method: "POST" }), 401);

  // Opening the verificationUrl claims it for the logged-in user.
  const claim = status(await alice.request(`/api/auth/requests/${created.id}/claim`, { method: "POST" }), 200);
  assert.equal(claim.status, "pending");
  assert.equal(claim.request.name, "DeepSeek");
  assert.equal(claim.request.access, "write");
  assert.equal(typeof claim.request.ip, "string");

  // After binding, it shows in the user's own pending list; another account
  // cannot see or claim it.
  const bob = f.browser(); await register(bob, "bob");
  const mine = status(await alice.request("/api/auth/requests"), 200);
  assert.equal(mine.requests.length, 1);
  status(await bob.request(`/api/auth/requests/${created.id}/claim`, { method: "POST" }), 404);
  status(await bob.request(`/api/auth/requests/${created.id}/approve`, { method: "POST" }), 404);

  // Approve → agent polls → token arrives exactly once.
  status(await alice.request(`/api/auth/requests/${created.id}/approve`, { method: "POST" }), 200);
  const first = status(await agent.request(`/api/v1/auth/requests/${created.id}`), 200);
  assert.equal(first.status, "approved");
  assert.match(first.token, /^notes_/);
  const second = status(await agent.request(`/api/v1/auth/requests/${created.id}`), 200);
  assert.equal(second.status, "approved");
  assert.equal(second.token, undefined);

  // The granted token works on the agent API.
  const page = status(await agent.request("/api/v1/pages", { method: "POST", token: first.token, body: { title: "Agent 写入" } }), 201);
  assert.equal(page.title, "Agent 写入");

  // Double approve conflicts.
  status(await alice.request(`/api/auth/requests/${created.id}/approve`, { method: "POST" }), 409);
});

test("UC-41: 拒绝后轮询只见 denied，过期链接不可再处理", async (t) => {
  const f = await fixture(t, { authRequestTtlMs: 60 });
  const agent = f.browser();
  const alice = f.browser();
  await register(alice, "alice");

  const denied = await ask(agent, { name: "Claude Code", access: "read" });
  await alice.request(`/api/auth/requests/${denied.id}/claim`, { method: "POST" });
  status(await alice.request(`/api/auth/requests/${denied.id}/deny`, { method: "POST" }), 200);
  const polled = status(await agent.request(`/api/v1/auth/requests/${denied.id}`), 200);
  assert.equal(polled.status, "denied");
  assert.equal(polled.token, undefined);
  status(await alice.request(`/api/auth/requests/${denied.id}/approve`, { method: "POST" }), 409);

  // Expired before anyone opened it: claim still binds the row but resolves
  // reads as expired, and approve is gone.
  const stale = await ask(agent, { name: "Codex" });
  await new Promise((wait) => setTimeout(wait, 80));
  const claim = status(await alice.request(`/api/auth/requests/${stale.id}/claim`, { method: "POST" }), 200);
  assert.equal(claim.status, "expired");
  status(await alice.request(`/api/auth/requests/${stale.id}/approve`, { method: "POST" }), 410);
  const polledStale = status(await agent.request(`/api/v1/auth/requests/${stale.id}`), 200);
  assert.equal(polledStale.status, "expired");
});

test("UC-41: 创建入参校验与匿名限流", async (t) => {
  const f = await fixture(t);
  const agent = f.browser();
  status(await agent.request("/api/v1/auth/requests", { method: "POST", body: { name: "" } }), 400);
  status(await agent.request("/api/v1/auth/requests", { method: "POST", body: { name: "X", access: "admin" } }), 400);
  for (let i = 0; i < 10; i++) await ask(agent, { name: `Bot-${i}` });
  status(await agent.request("/api/v1/auth/requests", { method: "POST", body: { name: "Bot-11" } }), 429);
});
