import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { startServer } from "../server/index.ts";

// UC-45 acceptance: an Agent token can upload attachment bytes, read them back,
// and reference them from file paragraphs, inline image mentions and image
// properties — the same StoredFile contract the browser and propertyFiles use.
type Json = any;
type Server = Awaited<ReturnType<typeof startServer>>;
interface Reply { status: number; body: Json; headers: Headers }
interface Options { method?: string; body?: unknown; token?: string; raw?: BodyInit; contentType?: string; binary?: boolean }

class Browser {
  cookie = "";
  constructor(private readonly url: () => string) {}
  async request(path: string, options: Options = {}): Promise<Reply> {
    const response = await fetch(this.url() + path, {
      method: options.method ?? "GET",
      headers: {
        Origin: this.url(),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : this.cookie ? { Cookie: this.cookie } : {}),
        ...(options.body !== undefined ? { "Content-Type": "application/json" }
          : options.raw !== undefined ? { "Content-Type": options.contentType ?? "application/octet-stream" } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : options.raw,
      redirect: "manual",
    });
    if (!options.token) for (const entry of response.headers.getSetCookie()) {
      const first = entry.split(";", 1)[0];
      if (first.startsWith("notes_session=")) this.cookie = /max-age=0/i.test(entry) ? "" : first;
    }
    if (options.binary) return { status: response.status, body: Buffer.from(await response.arrayBuffer()), headers: response.headers };
    const raw = await response.text();
    if (raw) assert.match(response.headers.get("content-type") ?? "", /application\/json/, `${path}: ${raw.slice(0, 200)}`);
    return { status: response.status, body: raw ? JSON.parse(raw) : null, headers: response.headers };
  }
}

function ok(reply: Reply, expected = 200): Json {
  assert.equal(reply.status, expected, JSON.stringify(reply.body));
  return reply.body;
}
function invalid(reply: Reply, statuses = [400]): Json {
  assert.ok(statuses.includes(reply.status), `Expected ${statuses}, got ${reply.status}: ${JSON.stringify(reply.body)}`);
  const body = Buffer.isBuffer(reply.body) ? JSON.parse(reply.body.toString()) : reply.body;
  assert.equal(typeof body.error, "string");
  assert.ok(body.error.length > 0, "Invalid input must have an error message");
  return body;
}

class Agent {
  constructor(readonly browser: Browser, readonly token: string) {}
  request(path: string, options: Omit<Options, "token"> = {}) {
    return this.browser.request(`/api/v1${path}`, { ...options, token: this.token });
  }
  upload(scope: string, options: Omit<Options, "token" | "method"> & { path?: string; name?: string } = {}) {
    const query = new URLSearchParams();
    if (options.path !== undefined) query.set("path", options.path);
    if (options.name !== undefined) query.set("name", options.name);
    const { path: _path, name: _name, ...rest } = options;
    return this.request(`/files/${scope}${query.size ? `?${query}` : ""}`, { method: "PUT", ...rest });
  }
  download(scope: string, path: string) {
    return this.request(`/files/${scope}?path=${encodeURIComponent(path)}`, { binary: true });
  }
  async createDocument(input: Json = {}) {
    const value = ok(await this.request("/pages", { method: "POST", body: { title: "文档", text: "body", ...input } }), 201);
    assert.equal(value.page.kind, "document");
    return value;
  }
  async getPage(id: string) { return ok(await this.request(`/pages/${id}`)); }
  async operations(id: string, operations: Json[], extra: Json = {}) {
    const page = await this.getPage(id);
    return await this.request(`/pages/${id}/operations`, {
      method: "POST",
      body: {
        requestId: randomUUID(), generation: page.collaboration.generation,
        baseRevision: page.collaboration.revision, mode: "apply", operations, ...extra,
      },
    });
  }
  async createDatabase(input: Json = {}) {
    const value = ok(await this.request("/databases", { method: "POST", body: { requestId: randomUUID(), ...input } }), 201);
    assert.equal(value.page.kind, "database");
    return value;
  }
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "notes-agent-files-http-"));
  let server: Server | undefined;
  t.after(async () => {
    try { await server?.close(); }
    finally {
      const target = resolve(directory);
      assert.equal(dirname(target), resolve(tmpdir()));
      assert.ok(basename(target).startsWith("notes-agent-files-http-"));
      await rm(target, { recursive: true, force: true });
    }
  });
  server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false });
  const browser = () => new Browser(() => server!.url);
  const owner = browser();
  const user = await register(owner, "owner");
  const writer = await makeToken(owner, "write");
  const reader = await makeToken(owner, "read");
  return { directory, browser, owner, user, agent: new Agent(browser(), writer.token), readerAgent: new Agent(browser(), reader.token) };
}
async function register(browser: Browser, handle: string) {
  ok(await browser.request("/api/auth/register", {
    method: "POST", body: { handle, displayName: handle, password: "Independent-app-acceptance-2026!" },
  }), 201);
  return ok(await browser.request("/api/session")).user;
}
async function makeToken(browser: Browser, access: "read" | "write") {
  return ok(await browser.request("/api/tokens", { method: "POST", body: { name: `UC-45 ${access}`, access } }), 201);
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
/* The handle is closed before returning: Windows keeps the file locked while
   it is open, so a leaked reader makes the fixture cleanup rm EBUSY. */
const fileRows = (dataDir: string) => {
  const db = new DatabaseSync(join(dataDir, "notes.sqlite"), { readOnly: true });
  try { return db.prepare("SELECT * FROM files ORDER BY scope,path").all() as Json[]; }
  finally { db.close(); }
};

function storedFile(reply: Reply, user: Json): Json {
  const file = ok(reply, 201);
  assert.equal(typeof file.path, "string");
  assert.match(file.path, /^files\//);
  assert.equal(file.owner, user.id);
  assert.equal(file.space, undefined);
  assert.equal(typeof file.name, "string");
  assert.ok(file.name);
  assert.equal(file.size, PNG.length);
  assert.equal(file.type, "image/png");
  return file;
}

test("upload with an explicit path returns a StoredFile and the bytes round-trip", async (t) => {
  const { agent, user } = await fixture(t);
  const file = storedFile(await agent.upload("personal", { path: "files/a/b.png", raw: PNG, contentType: "image/png" }), user);
  assert.equal(file.path, "files/a/b.png");
  assert.equal(file.name, "b.png");
  const got = await agent.download("personal", file.path);
  assert.equal(got.status, 200);
  assert.equal(sha256(got.body as Buffer), sha256(PNG));
  assert.match(got.headers.get("content-type") ?? "", /^image\/png/);
});

test("upload without a path gets a generated one; name overrides the file name", async (t) => {
  const { agent, user } = await fixture(t);
  const named = storedFile(await agent.upload("personal", { name: "界面 截图.PNG", raw: PNG, contentType: "image/png" }), user);
  assert.equal(named.name, "界面 截图.PNG");
  assert.match(named.path, /^files\/agent\/[\w-]+\/[\w.-]+$/);
  assert.ok(named.path.endsWith("/file.PNG"), `path keeps a readable stem and the extension: ${named.path}`);
  const again = storedFile(await agent.upload("personal", { raw: PNG, contentType: "image/png" }), user);
  assert.notEqual(again.path, named.path);
  assert.equal(again.name, again.path.split("/").at(-1));
});

test("same path with identical bytes replays; different bytes conflict; index stays single", async (t) => {
  const { agent, user, directory } = await fixture(t);
  const file = storedFile(await agent.upload("personal", { path: "files/repeat.png", raw: PNG, contentType: "image/png" }), user);
  const replay = storedFile(await agent.upload("personal", { path: "files/repeat.png", raw: PNG, contentType: "image/png" }), user);
  assert.deepEqual(replay, file);
  invalid(await agent.upload("personal", { path: "files/repeat.png", raw: Buffer.from("other"), contentType: "image/png" }), [409]);
  const rows = fileRows(directory).filter((row) => row.path === "files/repeat.png");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hash, sha256(PNG));
});

test("paths outside files/ and traversal attempts are refused", async (t) => {
  const { agent, directory } = await fixture(t);
  for (const path of ["a/b.png", "files/../escape.png", "files//gap.png", "files/%2e%2e/out.png"]) {
    invalid(await agent.upload("personal", { path, raw: PNG, contentType: "image/png" }));
  }
  const files = fileRows(directory);
  assert.equal(files.length, 0);
});

test("read tokens can download but cannot upload; missing files 404", async (t) => {
  const { agent, readerAgent, user } = await fixture(t);
  const file = storedFile(await agent.upload("personal", { path: "files/seen.png", raw: PNG, contentType: "image/png" }), user);
  invalid(await readerAgent.upload("personal", { path: "files/denied.png", raw: PNG, contentType: "image/png" }), [403]);
  const got = await readerAgent.download("personal", file.path);
  assert.equal(got.status, 200);
  assert.equal(sha256(got.body as Buffer), sha256(PNG));
  invalid(await agent.download("personal", "files/nothing.png"), [404]);
});

test("insert_block with file creates a file paragraph; insert_image embeds a picture", async (t) => {
  const { agent, user } = await fixture(t);
  const file = storedFile(await agent.upload("personal", { path: "files/note.png", name: "备注.png", raw: PNG, contentType: "image/png" }), user);
  const doc = await agent.createDocument();
  const [first] = doc.page.block_tree.by_id ? Object.values(doc.page.block_tree.by_id) : [];
  const reply = ok(await agent.operations(doc.id, [
    { type: "insert_block", text: "截图", file, kind: "file" },
  ]));
  const blocks = Object.values(reply.page.block_tree.by_id) as Json[];
  const fileBlock = blocks.find((block) => block.kind === "file");
  assert.ok(fileBlock, "a file paragraph must exist");
  assert.deepEqual(fileBlock.file, file);
  const image = ok(await agent.operations(doc.id, [
    { type: "insert_image", blockId: first.id, index: "end", file, width: 400 },
  ]));
  const target = image.page.block_tree.by_id[first.id];
  const run = (target.content ?? []).find((entry: Json) => entry.mention?.kind === "image");
  assert.ok(run, JSON.stringify(target.content));
  assert.deepEqual(run.mention.file, file);
  assert.equal(run.mention.width, 400);
});

test("operations refuse forged, missing and cross-scope file references", async (t) => {
  const { agent, owner, user } = await fixture(t);
  const file = storedFile(await agent.upload("personal", { path: "files/real.png", raw: PNG, contentType: "image/png" }), user);
  const space = ok(await owner.request("/api/spaces", { method: "POST", body: { name: "Shared" } }), 201);
  ok(await agent.upload(space.spaceId, { path: "files/space.png", raw: PNG, contentType: "image/png" }), 201);
  const doc = await agent.createDocument();
  const attempts = [
    { ...file, path: "files/missing.png" },
    { ...file, size: file.size + 1 },
    { ...file, type: "image/jpeg" },
    { ...file, owner: "someone-else" },
    { ...file, space: space.spaceId },
    { path: "files/space.png", owner: user.id, space: space.spaceId, name: "space.png", size: PNG.length, type: "image/png" },
  ];
  for (const candidate of attempts) {
    invalid(await agent.operations(doc.id, [{ type: "insert_block", text: "", file: candidate, kind: "file" }]));
    invalid(await agent.operations(doc.id, [{ type: "insert_image", blockId: Object.keys(doc.page.block_tree.by_id)[0], index: "end", file: candidate }]));
  }
  const page = await agent.getPage(doc.id);
  const kinds = Object.values(page.page.block_tree.by_id).map((block: Json) => block.kind);
  assert.equal(kinds.filter((kind) => kind === "file").length, 0);
});

test("propertyFiles accepts agent-uploaded files in personal and shared databases", async (t) => {
  const { agent, owner, user } = await fixture(t);
  const dbConfig = { title_name: "任务", properties: [{ id: "property_image", name: "图", type: "image" }], views: [{ id: "table", name: "全部", kind: "table" }] };
  const file = storedFile(await agent.upload("personal", { path: "files/cell.png", raw: PNG, contentType: "image/png" }), user);
  const db = await agent.createDatabase({ database: dbConfig });
  const row = ok(await agent.request(`/databases/${db.id}/rows`, {
    method: "POST",
    body: { requestId: randomUUID(), baseRevision: db.revision, title: "带图", propertyFiles: { property_image: [file] } },
  }), 201);
  assert.deepEqual(row.page.property_files.property_image, [file]);

  const space = ok(await owner.request("/api/spaces", { method: "POST", body: { name: "图库" } }), 201);
  const sharedFile = ok(await agent.upload(space.spaceId, { path: "files/cell2.png", raw: PNG, contentType: "image/png" }), 201);
  const sharedDb = await agent.createDatabase({ spaceId: space.spaceId, database: dbConfig });
  const sharedRow = ok(await agent.request(`/databases/${sharedDb.id}/rows`, {
    method: "POST",
    body: { requestId: randomUUID(), baseRevision: sharedDb.revision, title: "共享带图", propertyFiles: { property_image: [sharedFile] } },
  }), 201);
  assert.deepEqual(sharedRow.page.property_files.property_image, [sharedFile]);
});

test("uploading to a shared space binds space ownership and stays within role checks", async (t) => {
  const { agent, owner, browser } = await fixture(t);
  const space = ok(await owner.request("/api/spaces", { method: "POST", body: { name: "团队" } }), 201);
  const file = ok(await agent.upload(space.spaceId, { path: "files/logo.png", raw: PNG, contentType: "image/png" }), 201);
  assert.equal(file.space, space.spaceId);
  const got = await agent.download(space.spaceId, file.path);
  assert.equal(sha256(got.body as Buffer), sha256(PNG));
  const stranger = browser(); await register(stranger, "stranger");
  const outsider = new Agent(browser(), (await makeToken(stranger, "write")).token);
  invalid(await outsider.upload(space.spaceId, { path: "files/no.png", raw: PNG, contentType: "image/png" }), [403]);
  invalid(await outsider.download(space.spaceId, file.path), [403]);
});
