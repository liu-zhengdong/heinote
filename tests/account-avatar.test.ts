import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import sharp from "sharp";
import { startServer } from "../server/index.ts";
import { Store } from "../server/store.ts";
import { Browser, githubConfig, startGithubStub, type GithubConfig, type Json, type Reply } from "./helpers/github.ts";

// UC-12 acceptance uses real HTTP, image decoders and temporary SQLite files.
const avatarPath = "/api/account/avatar";
const password = "Correct-horse-battery-2026!";
const maxBytes = 5 * 1024 * 1024;
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
type RunningServer = Awaited<ReturnType<typeof startServer>>;

function status(reply: Reply, expected: number): Json {
  assert.equal(reply.status, expected, JSON.stringify(reply.body));
  return reply.body;
}

async function fixture(t: TestContext, seed?: (directory: string) => Promise<void>, github: GithubConfig | null = null) {
  const directory = await mkdtemp(join(tmpdir(), "terminus-notes-avatar-"));
  let server: RunningServer | undefined;
  t.after(async () => {
    try { await server?.close(); }
    finally {
      const target = resolve(directory);
      assert.equal(dirname(target), resolve(tmpdir()));
      assert.ok(basename(target).startsWith("terminus-notes-avatar-"));
      await rm(target, { recursive: true, force: true });
    }
  });
  await seed?.(directory);
  const boot = () => startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false, registrationOpen: true, github });
  server = await boot();
  return {
    directory,
    url: () => server!.url,
    browser: () => new Browser(() => server!.url),
    database<T>(work: (db: DatabaseSync) => T): T {
      const db = new DatabaseSync(join(directory, "notes.sqlite"));
      try { return work(db); } finally { db.close(); }
    },
    async restart() {
      await server!.close();
      server = undefined;
      server = await boot();
    },
  };
}

async function register(browser: Browser, handle: string): Promise<Json> {
  return status(await browser.request("/api/auth/register", {
    method: "POST", body: { handle, displayName: handle.toUpperCase(), password },
  }), 201).user;
}

async function session(browser: Browser): Promise<Json> {
  // The platform client uses this response as bootstrap.user.
  return status(await browser.request("/api/session"), 200).user;
}

const image = (format: "png" | "jpeg" | "webp" = "png", color = "#e83535", width = 800, height = 400) =>
  sharp({ create: { width, height, channels: 3, background: color } }).toFormat(format).toBuffer();

async function upload(browser: Browser, bytes: Buffer, contentType = "image/png", path = avatarPath): Promise<Json> {
  const user = status(await browser.request(path, { method: "PUT", raw: bytes, contentType }), 200).user;
  assert.match(user.avatarUrl, /^\/api\/account\/avatars\/[^/]+\/[a-f0-9]{64}\.webp$/);
  return user;
}

async function readAvatar(url: string, browser: Browser, path: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${url}${path}`, { headers: { Cookie: browser.cookie, ...headers }, redirect: "manual" });
  return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) };
}

async function assertWebp(reply: Awaited<ReturnType<typeof readAvatar>>) {
  assert.equal(reply.status, 200, reply.bytes.toString());
  assert.equal(reply.headers.get("content-type"), "image/webp");
  assert.equal(reply.headers.get("content-length"), String(reply.bytes.length));
  assert.equal(reply.headers.get("x-content-type-options"), "nosniff");
  assert.equal(reply.headers.get("cache-control"), "no-store");
  assert.equal(reply.headers.get("content-security-policy"), "sandbox; default-src 'none'");
  const metadata = await sharp(reply.bytes).metadata();
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 512);
  assert.equal(metadata.height, 512);
  for (const key of ["orientation", "exif", "icc", "iptc", "xmp"] as const) assert.equal(metadata[key], undefined, `${key} must be removed`);
  assert.equal(metadata.pages ?? 1, 1);
  return metadata;
}

test("account avatar normalizes PNG, JPEG and WebP through HTTP", async (t) => {
  const f = await fixture(t);
  const browser = f.browser();
  const original = await register(browser, "alice");
  for (const format of ["png", "jpeg", "webp"] as const) {
    const user = await upload(browser, await image(format), `image/${format}`);
    assert.deepEqual({ ...user, avatarUrl: null }, original);
    assert.deepEqual(await session(browser), user);
    await assertWebp(await readAvatar(f.url(), browser, user.avatarUrl));
  }
});

test("account avatar sources prefer uploads, fall back to the bound GitHub ID, and clear after unlink", async (t) => {
  const stub = await startGithubStub();
  t.after(() => stub.close());
  const f = await fixture(t, undefined, githubConfig(stub));
  const browser = f.browser();
  const local = await register(browser, "local_avatar");
  assert.equal(local.avatarUrl, null);
  assert.equal((await session(browser)).avatarUrl, null);
  const providerId = 7394182;
  stub.queue.push({ id: providerId, login: "linked-avatar-user" });
  const binding = status(await browser.request("/api/auth/github/link", { method: "POST" }), 200);
  const provider = await fetch(binding.url, { redirect: "manual" });
  await provider.arrayBuffer();
  assert.equal(provider.status, 302);
  const location = provider.headers.get("location");
  assert.ok(location);
  const callback = new URL(location);
  const linked = await browser.request(callback.pathname + callback.search);
  assert.equal(linked.status, 302);
  assert.equal(linked.headers.get("location"), "/?github=linked");
  const githubUrl = `https://avatars.githubusercontent.com/u/${providerId}?s=96`;
  const fallback = { ...local, avatarUrl: githubUrl };
  assert.deepEqual(await session(browser), fallback);
  assert.equal(f.database((db) => db.prepare("SELECT count(*) AS count FROM files WHERE scope LIKE 'avatar:%'").get())?.count, 0, "GitHub fallback must not copy remote photo bytes");
  await f.restart();
  assert.deepEqual(await session(browser), fallback);
  const uploaded = await upload(browser, await image());
  assert.notEqual(uploaded.avatarUrl, githubUrl);
  assert.deepEqual(await session(browser), uploaded);
  await assertWebp(await readAvatar(f.url(), browser, uploaded.avatarUrl));
  assert.deepEqual(status(await browser.request(avatarPath, { method: "DELETE" }), 200), { user: fallback });
  assert.deepEqual(await session(browser), fallback);
  status(await browser.request(uploaded.avatarUrl), 404);
  assert.deepEqual(status(await browser.request(avatarPath, { method: "DELETE" }), 200), { user: fallback });
  const unlinked = status(await browser.request("/api/auth/github/link", { method: "DELETE" }), 200);
  assert.equal(unlinked.identity, null);
  assert.equal(unlinked.hasPassword, true);
  assert.deepEqual(await session(browser), local);
  status(await browser.request(uploaded.avatarUrl), 404);
});

test("standalone Store returns no avatar before the OAuth table is initialized", async (t) => {
  const f = await fixture(t, async (directory) => {
    const store = new Store(directory);
    try {
      assert.equal(store.one("SELECT name FROM sqlite_master WHERE type='table' AND name='oauth_identities'"), undefined);
      assert.equal(store.user({ id: "standalone", handle: "standalone", display_name: "Standalone", site_role: "user" }).avatarUrl, null);
    } finally { store.db.close(); }
  });
  assert.equal((await register(f.browser(), "local_only")).avatarUrl, null);
});

test("account avatar requires a current session before consuming raw bodies", async (t) => {
  const f = await fixture(t);
  const guest = f.browser();
  for (const method of ["PUT", "DELETE"]) {
    status(await guest.request(avatarPath, { method, raw: Buffer.from("broken"), contentType: "application/json" }), 401);
    guest.cookie = "notes_session=unknown";
    status(await guest.request(avatarPath, { method, raw: Buffer.alloc(maxBytes + 1), contentType: "image/png" }), 401);
    guest.cookie = "";
  }
  const browser = f.browser();
  const user = await register(browser, "alice");
  const saved = await upload(browser, await image());
  const stale = f.browser();
  stale.cookie = browser.cookie;
  f.database((db) => db.prepare("UPDATE sessions SET expires=0 WHERE user_id=?").run(user.id));
  for (const method of ["PUT", "DELETE"]) status(await stale.request(avatarPath, { method, raw: await image(), contentType: "image/png" }), 401);
  status(await stale.request(saved.avatarUrl), 401);
  const fresh = f.browser();
  status(await fresh.request("/api/auth/login", { method: "POST", body: { handle: "alice", password } }), 200);
  assert.deepEqual(await session(fresh), saved);
  const revoked = f.browser();
  revoked.cookie = fresh.cookie;
  status(await fresh.request("/api/auth/logout", { method: "POST" }), 200);
  status(await revoked.request(avatarPath, { method: "DELETE" }), 401);
});

test("account avatar rejects Agent tokens and mixed credentials for upload, removal and reads", async (t) => {
  const f = await fixture(t);
  const alice = f.browser();
  const bob = f.browser();
  await register(alice, "alice");
  const b = await register(bob, "bob");
  const a = await upload(alice, await image());
  for (const access of ["read", "write"]) {
    const { token } = status(await alice.request("/api/tokens", { method: "POST", body: { name: access, access } }), 201);
    for (const browser of [f.browser(), alice, bob]) {
      const headers = { Cookie: browser.cookie };
      status(await browser.request(avatarPath, { method: "PUT", token, headers, raw: Buffer.alloc(maxBytes + 1), contentType: "application/json" }), 403);
      status(await browser.request(avatarPath, { method: "DELETE", token, headers }), 403);
      status(await browser.request(a.avatarUrl, { token, headers }), 403);
    }
  }
  assert.deepEqual(await session(alice), a);
  assert.deepEqual(await session(bob), b);
});

test("account avatar rejects cross-site writes and preserves the previous avatar", async (t) => {
  const f = await fixture(t);
  const browser = f.browser();
  await register(browser, "alice");
  const user = await upload(browser, await image());
  for (const headers of [{ Origin: "https://other.example" }, { "Sec-Fetch-Site": "cross-site" }]) {
    status(await browser.request(avatarPath, { method: "PUT", headers, raw: await image("png", "blue"), contentType: "image/png" }), 403);
    status(await browser.request(avatarPath, { method: "DELETE", headers }), 403);
    assert.deepEqual(await session(browser), user);
  }
});

test("account avatar auto-orients before center-cover cropping and removes metadata", async (t) => {
  const f = await fixture(t);
  const browser = f.browser();
  await register(browser, "alice");
  const red = await image("png", "red", 120, 120);
  const jpeg = await sharp({ create: { width: 120, height: 240, channels: 3, background: "blue" } })
    .composite([{ input: red, left: 0, top: 0 }]).jpeg({ quality: 100 })
    .withMetadata({ orientation: 6 }).withExif({ IFD0: { Artist: "Private artist" }, IFD2: { UserComment: "Private note" } }).toBuffer();
  const source = await sharp(jpeg).metadata();
  assert.equal(source.orientation, 6);
  assert.ok(source.exif);
  const user = await upload(browser, jpeg, "image/jpeg");
  const reply = await readAvatar(f.url(), browser, user.avatarUrl);
  await assertWebp(reply);
  const { data, info } = await sharp(reply.bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
  const left = pixel(64, 256);
  const right = pixel(448, 256);
  assert.ok(left[2] > 200 && left[0] < 40, `left must be blue after clockwise orientation: ${left}`);
  assert.ok(right[0] > 200 && right[2] < 40, `right must be red after clockwise orientation: ${right}`);
  const bands = await sharp({ create: { width: 800, height: 400, channels: 3, background: "blue" } })
    .composite([{ input: await image("png", "red", 400, 400), left: 200, top: 0 }]).png().toBuffer();
  const cropped = await upload(browser, bands);
  const stats = await sharp((await readAvatar(f.url(), browser, cropped.avatarUrl)).bytes).stats();
  assert.ok(stats.channels[0].mean > 240 && stats.channels[2].mean < 15, "center crop must exclude both outer blue bands");
});

test("account avatar rejects empty, damaged, disguised, animated and SVG input", async (t) => {
  const f = await fixture(t);
  const browser = f.browser();
  await register(browser, "alice");
  const user = await upload(browser, await image());
  const png = await image();
  const frames = Buffer.alloc(8 * 16 * 3);
  for (let pixel = 0; pixel < 8 * 16; pixel++) frames[pixel * 3 + (pixel < 64 ? 0 : 2)] = 255;
  const animation = await sharp(frames, { raw: { width: 8, height: 16, channels: 3, pageHeight: 8 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  assert.equal((await sharp(animation).metadata()).pages, 2);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="red"/></svg>');
  const invalid: Array<[Buffer, string, number]> = [
    [Buffer.alloc(0), "image/png", 400], [Buffer.from("not an image"), "image/png", 400],
    [png.subarray(0, 48), "image/png", 400], [png, "image/jpeg", 400],
    [await image("jpeg"), "image/webp", 400], [animation, "image/webp", 400],
    [svg, "image/png", 400], [svg, "image/svg+xml", 415],
    [png, "application/octet-stream", 415], [png, "application/json", 415],
    [Buffer.from('{"userId":"someone-else","avatarUrl":"https://example.invalid"}'), "application/json", 415],
  ];
  for (const [raw, contentType, expected] of invalid) {
    status(await browser.request(avatarPath, { method: "PUT", raw, contentType }), expected);
    assert.deepEqual(await session(browser), user, `invalid ${contentType} input changed the saved avatar`);
  }
  status(await browser.request(avatarPath, { method: "PUT" }), 400);
  const tables = f.database((db) => db.prepare("SELECT count(*) AS count FROM files WHERE scope LIKE 'avatar:%'").get());
  assert.equal(tables?.count, 1, "invalid uploads must not leave file metadata");
});

test("account avatar enforces five MiB and forty million decoded pixels", async (t) => {
  const f = await fixture(t);
  const browser = f.browser();
  await register(browser, "alice");
  const png = await image();
  const exact = Buffer.concat([png, Buffer.alloc(maxBytes - png.length)]);
  const user = await upload(browser, exact);
  status(await browser.request(avatarPath, { method: "PUT", raw: Buffer.concat([exact, Buffer.from([0])]), contentType: "image/png" }), 413);
  const tooManyPixels = await image("png", "green", 6400, 6251);
  assert.ok(tooManyPixels.length < maxBytes);
  status(await browser.request(avatarPath, { method: "PUT", raw: tooManyPixels, contentType: "image/png" }), 400);
  assert.deepEqual(await session(browser), user);
  const exactPixels = await image("png", "green", 6400, 6250);
  const accepted = await upload(browser, exactPixels);
  await assertWebp(await readAvatar(f.url(), browser, accepted.avatarUrl));
});

test("account avatar retries keep the URL and replacement invalidates the old URL", async (t) => {
  const f = await fixture(t);
  const browser = f.browser();
  await register(browser, "alice");
  const png = await image();
  const first = await upload(browser, png);
  assert.deepEqual(await upload(browser, png), first);
  const retries = await Promise.all(Array.from({ length: 3 }, () => upload(browser, png)));
  assert.ok(retries.every((user) => user.avatarUrl === first.avatarUrl));
  const next = await upload(browser, await image("webp", "blue"), "image/webp");
  assert.notEqual(next.avatarUrl, first.avatarUrl);
  status(await browser.request(first.avatarUrl), 404);
  status(await browser.request(next.avatarUrl.replace(/[^/]+$/, "unknown.webp")), 404);
  await assertWebp(await readAvatar(f.url(), browser, next.avatarUrl));
  assert.equal(f.database((db) => db.prepare("SELECT count(*) AS count FROM files WHERE scope LIKE 'avatar:%'").get())?.count, 2);
});

test("account avatar removal is idempotent and invalidates current and previous URLs", async (t) => {
  const f = await fixture(t);
  const browser = f.browser();
  const original = await register(browser, "alice");
  assert.deepEqual(status(await browser.request(avatarPath, { method: "DELETE" }), 200), { user: original });
  const first = await upload(browser, await image());
  const second = await upload(browser, await image("png", "blue"));
  for (let i = 0; i < 2; i++) assert.deepEqual(status(await browser.request(avatarPath, { method: "DELETE" }), 200), { user: original });
  assert.deepEqual(await session(browser), original);
  status(await browser.request(first.avatarUrl), 404);
  status(await browser.request(second.avatarUrl), 404);
  await f.restart();
  assert.deepEqual(await session(browser), original);
  status(await browser.request(second.avatarUrl), 404);
});

test("account avatar changes only the current account and never exposes private attachments", async (t) => {
  const f = await fixture(t);
  const alice = f.browser();
  const bob = f.browser();
  const a = await register(alice, "alice");
  const b = await register(bob, "bob");
  const aliceAvatar = await upload(alice, await image());
  const bobAvatar = await upload(bob, await image("png", "blue"));
  status(await bob.request(`${avatarPath}/${a.id}`, { method: "PUT", raw: await image(), contentType: "image/png" }), 404);
  status(await bob.request(`${avatarPath}/${a.id}`, { method: "DELETE" }), 404);
  status(await bob.request("/api/account/profile", { method: "PATCH", body: { displayName: "No change", avatarUrl: aliceAvatar.avatarUrl } }), 400);
  await assertWebp(await readAvatar(f.url(), bob, aliceAvatar.avatarUrl));
  status(await f.browser().request(aliceAvatar.avatarUrl), 401);
  const privatePath = "files/private.png";
  status(await alice.request(`/api/files/personal?path=${encodeURIComponent(privatePath)}`, { method: "PUT", raw: await image(), contentType: "image/png" }), 200);
  for (const scope of [`user:${a.id}`, `avatar:${a.id}`]) {
    for (const path of [privatePath, aliceAvatar.avatarUrl.split("/").at(-1)!]) {
      status(await bob.request(`/api/files/${encodeURIComponent(scope)}?path=${encodeURIComponent(path)}`), 403);
    }
  }
  status(await bob.request(`/api/account/avatars/${a.id}/${encodeURIComponent(privatePath)}`), 404);
  assert.deepEqual(status(await bob.request(avatarPath, { method: "DELETE" }), 200), { user: b });
  assert.deepEqual(await session(alice), aliceAvatar);
  assert.deepEqual(await session(bob), b);
  status(await alice.request(bobAvatar.avatarUrl), 404);
});

test("account avatar is consistent across session, bootstrap, admin, search, roster and invitee DTOs", async (t) => {
  const f = await fixture(t);
  const alice = f.browser();
  const bob = f.browser();
  await register(alice, "alice");
  await register(bob, "bob");
  const a = await upload(alice, await image());
  const b = await upload(bob, await image("png", "blue"));
  const secondSession = f.browser();
  assert.deepEqual(status(await secondSession.request("/api/auth/login", { method: "POST", body: { handle: "alice", password } }), 200).user, a);
  assert.deepEqual(await session(secondSession), a);
  const checkUsers = async (expected: Json[]) => {
    assert.deepEqual(status(await alice.request("/api/admin/users"), 200), expected);
    for (const person of expected) {
      const { siteRole: _role, ...publicPerson } = person;
      assert.deepEqual(status(await alice.request(`/api/users?query=${person.handle}`), 200), [publicPerson]);
    }
  };
  await checkUsers([a, b]);
  const { spaceId } = status(await alice.request("/api/spaces", { method: "POST", body: { name: "Avatar roster" } }), 201);
  status(await alice.request(`/api/spaces/${spaceId}/invitations`, { method: "POST", body: { handle: "bob", role: "editor" } }), 200);
  const pending = status(await alice.request(`/api/spaces/${spaceId}/roster`), 200);
  assert.deepEqual(pending.members, [{ ...a, role: "owner" }]);
  const { siteRole: _role, ...invitee } = b;
  assert.deepEqual(pending.invitations[0].invitee, invitee);
  const changed = await upload(bob, await image("png", "green"));
  assert.equal(status(await alice.request(`/api/spaces/${spaceId}/roster`), 200).invitations[0].invitee.avatarUrl, changed.avatarUrl);
  status(await bob.request(`/api/invitations/${pending.invitations[0].id}`, { method: "POST", body: { accept: true } }), 200);
  assert.deepEqual(status(await alice.request(`/api/spaces/${spaceId}/roster`), 200).members, [{ ...a, role: "owner" }, { ...changed, role: "editor" }]);
  await f.restart();
  assert.deepEqual(await session(alice), a);
  assert.deepEqual(await session(bob), changed);
  await checkUsers([a, changed]);
  await assertWebp(await readAvatar(f.url(), bob, a.avatarUrl));
});

test("account avatar rechecks the session after an upload body arrives", async (t) => {
  const f = await fixture(t);
  const browser = f.browser();
  const original = await register(browser, "alice");
  const png = await image();
  let request!: ReturnType<typeof httpRequest>;
  const reply = new Promise<{ status: number; body: Json }>((resolveReply, reject) => {
    request = httpRequest(`${f.url()}${avatarPath}`, { method: "PUT", headers: {
      Cookie: browser.cookie, Origin: f.url(), "Content-Type": "image/png", "Content-Length": png.length,
    } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolveReply({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      res.on("error", reject);
    });
    request.on("error", reject);
    request.write(png.subarray(0, 1));
  });
  t.after(() => request.destroy());
  status(await browser.request("/api/health"), 200);
  status(await browser.request("/api/auth/logout", { method: "POST" }), 200);
  request.end(png.subarray(1));
  assert.equal((await reply).status, 401);
  status(await browser.request("/api/auth/login", { method: "POST", body: { handle: "alice", password } }), 200);
  assert.deepEqual(await session(browser), original);
});

test("account avatar rolls back file metadata when the avatar mapping fails and permits a retry", async (t) => {
  const f = await fixture(t);
  const browser = f.browser();
  await register(browser, "alice");
  const previous = await upload(browser, await image());
  const before = f.database((db) => db.prepare("SELECT * FROM files ORDER BY scope,path").all());
  f.database((db) => db.exec("CREATE TRIGGER refuse_avatar BEFORE UPDATE ON avatars BEGIN SELECT RAISE(ABORT,'avatar fault injection'); END"));
  const bytes = await image("png", "blue");
  status(await browser.request(avatarPath, { method: "PUT", raw: bytes, contentType: "image/png" }), 500);
  assert.deepEqual(await session(browser), previous);
  await assertWebp(await readAvatar(f.url(), browser, previous.avatarUrl));
  assert.deepEqual(f.database((db) => db.prepare("SELECT * FROM files ORDER BY scope,path").all()), before);
  f.database((db) => db.exec("DROP TRIGGER refuse_avatar"));
  const saved = await upload(browser, bytes);
  assert.notEqual(saved.avatarUrl, previous.avatarUrl);
  status(await browser.request(previous.avatarUrl), 404);
});

test("account avatar opens existing five-column users and preserves old files across restart", async (t) => {
  const legacyBytes = Buffer.from("legacy private attachment");
  const f = await fixture(t, async (directory) => {
    const db = new DatabaseSync(join(directory, "notes.sqlite"));
    try {
      db.exec("CREATE TABLE users(id TEXT PRIMARY KEY, handle TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, password TEXT NOT NULL, site_role TEXT NOT NULL); CREATE TABLE sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires INTEGER NOT NULL); CREATE TABLE files(scope TEXT NOT NULL,path TEXT NOT NULL,type TEXT NOT NULL,size INTEGER NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(scope,path));");
      db.prepare("INSERT INTO users VALUES(?,?,?,?,?)").run("legacy-id", "legacy", "Legacy user", "unused", "admin");
      db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(digest("legacy-session"), "legacy-id", Date.now() + 86400000);
      db.prepare("INSERT INTO files VALUES(?,?,?,?,?)").run("user:legacy-id", "files/old.bin", "application/octet-stream", legacyBytes.length, digest(legacyBytes));
    } finally { db.close(); }
    const shard = join(directory, "attachments", digest(legacyBytes).slice(0, 2));
    await mkdir(shard, { recursive: true });
    await writeFile(join(shard, digest(legacyBytes)), legacyBytes);
  });
  const browser = f.browser();
  browser.cookie = "notes_session=legacy-session";
  assert.deepEqual(await session(browser), { id: "legacy-id", handle: "legacy", displayName: "Legacy user", avatarUrl: null, siteRole: "admin" });
  const user = await upload(browser, await image());
  const newcomer = await register(f.browser(), "newcomer");
  assert.equal(newcomer.avatarUrl, null);
  await f.restart();
  assert.deepEqual(await session(browser), user);
  await assertWebp(await readAvatar(f.url(), browser, user.avatarUrl));
  const old = await readAvatar(f.url(), browser, "/api/files/personal?path=files%2Fold.bin");
  assert.equal(old.status, 200);
  assert.deepEqual(old.bytes, legacyBytes);
  assert.deepEqual(f.database((db) => db.prepare("PRAGMA table_info(users)").all()).map((column) => column.name), ["id", "handle", "display_name", "password", "site_role"]);
});
