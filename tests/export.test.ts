import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { startServer } from "../server/index.ts";

/* 导出的 HTTP 验收：GET /api/account/export 产出合法的 STORE zip，含
   README、export.json、每页一个 Markdown、回收站镜像与 attachments/。
   压缩包只写局部头 + 数据描述符 + 中心目录，这里解析中心目录核对条目。 */

type Json = any;
type RunningServer = Awaited<ReturnType<typeof startServer>>;
interface Reply { status: number; body: Json; headers: Headers }

class Browser {
  cookie = "";
  constructor(private readonly url: () => string) {}
  async request(path: string, options: { method?: string; body?: unknown; raw?: BodyInit; contentType?: string; binary?: boolean } = {}): Promise<Reply> {
    const headers: Record<string, string> = { Origin: this.url() };
    if (this.cookie) headers.Cookie = this.cookie;
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
    if (options.binary) return { status: response.status, body: Buffer.from(await response.arrayBuffer()), headers: response.headers };
    const text = await response.text();
    let parsed: Json = null;
    if (text && /application\/json/.test(response.headers.get("content-type") ?? "")) parsed = JSON.parse(text);
    return { status: response.status, body: parsed, headers: response.headers };
  }

  /* Structure gestures only: fills expectedPages the way the real client does. */
  async structure(path: string, options: { method?: string; body?: unknown } = {}): Promise<Reply> {
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

const password = "Correct-horse-battery-2026!";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "terminus-notes-export-"));
  let server: RunningServer | undefined = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false });
  t.after(async () => {
    await server?.close();
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("terminus-notes-export-"));
    await rm(target, { recursive: true, force: true });
  });
  return { browser: () => new Browser(() => server!.url) };
}

async function register(browser: Browser, handle: string): Promise<Json> {
  const r = await browser.request("/api/auth/register", { method: "POST", body: { handle, displayName: handle, password } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const session = await browser.request("/api/session");
  assert.equal(session.status, 200);
  assert.ok(browser.cookie);
  return session.body.user;
}

/* Minimal central-directory reader for our STORE-only writer. */
function zipEntries(zip: Buffer): { name: string; size: number; crc: number; offset: number }[] {
  const entries: { name: string; size: number; crc: number; offset: number }[] = [];
  let i = zip.length - 22;
  // Scan back for EOCD.
  while (i > 0 && zip.readUInt32LE(i) !== 0x06054b50) i--;
  assert.ok(zip.readUInt32LE(i) === 0x06054b50, "no EOCD found");
  const cdOffset = zip.readUInt32LE(i + 16);
  let p = cdOffset;
  while (p < zip.length) {
    const sig = zip.readUInt32LE(p);
    if (sig !== 0x02014b50) break;
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    entries.push({ name, size: zip.readUInt32LE(p + 20), crc: zip.readUInt32LE(p + 16), offset: zip.readUInt32LE(p + 42) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function entryContent(zip: Buffer, entry: { offset: number }): Buffer {
  const lh = entry.offset;
  assert.equal(zip.readUInt32LE(lh), 0x04034b50, "local header missing");
  const nameLen = zip.readUInt16LE(lh + 26);
  const extraLen = zip.readUInt16LE(lh + 28);
  return zip.subarray(lh + 30 + nameLen + extraLen, zip.length);
}

const today = () => new Date().toISOString().slice(0, 10);

test("未登录导出返回 401", async (t) => {
  const { browser } = await fixture(t);
  const r = await browser().request("/api/account/export", { binary: true });
  assert.equal(r.status, 401);
});

test("导出 zip 含 README、export.json、页面 Markdown 与回收站镜像", async (t) => {
  const { browser } = await fixture(t);
  const b = browser();
  const me = await register(b, "exporter");

  const put = (collection: string, id: string, value: unknown) =>
    b.structure(`/api/records/personal/${collection}/${id}`, {
      method: "POST", body: { action: "put", value },
    });

  const parent = "aa11bb22-cc33-4dd4-9e55-ff6677889900";
  const child = "bb22cc33-dd44-4ee5-af66-778899001122";
  const trashed = "cc33dd44-ee55-4ff6-bg77-889900112233";

  assert.equal((await put("pages", parent, { id: parent, title_content: [{ text: "父页面" }], icon: "", kind: "document", created_at: "2026-11-11T00:00:00Z", updated_at: "2026-11-11T00:00:00Z", created_by: "u", updated_by: "u" })).status, 200);
  assert.equal((await put("pages", child, { id: child, title_content: [{ text: "子页面" }], icon: "", kind: "document", parent_id: parent, created_at: "2026-11-11T00:00:00Z", updated_at: "2026-11-11T00:00:00Z", created_by: "u", updated_by: "u" })).status, 200);
  assert.equal((await put("pages", trashed, { id: trashed, title_content: [{ text: "已删页面" }], icon: "", kind: "document", parent_id: parent, archived: true, archived_at: "2026-11-11T01:00:00Z", created_at: "2026-11-11T00:00:00Z", updated_at: "2026-11-11T00:00:00Z", created_by: "u", updated_by: "u" })).status, 200);

  assert.equal((await put("blocks", `${parent.length}_${parent}_b1`, { id: "b1", page: parent, kind: "text", order: 2048, content: [{ embed: { mention: { kind: "page", page_id: child } } }] })).status, 200);
  assert.equal((await put("blocks", `${child.length}_${child}_b1`, { id: "b1", page: child, kind: "text", order: 2048, content: [{ text: "子页面内容" }] })).status, 200);
  assert.equal((await put("blocks", `${trashed.length}_${trashed}_b1`, { id: "b1", page: trashed, kind: "text", order: 2048, content: [{ text: "回收站内容" }] })).status, 200);

  const r = await b.request("/api/account/export", { binary: true });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/zip");
  const cd = r.headers.get("content-disposition") ?? "";
  assert.match(cd, /notes-export-\d{4}-\d{2}-\d{2}\.zip/);

  const zip = r.body as Buffer;
  assert.equal(zip.readUInt32LE(0), 0x04034b50, "not a zip local header");
  const names = zipEntries(zip).map((e) => e.name);

  assert.ok(names.includes("README.md"), "README missing");
  assert.ok(names.includes("export.json"), "export.json missing");
  assert.ok(names.includes("个人笔记/records.json"), "records.json missing");
  assert.ok(names.includes(`个人笔记/pages/父页面.md`), `expected 父页面.md, got ${JSON.stringify(names)}`);
  assert.ok(names.includes(`个人笔记/pages/父页面/子页面.md`), `expected nested 子页面.md, got ${JSON.stringify(names)}`);
  assert.ok(names.includes(`个人笔记/trash/pages/父页面/已删页面.md`), `expected trashed page under trash/, got ${JSON.stringify(names)}`);

  const parentEntry = zipEntries(zip).find((e) => e.name === "个人笔记/pages/父页面.md")!;
  const md = entryContent(zip, parentEntry).subarray(0, parentEntry.size).toString("utf8");
  assert.match(md, /# 父页面/);
  assert.match(md, /\[\[子页面\]\]/, "page mention should export as wikilink");
});

test("导出的 export.json 记录范围与时间", async (t) => {
  const { browser } = await fixture(t);
  const b = browser();
  const me = await register(b, "exportmeta");
  const r = await b.request("/api/account/export", { binary: true });
  assert.equal(r.status, 200);
  const zip = r.body as Buffer;
  const meta = zipEntries(zip).find((e) => e.name === "export.json")!;
  const json = JSON.parse(entryContent(zip, meta).subarray(0, meta.size).toString("utf8"));
  assert.equal(json.version, 1);
  assert.equal(json.account.handle, "exportmeta");
  assert.ok(json.generated_at.startsWith(today()));
  assert.deepEqual(json.scopes.map((s: Json) => s.scope), [`user:${me.id}`]);
});
