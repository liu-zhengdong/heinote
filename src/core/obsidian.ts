import { markdownToBlockTree } from "./markdown-blocks";
import { markdownInlineToContent } from "./inline-markdown";
import { normalizeInlineContent } from "./inline-content";
import { isImageType } from "./files";
import type { Block, InlineContent, StoredFile } from "./types";

/* An Obsidian vault as it maps onto HeiNote: every .md a page under the
   folder's page, [[links]] page mentions, ![[embeds]] the picture's inline
   mention or a file paragraph, frontmatter kept as a yaml code block.
   Resolution follows Obsidian's rule: a link names the page whose path is
   shortest among its basename's holders. */

/** A vault member, mapped from a zip entry or a picked folder's files. */
export interface VaultEntry {
  /** Path inside the vault, slashes, no leading slash. */
  path: string;
  /** Bytes, already read. */
  bytes: Uint8Array;
  /** Media type, when known. */
  type?: string;
}

export interface VaultPlan {
  /** Vault display name: the top folder of a picked vault, or the zip's. */
  name: string;
  /** Markdown notes, in path order. */
  notes: VaultEntry[];
  /** Other files: attachments, kept for ![[embeds]] and completeness. */
  attachments: VaultEntry[];
  /** The vault marker, when the source held .obsidian/. */
  configured: boolean;
}

const HIDDEN = /(^|\/)\.[^/]+/;

/** Files under one folder as a vault plan: hidden files skipped except the
 *  .obsidian marker itself (its presence is what proves the folder is a
 *  vault; its contents are not imported). A single shared top folder is
 *  the vault's own directory and is stripped from member paths. */
export function planVault(entries: VaultEntry[]): VaultPlan | null {
  const notes: VaultEntry[] = [];
  const attachments: VaultEntry[] = [];
  let configured = false;
  let common: string | undefined;
  for (const entry of entries) {
    const path = entry.path.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!path) continue;
    const segments = path.split("/");
    if (segments.includes(".obsidian")) {
      configured = true;
      continue;
    }
    if (HIDDEN.test(path)) continue;
    if (segments.length === 1) {
      // A member at the archive's root means no shared vault folder.
      common = undefined;
    } else if (common === undefined) {
      common = segments[0];
    } else if (common !== segments[0]) {
      common = "";
    }
    if (path.toLowerCase().endsWith(".md")) notes.push({ ...entry, path });
    else attachments.push({ ...entry, path });
  }
  if (!notes.length) return null;
  const strip = common ? `${common}/` : "";
  const clean = (path: string) => path.startsWith(strip) ? path.slice(strip.length) : path;
  const remap = (list: VaultEntry[]) => list
    .map((entry) => ({ ...entry, path: clean(entry.path) }))
    .filter((entry) => entry.path && !HIDDEN.test(entry.path));
  return {
    name: common || "Obsidian 库",
    notes: remap(notes).sort((a, b) => a.path.localeCompare(b.path)),
    attachments: remap(attachments).sort((a, b) => a.path.localeCompare(b.path)),
    configured,
  };
}

/* ── Link resolution ────────────────────────────────────────────────────── */

interface VaultIndex {
  /** Basename (lowercase, no ext) → note entries, shortest path first. */
  notes: Map<string, VaultEntry[]>;
  /** Full vault path (lowercase, with and without .md) → entry. */
  byPath: Map<string, VaultEntry>;
  /** Basename with ext (lowercase) → attachment entries, shortest first. */
  files: Map<string, VaultEntry[]>;
}

export function indexVault(plan: VaultPlan): VaultIndex {
  const index: VaultIndex = { notes: new Map(), byPath: new Map(), files: new Map() };
  const push = (map: Map<string, VaultEntry[]>, key: string, entry: VaultEntry) => {
    const list = map.get(key) ?? [];
    list.push(entry);
    list.sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
    map.set(key, list);
  };
  for (const note of plan.notes) {
    const base = note.path.split("/").at(-1)!.replace(/\.md$/i, "").toLowerCase();
    push(index.notes, base, note);
    index.byPath.set(note.path.toLowerCase(), note);
    index.byPath.set(note.path.toLowerCase().replace(/\.md$/i, ""), note);
  }
  for (const file of plan.attachments) {
    const base = file.path.split("/").at(-1)!.toLowerCase();
    push(index.files, base, file);
    index.byPath.set(file.path.toLowerCase(), file);
  }
  return index;
}

const decode = (value: string) => {
  try { return decodeURIComponent(value); } catch { return value; }
};

/** Obsidian's lookup for `[[target]]`: an exact path wins; a path ending
 *  names the note at its tail; a bare name picks the shortest-path holder. */
function resolve(index: VaultIndex, target: string): VaultEntry | undefined {
  const key = decode(target.replace(/#.*$/, "").trim()).toLowerCase();
  if (!key) return undefined;
  const direct = index.byPath.get(key) ?? index.byPath.get(`${key}.md`);
  if (direct) return direct;
  if (key.includes("/")) {
    const candidates = index.notes.get(key.split("/").at(-1)!);
    return candidates?.find((entry) => entry.path.toLowerCase().replace(/\.md$/i, "").endsWith(key));
  }
  return index.notes.get(key)?.[0];
}

function resolveFile(index: VaultIndex, target: string): VaultEntry | undefined {
  const key = decode(target.replace(/#.*$/, "").trim()).toLowerCase();
  if (!key) return undefined;
  const direct = index.byPath.get(key);
  if (direct) return direct;
  if (key.includes("/")) {
    const base = key.split("/").at(-1)!;
    return index.files.get(base)?.find((entry) => entry.path.toLowerCase().endsWith(key));
  }
  return index.files.get(key)?.[0];
}

/* ── Markdown → blocks, with wikilinks and embeds ───────────────────────── */

export interface ResolveHooks {
  /** `[[name]]` → the imported page's id. */
  pageIdOf(note: VaultEntry): string;
  /** `![[file]]` or `![](file)` → the stored file, or undefined. */
  storedOf(file: VaultEntry): StoredFile | undefined;
  /** Links that resolved nowhere, for the import report. */
  unresolved(target: string): void;
}

const MENTION = "￼";

/** `parseMarkdown`'s inline reader for a vault line: Obsidian's wikilinks
 *  and picture embeds become mentions, Markdown links to vault notes and
 *  files follow, and the rest reads as ordinary Markdown. A `![[file]]` on
 *  a line of its own that is not a picture becomes a file paragraph —
 *  `noteToBlocks` lifts those before the line is read. */
export function obsidianInline(index: VaultIndex, hooks: ResolveHooks): (text: string) => InlineContent {
  const pattern = /!?\[\[([^\]\n]+)\]\]|!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[([^\]\n]+)\]\(([^)\s]+\.md)(?:#[^)\s]*)?(?:\s+"[^"]*")?\)/g;
  return (text) => {
    const runs: InlineContent = [];
    let at = 0;
    for (const match of text.matchAll(pattern)) {
      const [raw, wiki, alt, mdImg, label, mdPage] = match;
      const before = text.slice(at, match.index!);
      if (before) runs.push(...markdownInlineToContent(before));
      at = match.index! + raw.length;
      if (wiki !== undefined) {
        const embed = raw.startsWith("!");
        const target = wiki.split("|")[0].trim();
        const alias = wiki.includes("|") ? wiki.split("|").slice(1).join("|").trim() : "";
        if (!embed) {
          const note = resolve(index, target);
          if (note) runs.push({ text: MENTION, mention: { kind: "page", page_id: hooks.pageIdOf(note) } });
          else { hooks.unresolved(target); runs.push({ text: alias || target }); }
        } else {
          const file = resolveFile(index, target);
          const stored = file ? hooks.storedOf(file) : undefined;
          if (stored && isImageType(stored.type)) runs.push({ text: MENTION, mention: { kind: "image", file: stored } });
          else if (stored) runs.push({ text: stored.name });
          else { hooks.unresolved(target); runs.push({ text: alias || target }); }
        }
      } else if (mdImg !== undefined) {
        const file = resolveFile(index, mdImg);
        const stored = file ? hooks.storedOf(file) : undefined;
        if (stored && isImageType(stored.type)) {
          runs.push({ text: MENTION, mention: { kind: "image", file: stored } });
        } else {
          runs.push(...markdownInlineToContent(`![${alt}](${mdImg})`));
        }
      } else {
        const note = resolve(index, decode(mdPage));
        if (note) runs.push({ text: MENTION, mention: { kind: "page", page_id: hooks.pageIdOf(note) } });
        else runs.push(...markdownInlineToContent(`[${label}](${mdPage})`));
      }
    }
    if (at < text.length) runs.push(...markdownInlineToContent(text.slice(at)));
    return normalizeInlineContent(runs);
  };
}

/* ── A note → a page's blocks ───────────────────────────────────────────── */

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;
const FILE_LINE = /^!\[\[([^\]]+)\]\]\s*$/;

export function noteToBlocks(
  markdown: string,
  index: VaultIndex,
  hooks: ResolveHooks,
  idFactory: () => string,
): { blocks: Block[]; frontmatter?: string } {
  let body = markdown.replace(/\r\n?/g, "\n");
  let frontmatter: string | undefined;
  const matter = FRONTMATTER.exec(body);
  if (matter) {
    frontmatter = matter[1];
    body = body.slice(matter[0].length);
  }
  // A line that is only `![[file]]` to a non-picture becomes a file
  // paragraph; a picture embed stays inline. Both read inside lists or
  // quotes as ordinary text — Obsidian embeds them inline too.
  const fileLines: VaultEntry[] = [];
  const rest = body.split("\n").map((line) => {
    const embed = FILE_LINE.exec(line.trim());
    if (embed) {
      const file = resolveFile(index, embed[1].split("|")[0].trim());
      const stored = file ? hooks.storedOf(file) : undefined;
      if (stored && !isImageType(stored.type)) {
        fileLines.push(file!);
        return "";
      }
    }
    return line;
  }).join("\n");

  const tree = markdownToBlockTree(rest, idFactory, obsidianInline(index, hooks));
  const blocks = Object.values(tree.by_id).sort((a, b) => a.order - b.order);

  // File paragraphs get their own trailing rows: Obsidian draws an embed
  // where it stands, and the paragraph's order keeps it near its line.
  const files: Block[] = fileLines.map((entry, i) => {
    const stored = hooks.storedOf(entry)!;
    return {
      id: idFactory(),
      kind: "file",
      parent_id: null,
      order: (blocks.at(-1)?.order ?? 0) + (i + 1) * 1024,
      content: [],
      file: stored,
      name: stored.name,
    } as Block;
  });
  const all = [...blocks, ...files];
  if (frontmatter !== undefined) {
    all.unshift({
      id: idFactory(),
      kind: "code",
      parent_id: null,
      order: Math.max(1, Math.floor((all[0]?.order ?? 1024) / 2)),
      content: [{ text: frontmatter }],
      language: "yaml",
    } as Block);
  }
  return { blocks: all.sort((a, b) => a.order - b.order), frontmatter };
}
