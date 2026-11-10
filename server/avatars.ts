import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import type { FileStore } from "./files.ts";
import { fail, HttpError } from "./store.ts";

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const formats = new Map([["image/jpeg", "jpeg"], ["image/png", "png"], ["image/webp", "webp"]]);

// Decode outside the database transaction. Sharp drops metadata from the output.
export async function prepareAvatar(bytes: Buffer, contentType: string): Promise<Buffer> {
  if (!bytes.length) fail(400, "请选择照片。", "bad_request");
  if (bytes.length > MAX_AVATAR_BYTES) fail(413, "照片不能超过 5 MiB。", "too_large");
  const format = formats.get(contentType.split(";", 1)[0].trim().toLowerCase());
  if (!format) fail(415, "照片必须为 JPEG、PNG 或 WebP。", "unsupported_media_type");
  try {
    const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: "warning" });
    const metadata = await image.metadata();
    if (metadata.format !== format || (metadata.pages ?? 1) > 1) fail(400, "照片格式不符或包含动画。", "bad_request");
    return await image.autoOrient().resize(512, 512, { fit: "cover", position: "centre" }).webp({ quality: 85 }).toBuffer();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(400, "照片无法读取，或像素超过 4000 万。", "bad_request");
  }
}

// This module owns the current revision and the private attachment namespace.
export class AvatarStore {
  constructor(private readonly db: DatabaseSync, private readonly files: FileStore) {
    db.exec("CREATE TABLE IF NOT EXISTS avatars(user_id TEXT PRIMARY KEY REFERENCES users(id), path TEXT NOT NULL)");
  }

  url(userId: string): string | null {
    const row = this.db.prepare("SELECT path FROM avatars WHERE user_id=?").get(userId);
    return row ? `/api/account/avatars/${encodeURIComponent(userId)}/${encodeURIComponent(String(row.path))}` : null;
  }

  // The caller commits the file index and current mapping in one Store transaction.
  put(userId: string, bytes: Buffer): void {
    const path = `${createHash("sha256").update(bytes).digest("hex")}.webp`;
    if (!this.files.write(`avatar:${userId}`, path, "image/webp", bytes)) fail(409, "头像版本冲突，请重试。");
    this.db.prepare("INSERT INTO avatars(user_id,path) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET path=excluded.path").run(userId, path);
  }

  remove(userId: string): void {
    this.db.prepare("DELETE FROM avatars WHERE user_id=?").run(userId);
  }

  current(userId: string, revision: string): { scope: string; path: string } | undefined {
    const row = this.db.prepare("SELECT path FROM avatars WHERE user_id=? AND path=?").get(userId, revision);
    return row ? { scope: `avatar:${userId}`, path: String(row.path) } : undefined;
  }
}
