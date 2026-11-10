import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { startServer } from "../server/index.ts";

// Acceptance for content-addressed attachments: PUT/GET /api/files/:scope keeps
// the same HTTP contract, but bytes live at DATA_DIR/attachments/<hh>/<sha256>
// and SQLite keeps only files(scope,path,type,size,hash). scripts/backup.mjs
// copies an online SQLite snapshot plus the immutable attachments tree into a
// new directory. These tests drive the deployed boundary plus the filesystem.
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
  binary?: boolean;
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
    if (options.binary) {
      return { status: response.status, body: Buffer.from(await response.arrayBuffer()), headers: response.headers };
    }
    const text = await response.text();
    let parsed: Json = null;
    if (text) {
      const isJson = /application\/json/.test(response.headers.get("content-type") ?? "");
      assert.ok(isJson, `${path} returned a non-JSON API response: ${text.slice(0, 200)}`);
      parsed = JSON.parse(text);
    }
    return { status: response.status, body: parsed, headers: response.headers };
  }

  // Structure gestures only: preserves each supplied record and fills
  // expectedPages the way the real client does.
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

function denied(reply: Reply): void {
  assert.ok([401, 403, 404].includes(reply.status), `Expected access refusal, got ${reply.status}: ${JSON.stringify(reply.body)}`);
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "terminus-notes-files-"));
  let server: RunningServer | undefined = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false });
  t.after(async () => {
    await server?.close();
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("terminus-notes-files-"));
    await rm(target, { recursive: true, force: true });
  });
  return {
    directory,
    browser: () => new Browser(() => server!.url),
    async restart() {
      await server!.close();
      server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false });
    },
    async stop() {
      await server?.close();
      server = undefined;
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

const fileUrl = (scope: string, path: string) => `/api/files/${encodeURIComponent(scope)}?path=${encodeURIComponent(path)}`;

function putFile(browser: Browser, scope: string, path: string, bytes: Buffer, contentType = "application/octet-stream") {
  return browser.request(fileUrl(scope, path), { method: "PUT", raw: bytes, contentType });
}

async function getFile(browser: Browser, scope: string, path: string): Promise<{ status: number; bytes: Buffer; headers: Headers }> {
  const reply = await browser.request(fileUrl(scope, path), { binary: true });
  return { status: reply.status, bytes: reply.body as Buffer, headers: reply.headers };
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const blobPath = (dataDir: string, hash: string) => join(dataDir, "attachments", hash.slice(0, 2), hash);

// Every entry under attachments/ must be one immutable blob at <hh>/<64-hex>.
function attachmentFiles(dataDir: string): string[] {
  const root = join(dataDir, "attachments");
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else files.push(rel);
    }
  };
  walk(root, "");
  return files.sort();
}

const HASH_LAYOUT = /^[0-9a-f]{2}\/[0-9a-f]{64}$/;

function fileRows(dataDir: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(join(dataDir, "notes.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT scope,path,type,size,hash FROM files ORDER BY scope,path").all() as Array<Record<string, unknown>>;
  } finally { db.close(); }
}

const BACKUP_SCRIPT = fileURLToPath(new URL("../scripts/backup.mjs", import.meta.url));

function runBackup(dataDir: string, target: string): { ok: boolean; output: string } {
  try {
    const stdout = execFileSync(process.execPath, [BACKUP_SCRIPT, target], {
      env: { ...process.env, DATA_DIR: dataDir },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: stdout };
  } catch (error) {
    const failure = error as { stdout?: string | Buffer; stderr?: string | Buffer };
    return { ok: false, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

const png = () => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256)),
]);

test("binary uploads land under attachments/<hh>/<sha256> and round-trip byte for byte", async (t) => {
  const f = await fixture(t);
  const browser = f.browser();
  const user = await register(browser, "alice");
  const bytes = png();
  assert.equal(bytes.includes(0x00) && bytes.includes(0xff), true, "fixture must cover 0x00 and 0xff");
  status(await browser.request("/api/files/personal", { method: "PUT", raw: bytes }), 400);
  status(await putFile(browser, "personal", "files/picture.png", bytes, "image/png"), 200);
  const hash = sha256(bytes);
  const stored = blobPath(f.directory, hash);
  assert.ok(statSync(stored).isFile(), `blob must live at ${stored}`);
  assert.deepEqual(statSync(stored).size, bytes.byteLength);
  assert.equal(readFileSync(stored).equals(bytes), true, "stored blob must equal uploaded bytes");
  const same = await getFile(browser, "personal", "files/picture.png");
  assert.equal(same.status, 200);
  assert.ok(same.bytes.equals(bytes), "GET must return the exact uploaded bytes");
  assert.equal(same.headers.get("content-type"), "image/png");
  // A second logical path with the same content dedups onto the same blob.
  status(await putFile(browser, "personal", "files/duplicate.png", bytes, "image/png"), 200);
  assert.deepEqual(attachmentFiles(f.directory), [`${hash.slice(0, 2)}/${hash}`], "identical content must share one blob; no temp files may remain");
  const missing = await getFile(browser, "personal", "files/missing.png");
  assert.equal(missing.status, 404);
  await f.stop();
  const rows = fileRows(f.directory);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.scope, `user:${user.id}`);
    assert.equal(row.type, "image/png");
    assert.equal(row.size, bytes.byteLength);
    assert.equal(row.hash, hash, "files.hash must be the content sha256");
  }
  assert.deepEqual(rows.map((row) => row.path).sort(), ["files/duplicate.png", "files/picture.png"]);
  // Acceptance target: no bytes column anywhere in the files index.
  const db = new DatabaseSync(join(f.directory, "notes.sqlite"), { readOnly: true });
  try {
    const columns = (db.prepare("PRAGMA table_info(files)").all() as Array<Record<string, unknown>>).map((column) => String(column.name)).sort();
    assert.deepEqual(columns, ["hash", "path", "scope", "size", "type"]);
  } finally { db.close(); }
});

test("same-path retries keep identical bytes and reject changed bytes, even concurrently", async (t) => {
  const f = await fixture(t);
  const browser = f.browser();
  await register(browser, "alice");
  const first = Buffer.from("first payload \x00\xff");
  const second = Buffer.from("second payload");
  const path = "files/contended.bin";
  status(await putFile(browser, "personal", path, first), 200);
  status(await putFile(browser, "personal", path, first), 200);
  status(await putFile(browser, "personal", path, second), 409);
  let read = await getFile(browser, "personal", path);
  assert.equal(read.status, 200);
  assert.ok(read.bytes.equals(first), "a conflicting retry must not replace stored bytes");
  const identical = await Promise.all(Array.from({ length: 4 }, () => putFile(browser, "personal", "files/concurrent-same.bin", first)));
  assert.deepEqual(identical.map((reply) => reply.status), [200, 200, 200, 200]);
  const raced = await Promise.all([
    putFile(browser, "personal", "files/race.bin", first),
    putFile(browser, "personal", "files/race.bin", second),
    putFile(browser, "personal", "files/race.bin", Buffer.from("third payload")),
    putFile(browser, "personal", "files/race.bin", Buffer.from("fourth payload")),
  ]);
  assert.deepEqual(raced.map((reply) => reply.status).sort(), [200, 409, 409, 409], "one concurrent writer must win; the rest conflict");
  read = await getFile(browser, "personal", "files/race.bin");
  const winner = raced.findIndex((reply) => reply.status === 200);
  const winnerBytes = [first, second, Buffer.from("third payload"), Buffer.from("fourth payload")][winner];
  assert.ok(read.bytes.equals(winnerBytes), "GET must return the bytes of the winning writer");
  await f.stop();
  assert.equal(fileRows(f.directory).filter((row) => row.path === "files/race.bin").length, 1);
});

test("scopes keep separate indexes even for identical content", async (t) => {
  const f = await fixture(t);
  const alice = f.browser();
  const bob = f.browser();
  const carol = f.browser();
  await register(alice, "alice");
  await register(bob, "bob");
  await register(carol, "carol");
  const shared = Buffer.from("same bytes everywhere");
  const path = "files/shared.bin";
  status(await putFile(alice, "personal", path, shared), 200);
  status(await putFile(bob, "personal", path, shared), 200);
  const space = status(await alice.request("/api/spaces", { method: "POST", body: { name: "File scope" } }), 201);
  // Bob cannot read through Alice's scope, and the space has no file yet.
  denied(await carol.request(fileUrl(space.spaceId, path)));
  assert.equal((await getFile(alice, space.spaceId, path)).status, 404, "a personal upload must not leak into a space");
  const spaceBytes = Buffer.from("space-specific bytes");
  status(await putFile(alice, space.spaceId, path, spaceBytes), 200);
  denied(await carol.request(fileUrl(space.spaceId, path)));
  denied(await carol.request(fileUrl(space.spaceId, path), { method: "PUT", raw: shared }));
  const spaceRead = await getFile(alice, space.spaceId, path);
  assert.equal(spaceRead.status, 200);
  assert.ok(spaceRead.bytes.equals(spaceBytes));
  const personalRead = await getFile(alice, "personal", path);
  assert.ok(personalRead.bytes.equals(shared), "the space upload must not touch personal bytes");
  const bobRead = await getFile(bob, "personal", path);
  assert.ok(bobRead.bytes.equals(shared));
  await f.stop();
  const rows = fileRows(f.directory).filter((row) => row.path === path);
  assert.equal(rows.length, 3, "each scope indexes its own row for the same path");
  assert.deepEqual(new Set(rows.map((row) => row.scope)).size, 3);
  assert.equal(rows.filter((row) => row.hash === sha256(shared)).length, 2);
});

test("client-supplied paths never escape onto the filesystem", async (t) => {
  const f = await fixture(t);
  const browser = f.browser();
  await register(browser, "alice");
  const bytes = Buffer.from("traversal payload");
  for (const path of ["../../evil.bin", "..%2f..%2fnested", "files/../../inside.bin"]) {
    const logical = decodeURIComponent(path);
    status(await putFile(browser, "personal", logical, bytes), 200);
    const read = await getFile(browser, "personal", logical);
    assert.equal(read.status, 200);
    assert.ok(read.bytes.equals(bytes));
  }
  assert.equal(existsSync(resolve(f.directory, "../../evil.bin")), false);
  assert.equal(existsSync(resolve(f.directory, "../../nested")), false);
  assert.equal(existsSync(resolve(f.directory, "../inside.bin")), false);
  for (const entry of readdirSync(f.directory)) {
    assert.ok(/^notes\.sqlite(-wal|-shm)?$/.test(entry) || entry === "attachments", `traversal paths must not create ${entry} in DATA_DIR`);
  }
  for (const rel of attachmentFiles(f.directory)) {
    assert.match(rel, HASH_LAYOUT, `attachment ${rel} must be addressed by content hash, never by client path`);
  }
  assert.equal(attachmentFiles(f.directory).length, 1, "identical traversal payloads must dedup to one blob");
});

test("uploads at most eight MiB are accepted and larger bodies are refused", async (t) => {
  const f = await fixture(t);
  const browser = f.browser();
  await register(browser, "alice");
  const max = Buffer.alloc(8 * 1024 * 1024);
  for (let i = 0; i < max.byteLength; i += 65536) max[i] = i % 256;
  status(await putFile(browser, "personal", "files/max.bin", max), 200);
  const read = await getFile(browser, "personal", "files/max.bin");
  assert.equal(read.status, 200);
  assert.equal(sha256(read.bytes), sha256(max));
  const over = Buffer.alloc(8 * 1024 * 1024 + 1);
  const reply = await putFile(browser, "personal", "files/over.bin", over);
  assert.equal(reply.status, 413, `8MiB+1 must be refused, got ${reply.status}`);
  assert.equal((await getFile(browser, "personal", "files/over.bin")).status, 404);
  await f.stop();
  assert.equal(fileRows(f.directory).some((row) => row.path === "files/over.bin"), false, "a refused upload must not leave metadata");
});

test("attachments survive a server restart", async (t) => {
  const f = await fixture(t);
  const browser = f.browser();
  await register(browser, "alice");
  const bytes = png();
  status(await putFile(browser, "personal", "files/restart.png", bytes, "image/png"), 200);
  await f.restart();
  const read = await getFile(browser, "personal", "files/restart.png");
  assert.equal(read.status, 200);
  assert.ok(read.bytes.equals(bytes));
  status(await putFile(browser, "personal", "files/restart.png", bytes, "image/png"), 200);
  status(await putFile(browser, "personal", "files/restart.png", Buffer.from("changed"), "image/png"), 409);
});

test("a deleted blob reads as missing until an identical upload heals it", async (t) => {
  const f = await fixture(t);
  const browser = f.browser();
  await register(browser, "alice");
  const bytes = png();
  status(await putFile(browser, "personal", "files/healed.png", bytes, "image/png"), 200);
  const hash = sha256(bytes);
  const stored = blobPath(f.directory, hash);
  assert.ok(statSync(stored).isFile());
  await unlink(stored);
  // The metadata row still exists, but its bytes are gone from disk.
  const gone = await getFile(browser, "personal", "files/healed.png");
  assert.equal(gone.status, 404, "a missing blob must read as absent");
  // Re-uploading the same bytes is a legal identical retry that restores the blob.
  status(await putFile(browser, "personal", "files/healed.png", bytes, "image/png"), 200);
  assert.ok(statSync(stored).isFile(), "the identical retry must rewrite the blob");
  assert.equal(readFileSync(stored).equals(bytes), true);
  const healed = await getFile(browser, "personal", "files/healed.png");
  assert.equal(healed.status, 200);
  assert.ok(healed.bytes.equals(bytes));
});

test("a failed disk write returns an error and leaves no file metadata", async (t) => {
  const f = await fixture(t);
  const browser = f.browser();
  await register(browser, "alice");
  const bytes = Buffer.from("must survive the fault injection");
  const hash = sha256(bytes);
  // A regular file where the blob's shard directory must be created.
  const attachments = join(f.directory, "attachments");
  mkdirSync(attachments, { recursive: true });
  const blocker = join(attachments, hash.slice(0, 2));
  writeFileSync(blocker, "not a directory");
  const failed = await putFile(browser, "personal", "files/faulty.bin", bytes);
  assert.ok(failed.status >= 400, `a failed disk write must not succeed, got ${failed.status}`);
  assert.equal((await getFile(browser, "personal", "files/faulty.bin")).status, 404);
  assert.equal(fileRows(f.directory).some((row) => row.path === "files/faulty.bin"), false, "a failed write must not commit files metadata");
  // Once the fault clears the same upload succeeds.
  await unlink(blocker);
  status(await putFile(browser, "personal", "files/faulty.bin", bytes), 200);
  const read = await getFile(browser, "personal", "files/faulty.bin");
  assert.ok(read.bytes.equals(bytes));
  assert.equal(readFileSync(blobPath(f.directory, hash)).equals(bytes), true);
});

test("backup writes a self-contained directory that restores accounts, pages, and attachments", async (t) => {
  const f = await fixture(t);
  const alice = f.browser();
  const user = await register(alice, "alice");
  const original = png();
  const preview = Buffer.from("small preview \x00\xff of the cover");
  status(await putFile(alice, "personal", "files/cover.png", original, "image/png"), 200);
  status(await putFile(alice, "personal", "files/cover.preview.png", preview, "image/png"), 200);
  await put(alice, "personal", "pages", "media", page("media", user.id, {
    cover_image: { path: "files/cover.png", preview: "files/cover.preview.png", owner: user.id, name: "cover.png", size: original.byteLength, type: "image/png" },
  }));
  const share = status(await alice.request("/api/shares", { method: "POST", body: { pageId: "media" } }), 201);
  const shareToken = new URL(share.url, "http://unused.invalid").pathname.split("/").at(-1);
  assert.ok(shareToken);
  // A leftover temp upload must not be copied into the backup.
  const orphan = join(f.directory, "attachments", sha256(original).slice(0, 2), "upload-in-progress.tmp");
  writeFileSync(orphan, "half-written bytes");
  // The backup may live inside DATA_DIR/backups, but never inside attachments —
  // not even when a symlinked parent directory hides it there.
  const target = join(f.directory, "backups", "snapshot-a");
  const insideAttachments = runBackup(f.directory, join(f.directory, "attachments", "nested-backup"));
  assert.equal(insideAttachments.ok, false, "the backup target must not sit inside attachments/");
  mkdirSync(join(f.directory, "backups"), { recursive: true });
  symlinkSync(join(f.directory, "attachments"), join(f.directory, "backups", "alias"));
  const symlinked = runBackup(f.directory, join(f.directory, "backups", "alias", "snapshot-b"));
  assert.equal(symlinked.ok, false, "a symlinked parent must not smuggle the target into attachments/");
  const result = runBackup(f.directory, target);
  assert.ok(result.ok, `backup failed: ${result.output}`);
  assert.ok(statSync(target).isDirectory(), "the backup product must be a directory");
  assert.deepEqual(readdirSync(target).sort(), ["attachments", "notes.sqlite"], "the backup holds exactly the database and the blob store");
  assert.ok(statSync(join(target, "notes.sqlite")).isFile());
  assert.ok(statSync(join(target, "attachments")).isDirectory());
  const backedUp = attachmentFiles(target);
  assert.deepEqual(backedUp, [sha256(original), sha256(preview)].map((h) => `${h.slice(0, 2)}/${h}`).sort(), "backup must copy each blob and skip .tmp files");
  assert.equal(readFileSync(blobPath(target, sha256(original))).equals(original), true);
  const again = runBackup(f.directory, target);
  assert.equal(again.ok, false, "the script must refuse an existing backup target");
  const preexisting = join(f.directory, "backups", "already-there");
  mkdirSync(preexisting, { recursive: true });
  const occupied = runBackup(f.directory, preexisting);
  assert.equal(occupied.ok, false, "the script must refuse an existing directory even when empty");
  // Restore from a copy: the backup itself stays a pristine, retained artifact.
  const restoredDir = join(f.directory, "restored");
  cpSync(target, restoredDir, { recursive: true });
  const restored = await startServer({ dataDir: restoredDir, port: 0, host: "127.0.0.1", serveStatic: false });
  try {
    const url = () => restored.url;
    const aliceRestored = new Browser(url);
    status(await aliceRestored.request("/api/auth/login", { method: "POST", body: { handle: "alice", password } }), 200);
    assert.equal(status(await aliceRestored.request("/api/session"), 200).user.id, user.id);
    const aliceCookie = new Browser(url);
    aliceCookie.cookie = alice.cookie;
    assert.equal(status(await aliceCookie.request("/api/session"), 200).user.id, user.id, "backed-up sessions must still authenticate");
    const guestRestored = new Browser(url);
    const pages = status(await aliceRestored.request("/api/records/personal/pages"), 200);
    assert.ok(pages.some((row: Json) => row.id === "media"), "the restored page index must include the uploaded record");
    for (const [path, expected] of [["files/cover.png", original], ["files/cover.preview.png", preview]] as const) {
      const read = await getFile(aliceRestored, "personal", path);
      assert.equal(read.status, 200, `${path} must read back after restore`);
      assert.ok(read.bytes.equals(expected));
      const viaShare = await guestRestored.request(`/api/public/${shareToken}/files?path=${encodeURIComponent(path)}`, { binary: true });
      assert.equal(viaShare.status, 200, `${path} must stay readable through the backed-up share`);
      assert.ok((viaShare.body as Buffer).equals(expected));
    }
  } finally {
    await restored.close();
  }
  await f.stop();
  const rows = fileRows(restoredDir);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => typeof row.hash === "string" && String(row.hash).length === 64));
});
