import type { DatabaseSync } from "node:sqlite";

/**
 * Trigger-maintained per-scope byte counters (UC-59, simplified in UC-60).
 *
 * Tracks `records` bytes in O(scopes) so quota checks never scan the records
 * table. Transient sliding-window logs (`collaboration_ops`, `record_changes`,
 * `requests`) are deliberately excluded so over-quota users can always delete
 * text or blocks to reclaim space (UC-16).
 */
export const SCOPE_USAGE_DDL = `
  CREATE TABLE IF NOT EXISTS scope_usage(
    scope TEXT PRIMARY KEY,
    records_bytes INTEGER NOT NULL DEFAULT 0,
    docs_bytes INTEGER NOT NULL DEFAULT 0,
    archives_bytes INTEGER NOT NULL DEFAULT 0
  );`;

const addBytes = (expr: string, scopeExpr: string) => `
    UPDATE scope_usage SET records_bytes = records_bytes + COALESCE(${expr}, 0) WHERE scope = ${scopeExpr};
    INSERT INTO scope_usage(scope, records_bytes) SELECT ${scopeExpr}, COALESCE(${expr}, 0)
      WHERE NOT EXISTS(SELECT 1 FROM scope_usage WHERE scope = ${scopeExpr});`;

const subBytes = (expr: string, scopeExpr: string) => `
    UPDATE scope_usage SET records_bytes = MAX(0, records_bytes - COALESCE(${expr}, 0)) WHERE scope = ${scopeExpr};`;

export const SCOPE_USAGE_TRIGGERS = `
  DROP TRIGGER IF EXISTS scope_usage_records_insert;
  DROP TRIGGER IF EXISTS scope_usage_records_update;
  DROP TRIGGER IF EXISTS scope_usage_records_delete;
  DROP TRIGGER IF EXISTS scope_usage_docs_insert;
  DROP TRIGGER IF EXISTS scope_usage_docs_update;
  DROP TRIGGER IF EXISTS scope_usage_docs_delete;
  DROP TRIGGER IF EXISTS scope_usage_archives_insert;
  DROP TRIGGER IF EXISTS scope_usage_archives_update;
  DROP TRIGGER IF EXISTS scope_usage_archives_delete;

  CREATE TRIGGER scope_usage_records_insert AFTER INSERT ON records BEGIN
    ${addBytes("LENGTH(NEW.value)", "NEW.scope")}
  END;
  CREATE TRIGGER scope_usage_records_update AFTER UPDATE ON records BEGIN
    ${subBytes("LENGTH(OLD.value)", "OLD.scope")}
    ${addBytes("LENGTH(NEW.value)", "NEW.scope")}
  END;
  CREATE TRIGGER scope_usage_records_delete AFTER DELETE ON records BEGIN
    ${subBytes("LENGTH(OLD.value)", "OLD.scope")}
  END;`;

const hasTable = (db: DatabaseSync, table: string): boolean =>
  Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));

/** Recompute `scope_usage` from scratch from `records`. */
export function rebuildScopeUsage(db: DatabaseSync): void {
  db.exec(SCOPE_USAGE_DDL);
  db.exec("DELETE FROM scope_usage");
  if (hasTable(db, "records")) {
    db.exec(`
      INSERT INTO scope_usage(scope, records_bytes, docs_bytes, archives_bytes)
      SELECT scope, COALESCE(SUM(LENGTH(value)), 0), 0, 0 FROM records GROUP BY scope
    `);
  }
}
