import type { Express, Request } from "express";
import { z } from "zod";
import type { Actor, Row, Store } from "./store.ts";
import { fail, hash, id, secret } from "./store.ts";

/** UC-41: an anonymous agent asks for a token. The site's logged-in user sees
 *  the request in the app and approves or denies it; the agent polls its own
 *  request URL and gets the bearer token back exactly once, on approval.
 *
 *  Requests carry no target user: the requester cannot name one, and on this
 *  single-occupant install the approver is the only logged-in user anyway —
 *  approval binds the minted token to the approver's account.
 *
 *  The requester is anonymous, so creation is rate-limited in two places:
 *  per-source-IP creates (in-memory, per process) and a global ceiling on
 *  rows still pending. Expired rows are judged at read time, never swept. */

const REQUEST_TTL_MS = 10 * 60 * 1000;
const CREATE_WINDOW_MS = 10 * 60 * 1000;
const CREATE_PER_IP = 10;
const MAX_PENDING = 50;

const requestBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  access: z.enum(["read", "write"]).default("write"),
}).strict();

const windowFor = (log: Map<string, number[]>, ip: string, now: number): number[] => {
  const kept = (log.get(ip) ?? []).filter((at) => now - at < CREATE_WINDOW_MS);
  log.set(ip, kept);
  return kept;
};

const sourceIp = (req: Request): string => String(req.ip ?? req.socket.remoteAddress ?? "");

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) fail(400, result.error.issues[0]?.message ?? "请求参数无效。", "bad_request");
  return result.data;
};

const now = () => new Date().toISOString();

interface AuthRequestRow extends Row {
  id: string; name: string; access: string; ip: string;
  status: "pending" | "approved" | "denied";
  user_id: string | null; token_id: string | null; granted_token: string | null;
  created_at: string; expires: number; resolved_at: string | null;
}

type Status = "pending" | "approved" | "denied" | "expired";

const statusOf = (row: AuthRequestRow): Status =>
  row.status === "pending" && row.expires <= Date.now() ? "expired" : row.status;

/** DTO for the requester: never carries the token beyond the one-time grant. */
const agentDto = (row: AuthRequestRow, includeToken: boolean) => ({
  id: String(row.id),
  status: statusOf(row),
  name: String(row.name),
  access: String(row.access),
  createdAt: String(row.created_at),
  expiresAt: new Date(Number(row.expires)).toISOString(),
  ...(includeToken && row.granted_token ? { token: String(row.granted_token) } : {}),
});

/** DTO for the approver: who claims to be asking, where from, and a handle. */
const pendingDto = (row: AuthRequestRow) => ({
  id: String(row.id),
  name: String(row.name),
  access: String(row.access),
  ip: String(row.ip),
  createdAt: String(row.created_at),
  expiresAt: new Date(Number(row.expires)).toISOString(),
});

/** What a subscribed socket needs right now: that user's actionable rows. */
export const pendingAuthRequests = (store: Store, userId: string) =>
  (store.all(
    "SELECT * FROM agent_auth_requests WHERE status='pending' AND user_id=? AND expires>? ORDER BY created_at",
    userId, Date.now(),
  ) as AuthRequestRow[]).map(pendingDto);

export function attachAgentAuthRequests(
  app: Express,
  store: Store,
  actor: (req: Request) => Actor,
  broadcastPending: (userId: string) => void,
  ttlMs: number = REQUEST_TTL_MS,
): void {

  /** Agent-facing. Anonymous: the requester holds no credentials by design. */
  const createLog = new Map<string, number[]>();
  app.post("/api/v1/auth/requests", (req, res) => {
    const input = parse(requestBodySchema, req.body);
    const ip = sourceIp(req);
    if (windowFor(createLog, ip, Date.now()).length >= CREATE_PER_IP) fail(429, "请求过于频繁，请稍后再试。", "rate_limited");

    const row = store.one(
      "SELECT COUNT(*) AS n FROM agent_auth_requests WHERE status='pending' AND expires>?",
      Date.now(),
    );
    if (Number(row?.n ?? 0) >= MAX_PENDING) fail(429, "待处理的请求过多，请稍后再试。", "rate_limited");

    const requestId = id();
    const expires = Date.now() + ttlMs;
    store.db.prepare(
      "INSERT INTO agent_auth_requests(id,name,access,ip,status,created_at,expires) VALUES(?,?,?,?,'pending',?,?)",
    ).run(requestId, input.name, input.access, ip, now(), expires);
    windowFor(createLog, ip, Date.now()).push(Date.now());
    // No broadcast: the request is anonymous and user-unbound until someone
    // opens its verificationUrl. There is nobody to notify yet.
    const base = `${req.protocol}://${req.get("host")}`;
    res.status(201).json({
      id: requestId,
      status: "pending",
      verificationUrl: `${base}/?auth_request=${requestId}`,
      expiresAt: new Date(expires).toISOString(),
    });
  });

  /** Agent-facing. First response after approval hands back the token once;
   *  later reads (and any other reader) only ever see the status. */
  app.get("/api/v1/auth/requests/:id", (req, res) => {
    const row = store.one("SELECT * FROM agent_auth_requests WHERE id=?", String(req.params.id)) as AuthRequestRow | undefined;
    if (!row) fail(404, "请求不存在。", "not_found");
    const fresh = row.status === "approved" && row.granted_token;
    if (fresh) store.db.prepare("UPDATE agent_auth_requests SET granted_token=NULL WHERE id=?").run(row.id);
    res.json(agentDto(row, Boolean(fresh)));
  });

  /** User-facing: the calling user's own pending requests (bound ones). */
  app.get("/api/auth/requests", (req, res) => {
    const who = actor(req);
    res.json({ requests: pendingAuthRequests(store, who.user.id) });
  });

  /** Claim-on-open: the logged-in user opening a request's link binds it to
   *  their account — this is how an anonymous request finds its approver. */
  const claim = (who: Actor, row: AuthRequestRow) => {
    if (row.user_id === who.user.id) return;
    if (row.user_id !== null) fail(404, "请求不存在。", "not_found"); // bound to someone else
    store.db.prepare("UPDATE agent_auth_requests SET user_id=? WHERE id=?").run(who.user.id, row.id);
    row.user_id = who.user.id;
  };

  const resolve = (req: Request, approve: boolean) => {
    const who = actor(req);
    const row = store.one("SELECT * FROM agent_auth_requests WHERE id=?", String(req.params.id)) as AuthRequestRow | undefined;
    if (!row) fail(404, "请求不存在。", "not_found");
    claim(who, row);
    if (statusOf(row) === "expired") fail(410, "请求已过期。", "gone");
    if (row.status !== "pending") fail(409, "请求已被处理。", "conflict");

    if (!approve) {
      store.db.prepare("UPDATE agent_auth_requests SET status='denied',resolved_at=? WHERE id=?")
        .run(now(), row.id);
      broadcastPending(who.user.id);
      return { status: "denied" };
    }

    return store.transaction(() => {
      // A second approve on the same row must hit the conflict above, so the
      // transaction also re-reads before minting — no double grant.
      const again = store.one("SELECT * FROM agent_auth_requests WHERE id=?", row.id) as AuthRequestRow | undefined;
      if (!again || again.status !== "pending") fail(409, "请求已被处理。", "conflict");
      const tokenId = id();
      const token = `notes_${secret()}`;
      store.db.prepare("INSERT INTO tokens(id,hash,user_id,name,display_name,access,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(tokenId, hash(token), who.user.id, row.name, row.name, row.access, now());
      store.db.prepare("UPDATE agent_auth_requests SET status='approved',user_id=?,token_id=?,granted_token=?,resolved_at=? WHERE id=?")
        .run(who.user.id, tokenId, token, now(), row.id);
      return { status: "approved", tokenId };
    });
  };

  /** User-facing: opening a request's verificationUrl claims it for the
   *  logged-in user and returns the pending details for the confirm page.
   *  Binding is the side effect; approve/deny still do their own claim. */
  app.post("/api/auth/requests/:id/claim", (req, res) => {
    const who = actor(req);
    const row = store.one("SELECT * FROM agent_auth_requests WHERE id=?", String(req.params.id)) as AuthRequestRow | undefined;
    if (!row) fail(404, "请求不存在。", "not_found");
    claim(who, row);
    broadcastPending(who.user.id);
    res.json({ request: pendingDto(row), status: statusOf(row) });
  });

  app.post("/api/auth/requests/:id/approve", (req, res) => {
    const who = actor(req);
    const result = resolve(req, true);
    broadcastPending(who.user.id);
    res.json(result);
  });

  app.post("/api/auth/requests/:id/deny", (req, res) => {
    const result = resolve(req, false);
    res.json(result);
  });
}
