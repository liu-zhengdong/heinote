import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const engine = process.env.CONTAINER_ENGINE ?? "podman";
const image = process.env.HEINOTE_IMAGE ?? "localhost/heinote:latest";
const runId = randomUUID();
const container = `heinote-accept-${runId}`;
const volume = `${container}-data`;
const run = (...args) => execFileSync(engine, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 }).trim();
const feeds = new Set();
let url;
const password = `Test-${randomUUID()}`;
const waitForServer = async () => {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${url}/api/health`)).ok) return; } catch { /* Wait for the container's server. */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Container did not become ready: ${run("logs", container)}`);
};
function browser() {
  let cookie = "";
  const request = async (path, { method = "GET", body, token, raw } = {}) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { Origin: url, ...(token ? { Authorization: `Bearer ${token}` } : cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : raw !== undefined ? { "Content-Type": "application/octet-stream" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : raw,
    });
    if (!token) for (const entry of response.headers.getSetCookie()) cookie = entry.split(";", 1)[0];
    const value = response.headers.get("content-type")?.includes("application/json") ? await response.json() : await response.text();
    return { status: response.status, value, path };
  };
  Object.defineProperty(request, "cookie", { get: () => cookie });
  return request;
}
const expectStatus = (reply, status) => { assert.equal(reply.status, status, `Unexpected status for ${reply.path}`); return reply.value; };
const bodyKey = (recordId) => `blocks/${encodeURIComponent(recordId)}/content`;
function fieldRuns(value, key) {
  const [collection, encodedId, ...path] = key.split("/");
  const recordId = decodeURIComponent(encodedId);
  let target = collection === "pages" && recordId === value.pageId
    ? value.records.page
    : value.records.blocks.find((row) => row.id === recordId)?.value;
  for (const segment of path) target = target?.[decodeURIComponent(segment)];
  assert.ok(Array.isArray(target), `The snapshot must include the SQL projection for ${key}`);
  return target;
}
function text(value, key) {
  return fieldRuns(value, key).filter((run) => typeof run.text === "string").map((run) => run.text).join("");
}
function assertSnapshot(value) {
  assert.equal(typeof value.epoch, "string"); assert.ok(value.epoch);
  assert.equal(typeof value.seq, "number"); assert.ok(Number.isInteger(value.seq) && value.seq >= 0);
  assert.equal(typeof value.revision, "string"); assert.ok(value.revision);
  assert.equal(value.records?.page?.id, value.pageId);
  assert.ok(Array.isArray(value.records.blocks));
  assert.ok(value.records.blocks.every((row) => row.value.page === value.pageId));
}
async function snapshot(client, scope, pageId) {
  const value = expectStatus(await client(`/api/collaboration/${encodeURIComponent(scope)}/${encodeURIComponent(pageId)}`), 200);
  assert.equal(value.scope, scope); assert.equal(value.pageId, pageId); assertSnapshot(value); return value;
}
async function submitOps(client, basis, ops, requestId = randomUUID()) {
  return client("/api/records/batch", {
    method: "POST",
    body: {
      requestId,
      writes: [],
      pageOps: [{ scope: basis.scope, pageId: basis.pageId, epoch: basis.epoch, baseSeq: basis.seq, ops }],
    },
  });
}
function assertIdentity(before, after, key) {
  assert.equal(after.epoch, before.epoch, "Restarting a service must retain its page epoch");
  assert.equal(after.seq, before.seq, "Restarting a service must retain its page seq");
  assert.equal(after.revision, before.revision, "Restarting a service cannot modify the page projection");
  assert.deepEqual(fieldRuns(after, key), fieldRuns(before, key));
}
function assertDurableState(value) {
  // A separate container process reads SQLite after receiving the WebSocket event.
  const script = `import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync('/app/data/notes.sqlite', {readOnly:true});
    try {
      const [scope,pageId] = process.argv.slice(1);
      const meta = db.prepare('SELECT epoch,seq FROM collaboration_pages WHERE scope=? AND page_id=?').get(scope,pageId);
      const page = db.prepare("SELECT value FROM records WHERE scope=? AND collection='pages' AND id=?").get(scope,pageId);
      const blocks = db.prepare("SELECT id,value FROM records WHERE scope=? AND collection='blocks' AND json_extract(value,'$.page')=? ORDER BY id").all(scope,pageId).map(row=>({id:row.id,value:JSON.parse(row.value)}));
      console.log(JSON.stringify({epoch:meta?.epoch,seq:meta?.seq,records:{page:page?JSON.parse(page.value):null,blocks}}));
    } finally { db.close(); }`;
  const persisted = JSON.parse(run("exec", container, "node", "--input-type=module", "-e", script, value.scope, value.pageId));
  assert.equal(persisted.epoch, value.epoch);
  assert.equal(persisted.seq, value.seq, "A WebSocket op commit must already exist in SQLite");
  assert.deepEqual(persisted.records, value.records, "The committed records must match the latest snapshot");
}
class Feed {
  messages = [];
  watchers = new Set();
  failure;
  constructor(client) {
    this.socket = new WebSocket(url.replace(/^http/, "ws") + "/api/collaboration", { headers: { Origin: url, Cookie: client.cookie } });
    this.socket.on("message", (bytes) => {
      try { this.messages.push(JSON.parse(bytes.toString())); }
      catch (error) { this.failure = error; }
      this.notify();
    });
    this.socket.on("error", (error) => { this.failure = error; this.notify(); });
    this.socket.on("open", () => this.notify());
    this.socket.on("close", () => this.notify());
    this.socket.on("unexpected-response", (_request, response) => { this.failure = new Error(`WebSocket refused: ${response.statusCode}`); response.resume(); this.socket.terminate(); this.notify(); });
    feeds.add(this);
  }
  notify() { for (const watcher of this.watchers) watcher(); }
  async wait(predicate) {
    await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.watchers.delete(check); };
      const check = () => {
        if (this.failure) { cleanup(); reject(this.failure); }
        else if (predicate()) { cleanup(); resolve(); }
        else if (this.socket.readyState === WebSocket.CLOSED) { cleanup(); reject(new Error("WebSocket closed before the expected event")); }
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`WebSocket event timed out; types=${this.messages.map((message) => message.type).join(",")}`)); }, 10000);
      this.watchers.add(check); check();
    });
  }
  async subscribe(scope, pageId) {
    await this.wait(() => this.socket.readyState === WebSocket.OPEN);
    this.socket.send(JSON.stringify({ type: "subscribe", scope, pageId }));
    await this.wait(() => this.messages.some((m) => m.type === "document" && m.snapshot?.scope === scope && m.snapshot?.pageId === pageId));
    const snap = this.messages.find((m) => m.type === "document" && m.snapshot?.scope === scope && m.snapshot?.pageId === pageId).snapshot;
    assertSnapshot(snap);
    return snap;
  }
  async waitOp(predicate, after = 0) {
    const events = () => this.messages.slice(after).filter((m) => m.type === "op" || m.type === "reset");
    await this.wait(() => events().some(predicate));
    return events().find(predicate);
  }
  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { this.socket.terminate(); resolve(); }, 500);
      this.socket.once("close", () => { clearTimeout(timer); resolve(); }); this.socket.close();
    });
  }
}
function assertOwnContainer() {
  const inspected = JSON.parse(run("inspect", container))[0];
  assert.equal(inspected.Config.Labels["notes.test-run"], runId);
  assert.equal(inspected.Name.replace(/^\//, ""), container);
}
let createdContainer = false;
let createdVolume = false;
try {
  const imageId = run("image", "inspect", image, "--format", "{{.Id}}");
  console.log(`Container acceptance image: ${image} (${imageId})`);
  run("volume", "create", "--label", `notes.test-run=${runId}`, volume); createdVolume = true;
  run("run", "-d", "--name", container, "--label", `notes.test-run=${runId}`, "-p", "127.0.0.1::3000", "-v", `${volume}:/app/data`, image); createdContainer = true;
  url = `http://${run("port", container, "3000/tcp").split("\n")[0]}`;
  await waitForServer();
  const alice = browser(); const bob = browser(); const guest = browser();
  const a = expectStatus(await alice("/api/auth/register", { method: "POST", body: { handle: "alice", displayName: "Alice", password } }), 201).user;
  const b = expectStatus(await bob("/api/auth/register", { method: "POST", body: { handle: "bob", displayName: "Bob", password } }), 201).user;
  assert.equal(a.siteRole, "admin"); assert.equal(b.siteRole, "user");
  expectStatus(await alice(`/api/admin/users/${b.id}`, { method: "PATCH", body: { siteRole: "admin" } }), 200);
  assert.equal(expectStatus(await bob("/api/admin/users"), 200).filter((user) => user.siteRole === "admin").length, 2);
  const writer = expectStatus(await alice("/api/tokens", { method: "POST", body: { name: "Container Agent", access: "write" } }), 201);
  const collaborator = expectStatus(await bob("/api/tokens", { method: "POST", body: { name: "Collaborator Agent", access: "write" } }), 201);
  const page = expectStatus(await alice("/api/v1/pages", { method: "POST", token: writer.token, body: { title: "容器持久化笔记", text: "恢复前的正文" } }), 201);
  expectStatus(await bob(`/api/v1/pages/${page.id}`, { token: collaborator.token }), 404);
  const version = expectStatus(await alice(`/api/v1/pages/${page.id}/checkpoint`, { method: "POST", token: writer.token }), 200);
  expectStatus(await alice(`/api/v1/pages/${page.id}`, { method: "PATCH", token: writer.token, body: { text: "临时修改", baseRevision: page.revision } }), 200);
  const beforeRestore = await snapshot(alice, "personal", page.id);
  const oldBlock = beforeRestore.records.blocks[0]; assert.ok(oldBlock);
  const restored = expectStatus(await alice(`/api/v1/pages/${page.id}/restore`, { method: "POST", token: writer.token, body: { versionId: version.id, baseRevision: beforeRestore.revision } }), 200);
  assert.equal(restored.text, "恢复前的正文");
  const afterRestore = await snapshot(alice, "personal", page.id);
  assert.notEqual(afterRestore.epoch, beforeRestore.epoch);
  expectStatus(await submitOps(alice, beforeRestore, [{ type: "text", field: bodyKey(oldBlock.id), ops: [{ insert: "恢复后不得复活" }] }]), 409);
  assert.equal(text(await snapshot(alice, "personal", page.id), bodyKey(oldBlock.id)), "恢复前的正文", "An old-epoch op cannot revive text after a restore");
  const share = expectStatus(await alice("/api/shares", { method: "POST", body: { pageId: page.id } }), 201);
  const shareToken = share.url.split("/").at(-1);
  assert.equal(expectStatus(await guest(`/api/public/${shareToken}`), 200).pages[0].title, page.title);
  expectStatus(await alice(`/api/shares/${share.id}`, { method: "DELETE" }), 200);
  expectStatus(await guest(`/api/public/${shareToken}`), 404);
  const space = expectStatus(await alice("/api/spaces", { method: "POST", body: { name: "容器协作" } }), 201);
  const shared = expectStatus(await alice("/api/v1/pages", { method: "POST", token: writer.token, body: { title: "共同编辑", text: "初始正文", spaceId: space.spaceId } }), 201);
  expectStatus(await alice(`/api/spaces/${space.spaceId}/invitations`, { method: "POST", body: { handle: "bob", role: "editor" } }), 200);
  const invitation = expectStatus(await bob("/api/invitations"), 200)[0];
  expectStatus(await bob(`/api/invitations/${invitation.id}`, { method: "POST", body: { accept: true } }), 200);
  const edited = expectStatus(await bob(`/api/v1/pages/${shared.id}`, { method: "PATCH", token: collaborator.token, body: { text: "协作者保存", baseRevision: shared.revision } }), 200);
  assert.equal(edited.text, "协作者保存");
  expectStatus(await alice(`/api/files/${space.spaceId}?path=attachment.txt`, { method: "PUT", raw: "container attachment" }), 200);
  assert.equal(expectStatus(await bob(`/api/files/${space.spaceId}?path=attachment.txt`), 200), "container attachment");
  run("restart", container); await waitForServer();
  assert.equal(expectStatus(await alice(`/api/v1/pages/${page.id}`, { token: writer.token }), 200).text, "恢复前的正文");
  assert.equal(expectStatus(await bob(`/api/v1/pages/${shared.id}`, { token: collaborator.token }), 200).text, "协作者保存");
  assert.equal(expectStatus(await bob(`/api/files/${space.spaceId}?path=attachment.txt`), 200), "container attachment");
  assert.equal(expectStatus(await alice("/api/session"), 200).user.id, a.id);

  const baseline = await snapshot(alice, space.spaceId, shared.id);
  const body = baseline.records.blocks[0]; assert.ok(body);
  const key = bodyKey(body.id);
  const feed = new Feed(bob);
  const initialFeed = await feed.subscribe(space.spaceId, shared.id);
  assert.equal(initialFeed.epoch, baseline.epoch);
  assert.equal(initialFeed.seq, baseline.seq);

  // Both independent edits are based on `baseline.seq` before either HTTP request is submitted.
  let mark = feed.messages.length;
  expectStatus(await submitOps(bob, baseline, [{ type: "text", field: key, ops: [{ insert: "乙" }] }]), 200);
  const middle = await snapshot(bob, space.spaceId, shared.id);
  await feed.waitOp((m) => m.type === "op" && m.seq === middle.seq, mark);
  assertDurableState(middle);
  assert.equal(text(middle, key), "乙协作者保存");

  mark = feed.messages.length;
  const replayId = randomUUID();
  expectStatus(await submitOps(alice, baseline, [{ type: "text", field: key, ops: [{ insert: "甲😀" }] }], replayId), 200);
  const merged = await snapshot(alice, space.spaceId, shared.id);
  await feed.waitOp((m) => m.type === "op" && m.seq === merged.seq, mark);
  assertDurableState(merged);
  assert.equal(merged.epoch, baseline.epoch);
  assert.equal(text(merged, key).length, "甲😀乙协作者保存".length);
  assert.ok(text(merged, key).includes("甲😀") && text(merged, key).includes("乙") && text(merged, key).includes("协作者保存"));
  expectStatus(await submitOps(alice, baseline, [{ type: "text", field: key, ops: [{ insert: "甲😀" }] }], replayId), 200);
  assert.equal(text(await snapshot(bob, space.spaceId, shared.id), key), text(merged, key), "A retried op cannot insert text twice");

  // Semantic reorder via move_blocks succeeds without conflict.
  expectStatus(await submitOps(alice, merged, [{ type: "move_blocks", blockIds: [body.value.id], parentId: null }]), 200);
  const moved = await snapshot(alice, space.spaceId, shared.id);
  assert.equal(text(moved, key), text(merged, key));

  const agentView = expectStatus(await alice(`/api/v1/pages/${shared.id}`, { token: writer.token }), 200);
  assert.ok(agentView.collaboration?.epoch, "An Agent must obtain its epoch without a browser session");
  const append = { requestId: randomUUID(), epoch: agentView.collaboration.epoch, operations: [{ type: "insert_text", blockId: body.value.id, index: "end", text: "Agent结构化追加" }] };
  expectStatus(await alice(`/api/v1/pages/${shared.id}/operations`, { method: "POST", token: writer.token, body: append }), 200);
  expectStatus(await alice(`/api/v1/pages/${shared.id}/operations`, { method: "POST", token: writer.token, body: append }), 200);
  const appended = await snapshot(alice, space.spaceId, shared.id);
  assert.equal(text(appended, key), text(merged, key) + "Agent结构化追加");
  const inserted = expectStatus(await alice(`/api/v1/pages/${shared.id}/operations`, { method: "POST", token: writer.token, body: {
    requestId: randomUUID(), epoch: appended.epoch, baseRevision: appended.revision,
    operations: [{ type: "insert_block", afterId: body.value.id, kind: "text", text: "Agent新增段落" }],
  } }), 200);
  const insertedSnapshot = await snapshot(alice, space.spaceId, shared.id);
  assert.equal(Object.values(inserted.page.block_tree.by_id).filter((block) => block.content.map((run) => run.text ?? "").join("") === "Agent新增段落").length, 1);
  const suggestion = { requestId: randomUUID(), epoch: insertedSnapshot.epoch, baseRevision: insertedSnapshot.revision, mode: "suggest", operations: [{ type: "insert_text", blockId: body.value.id, index: "end", text: "审核通过" }] };
  const proposal = expectStatus(await alice(`/api/v1/pages/${shared.id}/operations`, { method: "POST", token: writer.token, body: suggestion }), 201);
  assert.equal(proposal.status, "pending"); assert.equal(proposal.author.id, a.id);
  assert.equal(text(await snapshot(bob, space.spaceId, shared.id), key), text(insertedSnapshot, key), "An unapproved suggestion must not modify the live document");
  const proposals = expectStatus(await bob(`/api/proposals?scope=${encodeURIComponent(space.spaceId)}&pageId=${encodeURIComponent(shared.id)}`), 200);
  assert.equal(proposals.find((item) => item.id === proposal.id)?.status, "pending");
  expectStatus(await bob(`/api/proposals/${proposal.id}/apply`, { method: "POST", body: { baseRevision: proposal.baseRevision } }), 200);
  const approved = await snapshot(alice, space.spaceId, shared.id);
  assert.equal(text(approved, key), text(merged, key) + "Agent结构化追加审核通过");
  assert.equal(expectStatus(await bob(`/api/proposals?scope=${encodeURIComponent(space.spaceId)}&pageId=${encodeURIComponent(shared.id)}`), 200).find((item) => item.id === proposal.id).status, "applied");
  await feed.close();

  const privateBeforeRestart = await snapshot(alice, "personal", page.id);
  const privateKey = bodyKey(privateBeforeRestart.records.blocks[0].id);
  run("restart", container); await waitForServer();
  const restarted = await snapshot(alice, space.spaceId, shared.id);
  assertIdentity(approved, restarted, key);
  assertIdentity(privateBeforeRestart, await snapshot(alice, "personal", page.id), privateKey);
  expectStatus(await submitOps(alice, approved, [{ type: "text", field: key, ops: [{ retain: text(approved, key).length }, { insert: "重启前草稿" }] }]), 200);
  const beforeRecreate = await snapshot(alice, space.spaceId, shared.id);
  assert.equal(text(beforeRecreate, key), text(approved, key) + "重启前草稿");
  const sharedText = expectStatus(await alice(`/api/v1/pages/${shared.id}`, { token: writer.token }), 200).text;
  assertOwnContainer();
  run("rm", "-f", container); createdContainer = false;
  run("run", "-d", "--name", container, "--label", `notes.test-run=${runId}`, "-p", "127.0.0.1::3000", "-v", `${volume}:/app/data`, image); createdContainer = true;
  url = `http://${run("port", container, "3000/tcp").split("\n")[0]}`;
  await waitForServer();
  assert.equal(expectStatus(await alice("/api/session"), 200).user.id, a.id);
  assert.equal(expectStatus(await alice(`/api/v1/pages/${page.id}`, { token: writer.token }), 200).text, "恢复前的正文");
  assert.equal(expectStatus(await bob(`/api/files/${space.spaceId}?path=attachment.txt`), 200), "container attachment");
  const recreated = await snapshot(bob, space.spaceId, shared.id);
  assertIdentity(beforeRecreate, recreated, key);
  assertIdentity(privateBeforeRestart, await snapshot(alice, "personal", page.id), privateKey);
  assert.equal(expectStatus(await bob(`/api/v1/pages/${shared.id}`, { token: collaborator.token }), 200).text, sharedText);
  run("exec", container, "node", "scripts/backup.mjs", "/app/data/container-test-backup");
  const integrity = run("exec", container, "node", "--input-type=module", "-e", "import assert from'node:assert/strict';import{DatabaseSync}from'node:sqlite';import{readFileSync,readdirSync}from'node:fs';const root='/app/data/container-test-backup';assert.deepEqual(readdirSync(root).sort(),['attachments','notes.sqlite']);const d=new DatabaseSync(root+'/notes.sqlite',{readOnly:true});assert.ok(!d.prepare('PRAGMA table_info(files)').all().some(c=>c.name==='bytes'));const file=d.prepare('SELECT hash FROM files WHERE path=?').get('attachment.txt');assert.equal(readFileSync(root+'/attachments/'+file.hash.slice(0,2)+'/'+file.hash,'utf8'),'container attachment');console.log(d.prepare('PRAGMA integrity_check').get().integrity_check);d.close()");
  assert.equal(integrity, "ok");
  expectStatus(await bob(`/api/tokens/${collaborator.id}`, { method: "DELETE" }), 200);
  expectStatus(await bob(`/api/v1/pages/${shared.id}`, { token: collaborator.token }), 401);
  const shell = await fetch(url); assert.equal(shell.status, 200);
  const html = await shell.text(); const asset = /src="([^"]+\.js)"/.exec(html)?.[1];
  assert.ok(asset); assert.equal((await fetch(new URL(asset, url))).status, 200);
  run("healthcheck", "run", container);
  console.log("Container acceptance passed: register, two admins, isolation, Agent, versions, publish/revoke, invite/edit, files, semantic OT merge, durable WebSocket commits, Agent operations/proposal review, epoch barriers, persistence through restart/recreation, offline continuation, backup, assets, healthcheck.");
} finally {
  await Promise.all([...feeds].map((feed) => feed.close()));
  // Remove only the exact temporary resources created by this test run.
  if (createdContainer) { assertOwnContainer(); run("rm", "-f", container); }
  if (createdVolume) {
    const inspected = JSON.parse(run("volume", "inspect", volume))[0];
    assert.equal(inspected.Labels["notes.test-run"], runId); assert.equal(inspected.Name, volume);
    run("volume", "rm", volume);
  }
}
