import type { DatabaseSync } from "node:sqlite";

const hasTable = (db: DatabaseSync, table: string): boolean =>
  Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));

const hasColumn = (db: DatabaseSync, table: string, column: string): boolean =>
  (db.prepare(`SELECT name FROM pragma_table_info(?) WHERE name=?`).all(table, column) as Array<{ name: string }>).length > 0;

/** UC-58: workbench iframe embed sessions. A token gains an `embed` flag that
 *  authorizes exchanging it for a browser session pinned to a reported parent
 *  origin; session rows carrying token_id/embed_origin are that session.
 *  Legacy minimal databases may lack either table: Store's baseline CREATE
 *  already carries every column, so absence means nothing to do here. */
export default {
  version: 7,
  description: "tokens.embed 嵌入能力位与 sessions 的嵌入会话字段",
  migrate(db: DatabaseSync) {
    if (hasTable(db, "tokens") && !hasColumn(db, "tokens", "embed"))
      db.exec("ALTER TABLE tokens ADD COLUMN embed INTEGER NOT NULL DEFAULT 0");
    if (hasTable(db, "sessions")) {
      if (!hasColumn(db, "sessions", "token_id"))
        db.exec("ALTER TABLE sessions ADD COLUMN token_id TEXT");
      if (!hasColumn(db, "sessions", "embed_origin"))
        db.exec("ALTER TABLE sessions ADD COLUMN embed_origin TEXT");
    }
  },
};
