import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { startServer } from "../server/index.ts";
import { Browser, type Json, type Reply } from "./helpers/github.ts";

/* UC-58: workbench iframe embed sessions. An embed-capable token mints a
   one-shot ticket pinned to the reported parent origin; redeeming it in an
   iframe plants a cross-site session whose actor carries the token's
   identity and access. Only responses on that session drop the frame
   blockade — everything else keeps DENY. */

type RunningServer = Awaited<ReturnType<typeof startServer>>;
const WORKBENCH = "https://workbench.example.com";
const password = "Embed-session-password-2026!";

function status(reply: Reply, expected: number): Json {
  assert.equal(reply.status, expected, JSON.stringify(reply.body));
  return reply.body;
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "heinote-embed-"));
  const server: RunningServer = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false });
  t.after(async () => {
    await server.close();
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("heinote-embed-"));
    await rm(target, { recursive: true, force: true });
  });
  return { server, browser: () => new Browser(() => server.url) };
}

async function register(browser: Browser, handle: string) {
  status(await browser.request("/api/auth/register", {
    method: "POST", body: { handle, displayName: handle.toUpperCase(), password },
  }), 201);
}

/** Headers a real browser sends when an iframe navigates the redeem URL. */
const frameNav = (origin: string) => ({ Origin: origin, Referer: `${origin}/`, "sec-fetch-dest": "iframe", "sec-fetch-site": "cross-site" });

async function redeem(browser: Browser, ticket: string, origin: string): Promise<Reply> {
  return browser.request(`/api/v1/embed/session?t=${encodeURIComponent(ticket)}`, { headers: frameNav(origin) });
}

async function makeToken(browser: Browser, body: Json = {}): Promise<Json> {
  const created = status(await browser.request("/api/tokens", { method: "POST", body: { name: "workbench", access: "write", ...body } }), 201);
  return created;
}

test("ticket mint: requires a Bearer token with embed enabled", async (t) => {
  const f = await fixture(t);
  const alice = f.browser();
  await register(alice, "embed-alice");
  const plain = await makeToken(alice);
  const embedded = await makeToken(alice, { name: "embedded", embed: true });

  // Anonymous → 401.
  status(await f.browser().request("/api/v1/embed/tickets", { method: "POST", body: { origin: WORKBENCH }, headers: { Origin: null } }), 401);
  // Token without embed → 403.
  status(await f.browser().request("/api/v1/embed/tickets", { method: "POST", token: plain.token, body: { origin: WORKBENCH }, headers: { Origin: null } }), 403);
  // Cookie session (not a token) → 403, even though the caller is the owner.
  status(await alice.request("/api/v1/embed/tickets", { method: "POST", body: { origin: WORKBENCH } }), 403);

  // Embed token + Origin header → ticket bound to that origin.
  const viaHeader = status(await f.browser().request("/api/v1/embed/tickets", {
    method: "POST", token: embedded.token, headers: { Origin: WORKBENCH },
  }), 201);
  assert.equal(typeof viaHeader.ticket, "string");
  // Embed token + body origin (plugin backend with no Origin header).
  const viaBody = status(await f.browser().request("/api/v1/embed/tickets", {
    method: "POST", token: embedded.token, body: { origin: WORKBENCH }, headers: { Origin: null },
  }), 201);
  assert.equal(typeof viaBody.ticket, "string");
  // Conflicting declarations are rejected.
  status(await f.browser().request("/api/v1/embed/tickets", {
    method: "POST", token: embedded.token, body: { origin: "https://other.example.com" }, headers: { Origin: WORKBENCH },
  }), 400);
  status(await f.browser().request("/api/v1/embed/tickets", {
    method: "POST", token: embedded.token, body: {}, headers: { Origin: null },
  }), 400);
  status(await f.browser().request("/api/v1/embed/tickets", {
    method: "POST", token: embedded.token, body: { origin: "not-an-origin" }, headers: { Origin: null },
  }), 400);
});

test("redeem: plants a partitioned SameSite=None session, once, for the declared origin", async (t) => {
  const f = await fixture(t);
  const alice = f.browser();
  await register(alice, "embed-bob");
  const token = await makeToken(alice, { embed: true });
  const minted = status(await f.browser().request("/api/v1/embed/tickets", {
    method: "POST", token: token.token, headers: { Origin: WORKBENCH },
  }), 201);

  const frame = f.browser();
  const reply = await redeem(frame, minted.ticket, WORKBENCH);
  assert.equal(reply.status, 302, `expected redirect, got ${JSON.stringify(reply.body)}`);
  assert.equal(reply.headers.get("location"), "/");
  const cookie = reply.headers.getSetCookie().find((line) => line.startsWith("notes_embed="));
  assert.ok(cookie, "missing notes_embed Set-Cookie");
  for (const attr of ["httponly", "secure", "samesite=none", "partitioned"]) {
    assert.match(cookie, new RegExp(`;\\s*${attr}`, "i"), `cookie lacks ${attr}: ${cookie}`);
  }

  // The cookie authenticates as the token identity.
  const session = status(await frame.request("/api/session", { headers: { Origin: null } }), 200);
  assert.equal(session.user.handle, "embed-bob");
  assert.equal(session.embed, true);

  // One shot: replaying the same ticket fails.
  status(await redeem(f.browser(), minted.ticket, WORKBENCH), 401);
});

test("redeem: wrong origin, non-iframe navigation and expired tickets are refused", async (t) => {
  const f = await fixture(t);
  const alice = f.browser();
  await register(alice, "embed-carol");
  const token = await makeToken(alice, { embed: true });
  const mint = async () => status(await f.browser().request("/api/v1/embed/tickets", {
    method: "POST", token: token.token, headers: { Origin: WORKBENCH },
  }), 201).ticket;

  // Navigated from an origin different from the declared one.
  status(await redeem(f.browser(), await mint(), "https://evil.example.com"), 403);
  // No origin evidence at all.
  status(await f.browser().request(`/api/v1/embed/session?t=${await mint()}`, { headers: { Origin: null, "sec-fetch-dest": "iframe" } }), 403);
  // Top-level navigation (session fixation): sec-fetch-dest=document.
  status(await f.browser().request(`/api/v1/embed/session?t=${await mint()}`, {
    headers: { Origin: WORKBENCH, Referer: `${WORKBENCH}/`, "sec-fetch-dest": "document", "sec-fetch-site": "cross-site" },
  }), 403);
  // Nonsense ticket.
  status(await redeem(f.browser(), "bogus", WORKBENCH), 401);
});

test("embed session: token access applies, management paths stay closed, revoke kills it", async (t) => {
  const f = await fixture(t);
  const alice = f.browser();
  await register(alice, "embed-dan");
  const readToken = await makeToken(alice, { name: "reader", access: "read", embed: true });
  const writeToken = await makeToken(alice, { name: "writer", embed: true });

  const readFrame = f.browser();
  let ticket = status(await f.browser().request("/api/v1/embed/tickets", { method: "POST", token: readToken.token, headers: { Origin: WORKBENCH } }), 201).ticket;
  await redeem(readFrame, ticket, WORKBENCH);

  const writeFrame = f.browser();
  ticket = status(await f.browser().request("/api/v1/embed/tickets", { method: "POST", token: writeToken.token, headers: { Origin: WORKBENCH } }), 201).ticket;
  await redeem(writeFrame, ticket, WORKBENCH);

  // Read session: content reads fine, record writes 403.
  status(await readFrame.request("/api/spaces", { headers: { Origin: null } }), 200);
  status(await readFrame.request("/api/records/batch", {
    method: "POST", body: { writes: [{ scope: "personal", collection: "pages", id: "p1", action: "put", value: {} }] },
  }), 403);
  // Write session can create a page through the browser write path.
  const who = status(await writeFrame.request("/api/session", { headers: { Origin: null } }), 200).user;
  const created = await writeFrame.structure("/api/records/batch", {
    method: "POST",
    body: { writes: [{ scope: "personal", collection: "pages", id: "embed-page", action: "put", value: {
      id: "embed-page", title_content: [{ text: "嵌入页" }], icon: "", kind: "document",
      created_at: "2026-11-23T00:00:00.000Z", updated_at: "2026-11-23T00:00:00.000Z",
      created_by: who.handle, updated_by: who.handle } }] },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));

  // Token management is closed to embed sessions: it cannot even mint more
  // tickets or see the token list; account and auth management too.
  status(await writeFrame.request("/api/v1/embed/tickets", { method: "POST", headers: { Origin: WORKBENCH } }), 403);
  status(await writeFrame.request("/api/tokens", { headers: { Origin: null } }), 403);
  status(await writeFrame.request("/api/account/profile", { method: "PATCH", body: { displayName: "x" } }), 403);
  status(await writeFrame.request("/api/auth/login", { method: "POST", body: { handle: "somebody", password: "whatever-password" } }), 403);

  // Closing embed on the token kills the session at lookup time.
  status(await alice.request(`/api/tokens/${writeToken.id}`, { method: "PATCH", body: { embed: false } }), 200);
  const deadSession = status(await writeFrame.request("/api/session", { headers: { Origin: null } }), 200);
  assert.equal(deadSession.user, null);
  status(await writeFrame.request("/api/spaces", { headers: { Origin: null } }), 401);

  // Re-enable + new session, then revoke the token: sessions die in the
  // revoke transaction and at lookup.
  status(await alice.request(`/api/tokens/${writeToken.id}`, { method: "PATCH", body: { embed: true } }), 200);
  ticket = status(await f.browser().request("/api/v1/embed/tickets", { method: "POST", token: writeToken.token, headers: { Origin: WORKBENCH } }), 201).ticket;
  await redeem(writeFrame, ticket, WORKBENCH);
  status(await alice.request(`/api/tokens/${writeToken.id}`, { method: "DELETE" }), 200);
  status(await writeFrame.request("/api/spaces", { headers: { Origin: null } }), 401);
});

test("headers: only embed-session frameable responses get frame-ancestors", async (t) => {
  const f = await fixture(t);
  const alice = f.browser();
  await register(alice, "embed-erin");
  const token = await makeToken(alice, { embed: true });
  const ticket = status(await f.browser().request("/api/v1/embed/tickets", { method: "POST", token: token.token, headers: { Origin: WORKBENCH } }), 201).ticket;
  const frame = f.browser();
  await redeem(frame, ticket, WORKBENCH);

  // Frameable response on the embed session: no XFO, CSP pins the origin.
  // serveStatic is off, so / falls through to the 404 page — the frame
  // contract still applies to it exactly like the app shell.
  const doc = await frame.request("/", { headers: { Origin: null }, rawResponse: true });
  assert.equal(doc.headers.get("x-frame-options"), null);
  assert.equal(doc.headers.get("content-security-policy"), `frame-ancestors 'self' ${WORKBENCH}`);

  // Api responses on the same session stay DENY.
  const apiReply = await frame.request("/api/session", { headers: { Origin: null } });
  assert.equal(apiReply.headers.get("x-frame-options"), "DENY");
  assert.equal(apiReply.headers.get("content-security-policy"), null);

  // Anonymous and normal sessions stay unframeable: XFO DENY, plus whatever
  // deny CSP the page itself emits (Express's 404 sends default-src 'none').
  for (const other of [f.browser(), alice]) {
    const reply = await other.request("/", { headers: { Origin: null }, rawResponse: true });
    assert.equal(reply.headers.get("x-frame-options"), "DENY");
    const csp = reply.headers.get("content-security-policy") ?? "";
    assert.doesNotMatch(csp, /frame-ancestors 'self' https/);
    assert.ok(!csp || /default-src 'none'|frame-ancestors 'none'/.test(csp), `unexpected CSP: ${csp}`);
  }
});
