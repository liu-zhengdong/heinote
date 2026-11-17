import type { DatabaseSync } from "node:sqlite";
import { DELTA_DDL, DELTA_TRIGGERS } from "../record-delta.ts";

/** ISS-12: record changelog for incremental collection sync. Existing rows
 *  get no changelog entries — a client pulling with after=0 receives the
 *  full collection plus the current watermark, and every later write lands
 *  in `record_changes` by trigger. */
export default {
  version: 5,
  description: "record_seq/record_changes 表与触发器：集合增量同步",
  migrate(db: DatabaseSync) {
    // Databases from before records existed lack the table; the store's
    // DDL would create it anyway, so bring it up here before the triggers.
    db.exec(`CREATE TABLE IF NOT EXISTS records(scope TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope,collection,id));
      CREATE INDEX IF NOT EXISTS records_page ON records(scope,collection,json_extract(value,'$.page'));`);
    db.exec(DELTA_DDL);
    db.exec(DELTA_TRIGGERS);
  },
};
