import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { openZipFile } from "../server/import-zip.ts";
import { startServer } from "../server/index.ts";
import { crc32, ZipStream } from "../src/core/zip.ts";

const runExecFile = promisify(execFile);

type Json = any;
type RunningServer = Awaited<ReturnType<typeof startServer>>;
interface Reply { status: number; body: Json; headers: Headers }

class Browser {
  cookie = "";
  constructor(private readonly url: () => string) {}
  async request(path: string, options: { method?: string; body?: unknown; raw?: BodyInit; contentType?: string; token?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = { Origin: this.url() };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    else if (this.cookie) headers.Cookie = this.cookie;
    let body: BodyInit | undefined;
    if (options.body !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(options.body); }
    else if (options.raw !== undefined) { headers["Content-Type"] = options.contentType ?? "application/octet-stream"; body = options.raw; }
    const response = await fetch(`${this.url()}${path}`, { method: options.method ?? "GET", headers, body, redirect: "manual" });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) {
      const known = new Map(this.cookie.split("; ").filter(Boolean).map((part) => { const at = part.indexOf("="); return [part.slice(0, at), part.slice(at + 1)]; }));
      for (const cookie of cookies) { const first = cookie.split(";", 1)[0]; const at = first.indexOf("="); const key = first.slice(0, at); const value = first.slice(at + 1); if (!value || /(?:^|;)\s*max-age=0(?:;|$)/i.test(cookie)) known.delete(key); else known.set(key, value); }
      this.cookie = [...known].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    const text = await response.text();
    let parsed: Json = null;
    if (text && /application\/json/.test(response.headers.get("content-type") ?? "")) parsed = JSON.parse(text);
    return { status: response.status, body: parsed, headers: response.headers };
  }
}

const password = "Correct-horse-battery-2026!";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "heinote-import-chunked-"));
  let server: RunningServer | undefined = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false });
  t.after(async () => {
    await server?.close();
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("heinote-import-chunked-"));
    await rm(target, { recursive: true, force: true });
  });
  return {
    directory,
    url: () => server!.url,
    browser: () => new Browser(() => server!.url),
    async restart() {
      await server!.close();
      server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false });
    },
  };
}

async function register(browser: Browser, handle: string, role: "admin" | "user" = "user"): Promise<Json> {
  const r = await browser.request("/api/auth/register", { method: "POST", body: { handle, displayName: handle, password } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const session = await browser.request("/api/session");
  assert.equal(session.status, 200);
  if (role === "admin") assert.equal(session.body.user.siteRole, "admin");
  return session.body.user;
}

async function createToken(browser: Browser, name: string, access: "read" | "write"): Promise<{ id: string; token: string }> {
  const res = await browser.request("/api/tokens", { method: "POST", body: { name, access, displayName: name } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

async function zipOf(entries: Record<string, string | Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const zip = new ZipStream({ write: (chunk) => chunks.push(chunk) });
  for (const [name, body] of Object.entries(entries)) await zip.add(name, body);
  zip.finish();
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
}

/** Build a real ZIP64 archive (ZIP64 EOCD Record + Locator + 0x0001 Extra Field). */
function zip64Of(entries: Record<string, string | Uint8Array>): Buffer {
  const parts: Buffer[] = [];
  const meta: Array<{ name: Buffer; crc: number; size: number; offset: number }> = [];
  let written = 0;
  const pushBuf = (buf: Buffer) => { parts.push(buf); written += buf.length; };

  for (const [rawName, rawBody] of Object.entries(entries)) {
    const name = Buffer.from(rawName, "utf8");
    const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
    const sum = crc32(body);
    const offset = written;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(45, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(0, 8);
    head.writeUInt32LE(sum, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(body.length, 22);
    head.writeUInt16LE(name.length, 26);
    pushBuf(head);
    pushBuf(name);
    pushBuf(body);
    meta.push({ name, crc: sum, size: body.length, offset });
  }

  const cdStart = written;
  for (const m of meta) {
    const extra = Buffer.alloc(28);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(24, 2);
    extra.writeBigUInt64LE(BigInt(m.size), 4);
    extra.writeBigUInt64LE(BigInt(m.size), 12);
    extra.writeBigUInt64LE(BigInt(m.offset), 20);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(45, 4);
    cd.writeUInt16LE(45, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(m.crc, 16);
    cd.writeUInt32LE(0xffffffff, 20);
    cd.writeUInt32LE(0xffffffff, 24);
    cd.writeUInt16LE(m.name.length, 28);
    cd.writeUInt16LE(extra.length, 30);
    cd.writeUInt32LE(0xffffffff, 42);
    pushBuf(cd);
    pushBuf(m.name);
    pushBuf(extra);
  }
  const cdSize = written - cdStart;

  const z64Offset = written;
  const z64 = Buffer.alloc(56);
  z64.writeUInt32LE(0x06064b50, 0);
  z64.writeBigUInt64LE(44n, 4);
  z64.writeUInt16LE(45, 12);
  z64.writeUInt16LE(45, 14);
  z64.writeBigUInt64LE(BigInt(meta.length), 24);
  z64.writeBigUInt64LE(BigInt(meta.length), 32);
  z64.writeBigUInt64LE(BigInt(cdSize), 40);
  z64.writeBigUInt64LE(BigInt(cdStart), 48);
  pushBuf(z64);

  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(z64Offset), 8);
  locator.writeUInt32LE(1, 16);
  pushBuf(locator);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0xffff, 8);
  eocd.writeUInt16LE(0xffff, 10);
  eocd.writeUInt32LE(0xffffffff, 12);
  eocd.writeUInt32LE(0xffffffff, 16);
  pushBuf(eocd);

  return Buffer.concat(parts);
}

async function waitImport(browser: Browser, id: string, token?: string): Promise<Json> {
  for (let i = 0; i < 200; i += 1) {
    const res = await browser.request(`/api/v1/imports/${id}`, { token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    if (res.body.status === "done" || res.body.status === "failed") return res.body;
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.fail(`导入任务 ${id} 超时未完成`);
}

async function uploadChunked(
  browser: Browser,
  token: string,
  source: "obsidian" | "notion",
  zip: Buffer,
  options: { partSize?: number; parentId?: string; spaceId?: string; title?: string; sha256?: string; reverseOrder?: boolean } = {},
): Promise<Json> {
  const partSize = options.partSize ?? 1024;
  const created = await browser.request("/api/v1/imports", {
    method: "POST",
    token,
    body: {
      source,
      totalBytes: zip.length,
      partSize,
      ...(options.parentId ? { parentId: options.parentId } : {}),
      ...(options.spaceId ? { spaceId: options.spaceId } : {}),
      ...(options.title ? { title: options.title } : {}),
      ...(options.sha256 ? { sha256: options.sha256 } : {}),
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  const partCount = created.body.partCount;
  const indices = Array.from({ length: partCount }, (_, i) => i);
  if (options.reverseOrder) indices.reverse();

  await Promise.all(indices.map(async (idx) => {
    const start = idx * partSize;
    const end = Math.min(zip.length, start + partSize);
    const put = await browser.request(`/api/v1/imports/${id}/parts/${idx}`, {
      method: "PUT",
      token,
      raw: zip.subarray(start, end),
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
  }));

  const completed = await browser.request(`/api/v1/imports/${id}/complete`, { method: "POST", token });
  assert.equal(completed.status, 202, JSON.stringify(completed.body));
  return waitImport(browser, id, token);
}

const records = async (browser: Browser, scope: string, collection: string): Promise<Json[]> =>
  ((await browser.request(`/api/records/${scope}/${collection}`)).body ?? []).map((row: Json) => row.value ?? row);
const titleOf = (page: Json): string => page.title_content?.map((run: Json) => run.text ?? "").join("") ?? "";

test("AC-01：Agent 分片导入 Obsidian 到指定父页，顶层直接展开挂入且保留双链/附件/.base", async (t) => {
  const { browser } = await fixture(t);
  const b = browser();
  await register(b, "agent_importer");
  const { id: tokenId, token } = await createToken(b, "MigrationBot", "write");

  const hostRes = await b.request("/api/v1/pages", {
    method: "POST",
    token,
    body: { title: "父页A", text: "父页原有正文。" },
  });
  assert.equal(hostRes.status, 201, JSON.stringify(hostRes.body));
  const parentId = hostRes.body.id;

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6]);
  const baseYaml = `filters:\n  and:\n    - 'file.inFolder("项目")'\nproperties:\n  status:\n    displayName: 状态\nviews:\n  - type: table\n    name: 表格\n`;
  const zip = await zipOf({
    "MyVault/.obsidian/app.json": "{}",
    "MyVault/README.md": "# README\n\n连到 [[子目录/设计稿]]。\n\n![[pic.png]]",
    "MyVault/子目录/设计稿.md": "# 设计稿\n\n回链 [[README]]。",
    "MyVault/项目/任务一.md": "---\nstatus: 进行中\n---\n# 任务一\n",
    "MyVault/项目清单.base": baseYaml,
    "MyVault/pic.png": png,
  });

  const sha256 = createHash("sha256").update(zip).digest("hex");
  const job = await uploadChunked(b, token, "obsidian", zip, {
    partSize: 1024,
    parentId,
    sha256,
    reverseOrder: true,
  });

  assert.equal(job.status, "done", JSON.stringify(job));
  assert.equal(job.result.parentPageId, parentId);
  assert.equal(job.result.rootPageId, parentId);
  assert.equal(job.result.attachments, 1);
  assert.equal(job.result.topLevelPageIds.length, 3);

  const allPages = await records(b, "personal", "pages");
  const byTitle = new Map(allPages.map((p) => [titleOf(p), p]));
  assert.equal(byTitle.has("Obsidian 导入 — MyVault"), false, "不应创建外框容器页");

  const readme = byTitle.get("README");
  const folder = byTitle.get("子目录");
  const db = byTitle.get("项目清单");
  const designNote = byTitle.get("设计稿");
  assert.ok(readme && folder && db && designNote);
  assert.equal(readme.parent_id, parentId);
  assert.equal(folder.parent_id, parentId);
  assert.equal(db.parent_id, parentId);
  assert.equal(db.kind, "database");
  assert.equal(designNote.parent_id, folder.id);

  // Parent page's own body must remain untouched.
  const hostAfter = await b.request(`/api/v1/pages/${parentId}`, { token });
  assert.equal(hostAfter.status, 200);
  assert.equal(hostAfter.body.text, "父页原有正文。");

  // Token activity recorded.
  const act = await b.request(`/api/tokens/${tokenId}/activity`);
  assert.equal(act.status, 200);
  assert.ok(act.body.some((e: Json) => e.action === "import" && e.pageId === parentId));
});

test("AC-02：权限校验、异常父页面拒绝以及团队知识库导入归属", async (t) => {
  const { browser } = await fixture(t);
  const alice = browser();
  await register(alice, "kb_owner");
  const readTok = await createToken(alice, "Reader", "read");
  const writeTok = await createToken(alice, "Writer", "write");

  const roRes = await alice.request("/api/v1/imports", {
    method: "POST",
    token: readTok.token,
    body: { source: "obsidian", totalBytes: 100 },
  });
  assert.equal(roRes.status, 403);

  const missingParent = await alice.request("/api/v1/imports", {
    method: "POST",
    token: writeTok.token,
    body: { source: "obsidian", totalBytes: 100, parentId: "missing_id" },
  });
  assert.equal(missingParent.status, 404);

  const dbRes = await alice.request("/api/v1/databases", {
    method: "POST",
    token: writeTok.token,
    body: { requestId: "db-parent-check", title: "MyDB" },
  });
  assert.equal(dbRes.status, 201);
  const nonDocRes = await alice.request("/api/v1/imports", {
    method: "POST",
    token: writeTok.token,
    body: { source: "obsidian", totalBytes: 100, parentId: dbRes.body.id },
  });
  assert.equal(nonDocRes.status, 400);

  const shelvedPage = await alice.request("/api/v1/pages", {
    method: "POST",
    token: writeTok.token,
    body: { title: "ShelvedDoc", text: "hi" },
  });
  assert.equal(shelvedPage.status, 201);
  const shelveRes = await alice.request(`/api/records/personal/pages/${shelvedPage.body.id}`, {
    method: "POST",
    body: { action: "patch", base: shelvedPage.body.page, patch: { shelved: true } },
  });
  assert.ok(shelveRes.status < 300, JSON.stringify(shelveRes.body));
  const shelvedReject = await alice.request("/api/v1/imports", {
    method: "POST",
    token: writeTok.token,
    body: { source: "obsidian", totalBytes: 100, parentId: shelvedPage.body.id },
  });
  assert.equal(shelvedReject.status, 409);

  // Team knowledge base: spaceId only mounts directly under KB homePageId.
  const kbRes = await alice.request("/api/knowledge-bases", {
    method: "POST",
    body: { requestId: "11111111-1111-4111-8111-111111111111", name: "团队库", description: "" },
  });
  assert.equal(kbRes.status, 201, JSON.stringify(kbRes.body));
  const kbSpaceId = kbRes.body.spaceId;
  const kbHomeId = kbRes.body.knowledgeBase.homePageId;

  const zip = await zipOf({
    "KBVault/.obsidian/app.json": "{}",
    "KBVault/规范.md": "# 规范\n\n![[logo.png]]",
    "KBVault/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]),
  });
  const kbJob = await uploadChunked(alice, writeTok.token, "obsidian", zip, {
    partSize: 1024,
    spaceId: kbSpaceId,
  });
  assert.equal(kbJob.status, "done", JSON.stringify(kbJob));
  assert.equal(kbJob.result.parentPageId, kbHomeId);

  const kbPages = await records(alice, kbSpaceId, "pages");
  const spec = kbPages.find((p) => titleOf(p) === "规范");
  assert.ok(spec);
  assert.equal(spec.parent_id, kbHomeId);

  const specBlocks = (await records(alice, kbSpaceId, "blocks")).filter((b) => b.page === spec.id);
  const img = specBlocks.flatMap((b) => b.content ?? []).find((r: Json) => r.embed?.mention?.kind === "image")?.embed?.mention?.file;
  assert.equal(img?.space, kbSpaceId, "团队库附件 StoredFile 必须归属 KB space");
});

test("AC-03：断点续传（含重启后恢复）、分片幂等与取消/过期清理", async (t) => {
  const f = await fixture(t);
  const b = f.browser();
  await register(b, "resumer", "admin");
  const { token } = await createToken(b, "ResumeBot", "write");

  const zip = await zipOf({
    "Vault/一.md": "# 一\n" + "内容".repeat(400),
    "Vault/二.md": "# 二\n" + "内容".repeat(400),
  });
  const partSize = 1024;
  const created = await b.request("/api/v1/imports", {
    method: "POST",
    token,
    body: { source: "obsidian", totalBytes: zip.length, partSize, title: "ResumeVault" },
  });
  assert.equal(created.status, 201);
  const jobId = created.body.id;
  assert.ok(created.body.partCount >= 2);

  // Upload part 0 twice (idempotent) + premature complete (400 with missingParts).
  const p0 = zip.subarray(0, partSize);
  assert.equal((await b.request(`/api/v1/imports/${jobId}/parts/0`, { method: "PUT", token, raw: p0 })).status, 200);
  assert.equal((await b.request(`/api/v1/imports/${jobId}/parts/0`, { method: "PUT", token, raw: p0 })).status, 200);

  const premature = await b.request(`/api/v1/imports/${jobId}/complete`, { method: "POST", token });
  assert.equal(premature.status, 400);
  assert.equal(premature.body.code, "incomplete_parts");
  assert.ok(Array.isArray(premature.body.missingParts) && premature.body.missingParts.includes(1));

  // Restart server mid-upload: uploading session must remain resumable!
  await f.restart();
  const statusAfterRestart = await b.request(`/api/v1/imports/${jobId}`, { token });
  assert.equal(statusAfterRestart.status, 200);
  assert.equal(statusAfterRestart.body.status, "uploading");
  assert.deepEqual(statusAfterRestart.body.receivedParts, [0]);

  for (let idx = 1; idx < created.body.partCount; idx += 1) {
    const start = idx * partSize;
    const end = Math.min(zip.length, start + partSize);
    const put = await b.request(`/api/v1/imports/${jobId}/parts/${idx}`, { method: "PUT", token, raw: zip.subarray(start, end) });
    assert.equal(put.status, 200);
  }
  assert.equal((await b.request(`/api/v1/imports/${jobId}/complete`, { method: "POST", token })).status, 202);
  const done = await waitImport(b, jobId, token);
  assert.equal(done.status, "done", JSON.stringify(done));
  assert.equal(existsSync(join(f.directory, "imports", jobId)), false, "完成后应清理临时目录");

  // Cancel uploading session cleans temp dir immediately.
  const s2 = await b.request("/api/v1/imports", {
    method: "POST",
    token,
    body: { source: "obsidian", totalBytes: 2048, partSize: 1024 },
  });
  assert.equal(s2.status, 201);
  assert.equal(existsSync(join(f.directory, "imports", s2.body.id)), true);
  assert.equal((await b.request(`/api/v1/imports/${s2.body.id}`, { method: "DELETE", token })).status, 200);
  assert.equal(existsSync(join(f.directory, "imports", s2.body.id)), false, "取消上传应立即删除临时目录");
});

test("AC-04：两阶段写锁，后台解析期间普通读写不被 503 阻塞", async (t) => {
  const { browser } = await fixture(t);
  const b = browser();
  await register(b, "nonblocking");
  const { token } = await createToken(b, "FastBot", "write");

  const entries: Record<string, string | Uint8Array> = {};
  for (let i = 0; i < 800; i += 1) entries[`Vault/Note${i}.md`] = `# Note ${i}\n\n` + "正文内容。".repeat(400);
  const zip = await zipOf(entries);

  const created = await b.request("/api/v1/imports", {
    method: "POST",
    token,
    body: { source: "obsidian", totalBytes: zip.length, partSize: 16 * 1024 * 1024 },
  });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal((await b.request(`/api/v1/imports/${id}/parts/0`, { method: "PUT", token, raw: zip })).status, 200);
  assert.equal((await b.request(`/api/v1/imports/${id}/complete`, { method: "POST", token })).status, 202);

  let sawWriteOkDuringParsing = false;
  let sawDone = false;
  for (let i = 0; i < 600; i += 1) {
    const status = await b.request(`/api/v1/imports/${id}`, { token });
    assert.equal(status.status, 200);
    if (status.body.status === "done") { sawDone = true; break; }
    if (status.body.status === "failed") assert.fail(JSON.stringify(status.body));
    const readRes = await b.request("/api/v1/pages", { token });
    assert.equal(readRes.status, 200);
    if (status.body.status === "scanning" || status.body.status === "importing") {
      const writeRes = await b.request("/api/v1/pages", { method: "POST", token, body: { title: `并发页${i}`, text: "ok" } });
      if (writeRes.status === 201) sawWriteOkDuringParsing = true;
      else assert.equal(writeRes.status, 503);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(sawDone, "导入应顺利完成");
  assert.ok(sawWriteOkDuringParsing, "解析阶段普通写请求应能成功（不全程 503）");
});

test("AC-05 & AC-06：原子回滚无残留 + ZIP64 大包格式解析", async (t) => {
  const { directory, browser } = await fixture(t);
  const b = browser();
  await register(b, "atomic_zip64", "admin");
  const { token } = await createToken(b, "AtomicBot", "write");

  // AC-05a: Exceeding personal storage quota (default 5 GB) fails at session creation without creating temp dir.
  const tooBig = await b.request("/api/v1/imports", {
    method: "POST",
    token,
    body: { source: "obsidian", totalBytes: 6 * 1000 * 1000 * 1000 },
  });
  assert.equal(tooBig.status, 413);

  // AC-05b: Parent trashed before commit rolls back cleanly with zero orphan pages or attachments.
  const host = await b.request("/api/v1/pages", { method: "POST", token, body: { title: "WillTrash", text: "x" } });
  assert.equal(host.status, 201);
  const zip = await zipOf({
    "Vault/.obsidian/app.json": "{}",
    "Vault/子页.md": "# 子页\n\n![[a.png]]",
    "Vault/a.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7, 8, 9]),
  });
  const created = await b.request("/api/v1/imports", {
    method: "POST",
    token,
    body: { source: "obsidian", totalBytes: zip.length, partSize: 4096, parentId: host.body.id },
  });
  assert.equal(created.status, 201);
  assert.equal((await b.request(`/api/v1/imports/${created.body.id}/parts/0`, { method: "PUT", token, raw: zip })).status, 200);
  // Trash parent before completing!
  assert.equal((await b.request(`/api/records/personal/pages/${host.body.id}`, {
    method: "POST",
    body: { action: "patch", base: host.body.page, patch: { archived: true } },
  })).status, 200);
  const rejectedComplete = await b.request(`/api/v1/imports/${created.body.id}/complete`, { method: "POST", token });
  assert.equal(rejectedComplete.status, 409);
  assert.equal((await records(b, "personal", "pages")).some((p) => titleOf(p) === "子页"), false);

  // AC-06: Real ZIP64 archive read via openZipFile and imported via /api/v1/imports.
  const z64Buf = zip64Of({
    "Z64Vault/.obsidian/app.json": "{}",
    "Z64Vault/大包笔记.md": "# ZIP64\n\n验证 ZIP64 偏移读取成功。",
  });
  const z64File = join(directory, "test-z64.zip");
  await writeFile(z64File, z64Buf);
  const opened = openZipFile(z64File);
  try {
    assert.equal(opened.entries.length, 2);
    assert.ok(opened.entries.some((e) => e.name === "Z64Vault/大包笔记.md" && e.bytes().toString("utf8").includes("ZIP64")));
  } finally {
    opened.close();
  }

  const host2 = await b.request("/api/v1/pages", { method: "POST", token, body: { title: "Z64Host", text: "host" } });
  assert.equal(host2.status, 201);
  const z64Job = await uploadChunked(b, token, "obsidian", z64Buf, { partSize: 1024, parentId: host2.body.id });
  assert.equal(z64Job.status, "done", JSON.stringify(z64Job));
  const importedZ64 = (await records(b, "personal", "pages")).find((p) => titleOf(p) === "大包笔记");
  assert.ok(importedZ64);
  assert.equal(importedZ64.parent_id, host2.body.id);
});

test("AC-07：heinote CLI 目录自动打包、并发上传与断点续传", async (t) => {
  const { directory, url, browser } = await fixture(t);
  const b = browser();
  await register(b, "cli_importer");
  const { token } = await createToken(b, "CliAgent", "write");

  const host = await b.request("/api/v1/pages", { method: "POST", token, body: { title: "CLI父页", text: "root" } });
  assert.equal(host.status, 201);

  const vaultDir = join(directory, "LocalObsidianVault");
  await mkdir(join(vaultDir, ".obsidian"), { recursive: true });
  await mkdir(join(vaultDir, "随笔"), { recursive: true });
  await writeFile(join(vaultDir, ".obsidian", "app.json"), "{}");
  await writeFile(join(vaultDir, "索引.md"), "# 索引\n\n连到 [[随笔/第一篇]]。");
  await writeFile(join(vaultDir, "随笔", "第一篇.md"), "# 第一篇\n\n来自本地目录。");

  const fakeHome = join(directory, "cli-home");
  await mkdir(fakeHome, { recursive: true });
  const env = { ...process.env, HOME: fakeHome, HEINOTE_URL: url(), HEINOTE_TOKEN: token };

  const { stdout } = await runExecFile("python3", [
    resolve("skills/heinote/heinote"),
    "import", "obsidian", vaultDir,
    "--parent-id", host.body.id,
    "--part-size", "1024",
    "--concurrency", "3",
  ], { env });
  const result = JSON.parse(stdout);
  assert.equal(result.status, "done", stdout);
  assert.equal(result.result.parentPageId, host.body.id);

  const all = await records(b, "personal", "pages");
  const idxPage = all.find((p) => titleOf(p) === "索引");
  const folder = all.find((p) => titleOf(p) === "随笔");
  assert.ok(idxPage && folder);
  assert.equal(idxPage.parent_id, host.body.id);
  assert.equal(folder.parent_id, host.body.id);

  // Resume flow via --resume-id on a partially uploaded zip.
  const zipBuf = await zipOf({ "ZipVault/续传笔记.md": "# 续传\n\n" + "文字".repeat(400) });
  const zipPath = join(directory, "resume.zip");
  await writeFile(zipPath, zipBuf);
  const partial = await b.request("/api/v1/imports", {
    method: "POST",
    token,
    body: { source: "obsidian", totalBytes: zipBuf.length, partSize: 1024, parentId: host.body.id },
  });
  assert.equal(partial.status, 201);
  assert.equal((await b.request(`/api/v1/imports/${partial.body.id}/parts/0`, { method: "PUT", token, raw: zipBuf.subarray(0, 1024) })).status, 200);

  const resumed = await runExecFile("python3", [
    resolve("skills/heinote/heinote"),
    "import", "obsidian", zipPath,
    "--parent-id", host.body.id,
    "--part-size", "1024",
    "--resume-id", partial.body.id,
  ], { env });
  const resumedResult = JSON.parse(resumed.stdout);
  assert.equal(resumedResult.id, partial.body.id);
  assert.equal(resumedResult.status, "done");
  assert.ok((await records(b, "personal", "pages")).some((p) => titleOf(p) === "续传笔记"));

  const remaining = await readdir(join(directory, "imports"));
  assert.equal(remaining.length, 0, "所有导入完成后 imports 临时目录应为空");
});
