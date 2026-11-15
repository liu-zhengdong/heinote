import type { DatabaseSync } from "node:sqlite";

/** UC-41: agent auth requests. Anonymous agents ask for a token; a logged-in
 *  user approves or denies in the app, and the agent polls for the result.
 *  Rows older than their `expires` no longer accept any action. */
export default {
  version: 4,
  description: "agent_auth_requests 表：Agent 令牌授权请求",
  migrate(db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_auth_requests(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      access TEXT NOT NULL,
      ip TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      user_id TEXT REFERENCES users(id),
      token_id TEXT REFERENCES tokens(id),
      granted_token TEXT,
      created_at TEXT NOT NULL,
      expires INTEGER NOT NULL,
      resolved_at TEXT
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_agent_auth_requests_status ON agent_auth_requests(status)");
  },
};
