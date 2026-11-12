import { spawn } from "node:child_process";
import { backup, DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync } from "node:fs";
import { fail } from "./store.ts";
import { readState, writeState, updateLogDir, cleanStaging, type UpdateState } from "./update-core.ts";

/** Options the server injects; tests override apiBase and spawnRunner. */
export interface UpdateConfig {
  repository: string;
  version: string;
  dataDir: string;
  /** Test seam: point GitHub API at a stub server. */
  apiBase?: string;
  /** Test seam: run an alternate runner script. */
  runnerPath?: string;
}

export interface ReleaseInfo {
  tag: string;
  name: string;
  notes: string;
  asset: string | null;
  assetSha256: string | null;
  newer: boolean;
}

/** semver-ish compare: numbers and prerelease tags, enough for release tags. */
export const newerVersion = (candidate: string, current: string): boolean => {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/i, "").split("-", 2);
    return { nums: core.split(".").map((n) => parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const a = parse(candidate), b = parse(current);
  for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i++) {
    const d = (a.nums[i] ?? 0) - (b.nums[i] ?? 0);
    if (d) return d > 0;
  }
  if (a.pre === b.pre) return false;
  if (a.pre === null) return true;   // stable beats prerelease
  if (b.pre === null) return false;
  return a.pre > b.pre;
};

interface GithubAsset { name: string; browser_download_url: string; digest?: string }
interface GithubRelease { tag_name: string; name?: string; body?: string; assets?: GithubAsset[]; prerelease?: boolean; draft?: boolean }

const githubFetch = async (url: string): Promise<Response> => {
  const response = await fetch(url, {
    headers: { "User-Agent": "heinote-updater", Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15_000),
  });
  return response;
};

const repoSlug = (repository: string): string => {
  const match = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(repository);
  if (!match) fail(400, "package.json 的 repository 无法解析为 GitHub 仓库。", "bad_request");
  return match[1];
};

/** Queries the latest GitHub release and locates the runtime archive asset. */
export const checkUpdate = async (config: UpdateConfig): Promise<ReleaseInfo> => {
  const slug = repoSlug(config.repository);
  const apiBase = config.apiBase ?? "https://api.github.com";
  let release: GithubRelease;
  try {
    const response = await githubFetch(`${apiBase}/repos/${slug}/releases/latest`);
    if (response.status === 404) fail(404, "仓库尚无已发布的 Release。", "not_found");
    if (!response.ok) fail(502, `检查更新失败：GitHub 返回 ${response.status}。`, "upstream_error");
    release = await response.json() as GithubRelease;
  } catch (error) {
    if (error && typeof error === "object" && "status" in error) throw error;
    fail(502, `检查更新失败：无法访问 GitHub（${error instanceof Error ? error.message : String(error)}）。`, "upstream_error");
  }
  const asset = release.assets?.find((item) => /runtime(-[\w.]+)?\.(zip|tar\.gz)$/.test(item.name)) ?? null;
  return {
    tag: release.tag_name,
    name: release.name ?? release.tag_name,
    notes: release.body ?? "",
    asset: asset?.browser_download_url ?? null,
    assetSha256: asset?.digest?.replace(/^sha256:/i, "") ?? null,
    newer: newerVersion(release.tag_name, config.version),
  };
};

const RUNNER = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/update-runner.mjs");

const backupDatabase = async (dataDir: string): Promise<void> => {
  const databasePath = join(dataDir, "notes.sqlite");
  if (!existsSync(databasePath)) return;
  const dir = updateLogDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try { await backup(db, join(dir, `notes-pre-update-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`)); }
  finally { db.close(); }
};

const inContainer = (): boolean =>
  existsSync("/.dockerenv") || Boolean(process.env.KUBERNETES_SERVICE_HOST || process.env.HEINOTE_UPDATE_IN_CONTAINER);

const spawnRunner = (config: UpdateConfig, state: UpdateState): number => {
  const env = {
    ...process.env,
    HEINOTE_DATA_DIR: config.dataDir,
    HEINOTE_UPDATE_ASSET: state.assetUrl!,
    HEINOTE_UPDATE_SHA256: state.assetSha256 ?? "",
    HEINOTE_UPDATE_TAG: state.version!,
    HEINOTE_UPDATE_PORT: String(state.port ?? 0),
    HEINOTE_UPDATE_IN_CONTAINER: inContainer() ? "1" : "",
    HEINOTE_UPDATE_PPID: String(process.pid),
    // JSON keeps argv intact for paths containing spaces.
    HEINOTE_RESPAWN_COMMAND: inContainer() ? "" : JSON.stringify(process.argv),
    HEINOTE_RESPAWN_CWD: process.cwd(),
    HEINOTE_UPDATE_TEST_MODE: process.env.HEINOTE_UPDATE_TEST_MODE ?? "",
    HEINOTE_UPDATE_SKIP_NPM: process.env.HEINOTE_UPDATE_SKIP_NPM ?? "",
  };
  const runner = config.runnerPath ?? RUNNER;
  const child = spawn(process.execPath, [runner], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env,
  });
  child.unref();
  return child.pid ?? 0;
};

/**
 * Backs up data, records running state, and spawns the detached runner.
 * The runner performs the heavy work so an admin request never blocks.
 */
export const applyUpdate = async (config: UpdateConfig, port: number): Promise<UpdateState> => {
  const state = readState(config.dataDir) as UpdateState;
  if (state.status === "running") fail(409, "已有更新任务进行中。", "conflict");
  const release = await checkUpdate(config);
  if (!release.newer) fail(409, "当前已是最新版本。", "conflict");
  if (!release.asset) fail(409, `版本 ${release.tag} 未提供自动更新产物，请手动升级。`, "conflict");
  cleanStaging(config.dataDir);
  await backupDatabase(config.dataDir);
  const next: UpdateState = {
    status: "running", step: "download", version: release.tag,
    startedAt: new Date().toISOString(), assetUrl: release.asset,
    assetSha256: release.assetSha256 ?? undefined, port,
  };
  writeState(config.dataDir, next);
  try {
    next.pid = spawnRunner(config, next);
  } catch (error) {
    next.status = "failed";
    next.error = `启动更新进程失败：${error instanceof Error ? error.message : String(error)}`;
    next.finishedAt = new Date().toISOString();
    writeState(config.dataDir, next);
    throw error;
  }
  writeState(config.dataDir, next);
  return next;
};

export const updateStatus = (config: UpdateConfig): UpdateState => readState(config.dataDir);
