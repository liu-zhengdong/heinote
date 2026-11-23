import type { DatabaseSync } from "node:sqlite";
import { PURGE_QUEUE_DDL } from "../purge.ts";

/** UC-57: persistent queue for background chunked permanent deletion. */
export default {
  version: 6,
  description: "purge_queue 表：后台分片永久删除子树",
  migrate(db: DatabaseSync) {
    db.exec(PURGE_QUEUE_DDL);
  },
};
