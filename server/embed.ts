import type { Express, Request, Response } from "express";
import { fail, hash, secret, Store, type Actor, type User } from "./store.ts";
import { tokenAvatarUrl } from "./token-identity.ts";

/** UC-58: workbench iframe embed sessions.
 *
 *  An Agent token carrying `embed` can mint a one-shot ticket; an iframe
 *  navigates to the redeem URL, which verifies the real parent origin against
 *  the origin declared at mint, plants a cross-site session cookie and lands
 *  on the app shell. The session stays pinned to that origin: only responses
 *  to requests holding it drop X-Frame-Options and emit CSP frame-ancestors
 *  for that origin — everything else keeps DENY. */

export const EMBED_COOKIE = "notes_embed";
const TICKET_TTL = 60_000;
const SESSION_TTL = 30 * 86400000;

export interface EmbedSession {
  user: User;
  tokenId: string;
  tokenAccess: "read" | "write";
  displayName?: string;
  avatar?: string;
  embedOrigin: string;
  /** sessions.hash for the row backing this session. */
  key: string;
}

interface Ticket {
  tokenId: string;
  userId: string;
  origin: string;
  expires: number;
}

const text = (value: unknown) => typeof value === "string" ? value : "";

const cookieValue = (req: Request) => /(?:^|;\s*)notes_embed=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];

/** An origin is exactly scheme://host[:port] — no path, no credentials. */
export const normalizeOrigin = (value: unknown): string | undefined => {
  const raw = text(value).trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
};

const setEmbedCookie = (res: Response, value: string, maxAge: number) =>
  res.setHeader("Set-Cookie", `${EMBED_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${maxAge}`);

export const clearEmbedCookie = (res: Response) => setEmbedCookie(res, "", 0);

export function createEmbed(store: Store, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const tickets = new Map<string, Ticket>();
  /** Session lookups run once per request; the header middleware and the
   *  actor both ask for the same session. */
  const cache = new WeakMap<Request, EmbedSession | null>();

  /** Uncached DB lookup by hashed embed session cookie — used by WebSocket
   *  revalidation so revoking a token or disabling `embed` takes effect
   *  immediately instead of hitting the per-Request WeakMap cache (UC-60 H5). */
  const resolveByHash = (key: string): EmbedSession | undefined => {
    if (!key) return undefined;
    const row = store.one(
      `SELECT u.*, s.expires AS session_expires, s.embed_origin, t.id AS token_id,
         t.access AS token_access, t.display_name AS token_display_name,
         t.avatar AS token_avatar, t.embed AS token_embed
       FROM sessions s JOIN tokens t ON t.id = s.token_id JOIN users u ON u.id = s.user_id
       WHERE s.hash = ? AND s.token_id IS NOT NULL`, key);
    if (!row || Number(row.session_expires) <= now() || Number(row.token_embed) !== 1) return undefined;
    const tokenId = String(row.token_id);
    const avatar = row.token_avatar == null ? undefined : tokenAvatarUrl(tokenId, String(row.token_avatar)) ?? String(row.token_avatar);
    return {
      user: store.user(row), tokenId,
      tokenAccess: row.token_access as "read" | "write",
      displayName: row.token_display_name == null ? undefined : String(row.token_display_name),
      avatar, embedOrigin: String(row.embed_origin), key,
    };
  };

  const resolve = (req: Request): EmbedSession | undefined => {
    if (cache.has(req)) return cache.get(req) ?? undefined;
    const value = cookieValue(req);
    const session = value ? (resolveByHash(hash(value)) ?? null) : null;
    cache.set(req, session);
    return session ?? undefined;
  };

  /** Embed sessions act with token identity — the same boundary the token
   *  contract states for /api/v1, expressed for the browser API: content
   *  reads stay open, writes whitelist the browser content surface only
   *  (records, attachments, proposal handling, presence, logout). Anything
   *  else — minting tokens, sharing pages publicly, auth, account, member,
   *  space and admin management — is closed, because tokenAccess gating
   *  only lives in store.scope and would not stop a read token's session
   *  from minting a write token or publishing a page. */
  const scopeDenied = (path: string, method: string): boolean => {
    /* The redeem endpoint must answer even while an older embed session is
       still alive (the plugin may re-navigate the frame). Everything else
       under /api/v1 is closed: the session is not a second channel to the
       content API — it could mint tickets at will. */
    if (path === "/api/v1/embed/session") return false;
    if (path.startsWith("/api/v1/")) return true;
    if (["GET", "HEAD", "OPTIONS"].includes(method)) {
      /* Management reads are closed too; token avatars stay open because
         the app renders them anywhere a token-authored page appears. */
      if (path === "/api/tokens" || path.startsWith("/api/tokens/"))
        return !/^\/api\/tokens\/[^/]+\/avatar\//.test(path);
      return path.startsWith("/api/admin") || path.startsWith("/api/auth/") ||
             path.startsWith("/api/account") || path.startsWith("/api/knowledge-bases");
    }
    return !(
      path === "/api/auth/logout" ||
      path === "/api/records/batch" ||
      path.startsWith("/api/records/") ||
      path.startsWith("/api/files/") ||
      /^\/api\/proposals\/[^/]+\/(apply|reject)$/.test(path) ||
      /^\/api\/spaces\/[^/]+\/presence$/.test(path)
    );
  };

  const actorFor = (req: Request): Actor | undefined => {
    const session = resolve(req);
    if (!session) return undefined;
    if (scopeDenied(req.path, req.method)) fail(403, "嵌入会话不可访问账号管理。", "forbidden");
    store.db.prepare("UPDATE tokens SET last_used_at=? WHERE id=?").run(new Date().toISOString(), session.tokenId);
    return {
      user: session.user, tokenId: session.tokenId, tokenAccess: session.tokenAccess,
      displayName: session.displayName, avatar: session.avatar,
    };
  };

  const attach = (app: Express, actor: (req: Request) => Actor) => {
    app.post("/api/v1/embed/tickets", (req, res) => {
      const who = actor(req);
      if (!who.tokenId) fail(403, "需要 Agent 令牌。", "forbidden");
      const row = store.one("SELECT embed FROM tokens WHERE id=?", who.tokenId);
      if (!row || Number(row.embed) !== 1) fail(403, "此令牌未开启嵌入。", "forbidden");
      const headerOrigin = normalizeOrigin(req.get("origin"));
      let bodyOrigin: string | undefined;
      if (req.body && typeof req.body === "object" && "origin" in (req.body as Record<string, unknown>)) {
        bodyOrigin = normalizeOrigin((req.body as Record<string, unknown>).origin);
        if (!bodyOrigin) fail(400, "origin 必须是合法的 http(s) 源。", "bad_request");
      }
      if (headerOrigin && bodyOrigin && headerOrigin !== bodyOrigin) fail(400, "origin 与请求来源不一致。", "bad_request");
      const origin = headerOrigin ?? bodyOrigin;
      if (!origin) fail(400, "无法确定父页面来源：请携带 Origin 头或 origin 参数。", "bad_request");
      for (const [key, ticket] of tickets) if (ticket.expires <= now()) tickets.delete(key);
      if (tickets.size >= 1000) fail(429, "票据请求过多，请稍后重试。");
      const ticket = secret();
      tickets.set(hash(ticket), { tokenId: who.tokenId, userId: who.user.id, origin, expires: now() + TICKET_TTL });
      res.status(201).json({ ticket, expiresAt: new Date(now() + TICKET_TTL).toISOString() });
    });

    app.get("/api/v1/embed/session", (req, res) => {
      const key = hash(text(req.query.t));
      const ticket = tickets.get(key);
      // One shot regardless of outcome: a leaked or stale ticket never replays.
      if (ticket) tickets.delete(key);
      if (!ticket || ticket.expires <= now()) fail(401, "嵌入票据无效或已过期。", "unauthorized");
      /* Only an iframe may redeem. A top-level navigation would plant a
         logged-in cookie outside the frame — session fixation. */
      if (req.get("sec-fetch-dest") !== "iframe") fail(403, "嵌入会话只能在 iframe 中建立。", "forbidden");
      /* The real navigation origin is the document that hosts the frame:
         Referer first (always sent), Origin for transports that send it. */
      const navOrigin = normalizeOrigin(req.get("referer")) ?? normalizeOrigin(req.get("origin"));
      if (!navOrigin || navOrigin !== ticket.origin) fail(403, "嵌入来源与授权来源不一致。", "forbidden");
      const token = store.one("SELECT embed FROM tokens WHERE id=?", ticket.tokenId);
      if (!token || Number(token.embed) !== 1) fail(401, "令牌已失效。", "unauthorized");
      const session = secret();
      store.transaction(() => {
        store.db.prepare("DELETE FROM sessions WHERE token_id=? AND embed_origin IS NOT NULL").run(ticket.tokenId);
        store.db.prepare("INSERT INTO sessions(hash,user_id,expires,token_id,embed_origin) VALUES(?,?,?,?,?)")
          .run(hash(session), ticket.userId, now() + SESSION_TTL, ticket.tokenId, ticket.origin);
        store.collaboration.notifyPermissionChange({ tokenId: ticket.tokenId });
      });
      /* Browsers evaluate frame-ancestors/XFO per hop of a redirect; carry
         the allow-list on the 302 itself instead of relying on the target. */
      res.removeHeader("X-Frame-Options");
      res.setHeader("Content-Security-Policy", `frame-ancestors 'self' ${ticket.origin}`);
      setEmbedCookie(res, session, SESSION_TTL / 1000);
      res.redirect("/");
    });
  };

  return {
    /** The valid embed session behind this request, if any. */
    resolve,
    /** Uncached lookup by hashed session token for WebSocket permission rechecks. */
    resolveByHash,
    /** Extract raw embed session cookie hash from a Cookie header. */
    cookieHash: (cookieHeader?: string) => {
      const value = /(?:^|;\s*)notes_embed=([^;]+)/.exec(cookieHeader ?? "")?.[1];
      return value ? hash(value) : undefined;
    },
    /** Actor for an embed session, enforcing the token-identity boundary. */
    actorFor,
    /** Parent origin this request's embed session is pinned to, for headers. */
    frameOrigin: (req: Request) => resolve(req)?.embedOrigin,
    /** True when an embed session reaches a path outside its scope. Mounted
        under /api so the path argument is the mount-relative path. */
    denied: (relPath: string, method: string) => scopeDenied(`/api${relPath}`, method),
    attach,
  };
}
