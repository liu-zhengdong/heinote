import type { BlockKind } from "../../core/types";
import { blockShortcut } from "./block-registry";
import { codeLanguage } from "./code-highlight";

/** What a line typed so far turns into when it is closed — by a space, or,
 *  for a fence, Enter too: the block registry's shortcuts, and a code fence
 *  naming its language (```python, ```ts), as Markdown writes one. */
export function markdownShortcut(value: string): { kind: BlockKind; checked?: boolean; language?: string } | null {
  const fence = /^```([^\s`]+)$/.exec(value);
  if (fence) return { kind: "code", language: codeLanguage(fence[1]).id };
  return blockShortcut(value);
}

/** Markdown → paragraphs lives in core/markdown-blocks.ts (the importer on
 *  the server uses it too); a tree's Markdown and HTML-clipped forms live in
 *  core/export-markdown.ts. Kept here for the window's imports. */
export { markdownToBlockTree } from "../../core/markdown-blocks";
export { blockTreeToMarkdown, inlineContentToMarkdown, readableTree } from "../../core/export-markdown";
