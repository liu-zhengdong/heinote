import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateDatabase, LATEST_VERSION } from "../server/migrations/index.ts";
import { Store } from "../server/store.ts";

const dir = () => mkdtempSync(join(tmpdir(), "heinote-migrations-"));
const dbPath = (dataDir: string) => join(dataDir, "notes.sqlite");
const versionOf = (path: string): number => {
  const db = new DatabaseSync(path);
  try { return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version); }
  finally { db.close(); }
};
const columnsOf = (path: string, table: string): string[] => {
  const db = new DatabaseSync(path);
  try { return (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{ name: string }>).map((row) => row.name); }
  finally { db.close(); }
};
const snapshots = (dataDir: string): string[] =>
  readdirSync(join(dataDir, "update-log")).filter((file) => file.startsWith("notes-pre-migration-"));

/** The schema a user_version=1 database carried before token identity and quotas. */
const createOldDatabase = (dataDir: string, { patchedTokens = false, patchedQuotas = false } = {}) => {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(dbPath(dataDir));
  try {
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE users(id TEXT PRIMARY KEY, handle TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, password TEXT NOT NULL, site_role TEXT NOT NULL${patchedQuotas ? ", created_at TEXT, storage_limit INTEGER, team_creation_limit INTEGER" : ""});
      CREATE TABLE sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
      CREATE TABLE spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id));
      CREATE TABLE members(space_id TEXT NOT NULL REFERENCES spaces(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL, PRIMARY KEY(space_id,user_id));
      CREATE TABLE invitations(id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), user_id TEXT NOT NULL REFERENCES users(id), inviter_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL, status TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE records(scope TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope,collection,id));
      CREATE TABLE tokens(id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL${patchedTokens ? ", display_name TEXT, avatar TEXT" : ""}, access TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT);
      CREATE TABLE token_events(id TEXT PRIMARY KEY, token_id TEXT NOT NULL REFERENCES tokens(id), action TEXT NOT NULL, page_id TEXT NOT NULL, page_title TEXT NOT NULL, version_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE shares(id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), scope TEXT NOT NULL, page_id TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE requests(user_id TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(user_id,request_id));
      ${patchedQuotas ? "CREATE TABLE site_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);" : ""}
      PRAGMA user_version=1;`);
    db.prepare("INSERT INTO users(id,handle,display_name,password,site_role) VALUES(?,?,?,?,?)")
      .run("u1", "alice", "Alice", "hash", "admin");
  } finally {
    db.close();
  }
};

test("AC-01：version=1 旧库按序迁移到最新版本且数据保留", async () => {
  const dataDir = dir();
  createOldDatabase(dataDir);
  await migrateDatabase(dataDir);
  assert.equal(versionOf(dbPath(dataDir)), LATEST_VERSION);
  assert.deepEqual(["created_at", "storage_limit", "team_creation_limit"].every((c) => columnsOf(dbPath(dataDir), "users").includes(c)), true);
  assert.deepEqual(["display_name", "avatar"].every((c) => columnsOf(dbPath(dataDir), "tokens").includes(c)), true);
  const db = new DatabaseSync(dbPath(dataDir));
  try {
    assert.equal((db.prepare("SELECT handle FROM users WHERE id='u1'").get() as { handle: string }).handle, "alice");
    assert.equal((db.prepare("SELECT value FROM site_settings WHERE key='personalStorageGB'").get() as { value: string }).value, "5");
  } finally { db.close(); }
  assert.equal(snapshots(dataDir).length, 1);
  // Migrated database opens through Store without complaint.
  const store = new Store(dataDir);
  assert.ok(store.one("SELECT id FROM users WHERE id='u1'"));
});

test("遗留库 user_version=0 且已有表：按基线迁移而非误当新库", async () => {
  const dataDir = dir();
  // A database from before the version stamp existed: tables but version 0.
  const db = new DatabaseSync(dbPath(dataDir));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE users(id TEXT PRIMARY KEY, handle TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, password TEXT NOT NULL, site_role TEXT NOT NULL);
    CREATE TABLE sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE files(scope TEXT NOT NULL, path TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(scope,path));`);
  db.prepare("INSERT INTO users VALUES(?,?,?,?,?)").run("u0", "legacy", "Legacy", "h", "admin");
  db.close();
  await migrateDatabase(dataDir);
  assert.equal(versionOf(dbPath(dataDir)), LATEST_VERSION);
  assert.equal(columnsOf(dbPath(dataDir), "users").includes("created_at"), true);
  const store = new Store(dataDir);
  assert.ok(store.one("SELECT id FROM users WHERE id='u0'"));
  assert.equal(snapshots(dataDir).length, 1);
});

test("AC-02：版本一致时不迁移、不产生快照", async () => {
  const dataDir = dir();
  createOldDatabase(dataDir);
  await migrateDatabase(dataDir);
  await migrateDatabase(dataDir);
  assert.equal(versionOf(dbPath(dataDir)), LATEST_VERSION);
  assert.equal(snapshots(dataDir).length, 1);
});

test("AC-03：迁移失败回滚该迁移且版本不涨，快照可用于恢复", async () => {
  const dataDir = dir();
  createOldDatabase(dataDir);
  const broken = [{
    version: 2,
    description: "故意失败的迁移",
    migrate(db: DatabaseSync) {
      db.exec("ALTER TABLE users ADD COLUMN probe TEXT");
      db.exec("ALTER TABLE users ADD COLUMN probe TEXT"); // duplicate column fails
    },
  }];
  await assert.rejects(() => migrateDatabase(dataDir, broken), /迁移 2.*失败/);
  assert.equal(versionOf(dbPath(dataDir)), 1);
  assert.equal(columnsOf(dbPath(dataDir), "users").includes("probe"), false);
  assert.equal(snapshots(dataDir).length, 1);
  // The snapshot restores a working database.
  const snapshotPath = join(dataDir, "update-log", snapshots(dataDir)[0]);
  assert.equal(versionOf(snapshotPath), 1);
});

test("AC-05：迁移链不连续时拒绝启动", async () => {
  const dataDir = dir();
  createOldDatabase(dataDir);
  const gapped = [
    { version: 2, description: "正常", migrate() {} },
    { version: 4, description: "跳号", migrate() {} },
  ];
  await assert.rejects(() => migrateDatabase(dataDir, gapped), /迁移链不完整/);
});

test("AC-04：数据库版本高于代码版本时拒绝", async () => {
  const dataDir = dir();
  createOldDatabase(dataDir);
  const db = new DatabaseSync(dbPath(dataDir));
  db.exec(`PRAGMA user_version=${LATEST_VERSION + 1}`);
  db.close();
  await assert.rejects(() => migrateDatabase(dataDir), /高于本应用支持的版本/);
});

test("AC-06：含既有 ALTER 补丁的旧库迁移幂等", async () => {
  const dataDir = dir();
  createOldDatabase(dataDir, { patchedTokens: true, patchedQuotas: true });
  await migrateDatabase(dataDir);
  assert.equal(versionOf(dbPath(dataDir)), LATEST_VERSION);
  assert.deepEqual(["display_name", "avatar"].every((c) => columnsOf(dbPath(dataDir), "tokens").includes(c)), true);
  assert.deepEqual(["created_at", "storage_limit", "team_creation_limit"].every((c) => columnsOf(dbPath(dataDir), "users").includes(c)), true);
});

test("AC-07：新库不跑迁移，Store 置为最高版本", async () => {
  const dataDir = dir();
  await migrateDatabase(dataDir);
  const store = new Store(dataDir);
  assert.equal(versionOf(dbPath(dataDir)), LATEST_VERSION);
  assert.deepEqual(["created_at", "storage_limit", "team_creation_limit"].every((c) => columnsOf(dbPath(dataDir), "users").includes(c)), true);
  assert.equal((store.one("SELECT value FROM site_settings WHERE key='personalStorageGB'") as { value: string }).value, "5");
});

test("未迁移的旧库构造 Store 被拒绝", () => {
  const dataDir = dir();
  createOldDatabase(dataDir);
  assert.throws(() => new Store(dataDir), /migrateDatabase/);
});
