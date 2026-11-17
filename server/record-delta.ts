/** Incremental record sync (ISS-12): a changelog on `records`, kept by
 *  triggers so every write path counts — app writes, the import worker,
 *  migrations. Each (scope,collection) has a watermark in `record_seq`;
 *  `record_changes` holds the latest seq of each touched row (and deleted
 *  rows, since `records` itself no longer has them). A client polls with
 *  its watermark and receives only what changed.
 *
 *  Trigger bodies deliberately avoid UPSERT and OR REPLACE entirely: when
 *  the firing statement is itself an UPSERT (Store.put is), SQLite ignores
 *  conflict-resolution clauses inside trigger bodies and would raise
 *  UNIQUE constraint errors instead. UPDATE + INSERT WHERE NOT EXISTS is
 *  the conflict-clause-free equivalent. */

export const DELTA_DDL = `
  CREATE TABLE IF NOT EXISTS record_seq(scope TEXT NOT NULL, collection TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(scope,collection));
  CREATE TABLE IF NOT EXISTS record_changes(scope TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope,collection,id));
  CREATE INDEX IF NOT EXISTS record_changes_seq ON record_changes(scope,collection,seq);`;

const BUMP = (alias: string) => `
    UPDATE record_seq SET seq=seq+1 WHERE scope=${alias}.scope AND collection=${alias}.collection;
    INSERT INTO record_seq SELECT ${alias}.scope,${alias}.collection,1
      WHERE NOT EXISTS(SELECT 1 FROM record_seq WHERE scope=${alias}.scope AND collection=${alias}.collection);`;

const CHANGELOG = (alias: string, deleted: number) => `
    UPDATE record_changes SET seq=(SELECT seq FROM record_seq WHERE scope=${alias}.scope AND collection=${alias}.collection), deleted=${deleted}
      WHERE scope=${alias}.scope AND collection=${alias}.collection AND id=${alias}.id;
    INSERT INTO record_changes SELECT ${alias}.scope,${alias}.collection,${alias}.id,(SELECT seq FROM record_seq WHERE scope=${alias}.scope AND collection=${alias}.collection),${deleted}
      WHERE NOT EXISTS(SELECT 1 FROM record_changes WHERE scope=${alias}.scope AND collection=${alias}.collection AND id=${alias}.id);`;

export const DELTA_TRIGGERS = `
  CREATE TRIGGER IF NOT EXISTS record_seq_insert AFTER INSERT ON records BEGIN
    ${BUMP("NEW")}
    ${CHANGELOG("NEW", 0)}
  END;
  CREATE TRIGGER IF NOT EXISTS record_seq_update AFTER UPDATE ON records BEGIN
    ${BUMP("NEW")}
    ${CHANGELOG("NEW", 0)}
  END;
  CREATE TRIGGER IF NOT EXISTS record_seq_delete AFTER DELETE ON records BEGIN
    ${BUMP("OLD")}
    ${CHANGELOG("OLD", 1)}
  END;`;
