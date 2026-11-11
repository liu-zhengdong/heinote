import { randomUUID } from "node:crypto";
import type { Row } from "./store.ts";
import { fail } from "./store.ts";

/** Agent 令牌的身份：一个 displayName 加一个头像引用。
 *  头像只存形态引用，不存路径：`preset:<id>` 用内置品牌标，
 *  `upload:<sha>.webp` 指附件区 `avatar-token:<tokenId>` 里的文件，
 *  `initial` 走按名生成。 */

const PRESET_IDS = new Set(["claude", "codex", "gpt", "gemini", "cursor", "deepseek"]);
const UPLOAD_RE = /^upload:[0-9a-f]{64}\.webp$/;

export type TokenAvatar =
  | { kind: "preset"; preset: string }
  | { kind: "upload"; path: string }
  | { kind: "initial" };

export function parseTokenAvatar(raw: unknown): TokenAvatar {
  if (raw == null || raw === "" || raw === "initial") return { kind: "initial" };
  if (typeof raw !== "string") fail(400, "头像引用无效。", "bad_request");
  const [kind, value] = raw.split(":", 2);
  if (kind === "preset" && PRESET_IDS.has(value)) return { kind: "preset", preset: value };
  if (kind === "upload" && UPLOAD_RE.test(raw)) return { kind: "upload", path: value };
  fail(400, "头像引用无效。", "bad_request");
}

export function tokenAvatarRef(input: { avatar?: string; avatarPreset?: string }): string {
  if (input.avatar !== undefined) {
    parseTokenAvatar(input.avatar);
    return input.avatar;
  }
  if (input.avatarPreset !== undefined) {
    if (!PRESET_IDS.has(input.avatarPreset)) fail(400, "预设头像不存在。", "bad_request");
    return `preset:${input.avatarPreset}`;
  }
  return "initial";
}

export function tokenAvatarUrl(tokenId: string, avatar: string): string | null {
  const parsed = parseTokenAvatar(avatar);
  if (parsed.kind === "upload") return `/api/tokens/${encodeURIComponent(tokenId)}/avatar/${encodeURIComponent(parsed.path)}`;
  return null; // preset 与 initial 由客户端渲染，URL 为空
}

export const AVATAR_PRESETS = [...PRESET_IDS];

/** 令牌行的对外形状。avatar 只给 `preset`/`upload` 引用，不给密钥。 */
export function tokenDto(row: Row) {
  return {
    id: String(row.id),
    name: String(row.name),
    displayName: row.display_name == null ? String(row.name) : String(row.display_name),
    avatar: row.avatar == null ? "initial" : String(row.avatar),
    access: String(row.access),
    createdAt: String(row.created_at),
    lastUsedAt: row.last_used_at == null ? null : String(row.last_used_at),
  };
}

export const tokenAvatarScope = (tokenId: string) => `avatar-token:${tokenId}`;

/** 写操作事件。与内容写入同事务记录；撤销令牌时随令牌删除。 */
export interface TokenEvent {
  action: string;
  pageId: string;
  pageTitle: string;
  versionId?: string;
}

export function recordTokenEvent(
  db: { prepare(sql: string): { run(...args: unknown[]): unknown } },
  tokenId: string | undefined,
  event: TokenEvent,
): void {
  if (!tokenId) return;
  db.prepare("INSERT INTO token_events(id,token_id,action,page_id,page_title,version_id,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(randomUUID(), tokenId, event.action, event.pageId, event.pageTitle.slice(0, 500), event.versionId ?? null, new Date().toISOString());
}

export function eventDto(row: Row) {
  return {
    id: String(row.id),
    action: String(row.action),
    pageId: String(row.page_id),
    pageTitle: String(row.page_title),
    versionId: row.version_id == null ? null : String(row.version_id),
    createdAt: String(row.created_at),
  };
}
