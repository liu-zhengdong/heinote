import { DatabaseSync, backup } from "node:sqlite";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import migration002 from "./002-token-identity.ts";
import migration003 from "./003-quota-columns.ts";

/** A migration mutates the open database inside the runner's transaction. */
export interface Migration {
  version: number;
  description: string;
  migrate(db: DatabaseSync): void;
}

/**
 * The ordered migration chain. Versions must be contiguous starting at 2;
 * version 1 is the baseline every pre-migration database already carries.
 */
export const MIGRATIONS: Migration[] = [migration002, migration003];
export const LATEST_VERSION = MIGRATIONS.length ? Math.max(...MIGRATIONS.map((m) => m.version)) : 1;

const SNAPSHOTS_KEPT = 3;
const updateLogDir = (dataDir: string) => join(dataDir, "update-log");

const currentVersion = (db: DatabaseSync): number =>
  Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);

const setVersion = (db: DatabaseSync, version: number): void => {
  db.exec(`PRAGMA user_version=${version}`);
};

const validateChain = (migrations: Migration[]): void => {
  migrations.forEach((migration, index) => {
    const expected = index + 2;
    if (migration.version !== expected)
      throw new Error(`数据库迁移链不完整：期望迁移版本 ${expected}，实际为 ${migration.version}（${migration.description}）。`);
  });
};

const snapshot = async (db: DatabaseSync, dataDir: string, fromVersion: number): Promise<string> => {
  const dir = updateLogDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `notes-pre-migration-${fromVersion}-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`;
  const target = join(dir, name);
  await backup(db, target);
  const snapshots = readdirSync(dir)
    .filter((file) => /^notes-pre-migration-\d+-.*\.sqlite$/.test(file))
    .sort();
  for (const stale of snapshots.slice(0, Math.max(0, snapshots.length - SNAPSHOTS_KEPT)))
    rmQuietly(join(dir, stale));
  return target;
};

/** Stale snapshot cleanup is best-effort and must not fail the migration. */
const rmQuietly = (path: string): void => {
  try { rmSync(path, { force: true }); } catch { /* ignore */ }
};

/**
 * Applies pending schema migrations to notes.sqlite in dataDir, then closes
 * the database. Runs before Store construction. New databases (user_version
 * 0) skip migration: Store's CREATE TABLE IF NOT EXISTS baseline stamps the
 * latest version. Throws on a database newer than this code knows, on a
 * broken migration chain, or when the pre-migration snapshot fails.
 *
 * `migrations` overrides the chain for tests; production always passes none.
 */
export const migrateDatabase = async (dataDir: string, migrations: Migration[] = MIGRATIONS): Promise<void> => {
  validateChain(migrations);
  const latest = migrations.length ? Math.max(...migrations.map((m) => m.version)) : 1;
  const dir = resolve(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const databasePath = join(dir, "notes.sqlite");
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    let version = currentVersion(db);
    if (version === 0) {
      // user_version 0 means either a fresh database or a legacy one from
      // before the version stamp existed. Tables present => legacy baseline.
      const hasTables = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1").get());
      if (!hasTables) return; // fresh: baseline CREATE + stamp in Store
      version = 1;
    }
    if (version > latest)
      throw new Error(`数据库版本 ${version} 高于本应用支持的版本 ${latest}：数据库来自更新版本。请升级应用，或以最近的数据库快照替换 notes.sqlite（同时删除 -wal 与 -shm 侧文件）。`);
    const pending = migrations.filter((migration) => migration.version > version);
    if (!pending.length) return;
    await snapshot(db, dir, version);
    for (const migration of pending) {
      db.exec("BEGIN IMMEDIATE");
      try {
        migration.migrate(db);
        setVersion(db, migration.version);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw new Error(`数据库迁移 ${migration.version}（${migration.description}）失败，已回滚该迁移：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    db.close();
  }
};
