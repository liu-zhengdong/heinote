import type { DatabaseSync } from "node:sqlite";

/**
 * Trigger-maintained per-scope byte counters (UC-59).
 *
 * Mirrors `Quotas.scopeBytes` exact SQLite `LENGTH(...)` definitions for
 * `records`, `collaboration_documents`, and `collaboration_archives`, so
 * quota checks run in O(scopes) instead of scanning every record row twice
 * per write transaction. Rollbacks unwind trigger updates automatically.
 */
export const SCOPE_USAGE_DDL = `
  CREATE TABLE IF NOT EXISTS scope_usage(
    scope TEXT PRIMARY KEY,
    records_bytes INTEGER NOT NULL DEFAULT 0,
    docs_bytes INTEGER NOT NULL DEFAULT 0,
    archives_bytes INTEGER NOT NULL DEFAULT 0
  );`;

const addBytes = (column: "records_bytes" | "docs_bytes" | "archives_bytes", expr: string, scopeExpr: string) => `
    UPDATE scope_usage SET ${column} = ${column} + COALESCE(${expr}, 0) WHERE scope = ${scopeExpr};
    INSERT INTO scope_usage(scope, ${column}) SELECT ${scopeExpr}, COALESCE(${expr}, 0)
      WHERE NOT EXISTS(SELECT 1 FROM scope_usage WHERE scope = ${scopeExpr});`;

const subBytes = (column: "records_bytes" | "docs_bytes" | "archives_bytes", expr: string, scopeExpr: string) => `
    UPDATE scope_usage SET ${column} = MAX(0, ${column} - COALESCE(${expr}, 0)) WHERE scope = ${scopeExpr};`;

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
    ${addBytes("records_bytes", "LENGTH(NEW.value)", "NEW.scope")}
  END;
  CREATE TRIGGER scope_usage_records_update AFTER UPDATE ON records BEGIN
    ${subBytes("records_bytes", "LENGTH(OLD.value)", "OLD.scope")}
    ${addBytes("records_bytes", "LENGTH(NEW.value)", "NEW.scope")}
  END;
  CREATE TRIGGER scope_usage_records_delete AFTER DELETE ON records BEGIN
    ${subBytes("records_bytes", "LENGTH(OLD.value)", "OLD.scope")}
  END;

  CREATE TRIGGER scope_usage_docs_insert AFTER INSERT ON collaboration_documents BEGIN
    ${addBytes("docs_bytes", "LENGTH(NEW.state)", "NEW.scope")}
  END;
  CREATE TRIGGER scope_usage_docs_update AFTER UPDATE ON collaboration_documents BEGIN
    ${subBytes("docs_bytes", "LENGTH(OLD.state)", "OLD.scope")}
    ${addBytes("docs_bytes", "LENGTH(NEW.state)", "NEW.scope")}
  END;
  CREATE TRIGGER scope_usage_docs_delete AFTER DELETE ON collaboration_documents BEGIN
    ${subBytes("docs_bytes", "LENGTH(OLD.state)", "OLD.scope")}
  END;

  CREATE TRIGGER scope_usage_archives_insert AFTER INSERT ON collaboration_archives BEGIN
    ${addBytes("archives_bytes", "LENGTH(NEW.state)", "NEW.scope")}
  END;
  CREATE TRIGGER scope_usage_archives_update AFTER UPDATE ON collaboration_archives BEGIN
    ${subBytes("archives_bytes", "LENGTH(OLD.state)", "OLD.scope")}
    ${addBytes("archives_bytes", "LENGTH(NEW.state)", "NEW.scope")}
  END;
  CREATE TRIGGER scope_usage_archives_delete AFTER DELETE ON collaboration_archives BEGIN
    ${subBytes("archives_bytes", "LENGTH(OLD.state)", "OLD.scope")}
  END;`;

const hasTable = (db: DatabaseSync, table: string): boolean =>
  Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));

/** Recompute `scope_usage` from scratch from whichever underlying tables exist. */
export function rebuildScopeUsage(db: DatabaseSync): void {
  db.exec(SCOPE_USAGE_DDL);
  db.exec("DELETE FROM scope_usage");
  if (hasTable(db, "records")) {
    db.exec(`
      INSERT INTO scope_usage(scope, records_bytes)
      SELECT scope, COALESCE(SUM(LENGTH(value)), 0) FROM records GROUP BY scope
    `);
  }
  if (hasTable(db, "collaboration_documents")) {
    db.exec(`
      INSERT INTO scope_usage(scope, docs_bytes)
      SELECT scope, COALESCE(SUM(LENGTH(state)), 0) FROM collaboration_documents GROUP BY scope
      ON CONFLICT(scope) DO UPDATE SET docs_bytes = excluded.docs_bytes
    `);
  }
  if (hasTable(db, "collaboration_archives")) {
    db.exec(`
      INSERT INTO scope_usage(scope, archives_bytes)
      SELECT scope, COALESCE(SUM(LENGTH(state)), 0) FROM collaboration_archives GROUP BY scope
      ON CONFLICT(scope) DO UPDATE SET archives_bytes = excluded.archives_bytes
    `);
  }
}
