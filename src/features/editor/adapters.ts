import { BLOCK_ORDER_STEP, createBlock } from "../../core/block-tree";
import { normalizeEmbed } from "../../core/embeds";
import { type DescribeMention, inlinePlainText, inlineReadable } from "../../core/inline-content";
import { isMarkdownTableStart, markdownTableLines, tableFromCells, tableGrid, tableToMarkdown } from "../../core/simple-table";
import type { Block, BlockKind, BlockTree, InlineContent, InlineMarks, SimpleTable } from "../../core/types";
import { blockShortcut } from "./block-registry";
import { codeLanguage } from "./code-highlight";
import { markdownInlineToContent } from "./inline-markdown";
import { layout } from "./layout";
import { readableDescriber } from "./mentions";

interface MarkdownDraft {
  kind: BlockKind;
  content: InlineContent;
  checked?: boolean;
  language?: string;
  table?: SimpleTable;
  depth: number;
}

function wrapMarkdown(value: string, marks?: InlineMarks): string {
  if (!marks) return value;
  let result = value;
  if (marks.code) result = `\`${result}\``;
  if (marks.bold) result = `**${result}**`;
  if (marks.italic) result = `*${result}*`;
  if (marks.strike) result = `~~${result}~~`;
  if (marks.link) result = `[${result}](${marks.link})`;
  return result;
}

/** A mention's run is one invisible character: in Markdown it is written out
 *  as `describe` reads it, one with the words beside it that share its marks. */
export function inlineContentToMarkdown(content: InlineContent, describe: DescribeMention): string {
  // The bytes stay in Notes; outside it a picture is Markdown's, by its name.
  const parts: string[] = [];
  let words: InlineContent = [];
  const flush = () => {
    if (words.length) parts.push(inlineReadable(words, describe).map((run) => wrapMarkdown(run.text, run.marks)).join(""));
    words = [];
  };
  for (const run of content) {
    if (run.mention?.kind !== "image") {
      words.push(run);
      continue;
    }
    flush();
    parts.push(`![${run.mention.file.name}](${encodeURI(run.mention.file.name)})`);
  }
  flush();
  return parts.join("");
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

/** One line as Markdown; `number`, a numbered line's place in its list. */
function markdownLine(block: Block, number: number, describe: DescribeMention): string {
  const text = inlineContentToMarkdown(block.content, describe);
  switch (block.kind) {
    case "heading1": return `# ${text}`;
    case "heading2": return `## ${text}`;
    case "heading3": return `### ${text}`;
    case "todo": return `- [${block.checked ? "x" : " "}] ${text}`;
    case "bullet": return `- ${text}`;
    case "numbered": return `${number}. ${text}`;
    // Every line of a quote is quoted.
    case "quote": return text.split("\n").map((line) => `> ${line}`).join("\n");
    case "divider": return "---";
    case "table": return tableToMarkdown(tableGrid(block.table), (content) => inlineContentToMarkdown(content, describe));
    case "code": return `\`\`\`${block.language ?? ""}\n${inlinePlainText(block.content)}\n\`\`\``;
    // The bytes stay in Notes; outside it a file is its name.
    case "file": return `[${block.file?.name || "file"}](${encodeURI(block.file?.name ?? "")})${text ? ` ${text}` : ""}`;
    // Outside Notes a card is its link.
    case "embed": return normalizeEmbed(block.embed)?.url ?? "";
    default: return text;
  }
}

/** What a page block — or a mention — reads as outside Notes: the page's
 *  name; a date mention, the date written out. */
export function readableTree(tree: BlockTree, titleOf: (pageId: string) => string): BlockTree {
  const describe = readableDescriber(titleOf);
  const byId: Record<string, Block> = {};
  for (const block of Object.values(tree.by_id)) {
    byId[block.id] = { ...block, content: inlineReadable(block.content, describe) };
  }
  return { by_id: byId };
}

/** The tree as Markdown, as it reads outside Notes (`readableTree`): a page
 *  by its name, its rows too, and a date written out — line by line as the
 *  editor draws them (`layout`), a block's paragraphs at the level it sits
 *  and a list numbered as it shows. */
export function blockTreeToMarkdown(source: BlockTree, titleOf: (pageId: string) => string): string {
  const describe = readableDescriber(titleOf);
  return layout(readableTree(source, titleOf)).rows
    .map(({ block, depth, index }) => `${"  ".repeat(depth)}${markdownLine(block, index, describe)}`)
    .join("\n");
}
