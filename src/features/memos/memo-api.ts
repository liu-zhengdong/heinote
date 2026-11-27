import type { MemoQuickFilter } from "../../app/ui-context";
import type { MemoTagNode } from "../../core/memos";
import type { BlockTree, StoredFile } from "../../core/types";
import { request } from "../../platform/http";

export interface MemoCommentDto {
  id: string;
  parentId: string;
  text: string;
  markdown: string;
  blockTree: BlockTree;
  tags: string[];
  attachments: StoredFile[];
  createdAt: string;
  updatedAt: string;
}

export interface MemoDto {
  id: string;
  parentId: null;
  text: string;
  markdown: string;
  blockTree: BlockTree;
  summary: string;
  tags: string[];
  pinned: boolean;
  archived: boolean;
  archivedAt: string | null;
  attachments: StoredFile[];
  mentions: Array<{ pageId: string; title: string }>;
  comments: MemoCommentDto[];
  commentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoCounts {
  all: number;
  pinned: number;
  commented: number;
  untagged: number;
  trashed: number;
}

export interface MemoListResponse {
  memos: MemoDto[];
  nextCursor: string | null;
  hasMore: boolean;
  counts: MemoCounts;
}

export interface MemoTagsResponse {
  tags: MemoTagNode[];
  pinnedTags: string[];
}

export function listMemos(params: {
  limit?: number;
  cursor?: string | null;
  filter?: MemoQuickFilter | "trashed";
  tag?: string | null;
  q?: string;
  around?: string;
  signal?: AbortSignal;
} = {}): Promise<MemoListResponse> {
  const search = new URLSearchParams();
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.cursor) search.set("cursor", params.cursor);
  if (params.filter && params.filter !== "all") search.set("filter", params.filter);
  if (params.tag) search.set("tag", params.tag);
  if (params.q?.trim()) search.set("q", params.q.trim());
  if (params.around) search.set("around", params.around);
  const qs = search.toString();
  return request<MemoListResponse>(`/api/v1/memos${qs ? `?${qs}` : ""}`, { signal: params.signal });
}

export function listMemoTags(signal?: AbortSignal): Promise<MemoTagsResponse> {
  return request<MemoTagsResponse>("/api/v1/memos/tags", { signal });
}

export function createMemo(input: {
  text?: string;
  markdown?: string;
  blockTree?: BlockTree;
  parentId?: string;
  pinned?: boolean;
  attachments?: StoredFile[];
  mentionPageIds?: string[];
}): Promise<MemoDto | MemoCommentDto> {
  return request<MemoDto | MemoCommentDto>("/api/v1/memos", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateMemo(
  id: string,
  input: {
    text?: string;
    markdown?: string;
    blockTree?: BlockTree;
    pinned?: boolean;
    attachments?: StoredFile[];
    mentionPageIds?: string[];
  },
): Promise<MemoDto | MemoCommentDto> {
  return request<MemoDto | MemoCommentDto>(`/api/v1/memos/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function trashMemo(id: string): Promise<{ ok: true; id: string; archived: boolean }> {
  return request(`/api/v1/memos/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function purgeMemo(id: string): Promise<{ ok: true; id: string; deleted: boolean }> {
  return request(`/api/v1/memos/${encodeURIComponent(id)}?permanent=true`, { method: "DELETE" });
}

export function restoreMemo(id: string): Promise<MemoDto> {
  return request<MemoDto>(`/api/v1/memos/${encodeURIComponent(id)}/restore`, { method: "POST" });
}

export function promoteMemo(id: string, title?: string): Promise<{ page: { id: string; title: string }; mergedComments: number }> {
  return request(`/api/v1/memos/${encodeURIComponent(id)}/promote`, {
    method: "POST",
    body: JSON.stringify(title ? { title } : {}),
  });
}

export function renameMemoTag(from: string, to: string): Promise<{ updated: number; tags: MemoTagNode[]; pinnedTags: string[] }> {
  return request("/api/v1/memos/tags/rename", {
    method: "POST",
    body: JSON.stringify({ from, to }),
  });
}

export function deleteMemoTag(tag: string): Promise<{ updated: number; tags: MemoTagNode[]; pinnedTags: string[] }> {
  return request("/api/v1/memos/tags/delete", {
    method: "POST",
    body: JSON.stringify({ tag }),
  });
}

export function setPinnedMemoTags(tags: string[]): Promise<{ pinnedTags: string[] }> {
  return request("/api/v1/memos/tags/pinned", {
    method: "PUT",
    body: JSON.stringify({ tags }),
  });
}

export function uploadMemoImage(file: File): Promise<StoredFile> {
  const name = encodeURIComponent(file.name || "image.png");
  return request<StoredFile>(`/api/v1/files/personal?name=${name}`, {
    method: "PUT",
    headers: { "Content-Type": file.type || "image/png" },
    body: file,
  });
}

export function memoFileUrl(file: StoredFile): string {
  return `/api/files/personal?path=${encodeURIComponent(file.path)}`;
}
