import express, { type Request, type Response, type NextFunction } from "express";
import { scrypt, timingSafeEqual, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { pipeline } from "node:stream";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { Store, fail, hash, id, secret, HttpError, writeSchema, type Actor, type Row, type User } from "./store.ts";
import { newPage } from "../src/core/block-tree.ts";
import { restoredPage } from "../src/core/versions.ts";
import type { NotePage, StoredFile } from "../src/core/types.ts";
import { textUpdateSchema, expectedPageSchema } from "./collaboration.ts";
import { attachCollaborationSocket } from "./collaboration-socket.ts";
import { attachAgentOperations } from "./agent-operations.ts";
import { attachAgentDatabases } from "./agent-databases.ts";
import { attachKnowledgeBases, spaceSummary } from "./knowledge-bases.ts";
import { LIMIT_BYTES, TEAM_LIMIT } from "./quotas.ts";
import { MAX_AVATAR_BYTES, prepareAvatar } from "./avatars.ts";
import { attachGithubAuth, githubConfigFromEnvironment, type GithubConfig } from "./github-auth.ts";
import { writeExport } from "./export.ts";
import { importJob, startImport } from "./import.ts";

const derive = promisify(scrypt);
const passwordHash = async (password: string) => {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${(await derive(password, salt, 64) as Buffer).toString("hex")}`;
};
const passwordMatches = async (password: string, encoded: string) => {
  // GitHub-only accounts have no password credential.
  if (!encoded) return false;
  const [salt, expected] = encoded.split(":");
  const actual = await derive(password, salt, 64) as Buffer;
  return timingSafeEqual(actual, Buffer.from(expected, "hex"));
};
const handle = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_.-]{1,39}$/);
const roleSchema = z.enum(["admin", "editor", "viewer"]);
const parse = <T extends z.ZodType>(schema: T, input: unknown): z.infer<T> => schema.parse(input);
const text = (value: unknown) => typeof value === "string" ? value : "";
const currentTime = () => new Date().toISOString();

export async function startServer(options: { dataDir?: string; host?: string; port?: number; serveStatic?: boolean; dev?: boolean; github?: GithubConfig | null; registrationOpen?: boolean } = {}) {
  const githubConfig = options.github === undefined ? githubConfigFromEnvironment() : options.github;
  const publicUrl = githubConfig?.publicUrl ?? process.env.PUBLIC_URL;
  const store = new Store(resolve(options.dataDir ?? process.env.DATA_DIR ?? "data"));
  const app = express();
  let collaborationSocket: ReturnType<typeof attachCollaborationSocket> | undefined;
  app.use((_req, res, next) => { res.once("finish", () => collaborationSocket?.revalidate()); next(); });
  app.disable("x-powered-by");
  const secure = publicUrl?.startsWith("https://") ?? false;
  const registrationOpen = options.registrationOpen ?? process.env.REGISTRATION_OPEN !== "false";
  const registrationAllowed = () => registrationOpen || !store.one("SELECT id FROM users LIMIT 1");
  const attempts = new Map<string, { count: number; until: number }>();
  const presence = new Map<string, { userId: string; clientId: string; state: unknown; time: number }>();
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.get("origin");
      const expected = publicUrl ? new URL(publicUrl).origin : `${req.protocol}://${req.get("host")}`;
      if ((origin && origin !== expected) || req.get("sec-fetch-site") === "cross-site") return next(new HttpError(403, "请求来源无效。"));
    }
    next();
  });
  const jsonParser = express.json({ limit: "16mb" });
  app.use((req, res, next) => req.path.startsWith("/api/files/") || /^\/api\/account\/avatar\/?$/i.test(req.path) ? next() : jsonParser(req, res, next));

  const cookie = (req: Request) => /(?:^|;\s*)notes_session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
  const sessionUser = (req: Request): User | undefined => {
    const token = cookie(req);
    if (!token) return;
    const row = store.one("SELECT u.* FROM users u JOIN sessions s ON u.id=s.user_id WHERE s.hash=? AND s.expires>?", hash(token), Date.now());
    return row && store.user(row);
  };
  const actor = (req: Request): Actor => {
    if (req.headers.authorization) {
      if (!req.path.startsWith("/api/v1/")) fail(403, "Agent 令牌仅可调用内容 API。");
      const token = /^Bearer (.+)$/.exec(req.headers.authorization)?.[1];
      const row = token && store.one("SELECT * FROM tokens WHERE hash=?", hash(token));
      if (!row) fail(401, "令牌无效或已撤销。", "unauthorized");
      const user = store.userById(String(row.user_id));
      if (!user) fail(401, "账号不存在。");
      store.db.prepare("UPDATE tokens SET last_used_at=? WHERE id=?").run(currentTime(), String(row.id));
      return { user, tokenAccess: row.access as "read" | "write" };
    }
    const user = sessionUser(req);
    if (!user) fail(401, "请先登录。", "unauthorized");
    return { user };
  };
  attachKnowledgeBases(app, { store, actor });
  const admin = (req: Request) => {
    const who = actor(req);
    if (who.user.siteRole !== "admin") fail(403, "需要站点管理员权限。");
    return who;
  };
  const establish = (req: Request, res: Response, userId: string) => {
    const previous = cookie(req);
    if (previous) store.db.prepare("DELETE FROM sessions WHERE hash=?").run(hash(previous));
    const token = secret();
    store.db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(hash(token), userId, Date.now() + 30 * 86400000);
    res.cookie("notes_session", token, { httpOnly: true, sameSite: "lax", secure, maxAge: 30 * 86400000, path: "/" });
  };
  const throttle = (req: Request) => {
    const key = `${req.socket.remoteAddress}:${text(req.body?.handle).toLowerCase()}`;
    const previous = attempts.get(key);
    if (previous && previous.until > Date.now() && previous.count >= 15) fail(429, "尝试次数过多，请稍后重试。");
    attempts.set(key, { count: previous && previous.until > Date.now() ? previous.count + 1 : 1, until: Date.now() + 10 * 60000 });
    if (attempts.size > 10000) for (const [key, value] of attempts) if (value.until < Date.now()) attempts.delete(key);
  };
  const github = attachGithubAuth(app, {
    store, config: githubConfig, secure, establish, registrationAllowed,
    session: (req) => ({ user: sessionUser(req), key: cookie(req) ? hash(cookie(req)!) : undefined }),
  });
  app.get("/api/health", (_req, res) => { store.one("SELECT 1"); res.json({ status: "ok" }); });
  app.get("/api/session", (req, res) => res.json({ user: sessionUser(req) ?? null, registrationOpen: registrationAllowed(), githubEnabled: github.enabled }));
  app.patch("/api/account/profile", (req, res) => {
    const who = actor(req); const { displayName } = parse(z.object({ displayName: z.string().trim().min(1).max(100) }).strict(), req.body);
    store.db.prepare("UPDATE users SET display_name=? WHERE id=?").run(displayName, who.user.id);
    res.json({ user: store.userById(who.user.id) });
  });
  app.post("/api/auth/register", async (req, res) => {
    throttle(req);
    const input = parse(z.object({ handle, displayName: z.string().trim().min(1).max(100), password: z.string().min(10).max(256) }), req.body);
    if (!registrationOpen && store.one("SELECT id FROM users LIMIT 1")) fail(403, "注册已关闭。");
    if (store.one("SELECT id FROM users WHERE handle=?", input.handle)) fail(409, "此用户名已注册。");
    const password = await passwordHash(input.password);
    const userId = id();
    store.transaction(() => {
      if (store.one("SELECT id FROM users WHERE handle=?", input.handle)) fail(409, "此用户名已注册。");
      const siteRole = store.one("SELECT id FROM users LIMIT 1") ? "user" : "admin";
      store.db.prepare("INSERT INTO users(id,handle,display_name,password,site_role,created_at) VALUES(?,?,?,?,?,?)").run(userId, input.handle, input.displayName, password, siteRole, currentTime());
    });
    establish(req, res, userId); res.status(201).json({ user: store.userById(userId) });
  });
  app.post("/api/auth/login", async (req, res) => {
    throttle(req);
    const input = parse(z.object({ handle, password: z.string().min(1).max(256) }), req.body);
    const row = store.one("SELECT * FROM users WHERE handle=?", input.handle);
    if (!row || !await passwordMatches(input.password, String(row.password))) fail(401, "用户名或密码错误。");
    establish(req, res, String(row.id)); res.json({ user: store.user(row) });
  });
  app.post("/api/auth/logout", (req, res) => {
    const value = cookie(req); if (value) store.db.prepare("DELETE FROM sessions WHERE hash=?").run(hash(value));
    res.clearCookie("notes_session", { path: "/", httpOnly: true, sameSite: "lax", secure }); res.json({ ok: true });
  });
  const quotaUser = (row: Row) => {
    const user = store.user(row);
    const id = String(row.id);
    const storage = store.quotas.quota(`user:${id}`);
    const teams = store.quotas.teamCount(id);
    const teamLimit = store.quotas.teamLimitOf(id);
    return { ...user, storageBytes: storage.used, storageLimit: storage.limit, storageSource: storage.source, storageOver: storage.over, teamCount: teams, teamLimit: teamLimit.limit, teamLimitSource: teamLimit.source };
  };
  const quotaKb = (row: Row) => {
    const spaceId = String(row.id);
    const meta = store.knowledgeBases.get(spaceId)!;
    const storage = store.quotas.quota(`kb:${spaceId}`);
    const members = Number(store.one("SELECT count(*) AS n FROM members WHERE space_id=?", spaceId)?.n ?? 0);
    return {
      spaceId, name: String(row.name), ownerId: String(row.owner_id),
      ownerName: String(store.one("SELECT display_name FROM users WHERE id=?", String(row.owner_id))?.display_name ?? ""),
      memberCount: members, archived: meta.archived, createdAt: meta.createdAt,
      storageBytes: storage.used, storageLimit: storage.limit, storageSource: storage.source, storageOver: storage.over,
    };
  };
  app.get("/api/admin/overview", (req, res) => {
    admin(req);
    const today = store.quotas.today();
    const users = Number(store.one("SELECT count(*) AS n FROM users")?.n ?? 0);
    // Registration times are ISO strings; the site timezone fixes the boundary.
    const newToday = store.all("SELECT created_at FROM users WHERE created_at IS NOT NULL")
      .filter((row) => { try { return new Intl.DateTimeFormat("en-CA", { timeZone: store.quotas.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(String(row.created_at))) === today; } catch { return false; } }).length;
    const active = Number(store.one("SELECT count(*) AS n FROM knowledge_bases WHERE archived=0")?.n ?? 0);
    const archived = Number(store.one("SELECT count(*) AS n FROM knowledge_bases WHERE archived=1")?.n ?? 0);
    const rows = store.quotas.usageRows();
    const personal = rows.filter((row) => row.kind === "user").reduce((sum, row) => sum + row.used, 0);
    const teams = rows.filter((row) => row.kind === "kb").reduce((sum, row) => sum + row.used, 0);
    const disk = store.quotas.diskUsage();
    const over = rows.filter((row) => row.over > 0).map((row) => ({ ...row, label: store.quotas.describe(`${row.kind}:${row.id}`) }));
    res.json({ timezone: store.quotas.timezone, users, newToday, teams: { active, archived }, quotaBytes: { personal, teams, total: personal + teams }, disk, over });
  });
  app.get("/api/admin/users", (req, res) => { admin(req); res.json(store.all("SELECT * FROM users ORDER BY handle").map((row) => quotaUser(row))); });
  app.patch("/api/admin/users/:id", (req, res) => {
    admin(req); const input = parse(z.object({ siteRole: z.enum(["admin", "user"]) }), req.body);
    const target = store.one("SELECT * FROM users WHERE id=?", text(req.params.id)); if (!target) fail(404, "用户不存在。");
    store.transaction(() => {
      const user = store.userById(String(target.id)); if (!user) fail(404, "用户不存在。");
      if (user.siteRole === "admin" && input.siteRole === "user" && Number(store.one("SELECT count(*) AS count FROM users WHERE site_role='admin'")?.count) <= 1) fail(409, "至少保留一位站点管理员。");
      store.db.prepare("UPDATE users SET site_role=? WHERE id=?").run(input.siteRole, user.id);
    });
    res.json(store.userById(String(target.id)));
  });
  const limitInput = z.object({
    storageLimit: z.union([LIMIT_BYTES, z.null()]).optional(),
    teamCreationLimit: z.union([TEAM_LIMIT, z.null()]).optional(),
  }).refine((input) => input.storageLimit !== undefined || input.teamCreationLimit !== undefined, "请提供限额修改。");
  app.patch("/api/admin/users/:id/limits", (req, res) => {
    admin(req);
    const input = parse(limitInput, req.body);
    const row = store.one("SELECT * FROM users WHERE id=?", text(req.params.id));
    if (!row) fail(404, "用户不存在。", "not_found");
    // E6: refuse to overwrite a stale base with the client's blind write.
    const expected = parse(z.object({
      storageLimit: z.union([LIMIT_BYTES, z.null()]),
      teamCreationLimit: z.union([TEAM_LIMIT, z.null()]),
    }), req.body.base ?? {});
    if (Number(row.storage_limit ?? -1) !== (expected.storageLimit ?? -1) || Number(row.team_creation_limit ?? -1) !== (expected.teamCreationLimit ?? -1)) {
      res.status(409).json({ error: "限额已被其他管理员修改。", code: "conflict", current: quotaUser(row) });
      return;
    }
    const storage = input.storageLimit === undefined ? (row.storage_limit == null ? null : Number(row.storage_limit)) : input.storageLimit;
    const teams = input.teamCreationLimit === undefined ? (row.team_creation_limit == null ? null : Number(row.team_creation_limit)) : input.teamCreationLimit;
    store.transaction(() => store.quotas.setUserLimits(String(row.id), storage, teams));
    res.json(quotaUser(store.one("SELECT * FROM users WHERE id=?", String(row.id))!));
  });
  app.get("/api/admin/teams", (req, res) => {
    admin(req);
    res.json(store.all("SELECT s.* FROM spaces s JOIN knowledge_bases k ON k.space_id=s.id ORDER BY s.name").map(quotaKb));
  });
  app.patch("/api/admin/teams/:id/limits", (req, res) => {
    admin(req);
    const input = parse(z.object({ storageLimit: z.union([LIMIT_BYTES, z.null()]), base: z.object({ storageLimit: z.union([LIMIT_BYTES, z.null()]) }).optional() }), req.body);
    const row = store.one("SELECT s.* FROM spaces s JOIN knowledge_bases k ON k.space_id=s.id WHERE s.id=?", text(req.params.id));
    if (!row) fail(404, "知识库不存在。", "not_found");
    const current = store.one("SELECT storage_limit FROM knowledge_bases WHERE space_id=?", String(row.id))?.storage_limit;
    if (input.base && Number(current ?? -1) !== (input.base.storageLimit ?? -1)) {
      res.status(409).json({ error: "限额已被其他管理员修改。", code: "conflict", current: quotaKb(row) });
      return;
    }
    store.transaction(() => store.quotas.setKbLimit(String(row.id), input.storageLimit));
    res.json(quotaKb(store.one("SELECT * FROM spaces WHERE id=?", String(row.id))!));
  });
  app.get("/api/admin/quota-settings", (req, res) => {
    admin(req);
    const defaults = store.quotas.defaults();
    res.json({ personalStorageBytes: defaults.personalStorageBytes, teamStorageBytes: defaults.teamStorageBytes, teamCreation: defaults.teamCreation });
  });
  app.post("/api/admin/quota-settings/preview", (req, res) => {
    admin(req);
    const input = parse(z.object({ key: z.enum(["personal", "team", "creation"]), value: z.number().int().min(0).max(1_000_000_000_000_000) }), req.body);
    if (input.key !== "creation" && input.value <= 0) fail(400, "存储限额必须为正值。", "bad_request");
    res.json(store.quotas.impact(input.key, input.value));
  });
  app.put("/api/admin/quota-settings", (req, res) => {
    admin(req);
    const input = parse(z.object({
      key: z.enum(["personal", "team", "creation"]),
      value: z.number().int().min(0).max(1_000_000_000_000_000),
      base: z.object({ personalStorageBytes: z.number(), teamStorageBytes: z.number(), teamCreation: z.number() }).optional(),
    }), req.body);
    if (input.key !== "creation" && input.value <= 0) fail(400, "存储限额必须为正值。", "bad_request");
    if (input.base) {
      const current = store.quotas.defaults();
      const stale = current.personalStorageBytes !== input.base.personalStorageBytes
        || current.teamStorageBytes !== input.base.teamStorageBytes
        || current.teamCreation !== input.base.teamCreation;
      if (stale) { res.status(409).json({ error: "默认限额已被其他管理员修改。", code: "conflict", current }); return; }
    }
    store.transaction(() => store.quotas.setDefault(input.key, input.value));
    res.json(store.quotas.defaults());
  });
  app.get("/api/account/quota", (req, res) => {
    const who = actor(req);
    const storage = store.quotas.quota(`user:${who.user.id}`);
    const managed = store.all("SELECT s.id FROM spaces s JOIN knowledge_bases k ON k.space_id=s.id JOIN members m ON m.space_id=s.id WHERE m.user_id=? AND m.role IN ('owner','admin')", who.user.id).map((row) => {
      const quota = store.quotas.quota(`kb:${String(row.id)}`);
      return { spaceId: String(row.id), name: String(store.one("SELECT name FROM spaces WHERE id=?", String(row.id))?.name ?? ""), used: quota.used, limit: quota.limit, over: quota.over };
    });
    const teams = { count: store.quotas.teamCount(who.user.id), ...store.quotas.teamLimitOf(who.user.id) };
    res.json({ storage: { used: storage.used, limit: storage.limit, source: storage.source, over: storage.over }, teams, managed });
  });
  app.patch("/api/admin/users/:id", (req, res) => {
    admin(req); const input = parse(z.object({ siteRole: z.enum(["admin", "user"]) }), req.body);
    store.transaction(() => {
      const user = store.userById(text(req.params.id)); if (!user) fail(404, "用户不存在。");
      if (user.siteRole === "admin" && input.siteRole === "user" && Number(store.one("SELECT count(*) AS count FROM users WHERE site_role='admin'")?.count) <= 1) fail(409, "至少保留一位站点管理员。");
      store.db.prepare("UPDATE users SET site_role=? WHERE id=?").run(input.siteRole, user.id);
    }); res.json({ ok: true });
  });
  app.get("/api/users", (req, res) => {
    actor(req); const query = text(req.query.query).trim().replace(/^@/, "").toLowerCase();
    res.json(query.length < 2 ? [] : store.all("SELECT * FROM users WHERE instr(handle,?)>0 OR instr(lower(display_name),?)>0 ORDER BY handle LIMIT 20", query, query).map((row) => { const { siteRole: _siteRole, createdAt: _createdAt, ...person } = store.user(row); return person; }));
  });
  app.get("/api/spaces", (req, res) => { const who = actor(req); res.json(store.all("SELECT s.*,m.role FROM spaces s JOIN members m ON s.id=m.space_id WHERE m.user_id=? ORDER BY s.id", who.user.id).map((row) => spaceSummary(store, row))); });
  app.post("/api/spaces", (req, res) => {
    const who = actor(req); const { name } = parse(z.object({ name: z.string().trim().min(1).max(200) }), req.body); const spaceId = id();
    store.transaction(() => { store.db.prepare("INSERT INTO spaces VALUES(?,?,?)").run(spaceId, name, who.user.id); store.db.prepare("INSERT INTO members VALUES(?,?,?)").run(spaceId, who.user.id, "owner"); });
    res.status(201).json({ spaceId, name });
  });
  app.get("/api/spaces/:id/roster", (req, res) => {
    const who = actor(req); const spaceId = text(req.params.id); store.role(who, spaceId);
    const members = store.all("SELECT u.*,m.role FROM users u JOIN members m ON u.id=m.user_id WHERE m.space_id=? ORDER BY u.handle", spaceId).map((row) => { const { createdAt: _createdAt, ...person } = store.user(row); return { ...person, role: row.role }; });
    const invitations = store.all("SELECT i.*,u.handle,u.display_name,u.site_role FROM invitations i JOIN users u ON u.id=i.user_id WHERE i.space_id=? AND i.status='pending' AND i.expires>?", spaceId, Date.now()).map((row) => {
      const { siteRole: _siteRole, createdAt: _createdAt, ...invitee } = store.user({ ...row, id: row.user_id });
      return { id: row.id, invitee, role: row.role, status: row.status, expiresAt: new Date(Number(row.expires)).toISOString() };
    });
    res.json({ members, invitations });
  });
  app.post("/api/spaces/:id/invitations", (req, res) => {
    const who = actor(req); const spaceId = text(req.params.id);
    const input = parse(z.object({ handle, role: roleSchema }), req.body);
    const result = store.transaction(() => {
      const myRole = store.manage(who, spaceId);
      if (store.knowledgeBases.get(spaceId)?.archived) fail(403, "知识库已归档，不能发出新邀请。", "read_only");
      if (input.role === "admin" && myRole !== "owner") fail(403, "只有所有者可以授予管理权限。");
      const user = store.one("SELECT id FROM users WHERE handle=?", input.handle); if (!user) fail(404, "用户尚未注册。请先让对方注册账号。");
      const userId = String(user.id);
      if (store.one("SELECT role FROM members WHERE space_id=? AND user_id=?", spaceId, userId)) return { created: false };
      if (store.one("SELECT id FROM invitations WHERE space_id=? AND user_id=? AND status='pending' AND expires>?", spaceId, userId, Date.now())) return { created: false };
      store.db.prepare("INSERT INTO invitations VALUES(?,?,?,?,?,?,?)").run(id(), spaceId, userId, who.user.id, input.role, "pending", Date.now() + 7 * 86400000);
      return { created: true };
    });
    res.json(result);
  });
  app.delete("/api/spaces/:id/invitations/:invitationId", (req, res) => {
    const who = actor(req); const spaceId = text(req.params.id);
    store.transaction(() => {
      const myRole = store.manage(who, spaceId);
      const invitation = store.one("SELECT * FROM invitations WHERE id=? AND space_id=?", text(req.params.invitationId), spaceId);
      if (!invitation) fail(404, "邀请不存在。", "not_found");
      if (myRole !== "owner" && invitation.role === "admin") fail(403, "只有所有者可以撤销管理员邀请。", "forbidden");
      if (invitation.status === "revoked") return;
      if (invitation.status !== "pending") fail(409, "邀请已处理，不能撤销。", "conflict");
      store.db.prepare("UPDATE invitations SET status='revoked' WHERE id=?").run(String(invitation.id));
    });
    res.json({ ok: true });
  });
  app.get("/api/invitations", (req, res) => { const who = actor(req); res.json(store.all("SELECT i.*,s.name,u.display_name FROM invitations i JOIN spaces s ON i.space_id=s.id JOIN users u ON u.id=i.inviter_id WHERE i.user_id=? AND i.status='pending' AND i.expires>?", who.user.id, Date.now()).map((row) => ({ id: row.id, spaceId: row.space_id, spaceName: row.name, role: row.role, inviter: row.display_name, expiresAt: new Date(Number(row.expires)).toISOString() }))); });
  app.post("/api/invitations/:id", (req, res) => {
    const who = actor(req); const input = parse(z.object({ accept: z.boolean() }), req.body);
    store.transaction(() => {
      const invitation = store.one("SELECT * FROM invitations WHERE id=? AND user_id=?", text(req.params.id), who.user.id);
      if (!invitation) fail(404, "邀请不存在。");
      if (invitation.status !== "pending" || Number(invitation.expires) < Date.now()) fail(409, "邀请已处理或过期。");
      if (input.accept && store.knowledgeBases.get(String(invitation.space_id))?.archived) fail(409, "知识库已归档，此邀请不能接受。", "conflict");
      if (input.accept) store.db.prepare("INSERT INTO members VALUES(?,?,?) ON CONFLICT DO NOTHING").run(String(invitation.space_id), who.user.id, String(invitation.role));
      store.db.prepare("UPDATE invitations SET status=? WHERE id=?").run(input.accept ? "accepted" : "declined", String(invitation.id));
    }); res.json({ ok: true });
  });
  const managedMember = (req: Request) => {
    const who = actor(req); const spaceId = text(req.params.id); const myRole = store.manage(who, spaceId);
    const member = store.one("SELECT * FROM members WHERE space_id=? AND user_id=?", spaceId, text(req.params.userId));
    if (!member) fail(404, "成员不存在。");
    if (member.role === "owner" || (myRole !== "owner" && member.role === "admin")) fail(403, "不能修改此成员。");
    return { spaceId, myRole };
  };
  app.patch("/api/spaces/:id/members/:userId", (req, res) => {
    const { spaceId, myRole } = managedMember(req); const { role } = parse(z.object({ role: roleSchema }), req.body);
    if (role === "admin" && myRole !== "owner") fail(403, "只有所有者可授予管理权限。");
    store.db.prepare("UPDATE members SET role=? WHERE space_id=? AND user_id=?").run(role, spaceId, text(req.params.userId)); res.json({ ok: true });
  });
  app.delete("/api/spaces/:id/members/:userId", (req, res) => {
    const { spaceId } = managedMember(req); store.db.prepare("DELETE FROM members WHERE space_id=? AND user_id=?").run(spaceId, text(req.params.userId)); res.json({ ok: true });
  });
  app.post("/api/spaces/:id/leave", (req, res) => {
    const who = actor(req); const spaceId = text(req.params.id); if (store.role(who, spaceId) === "owner") fail(403, "所有者不能退出自己的空间。");
    store.db.prepare("DELETE FROM members WHERE space_id=? AND user_id=?").run(spaceId, who.user.id); res.json({ ok: true });
  });
  app.post("/api/spaces/:id/presence", (req, res) => {
    const who = actor(req); const spaceId = text(req.params.id); store.role(who, spaceId);
    const input = parse(z.object({ clientId: z.string().max(100), state: z.record(z.string(), z.unknown()).nullable() }), req.body);
    const key = `${spaceId}:${who.user.id}:${input.clientId}`;
    if (!input.state) presence.delete(key); else presence.set(key, { userId: who.user.id, clientId: input.clientId, state: input.state, time: Date.now() });
    res.json({ ok: true });
  });
  app.get("/api/spaces/:id/presence", (req, res) => {
    const who = actor(req); const spaceId = text(req.params.id); store.role(who, spaceId);
    for (const [key, item] of presence) if (item.time < Date.now() - 45000) presence.delete(key);
    const active = [...presence].filter(([key, item]) => key.startsWith(`${spaceId}:`) && store.one("SELECT role FROM members WHERE space_id=? AND user_id=?", spaceId, item.userId));
    res.json([...new Map(active.map(([, item]) => [item.userId, { userId: item.userId, state: item.state, online: true }])).values()]);
  });
  app.get("/api/records/:scope/:collection", (req, res) => {
    const who = actor(req); const scope = store.scope(who, text(req.params.scope)); const collection = text(req.params.collection);
    if (!["pages", "blocks", "versions", "workspace_settings"].includes(collection)) fail(404, "记录集合不存在。");
    if (collection === "workspace_settings" && !scope.startsWith("user:")) fail(403, "设置仅属于个人。");
    res.json(store.records(scope, collection));
  });
  app.get("/api/collaboration/:scope/:pageId", (req, res) => {
    res.json(store.collaboration.snapshot(actor(req), text(req.params.scope), text(req.params.pageId)));
  });
  app.post("/api/records/batch", (req, res) => {
    const who = actor(req);
    const { writes, requestId, textUpdates, expectedPages } = parse(z.object({ writes: z.array(writeSchema).max(10000).default([]), requestId: z.string().max(100).optional(), textUpdates: z.array(textUpdateSchema).max(1000).default([]), expectedPages: z.array(expectedPageSchema).max(1000).default([]) }), req.body);
    res.json(store.apply(who, writes, requestId, textUpdates, expectedPages));
  });
  app.post("/api/records/:scope/:collection/:id", (req, res) => {
    const who = actor(req); const write = parse(writeSchema, { ...req.body, scope: req.params.scope, collection: req.params.collection, id: req.params.id });
    res.json(store.apply(who, [write])[0]);
  });
  const fileInput = (req: Request, write = false) => {
    const who = actor(req); const scope = store.scope(who, text(req.params.scope), write); const path = parse(z.string().min(1).max(2048), req.query.path);
    return { scope, path };
  };
  const sendFile = (res: Response, scope: string, path: string) => {
    const file = store.files.read(scope, path);
    if (!file) fail(404, "附件不存在。", "not_found");
    res.setHeader("Content-Type", file.type); res.setHeader("Content-Length", file.size);
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(path.split("/").at(-1) ?? "file")}`);
    pipeline(file.stream, res, (error) => { if (error) res.destroy(error); });
  };
  app.put("/api/account/avatar", (req, _res, next) => { actor(req); next(); }, express.raw({ type: () => true, limit: MAX_AVATAR_BYTES }), async (req, res) => {
    const who = actor(req);
    if (!Buffer.isBuffer(req.body)) fail(400, "需要照片内容。", "bad_request");
    const bytes = await prepareAvatar(req.body, req.get("content-type") ?? "");
    store.transaction(() => {
      const current = actor(req);
      if (current.user.id !== who.user.id) fail(401, "账号已变化，请重新登录。", "unauthorized");
      store.avatars.put(current.user.id, bytes);
    });
    res.json({ user: store.userById(who.user.id) });
  });
  app.delete("/api/account/avatar", (req, res) => {
    const who = actor(req);
    store.transaction(() => store.avatars.remove(who.user.id));
    res.json({ user: store.userById(who.user.id) });
  });
  app.get("/api/account/avatars/:userId/:revision", (req, res) => {
    actor(req);
    const location = store.avatars.current(text(req.params.userId), text(req.params.revision));
    if (!location) fail(404, "头像不存在。", "not_found");
    sendFile(res, location.scope, location.path);
  });
  app.put("/api/files/:scope", express.raw({ type: () => true, limit: "8mb" }), (req, res) => {
    const { scope, path } = fileInput(req, true); if (!Buffer.isBuffer(req.body)) fail(400, "需要附件内容。");
    // Inside the transaction so the quota check covers the new payload.
    store.transaction(() => {
      if (!store.files.write(scope, path, req.get("content-type") ?? "application/octet-stream", req.body)) fail(409, "附件路径已存在。");
    });
    res.json({ ok: true });
  });
  app.get("/api/files/:scope", (req, res) => { const { scope, path } = fileInput(req); sendFile(res, scope, path); });
  const tokenDto = (row: Row) => ({ id: row.id, name: row.name, access: row.access, createdAt: row.created_at, lastUsedAt: row.last_used_at });
  app.get("/api/account/export", async (req, res) => {
    const who = actor(req);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="notes-export-${new Date().toISOString().slice(0, 10)}.zip"`);
    try {
      await writeExport(res, store, who);
      res.end();
    } catch (error) {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });
  app.post("/api/account/import/:source", express.raw({ type: () => true, limit: "1gb" }), (req, res) => {
    const who = actor(req);
    const source = req.params.source === "notion" ? "notion" : req.params.source === "obsidian" ? "obsidian" : null;
    if (!source) fail(404, "不支持的导入来源。", "not_found");
    if (!Buffer.isBuffer(req.body) || !req.body.length) fail(400, "需要 zip 内容。");
    const job = startImport(store, who, source, req.body);
    res.status(202).json({ id: job.id, status: job.status });
  });
  app.get("/api/account/import/:id", (req, res) => {
    const who = actor(req);
    const job = importJob(who.user.id, req.params.id);
    if (!job) fail(404, "导入任务不存在。", "not_found");
    const { userId: _user, created: _created, ...dto } = job;
    res.json(dto);
  });
  app.get("/api/tokens", (req, res) => { const who = actor(req); res.json(store.all("SELECT * FROM tokens WHERE user_id=? ORDER BY created_at", who.user.id).map(tokenDto)); });
  app.post("/api/tokens", (req, res) => {
    const who = actor(req); const input = parse(z.object({ name: z.string().trim().min(1).max(100), access: z.enum(["read", "write"]) }), req.body);
    const tokenId = id(); const token = `notes_${secret()}`; const createdAt = currentTime();
    store.db.prepare("INSERT INTO tokens VALUES(?,?,?,?,?,?,NULL)").run(tokenId, hash(token), who.user.id, input.name, input.access, createdAt);
    res.status(201).json({ id: tokenId, token, ...input, createdAt, lastUsedAt: null });
  });
  app.delete("/api/tokens/:id", (req, res) => { const who = actor(req); store.db.prepare("DELETE FROM tokens WHERE id=? AND user_id=?").run(text(req.params.id), who.user.id); res.json({ ok: true }); });
  const shareDto = (row: Row) => ({ id: row.id, url: `/s/${row.token}`, createdAt: row.created_at });
  app.get("/api/shares", (req, res) => { const who = actor(req); res.json(store.all("SELECT * FROM shares WHERE user_id=? AND page_id=?", who.user.id, text(req.query.pageId)).map(shareDto)); });
  app.post("/api/shares", (req, res) => {
    const who = actor(req); const { pageId } = parse(z.object({ pageId: z.string() }), req.body); const { scope } = store.page(who, pageId);
    if (store.knowledgeBases.get(scope)) fail(403, "团队知识库页面不能公开分享。", "forbidden");
    if (!scope.startsWith("user:") && store.role(who, scope) !== "owner") fail(403, "只有所有者可以公开分享。");
    const row = { id: id(), token: secret(), created_at: currentTime() };
    store.db.prepare("INSERT INTO shares VALUES(?,?,?,?,?,?)").run(row.id, row.token, who.user.id, scope, pageId, row.created_at);
    res.status(201).json(shareDto(row));
  });
  app.delete("/api/shares/:id", (req, res) => { const who = actor(req); store.db.prepare("DELETE FROM shares WHERE id=? AND user_id=?").run(text(req.params.id), who.user.id); res.json({ ok: true }); });
  app.get("/api/public/:token", (req, res) => { const { title, pages } = store.published(text(req.params.token)); res.json({ title, pages }); });
  app.get("/api/public/:token/files", (req, res) => {
    const { pages, scope: publishedScope } = store.published(text(req.params.token)); const path = text(req.query.path);
    const refs: StoredFile[] = [];
    const collect = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if ("path" in value && "owner" in value && "name" in value) refs.push(value as StoredFile);
      for (const child of Object.values(value)) collect(child);
    };
    pages.forEach(collect); const file = refs.find((file) => file.path === path || file.preview === path);
    if (!file) fail(404, "附件不属于此分享。");
    const share = store.one("SELECT user_id FROM shares WHERE token=?", text(req.params.token));
    const publisher = share && store.userById(String(share.user_id));
    if (!publisher) fail(404, "分享链接已失效。");
    if (!file.space && file.owner !== publisher.id) fail(403, "此附件未移入分享空间。");
    const fileScope = store.scope({ user: publisher }, file.space ?? "personal");
    if (fileScope !== publishedScope) fail(403, "附件必须先移入发布页面所在的空间。");
    sendFile(res, fileScope, path);
  });
  app.get("/api/v1/pages", (req, res) => { const who = actor(req); res.json(Object.values(store.state(who).pages).filter((page) => !page.archived).map((page) => store.pageDto(who, page.id))); });
  app.post("/api/v1/pages", (req, res) => {
    const who = actor(req); const input = parse(z.object({ title: z.string().max(500).default(""), text: z.string().max(100000).default(""), parentId: z.string().min(1).max(256).optional(), spaceId: z.string().min(1).max(256).optional(), scope: z.string().min(1).max(256).optional() }).strict(), req.body);
    const pageId = store.transaction(() => {
      const parent = input.parentId ? store.page(who, input.parentId) : undefined;
      const requested = input.scope ?? input.spaceId;
      const explicitScope = requested ? store.scope(who, requested, true) : undefined;
      if (input.scope && input.spaceId && store.scope(who, input.spaceId, true) !== explicitScope) fail(400, "指定空间不一致。", "bad_request");
      if (parent && explicitScope && parent.scope !== explicitScope) fail(400, "父页面与指定空间不一致。", "bad_request");
      const scope = parent?.scope ?? explicitScope ?? store.scope(who, "personal", true);
      store.scope(who, scope.startsWith("user:") ? "personal" : scope, true);
      const knowledgeBase = store.knowledgeBases.get(scope);
      const page = newPage(id(), "document", input.parentId ?? knowledgeBase?.homePageId ?? null, { author: who.user.id, now: currentTime() }, id());
      page.title = input.title;
      const block = Object.values(page.block_tree.by_id)[0]; block.content = [{ text: input.text }];
      if (!parent && !scope.startsWith("user:") && !knowledgeBase) page.share_space_id = scope;
      store.savePage(scope, page);
      return page.id;
    });
    res.status(201).json(store.pageDto(who, pageId));
  });
  app.get("/api/v1/pages/:id", (req, res) => { const who = actor(req); res.json(store.pageDto(who, text(req.params.id))); });
  app.patch("/api/v1/pages/:id", (req, res) => {
    const who = actor(req); const pageId = text(req.params.id); store.page(who, pageId);
    const input = parse(z.object({ title: z.string().max(500).optional(), text: z.string().max(100000).optional(), baseRevision: z.string() }).strict(), req.body);
    store.transaction(() => {
      const { page, scope } = store.page(who, pageId); store.scope(who, scope.startsWith("user:") ? "personal" : scope, true);
      if (input.baseRevision !== store.revision(scope, pageId)) fail(409, "页面已被修改。请重新读取。", "conflict");
      store.checkpoint(who, pageId, "Agent 修改前");
      const next = { ...page, updated_at: currentTime(), updated_by: who.user.id };
      if (input.title !== undefined) { next.title = input.title; delete next.title_content; }
      if (input.text !== undefined) {
        const blockId = id(); next.block_tree = { by_id: { [blockId]: { id: blockId, kind: "text", parent_id: null, order: 1024, content: [{ text: input.text }] } } };
      }
      store.savePage(scope, next);
    }); res.json(store.pageDto(who, pageId));
  });
  app.get("/api/v1/pages/:id/versions", (req, res) => { const who = actor(req); const pageId = text(req.params.id); store.page(who, pageId); res.json(Object.values(store.state(who).versions[pageId] ?? {}).sort((a, b) => a.created_at.localeCompare(b.created_at))); });
  app.post("/api/v1/pages/:id/checkpoint", (req, res) => { const who = actor(req); const version = store.transaction(() => store.checkpoint(who, text(req.params.id), text(req.body?.summary).slice(0, 200) || "手动保存")); res.json(version); });
  app.post("/api/v1/pages/:id/restore", (req, res) => {
    const who = actor(req); const pageId = text(req.params.id); const { versionId, baseRevision } = parse(z.object({ versionId: z.string(), baseRevision: z.string().optional() }), req.body);
    store.transaction(() => {
      const { page, scope } = store.page(who, pageId); store.scope(who, scope.startsWith("user:") ? "personal" : scope, true);
      if (baseRevision && store.revision(scope, pageId) !== baseRevision) fail(409, "页面已有新修改。请重新检查后恢复。", "conflict");
      const version = store.state(who).versions[pageId]?.[versionId]; if (!version) fail(404, "版本不存在。");
      store.checkpoint(who, pageId, "恢复前", true);
      const restored: NotePage = restoredPage(version.snapshot, page); restored.updated_at = currentTime(); restored.updated_by = who.user.id;
      store.savePage(scope, restored);
      store.collaboration.reset(scope, pageId);
    }); res.json(store.pageDto(who, pageId));
  });

  attachAgentDatabases(app, store, actor);
  attachAgentOperations(app, store, actor);
  app.use("/api", (_req, _res, next) => next(new HttpError(404, "接口不存在。", "not_found")));
  let vite: { close(): Promise<void> } | undefined;
  if (options.dev) {
    const { createServer } = await import("vite");
    const server = await createServer({ server: { middlewareMode: true }, appType: "spa" });
    vite = server; app.use(server.middlewares);
  } else if (options.serveStatic !== false) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
    app.use(express.static(root, { index: false }));
    app.get("/{*path}", (_req, res) => res.sendFile(resolve(root, "index.html")));
  }
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) { res.status(400).json({ error: "输入格式无效。", code: "bad_request", details: error.issues.map((issue) => ({ path: issue.path, message: issue.message })) }); return; }
    if (error instanceof HttpError) {
      const quota = (error as { quota?: unknown }).quota;
      res.status(error.status).json({ error: error.message, code: error.code, ...(quota ? { quota } : {}) });
      return;
    }
    if ((error as { type?: string })?.type === "entity.too.large") { res.status(413).json({ error: "请求过大。", code: "too_large" }); return; }
    if (error instanceof SyntaxError) { res.status(400).json({ error: "JSON 格式无效。", code: "bad_request" }); return; }
    console.error(error); res.status(500).json({ error: "服务暂时无法完成请求。", code: "internal_error" });
  });
  const server = app.listen(options.port ?? Number(process.env.PORT ?? 3000), options.host ?? process.env.HOST ?? "0.0.0.0");
  collaborationSocket = attachCollaborationSocket(server, store, (req) => {
    if (req.headers.authorization) fail(403, "实时连接使用浏览器会话。");
    const user = sessionUser(req as Request);
    if (!user) fail(401, "请重新登录。", "unauthorized");
    return { user };
  });
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const address = server.address();
  const url = `http://${options.host && options.host !== "0.0.0.0" ? options.host : "127.0.0.1"}:${typeof address === "object" && address ? address.port : 3000}`;
  return { url, async close() { collaborationSocket?.close(); await vite?.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); store.db.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = await startServer({ dev: process.argv.includes("--dev") });
  console.log(`Notes: ${server.url}`);
  const stop = () => void server.close().then(() => process.exit(0));
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
}
