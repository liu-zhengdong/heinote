import type { StoredFile } from "./types";

/* A file reference read from a record is untrusted: another member's client
   wrote it. Only a path under `files/`, with no way out of it, is ever read,
   and every other field is checked for its shape. */
const FILE_PATH = /^files\/[A-Za-z0-9._\-/]{1,300}$/;
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const MEDIA_TYPE = /^[\w.+-]{1,60}\/[\w.+-]{1,60}$/;

function safePath(value: unknown): string | undefined {
  return typeof value === "string" && FILE_PATH.test(value) && !value.split("/").includes("..") ? value : undefined;
}

function dimension(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 50_000 ? Math.round(value) : undefined;
}

export function normalizeStoredFile(value: unknown): StoredFile | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const path = safePath(candidate.path);
  const owner = typeof candidate.owner === "string" && ID.test(candidate.owner) ? candidate.owner : undefined;
  if (!path || !owner) return undefined;
  const space = typeof candidate.space === "string" && ID.test(candidate.space) ? candidate.space : undefined;
  const width = dimension(candidate.width);
  const height = dimension(candidate.height);
  const preview = safePath(candidate.preview);
  return {
    path,
    owner,
    ...(space ? { space } : {}),
    name: typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.slice(0, 255) : "file",
    size: typeof candidate.size === "number" && Number.isFinite(candidate.size) && candidate.size >= 0 ? Math.round(candidate.size) : 0,
    type: typeof candidate.type === "string" && MEDIA_TYPE.test(candidate.type) ? candidate.type.toLowerCase() : "application/octet-stream",
    ...(width && height ? { width, height } : {}),
    ...(preview ? { preview } : {}),
  };
}

/** A picture a page can draw: the kinds every browser shows. */
export function isImageType(type: string): boolean {
  return /^image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/i.test(type);
}

/** An image's drawn width: a sensible number of CSS pixels, or none. */
export function normalizeImageWidth(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 40 && value <= 4000 ? Math.round(value) : undefined;
}

/** "3.2 MB", as Notion writes a file's size. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
