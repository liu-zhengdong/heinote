import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { startServer } from "../server/index.ts";
import { crc32, ZipStream } from "../src/core/zip.ts";

/* 导入的 HTTP 验收：POST /api/account/import/:source 收 zip 起任务，
   GET 轮询到 done 后页面树与附件已写入：Obsidian 库（含 .obsidian、
   wikilink、frontmatter、图片）与 Notion 导出（[id] 命名、<page>、表格）。 */

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
    const text = await response.text();
    let parsed: Json = null;
    if (text && /application\/json/.test(response.headers.get("content-type") ?? "")) parsed = JSON.parse(text);
    if (options.binary) return { status: response.status, body: text ? Buffer.from(text) : parsed, headers: response.headers };
    return { status: response.status, body: parsed, headers: response.headers };
  }
}

const password = "Correct-horse-battery-2026!";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "heinote-import-"));
  let server: RunningServer | undefined = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false });
  t.after(async () => {
    await server?.close();
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("heinote-import-"));
    await rm(target, { recursive: true, force: true });
  });
  return { browser: () => new Browser(() => server!.url) };
}

async function register(browser: Browser, handle: string): Promise<Json> {
  const r = await browser.request("/api/auth/register", { method: "POST", body: { handle, displayName: handle, password } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const session = await browser.request("/api/session");
  assert.equal(session.status, 200);
  return session.body.user;
}

/** One STORE zip in memory: the same writer the export uses. */
async function zipOf(entries: Record<string, string | Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const zip = new ZipStream({ write: (chunk) => chunks.push(chunk) });
  for (const [name, body] of Object.entries(entries)) await zip.add(name, body);
  zip.finish();
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
}

async function runImport(browser: Browser, source: string, zip: Buffer): Promise<Json> {
  const started = await browser.request(`/api/account/import/${source}`, { method: "POST", raw: zip, contentType: "application/zip" });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  for (let i = 0; i < 100; i += 1) {
    const job = await browser.request(`/api/account/import/${started.body.id}`);
    assert.equal(job.status, 200);
    if (job.body.status === "done" || job.body.status === "failed") return job.body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("导入任务未结束。");
}

const records = async (browser: Browser, collection: string): Promise<Json[]> =>
  ((await browser.request(`/api/records/personal/${collection}`)).body ?? []).map((row: Json) => row.value ?? row);
const pages = (browser: Browser) => records(browser, "pages");
const blocks = (browser: Browser) => records(browser, "blocks");
const titleOf = (page: Json): string => page.title_content?.map((run: Json) => run.text ?? "").join("") ?? "";
const inOrder = (list: Json[]): Json[] => [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

test("Obsidian：库文件夹识别、双链、frontmatter 与附件", async (t) => {
  const { browser } = await fixture(t);
  const b = browser();
  await register(b, "obsidianer");

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const zip = await zipOf({
    "vault/.obsidian/app.json": "{}",
    "vault/主页.md": "---\ntags: [home]\n---\n# 主页\n\n连到 [[子目录/笔记A]] 和 [[不存在]]。\n\n![[图.png]]",
    "vault/子目录/笔记A.md": "# 笔记A\n\n回链 [[主页]]。",
    "vault/图.png": png,
  });
  const job = await runImport(b, "obsidian", zip);
  assert.equal(job.status, "done", JSON.stringify(job));
  assert.equal(job.result.title, "Obsidian 导入 — vault");
  assert.ok(job.result.pages >= 4); // root + 子目录 folder + 2 notes
  assert.equal(job.result.attachments, 1);
  assert.deepEqual(job.result.unresolved, ["不存在"]);

  const all = await pages(b);
  const byTitle = new Map(all.map((p) => [titleOf(p), p]));
  const root = byTitle.get("Obsidian 导入 — vault");
  assert.ok(root, JSON.stringify(all.map(titleOf)));
  const folder = byTitle.get("子目录");
  assert.ok(folder);
  const noteA = byTitle.get("笔记A");
  assert.ok(noteA);
  assert.equal(noteA.parent_id, folder.id);
  const home = byTitle.get("主页");
  assert.ok(home);
  assert.equal(home.parent_id, root.id);

  const homeBlocks = inOrder((await blocks(b)).filter((x) => x.page === home.id));
  const kinds = homeBlocks.map((x) => x.kind);
  assert.ok(kinds.includes("code"), JSON.stringify(kinds)); // frontmatter kept
  const mention = homeBlocks.flatMap((x) => x.content ?? []).find((r: Json) => r.embed?.mention?.kind === "page")?.embed?.mention;
  assert.ok(mention, JSON.stringify(homeBlocks.map((x) => x.content)));
  assert.equal(mention?.page_id, noteA.id);
  // 图片：内联 mention 存原始 StoredFile
  const imageRun = homeBlocks.flatMap((x) => x.content ?? []).find((r: Json) => r.embed?.mention?.kind === "image");
  assert.ok(imageRun, JSON.stringify(homeBlocks));
  assert.equal(imageRun.embed.mention.file.name, "图.png");

  const noteABlocks = (await blocks(b)).filter((x) => x.page === noteA.id);
  const backLink = noteABlocks.flatMap((x) => x.content ?? []).find((r: Json) => r.embed?.mention?.kind === "page");
  assert.equal(backLink?.embed?.mention?.page_id, home.id);
});

test("Notion：命名、[id] 链接、<page>、表格与任务", async (t) => {
  const { browser } = await fixture(t);
  const b = browser();
  await register(b, "notioner");

  const zip = await zipOf({
    "Notion导出/Inbox [aaaabbbbcccc].md": "# Inbox\n\n[Notion 原页](https://app.notion.com/p/xxxxxxxxxxxxxxxxxxxxxaaaabbbbcccc)\n\n---\n\n<page url=\"https://app.notion.com/p/xxxxxxxxxxxxxxxxxxxxxdddddddddddd\">\n子页面\n</page>\n\n<mention url=\"https://app.notion.com/p/xxxxxxxxxxxxxxxxxxxxxdddddddddddd\">子页面</mention> 在此。",
    "Notion导出/子页面 [dddddddddddd].md": "# 子页面\n\n- [ ] 待办一\n- [x] 已完成\n\n<table header-row=\"true\">\n<tr><td>\n列A\n</td><td>\n列B\n</td></tr>\n<tr><td>\n1\n</td><td>\n2\n</td></tr>\n</table>\n\n<callout icon=\"💡\" color=\"blue_bg\">\n提示内容\n</callout>",
  });
  const job = await runImport(b, "notion", zip);
  assert.equal(job.status, "done", JSON.stringify(job));
  assert.equal(job.result.pages, 3); // root + Inbox + 子页面

  const all = await pages(b);
  const byTitle = new Map(all.map((p) => [titleOf(p), p]));
  const root = byTitle.get("Notion 导入");
  assert.ok(root);
  const inbox = byTitle.get("Inbox");
  const sub = byTitle.get("子页面");
  assert.ok(inbox && sub);
  assert.equal(inbox.parent_id, root.id);
  assert.equal(sub.parent_id, root.id);

  const inboxBlocks = (await blocks(b)).filter((x) => x.page === inbox.id);
  const mentions = inboxBlocks.flatMap((x) => x.content ?? []).filter((r: Json) => r.embed?.mention?.kind === "page");
  assert.ok(mentions.length >= 2, JSON.stringify(inboxBlocks)); // <page> + <mention>
  assert.equal(mentions[0].embed.mention.page_id, sub.id);

  const subBlocks = inOrder((await blocks(b)).filter((x) => x.page === sub.id));
  const kinds = subBlocks.map((x) => x.kind);
  assert.ok(kinds.includes("todo") && kinds.includes("table") && kinds.includes("callout"), JSON.stringify(kinds));
  const todos = subBlocks.filter((x) => x.kind === "todo");
  assert.deepEqual(todos.map((x) => x.checked), [false, true]);
});

test("Obsidian：deflate 压缩条目按压缩大小读取", async (t) => {
  const { browser } = await fixture(t);
  const b = browser();
  await register(b, "deflater");

  // A payload that inflates under deflate: incompressible random bytes.
  // The reader must honor the central directory's compressed size, or the
  // slice cuts the stream short and inflate fails (Obsidian vault PNGs hit
  // exactly this shape).
  const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), randomBytes(64 * 1024)]);
  const deflated = deflateRawSync(pngBytes);
  assert.ok(deflated.length > pngBytes.length, `payload must expand under deflate: ${deflated.length} > ${pngBytes.length}`);

  const note = Buffer.from("![[膨胀.png]]", "utf8");
  const noteDeflated = deflateRawSync(note);
  const parts: Buffer[] = [];
  const meta: Array<{ name: Buffer; crc: number; csize: number; usize: number; offset: number; method: number; body: Buffer }> = [];
  let written = 0;
  const write = (buf: Buffer) => { parts.push(buf); written += buf.length; };
  const push = (name: string, body: Buffer, compressed: Buffer) => {
    const nameBytes = Buffer.from(name, "utf8");
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt32LE(crc32(body), 14);
    head.writeUInt32LE(compressed.length, 18);
    head.writeUInt32LE(body.length, 22);
    head.writeUInt16LE(nameBytes.length, 26);
    const offset = written;
    write(head); write(nameBytes); write(compressed);
    meta.push({ name: nameBytes, crc: crc32(body), csize: compressed.length, usize: body.length, offset, method: 8, body });
  };
  push("vault/.obsidian/app.json", Buffer.from("{}"), deflateRawSync(Buffer.from("{}")));
  push("vault/注.md", note, noteDeflated);
  push("vault/膨胀.png", pngBytes, deflated);

  const centralAt = written;
  for (const m of meta) {
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8); head.writeUInt16LE(m.method, 10);
    head.writeUInt32LE(m.crc, 16); head.writeUInt32LE(m.csize, 20); head.writeUInt32LE(m.usize, 24);
    head.writeUInt16LE(m.name.length, 28);
    head.writeUInt32LE(m.offset, 42);
    write(head); write(m.name);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); // single disk
  end.writeUInt16LE(meta.length, 8); end.writeUInt16LE(meta.length, 10);
  end.writeUInt32LE(written - centralAt, 12); end.writeUInt32LE(centralAt, 16);
  write(end);

  const job = await runImport(b, "obsidian", Buffer.concat(parts));
  assert.equal(job.status, "done", JSON.stringify(job));
  assert.equal(job.result.attachments, 1, JSON.stringify(job.result));

  const all = await pages(b);
  const imported = all.find((p) => titleOf(p) === "注");
  assert.ok(imported);
  const imageRun = (await blocks(b)).filter((x) => x.page === imported.id)
    .flatMap((x) => x.content ?? []).find((r: Json) => r.embed?.mention?.kind === "image");
  assert.ok(imageRun, "图片 mention 应指向已存储附件");
});

test("无效 zip 与未知来源被拒绝", async (t) => {
  const { browser } = await fixture(t);
  const b = browser();
  await register(b, "badimporter");
  const reply = await b.request("/api/account/import/obsidian", { method: "POST", raw: Buffer.from("not a zip"), contentType: "application/zip" });
  assert.equal(reply.status, 202); // 任务受理，失败体现在轮询
  const job = await b.request(`/api/account/import/${reply.body.id}`);
  assert.equal(job.body.status, "failed");
  const other = await b.request("/api/account/import/wordpress", { method: "POST", raw: Buffer.from("x"), contentType: "application/zip" });
  assert.equal(other.status, 404);
});
