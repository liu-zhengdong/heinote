import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { startServer } from "../server/index.ts";
import {
  Browser,
  githubConfig,
  startGithubStub,
  type GithubConfig,
  type GithubStub,
  type Json,
  type Reply,
  type StubIdentity,
} from "./helpers/github.ts";

// HTTP acceptance for UC-11 GitHub sign-in. Everything goes through the real
// HTTP boundary plus a scripted GitHub stand-in; no internals are imported.
type RunningServer = Awaited<ReturnType<typeof startServer>>;
type ServerOptions = Parameters<typeof startServer>[0];

interface FixtureOptions {
  github?: GithubConfig | null;
  registrationOpen?: boolean;
}

const checkDirectory = async (directory: string) => {
  const target = resolve(directory);
  assert.equal(dirname(target), resolve(tmpdir()));
  assert.ok(basename(target).startsWith("terminus-notes-github-"));
  await rm(target, { recursive: true, force: true });
};

// Boot a throwaway server for configuration tests. The temp directory is
// cleaned even when boot itself fails.
async function boot(t: TestContext, options: ServerOptions): Promise<RunningServer> {
  const directory = await mkdtemp(join(tmpdir(), "terminus-notes-github-"));
  let server: RunningServer;
  try {
    server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false, ...options });
  } catch (error) {
    await checkDirectory(directory);
    throw error;
  }
  t.after(async () => {
    await server.close();
    await checkDirectory(directory);
  });
  return server;
}

// Assert startServer rejects a configuration; returns the thrown error.
async function bootFails(t: TestContext, options: ServerOptions): Promise<Error> {
  const directory = await mkdtemp(join(tmpdir(), "terminus-notes-github-"));
  t.after(() => checkDirectory(directory));
  const outcome = await Promise.resolve()
    .then(() => startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false, ...options }))
    .then((server) => ({ server }), (error: Error) => ({ error }));
  if ("server" in outcome) {
    await outcome.server.close();
    assert.fail(`startServer accepted an invalid GitHub config: ${JSON.stringify(options)}`);
  }
  return outcome.error;
}

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "terminus-notes-github-"));
  const stub = await startGithubStub();
  let serverOptions: FixtureOptions = { github: githubConfig(stub), ...options };
  let server: RunningServer = await startServer({
    dataDir: directory,
    port: 0,
    host: "127.0.0.1",
    serveStatic: false,
    ...serverOptions,
  });
  t.after(async () => {
    await server.close();
    await stub.close();
    await checkDirectory(directory);
  });
  return {
    stub,
    url: () => server.url,
    browser: () => new Browser(() => server.url),
    async restart(next: FixtureOptions = {}) {
      serverOptions = { ...serverOptions, ...next };
      await server.close();
      server = await startServer({
        dataDir: directory,
        port: 0,
        host: "127.0.0.1",
        serveStatic: false,
        ...serverOptions,
      });
    },
  };
}

function status(reply: Reply, expected: number): Json {
  assert.equal(reply.status, expected, JSON.stringify(reply.body));
  return reply.body;
}

function denied(reply: Reply): void {
  assert.ok([401, 403, 404].includes(reply.status), `Expected access refusal, got ${reply.status}: ${JSON.stringify(reply.body)}`);
}

function refused(reply: Reply): void {
  assert.ok(reply.status >= 400 && reply.status < 500, `Expected a 4xx refusal, got ${reply.status}: ${JSON.stringify(reply.body)}`);
}

// Refusal that also tolerates an explicit "unavailable" 5xx.
function rejected(reply: Reply): void {
  assert.ok(reply.status >= 400, `Expected refusal, got ${reply.status}: ${JSON.stringify(reply.body)}`);
}

function redirectTo(reply: Reply): URL {
  assert.equal(reply.status, 302, `Expected a redirect, got ${reply.status}: ${JSON.stringify(reply.body)}`);
  const location = reply.headers.get("location");
  assert.ok(location, "Redirect must carry a Location header");
  return new URL(location, "http://notes.test");
}

// Fixed error codes land as /?github=<code> on the app root.
function githubError(reply: Reply, code: string): void {
  const url = redirectTo(reply);
  assert.equal(url.pathname, "/");
  assert.equal(url.searchParams.get("github"), code);
}

function signupTicket(reply: Reply): string {
  const url = redirectTo(reply);
  assert.equal(url.pathname, "/");
  const ticket = url.searchParams.get("github_signup");
  assert.ok(ticket, `Expected a github_signup ticket, got ${url}`);
  return ticket;
}

const password = "Correct-horse-battery-2026!";

async function register(browser: Browser, handle: string): Promise<Json> {
  status(await browser.request("/api/auth/register", {
    method: "POST",
    body: { handle, displayName: handle.toUpperCase(), password },
  }), 201);
  const session = status(await browser.request("/api/session"), 200);
  assert.equal(session.user.handle, handle);
  return session.user;
}

function page(id: string, author: string, fields: Record<string, unknown> = {}) {
  return {
    id,
    title_content: [{ text: id }],
    icon: "",
    kind: "document",
    created_at: "2026-11-03T00:00:00.000Z",
    updated_at: "2026-11-03T00:00:00.000Z",
    created_by: author,
    updated_by: author,
    ...fields,
  };
}

async function put(browser: Browser, scope: string, collection: string, id: string, value: unknown) {
  return status(await browser.structure(`/api/records/${scope}/${collection}/${id}`, {
    method: "POST",
    body: { action: "put", value },
  }), 200);
}

// ---- OAuth flow helpers ----------------------------------------------------

// Start a login authorization request and return the provider URL the user is
// sent to. The identity the stub will return is queued first.
async function startGithubLogin(browser: Browser, stub: GithubStub, identity: StubIdentity = { id: 1001, login: "octocat" }): Promise<URL> {
  stub.queue.push(identity);
  const reply = await browser.request("/api/auth/github");
  const authorize = redirectTo(reply);
  assert.ok(authorize.href.startsWith(`${stub.url}/`), `Expected a redirect to the provider, got ${authorize.href}`);
  return authorize;
}

// Follow the provider authorize URL, then return the Notes callback location.
// The provider hop is a plain fetch; cookies stay with the Notes origin.
async function followProvider(authorize: URL): Promise<string> {
  const providerReply = await fetch(authorize.href, { redirect: "manual" });
  await providerReply.arrayBuffer();
  assert.ok(providerReply.status >= 300 && providerReply.status < 400, `Provider must redirect back, got ${providerReply.status}`);
  const location = providerReply.headers.get("location");
  assert.ok(location, "Provider redirect must carry a Location header");
  const callback = new URL(location);
  return callback.pathname + callback.search;
}

// Drive the whole login: authorize -> provider -> callback reply.
async function finishGithubLogin(browser: Browser, stub: GithubStub, identity: StubIdentity = { id: 1001, login: "octocat" }): Promise<Reply> {
  const authorize = await startGithubLogin(browser, stub, identity);
  return browser.request(await followProvider(authorize));
}

// Full round trip: authorize -> callback -> 302 "/" with a local session.
async function githubLogin(browser: Browser, stub: GithubStub, identity: StubIdentity = { id: 1001, login: "octocat" }): Promise<Json> {
  const reply = await finishGithubLogin(browser, stub, identity);
  const home = redirectTo(reply);
  assert.equal(home.pathname, "/");
  assert.equal(home.search, "");
  const session = status(await browser.request("/api/session"), 200);
  assert.ok(session.user?.id, "GitHub login must establish a local session");
  return session.user;
}

// POST /api/auth/github/link -> provider -> callback -> ?github=linked.
async function linkGithub(browser: Browser, stub: GithubStub, identity: StubIdentity): Promise<Json> {
  const { url } = status(await browser.request("/api/auth/github/link", { method: "POST" }), 200);
  assert.ok(url, "link must return an authorize url");
  stub.queue.push(identity);
  const reply = await browser.request(await followProvider(new URL(url)));
  const home = redirectTo(reply);
  assert.equal(home.pathname, "/");
  assert.equal(home.searchParams.get("github"), "linked");
  const linkStatus = status(await browser.request("/api/auth/github/status"), 200);
  assert.equal(linkStatus.identity?.id, String(identity.id));
  assert.equal(linkStatus.identity?.login, identity.login);
  return linkStatus;
}

// ---- Tests -----------------------------------------------------------------

test("disabled configuration hides the entry and refuses the flow routes", async (t) => {
  const f = await fixture(t, { github: null });
  const anonymous = f.browser();
  const session = status(await anonymous.request("/api/session"), 200);
  assert.ok(!session.githubEnabled, "githubEnabled must report disabled");
  denied(await anonymous.request("/api/auth/github/status"));
  for (const reply of [
    await anonymous.request("/api/auth/github"),
    await anonymous.request("/api/auth/github/link", { method: "POST" }),
    await anonymous.request("/api/auth/github/signup?ticket=fake"),
    await anonymous.request("/api/auth/github/signup", { method: "POST", body: { ticket: "fake" } }),
    await anonymous.request("/api/auth/github/signup", { method: "DELETE", body: { ticket: "fake" } }),
  ]) {
    rejected(reply);
    assert.notEqual(reply.status, 302, "A disabled provider must never redirect into the flow");
  }
  // The callback may refuse outright or bounce to the fixed error page; either
  // way no session and no account may appear.
  const callback = await anonymous.request("/api/auth/github/callback?code=fake&state=fake");
  if (callback.status === 302) {
    const home = redirectTo(callback);
    assert.equal(home.pathname, "/");
    assert.match(home.searchParams.get("github") ?? "", /^(disabled|invalid_request)$/);
  } else rejected(callback);
  assert.equal(status(await anonymous.request("/api/session"), 200).user, null);
  assert.equal(status(await anonymous.request("/api/session"), 200).githubEnabled ?? false, false);
  const alice = f.browser();
  await register(alice, "alice");
  const linkStatus = await alice.request("/api/auth/github/status");
  if (linkStatus.status === 200) assert.equal(linkStatus.body.enabled, false);
  else rejected(linkStatus);
  rejected(await alice.request("/api/auth/github/link", { method: "POST" }));
  // Unlink stays usable on a password account while disabled: idempotent no-op.
  const unlinked = status(await alice.request("/api/auth/github/link", { method: "DELETE" }), 200);
  assert.deepEqual(unlinked.identity, null);
  // Password sign-in stays the only available path while disabled.
  status(await f.browser().request("/api/auth/login", {
    method: "POST",
    body: { handle: "alice", password },
  }), 200);
});

test("GitHub entry reports availability and first sign-in round-trips through the provider", async (t) => {
  const f = await fixture(t);
  const browser = f.browser();
  assert.equal(status(await browser.request("/api/session"), 200).githubEnabled, true);
  denied(await browser.request("/api/auth/github/status"));

  const authorize = await startGithubLogin(browser, f.stub, { id: 7001, login: "octocat", name: "Octo Cat" });
  assert.equal(authorize.pathname, "/authorize");
  assert.equal(authorize.searchParams.get("client_id"), f.stub.clientId);
  assert.equal(authorize.searchParams.get("redirect_uri"), `${serverUrl(f)}/api/auth/github/callback`);
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorize.searchParams.get("code_challenge")!.length >= 20, "PKCE challenge required");
  assert.ok(authorize.searchParams.get("state")!.length >= 20, "one-time state required");
  assert.ok(!authorize.searchParams.get("scope"), "no extra scopes are requested");

  const callback = await browser.request(await followProvider(authorize));
  const home = redirectTo(callback);
  assert.equal(home.pathname, "/");
  assert.equal(home.search, "");
  const user = status(await browser.request("/api/session"), 200).user;
  assert.ok(user?.id, "GitHub sign-in must establish a local session");
  assert.equal(user.siteRole, "admin", "first account on an empty database stays admin");

  // The token exchange proved client_secret and PKCE to the stub.
  assert.equal(f.stub.tokenRequests.length, 1);
  assert.equal(f.stub.tokenRequests[0].client_secret, f.stub.clientSecret);
  assert.equal(f.stub.tokenRequests[0].client_id, f.stub.clientId);
  assert.ok(f.stub.tokenRequests[0].code_verifier, "PKCE verifier must reach the provider");

  const linkStatus = status(await browser.request("/api/auth/github/status"), 200);
  assert.equal(linkStatus.enabled, true);
  assert.deepEqual(linkStatus.identity, { id: "7001", login: "octocat" });
  assert.equal(linkStatus.hasPassword, false);
  assert.equal(linkStatus.canUnlink, false, "the only sign-in method cannot be unlinked");

  // The same GitHub identity signs into the same Notes account again.
  const again = f.browser();
  const sameUser = await githubLogin(again, f.stub, { id: 7001, login: "octocat" });
  assert.equal(sameUser.id, user.id);

  // A passwordless account refuses password sign-in with 401, not a 500.
  status(await f.browser().request("/api/auth/login", {
    method: "POST",
    body: { handle: user.handle, password: "any-password-guess" },
  }), 401);
});

function serverUrl(f: Awaited<ReturnType<typeof fixture>>): string {
  return f.url();
}

test("cancelled, mismatched, expired, and replayed callbacks never create accounts or sessions", async (t) => {
  const f = await fixture(t);
  let clock = Date.now();
  await f.restart({ github: githubConfig(f.stub, () => clock) });

  // The user denies the authorization at the provider.
  const denying = f.browser();
  const deniedAuthorize = await startGithubLogin(denying, f.stub, { id: 7101, login: "denied_user", deny: true });
  githubError(await denying.request(await followProvider(deniedAuthorize)), "cancelled");
  assert.equal(status(await denying.request("/api/session"), 200).user, null);

  // A callback with an unknown state is an invalid request.
  githubError(await f.browser().request("/api/auth/github/callback?code=whatever&state=forged"), "invalid_request");

  // A state older than the request lifetime is rejected.
  const stale = f.browser();
  const staleAuthorize = await startGithubLogin(stale, f.stub, { id: 7102, login: "stale_user" });
  const staleCallback = await followProvider(staleAuthorize);
  clock += 2 * 60 * 60 * 1000;
  githubError(await stale.request(staleCallback), "invalid_request");
  assert.equal(status(await stale.request("/api/session"), 200).user, null);
  clock = Date.now();

  // A successful callback consumes both the state and the provider code.
  const first = f.browser();
  const replayAuthorize = await startGithubLogin(first, f.stub, { id: 7103, login: "replayed" });
  const replayCallback = await followProvider(replayAuthorize);
  redirectTo(await first.request(replayCallback));
  githubError(await first.request(replayCallback), "invalid_request");
  githubError(await f.browser().request(replayCallback), "invalid_request");
  const users = status(await first.request("/api/admin/users"), 200);
  assert.equal(users.length, 1, "replayed callbacks must not create accounts");

  // A foreign browser cannot redeem another browser's authorization.
  const owner = f.browser();
  const foreign = f.browser();
  const boundAuthorize = await startGithubLogin(owner, f.stub, { id: 7104, login: "bound_browser" });
  const boundCallback = await followProvider(boundAuthorize);
  githubError(await foreign.request(boundCallback), "invalid_request");
  assert.equal(status(await foreign.request("/api/session"), 200).user, null);
  // The state stays valid for the browser it was issued to.
  redirectTo(await owner.request(boundCallback));
  assert.ok(status(await owner.request("/api/session"), 200).user?.id);
});

test("provider outages report unavailable and keep prior sessions and records", async (t) => {
  const f = await fixture(t);
  const browser = f.browser();
  const user = await githubLogin(browser, f.stub, { id: 7201, login: "survivor" });
  await put(browser, "personal", "pages", "survivor_page", page("survivor_page", user.id));

  // The token exchange fails.
  let victim = f.browser();
  const tokenDown = await startGithubLogin(victim, f.stub, { id: 7202, login: "token_down", tokenFails: true });
  githubError(await victim.request(await followProvider(tokenDown)), "unavailable");
  assert.equal(status(await victim.request("/api/session"), 200).user, null);

  // The identity endpoint fails after a good token exchange.
  victim = f.browser();
  const userDown = await startGithubLogin(victim, f.stub, { id: 7203, login: "user_down", userFails: true });
  githubError(await victim.request(await followProvider(userDown)), "unavailable");
  assert.equal(status(await victim.request("/api/session"), 200).user, null);

  // The whole provider is down.
  victim = f.browser();
  f.stub.down = true;
  const outage = await startGithubLogin(victim, f.stub);
  githubError(await victim.request(await followProvider(outage)), "unavailable");
  f.stub.down = false;

  // The earlier session and private records are untouched by the failures.
  const session = status(await browser.request("/api/session"), 200);
  assert.equal(session.user?.id, user.id);
  assert.equal(status(await browser.request("/api/records/personal/pages"), 200)[0].id, "survivor_page");
});

test("closed registration rejects new identities but keeps existing logins, links, and the first admin", async (t) => {
  const f = await fixture(t, { registrationOpen: false });

  // On an empty database the first GitHub identity still becomes the admin.
  const admin = f.browser();
  const adminUser = await githubLogin(admin, f.stub, { id: 7301, login: "founder" });
  assert.equal(adminUser.siteRole, "admin");

  // A brand new identity is refused once an account exists.
  const newcomer = f.browser();
  githubError(await finishGithubLogin(newcomer, f.stub, { id: 7302, login: "newcomer" }), "registration_closed");
  assert.equal(status(await newcomer.request("/api/session"), 200).user, null);

  // An already linked identity still signs in while registration is closed.
  const returning = f.browser();
  const sameUser = await githubLogin(returning, f.stub, { id: 7301, login: "founder" });
  assert.equal(sameUser.id, adminUser.id);

  // Password registration is closed too; linking stays open for signed-in users.
  const worker = f.browser();
  status(await worker.request("/api/auth/register", {
    method: "POST",
    body: { handle: "worker", displayName: "Worker", password },
  }), 403);
  // Seed a password account through an open-registration server, then close it.
  await f.restart({ registrationOpen: true });
  const seeded = f.browser();
  await register(seeded, "seeded");
  await f.restart({ registrationOpen: false });
  status(await seeded.request("/api/auth/login", {
    method: "POST",
    body: { handle: "seeded", password },
  }), 200);
  const linkStatus = await linkGithub(seeded, f.stub, { id: 7303, login: "seeded_gh" });
  assert.equal(linkStatus.identity?.id, "7303", "closed registration must not block linking");
});

test("a matching handle never merges: signup ticket offers a new unique account", async (t) => {
  const f = await fixture(t);
  const carol = f.browser();
  const carolUser = await register(carol, "carol");
  await put(carol, "personal", "pages", "carol_page", page("carol_page", carolUser.id));

  // A GitHub identity whose login matches an existing handle gets a ticket.
  const visitor = f.browser();
  const ticket = signupTicket(await finishGithubLogin(visitor, f.stub, { id: 7401, login: "carol", name: "Carol Github" }));
  assert.equal(status(await visitor.request("/api/session"), 200).user, null, "the ticket must not sign anyone in");

  // The ticket exposes the suggested identity without a session.
  const offer = status(await visitor.request(`/api/auth/github/signup?ticket=${encodeURIComponent(ticket)}`), 200);
  assert.equal(offer.login, "carol");
  assert.equal(typeof offer.displayName, "string");

  // The ticket binds the browser: a stranger cannot read or confirm it.
  const stranger = f.browser();
  refused(await stranger.request(`/api/auth/github/signup?ticket=${encodeURIComponent(ticket)}`));
  refused(await stranger.request("/api/auth/github/signup", { method: "POST", body: { ticket } }));

  // Confirming creates a distinct account and signs the browser in.
  const confirmed = status(await visitor.request("/api/auth/github/signup", { method: "POST", body: { ticket } }), 201);
  assert.notEqual(confirmed.user.id, carolUser.id, "same-name signup must never reuse the existing account");
  assert.notEqual(confirmed.user.handle, "carol", "the new account gets a unique handle");
  assert.equal(status(await visitor.request("/api/session"), 200).user?.id, confirmed.user.id);

  // A spent ticket is gone, and the original account is untouched.
  refused(await visitor.request("/api/auth/github/signup", { method: "POST", body: { ticket } }));
  assert.equal(status(await carol.request("/api/records/personal/pages"), 200)[0].id, "carol_page");
  assert.deepEqual(status(await carol.request("/api/auth/github/status"), 200).identity, null);

  // The new GitHub identity now signs straight in.
  const again = f.browser();
  const sameNew = await githubLogin(again, f.stub, { id: 7401, login: "carol" });
  assert.equal(sameNew.id, confirmed.user.id);

  // Cancelling a different ticket leaves the identity unregistered.
  const undecided = f.browser();
  const spare = signupTicket(await finishGithubLogin(undecided, f.stub, { id: 7402, login: "carol" }));
  status(await undecided.request("/api/auth/github/signup", { method: "DELETE", body: { ticket: spare } }), 200);
  refused(await undecided.request("/api/auth/github/signup", { method: "POST", body: { ticket: spare } }));
  // The cancelled identity may start over and take the ticket again.
  const retry = f.browser();
  const renewed = signupTicket(await finishGithubLogin(retry, f.stub, { id: 7402, login: "carol" }));
  const retryConfirm = status(await retry.request("/api/auth/github/signup", { method: "POST", body: { ticket: renewed } }), 201);
  assert.notEqual(retryConfirm.user.id, confirmed.user.id, "each GitHub id maps to exactly one account");
});

test("signup tickets expire and require the issuing session", async (t) => {
  const f = await fixture(t);
  let clock = Date.now();
  await f.restart({ github: githubConfig(f.stub, () => clock) });
  const owner = f.browser();
  await register(owner, "holder");

  // Expired tickets are refused everywhere.
  const visitor = f.browser();
  const stale = signupTicket(await finishGithubLogin(visitor, f.stub, { id: 7501, login: "holder" }));
  clock += 2 * 60 * 60 * 1000;
  refused(await visitor.request(`/api/auth/github/signup?ticket=${encodeURIComponent(stale)}`));
  refused(await visitor.request("/api/auth/github/signup", { method: "POST", body: { ticket: stale } }));
  refused(await visitor.request("/api/auth/github/signup", { method: "DELETE", body: { ticket: stale } }));
  clock = Date.now();

  // A session change between callback and confirm invalidates the ticket.
  const switcher = f.browser();
  const switched = signupTicket(await finishGithubLogin(switcher, f.stub, { id: 7502, login: "holder" }));
  status(await switcher.request("/api/auth/login", {
    method: "POST",
    body: { handle: "holder", password },
  }), 200);
  refused(await switcher.request("/api/auth/github/signup", { method: "POST", body: { ticket: switched } }));

  // A fresh ticket still confirms once the session is stable again.
  const steady = f.browser();
  const valid = signupTicket(await finishGithubLogin(steady, f.stub, { id: 7503, login: "holder" }));
  status(await steady.request("/api/auth/github/signup", { method: "POST", body: { ticket: valid } }), 201);
});

test("linking binds one GitHub identity per account and survives duplicates", async (t) => {
  const f = await fixture(t);
  const alice = f.browser();
  const aliceUser = await register(alice, "alice");

  const linked = await linkGithub(alice, f.stub, { id: 7601, login: "alice_gh" });
  assert.equal(linked.hasPassword, true);
  assert.equal(linked.canUnlink, true);
  assert.equal(status(await alice.request("/api/session"), 200).user?.id, aliceUser.id);

  // Repeating the same link is a successful no-op.
  const again = status(await alice.request("/api/auth/github/link", { method: "POST" }), 200);
  f.stub.queue.push({ id: 7601, login: "alice_gh" });
  const repeated = await alice.request(await followProvider(new URL(again.url)));
  githubError(repeated, "linked");
  assert.equal(status(await alice.request("/api/auth/github/status"), 200).identity?.id, "7601");

  // The linked identity also signs in through the plain login flow.
  const inbound = f.browser();
  const viaLogin = await githubLogin(inbound, f.stub, { id: 7601, login: "alice_gh" });
  assert.equal(viaLogin.id, aliceUser.id);
});

test("link conflicts refuse foreign identities and session changes never mislink", async (t) => {
  const f = await fixture(t);
  const alice = f.browser();
  const bob = f.browser();
  const aliceUser = await register(alice, "alice");
  const bobUser = await register(bob, "bob");
  await linkGithub(alice, f.stub, { id: 7701, login: "alice_gh" });

  // An identity already bound to another account cannot be taken over.
  const { url: steal } = status(await bob.request("/api/auth/github/link", { method: "POST" }), 200);
  f.stub.queue.push({ id: 7701, login: "alice_gh" });
  githubError(await bob.request(await followProvider(new URL(steal))), "identity_in_use");
  assert.deepEqual(status(await bob.request("/api/auth/github/status"), 200).identity, null);

  // One GitHub identity per account: a second identity is refused.
  const { url: second } = status(await alice.request("/api/auth/github/link", { method: "POST" }), 200);
  f.stub.queue.push({ id: 7702, login: "other_gh" });
  githubError(await alice.request(await followProvider(new URL(second))), "already_linked");
  assert.equal(status(await alice.request("/api/auth/github/status"), 200).identity?.id, "7701");

  // Switching accounts mid-flow refuses the callback and binds nobody.
  const { url: switched } = status(await alice.request("/api/auth/github/link", { method: "POST" }), 200);
  f.stub.queue.push({ id: 7703, login: "switch_gh" });
  status(await alice.request("/api/auth/login", {
    method: "POST",
    body: { handle: "bob", password },
  }), 200);
  githubError(await alice.request(await followProvider(new URL(switched))), "session_changed");
  for (const [browser, userId] of [[alice, bobUser.id], [bob, bobUser.id]] as const) {
    const linkStatus = status(await browser.request("/api/auth/github/status"), 200);
    assert.deepEqual(linkStatus.identity, null, `session ${userId} must not gain a stray link`);
  }
  // Identity 7703 stayed unlinked and may register on its own.
  const fresh = f.browser();
  const newUser = await githubLogin(fresh, f.stub, { id: 7703, login: "switch_gh" });
  assert.notEqual(newUser.id, aliceUser.id);
  assert.notEqual(newUser.id, bobUser.id);
});

test("unlinked accounts refuse passwordless unlink and keep sign-in methods honest", async (t) => {
  const f = await fixture(t);
  const pure = f.browser();
  const pureUser = await githubLogin(pure, f.stub, { id: 7801, login: "pure_gh" });

  // The only sign-in method cannot be removed.
  const blocked = await pure.request("/api/auth/github/link", { method: "DELETE" });
  assert.equal(blocked.status, 409);
  const stillLinked = status(await pure.request("/api/auth/github/status"), 200);
  assert.equal(stillLinked.identity?.id, "7801");
  assert.equal(stillLinked.canUnlink, false);

  // A password account unlinks, keeps its session, and stays password-loginable.
  const mixed = f.browser();
  const mixedUser = await register(mixed, "mixed");
  await linkGithub(mixed, f.stub, { id: 7802, login: "mixed_gh" });
  const unlinked = status(await mixed.request("/api/auth/github/link", { method: "DELETE" }), 200);
  assert.deepEqual(unlinked.identity, null);
  assert.equal(unlinked.hasPassword, true);
  assert.equal(status(await mixed.request("/api/session"), 200).user?.id, mixedUser.id);
  // Repeating the unlink is idempotent.
  const again = status(await mixed.request("/api/auth/github/link", { method: "DELETE" }), 200);
  assert.deepEqual(again.identity, null);
  status(await f.browser().request("/api/auth/login", {
    method: "POST",
    body: { handle: "mixed", password },
  }), 200);
  // The released identity may link or sign in elsewhere.
  const elsewhere = f.browser();
  const rebound = await githubLogin(elsewhere, f.stub, { id: 7802, login: "mixed_gh" });
  assert.notEqual(rebound.id, mixedUser.id, "an unlinked identity becomes a fresh registration");
  assert.notEqual(rebound.id, pureUser.id);
});

test("GitHub rename keeps the numeric id mapping and private records stay private", async (t) => {
  const f = await fixture(t);
  const browser = f.browser();
  const user = await githubLogin(browser, f.stub, { id: 7901, login: "old_name" });
  await put(browser, "personal", "pages", "gh_private", page("gh_private", user.id));

  // The provider renames the account; the numeric id still finds it.
  const renamed = f.browser();
  const same = await githubLogin(renamed, f.stub, { id: 7901, login: "new_name" });
  assert.equal(same.id, user.id);

  // Another site admin cannot read the private page of a GitHub account.
  const boss = f.browser();
  const bossUser = await register(boss, "boss");
  status(await browser.request(`/api/admin/users/${bossUser.id}`, { method: "PATCH", body: { siteRole: "admin" } }), 200);
  assert.deepEqual(status(await browser.request("/api/records/personal/pages"), 200).map((row: Json) => row.id), ["gh_private"]);
  assert.equal(status(await boss.request("/api/records/personal/pages"), 200).length, 0);
  denied(await f.browser().request("/api/records/personal/pages"));
});

test("linked identities, sessions, and private records survive a restart", async (t) => {
  const f = await fixture(t);
  const browser = f.browser();
  const user = await githubLogin(browser, f.stub, { id: 7951, login: "durable" });
  await put(browser, "personal", "pages", "durable_page", page("durable_page", user.id));

  await f.restart();
  assert.equal(status(await browser.request("/api/session"), 200).user?.id, user.id);
  assert.deepEqual(status(await browser.request("/api/auth/github/status"), 200).identity, { id: "7951", login: "durable" });
  assert.equal(status(await browser.request("/api/records/personal/pages"), 200)[0].id, "durable_page");

  // A new browser signs the same GitHub identity into the same account.
  const resumed = f.browser();
  const same = await githubLogin(resumed, f.stub, { id: 7951, login: "durable" });
  assert.equal(same.id, user.id);
});

test("concurrent first sign-ins and repeated confirms converge on one account", async (t) => {
  const f = await fixture(t);
  const first = f.browser();
  const second = f.browser();
  const one = await startGithubLogin(first, f.stub, { id: 7971, login: "racer" });
  const two = await startGithubLogin(second, f.stub, { id: 7971, login: "racer" });
  const [callbackOne, callbackTwo] = await Promise.all([followProvider(one), followProvider(two)]);
  const [doneOne, doneTwo] = await Promise.all([
    first.request(callbackOne),
    second.request(callbackTwo),
  ]);
  redirectTo(doneOne);
  redirectTo(doneTwo);
  const [userOne, userTwo] = await Promise.all([
    first.request("/api/session"),
    second.request("/api/session"),
  ]);
  const idOne = status(userOne, 200).user?.id;
  const idTwo = status(userTwo, 200).user?.id;
  assert.ok(idOne);
  assert.equal(idTwo, idOne, "racing first sign-ins must land on one account");

  // The same-name branch converges the same way on ticket confirm.
  const holder = f.browser();
  await register(holder, "raced_handle");
  const visitorA = f.browser();
  const visitorB = f.browser();
  const ticketA = signupTicket(await finishGithubLogin(visitorA, f.stub, { id: 7972, login: "raced_handle" }));
  const ticketB = signupTicket(await finishGithubLogin(visitorB, f.stub, { id: 7972, login: "raced_handle" }));
  const [confirmA, confirmB] = await Promise.all([
    visitorA.request("/api/auth/github/signup", { method: "POST", body: { ticket: ticketA } }),
    visitorB.request("/api/auth/github/signup", { method: "POST", body: { ticket: ticketB } }),
  ]);
  assert.ok([200, 201].includes(confirmA.status));
  assert.ok([200, 201].includes(confirmB.status));
  assert.equal(status(await visitorA.request("/api/session"), 200).user?.id, status(await visitorB.request("/api/session"), 200).user?.id);
});

test("cross-site requests are refused on the entry but the provider callback stays legal", async (t) => {
  const f = await fixture(t);
  const guard = f.browser();
  await register(guard, "guard");
  const evil = { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" };

  // Cross-site navigations and fetch metadata must not start the OAuth flow.
  const crossSite = await guard.request("/api/auth/github", {
    headers: { "Sec-Fetch-Site": "cross-site", Referer: "https://evil.example/" },
  });
  assert.equal(crossSite.status, 403);
  const evilOrigin = await guard.request("/api/auth/github", {
    headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
  });
  assert.equal(evilOrigin.status, 403);
  const evilReferer = await guard.request("/api/auth/github", {
    headers: { Referer: "https://evil.example/page" },
  });
  assert.equal(evilReferer.status, 403);
  // None of the refused attempts consumed a provider identity.
  assert.equal(f.stub.tokenRequests.length, 0);

  // The mutating routes keep the existing cross-site protections.
  assert.equal((await guard.request("/api/auth/github/link", { method: "POST", headers: evil })).status, 403);
  assert.equal((await guard.request("/api/auth/github/link", { method: "DELETE", headers: evil })).status, 403);
  assert.equal((await guard.request("/api/auth/github/signup", { method: "POST", headers: { ...evil }, body: { ticket: "x" } })).status, 403);
  assert.equal((await guard.request("/api/auth/github/signup", { method: "DELETE", headers: { ...evil }, body: { ticket: "x" } })).status, 403);

  // A cross-site GET on the callback is the legitimate GitHub bounce-back.
  const { url } = status(await guard.request("/api/auth/github/link", { method: "POST" }), 200);
  f.stub.queue.push({ id: 7961, login: "guard_gh" });
  const callback = await followProvider(new URL(url));
  const reply = await guard.request(callback, {
    headers: { Origin: null, "Sec-Fetch-Site": "cross-site", Referer: "https://github.com/" },
  });
  const home = redirectTo(reply);
  assert.equal(home.searchParams.get("github"), "linked");
  assert.equal(status(await guard.request("/api/auth/github/status"), 200).identity?.id, "7961");
});

test("logging out while the token exchange is in flight voids the link", async (t) => {
  const f = await fixture(t);
  const alice = f.browser();
  const aliceUser = await register(alice, "alice");

  // Hold the provider's token response, then start the link callback.
  const gate = f.stub.gateToken();
  const { url } = status(await alice.request("/api/auth/github/link", { method: "POST" }), 200);
  f.stub.queue.push({ id: 7981, login: "midflight" });
  const callback = await followProvider(new URL(url));
  const pending = alice.request(callback);
  await gate.arrived;

  // The initiating session dies mid-exchange.
  const twin = f.browser();
  twin.cookie = alice.cookie;
  status(await twin.request("/api/auth/logout", { method: "POST" }), 200);
  gate.release();

  // The callback must not bind an identity to a destroyed session.
  githubError(await pending, "session_changed");
  assert.equal(status(await alice.request("/api/session"), 200).user, null);
  denied(await alice.request("/api/auth/github/status"));

  // The unlinked identity stays usable: a fresh login binds it cleanly.
  status(await alice.request("/api/auth/login", {
    method: "POST",
    body: { handle: "alice", password },
  }), 200);
  const relinked = await linkGithub(alice, f.stub, { id: 7981, login: "midflight" });
  assert.equal(relinked.identity?.id, "7981");
  assert.equal(status(await alice.request("/api/session"), 200).user?.id, aliceUser.id);
});

test("production GitHub configuration is validated before the server accepts traffic", async (t) => {
  const secret = "gh_secret_TEST_VALUE";
  const envKeys = ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "PUBLIC_URL"];
  const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const restore = () => {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
  const withEnv = async (env: Record<string, string | undefined>, run: () => Promise<void>) => {
    restore();
    for (const key of envKeys) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    try {
      await run();
    } finally {
      restore();
    }
  };
  const githubEnabled = async (server: RunningServer) => status(await new Browser(() => server.url).request("/api/session"), 200).githubEnabled;

  try {
    // Both fields unset or empty means disabled, not a startup failure.
    await withEnv({}, async () => {
      assert.ok(!await githubEnabled(await boot(t, {})));
    });
    await withEnv({ GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "  ", PUBLIC_URL: "https://notes.example" }, async () => {
      assert.ok(!await githubEnabled(await boot(t, {})));
    });

    // Either credential alone, or a missing PUBLIC_URL, refuses to boot.
    for (const env of [
      { GITHUB_CLIENT_ID: "gh_client", PUBLIC_URL: "https://notes.example" },
      { GITHUB_CLIENT_SECRET: secret, PUBLIC_URL: "https://notes.example" },
      { GITHUB_CLIENT_ID: "gh_client", GITHUB_CLIENT_SECRET: secret },
      { GITHUB_CLIENT_ID: "gh_client", GITHUB_CLIENT_SECRET: secret, PUBLIC_URL: "" },
    ]) {
      await withEnv(env, async () => {
        const error = await bootFails(t, {});
        assert.ok(!String(error?.message ?? error).includes(secret), `startup error leaked the secret: ${error?.message}`);
      });
    }

    // PUBLIC_URL must be an http(s) origin: no path, query, hash or userinfo.
    for (const publicUrl of ["not-a-url", "https://notes.example/path", "https://notes.example/?query=1", "https://notes.example/#frag", "https://user:pw@notes.example", "ftp://notes.example"]) {
      await withEnv({ GITHUB_CLIENT_ID: "gh_client", GITHUB_CLIENT_SECRET: secret, PUBLIC_URL: publicUrl }, async () => {
        const error = await bootFails(t, {});
        assert.ok(!String(error?.message ?? error).includes(secret), `startup error leaked the secret: ${error?.message}`);
      });
    }

    // A complete, well-formed configuration starts and reports enabled.
    await withEnv({ GITHUB_CLIENT_ID: "gh_client", GITHUB_CLIENT_SECRET: secret, PUBLIC_URL: "https://notes.example" }, async () => {
      assert.equal(await githubEnabled(await boot(t, {})), true);
    });
  } finally {
    restore();
  }
});
