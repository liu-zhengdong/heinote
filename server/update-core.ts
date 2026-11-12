import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, readlinkSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/** One step of an update run; the runner reports these to state.json. */
export type UpdateStep = "download" | "verify" | "unpack" | "install" | "switch" | "restart" | "check";
export interface UpdateState {
  status: "idle" | "running" | "failed" | "applied";
  step?: UpdateStep;
  version?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  pid?: number;
  /** Internal to the runner hand-off; harmless to expose, public URLs only. */
  assetUrl?: string;
  assetSha256?: string;
  port?: number;
}
export interface RuntimeManifest {
  name: string;
  version: string;
  files: string[];
}

export const updateLogDir = (dataDir: string) => join(dataDir, "update-log");
export const versionsDir = (dataDir: string) => join(dataDir, "versions");
export const stateFile = (dataDir: string) => join(updateLogDir(dataDir), "state.json");

export const readState = (dataDir: string): UpdateState => {
  try { return JSON.parse(readFileSync(stateFile(dataDir), "utf8")) as UpdateState; }
  catch { return { status: "idle" }; }
};

/** Write-temp-then-rename so readers never see a torn state file. */
export const writeState = (dataDir: string, state: UpdateState): void => {
  const dir = updateLogDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.state-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, stateFile(dataDir));
};

export const sha256File = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/** Extracts a .zip or .tar.gz archive into targetDir using system tools. */
export const unpackArchive = (archive: string, targetDir: string): void => {
  mkdirSync(targetDir, { recursive: true });
  const cmd = archive.endsWith(".zip")
    ? spawnSync("unzip", ["-q", "-o", archive, "-d", targetDir], { encoding: "utf8" })
    : spawnSync("tar", ["-xzf", archive, "-C", targetDir], { encoding: "utf8" });
  if (cmd.status !== 0)
    throw new Error(`解包产物归档失败：${(cmd.stderr || cmd.stdout || "").trim() || `退出码 ${cmd.status}`}`);
};

/**
 * Validates an unpacked runtime directory: manifest present and every listed
 * file exists. Returns the manifest for the version check that follows.
 */
export const readRuntimeManifest = (dir: string): RuntimeManifest => {
  const manifestPath = join(dir, "runtime-manifest.json");
  if (!existsSync(manifestPath)) throw new Error("产物归档缺少 runtime-manifest.json。");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RuntimeManifest;
  if (typeof manifest.version !== "string" || !manifest.version || !Array.isArray(manifest.files))
    throw new Error("runtime-manifest.json 格式无效。");
  for (const file of manifest.files) {
    if (typeof file !== "string" || !existsSync(join(dir, file)))
      throw new Error(`产物归档缺少文件：${file}`);
  }
  return manifest;
};

/**
 * Points dataDir/current at versions/<tag> via a staged symlink rename, so
 * readers never see a missing link. The previous version directory is kept:
 * the runner removes it only after the new version passes its health check,
 * because a failed start rolls the link back.
 */
export const switchCurrent = (dataDir: string, tag: string): { previous: string | null } => {
  const dir = resolve(dataDir);
  const target = join(versionsDir(dir), tag);
  const link = join(dir, "current");
  const previous = existsSync(link) ? readlinkSync(link) : null;
  const staged = join(dir, `.current-${process.pid}`);
  rmSync(staged, { force: true });
  symlinkSync(target, staged, "dir");
  renameSync(staged, link);
  return { previous };
};

/** Drops a versions/<tag> directory once the newer version is verified. */
export const dropVersion = (dataDir: string, tag: string): void => {
  const dir = resolve(versionsDir(dataDir), tag);
  if (dir.startsWith(versionsDir(dataDir)) && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
};

/** Removes stale .current-* and .stage-* leftovers from interrupted runs. */
export const cleanStaging = (dataDir: string): void => {
  for (const dir of [dataDir, versionsDir(dataDir)]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".current-") || name.startsWith(".stage-"))
        rmSync(join(dir, name), { recursive: true, force: true });
    }
  }
};

export const stagedVersionDir = (dataDir: string): string => {
  mkdirSync(versionsDir(dataDir), { recursive: true });
  return mkdtempSync(join(versionsDir(dataDir), ".stage-"));
};
