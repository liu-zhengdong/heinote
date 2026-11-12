import type { Express, Request, Response } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Store, HttpError, hash, id, secret, type User } from "./store.ts";
import { githubMessages, type GithubResult, type GithubStatus } from "../src/core/github-auth.ts";

export interface GithubConfig {
  clientId: string;
  clientSecret: string;
  publicUrl?: string;
  /** Only explicit server callers can replace GitHub for acceptance tests. */
  endpoints?: { authorize: string; token: string; user: string };
  now?: () => number;
}

interface Context {
  store: Store;
  config: GithubConfig | null;
  secure: boolean;
  session(req: Request): { user: User | undefined; key: string | undefined };
  establish(req: Request, res: Response, userId: string): void;
  registrationAllowed(): boolean;
}
interface Profile { id: string; login: string; displayName: string }
interface BoundRequest {
  browserHash: string;
  sessionKey: string | undefined;
  userId: string | undefined;
  expires: number;
}
type Flow = BoundRequest & (
  { stage: "authorize"; purpose: "login" | "bind"; verifier: string; redirectUri: string }
  | { stage: "signup"; profile: Profile }
);

class GithubFailure extends HttpError {
  constructor(readonly result: GithubResult, status = 400) { super(status, githubMessages[result], result); }
}
function fail(result: GithubResult, status = 400): never { throw new GithubFailure(result, status); }
const lifetime = 10 * 60 * 1000;
const browserCookie = "notes_github_browser";
const endpoints = {
  authorize: "https://github.com/login/oauth/authorize",
  token: "https://github.com/login/oauth/access_token",
  user: "https://api.github.com/user",
};
const cookieValue = (req: Request) => /(?:^|;\s*)notes_github_browser=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie ?? "")?.[1];
const string = (value: unknown) => typeof value === "string" ? value : "";

export function githubConfigFromEnvironment(): GithubConfig | null {
  const clientId = process.env.GITHUB_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim() ?? "";
  if (!clientId && !clientSecret) return null;
  const publicUrl = process.env.PUBLIC_URL?.trim() ?? "";
  const missing = [!clientId && "GITHUB_CLIENT_ID", !clientSecret && "GITHUB_CLIENT_SECRET", !publicUrl && "PUBLIC_URL"].filter(Boolean);
  if (missing.length) throw new Error(`GitHub 登录缺少配置：${missing.join("、")}`);
  let url: URL;
  try { url = new URL(publicUrl); } catch { throw new Error("GitHub 登录的 PUBLIC_URL 必须是完整 HTTP 或 HTTPS 源。"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("GitHub 登录的 PUBLIC_URL 只能包含协议、主机与端口。");
  }
  return { clientId, clientSecret, publicUrl: url.origin };
}

/** Own the GitHub protocol, transient requests, and account associations. */
export function attachGithubAuth(app: Express, ctx: Context) {
  const { store, config } = ctx;
  const enabled = Boolean(config);
  const urls = config?.endpoints ?? endpoints;
  const now = config?.now ?? Date.now;
  const flows = new Map<string, Flow>();
  store.db.exec(`CREATE TABLE IF NOT EXISTS oauth_identities(
    provider TEXT NOT NULL, provider_user_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id), login TEXT NOT NULL,
    PRIMARY KEY(provider,provider_user_id), UNIQUE(user_id,provider));`);

  const requireConfig = () => { if (!config) fail("disabled", 503); return config; };
  const origin = (req: Request) => config?.publicUrl ?? `${req.protocol}://${req.get("host")}`;
  const requireUser = (req: Request) => {
    if (req.headers.authorization) throw new HttpError(403, "登录方式使用浏览器会话。");
    const user = ctx.session(req).user;
    if (!user) throw new HttpError(401, "请先登录。", "unauthorized");
    return user;
  };
  const checkOrigin = (req: Request) => {
    if (req.get("sec-fetch-site") === "cross-site") throw new HttpError(403, "请求来源无效。");
    for (const value of [req.get("origin"), req.get("referer")]) {
      if (!value) continue;
      try { if (new URL(value).origin === new URL(origin(req)).origin) continue; } catch { /* Reject malformed origins. */ }
      throw new HttpError(403, "请求来源无效。");
    }
  };
  const sameSession = (req: Request, flow: BoundRequest) => {
    const session = ctx.session(req);
    if (session.key !== flow.sessionKey || session.user?.id !== flow.userId) fail("session_changed", 409);
  };
  const remember = (flow: Flow) => {
    for (const [key, previous] of flows) if (previous.expires <= now()) flows.delete(key);
    if (flows.size >= 1000) throw new HttpError(429, "授权请求过多，请稍后重试。");
    const token = secret(); flows.set(hash(token), flow); return token;
  };
  const read = <T extends Flow["stage"]>(req: Request, token: string, stage: T, consume: boolean): Extract<Flow, { stage: T }> => {
    const key = hash(token);
    const flow = flows.get(key);
    const browser = cookieValue(req);
    if (!flow || flow.stage !== stage || !browser || flow.browserHash !== hash(browser)) fail("invalid_request");
    if (flow.expires <= now()) { flows.delete(key); fail("invalid_request"); }
    sameSession(req, flow);
    // Validation and consumption are synchronous, before any provider request.
    if (consume) flows.delete(key);
    return flow as Extract<Flow, { stage: T }>;
  };
  const start = (req: Request, res: Response, purpose: "login" | "bind") => {
    const settings = requireConfig(); checkOrigin(req);
    const session = ctx.session(req);
    if (purpose === "bind") requireUser(req);
    else if (session.user || req.headers.authorization) fail("session_changed", 409);
    const browser = cookieValue(req) ?? secret();
    const verifier = secret();
    const redirectUri = new URL("/api/auth/github/callback", origin(req)).href;
    const state = remember({ stage: "authorize", purpose, verifier, redirectUri, browserHash: hash(browser), sessionKey: session.key, userId: session.user?.id, expires: now() + lifetime });
    res.cookie(browserCookie, browser, { httpOnly: true, sameSite: "lax", secure: ctx.secure, maxAge: lifetime, path: "/api/auth/github" });
    const url = new URL(urls.authorize);
    url.search = new URLSearchParams({ client_id: settings.clientId, redirect_uri: redirectUri, state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", scope: "" }).toString();
    return url.href;
  };
  const json = async (url: string, init: RequestInit) => {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000), redirect: "error" });
      if (!response.ok) fail("unavailable", 502);
      return await response.json() as unknown;
    } catch { return fail("unavailable", 502); }
  };
  const profile = async (code: string, flow: Extract<Flow, { stage: "authorize" }>): Promise<Profile> => {
    const settings = requireConfig();
    const token = z.object({ access_token: z.string().min(1) }).safeParse(await json(urls.token, {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: settings.clientId, client_secret: settings.clientSecret, code,
        redirect_uri: flow.redirectUri, code_verifier: flow.verifier }),
    }));
    if (!token.success) fail("unavailable", 502);
    const parsed = z.object({ id: z.number().int().positive().safe(), login: z.string().min(1).max(100), name: z.string().nullable().optional() }).safeParse(await json(urls.user, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token.data.access_token}`, "User-Agent": "HeiNote" },
    }));
    if (!parsed.success) fail("unavailable", 502);
    return { id: String(parsed.data.id), login: parsed.data.login, displayName: (parsed.data.name?.trim() || parsed.data.login).slice(0, 100) };
  };
  const identity = (profile: Profile) => store.one("SELECT * FROM oauth_identities WHERE provider='github' AND provider_user_id=?", profile.id);
  const updateLogin = (profile: Profile) => store.db.prepare("UPDATE oauth_identities SET login=? WHERE provider='github' AND provider_user_id=?").run(profile.login, profile.id);
  const link = (userId: string, profile: Profile) => store.transaction(() => {
    const linked = identity(profile);
    if (linked && linked.user_id !== userId) fail("identity_in_use", 409);
    const previous = store.one("SELECT * FROM oauth_identities WHERE provider='github' AND user_id=?", userId);
    if (previous && previous.provider_user_id !== profile.id) fail("already_linked", 409);
    if (!linked) store.db.prepare("INSERT INTO oauth_identities VALUES('github',?,?,?)").run(profile.id, userId, profile.login);
    else updateLogin(profile);
  });
  // Both automatic registration and confirmed signup use this transaction.
  const loginAccount = (profile: Profile, confirmed: boolean): { userId: string; created: boolean } | null => store.transaction(() => {
    const linked = identity(profile);
    if (linked) { updateLogin(profile); return { userId: String(linked.user_id), created: false }; }
    if (!ctx.registrationAllowed()) fail("registration_closed", 403);
    let base = profile.login.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 40);
    if (base.length < 2) base = `gh-${base || profile.id}`.slice(0, 40);
    const collision = store.one("SELECT id FROM users WHERE handle=?", base);
    if (collision && !confirmed) return null;
    let handle = base;
    for (let suffix = 2; store.one("SELECT id FROM users WHERE handle=?", handle); suffix++) {
      const ending = `-${suffix}`; handle = base.slice(0, 40 - ending.length) + ending;
    }
    const userId = id();
    const role = store.one("SELECT id FROM users LIMIT 1") ? "user" : "admin";
    // Empty password means this account has no password credential.
    store.db.prepare("INSERT INTO users(id,handle,display_name,password,site_role,created_at) VALUES(?,?,?,?,?,?)").run(userId, handle, profile.displayName, "", role, new Date().toISOString());
    store.db.prepare("INSERT INTO oauth_identities VALUES('github',?,?,?)").run(profile.id, userId, profile.login);
    return { userId, created: true };
  });
  const status = (userId: string): GithubStatus => {
    const row = store.one("SELECT password FROM users WHERE id=?", userId);
    const linked = store.one("SELECT provider_user_id,login FROM oauth_identities WHERE provider='github' AND user_id=?", userId);
    const hasPassword = Boolean(row?.password);
    return { enabled, identity: linked ? { id: String(linked.provider_user_id), login: String(linked.login) } : null, hasPassword, canUnlink: Boolean(linked) && hasPassword };
  };

  app.get("/api/auth/github", (req, res) => res.redirect(start(req, res, "login")));
  app.post("/api/auth/github/link", (req, res) => res.json({ url: start(req, res, "bind") }));
  app.get("/api/auth/github/status", (req, res) => res.json(status(requireUser(req).id)));
  app.delete("/api/auth/github/link", (req, res) => {
    const user = requireUser(req);
    store.transaction(() => {
      const previous = status(user.id);
      if (previous.identity && !previous.hasPassword) throw new HttpError(409, "GitHub 是唯一登录方式，当前无法解除绑定。");
      store.db.prepare("DELETE FROM oauth_identities WHERE provider='github' AND user_id=?").run(user.id);
    });
    res.json(status(user.id));
  });
  app.get("/api/auth/github/callback", async (req, res) => {
    try {
      requireConfig();
      const flow = read(req, string(req.query.state), "authorize", true);
      if (req.query.error) fail(req.query.error === "access_denied" ? "cancelled" : "unavailable");
      const code = string(req.query.code);
      if (!code) fail("invalid_request");
      const user = await profile(code, flow);
      sameSession(req, flow);
      if (flow.purpose === "bind") { link(flow.userId!, user); res.redirect("/?github=linked"); return; }
      const account = loginAccount(user, false);
      if (!account) {
        const ticket = remember({ stage: "signup", profile: user, browserHash: flow.browserHash, sessionKey: flow.sessionKey, userId: flow.userId, expires: now() + lifetime });
        res.redirect(`/?github_signup=${ticket}`); return;
      }
      ctx.establish(req, res, account.userId); res.redirect("/");
    } catch (error) {
      if (!(error instanceof GithubFailure)) console.error("GitHub authentication failed:", error instanceof Error ? error.message : "unknown");
      res.redirect(`/?github=${error instanceof GithubFailure ? error.result : "unavailable"}`);
    }
  });
  app.get("/api/auth/github/signup", (req, res) => {
    requireConfig();
    const flow = read(req, string(req.query.ticket), "signup", false);
    res.json({ login: flow.profile.login, displayName: flow.profile.displayName });
  });
  app.post("/api/auth/github/signup", (req, res) => {
    requireConfig(); checkOrigin(req);
    const flow = read(req, string(req.body?.ticket), "signup", true);
    const account = loginAccount(flow.profile, true)!;
    ctx.establish(req, res, account.userId);
    res.status(account.created ? 201 : 200).json({ user: store.userById(account.userId) });
  });
  app.delete("/api/auth/github/signup", (req, res) => {
    requireConfig(); checkOrigin(req);
    read(req, string(req.body?.ticket), "signup", true); res.json({ ok: true });
  });
  return { enabled };
}
