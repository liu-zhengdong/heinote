import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { startServer } from "../server/index.ts";

// POST /api/v1/pages/:id/copy: a page tree copied into another scope — the
// agent counterpart of the window's "拷贝到…", with attachments
// re-stored under the destination.

type Json = any;
type Server = Awaited<ReturnType<typeof startServer>>;
interface Reply { status: number; body: Json }
interface Options { method?: string; body?: unknown; raw?: Buffer; token?: string; binary?: boolean }

class Browser {
  cookie = "";
  constructor(private readonly url: () => string) {}
  async request(path: string, options: Options = {}): Promise<Reply> {
    const response = await fetch(this.url() + path, {
      method: options.method ?? "GET",
      headers: {
        Origin: this.url(),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : this.cookie ? { Cookie: this.cookie } : {}),
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(options.raw !== undefined ? { "Content-Type": "image/png" } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : options.raw,
      redirect: "manual",
    });
    if (!options.token) for (const entry of response.headers.getSetCookie()) {
      const first = entry.split(";", 1)[0];
      if (first.startsWith("notes_session=")) this.cookie = /max-age=0/i.test(entry) ? "" : first;
    }
    if (options.binary) return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
    const raw = await response.text();
    if (raw) assert.match(response.headers.get("content-type") ?? "", /application\/json/, `${path}: ${raw.slice(0, 200)}`);
    return { status: response.status, body: raw ? JSON.parse(raw) : null };
  }
}

function ok(reply: Reply, expected = 200): Json {
  assert.equal(reply.status, expected, JSON.stringify(reply.body));
  return reply.body;
}
function invalid(reply: Reply, statuses = [400]): Json {
  assert.ok(statuses.includes(reply.status), `Expected ${statuses}, got ${reply.status}: ${JSON.stringify(reply.body)}`);
  assert.equal(typeof reply.body?.error, "string");
  return reply.body;
}
function dto(value: Json): Json {
  assert.equal(typeof value.id, "string");
  assert.equal(typeof value.revision, "string");
  return value;
}
function blocks(dtoValue: Json): Json[] {
  return Object.values(dtoValue.page.block_tree.by_id);
}

async function register(browser: Browser, handle: string) {
  ok(await browser.request("/api/auth/register", {
    method: "POST", body: { handle, displayName: handle, password: "Independent-copy-acceptance-2026!" },
  }), 201);
}
async function makeToken(browser: Browser, access: "read" | "write" = "write") {
  return ok(await browser.request("/api/tokens", { method: "POST", body: { name: `copy ${access}`, access } }), 201).token as string;
}
async function createKb(browser: Browser) {
  return ok(await browser.request("/api/knowledge-bases", {
    method: "POST", body: { requestId: randomUUID(), name: "工程库", description: "" },
  }), 201);
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "notes-agent-copy-"));
  let server: Server | undefined;
  t.after(async () => {
    try { await server?.close(); }
    finally {
      const target = resolve(directory);
      assert.equal(dirname(target), resolve(tmpdir()));
      assert.ok(basename(target).startsWith("notes-agent-copy-"));
      await rm(target, { recursive: true, force: true });
    }
  });
  server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false });
  const owner = new Browser(() => server!.url);
  await register(owner, "owner");
  const write = await makeToken(owner, "write");
  const read = await makeToken(owner, "read");
  const request = (path: string, options: Options = {}) => owner.request(`/api/v1${path}`, { ...options, token: write });
  const readOnly = (path: string, options: Options = {}) => owner.request(`/api/v1${path}`, { ...options, token: read });
  return { owner, request, readOnly };
}

test("copy: personal page tree lands at a knowledge base's home", async (t) => {
  const { owner, request } = await fixture(t);
  const kb = await createKb(owner);
  const source = dto(ok(await request("/pages", { method: "POST", body: { title: "手册", markdown: "# 手册\n\n正文" } }), 201));
  const child = dto(ok(await request("/pages", { method: "POST", body: { title: "章节", parentId: source.id, text: "子页正文" } }), 201));
  const reply = dto(ok(await request(`/pages/${source.id}/copy`, {
    method: "POST", body: { requestId: randomUUID(), spaceId: kb.spaceId },
  }), 201));
  assert.notEqual(reply.id, source.id);
  assert.equal(reply.title, "手册");
  assert.equal(reply.scope, kb.spaceId);
  // The copy lands under the library's home page and appears there as an
  // expanded link, exactly like a page created into the base.
  const home = dto(ok(await request(`/pages/${kb.knowledgeBase.homePageId}`)));
  const link = blocks(home).find((block: Json) =>
    block.content.some((run: Json) => run.mention?.kind === "page" && run.mention.page_id === reply.id));
  assert.ok(link, "home page gained an expanded link to the copy");
  assert.equal(reply.page.parent_id, kb.knowledgeBase.homePageId);
  assert.equal(reply.page.share_space_id ?? null, null);
  // The subtree came along: the copy's child link points at a new page in
  // the same space, not back at the original.
  const copyLink = blocks(reply)
    .flatMap((block: Json) => block.content)
    .find((run: Json) => run.mention?.kind === "page" && run.mention.page_id !== source.id);
  assert.ok(copyLink?.mention?.page_id);
  assert.notEqual(copyLink.mention.page_id, child.id);
  const childCopy = dto(ok(await request(`/pages/${copyLink.mention.page_id}`)));
  assert.equal(childCopy.page.parent_id, reply.id);
  assert.equal(childCopy.scope, kb.spaceId);
  assert.equal(childCopy.title, "章节");
});

test("copy: knowledge-base page copied to personal with attachment bytes", async (t) => {
  const { owner, request, readOnly } = await fixture(t);
  const kb = await createKb(owner);
  const source = dto(ok(await request("/pages", {
    method: "POST", body: { title: "库页", scope: kb.spaceId, markdown: "- 列表" },
  }), 201));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const kbFile = ok(await request(`/files/${kb.spaceId}?name=${encodeURIComponent("图.png")}`, {
    method: "PUT", raw: png,
  }), 201);
  const fresh = dto(ok(await request(`/pages/${source.id}`)));
  const last = blocks(fresh).sort((a: Json, b: Json) => a.order - b.order).at(-1)!;
  await dto(ok(await request(`/pages/${source.id}/operations`, {
    method: "POST",
    body: { requestId: randomUUID(), generation: fresh.collaboration.generation, baseRevision: fresh.revision,
      mode: "apply", operations: [{ type: "insert_block", afterId: last.id, text: "配图", file: kbFile }] },
  })));
  const reply = dto(ok(await request(`/pages/${source.id}/copy`, { method: "POST", body: { requestId: randomUUID() } }), 201));
  assert.ok(String(reply.scope).startsWith("user:"));
  assert.equal(reply.page.parent_id ?? null, null);
  // The copy's file reference points at personal storage holding the bytes.
  const fileBlock = blocks(reply).find((block: Json) => block.file);
  assert.ok(fileBlock);
  assert.equal(fileBlock.file.space ?? null, null);
  assert.notEqual(fileBlock.file.path, kbFile.path);
  const downloaded = ok(await readOnly(`/files/personal?path=${encodeURIComponent(fileBlock.file.path)}`, { binary: true }));
  assert.deepEqual(downloaded, png);
  // The source's own file reference is untouched.
  const sourceAgain = dto(ok(await request(`/pages/${source.id}`)));
  const sourceBlock = blocks(sourceAgain).find((block: Json) => block.file);
  assert.equal(sourceBlock.file.path, kbFile.path);
});

test("copy: personal page tree lands at a shared space's top level", async (t) => {
  const { owner, request } = await fixture(t);
  const space = ok(await owner.request("/api/spaces", { method: "POST", body: { name: "协作组" } }), 201);
  const source = dto(ok(await request("/pages", { method: "POST", body: { title: "共享底稿", text: "正文" } }), 201));
  const child = dto(ok(await request("/pages", { method: "POST", body: { title: "附录", parentId: source.id, text: "子" } }), 201));
  const reply = dto(ok(await request(`/pages/${source.id}/copy`, {
    method: "POST", body: { requestId: randomUUID(), spaceId: space.spaceId },
  }), 201));
  assert.equal(reply.scope, space.spaceId);
  // The copy is the space's shared root: share_space_id marks it, and its
  // children hang under it without that field.
  assert.equal(reply.page.share_space_id, space.spaceId);
  assert.equal(reply.page.parent_id ?? null, null);
  const childCopyLink = blocks(reply).flatMap((block: Json) => block.content)
    .find((run: Json) => run.mention?.kind === "page" && run.mention.page_id !== source.id);
  const childCopy = dto(ok(await request(`/pages/${childCopyLink.mention.page_id}`)));
  assert.equal(childCopy.scope, space.spaceId);
  assert.equal(childCopy.page.share_space_id ?? null, null);
  assert.equal(childCopy.page.parent_id, reply.id);
});

test("copy: replaying a request returns the stored copy", async (t) => {
  const { request } = await fixture(t);
  const source = dto(ok(await request("/pages", { method: "POST", body: { title: "x", text: "a" } }), 201));
  const requestId = randomUUID();
  const first = dto(ok(await request(`/pages/${source.id}/copy`, { method: "POST", body: { requestId } }), 201));
  const replayed = dto(ok(await request(`/pages/${source.id}/copy`, { method: "POST", body: { requestId } }), 201));
  assert.equal(replayed.id, first.id);
  invalid(await request(`/pages/${source.id}/copy`, {
    method: "POST", body: { requestId, spaceId: "other" },
  }), [403, 409]);
});

test("copy: permissions and bad targets refuse", async (t) => {
  const { owner, request, readOnly } = await fixture(t);
  const kb = await createKb(owner);
  const source = dto(ok(await request("/pages", { method: "POST", body: { title: "x", text: "a" } }), 201));
  // Read-only tokens cannot copy anywhere.
  invalid(await readOnly(`/pages/${source.id}/copy`, { method: "POST", body: { requestId: randomUUID() } }), [401, 403]);
  // Unknown space, missing page, foreign parent, non-document parent.
  invalid(await request(`/pages/${source.id}/copy`, { method: "POST", body: { requestId: randomUUID(), spaceId: "no-such-space" } }), [403]);
  invalid(await request("/pages/no-such-page/copy", { method: "POST", body: { requestId: randomUUID() } }), [404]);
  const personal = dto(ok(await request("/pages", { method: "POST", body: { title: "私", text: "b" } }), 201));
  const kbPage = dto(ok(await request("/pages", { method: "POST", body: { title: "库页", scope: kb.spaceId, text: "b" } }), 201));
  // A parent in another scope than the destination is refused; a parent in
  // the destination scope is accepted.
  invalid(await request(`/pages/${personal.id}/copy`, { method: "POST", body: { requestId: randomUUID(), spaceId: kb.spaceId, parentId: personal.id } }), [400]);
  const landed = dto(ok(await request(`/pages/${kbPage.id}/copy`, { method: "POST", body: { requestId: randomUUID(), parentId: personal.id } }), 201));
  assert.ok(String(landed.scope).startsWith("user:"));
  assert.equal(landed.page.parent_id, personal.id);
  const app = dto(ok(await request("/pages", { method: "POST", body: { title: "app", kind: "app" } }), 201));
  invalid(await request(`/pages/${personal.id}/copy`, { method: "POST", body: { requestId: randomUUID(), spaceId: kb.spaceId, parentId: app.id } }), [400]);
});
