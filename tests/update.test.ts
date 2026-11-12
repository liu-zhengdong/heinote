import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync, readdirSync, readlinkSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { startServer } from "../server/index.ts";
import { newerVersion } from "../server/update.ts";
import { readState, switchCurrent, versionsDir, writeState, type UpdateState } from "../server/update-core.ts";
import { Browser, type Json, type Reply } from "./helpers/github.ts";

// UC-32 acceptance uses real HTTP plus the real detached runner (test mode).
const password = "Correct-horse-battery-2026!";
type RunningServer = Awaited<ReturnType<typeof startServer>>;

function status(reply: Reply, expected: number): Json {
  assert.equal(reply.status, expected, JSON.stringify(reply.body));
  return reply.body;
}

const makeArchive = (dir: string, tag: string, version = tag.replace(/^v/i, "")): string => {
  const staging = mkdtempSync(join(dir, `pkg-${tag}-`));
  for (const file of ["package.json", "package-lock.json", "runtime-manifest.json", "dist/app.js", "server/index.ts", "src/main.ts"]) {
    const path = join(staging, file);
    spawnSync("mkdir", ["-p", dirname(path)]);
    writeFileSync(path, file === "runtime-manifest.json"
      ? JSON.stringify({ name: "heinote", version, files: ["package.json", "runtime-manifest.json", "dist/app.js"] })
      : `// ${file}`);
  }
  const archive = join(dir, `heinote-runtime-${tag}.tar.gz`);
  const result = spawnSync("tar", ["-czf", archive, "-C", staging, "."]);
  assert.equal(result.status, 0, result.stderr?.toString());
  return archive;
};

/** Minimal GitHub API stub serving /releases/latest and the asset bytes. */
async function releaseStub(t: TestContext, tag: string, options: { noAsset?: boolean; digest?: string; corrupt?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "heinote-release-"));
  const archive = options.noAsset ? null : makeArchive(dir, tag);
  const bytes = archive ? readFileSync(archive) : null;
  if (bytes && options.corrupt) bytes[bytes.length - 1] ^= 0xff;
  const digest = archive ? createHash("sha256").update(bytes ?? []).digest("hex") : null;
  const assetUrl = () => `http://127.0.0.1:${(server.address() as { port: number }).port}/asset.tar.gz`;
  const server: Server = createServer((req, res) => {
    if (req.url === "/repos/liu-zhengdong/heinote/releases/latest") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        tag_name: tag, name: `Release ${tag}`, body: "release notes\nmore",
        assets: archive ? [{ name: `heinote-runtime-${tag}.tar.gz`, browser_download_url: assetUrl(), digest: `sha256:${options.digest ?? digest}` }] : [],
      }));
      return;
    }
    if (req.url === "/asset.tar.gz" && bytes) { res.setHeader("Content-Type", "application/octet-stream"); res.end(bytes); return; }
    res.statusCode = 404; res.end("not found");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function fixture(t: TestContext, apiBase: string) {
  const directory = await mkdtemp(join(tmpdir(), "heinote-update-"));
  const server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false, registrationOpen: true, update: { apiBase } });
  t.after(async () => {
    try { await server.close(); }
    finally {
      const target = resolve(directory);
      assert.equal(dirname(target), resolve(tmpdir()));
      assert.ok(basename(target).startsWith("heinote-update-"));
      await rm(target, { recursive: true, force: true });
    }
  });
  const browser = new Browser(() => server.url);
  await status(await browser.request("/api/auth/register", {
    method: "POST", body: { handle: "admin", displayName: "Admin", password },
  }), 201);
  return { directory, server, browser };
}

const waitState = async (directory: string, expected: string, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readState(directory);
    if (state.status === expected) return state;
    if (state.status === "failed" && expected !== "failed") assert.fail(`update failed at ${state.step}: ${state.error}`);
    await new Promise((done) => setTimeout(done, 200));
  }
  assert.fail(`state did not reach ${expected}: ${JSON.stringify(readState(directory))}`);
};

test("newerVersion compares stable and prerelease tags", () => {
  assert.equal(newerVersion("v1.2.0", "1.0.0"), true);
  assert.equal(newerVersion("1.0.0", "1.0.0"), false);
  assert.equal(newerVersion("v0.9.9", "1.0.0"), false);
  assert.equal(newerVersion("v1.0.1", "1.0"), true);
  assert.equal(newerVersion("v1.0.0-rc.1", "1.0.0"), false);
  assert.equal(newerVersion("v1.0.0", "1.0.0-rc.1"), true);
});

test("update-check reports a newer release and non-admin gets 403", async (t) => {
  const apiBase = await releaseStub(t, "v9.9.9");
  const f = await fixture(t, apiBase);
  const reply = status(await f.browser.request("/api/admin/update-check"), 200);
  assert.equal(reply.tag, "v9.9.9");
  assert.equal(reply.newer, true);
  assert.match(String(reply.asset), /\/asset\.tar\.gz$/);
  const guest = new Browser(() => f.server.url);
  await status(await guest.request("/api/auth/register", { method: "POST", body: { handle: "bob", displayName: "Bob", password } }), 201);
  assert.equal((await guest.request("/api/admin/update-check")).status, 403);
  assert.equal((await guest.request("/api/admin/update-apply", { method: "POST" })).status, 403);
});

test("update-status completes a restarted runtime only when its version matches", async (t) => {
  const f = await fixture(t, await releaseStub(t, "v9.9.9"));
  const about = status(await f.browser.request("/api/admin/about"), 200);
  const version = `v${about.version}`;
  for (const step of ["restart", "check"] as const) {
    writeState(f.directory, { status: "running", step, version, startedAt: "2026-11-12T11:46:56.357Z" });
    const state = status(await f.browser.request("/api/admin/update-status"), 200);
    assert.equal(state.status, "applied");
    assert.equal(state.step, "check");
    assert.equal(state.version, version);
    assert.equal(state.startedAt, "2026-11-12T11:46:56.357Z");
    assert.ok(state.finishedAt);
    assert.deepEqual(readState(f.directory), state, "completion survives the next read");
  }
  const unchanged: UpdateState[] = [
    { status: "running", step: "restart", version: "v9.9.9" },
    { status: "running", step: "download", version },
    { status: "running", step: "switch", version },
    { status: "failed", step: "check", version, error: "health check failed" },
  ];
  for (const expected of unchanged) {
    writeState(f.directory, expected);
    assert.deepEqual(status(await f.browser.request("/api/admin/update-status"), 200), expected);
    assert.deepEqual(readState(f.directory), expected);
    if (expected.status === "running") {
      assert.equal((await f.browser.request("/api/admin/update-apply", { method: "POST" })).status, 409);
    }
  }
});

test("update-apply accepts the next release after a completed container restart", async (t) => {
  process.env.HEINOTE_UPDATE_TEST_MODE = "no-restart";
  process.env.HEINOTE_UPDATE_SKIP_NPM = "1";
  t.after(() => { delete process.env.HEINOTE_UPDATE_TEST_MODE; delete process.env.HEINOTE_UPDATE_SKIP_NPM; });
  const f = await fixture(t, await releaseStub(t, "v9.9.9"));
  const about = status(await f.browser.request("/api/admin/about"), 200);
  writeState(f.directory, { status: "running", step: "restart", version: `v${about.version}` });
  status(await f.browser.request("/api/admin/update-apply", { method: "POST" }), 202);
  const applied = await waitState(f.directory, "applied");
  assert.equal(applied.version, "v9.9.9");
});

test("update-apply without archive or newer version returns 409", async (t) => {
  const noAsset = await releaseStub(t, "v9.9.9", { noAsset: true });
  const f1 = await fixture(t, noAsset);
  const check = status(await f1.browser.request("/api/admin/update-check"), 200);
  assert.equal(check.newer, true);
  assert.equal(check.asset, null);
  assert.equal((await f1.browser.request("/api/admin/update-apply", { method: "POST" })).status, 409);
  const oldRelease = await releaseStub(t, "v0.0.1");
  const f2 = await fixture(t, oldRelease);
  const reply = await f2.browser.request("/api/admin/update-apply", { method: "POST" });
  assert.equal(reply.status, 409);
});

test("update-apply runs the runner to applied state and switches current", async (t) => {
  process.env.HEINOTE_UPDATE_TEST_MODE = "no-restart";
  process.env.HEINOTE_UPDATE_SKIP_NPM = "1";
  t.after(() => { delete process.env.HEINOTE_UPDATE_TEST_MODE; delete process.env.HEINOTE_UPDATE_SKIP_NPM; });
  const apiBase = await releaseStub(t, "v9.9.9");
  const f = await fixture(t, apiBase);
  const reply = status(await f.browser.request("/api/admin/update-apply", { method: "POST" }), 202);
  assert.equal(reply.status, "running");
  const state = await waitState(f.directory, "applied");
  assert.equal(state.version, "v9.9.9");
  const link = readlinkSync(join(f.directory, "current"));
  assert.equal(link, join(versionsDir(f.directory), "v9.9.9"));
  assert.ok(existsSync(join(link, "runtime-manifest.json")));
  const logs = readdirSync(join(f.directory, "update-log")).filter((name) => name.startsWith("update-"));
  assert.ok(logs.length >= 1, "runner log exists");
  const snapshots = readdirSync(join(f.directory, "update-log")).filter((name) => name.startsWith("notes-pre-update-"));
  assert.equal(snapshots.length, 1, "pre-update backup snapshot exists");
});

test("update-apply with corrupt archive records failed state and keeps built-in", async (t) => {
  process.env.HEINOTE_UPDATE_TEST_MODE = "no-restart";
  process.env.HEINOTE_UPDATE_SKIP_NPM = "1";
  t.after(() => { delete process.env.HEINOTE_UPDATE_TEST_MODE; delete process.env.HEINOTE_UPDATE_SKIP_NPM; });
  const apiBase = await releaseStub(t, "v9.9.9", { digest: "0".repeat(64) });
  const f = await fixture(t, apiBase);
  status(await f.browser.request("/api/admin/update-apply", { method: "POST" }), 202);
  const state = await waitState(f.directory, "failed");
  assert.equal(state.step, "verify");
  assert.match(String(state.error), /SHA-256/);
  assert.equal(existsSync(join(f.directory, "current")), false, "current link untouched");
});

test("switchCurrent moves the link and keeps the previous version for rollback", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "heinote-switch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const tag of ["v1", "v2"]) {
    const target = join(versionsDir(directory), tag);
    spawnSync("mkdir", ["-p", target]);
    writeFileSync(join(target, "package.json"), "{}");
    switchCurrent(directory, tag);
    assert.equal(readlinkSync(join(directory, "current")), target);
  }
  assert.ok(existsSync(join(versionsDir(directory), "v1")), "previous version kept");
  assert.ok(existsSync(join(versionsDir(directory), "v2")));
});
