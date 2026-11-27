import { blocksInOrder } from "./block-tree";
import type { Block, BlockTree } from "./types";

export const MAX_MEMO_TAGS = 50;
export const MAX_MEMO_TAG_LENGTH = 40;

const TAG_CHAR_CLASS = "[^\\s#.,，。!?！？:：;；)）\\]】`'\"\\\\]";
const TAG_SEGMENT_RE = new RegExp(`(^|[\\s(（\\[【])#(${TAG_CHAR_CLASS}{1,${MAX_MEMO_TAG_LENGTH}})`, "g");

/** Normalize a raw `#tag` or `parent/child` path. Returns empty string if invalid. */
export function normalizeMemoTag(raw: string): string {
  const trimmed = raw.trim().replace(/^#+/, "");
  if (!trimmed) return "";
  const cleaned = trimmed
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");
  if (!cleaned || cleaned.length > MAX_MEMO_TAG_LENGTH) return "";
  if (/[\s#.,，。!?！？:：;；)）\]】`'"\\]/.test(cleaned)) return "";
  return cleaned;
}

/** Extract unique normalized `#tag` paths from plain/markdown text while
 *  skipping fenced code blocks and inline code spans. */
export function extractMemoTagsFromText(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Mask fenced code blocks and inline code spans so `#define` or `#tag` in code is ignored.
  const masked = text
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/`[^`\n]*`/g, (span) => " ".repeat(span.length));
  TAG_SEGMENT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_SEGMENT_RE.exec(masked)) !== null) {
    const normalized = normalizeMemoTag(match[2]);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= MAX_MEMO_TAGS) break;
  }
  return out;
}

/** Extract unique normalized `#tag` paths from a memo's BlockTree, skipping
 *  code blocks and inline code runs. */
export function extractTagsFromBlockTree(tree: BlockTree): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const block of blocksInOrder(tree)) {
    if (block.kind === "code") continue;
    const lineText = block.content
      .filter((run) => !run.mention && !run.marks?.code)
      .map((run) => run.text)
      .join("");
    for (const tag of extractMemoTagsFromText(lineText)) {
      if (seen.has(tag)) continue;
      seen.add(tag);
      out.push(tag);
      if (out.length >= MAX_MEMO_TAGS) return out;
    }
  }
  return out;
}

/** Rewrite `#oldTag` (and `#oldTag/...` descendants) to `#nextTag` (or remove
 *  when `nextTag` is null) in plain text. */
export function rewriteTagInText(text: string, oldTag: string, nextTag: string | null): string {
  const target = normalizeMemoTag(oldTag);
  if (!target) return text;
  const replacement = nextTag === null ? null : normalizeMemoTag(nextTag);
  if (nextTag !== null && !replacement) return text;

  const rewriteOne = (clean: string): string | null => {
    if (clean === target) return replacement;
    if (clean.startsWith(`${target}/`)) {
      return replacement === null ? null : `${replacement}${clean.slice(target.length)}`;
    }
    return clean;
  };

  let out = text.replace(TAG_SEGMENT_RE, (full, prefix: string, rawTag: string) => {
    const clean = normalizeMemoTag(rawTag);
    if (!clean) return full;
    if (clean !== target && !clean.startsWith(`${target}/`)) return full;
    const rewritten = rewriteOne(clean);
    if (rewritten === null) return prefix;
    return `${prefix}#${rewritten}`;
  });

  if (replacement === null) {
    out = out
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/^[ \t]+|[ \t]+$/gm, (line) => line);
  }
  return out;
}

/** Rewrite `#oldTag` (and `#oldTag/...`) across all non-code text runs of a BlockTree. */
export function rewriteTagInBlockTree(
  tree: BlockTree,
  oldTag: string,
  nextTag: string | null,
): { tree: BlockTree; changed: boolean } {
  let changed = false;
  const nextById: Record<string, Block> = {};
  for (const [id, block] of Object.entries(tree.by_id)) {
    if (block.kind === "code") {
      nextById[id] = block;
      continue;
    }
    let blockChanged = false;
    const nextContent = block.content.map((run) => {
      if (run.mention || run.marks?.code || !run.text.includes("#")) return run;
      const rewritten = rewriteTagInText(run.text, oldTag, nextTag);
      if (rewritten === run.text) return run;
      blockChanged = true;
      return { ...run, text: rewritten };
    });
    if (blockChanged) {
      changed = true;
      nextById[id] = { ...block, content: nextContent };
    } else {
      nextById[id] = block;
    }
  }
  return changed ? { tree: { by_id: nextById }, changed: true } : { tree, changed: false };
}

/** True when `memoTags` matches `filterTag` or any descendant under `filterTag/`. */
export function memoMatchesTag(memoTags: readonly string[], filterTag: string): boolean {
  const target = normalizeMemoTag(filterTag);
  if (!target) return false;
  return memoTags.some((tag) => tag === target || tag.startsWith(`${target}/`));
}

/** Derive a concise title for search hits or memo promotion from markdown/text. */
export function memoSummaryTitle(text: string): string {
  const lines = text.split("\n");
  for (const rawLine of lines) {
    const line = rawLine
      .trim()
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, "")
      .replace(/^\d+\.\s+/, "")
      .replace(/^>\s+/, "");
    const withoutTags = rewriteAllTagsOut(line).trim();
    if (withoutTags) {
      return withoutTags.length > 60 ? `${withoutTags.slice(0, 59).trimEnd()}…` : withoutTags;
    }
  }
  return "来自闪念的页面";
}

function rewriteAllTagsOut(line: string): string {
  return line
    .replace(TAG_SEGMENT_RE, (_full, prefix: string) => prefix)
    .replace(/\s{2,}/g, " ");
}

export interface MemoTagNode {
  path: string;
  name: string;
  count: number;
  children: MemoTagNode[];
}

/** Build a hierarchical tag tree where each node's count is the number of
 *  unique memos matching that tag or any descendant tag. */
export function buildMemoTagTree(memos: ReadonlyArray<{ tags: readonly string[] }>): MemoTagNode[] {
  const allPaths = new Set<string>();
  for (const memo of memos) {
    for (const raw of memo.tags) {
      const tag = normalizeMemoTag(raw);
      if (!tag) continue;
      const parts = tag.split("/");
      let acc = "";
      for (const part of parts) {
        acc = acc ? `${acc}/${part}` : part;
        allPaths.add(acc);
      }
    }
  }

  const nodes = new Map<string, MemoTagNode>();
  const sortedPaths = [...allPaths].sort((left, right) => left.localeCompare(right, "zh-CN"));
  for (const path of sortedPaths) {
    const parts = path.split("/");
    const count = memos.reduce((sum, memo) => sum + (memoMatchesTag(memo.tags, path) ? 1 : 0), 0);
    nodes.set(path, { path, name: parts[parts.length - 1], count, children: [] });
  }

  const roots: MemoTagNode[] = [];
  for (const path of sortedPaths) {
    const node = nodes.get(path)!;
    const slash = path.lastIndexOf("/");
    if (slash < 0) {
      roots.push(node);
    } else {
      const parent = nodes.get(path.slice(0, slash));
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
  }
  return roots;
}
