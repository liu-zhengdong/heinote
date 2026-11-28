import express, { type Express, type Request } from "express";
import { z } from "zod";
import {
  cancelImport,
  completeImportSession,
  createImportSession,
  dismissImportJob,
  getVisibleImportJob,
  listVisibleImports,
  MAX_PART_SIZE,
  MIN_PART_SIZE,
  toImportDto,
  uploadImportPart,
} from "./import.ts";
import { fail, type Actor, type Store } from "./store.ts";

const createSessionSchema = z.object({
  source: z.enum(["obsidian", "notion"]),
  totalBytes: z.number().int().min(22).max(100 * 1024 * 1024 * 1024),
  partSize: z.number().int().min(MIN_PART_SIZE).max(MAX_PART_SIZE).optional(),
  parentId: z.string().min(1).max(256).optional(),
  spaceId: z.string().min(1).max(256).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i, "SHA-256 必须是 64 位十六进制字符串。").optional(),
}).strict();

export function attachAgentImports(app: Express, store: Store, actor: (req: Request) => Actor): void {
  app.post("/api/v1/imports", (req, res) => {
    const who = actor(req);
    const input = createSessionSchema.parse(req.body);
    const job = createImportSession(store, who, input);
    res.status(201).json(toImportDto(job));
  });

  app.put("/api/v1/imports/:id/parts/:index", express.raw({ type: () => true, limit: "16mb" }), async (req, res, next) => {
    try {
      const who = actor(req);
      const rawIndex = String(req.params.index);
      if (!/^\d+$/.test(rawIndex)) fail(400, "分片序号无效。", "bad_request");
      const partIndex = Number(rawIndex);
      if (!Buffer.isBuffer(req.body)) fail(400, "需要分片二进制内容。", "bad_request");
      const receipt = await uploadImportPart(store, who, String(req.params.id), partIndex, req.body);
      res.json(receipt);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/imports/:id/complete", async (req, res, next) => {
    try {
      const who = actor(req);
      const job = await completeImportSession(store, who, String(req.params.id));
      res.status(202).json(toImportDto(job));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/imports", (req, res) => {
    const who = actor(req);
    res.json({ jobs: listVisibleImports(store, who).map(toImportDto) });
  });

  app.get("/api/v1/imports/:id", (req, res) => {
    const who = actor(req);
    const job = getVisibleImportJob(store, who, String(req.params.id));
    if (!job) fail(404, "导入任务不存在。", "not_found");
    res.json(toImportDto(job));
  });

  app.delete("/api/v1/imports/:id", (req, res) => {
    const who = actor(req);
    if (who.tokenAccess === "read") fail(403, "此令牌仅有读取权限。", "read_only");
    if (!cancelImport(who.user.id, String(req.params.id), who)) {
      fail(404, "没有可取消的导入任务。", "not_found");
    }
    res.json({ ok: true });
  });

  app.post("/api/v1/imports/:id/dismiss", (req, res) => {
    const who = actor(req);
    if (who.tokenAccess === "read") fail(403, "此令牌仅有读取权限。", "read_only");
    if (!dismissImportJob(store, who, String(req.params.id))) {
      fail(404, "导入任务不存在。", "not_found");
    }
    res.json({ ok: true });
  });
}
