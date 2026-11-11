import { BLOCK_ORDER_STEP, createBlock } from "../../core/block-tree";
import { isMarkdownTableStart, markdownTableLines, tableFromCells } from "../../core/simple-table";
import type { Block, BlockKind, BlockTree, InlineContent, SimpleTable } from "../../core/types";
import { blockShortcut } from "./block-registry";
import { codeLanguage } from "./code-highlight";
import { markdownInlineToContent } from "./inline-markdown";

interface MarkdownDraft {
  kind: BlockKind;
  content: InlineContent;
  checked?: boolean;
  language?: string;
  table?: SimpleTable;
  depth: number;
}

/** What a line typed so far turns into when it is closed — by a space, or,
 *  for a fence, Enter too: the block registry's shortcuts, and a code fence
 *  naming its language (```python, ```ts), as Markdown writes one. */
export function markdownShortcut(value: string): { kind: BlockKind; checked?: boolean; language?: string } | null {
  const fence = /^```([^\s`]+)$/.exec(value);
  if (fence) return { kind: "code", language: codeLanguage(fence[1]).id };
  return blockShortcut(value);
}

function indentationDepth(value: string): number {
  const whitespace = value.match(/^\s*/)?.[0] ?? "";
  return Math.floor(whitespace.replaceAll("\t", "  ").length / 2);
}

function parseMarkdown(value: string, idFactory: () => string): MarkdownDraft[] {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const drafts: MarkdownDraft[] = [];
  let quotedBefore = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    // Whether the line just before was quoted; this one says for itself.
    const continuing = quotedBefore;
    quotedBefore = false;
    const fence = line.match(/^\s*```\s*([^\s`]*)\s*$/);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      drafts.push({ kind: "code", content: [{ text: code.join("\n") }], language: fence[1] || undefined, depth: 0 });
      continue;
    }
    if (!line.trim()) continue;
    // A Markdown table — a header, its rule, its rows — is a simple table.
    if (isMarkdownTableStart(line, lines[index + 1])) {
      const { rows, end } = markdownTableLines(lines, index);
      const cells = rows.map((row) => row.map(markdownInlineToContent));
      drafts.push({ kind: "table", content: [], table: tableFromCells(cells, idFactory, { headerRow: true }), depth: 0 });
      index = end - 1;
      continue;
    }
    const depth = indentationDepth(line);
    const heading = line.match(/^\s*(#{1,3})\s+(.+)$/);
    if (heading) {
      drafts.push({ kind: `heading${heading[1].length}` as BlockKind, content: markdownInlineToContent(heading[2]), depth: 0 });
      continue;
    }
    const todo = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/);
    if (todo) {
      drafts.push({ kind: "todo", content: markdownInlineToContent(todo[2]), checked: todo[1].toLowerCase() === "x", depth });
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    if (bullet) {
      drafts.push({ kind: "bullet", content: markdownInlineToContent(bullet[1]), depth });
      continue;
    }
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (numbered) {
      drafts.push({ kind: "numbered", content: markdownInlineToContent(numbered[1]), depth });
      continue;
    }
    // Lines quoted one after another are one quote, as they are written.
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      const previous = drafts.at(-1);
      const lineContent = markdownInlineToContent(quote[1]);
      if (previous?.kind === "quote" && continuing) {
        previous.content = [...previous.content, { text: "\n" }, ...lineContent];
      } else {
        drafts.push({ kind: "quote", content: lineContent, depth: 0 });
      }
      quotedBefore = true;
      continue;
    }
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      drafts.push({ kind: "divider", content: [], depth: 0 });
      continue;
    }
    drafts.push({ kind: "text", content: markdownInlineToContent(line.trimStart()), depth: 0 });
  }
  return drafts;
}

export function markdownToBlockTree(value: string, idFactory: () => string): BlockTree {
  const byId: Record<string, Block> = {};
  const lastListAtDepth = new Map<number, string>();
  const siblingCounts = new Map<string, number>();
  for (const draft of parseMarkdown(value, idFactory)) {
    const listKind = draft.kind === "bullet" || draft.kind === "numbered" || draft.kind === "todo";
    const parentId = listKind && draft.depth > 0 ? lastListAtDepth.get(draft.depth - 1) ?? null : null;
    const parentKey = parentId ?? "root";
    const order = ((siblingCounts.get(parentKey) ?? 0) + 1) * BLOCK_ORDER_STEP;
    siblingCounts.set(parentKey, order / BLOCK_ORDER_STEP);
    const block = createBlock(idFactory(), draft.kind, {
      parent_id: parentId,
      order,
      content: draft.content,
      ...(draft.checked === undefined ? {} : { checked: draft.checked }),
      ...(draft.language === undefined ? {} : { language: draft.language }),
      ...(draft.table ? { table: draft.table } : {}),
    });
    byId[block.id] = block;
    if (listKind) {
      lastListAtDepth.set(draft.depth, block.id);
      for (const depth of [...lastListAtDepth.keys()]) if (depth > draft.depth) lastListAtDepth.delete(depth);
    } else {
      lastListAtDepth.clear();
    }
  }
  return { by_id: byId };
}

/** A tree's Markdown and HTML-clipped forms live in core/export-markdown.ts
 *  (the export writes them on the server); kept here for the window's
 *  imports. */
export { blockTreeToMarkdown, inlineContentToMarkdown, readableTree } from "../../core/export-markdown";
