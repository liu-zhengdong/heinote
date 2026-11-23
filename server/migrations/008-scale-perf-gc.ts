import type { DatabaseSync } from "node:sqlite";
import { DELTA_TRIGGERS } from "../record-delta.ts";
import { rebuildScopeUsage, SCOPE_USAGE_DDL, SCOPE_USAGE_TRIGGERS } from "../scope-usage.ts";

const hasTable = (db: DatabaseSync, table: string): boolean =>
  Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));

const hasColumn = (db: DatabaseSync, table: string, column: string): boolean =>
  (db.prepare("SELECT name FROM pragma_table_info(?) WHERE name=?").all(table, column) as Array<{ name: string }>).length > 0;

/**
 * UC-59: parent_id index for incremental validation & tree ops, `created_at`
 * timestamps for attachment GC and request TTL pruning, `record_seq.pruned_before`
 * for tombstone compaction, and `scope_usage` trigger-maintained quota counters.
 */
export default {
  version: 8,
  description: "records_parent 索引、scope_usage 配额汇总表与回收元数据列",
  migrate(db: DatabaseSync) {
    if (hasTable(db, "records")) {
      db.exec("CREATE INDEX IF NOT EXISTS records_parent ON records(scope,collection,json_extract(value,'$.parent_id'))");
    }
    if (hasTable(db, "files") && !hasColumn(db, "files", "created_at")) {
      db.exec("ALTER TABLE files ADD COLUMN created_at TEXT");
    }
    if (hasTable(db, "requests") && !hasColumn(db, "requests", "created_at")) {
      db.exec("ALTER TABLE requests ADD COLUMN created_at TEXT");
      db.prepare("UPDATE requests SET created_at=? WHERE created_at IS NULL").run(new Date().toISOString());
    }
    if (hasTable(db, "record_seq") && !hasColumn(db, "record_seq", "pruned_before")) {
      db.exec("ALTER TABLE record_seq ADD COLUMN pruned_before INTEGER NOT NULL DEFAULT 0");
      if (hasTable(db, "records") && hasTable(db, "record_changes")) {
        db.exec(DELTA_TRIGGERS);
      }
    }
    db.exec(SCOPE_USAGE_DDL);
    rebuildScopeUsage(db);
    if (hasTable(db, "records") && hasTable(db, "collaboration_documents") && hasTable(db, "collaboration_archives")) {
      db.exec(SCOPE_USAGE_TRIGGERS);
    }
  },
};
