import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import WebSocket from "ws";

const engine = process.env.CONTAINER_ENGINE ?? "podman";
const image = process.env.HEINOTE_IMAGE ?? "localhost/heinote:latest";
const runId = randomUUID();
const container = `heinote-accept-${runId}`;
const volume = `${container}-data`;
const run = (...args) => execFileSync(engine, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 }).trim();
const documents = new Set();
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
const expected = (value) => ({ scope: value.scope, pageId: value.pageId, generation: value.generation, revision: value.revision });
function fork(value) {
  const doc = new Y.Doc(); Y.applyUpdate(doc, Buffer.from(value.state, "base64")); documents.add(doc); return doc;
}
function field(doc, key) {
  const value = doc.getMap("fields").get(key);
  assert.ok(value instanceof Y.Text, `A persisted collaborative field must remain Y.Text: ${key}`);
  return value;
}
function update(doc, work) {
  const before = Y.encodeStateVector(doc); doc.transact(work, "independent-container-test");
  return Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString("base64");
}
function text(value, key) { return field(fork(value), key).toString(); }
function assertSnapshot(value) {
  assert.equal(typeof value.generation, "string"); assert.ok(value.generation);
  assert.equal(typeof value.revision, "string"); assert.ok(value.revision);
  assert.equal(typeof value.state, "string"); assert.ok(value.state);
  assert.equal(value.records?.page?.id, value.pageId);
  assert.ok(Array.isArray(value.records.blocks));
  assert.ok(value.records.blocks.every((row) => row.value.page === value.pageId));
  for (const [key, shared] of fork(value).getMap("fields")) {
    assert.ok(shared instanceof Y.Text);
    const [collection, encodedId, ...path] = key.split("/"); const recordId = decodeURIComponent(encodedId);
    assert.ok(collection === "pages" || collection === "blocks");
    let projected = collection === "pages" && recordId === value.pageId ? value.records.page : value.records.blocks.find((row) => row.id === recordId)?.value;
    for (const segment of path) projected = projected?.[decodeURIComponent(segment)];
    assert.ok(Array.isArray(projected), `The snapshot must include the SQL projection for ${key}`);
    assert.equal(projected.filter((run) => typeof run.text === "string").map((run) => run.text).join(""), shared.toString());
    assert.equal(projected.filter((run) => run.embed !== undefined).length, shared.toDelta().filter((part) => typeof part.insert === "object").length);
  }
}
async function snapshot(client, scope, pageId) {
  const value = expectStatus(await client(`/api/collaboration/${encodeURIComponent(scope)}/${encodeURIComponent(pageId)}`), 200);
  assert.equal(value.scope, scope); assert.equal(value.pageId, pageId); assertSnapshot(value); return value;
}
async function submit(client, basis, bytes, requestId = randomUUID()) {
  return client("/api/records/batch", { method: "POST", body: { requestId, writes: [], textUpdates: [{ scope: basis.scope, pageId: basis.pageId, generation: basis.generation, update: bytes }], expectedPages: [] } });
}
function assertIdentity(before, after, key) {
  assert.equal(after.generation, before.generation, "Restarting a service must retain its document generation");
  assert.equal(after.revision, before.revision, "Restarting a service cannot modify the page projection");
  const a = fork(before); const b = fork(after);
  assert.deepEqual(Y.encodeStateVector(b), Y.encodeStateVector(a), "The stored CRDT identities must survive instead of being seeded from JSON");
  assert.deepEqual(field(b, key).toDelta(), field(a, key).toDelta());
  const index = Math.min(1, field(a, key).length);
  const anchor = Y.createRelativePositionFromTypeIndex(field(a, key), index);
  const restored = Y.createAbsolutePositionFromRelativePosition(anchor, b);
  assert.ok(restored, "A relative position must resolve after restarting from the persistent volume");
  assert.equal(restored.index, index); assert.equal(restored.type, field(b, key));
}
function assertDurableSnapshot(value) {
  // A separate container process reads SQLite after receiving the WebSocket event.
  const script = `import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync('/app/data/notes.sqlite', {readOnly:true});
    try {
      const [scope,pageId] = process.argv.slice(1);
      const doc = db.prepare('SELECT generation,state FROM collaboration_documents WHERE scope=? AND page_id=?').get(scope,pageId);
      const page = db.prepare("SELECT value FROM records WHERE scope=? AND collection='pages' AND id=?").get(scope,pageId);
      const blocks = db.prepare("SELECT id,value FROM records WHERE scope=? AND collection='blocks' AND json_extract(value,'$.page')=? ORDER BY id").all(scope,pageId).map(row=>({id:row.id,value:JSON.parse(row.value)}));
      console.log(JSON.stringify({generation:doc?.generation,state:doc?Buffer.from(doc.state).toString('base64'):null,records:{page:page?JSON.parse(page.value):null,blocks}}));
    } finally { db.close(); }`;
  const persisted = JSON.parse(run("exec", container, "node", "--input-type=module", "-e", script, value.scope, value.pageId));
  assert.equal(persisted.generation, value.generation);
  assert.equal(persisted.state, value.state, "A WebSocket snapshot must already exist in the committed binary database");
  assert.deepEqual(persisted.records, value.records, "The event binary and SQL projection must belong to the same committed transaction");
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
    return this.snapshot((value) => value.scope === scope && value.pageId === pageId);
  }
  async snapshot(predicate, after = 0, commitOnly = false) {
    const events = () => this.messages.slice(after).flatMap((message) => {
      if (message.type !== "commit") return commitOnly ? [] : [message];
      assert.ok(Array.isArray(message.documents));
      assert.ok(message.documents.every((event) => ["document", "reset"].includes(event.type) && event.snapshot));
      return message.documents;
    });
    await this.wait(() => events().some((event) => event.snapshot && predicate(event.snapshot)));
    const value = events().find((event) => event.snapshot && predicate(event.snapshot)).snapshot;
    assertSnapshot(value); return value;
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
  const oldDoc = fork(beforeRestore);
  const oldBytes = update(oldDoc, () => field(oldDoc, bodyKey(oldBlock.id)).insert(0, "恢复后不得复活"));
  const restored = expectStatus(await alice(`/api/v1/pages/${page.id}/restore`, { method: "POST", token: writer.token, body: { versionId: version.id, baseRevision: beforeRestore.revision } }), 200);
  assert.equal(restored.text, "恢复前的正文");
  const afterRestore = await snapshot(alice, "personal", page.id);
  assert.notEqual(afterRestore.generation, beforeRestore.generation);
  expectStatus(await submit(alice, beforeRestore, oldBytes), 409);
  assert.equal((await snapshot(alice, "personal", page.id)).state, afterRestore.state, "An old-generation update cannot revive text after a restore");
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
  assert.equal(initialFeed.state, baseline.state);
  const forkA = fork(baseline); const forkB = fork(baseline);
  // Both independent edits exist before either HTTP request is submitted.
  const bytesA = update(forkA, () => field(forkA, key).insert(0, "甲😀"));
  const bytesB = update(forkB, () => field(forkB, key).insert(0, "乙"));
  let mark = feed.messages.length;
  expectStatus(await submit(bob, baseline, bytesB), 200);
  const middle = await snapshot(bob, space.spaceId, shared.id);
  const committedB = await feed.snapshot((value) => value.revision === middle.revision, mark, true);
  assertDurableSnapshot(committedB);
  assert.equal(text(committedB, key), "乙协作者保存");
  mark = feed.messages.length;
  const replayId = randomUUID();
  expectStatus(await submit(alice, baseline, bytesA, replayId), 200);
  const merged = await snapshot(alice, space.spaceId, shared.id);
  const committedA = await feed.snapshot((value) => value.revision === merged.revision, mark, true);
  assertDurableSnapshot(committedA);
  assert.equal(merged.generation, baseline.generation);
  Y.applyUpdate(forkA, Buffer.from(bytesB, "base64")); Y.applyUpdate(forkB, Buffer.from(bytesA, "base64"));
  const mergedDoc = fork(merged);
  assert.deepEqual(field(mergedDoc, key).toDelta(), field(forkA, key).toDelta());
  assert.deepEqual(field(forkA, key).toDelta(), field(forkB, key).toDelta());
  assert.equal(text(merged, key).length, "甲😀乙协作者保存".length);
  assert.ok(text(merged, key).includes("甲😀") && text(merged, key).includes("乙") && text(merged, key).includes("协作者保存"));
  expectStatus(await submit(alice, baseline, bytesA, replayId), 200);
  assert.equal((await snapshot(bob, space.spaceId, shared.id)).state, merged.state, "A retried binary update cannot insert text twice");

  const movedRow = merged.records.blocks.find((row) => row.id === body.id); assert.ok(movedRow);
  const move = { scope: space.spaceId, collection: "blocks", id: body.id, action: "patch", patch: { order: 4096 }, base: movedRow.value };
  expectStatus(await alice("/api/records/batch", { method: "POST", body: { requestId: randomUUID(), writes: [move] } }), 409);
  expectStatus(await alice("/api/records/batch", { method: "POST", body: { requestId: randomUUID(), writes: [move], expectedPages: [expected(baseline)] } }), 409);
  assert.equal((await snapshot(alice, space.spaceId, shared.id)).state, merged.state);
  expectStatus(await alice("/api/records/batch", { method: "POST", body: { requestId: randomUUID(), writes: [move], expectedPages: [expected(merged)] } }), 200);
  const moved = await snapshot(alice, space.spaceId, shared.id);
  assert.equal(moved.records.blocks.find((row) => row.id === body.id).value.order, 4096);
  assert.equal(text(moved, key), text(merged, key));

  const agentView = expectStatus(await alice(`/api/v1/pages/${shared.id}`, { token: writer.token }), 200);
  assert.ok(agentView.collaboration?.generation, "An Agent must obtain its generation without a browser session");
  const append = { requestId: randomUUID(), generation: agentView.collaboration.generation, operations: [{ type: "insert_text", blockId: body.value.id, index: "end", text: "Agent结构化追加" }] };
  expectStatus(await alice(`/api/v1/pages/${shared.id}/operations`, { method: "POST", token: writer.token, body: append }), 200);
  expectStatus(await alice(`/api/v1/pages/${shared.id}/operations`, { method: "POST", token: writer.token, body: append }), 200);
  const appended = await snapshot(alice, space.spaceId, shared.id);
  assert.equal(text(appended, key), text(merged, key) + "Agent结构化追加");
  const inserted = expectStatus(await alice(`/api/v1/pages/${shared.id}/operations`, { method: "POST", token: writer.token, body: {
    requestId: randomUUID(), generation: appended.generation, baseRevision: appended.revision,
    operations: [{ type: "insert_block", afterId: body.value.id, kind: "text", text: "Agent新增段落" }],
  } }), 200);
  const insertedSnapshot = await snapshot(alice, space.spaceId, shared.id);
  assert.equal(Object.values(inserted.page.block_tree.by_id).filter((block) => block.content.map((run) => run.text ?? "").join("") === "Agent新增段落").length, 1);
  const suggestion = { requestId: randomUUID(), generation: insertedSnapshot.generation, baseRevision: insertedSnapshot.revision, mode: "suggest", operations: [{ type: "insert_text", blockId: body.value.id, index: "end", text: "审核通过" }] };
  const proposal = expectStatus(await alice(`/api/v1/pages/${shared.id}/operations`, { method: "POST", token: writer.token, body: suggestion }), 201);
  assert.equal(proposal.status, "pending"); assert.equal(proposal.author.id, a.id);
  assert.equal((await snapshot(bob, space.spaceId, shared.id)).state, insertedSnapshot.state, "An unapproved suggestion must not modify the live document");
  const proposals = expectStatus(await bob(`/api/proposals?scope=${encodeURIComponent(space.spaceId)}&pageId=${encodeURIComponent(shared.id)}`), 200);
  assert.equal(proposals.find((item) => item.id === proposal.id)?.status, "pending");
  expectStatus(await bob(`/api/proposals/${proposal.id}/apply`, { method: "POST", body: { baseRevision: proposal.baseRevision } }), 200);
  const approved = await snapshot(alice, space.spaceId, shared.id);
  assert.equal(text(approved, key), text(merged, key) + "Agent结构化追加审核通过");
  assert.equal(expectStatus(await bob(`/api/proposals?scope=${encodeURIComponent(space.spaceId)}&pageId=${encodeURIComponent(shared.id)}`), 200).find((item) => item.id === proposal.id).status, "applied");
  await feed.close();

  const offline = fork(approved);
  const offlineBytes = update(offline, () => field(offline, key).insert(field(offline, key).length, "重启前草稿"));
  const privateBeforeRestart = await snapshot(alice, "personal", page.id);
  const privateKey = bodyKey(privateBeforeRestart.records.blocks[0].id);
  run("restart", container); await waitForServer();
  const restarted = await snapshot(alice, space.spaceId, shared.id);
  assertIdentity(approved, restarted, key);
  assertIdentity(privateBeforeRestart, await snapshot(alice, "personal", page.id), privateKey);
  expectStatus(await submit(alice, approved, offlineBytes), 200);
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
  console.log("Container acceptance passed: register, two admins, isolation, Agent, versions, publish/revoke, invite/edit, files, independent CRDT merge, durable WebSocket snapshots, structure CAS, Agent operations/proposal review, generation barriers, binary identity through restart/recreation, offline continuation, backup, assets, healthcheck.");
} finally {
  await Promise.all([...feeds].map((feed) => feed.close()));
  for (const doc of documents) doc.destroy();
  // Remove only the exact temporary resources created by this test run.
  if (createdContainer) { assertOwnContainer(); run("rm", "-f", container); }
  if (createdVolume) {
    const inspected = JSON.parse(run("volume", "inspect", volume))[0];
    assert.equal(inspected.Labels["notes.test-run"], runId); assert.equal(inspected.Name, volume);
    run("volume", "rm", volume);
  }
}
