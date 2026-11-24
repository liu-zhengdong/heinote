import type { DatabaseSync } from "node:sqlite";
import { rebuildScopeUsage, SCOPE_USAGE_DDL, SCOPE_USAGE_TRIGGERS } from "../scope-usage.ts";

export const SEMANTIC_COLLAB_DDL = `
  CREATE TABLE IF NOT EXISTS collaboration_pages(
    scope TEXT NOT NULL,
    page_id TEXT NOT NULL,
    epoch TEXT NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0,
    pruned_before INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(scope, page_id)
  );
  CREATE TABLE IF NOT EXISTS collaboration_ops(
    scope TEXT NOT NULL,
    page_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    epoch TEXT NOT NULL,
    request_id TEXT,
    actor_id TEXT,
    ops TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(scope, page_id, seq)
  );
  CREATE INDEX IF NOT EXISTS collaboration_ops_created ON collaboration_ops(scope, page_id, created_at);`;

/**
 * UC-60: replace legacy Yjs binary tables (`collaboration_documents`,
 * `collaboration_archives`, `collaboration_dirty`) and triggers with the
 * single-source-of-truth semantic OT tables (`collaboration_pages`,
 * `collaboration_ops`), and simplify `scope_usage` to track `records_bytes`
 * only so transient op logs never block over-quota deletions (UC-16).
 */
export default {
  version: 9,
  description: "零依赖中心权威语义协作表与单真相配额清理",
  migrate(db: DatabaseSync) {
    db.exec(`
      DROP TRIGGER IF EXISTS collaboration_insert;
      DROP TRIGGER IF EXISTS collaboration_update;
      DROP TRIGGER IF EXISTS collaboration_delete;
      DROP TRIGGER IF EXISTS scope_usage_docs_insert;
      DROP TRIGGER IF EXISTS scope_usage_docs_update;
      DROP TRIGGER IF EXISTS scope_usage_docs_delete;
      DROP TRIGGER IF EXISTS scope_usage_archives_insert;
      DROP TRIGGER IF EXISTS scope_usage_archives_update;
      DROP TRIGGER IF EXISTS scope_usage_archives_delete;
      DROP TABLE IF EXISTS collaboration_documents;
      DROP TABLE IF EXISTS collaboration_archives;
      DROP TABLE IF EXISTS collaboration_dirty;
      ${SEMANTIC_COLLAB_DDL}
      ${SCOPE_USAGE_DDL}
    `);
    rebuildScopeUsage(db);
    const hasRecords = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='records'").get());
    if (hasRecords) {
      db.exec(SCOPE_USAGE_TRIGGERS);
    }
  },
};
