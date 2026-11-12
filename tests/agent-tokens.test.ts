import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { startServer } from "../server/index.ts";
import { Browser, type Json, type Reply } from "./helpers/github.ts";

// UC-27：Agent 令牌携带身份；写操作按令牌记录。

type RunningServer = Awaited<ReturnType<typeof startServer>>;

function status(reply: Reply, expected: number): Json {
  assert.equal(reply.status, expected, JSON.stringify(reply.body));
  return reply.body;
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "heinote-agent-tokens-"));
  let server: RunningServer = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false });
  t.after(async () => {
    await server.close();
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("heinote-agent-tokens-"));
    await rm(target, { recursive: true, force: true });
  });
  return { browser: () => new Browser(() => server.url) };
}

const password = "Correct-horse-battery-2026!";

async function register(browser: Browser, handle: string): Promise<Json> {
  status(await browser.request("/api/auth/register", {
    method: "POST", body: { handle, displayName: handle.toUpperCase(), password },
  }), 201);
  return status(await browser.request("/api/session"), 200).user;
}

async function makeToken(browser: Browser, body: Json): Promise<Json> {
  const created = status(await browser.request("/api/tokens", { method: "POST", body }), 201);
  assert.equal(typeof created.id, "string");
  assert.equal(typeof created.token, "string");
  return created;
}

async function createPage(bearer: string, browser: Browser, title: string): Promise<Json> {
  return status(await browser.request("/api/v1/pages", { method: "POST", token: bearer, body: { title } }), 201);
}

test("UC-27: 令牌身份、写操作记录与撤销", async (t) => {
  const f = await fixture(t);
  const alice = f.browser();
  const owner = await register(alice, "alice");

  // AC-01：预设令牌身份。
  const claude = await makeToken(alice, { name: "Claude", access: "write", displayName: "Claude 助手", avatar: "preset:claude" });
  assert.equal(claude.displayName, "Claude 助手");
  assert.equal(claude.avatar, "preset:claude");
  assert.equal(claude.access, "write");
  const listed = status(await alice.request("/api/tokens"), 200);
  assert.equal(listed[0].displayName, "Claude 助手");
  assert.equal(listed[0].avatar, "preset:claude");

  // AC-02：令牌写操作署名 Agent 身份，并记录事件。
  const pageA = await createPage(claude.token, alice, "周报");
  status(await alice.request(`/api/v1/pages/${pageA.id}/checkpoint`, { method: "POST", token: claude.token, body: { summary: "首版" } }), 200);
  const versions = status(await alice.request(`/api/v1/pages/${pageA.id}/versions`, { token: claude.token }), 200);
  assert.equal(versions.at(-1).author_name, "Claude 助手");
  // 写操作记录 create + checkpoint。
  const activity = status(await alice.request(`/api/tokens/${claude.id}/activity`), 200);
  assert.ok(activity.length >= 2);
  const actions = activity.map((e: Json) => e.action);
  assert.ok(actions.includes("create"));
  assert.ok(actions.includes("checkpoint"));
  assert.equal(activity[0].pageTitle, "周报");

  // AC-04：修改身份后新署名用新身份，旧记录保留。
  status(await alice.request(`/api/tokens/${claude.id}`, { method: "PATCH", body: { displayName: "Claude 新名字" } }), 200);
  const pageC = await createPage(claude.token, alice, "第三页");
  status(await alice.request(`/api/v1/pages/${pageC.id}/checkpoint`, { method: "POST", token: claude.token, body: {} }), 200);
  const after = status(await alice.request(`/api/v1/pages/${pageC.id}/versions`, { token: claude.token }), 200);
  assert.equal(after.at(-1).author_name, "Claude 新名字");
  const versionsBefore = status(await alice.request(`/api/v1/pages/${pageA.id}/versions`, { token: claude.token }), 200);
  assert.equal(versionsBefore.at(-1).author_name, "Claude 助手");

  // AC-05：撤销后令牌失效，操作记录移除，署名快照保留。
  status(await alice.request(`/api/tokens/${claude.id}`, { method: "DELETE" }), 200);
  const denied = await alice.request("/api/v1/pages", { method: "POST", token: claude.token, body: { title: "x" } });
  assert.equal(denied.status, 401);
  const gone = status(await alice.request("/api/tokens"), 200);
  assert.equal(gone.length, 0);

  // AC-07：只读令牌写操作被拒，且不产生记录。
  const reader = await makeToken(alice, { name: "只读", access: "read" });
  const refuse = await alice.request("/api/v1/pages", { method: "POST", token: reader.token, body: { title: "x" } });
  assert.equal(refuse.status, 403);
  const empty = status(await alice.request(`/api/tokens/${reader.id}/activity`), 200);
  assert.equal(empty.length, 0);

  // 非拥有者看不到令牌操作记录。
  const bob = f.browser();
  await register(bob, "bob");
  const spy = await bob.request(`/api/tokens/${reader.id}/activity`);
  assert.equal(spy.status, 404);
});

test("UC-27: 默认身份与只读令牌边界", async (t) => {
  const f = await fixture(t);
  const alice = f.browser();
  await register(alice, "alice");
  const basic = await makeToken(alice, { name: "备份工具", access: "read" });
  assert.equal(basic.displayName, "备份工具");
  assert.equal(basic.avatar, "initial");
  // 未提供 displayName 时以名称为准。
  const renamed = status(await alice.request(`/api/tokens/${basic.id}`, { method: "PATCH", body: { displayName: "Backups" } }), 200);
  assert.equal(renamed.displayName, "Backups");
  // 无效输入不改变既有令牌。
  const bad = await alice.request(`/api/tokens/${basic.id}`, { method: "PATCH", body: { avatar: "preset:unknown" } });
  assert.equal(bad.status, 400);
  const still = status(await alice.request("/api/tokens"), 200);
  assert.equal(still[0].displayName, "Backups");
});
