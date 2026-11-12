#!/usr/bin/env node
/**
 * Detached update runner (UC-32). The web process spawns this script, which
 * downloads the release runtime archive, verifies it, unpacks to
 * versions/<tag>, runs npm ci, switches DATA_DIR/current, stops the parent
 * so the platform (Docker restart policy, or this script's respawn) brings
 * the new version up, then waits on /api/health and rolls back on failure.
 *
 * Environment (set by server/update.ts):
 *   HEINOTE_DATA_DIR            data directory (required)
 *   HEINOTE_UPDATE_ASSET        runtime archive download URL (required)
 *   HEINOTE_UPDATE_SHA256       expected digest, empty to skip verification
 *   HEINOTE_UPDATE_TAG          release tag, used as versions/<tag> (required)
 *   HEINOTE_UPDATE_PORT         service port for the post-restart health check
 *   HEINOTE_UPDATE_IN_CONTAINER "1" → Docker restarts the process; no respawn
 *   HEINOTE_RESPAWN_COMMAND     source-deploy command to respawn after exit
 *   HEINOTE_UPDATE_TEST_MODE    "no-restart" → skip exit/respawn/health wait
 */
import { spawnSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, readlinkSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join, resolve } from "node:path";

const env = process.env;
const DATA_DIR = resolve(env.HEINOTE_DATA_DIR ?? "");
const ASSET = env.HEINOTE_UPDATE_ASSET ?? "";
const SHA256 = env.HEINOTE_UPDATE_SHA256 ?? "";
const TAG = env.HEINOTE_UPDATE_TAG ?? "";
const PORT = Number(env.HEINOTE_UPDATE_PORT ?? 0);
const IN_CONTAINER = env.HEINOTE_UPDATE_IN_CONTAINER === "1";
const RESPAWN = env.HEINOTE_RESPAWN_COMMAND ?? "";   // JSON argv array
const RESPAWN_CWD = env.HEINOTE_RESPAWN_CWD ?? process.cwd();
const TEST_MODE = env.HEINOTE_UPDATE_TEST_MODE ?? "";
const PPID = Number(env.HEINOTE_UPDATE_PPID ?? 0);

if (!DATA_DIR || !ASSET || !TAG) {
  console.error("update-runner: HEINOTE_DATA_DIR / HEINOTE_UPDATE_ASSET / HEINOTE_UPDATE_TAG are required.");
  process.exit(2);
}

const logDir = join(DATA_DIR, "update-log");
const versionsDir = join(DATA_DIR, "versions");
const statePath = join(logDir, "state.json");
const logPath = join(logDir, `update-${TAG}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
mkdirSync(logDir, { recursive: true });

const logLine = (line) => {
  const text = `${new Date().toISOString()} ${line}\n`;
  try { writeFileSync(logPath, text, { flag: "a" }); } catch { /* logging must not kill the update */ }
  process.stderr.write(text);
};
const state = (patch) => {
  let current = {};
  try { current = JSON.parse(readFileSync(statePath, "utf8")); } catch { /* torn or missing */ }
  const tmp = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...current, ...patch }));
  renameSync(tmp, statePath);
};
const step = (name) => { logLine(`step: ${name}`); state({ step: name }); };
const fail = (stepName, error) => {
  const message = error instanceof Error ? error.message : String(error);
  logLine(`failed at ${stepName}: ${message}`);
  state({ status: "failed", step: stepName, error: message, finishedAt: new Date().toISOString() });
};

const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const run = (cmd, args, opts = {}) => {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} 退出码 ${result.status}：${(result.stderr || result.stdout || "").trim().slice(0, 500)}`);
  return result;
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const pidAlive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
};
const processAlive = (pid) => pidAlive(pid);

const waitForExit = async (pid, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await sleep(250);
  }
  return false;
};

const waitForHealth = async (port, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/api/health`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return true;
    } catch { /* still starting */ }
    await sleep(500);
  }
  return false;
};

/** Newest notes-pre-migration-*.sqlite the migration layer produced. */
const newestMigrationSnapshot = () => {
  try {
    const names = readdirSync(logDir).filter((name) => /^notes-pre-migration-\d+-.*\.sqlite$/.test(name)).sort();
    return names.length ? join(logDir, names[names.length - 1]) : null;
  } catch { return null; }
};

/** Rolls current back and restores the pre-migration database snapshot. */
const rollback = (previousLink) => {
  const link = join(DATA_DIR, "current");
  try {
    if (previousLink && existsSync(previousLink)) {
      rmSync(link, { force: true });
      symlinkSync(previousLink, link, "dir");
    } else {
      rmSync(link, { force: true });
    }
    logLine(`current rolled back to ${previousLink ?? "built-in"}`);
  } catch (error) { logLine(`rollback of current failed: ${error}`); }
  const snapshot = newestMigrationSnapshot();
  if (snapshot) {
    try {
      const databasePath = join(DATA_DIR, "notes.sqlite");
      run("cp", [snapshot, databasePath]);
      for (const side of ["-wal", "-shm"]) rmSync(`${databasePath}${side}`, { force: true });
      logLine(`database restored from ${snapshot}`);
    } catch (error) { logLine(`database snapshot restore failed: ${error}`); }
  }
};

const downloadAsset = async (target) => {
  const response = await fetch(ASSET, { headers: { "User-Agent": "heinote-updater", Accept: "application/octet-stream" }, signal: AbortSignal.timeout(120_000), redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
  await pipeline(response.body, createWriteStream(target));
};

const killParent = () => {
  if (!PPID || !processAlive(PPID)) return;
  try { process.kill(PPID, "SIGTERM"); } catch { /* parent already gone */ }
};

const respawn = () => {
  if (IN_CONTAINER || !RESPAWN) return;
  let parts;
  try { parts = JSON.parse(RESPAWN); } catch { parts = RESPAWN.split(" ").filter(Boolean); }
  if (!Array.isArray(parts) || !parts.length) return;
  const child = spawn(parts[0], parts.slice(1), {
    detached: true, stdio: "ignore", cwd: RESPAWN_CWD, env: process.env,
  });
  child.unref();
  logLine(`respawned: ${parts.join(" ")} (pid ${child.pid})`);
};

const main = async () => {
  state({ status: "running", version: TAG, pid: process.pid, startedAt: new Date().toISOString() });
  mkdirSync(versionsDir, { recursive: true });
  const staging = mkdtempSync(join(versionsDir, ".stage-"));
  let currentStep = "download";
  try {
    step("download");
    const archive = join(staging, "runtime" + (ASSET.includes("tar.gz") ? ".tar.gz" : ".zip"));
    await downloadAsset(archive);
    logLine(`downloaded ${archive}`);

    currentStep = "verify";
    step("verify");
    if (SHA256) {
      const actual = sha256File(archive);
      if (actual !== SHA256) throw new Error(`SHA-256 校验失败：期望 ${SHA256}，实际 ${actual}`);
      logLine("sha256 verified");
    }

    currentStep = "unpack";
    step("unpack");
    const unpacked = join(staging, "unpacked");
    mkdirSync(unpacked, { recursive: true });
    if (archive.endsWith(".zip")) run("unzip", ["-q", "-o", archive, "-d", unpacked]);
    else run("tar", ["-xzf", archive, "-C", unpacked]);
    const manifest = JSON.parse(readFileSync(join(unpacked, "runtime-manifest.json"), "utf8"));
    if (manifest.version !== TAG.replace(/^v/i, "") && manifest.version !== TAG)
      throw new Error(`产物版本 ${manifest.version} 与发布标签 ${TAG} 不一致。`);

    currentStep = "install";
    step("install");
    if (env.HEINOTE_UPDATE_SKIP_NPM === "1") logLine("npm ci skipped (test mode)");
    else run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: unpacked, timeout: 300_000 });
    logLine("npm ci done");

    currentStep = "switch";
    step("switch");
    const versionDir = join(versionsDir, TAG);
    rmSync(versionDir, { recursive: true, force: true });
    renameSync(unpacked, versionDir);
    const link = join(DATA_DIR, "current");
    const previousLink = existsSync(link) ? readlinkSync(link) : null;
    const staged = join(DATA_DIR, `.current-${process.pid}`);
    rmSync(staged, { force: true });
    symlinkSync(versionDir, staged, "dir");
    renameSync(staged, link);
    logLine(`current -> ${versionDir}`);

    if (TEST_MODE === "no-restart") {
      state({ status: "applied", step: "switch", version: TAG, previousLink, finishedAt: new Date().toISOString() });
      logLine("test mode: applied without restart");
      return;
    }

    currentStep = "restart";
    step("restart");
    killParent();
    await waitForExit(PPID, 30_000);
    respawn();

    currentStep = "check";
    step("check");
    const healthy = PORT ? await waitForHealth(PORT, 300_000) : true;
    if (!healthy) {
      logLine("health check timed out; rolling back");
      rollback(previousLink);
      killParent();
      await waitForExit(PPID, 30_000);
      respawn();
      const recovered = PORT ? await waitForHealth(PORT, 120_000) : true;
      fail("check", `新版本启动失败，已回滚。旧版本恢复${recovered ? "成功" : "状态未知"}。`);
      process.exit(1);
    }
    // Health passed: the older version directory is no longer needed.
    if (previousLink && previousLink.startsWith(versionsDir)) rmSync(previousLink, { recursive: true, force: true });
    state({ status: "applied", step: "check", version: TAG, finishedAt: new Date().toISOString() });
    logLine(`updated to ${TAG}`);
  } catch (error) {
    fail(currentStep, error);
    process.exit(1);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
};

await main();
