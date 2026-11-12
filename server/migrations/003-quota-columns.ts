import type { DatabaseSync } from "node:sqlite";

const hasColumn = (db: DatabaseSync, table: string, column: string): boolean =>
  (db.prepare(`SELECT name FROM pragma_table_info(?) WHERE name=?`).all(table, column) as Array<{ name: string }>).length > 0;

const hasTable = (db: DatabaseSync, table: string): boolean =>
  Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));

/**
 * UC-16 quota columns and the site_settings table. Databases predating
 * knowledge bases lack that table at this point; KnowledgeBases creates it
 * (with storage_limit) later, so the column is only added when the table is
 * already present — matching the removed quotas.ts patch.
 */
export default {
  version: 3,
  description: "users/knowledge_bases 限额列与 site_settings 默认值",
  migrate(db: DatabaseSync) {
    const addColumn = (table: string, column: string, type: string) => {
      if (!hasColumn(db, table, column))
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    };
    addColumn("users", "created_at", "TEXT");
    addColumn("users", "storage_limit", "INTEGER");
    addColumn("users", "team_creation_limit", "INTEGER");
    if (hasTable(db, "knowledge_bases")) addColumn("knowledge_bases", "storage_limit", "INTEGER");
    db.exec("CREATE TABLE IF NOT EXISTS site_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    // Keys must stay in sync with server/quotas.ts KEYS.
    for (const [key, value] of [
      ["personalStorageGB", "5"],
      ["teamStorageGB", "10"],
      ["teamCreation", "5"],
    ] as const) db.prepare("INSERT OR IGNORE INTO site_settings VALUES(?,?)").run(key, value);
  },
};
