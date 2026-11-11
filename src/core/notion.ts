import { BLOCK_ORDER_STEP, createBlock } from "./block-tree";
import { markdownToBlockTree } from "./markdown-blocks";
import { markdownInlineToContent } from "./inline-markdown";
import { normalizeInlineContent } from "./inline-content";
import { tableFromCells } from "./simple-table";
import type { Block, InlineContent } from "./types";
import type { VaultEntry, ResolveHooks } from "./obsidian";

/* The notes app's own Markdown export: every page a `Title [id].md` file,
 *  child pages inside a folder of the same title, page links as Markdown
 *  links to the target's file and as `<mention url>` / `<page url>` elements
 *  (the file's name suffix is the page url's last hex digits). Tables,
 *  callouts, toggles and inline databases keep their markup, so a page
 *  reads as element blocks plus ordinary Markdown between them. */

/** The page's own name without its id suffix: `Title [dec4fc989c7e]` → `Title`. */
export function notionTitle(fileName: string): string {
  return fileName.replace(/\s*\[[0-9a-f]{8,32}\]\s*$/, "");
}

/** The page id a Notion url points at — the trailing hex — or null. */
export function notionPageId(url: string): string | null {
  const match = /\/(?:p\/)?([0-9a-f]{32})/i.exec(url);
  if (match) return match[1].slice(-12);
  const bare = /([0-9a-f]{8,32})\/?$/i.exec(url.trim());
  return bare ? bare[1].toLowerCase() : null;
}

export interface NotionIndex {
  /** `url` hex suffix → the note it points at. */
  pageOf: (url: string) => VaultEntry | undefined;
  /** Attachment file name → entry. */
  fileOf: (name: string) => VaultEntry | undefined;
  /** All attachment entries. */
  attachments: VaultEntry[];
}

/** Index a Notion export: page notes by the id in their file name, other
 *  files by basename. */
export function indexNotion(entries: VaultEntry[]): NotionIndex {
  const byId = new Map<string, VaultEntry>();
  const byName = new Map<string, VaultEntry>();
  const attachments: VaultEntry[] = [];
  for (const entry of entries) {
    const base = entry.path.split("/").at(-1)!;
    if (entry.path.toLowerCase().endsWith(".md")) {
      const suffix = /\[([0-9a-f]{8,32})\]\.md$/i.exec(base);
      if (suffix) byId.set(suffix[1].toLowerCase(), entry);
      // Title-only links also resolve: `[x](Inbox [f95a87ecec55].md)` is
      // read as a file path first, so keep the full path too.
      byName.set(base.toLowerCase(), entry);
      byName.set(entry.path.toLowerCase(), entry);
    } else {
      attachments.push(entry);
      byName.set(base.toLowerCase(), entry);
      byName.set(entry.path.toLowerCase(), entry);
    }
  }
  return {
    pageOf: (url) => {
      const id = notionPageId(url);
      return id ? byId.get(id) : undefined;
    },
    fileOf: (name) => byName.get(name.toLowerCase()),
    attachments,
  };
}

/* ── Inline markup inside a run of words ───────────────────────────────── */

const MENTION = "￼";

/** Inline elements a Notion line carries: `<mention url>title</mention>` →
 *  a page mention, `<date start=…>` → a date mention, `<b>/<i>/<code>` →
 *  Markdown's own marks. Reads one line. */
function notionInline(index: NotionIndex, hooks: ResolveHooks): (text: string) => InlineContent {
  const pattern = /<mention url="([^"]+)">([^<]*)<\/mention>|<date start="([^"]+)"[^/>]*\/>|<b>([\s\S]*?)<\/b>|<i>([\s\S]*?)<\/i>|<code>([\s\S]*?)<\/code>|!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[([^\]\n]+)\]\(([^)\s]+\.md)(?:#[^)\s]*)?\)/g;
  return (original) => {
    // The export writes `[x](file name.md)` unescaped: encode spaces in the
    // target so the link reads as one address.
    const text = original.replace(/\]\(([^()]*\.md[^()]*)\)/g,
      (_all, target: string) => `](${target.replace(/ /g, "%20")})`);
    const runs: InlineContent = [];
    let at = 0;
    for (const match of text.matchAll(pattern)) {
      const [raw, mUrl, mText, date, bold, italic, code, alt, img, label, mdPage] = match;
      const before = text.slice(at, match.index!);
      if (before) runs.push(...markdownInlineToContent(before));
      at = match.index! + raw.length;
      if (mUrl !== undefined) {
        const page = index.pageOf(mUrl);
        if (page) runs.push({ text: MENTION, mention: { kind: "page", page_id: hooks.pageIdOf(page) } });
        else { hooks.unresolved(mText || mUrl); runs.push({ text: mText || mUrl }); }
      } else if (date !== undefined) {
        runs.push({ text: MENTION, mention: { kind: "date", date } });
      } else if (bold !== undefined) {
        runs.push(...notionInline(index, hooks)(bold).map((run) => ({ ...run, marks: { ...run.marks, bold: true } })));
      } else if (italic !== undefined) {
        runs.push(...notionInline(index, hooks)(italic).map((run) => ({ ...run, marks: { ...run.marks, italic: true } })));
      } else if (code !== undefined) {
        runs.push({ text: code, marks: { code: true } });
      } else if (img !== undefined) {
        const file = index.fileOf(decodeURIComponent(img).split("/").at(-1)!);
        const stored = file ? hooks.storedOf(file) : undefined;
        if (stored) runs.push({ text: MENTION, mention: { kind: "image", file: stored } });
        else runs.push(...markdownInlineToContent(`![${alt}](${img})`));
      } else {
        const target = decodeURIComponent(mdPage);
        const page = index.fileOf(target) ?? index.fileOf(target.split("/").at(-1)!);
        if (page && page.path.toLowerCase().endsWith(".md")) {
          runs.push({ text: MENTION, mention: { kind: "page", page_id: hooks.pageIdOf(page) } });
        } else {
          runs.push(...markdownInlineToContent(`[${label}](${mdPage})`));
        }
      }
    }
    if (at < text.length) runs.push(...markdownInlineToContent(text.slice(at)));
    return normalizeInlineContent(runs);
  };
}

/* ── The element blocks a page reads as ─────────────────────────────────── */

const ELEMENT = /^<(page|database|table|callout|toggle|image|date)\b/;

interface ElementBlock {
  tag: string;
  attrs: Record<string, string>;
  /** Text between the tags: a toggle's title + body, a callout's body. */
  body: string;
  /** Self-closing or empty element. */
  inlineOnly?: boolean;
}

const attr = (attrs: string): Record<string, string> =>
  Object.fromEntries([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));

/** Lines → element blocks and ordinary Markdown stretches, in order. */
function splitElements(lines: string[]): Array<ElementBlock | { markdown: string[] }> {
  const parts: Array<ElementBlock | { markdown: string[] }> = [];
  const plain = () => {
    const last = parts.at(-1);
    if (last && "markdown" in last) return last.markdown;
    const fresh: string[] = [];
    parts.push({ markdown: fresh });
    return fresh;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const open = ELEMENT.exec(line.trim());
    if (!open) {
      plain().push(line);
      continue;
    }
    const tag = open[1];
    const head = /^(<[^>]+>)/.exec(line.trim())![1];
    if (tag === "image" || tag === "date" || /<\/[a-z]+>\s*$/.test(head) || /\/>$/.test(head)) {
      parts.push({ tag, attrs: attr(head), body: "", inlineOnly: true });
      continue;
    }
    // Collect until the matching close tag.
    const close = `</${tag}>`;
    const body: string[] = [];
    let tail = line.trim().slice(head.length);
    if (tail === close) tail = "";
    if (tail) body.push(tail);
    while (i + 1 < lines.length && !lines[i + 1].includes(close)) {
      i += 1;
      body.push(lines[i]);
    }
    if (i + 1 < lines.length) {
      i += 1;
      const lastLine = lines[i];
      const end = lastLine.indexOf(close);
      if (end > 0) body.push(lastLine.slice(0, end));
      const after = lastLine.slice(end + close.length).trim();
      if (after) plain().push(after);
    }
    parts.push({ tag, attrs: attr(head), body: body.join("\n") });
  }
  return parts;
}

/* ── A page → blocks ────────────────────────────────────────────────────── */

const CALLOUT_COLORS: Record<string, string> = {
  gray_bg: "gray", blue_bg: "blue", green_bg: "green", yellow_bg: "yellow",
  orange_bg: "orange", red_bg: "red", purple_bg: "purple", brown_bg: "brown", pink_bg: "pink",
};

/** The file an `<image source="file://…">` names: its attachment file name. */
function imageFileName(source: string): string | null {
  const plain = decodeURIComponent(source);
  const attachment = /attachment:[0-9a-f-]{36}:([^"%]+)/i.exec(plain);
  if (attachment) return attachment[1];
  const tail = plain.split("/").at(-1);
  return tail && tail.includes(".") ? tail : null;
}

function markdownChildren(text: string, index: NotionIndex, hooks: ResolveHooks, idFactory: () => string): Block[] {
  // The export escapes punctuation as \_ and \* inside words; the reader
  // here does not collapse them, so drop the backslashes out of prose.
  const cleaned = text
    .replace(/\\([_*`~#|>+()\[\]{}.!-])/g, "$1")
    .replace(/<p\s*\/>|<research-dir>|<\/p>/g, "");
  return Object.values(markdownToBlockTree(cleaned, idFactory, notionInline(index, hooks)).by_id)
    .sort((a, b) => a.order - b.order);
}

/**
 * An export page's Markdown → the page's blocks, in document order.
 * Elements not modeled keep readable text (an inline `<database>` becomes a
 * page mention when its url resolves, else its title).
 */
export function notionPageToBlocks(
  markdown: string,
  index: NotionIndex,
  hooks: ResolveHooks,
  idFactory: () => string,
): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  // The first heading repeats the file's title; drop it.
  const first = lines.findIndex((line) => line.trim());
  if (first >= 0 && /^#\s/.test(lines[first].trim())) lines.splice(first, 1);
  const parts = splitElements(lines);
  const blocks: Block[] = [];
  const push = (block: Partial<Block> & Pick<Block, "kind" | "content">, parent: string | null, slot: number) => {
    const made = createBlock(idFactory(), block.kind, { ...block, parent_id: parent, order: (slot + 1) * BLOCK_ORDER_STEP });
    blocks.push(made);
    return made.id;
  };
  let slot = 0;
  const emit = (part: ElementBlock | { markdown: string[] }, parent: string | null) => {
    if ("markdown" in part) {
      for (const child of markdownChildren(part.markdown.join("\n"), index, hooks, idFactory)) {
        if (!child.parent_id) {
          child.parent_id = parent;
          child.order = ++slot * BLOCK_ORDER_STEP;
          blocks.push(child);
        } else {
          child.order = (blocks.length + 1) * BLOCK_ORDER_STEP;
          blocks.push(child);
        }
      }
      return;
    }
    const { tag, attrs, body } = part;
    slot += 1;
    if (tag === "page" || tag === "database") {
      const page = index.pageOf(attrs.url ?? "");
      const title = body.trim();
      const content: InlineContent = page
        ? [{ text: MENTION, mention: { kind: "page", page_id: hooks.pageIdOf(page) } }]
        : [{ text: title || "数据库", marks: { link: attrs.url } }];
      push({ kind: "text", content }, parent, slot);
    } else if (tag === "table") {
      const rows = [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) =>
        [...row[1].matchAll(/<td>([\s\S]*?)<\/td>/g)].map((cell) => cell[1].trim().replace(/\n+/g, "<br>")));
      if (rows.length) {
        const cells = rows.map((row) => row.map((cell) => notionInline(index, hooks)(cell)));
        push({ kind: "table", content: [], table: tableFromCells(cells, idFactory, { headerRow: attrs["header-row"] === "true" }) }, parent, slot);
      }
    } else if (tag === "callout") {
      const color = CALLOUT_COLORS[attrs.color ?? ""];
      const firstLine = body.split("\n")[0]?.trim() ?? "";
      push({ kind: "callout", content: notionInline(index, hooks)(firstLine), icon: attrs.icon, ...(color ? { color: color as Block["color"] } : {}) }, parent, slot);
    } else if (tag === "toggle") {
      const [titleLine, ...rest] = body.split("\n");
      const id = push({ kind: "bullet", content: notionInline(index, hooks)(titleLine?.trim() ?? "") }, parent, slot);
      // A toggle's body nests under its title as indented content.
      for (const child of notionToBlocksInner(rest.join("\n"), index, hooks, idFactory)) {
        child.parent_id = child.parent_id ?? id;
        child.order = blocks.length * BLOCK_ORDER_STEP;
        blocks.push(child);
      }
    } else if (tag === "image") {
      const name = imageFileName(attrs.source ?? "");
      const file = name ? index.fileOf(name) : undefined;
      const stored = file ? hooks.storedOf(file) : undefined;
      if (stored) push({ kind: "file", content: [], file: stored, name: stored.name }, parent, slot);
      else push({ kind: "text", content: [{ text: `（缺失图片：${name ?? "image"}）` }] }, parent, slot);
    } else if (tag === "date") {
      push({ kind: "text", content: [{ text: MENTION, mention: { kind: "date", date: attrs.start ?? "" } }] }, parent, slot);
    }
  };
  for (const part of parts) emit(part, null);
  return blocks;
}

/** Inner content of toggles/callouts: elements and Markdown recurse. */
function notionToBlocksInner(markdown: string, index: NotionIndex, hooks: ResolveHooks, idFactory: () => string): Block[] {
  const parts = splitElements(markdown.split("\n"));
  const blocks: Block[] = [];
  for (const part of parts) {
    if ("markdown" in part) {
      blocks.push(...markdownChildren(part.markdown.join("\n"), index, hooks, idFactory));
    } else {
      // A nested element reads as one text row carrying its words.
      const page = index.pageOf(part.attrs.url ?? "");
      const title = part.body.trim().split("\n")[0];
      blocks.push(createBlock(idFactory(), "text", {
        content: page ? [{ text: MENTION, mention: { kind: "page", page_id: hooks.pageIdOf(page) } }] : [{ text: title }],
      }));
    }
  }
  return blocks;
}
