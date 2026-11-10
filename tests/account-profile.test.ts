import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { startServer } from "../server/index.ts";
import { Browser, githubConfig, startGithubStub, type Json, type Reply, type StubIdentity } from "./helpers/github.ts";

// Exercise UC-12 through real HTTP requests and temporary SQLite storage.
type RunningServer = Awaited<ReturnType<typeof startServer>>;
type GithubConfig = NonNullable<Parameters<typeof startServer>[0]>["github"];
const profilePath = "/api/account/profile";
const password = "Correct-horse-battery-2026!";

function status(reply: Reply, expected: number): Json {
  assert.equal(reply.status, expected, JSON.stringify(reply.body));
  return reply.body;
}

async function fixture(t: TestContext, github: GithubConfig = null) {
  const directory = await mkdtemp(join(tmpdir(), "terminus-notes-profile-"));
  let server: RunningServer | undefined;
  t.after(async () => {
    try {
      await server?.close();
    } finally {
      const target = resolve(directory);
      assert.equal(dirname(target), resolve(tmpdir()));
      assert.ok(basename(target).startsWith("terminus-notes-profile-"));
      await rm(target, { recursive: true, force: true });
    }
  });
  const boot = () => startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false, registrationOpen: true, github });
  server = await boot();
  return {
    browser: () => new Browser(() => {
      assert.ok(server);
      return server.url;
    }),
    async restart() {
      await server!.close();
      server = undefined;
      server = await boot();
    },
  };
}

async function register(browser: Browser, handle: string): Promise<Json> {
  const { user } = status(await browser.request("/api/auth/register", {
    method: "POST", body: { handle, displayName: handle.toUpperCase(), password },
  }), 201);
  assert.ok(user.id);
  assert.ok(browser.cookie);
  return user;
}

async function session(browser: Browser): Promise<Json> {
  return status(await browser.request("/api/session"), 200).user;
}

async function save(browser: Browser, displayName: string): Promise<Json> {
  return status(await browser.request(profilePath, { method: "PATCH", body: { displayName } }), 200);
}

test("account profile requires a current browser session", async (t) => {
  const f = await fixture(t);
  const guest = f.browser();
  const input = { method: "PATCH", body: { displayName: "Unauthorized" } };
  assert.equal(status(await guest.request(profilePath, input), 401).code, "unauthorized");
  guest.cookie = "notes_session=unknown-session";
  status(await guest.request(profilePath, input), 401);

  const browser = f.browser();
  await register(browser, "alice");
  const stale = f.browser();
  stale.cookie = browser.cookie;
  status(await browser.request("/api/auth/logout", { method: "POST" }), 200);
  status(await stale.request(profilePath, input), 401);
});

test("account profile rejects read/write Agent tokens with or without cookies", async (t) => {
  const f = await fixture(t);
  const alice = f.browser();
  const bob = f.browser();
  const a = await register(alice, "alice");
  const b = await register(bob, "bob");
  for (const access of ["read", "write"]) {
    const { token } = status(await alice.request("/api/tokens", {
      method: "POST", body: { name: `${access} profile refusal`, access },
    }), 201);
    status(await f.browser().request(profilePath, {
      method: "PATCH", token, body: { displayName: "Agent name" },
    }), 403);
    for (const browser of [alice, bob]) {
      // The shared helper omits cookies for tokens unless Cookie is explicit.
      status(await browser.request(profilePath, {
        method: "PATCH", token, headers: { Cookie: browser.cookie }, body: { displayName: "Mixed credentials" },
      }), 403);
    }
  }
  assert.deepEqual(await session(alice), a);
  assert.deepEqual(await session(bob), b);
});

test("account profile rejects cross-site writes without changing the stored name", async (t) => {
  const f = await fixture(t);
  const browser = f.browser();
  const user = await register(browser, "alice");
  const origins: Array<Record<string, string>> = [{ Origin: "https://other.example" }, { "Sec-Fetch-Site": "cross-site" }];
  for (const headers of origins) {
    status(await browser.request(profilePath, {
      method: "PATCH", headers, body: { displayName: "Cross-site name" },
    }), 403);
    assert.deepEqual(await session(browser), user);
  }
});

test("account profile validates the displayName type and trimmed length", async (t) => {
  const f = await fixture(t);
  const browser = f.browser();
  const user = await register(browser, "alice");
  const invalid: unknown[] = [
    undefined, null, [], "name", {},
    { displayName: null }, { displayName: 12 }, { displayName: true },
    { displayName: [] }, { displayName: {} },
    { displayName: "" }, { displayName: " \t\n " },
    { displayName: "a".repeat(101) }, { displayName: `  ${"名".repeat(101)}  ` },
  ];
  for (const body of invalid) {
    const reply = status(await browser.request(profilePath, { method: "PATCH", body }), 400);
    assert.equal(reply.code, "bad_request");
    assert.deepEqual(await session(browser), user, `Invalid input changed the account: ${JSON.stringify(body)}`);
  }
});

test("account profile strictly rejects all additional fields and cannot target another account", async (t) => {
  const f = await fixture(t);
  const owner = f.browser();
  const browser = f.browser();
  const adminUser = await register(owner, "owner");
  const user = await register(browser, "alice");
  const extras = {
    id: adminUser.id, userId: adminUser.id, handle: "renamed-handle", username: "renamed-user",
    siteRole: "admin", password: "Replacement-password-2026!", avatarUrl: "https://other.example/avatar.png",
    display_name: "Bypass", unknown: "unsupported",
  };
  for (const [field, value] of Object.entries(extras)) {
    const reply = status(await browser.request(profilePath, {
      method: "PATCH", body: { displayName: "Must not save", [field]: value },
    }), 400);
    assert.equal(reply.code, "bad_request");
    assert.deepEqual(await session(browser), user, `Extra field ${field} changed the current account`);
    assert.deepEqual(await session(owner), adminUser, `Extra field ${field} changed another account`);
  }
  const login = f.browser();
  assert.deepEqual(status(await login.request("/api/auth/login", {
    method: "POST", body: { handle: user.handle, password },
  }), 200).user, user);
});

test("account profile trims names, accepts both length limits and duplicate names, and permits retries", async (t) => {
  const f = await fixture(t);
  const alice = f.browser();
  const bob = f.browser();
  const a = await register(alice, "alice");
  const b = await register(bob, "bob");
  for (const displayName of [" \t新 显示名\n ", " \tZ\n ", `  ${"名".repeat(100)}  `, b.displayName]) {
    const expected = { user: { ...a, displayName: displayName.trim() } };
    assert.deepEqual(await save(alice, displayName), expected);
    assert.deepEqual(await save(alice, displayName), expected);
    assert.deepEqual(await session(alice), expected.user);
    assert.deepEqual(await session(bob), b);
  }
  assert.equal((await session(alice)).displayName, (await session(bob)).displayName);
});

test("account profile persists across restart and session bootstrap reads the new name", async (t) => {
  const f = await fixture(t);
  const browser = f.browser();
  const user = await register(browser, "alice");
  const otherSession = f.browser();
  status(await otherSession.request("/api/auth/login", {
    method: "POST", body: { handle: user.handle, password },
  }), 200);
  const methods = status(await browser.request("/api/auth/github/status"), 200);
  const expected = { ...user, displayName: "Persistent display name" };
  assert.deepEqual(await save(browser, ` ${expected.displayName} `), { user: expected });
  // createPlatformClient reads /api/session when it builds bootstrap.user.
  assert.deepEqual(await session(otherSession), expected);
  await f.restart();
  assert.deepEqual(await session(browser), expected);
  assert.deepEqual(await session(otherSession), expected);
  assert.deepEqual(status(await browser.request("/api/auth/github/status"), 200), methods);
  assert.deepEqual(await save(browser, expected.displayName), { user: expected });
  const login = f.browser();
  assert.deepEqual(status(await login.request("/api/auth/login", {
    method: "POST", body: { handle: user.handle, password },
  }), 200).user, expected);
});

test("account profile preserves old author snapshots and new checkpoints use the saved name", async (t) => {
  const f = await fixture(t);
  const browser = f.browser();
  const user = await register(browser, "alice");
  const page = status(await browser.request("/api/v1/pages", {
    method: "POST", body: { title: "Before rename", text: "Original text" },
  }), 201);
  const checkpointPath = `/api/v1/pages/${page.id}/checkpoint`;
  const versionsPath = `/api/v1/pages/${page.id}/versions`;
  const old = status(await browser.request(checkpointPath, { method: "POST", body: { summary: "Before rename" } }), 200);
  assert.equal(old.author_id, user.id);
  assert.equal(old.author_name, user.displayName);
  const before = status(await browser.request(versionsPath), 200);

  const displayName = "New author name";
  await save(browser, displayName);
  assert.deepEqual(status(await browser.request(versionsPath), 200), before);
  const unchanged = status(await browser.request(`/api/v1/pages/${page.id}`), 200);
  assert.deepEqual(unchanged.page, page.page);
  status(await browser.request(`/api/v1/pages/${page.id}`, {
    method: "PATCH", body: { title: "After rename", baseRevision: unchanged.revision },
  }), 200);
  const next = status(await browser.request(checkpointPath, { method: "POST", body: { summary: "After rename" } }), 200);
  assert.notEqual(next.id, old.id);
  assert.equal(next.author_id, user.id);
  assert.equal(next.author_name, displayName);
  const after = status(await browser.request(versionsPath), 200);
  assert.deepEqual(after.find((version: Json) => version.id === old.id), old);
});

async function githubLogin(browser: Browser, stub: Awaited<ReturnType<typeof startGithubStub>>, identity: StubIdentity) {
  stub.queue.push(identity);
  const start = await browser.request("/api/auth/github");
  status(start, 302);
  const authorize = start.headers.get("location");
  assert.ok(authorize);
  const provider = await fetch(authorize, { redirect: "manual" });
  await provider.arrayBuffer();
  assert.equal(provider.status, 302);
  const location = provider.headers.get("location");
  assert.ok(location);
  const callback = new URL(location);
  const finish = await browser.request(callback.pathname + callback.search);
  status(finish, 302);
  assert.equal(finish.headers.get("location"), "/");
  return session(browser);
}

test("account profile preserves GitHub-only login identity and the saved name on later sign-in", async (t) => {
  const stub = await startGithubStub();
  t.after(() => stub.close());
  const f = await fixture(t, githubConfig(stub));
  const browser = f.browser();
  const identity = { id: 1234, login: "octocat", name: "Provider name" };
  const user = await githubLogin(browser, stub, identity);
  const methods = status(await browser.request("/api/auth/github/status"), 200);
  assert.equal(methods.hasPassword, false);
  assert.equal(methods.canUnlink, false);
  assert.deepEqual(methods.identity, { id: String(identity.id), login: identity.login });
  const expected = { ...user, displayName: "Local display name" };
  assert.deepEqual(await save(browser, expected.displayName), { user: expected });
  assert.deepEqual(status(await browser.request("/api/auth/github/status"), 200), methods);
  await f.restart();
  assert.deepEqual(await session(browser), expected);
  assert.deepEqual(status(await browser.request("/api/auth/github/status"), 200), methods);
  status(await browser.request("/api/auth/logout", { method: "POST" }), 200);
  assert.deepEqual(await githubLogin(browser, stub, { ...identity, name: "Updated provider name" }), expected);
  assert.deepEqual(status(await browser.request("/api/auth/github/status"), 200), methods);
});
