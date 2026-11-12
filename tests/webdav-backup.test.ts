import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { startServer } from "../server/index.ts";
import { nextDue } from "../server/backups.ts";

// UC-31 自动备份到云盘 acceptance. A filesystem-backed WebDAV stub enforces
// the real wire contract: MKCOL collections, Content-Length PUTs, Depth:1
// PROPFIND with getcontentlength, DELETE — plus a mid-upload disconnect to
// prove part-granularity resume. Browser mirrors the other HTTP tests.

type Json = any;
type RunningServer = Awaited<ReturnType<typeof startServer>>;
interface Reply { status: number; body: Json; headers: Headers }
interface RequestOptions { method?: string; body?: unknown; raw?: BodyInit; contentType?: string }

class Browser {
  cookie = "";
  constructor(private readonly serverUrl: () => string) {}
  async request(path: string, options: RequestOptions = {}): Promise<Reply> {
    const headers: Record<string, string> = { Origin: this.serverUrl() };
    if (this.cookie) headers.Cookie = this.cookie;
    let body: BodyInit | undefined;
    if (options.body !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(options.body); }
    else if (options.raw !== undefined) { headers["Content-Type"] = options.contentType ?? "application/octet-stream"; body = options.raw; }
    const response = await fetch(`${this.serverUrl()}${path}`, { method: options.method ?? "GET", headers, body, redirect: "manual" });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) {
      const known = new Map(this.cookie.split("; ").filter(Boolean).map((part) => [part.slice(0, part.indexOf("=")), part.slice(part.indexOf("=") + 1)] as const));
      for (const cookie of cookies) {
        const first = cookie.split(";", 1)[0];
        const key = first.slice(0, first.indexOf("=")), value = first.slice(first.indexOf("=") + 1);
        if (!value || /(?:^|;)\s*max-age=0(?:;|$)/i.test(cookie)) known.delete(key); else known.set(key, value);
      }
      this.cookie = [...known].map(([key, value]) => `${key}=${value}`).join("; ");
    }
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  }
}

function status(reply: Reply, expected: number): Json {
  assert.equal(reply.status, expected, JSON.stringify(reply.body));
  return reply.body;
}

/* ————— WebDAV stub ————— */

interface DavStub {
  url: string;
  directory: string;
  user: string;
  password: string;
  /** Every PUT object name that reached the stub. */
  putLog: string[];
  /** Fail all requests with 401 while true. */
  failAuth: boolean;
  /** Fail only PUT requests with 401 while true (archival + probe still pass). */
  failAuthPut: boolean;
  /** Destroy the request stream partway through `.part-` PUTs whose name
   *  ends with dropNameSuffix, for the first `dropLimit` such requests. */
  dropNameSuffix: string;
  dropLimit: number;
  dropAfterBytes: number;
  drops: number;
  /** Hold every PUT this long before streaming (makes runs overlap). */
  putHoldMs: number;
  close(): Promise<void>;
  objects(): Promise<string[]>;
}

async function davStub(directory: string): Promise<DavStub> {
  const root = join(directory, "dav-store");
  const stub: DavStub = {
    url: "", directory: root, user: "dav-user", password: "dav-pass",
    putLog: [], failAuth: false, failAuthPut: false, dropNameSuffix: "", dropLimit: 0, dropAfterBytes: 512 * 1024, drops: 0, putHoldMs: 0,
    async close() { server.closeAllConnections(); await new Promise<void>((ok, bad) => server.close((e) => e ? bad(e) : ok())); },
    async objects() { return await readdir(join(root, "backups")).catch(() => [] as string[]); },
  };
  const fileOf = (pathname: string) => join(root, decodeURIComponent(pathname).replace(/^\/+/, ""));
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "http://stub").pathname;
    const send = (code: number, body = "", type = "text/plain") => {
      res.writeHead(code, { "Content-Type": type });
      res.end(body);
    };
    const auth = req.headers.authorization ?? "";
    const expected = `Basic ${Buffer.from(`${stub.user}:${stub.password}`).toString("base64")}`;
    if (auth !== expected || stub.failAuth || (stub.failAuthPut && req.method === "PUT")) { send(401); return; }

    if (req.method === "MKCOL") {
      const dir = fileOf(pathname);
      try { await stat(dir); send(405); return; } catch { /* absent */ }
      await mkdir(dir, { recursive: true });
      send(201); return;
    }
    if (req.method === "PUT") {
      const file = fileOf(pathname);
      await mkdir(dirname(file), { recursive: true });
      const name = basename(pathname);
      stub.putLog.push(name);
      if (stub.putHoldMs > 0) await new Promise((ok) => setTimeout(ok, stub.putHoldMs));
      // Arm the drop for this request before data flows.
      const dropThis = name.endsWith(stub.dropNameSuffix || "\0") && stub.drops < stub.dropLimit;
      const out = createWriteStream(file);
      req.pipe(out);
      let received = 0;
      req.on("data", (chunk) => {
        received += chunk.length;
        if (dropThis && received > stub.dropAfterBytes) {
          stub.drops += 1;
          req.socket.destroy();
        }
      });
      out.on("finish", () => send(201));
      req.on("error", () => undefined);
      out.on("error", () => undefined);
      return;
    }
    if (req.method === "DELETE") {
      const file = fileOf(pathname);
      try { await rm(file, { recursive: true }); send(204); } catch { send(404); }
      return;
    }
    if (req.method === "PROPFIND") {
      const dir = fileOf(pathname);
      try {
        const info = await stat(dir);
        if (!info.isDirectory()) { send(404); return; }
      } catch { send(404); return; }
      const rows: string[] = [];
      const hrefOf = (name: string) => encodeURI(`${pathname.replace(/\/+$/, "")}/${name}`);
      const dirRow = `<d:response><d:href>${encodeURI(pathname.endsWith("/") ? pathname : `${pathname}/`)}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
      rows.push(dirRow);
      for (const name of await readdir(dir)) {
        const info = await stat(join(dir, name));
        if (info.isDirectory()) rows.push(`<d:response><d:href>${hrefOf(name)}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);
        else rows.push(`<d:response><d:href>${hrefOf(name)}</d:href><d:propstat><d:prop><d:getcontentlength>${info.size}</d:getcontentlength><d:getlastmodified>${info.mtime.toUTCString()}</d:getlastmodified><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);
      }
      send(207, `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${rows.join("")}</d:multistatus>`, "application/xml");
      return;
    }
    send(501);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  stub.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/backups`;
  return stub;
}

/* ————— fixture ————— */

const password = "Correct-horse-battery-2026!";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "heinote-backup-"));
  let server: RunningServer | undefined = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false, backupRetryDelays: [10] });
  const dav = await davStub(directory);
  t.after(async () => {
    await server?.close();
    await dav.close();
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("heinote-backup-"));
    await rm(target, { recursive: true, force: true });
  });
  return {
    directory, dav,
    browser: () => new Browser(() => server!.url),
    async restart() {
      await server!.close();
      server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false, backupRetryDelays: [10] });
    },
  };
}

async function register(browser: Browser, handle: string) {
  status(await browser.request("/api/auth/register", {
    method: "POST", body: { handle, displayName: handle.toUpperCase(), password },
  }), 201);
}

async function configure(browser: Browser, dav: DavStub, extra?: Json) {
  return status(await browser.request("/api/admin/backups/settings", {
    method: "PUT",
    body: {
      enabled: true,
      webdav: { url: dav.url, user: dav.user, password: dav.password },
      chunkBytes: 4 * 1024 * 1024,
      ...extra,
    },
  }), 200);
}

async function runBackup(browser: Browser): Promise<Reply> {
  return await browser.request("/api/admin/backups/run", { method: "POST", body: {} });
}

async function backupStatus(browser: Browser): Promise<Json> {
  return status(await browser.request("/api/admin/backups"), 200);
}

/** Upload `bytes` as one attachment through the real files API (≤8mb limit). */
async function putAttachment(browser: Browser, bytes: number) {
  const data = Buffer.alloc(bytes);
  for (let i = 0; i < data.length; i += 4096) data.writeUInt32BE(i % 997, i);
  status(await browser.request(`/api/files/personal?path=${encodeURIComponent(`blob-${bytes}.bin`)}`, {
    method: "PUT", raw: data,
  }), 200);
}

/* Minimal zip central-directory reader + entry extractor (STORE method). */
function zipEntries(zip: Buffer): { name: string; size: number; offset: number }[] {
  const entries: { name: string; size: number; offset: number }[] = [];
  let i = zip.length - 22;
  while (i > 0 && zip.readUInt32LE(i) !== 0x06054b50) i--;
  assert.equal(zip.readUInt32LE(i), 0x06054b50, "no EOCD found");
  let p = zip.readUInt32LE(i + 16);
  while (p < zip.length) {
    if (zip.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    entries.push({ name: zip.subarray(p + 46, p + 46 + nameLen).toString("utf8"), size: zip.readUInt32LE(p + 20), offset: zip.readUInt32LE(p + 42) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function entryContent(zip: Buffer, entry: { offset: number; size: number }): Buffer {
  const lh = entry.offset;
  assert.equal(zip.readUInt32LE(lh), 0x04034b50, "local header missing");
  const nameLen = zip.readUInt16LE(lh + 26);
  const extraLen = zip.readUInt16LE(lh + 28);
  // Local headers carry sizes in the trailing data descriptor (flag 0x0808);
  // the authoritative size is the central-directory field.
  return zip.subarray(lh + 30 + nameLen + extraLen, lh + 30 + nameLen + extraLen + entry.size);
}

/* ————— AC-01 完整备份 ————— */

test("UC-31 AC-01: backup uploads part group and manifest; joined archive is a valid restorable zip", async (t) => {
  const f = await fixture(t);
  const admin = f.browser();
  await register(admin, "admin");
  await putAttachment(admin, 2 * 1024 * 1024 + 123);
  await configure(admin, f.dav);

  // Config endpoint never leaks the password.
  const before = await backupStatus(admin);
  assert.equal(before.config.webdav.passwordSet, true);
  assert.equal("password" in before.config.webdav, false);

  const result = status(await runBackup(admin), 200);
  assert.equal(result.result.kind, "ok");

  const objects = await f.dav.objects();
  const manifestName = objects.find((name) => name.endsWith(".manifest.json"));
  assert.ok(manifestName, "manifest missing remotely");
  const manifest = JSON.parse(await readFile(join(f.dav.directory, "backups", manifestName), "utf8"));
  assert.equal(manifest.app, "heinote");
  assert.equal(manifest.parts.length, Math.max(1, Math.ceil(manifest.bytes / manifest.chunkBytes)));
  for (const part of manifest.parts) {
    assert.equal(statSync(join(f.dav.directory, "backups", part.name)).size, part.size, `${part.name} size mismatch`);
    assert.ok(objects.includes(part.name));
  }
  assert.ok(manifest.sha256 && manifest.sha256.length === 64, "whole-archive sha256 missing");

  // Join parts → valid zip with notes.sqlite + streamed attachments.
  const joined = Buffer.concat(manifest.parts.map((part: Json) =>
    readFileSync(join(f.dav.directory, "backups", part.name))));
  assert.equal(createHash("sha256").update(joined).digest("hex"), manifest.sha256);
  assert.equal(joined.length, manifest.bytes);
  const entries = zipEntries(joined);
  assert.ok(entries.some((e) => e.name === "notes.sqlite"), "snapshot missing in archive");
  assert.ok(entries.some((e) => e.name.startsWith("attachments/")), "attachments missing in archive");
  const dbEntry = entries.find((e) => e.name === "notes.sqlite")!;
  const snapshotBytes = entryContent(joined, dbEntry);
  assert.equal(snapshotBytes.subarray(0, 16).toString("latin1"), "SQLite format 3\0");

  const after = await backupStatus(admin);
  assert.equal(after.state.lastResult, "ok");
  assert.equal(after.state.lastArchiveId, manifest.archiveId);
  assert.equal(after.state.remoteCount, 1);
  assert.equal(after.state.pending, null);
});

/* ————— AC-02 保留清理 ————— */

test("UC-31 AC-02: retention keeps only the newest N archive groups", async (t) => {
  const f = await fixture(t);
  const admin = f.browser();
  await register(admin, "admin");
  await putAttachment(admin, 512 * 1024);
  await configure(admin, f.dav, { retention: 2 });

  for (let i = 0; i < 3; i += 1) {
    status(await runBackup(admin), 200);
    await new Promise((ok) => setTimeout(ok, 1100)); // distinct archive timestamps
  }
  const objects = await f.dav.objects();
  const manifests = objects.filter((name) => name.endsWith(".manifest.json"));
  assert.equal(manifests.length, 2, JSON.stringify(objects));
  const groups = new Set(objects.map((name) => /^heinote-backup-(.+?)\.(?:part-\d+|manifest\.json)$/.exec(name)?.[1]).filter(Boolean));
  assert.equal(groups.size, 2);
  const after = await backupStatus(admin);
  assert.equal(after.state.remoteCount, 2);
});

/* ————— AC-03 凭据失效 ————— */

test("UC-31 AC-03: expired credentials record an auth failure; remote untouched, local archive kept", async (t) => {
  const f = await fixture(t);
  const admin = f.browser();
  await register(admin, "admin");
  await putAttachment(admin, 256 * 1024);
  await configure(admin, f.dav);
  status(await runBackup(admin), 200);
  const remoteBefore = await f.dav.objects();

  // 只让 PUT 认证失败：归档与探测仍走通，失败落在上传阶段，本地归档留下。
  f.dav.failAuthPut = true;
  const reply = await runBackup(admin);
  assert.equal(reply.status, 502);
  const after = await backupStatus(admin);
  assert.equal(after.state.lastResult, "auth");
  assert.ok(after.state.lastError.includes("认证失败"));
  assert.deepEqual(await f.dav.objects(), remoteBefore);
  // 本地归档保留 pending 供恢复后续传（目标绑定不变）。
  assert.ok(after.state.pending);
  const backups = await readdir(join(f.directory, "backups"));
  assert.ok(backups.some((name) => name.startsWith("archive-")), "local archive must survive the failure");

  // 凭据恢复：按分片续传同一归档，不整份重传。
  f.dav.failAuthPut = false;
  const putsBefore = f.dav.putLog.length;
  status(await runBackup(admin), 200);
  const newPuts = f.dav.putLog.slice(putsBefore).filter((name) => name.includes(".part-"));
  const done = await backupStatus(admin);
  assert.equal(done.state.lastResult, "ok");
  assert.equal(done.state.pending, null);
  // 同一 archiveId 续传：新 PUT 若包含 part，名字须属于同一归档组。
  const pendingPrefix = `heinote-backup-${after.state.pending.archiveId}`;
  assert.ok(newPuts.every((name) => name.startsWith(pendingPrefix)));
});

/* ————— AC-04 并发互斥 ————— */

test("UC-31 AC-04: a second trigger while a run is in flight does not run concurrently", async (t) => {
  const f = await fixture(t);
  const admin = f.browser();
  await register(admin, "admin");
  await putAttachment(admin, 6 * 1024 * 1024);
  await configure(admin, f.dav);

  // Hold each PUT 400 ms so the first run is still in flight when the
  // second trigger lands — it must short-circuit, not run concurrently.
  f.dav.putHoldMs = 400;
  const first = runBackup(admin);
  await new Promise((ok) => setTimeout(ok, 200));
  const second = await runBackup(admin);
  const firstReply = await first;
  f.dav.putHoldMs = 0;
  assert.equal(firstReply.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body.result.kind, "skipped", JSON.stringify(second.body));
  const objects = await f.dav.objects();
  assert.equal(objects.filter((name) => name.endsWith(".manifest.json")).length, 1);
});

/* ————— AC-06 断点续传 ————— */

test("UC-31 AC-06: an interrupted upload resumes at part granularity — sent parts are not re-uploaded", async (t) => {
  const f = await fixture(t);
  const admin = f.browser();
  await register(admin, "admin");
  await putAttachment(admin, 5 * 1024 * 1024); // ≥2 parts at 4 MiB chunking
  await configure(admin, f.dav);

  // Break the first two part-2 attempts mid-stream so the run fails after
  // its (test-shortened) retries, but a later resume run succeeds.
  f.dav.dropNameSuffix = ".part-2";
  f.dav.dropLimit = 2;
  const first = await runBackup(admin);
  assert.equal(first.status, 502, JSON.stringify(first.body));
  const failed = await backupStatus(admin);
  assert.equal(failed.state.lastResult, "network");
  assert.ok(failed.state.pending, "pending resume info must persist");

  // 替身端：part-1 完整落盘，part-2 被截断，无 manifest。
  const midObjects = await f.dav.objects();
  const part1 = midObjects.find((name) => name.endsWith(".part-1"));
  assert.ok(part1, "part-1 should have landed before the drop");
  assert.ok(!midObjects.some((name) => name.endsWith(".manifest.json")));

  const putsBefore = f.dav.putLog.length;
  const resumed = await runBackup(admin);
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  const newPuts = f.dav.putLog.slice(putsBefore);
  assert.ok(!newPuts.includes(part1), `part-1 was re-uploaded: ${JSON.stringify(newPuts)}`);
  assert.ok(newPuts.some((name) => name.endsWith(".manifest.json")));

  // 拼接验证完整归档。
  const objects = await f.dav.objects();
  const manifestName = objects.find((name) => name.endsWith(".manifest.json"))!;
  const manifest = JSON.parse(await readFile(join(f.dav.directory, "backups", manifestName), "utf8"));
  const joined = Buffer.concat(manifest.parts.map((part: Json) =>
    readFileSync(join(f.dav.directory, "backups", part.name))));
  assert.equal(createHash("sha256").update(joined).digest("hex"), manifest.sha256);
  const done = await backupStatus(admin);
  assert.equal(done.state.lastResult, "ok");
  assert.equal(done.state.pending, null);
});

/* ————— AC-07 内存上限 ————— */

test("UC-31 AC-07: peak RSS delta stays under 256 MB for an archive far larger than memory", async (t) => {
  const f = await fixture(t);
  const admin = f.browser();
  await register(admin, "admin");
  await configure(admin, f.dav);

  // Write a 240 MB attachment blob straight into DATA_DIR + files index —
  // bypasses the 8 MB API limit while producing the real on-disk layout.
  const hash = createHash("sha256").update(Buffer.from("uc31-ac07")).digest("hex");
  mkdirSync(join(f.directory, "attachments", hash.slice(0, 2)), { recursive: true });
  const blobPath = join(f.directory, "attachments", hash.slice(0, 2), hash);
  const out = createWriteStream(blobPath);
  const block = randomBytes(8 * 1024 * 1024);
  for (let i = 0; i < 30; i += 1) { out.write(block); await new Promise((ok) => out.once("drain", ok)); }
  await new Promise<void>((ok, bad) => out.end((e?: Error) => e ? bad(e) : ok()));
  const size = statSync(blobPath).size;
  assert.ok(size > 200 * 1024 * 1024);
  const db = new DatabaseSync(join(f.directory, "notes.sqlite"));
  try {
    db.prepare("INSERT INTO files(scope,path,type,size,hash) VALUES(?,?,?,?,?)")
      .run("personal", "big.bin", "application/octet-stream", size, hash);
  } finally { db.close(); }

  const rss: number[] = [];
  const sampler = setInterval(() => rss.push(process.memoryUsage().rss), 25);
  const baseline = Math.max(...rss, process.memoryUsage().rss);
  try {
    status(await runBackup(admin), 200);
  } finally { clearInterval(sampler); }
  const peak = Math.max(...rss);
  const delta = peak - baseline;
  assert.ok(delta < 256 * 1024 * 1024, `RSS delta ${(delta / 1024 / 1024).toFixed(0)} MB exceeded 256 MB`);

  const manifestName = (await f.dav.objects()).find((name) => name.endsWith(".manifest.json"))!;
  const manifest = JSON.parse(await readFile(join(f.dav.directory, "backups", manifestName), "utf8"));
  assert.ok(manifest.bytes > 200 * 1024 * 1024);
});

/* ————— 调度 nextDue ————— */

test("UC-31 nextDue: server-local daily slot, interrupted does not consume the day, failure does not retry", () => {
  const config = { enabled: true, schedule: { hour: 3, minute: 0 } };
  const idle = { running: false, lastStartedAt: null, lastResult: null };
  assert.equal(nextDue(new Date(2026, 10, 12, 2, 59), config, idle), false);
  assert.equal(nextDue(new Date(2026, 10, 12, 3, 0), config, idle), true);
  assert.equal(nextDue(new Date(2026, 10, 12, 23, 30), config, idle), true);
  assert.equal(nextDue(new Date(2026, 10, 12, 4, 0), { ...config, enabled: false }, idle), false);
  assert.equal(nextDue(new Date(2026, 10, 12, 4, 0), config, { ...idle, running: true }), false);
  // 当日已结束（ok/失败）→ 不再触发；失败当日不重跑。
  assert.equal(nextDue(new Date(2026, 10, 12, 4, 0), config,
    { running: false, lastStartedAt: new Date(2026, 10, 12, 3, 0).toISOString(), lastResult: "ok" }), false);
  assert.equal(nextDue(new Date(2026, 10, 12, 4, 0), config,
    { running: false, lastStartedAt: new Date(2026, 10, 12, 3, 0).toISOString(), lastResult: "network" }), false);
  // 中断不占当日额度 → 重启后同日补跑。
  assert.equal(nextDue(new Date(2026, 10, 12, 4, 0), config,
    { running: false, lastStartedAt: new Date(2026, 10, 12, 3, 0).toISOString(), lastResult: "interrupted" }), true);
  // 昨日记录不影响今日。
  assert.equal(nextDue(new Date(2026, 10, 13, 3, 30), config,
    { running: false, lastStartedAt: new Date(2026, 10, 12, 3, 0).toISOString(), lastResult: "ok" }), true);
});

/* ————— 设置校验 ————— */

test("UC-31: settings validation, masked password round-trip, empty password keeps the stored one", async (t) => {
  const f = await fixture(t);
  const admin = f.browser();
  await register(admin, "admin");
  const outsider = f.browser();
  await register(outsider, "bob");

  status(await outsider.request("/api/admin/backups"), 403);
  status(await admin.request("/api/admin/backups/settings", { method: "PUT", body: { webdav: { url: "not-a-url" } } }), 400);

  await configure(admin, f.dav);
  // 只改保留份数，密码留空 → 存储密码保留。
  status(await admin.request("/api/admin/backups/settings", { method: "PUT", body: { retention: 3 } }), 200);
  const stored = await backupStatus(admin);
  assert.equal(stored.config.retention, 3);
  assert.equal(stored.config.webdav.passwordSet, true);
  // 磁盘上的凭据文件不是普通可读权限。
  const mode = statSync(join(f.directory, "backup-config.json")).mode & 0o777;
  assert.equal(mode, 0o600, `config mode ${mode.toString(8)}`);

  // 测试连接：空密码用已存储凭据；坏凭据报凭据失效。
  const ok = status(await admin.request("/api/admin/backups/test", { method: "POST", body: { webdav: { url: f.dav.url } } }), 200);
  assert.equal(ok.ok, true);
  const bad = status(await admin.request("/api/admin/backups/test", { method: "POST", body: { webdav: { url: f.dav.url, user: f.dav.user, password: "wrong" } } }), 200);
  assert.equal(bad.ok, false);
  assert.equal(bad.kind, "auth");
});
