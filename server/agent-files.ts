import express, { type Express, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import schema from "../schema.ts";
import { isImageType, normalizeStoredFile } from "../src/core/files.ts";
import type { StoredFile } from "../src/core/types.ts";
import { fail, type Actor, type Store } from "./store.ts";
import { recordTokenEvent } from "./token-identity.ts";

/* Agent attachment boundary: PUT writes bytes into the same FileStore the
   browser uses, GET reads them back, and checkedStoredFile is the single
   reference check every Agent surface shares (image properties, file
   paragraphs, image mentions). */

const FILE_PATH = /^files\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const pathSchema = z.string().min(1).max(320)
  .refine((value) => FILE_PATH.test(value) && !value.split("/").includes(".."), "附件路径无效。");
const scopeParam = z.string().min(1).max(256);
const nameParam = z.string().trim().min(1).max(255);

/** The record shape of a StoredFile, strict: unknown keys are rejected so a
 *  passed-in reference is exactly what the records keep. Shared by
 *  propertyFiles, file paragraphs and image mentions. */
export const storedFileSchema = schema.definition.collections.pages.fields.cover_image.unwrap().strict().extend({
  path: pathSchema,
  owner: z.string().min(1).max(256).refine((value) => !["__proto__", "prototype", "constructor"].includes(value), "标识无效。"),
  space: z.string().min(1).max(256).refine((value) => !["__proto__", "prototype", "constructor"].includes(value), "标识无效。").optional(),
  name: z.string().min(1).max(255), size: z.number().int().min(0), type: z.string().max(125),
  width: z.number().int().min(1).max(50000).optional(), height: z.number().int().min(1).max(50000).optional(),
  preview: pathSchema.optional(),
});

/** A reference an Agent hands back must be one the server could have issued:
 *  normalize-clean and deep-equal to the input, owned by the target scope,
 *  and still indexed with the same type and size. `image` additionally
 *  requires a browser-drawable image type. `scope` is the resolved internal
 *  scope (`user:<id>` or the space id). */
export function checkedStoredFile(store: Store, who: Actor, scope: string, input: unknown, image = false): StoredFile {
  const normalized = normalizeStoredFile(input);
  if (!normalized || !isDeepStrictEqual(normalized, input)) fail(400, "附件引用无效。", "bad_request");
  if (scope.startsWith("user:") ? normalized.owner !== who.user.id || normalized.space !== undefined
                               : normalized.space !== scope) fail(400, "附件必须属于目标空间。", "bad_request");
  const known = store.one("SELECT type,size FROM files WHERE scope=? AND path=?", scope, normalized.path);
  if (!known || known.type !== normalized.type || Number(known.size) !== normalized.size)
    fail(400, "附件不存在，或附件元数据不匹配。", "bad_request");
  if (normalized.preview) {
    const preview = store.one("SELECT type FROM files WHERE scope=? AND path=?", scope, normalized.preview);
    if (!preview || !isImageType(String(preview.type))) fail(400, "图片预览不存在。", "bad_request");
  }
  if (image && !isImageType(normalized.type)) fail(400, "附件不是图片。", "bad_request");
  return normalized;
}

/** The path segment of a generated attachment path: the display name's safe
 *  form, the extension kept — the same rule the browser applies. */
function safeFileName(name: string): string {
  const sanitize = (value: string) => value.normalize("NFKD").replace(/[^\w.-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  const ext = /\.[^./]{1,10}$/.exec(name)?.[0] ?? "";
  const stem = sanitize(ext ? name.slice(0, -ext.length) : name) || "file";
  return `${stem}${ext}`.slice(-80);
}

const generatedPath = (name: string) => `files/agent/${randomUUID().replaceAll("-", "")}/${safeFileName(name)}`;

export function attachAgentFiles(app: Express, store: Store, actor: (req: Request) => Actor): void {
  app.put("/api/v1/files/:scope", express.raw({ type: () => true, limit: "8mb" }), (req, res) => {
    const who = actor(req);
    const requested = scopeParam.parse(req.params.scope);
    const scope = store.scope(who, requested, true);
    if (!Buffer.isBuffer(req.body) || !req.body.length) fail(400, "需要附件内容。", "bad_request");
    const input = z.object({ path: pathSchema.optional(), name: nameParam.optional() }).strict().parse(req.query);
    const type = (req.get("content-type") ?? "application/octet-stream").toLowerCase();
    const path = input.path ?? generatedPath(input.name ?? "file");
    const name = input.name ?? input.path?.split("/").at(-1) ?? path.split("/").at(-1)!;
    const file = store.transaction((): StoredFile => {
      if (!store.files.write(scope, path, type, req.body)) fail(409, "附件路径已存在。", "conflict");
      const stored: StoredFile = {
        path, owner: who.user.id, ...(scope.startsWith("user:") ? {} : { space: scope }),
        name, size: req.body.length, type,
      };
      recordTokenEvent(store.db, who.tokenId, { action: "upload", pageId: path, pageTitle: name });
      return stored;
    });
    res.status(201).json(file);
  });

  app.get("/api/v1/files/:scope", (req: Request, res: Response) => {
    const who = actor(req);
    const scope = store.scope(who, scopeParam.parse(req.params.scope));
    const path = pathSchema.parse(req.query.path);
    const file = store.files.read(scope, path);
    if (!file) fail(404, "附件不存在。", "not_found");
    res.setHeader("Content-Type", file.type);
    res.setHeader("Content-Length", file.size);
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(path.split("/").at(-1) ?? "file")}`);
    pipeline(file.stream, res, (error) => { if (error) res.destroy(error); });
  });
}
