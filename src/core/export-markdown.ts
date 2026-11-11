import { normalizeEmbed } from "./embeds";
import { type DescribeMention, dateLabel, inlinePlainText, inlineReadable } from "./inline-content";
import { tableGrid, tableToMarkdown } from "./simple-table";
import type { Block, BlockTree, InlineContent, InlineMarks, StoredFile } from "./types";
import { layout } from "./block-layout";

/* A page as Markdown outside Notes — copied to the clipboard, or written
   into an export archive (server/export.ts). Outside Notes a mention is its
   words and a file its name; an export may give each file a real place with
   `fileHref`. */

/** Where a file link points: its name unless an export says otherwise. */
export type FileHref = (file: StoredFile) => string;

const fileHref: FileHref = (file) => encodeURI(file.name || "file");

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
export function inlineContentToMarkdown(content: InlineContent, describe: DescribeMention, href: FileHref = fileHref): string {
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
    parts.push(`![${run.mention.file.name}](${href(run.mention.file)})`);
  }
  flush();
  return parts.join("");
}

/** One line as Markdown; `number`, a numbered line's place in its list. */
function markdownLine(block: Block, number: number, describe: DescribeMention, href: FileHref): string {
  const text = inlineContentToMarkdown(block.content, describe, href);
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
    case "table": return tableToMarkdown(tableGrid(block.table), (content) => inlineContentToMarkdown(content, describe, href));
    case "code": return `\`\`\`${block.language ?? ""}\n${inlinePlainText(block.content)}\n\`\`\``;
    // The bytes stay in Notes; outside it a file is its name.
    case "file": return `[${block.file?.name || "file"}](${href(block.file ?? { path: "", owner: "", name: "file", size: 0, type: "" })})${text ? ` ${text}` : ""}`;
    // Outside Notes a card is its link.
    case "embed": return normalizeEmbed(block.embed)?.url ?? "";
    default: return text;
  }
}

/** How mentions read once they leave Notes — copied as HTML or Markdown:
 *  a page as its name, a date written out. */
export function readableDescriber(titleOf: (pageId: string) => string): DescribeMention {
  return (mention) => ({
    label: mention.kind === "page" ? titleOf(mention.page_id) || "Untitled"
      : mention.kind === "image" ? mention.file.name
        : dateLabel(mention.date),
  });
}

/** Page mentions as Obsidian wikilinks: `[[Title]]` keeps the link alive in
 *  any vault, and an Obsidian import resolves it back to a mention. A title
 *  holding `]]` falls back to its words. */
export function wikilinkDescriber(titleOf: (pageId: string) => string): DescribeMention {
  const plain = readableDescriber(titleOf);
  return (mention) => {
    const view = plain(mention);
    if (mention.kind === "page" && !view.label.includes("]]")) view.label = `[[${view.label}]]`;
    return view;
  };
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
export function blockTreeToMarkdown(source: BlockTree, titleOf: (pageId: string) => string, href: FileHref = fileHref, describe: DescribeMention = readableDescriber(titleOf)): string {
  // Layout runs on the stored tree so `describe` can render mentions (an export
  // writes `[[wikilinks]]`); only code blocks pre-flatten, where a mention
  // reads as its words inside the fence.
  const readable = readableTree(source, titleOf);
  return layout(source).rows
    .map(({ block, depth, index }) => `${"  ".repeat(depth)}${markdownLine(block.kind === "code" ? readable.by_id[block.id] ?? block : block, index, describe, href)}`)
    .join("\n");
}
