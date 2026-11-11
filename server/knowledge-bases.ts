import type { Express, Request } from "express";
import { z } from "zod";
import { SIDEBAR_SORTS } from "../schema.ts";
import { newPage } from "../src/core/block-tree.ts";
import type { KnowledgeBase, SidebarSort, SpaceRole, SpaceSummary } from "../src/core/types.ts";
import { fail, hash, id, type Actor, type Row, type Store } from "./store.ts";

const identifier = z.string().min(1).max(256);
const requestId = z.string().uuid();
const name = z.string().trim().min(1).max(200);
const description = z.string().trim().max(2000);
const revision = z.number().int().min(1);
const createSchema = z.object({ requestId, name, description: description.default("") }).strict();
const patchSchema = z.object({ requestId, revision, name: name.optional(), description: description.optional(), sort: z.enum(SIDEBAR_SORTS).optional() }).strict()
  .refine((input) => input.name !== undefined || input.description !== undefined || input.sort !== undefined, "请提供知识库修改。");
const archiveSchema = z.object({ requestId, revision, archived: z.boolean() }).strict();
const transferSchema = z.object({ requestId, revision, userId: identifier }).strict();

/** Metadata identifies a knowledge base. Content stays in existing records. */
export class KnowledgeBases {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS knowledge_bases(
      space_id TEXT PRIMARY KEY REFERENCES spaces(id),
      home_page_id TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      archived INTEGER NOT NULL CHECK(archived IN (0,1)),
      sort TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      created_at TEXT NOT NULL
    )`);
  }

  get(spaceId: string): KnowledgeBase | undefined {
    const row = this.store.one("SELECT * FROM knowledge_bases WHERE space_id=?", spaceId);
    return row && {
      homePageId: String(row.home_page_id), description: String(row.description),
      archived: Number(row.archived) !== 0, sort: row.sort as SidebarSort,
      revision: Number(row.revision), createdAt: String(row.created_at),
    };
  }
}

export function spaceSummary(store: Store, row: Row): SpaceSummary {
  const spaceId = String(row.id);
  const role = row.role as SpaceRole;
  const manager = role === "owner" || role === "admin";
  const knowledgeBase = store.knowledgeBases.get(spaceId);
  const kbQuota = knowledgeBase ? store.quotas?.quota(`kb:${spaceId}`) : undefined;
  return {
    spaceId, name: String(row.name), role,
    canInvite: manager && !knowledgeBase?.archived,
    canManageRoles: manager, canRemoveMembers: manager, canLeave: role !== "owner",
    // Managers see the capacity line; members see the KB without it.
    ...(knowledgeBase ? { knowledgeBase: { ...knowledgeBase, ...(manager && kbQuota ? { storage: { used: kbQuota.used, limit: kbQuota.limit, over: kbQuota.over } } : {}) } } : {}),
  };
}

export function attachKnowledgeBases(app: Express, { store, actor }: { store: Store; actor: (request: Request) => Actor }): void {
  const browserActor = (request: Request): Actor => {
    const who = actor(request);
    if (who.tokenAccess !== undefined) fail(403, "知识库管理使用浏览器登录会话。", "forbidden");
    return who;
  };
  const summary = (who: Actor, spaceId: string): SpaceSummary => {
    const role = store.role(who, spaceId);
    const space = store.one("SELECT * FROM spaces WHERE id=?", spaceId);
    if (!space) fail(404, "知识库不存在。", "not_found");
    return spaceSummary(store, { ...space, role });
  };
  const current = (who: Actor, spaceId: string, expected: number): { metadata: KnowledgeBase; role: SpaceRole } => {
    const role = store.role(who, spaceId);
    const metadata = store.knowledgeBases.get(spaceId);
    if (!metadata) fail(404, "知识库不存在。", "not_found");
    if (metadata.revision !== expected) fail(409, "知识库已被修改。请重新读取。", "conflict");
    return { metadata, role };
  };
  const owner = (role: SpaceRole): void => {
    if (role !== "owner") fail(403, "只有所有者可以执行此操作。", "forbidden");
  };
  const mutation = (who: Actor, request: Request, input: { requestId: string }, work: () => SpaceSummary): SpaceSummary => store.transaction(() => {
    const key = `knowledge:${input.requestId}`;
    const digest = hash(JSON.stringify({ method: request.method, path: request.path, input }));
    const cached = store.one("SELECT digest,result FROM requests WHERE user_id=? AND request_id=?", who.user.id, key);
    if (cached) {
      if (cached.digest !== digest) fail(409, "请求 ID 已用于其他操作。", "conflict");
      const result = JSON.parse(String(cached.result)) as SpaceSummary;
      store.role(who, result.spaceId);
      return result;
    }
    const result = work();
    store.db.prepare("INSERT INTO requests(user_id,request_id,digest,result) VALUES(?,?,?,?)").run(who.user.id, key, digest, JSON.stringify(result));
    return result;
  });

  app.get("/api/knowledge-bases/operations/:requestId", (req, res) => {
    const who = browserActor(req);
    const key = `knowledge:${requestId.parse(req.params.requestId)}`;
    const operation = store.one("SELECT result FROM requests WHERE user_id=? AND request_id=?", who.user.id, key);
    if (!operation) fail(404, "操作结果不存在。", "not_found");
    res.json({ status: "committed", result: JSON.parse(String(operation.result)) as SpaceSummary });
  });

  app.post("/api/knowledge-bases", (req, res) => {
    const who = browserActor(req); const input = createSchema.parse(req.body);
    const result = mutation(who, req, input, () => {
      // UC-16 V4: one slot check shared by create and ownership transfer.
      store.quotas.assertTeamSlot(who.user.id, "请联系站点管理员调整创建上限。");
      const spaceId = id(); const homePageId = id(); const createdAt = new Date().toISOString();
      store.db.prepare("INSERT INTO spaces(id,name,owner_id) VALUES(?,?,?)").run(spaceId, input.name, who.user.id);
      store.db.prepare("INSERT INTO members(space_id,user_id,role) VALUES(?,?,?)").run(spaceId, who.user.id, "owner");
      store.db.prepare("INSERT INTO knowledge_bases(space_id,home_page_id,description,archived,sort,revision,created_at) VALUES(?,?,?,?,?,?,?)").run(spaceId, homePageId, input.description, 0, "name", 1, createdAt);
      const home = newPage(homePageId, "document", null, { author: who.user.id, now: createdAt }, id());
      home.title = input.name; home.share_space_id = spaceId;
      store.savePage(spaceId, home);
      return summary(who, spaceId);
    });
    res.status(201).json(result);
  });

  app.patch("/api/knowledge-bases/:id", (req, res) => {
    const who = browserActor(req); const spaceId = identifier.parse(req.params.id); const input = patchSchema.parse(req.body);
    const result = mutation(who, req, input, () => {
      const { metadata, role } = current(who, spaceId, input.revision);
      if (role === "viewer" || ((input.name !== undefined || input.description !== undefined) && role !== "owner" && role !== "admin")) fail(403, "没有修改此知识库设置的权限。", "forbidden");
      if (metadata.archived) fail(403, "知识库已归档，仅可读取。", "read_only");
      if (input.name !== undefined) store.db.prepare("UPDATE spaces SET name=? WHERE id=?").run(input.name, spaceId);
      store.db.prepare("UPDATE knowledge_bases SET description=?,sort=?,revision=revision+1 WHERE space_id=?").run(input.description ?? metadata.description, input.sort ?? metadata.sort, spaceId);
      return summary(who, spaceId);
    });
    res.json(result);
  });

  app.post("/api/knowledge-bases/:id/archive", (req, res) => {
    const who = browserActor(req); const spaceId = identifier.parse(req.params.id); const input = archiveSchema.parse(req.body);
    const result = mutation(who, req, input, () => {
      const { role } = current(who, spaceId, input.revision); owner(role);
      store.db.prepare("UPDATE knowledge_bases SET archived=?,revision=revision+1 WHERE space_id=?").run(Number(input.archived), spaceId);
      if (input.archived) store.db.prepare("UPDATE invitations SET status='revoked' WHERE space_id=? AND status='pending'").run(spaceId);
      return summary(who, spaceId);
    });
    res.json(result);
  });

  app.post("/api/knowledge-bases/:id/transfer", (req, res) => {
    const who = browserActor(req); const spaceId = identifier.parse(req.params.id); const input = transferSchema.parse(req.body);
    const result = mutation(who, req, input, () => {
      const { role } = current(who, spaceId, input.revision); owner(role);
      if (input.userId === who.user.id) fail(400, "请选择其他已加入的成员。", "bad_request");
      const member = store.one("SELECT role FROM members WHERE space_id=? AND user_id=?", spaceId, input.userId);
      if (!member || member.role === "owner") fail(409, "接收者必须是当前知识库的其他成员。", "conflict");
      // UC-16 E11: the receiver must have a free team slot.
      store.quotas.assertTeamSlot(input.userId, "对方无法接收此团队。");
      store.db.prepare("UPDATE members SET role='admin' WHERE space_id=? AND user_id=?").run(spaceId, who.user.id);
      store.db.prepare("UPDATE members SET role='owner' WHERE space_id=? AND user_id=?").run(spaceId, input.userId);
      store.db.prepare("UPDATE spaces SET owner_id=? WHERE id=?").run(input.userId, spaceId);
      store.db.prepare("UPDATE knowledge_bases SET revision=revision+1 WHERE space_id=?").run(spaceId);
      return summary(who, spaceId);
    });
    res.json(result);
  });
}
