import type { DatabaseSync } from "node:sqlite";

const hasTable = (db: DatabaseSync, table: string): boolean =>
  Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));

const hasColumn = (db: DatabaseSync, table: string, column: string): boolean =>
  (db.prepare(`SELECT name FROM pragma_table_info(?) WHERE name=?`).all(table, column) as Array<{ name: string }>).length > 0;

/**
 * UC-27 token identity columns. Old databases gained these through an ad-hoc
 * ALTER patch in Store; the checks keep this migration idempotent there.
 * Legacy minimal databases may lack tokens entirely: Store's baseline CREATE
 * carries the columns, so the table's absence means nothing to do here.
 */
export default {
  version: 2,
  description: "tokens 增加 display_name 与 avatar 列",
  migrate(db: DatabaseSync) {
    if (!hasTable(db, "tokens")) return;
    for (const column of ["display_name", "avatar"]) {
      if (!hasColumn(db, "tokens", column))
        db.exec(`ALTER TABLE tokens ADD COLUMN ${column} TEXT`);
    }
  },
};
