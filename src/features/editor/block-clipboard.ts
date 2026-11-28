/* Blocks on the clipboard.

   Copying blocks puts three things on the clipboard, the way Notion does: the
   blocks themselves, for pasting back into HeiNote exactly — kinds, nesting,
   marks, checkboxes, the pages behind page blocks; HTML, for a rich-text
   editor elsewhere; and Markdown, for plain text. The blocks ride under their
   own type and again inside the HTML, because some clipboards (another
   browser, an app shell) keep only the standard types.

   Anything read back is untrusted — it may have been copied from any page on
   the web — so it goes through the same normalisation as stored content:
   unknown kinds become text and only safe links survive. */

import { normalizeBlockTree, orderedBlocks } from "../../core/block-tree";
import { blobToDataUrl, canCopyImage, copyImageBlob } from "../../core/clipboard";
import { normalizeEmbed } from "../../core/embeds";
import { escapeHtml, inlinePlainText, inlineToHtml, soleImage } from "../../core/inline-content";
import { alignOf, colorOf, spanCovering, spansInRect, tableCells, tableGrid, tableToHtml, type CellRect } from "../../core/simple-table";
import type { Block, BlockKind, BlockTree, Mention } from "../../core/types";
import { blockTreeToMarkdown, markdownToBlockTree, readableTree } from "./adapters";
import { BLOCK_DEFINITIONS } from "./block-registry";

export const BLOCKS_MIME = "application/x-notes-blocks";

export interface CopiedBlocks {
  /** The blocks as a body of their own: top-level blocks are its roots. */
  tree: BlockTree;
  /** Cut rather than copied. Pasting a cut page block moves the page. */
  cut: boolean;
  /** The page the blocks came from. */
  source: string;
}

interface Payload {
  notes: 1;
  cut: boolean;
  source: string;
  blocks: Block[];
}

const KINDS = new Set<BlockKind>(BLOCK_DEFINITIONS.map((definition) => definition.kind));
const LIST_TAG: Partial<Record<BlockKind, "ul" | "ol">> = { bullet: "ul", todo: "ul", numbered: "ol" };

function blocksHtml(tree: BlockTree, parentId: string | null): string {
  let html = "";
  let open: "ul" | "ol" | null = null;
  for (const block of orderedBlocks(tree, parentId)) {
    const list = LIST_TAG[block.kind] ?? null;
    if (open !== list) {
      if (open) html += `</${open}>`;
      if (list) html += `<${list}>`;
      open = list;
    }
    const inner = inlineToHtml(block.content);
    const children = blocksHtml(tree, block.id);
    switch (block.kind) {
      case "heading1": html += `<h1>${inner}</h1>${children}`; break;
      case "heading2": html += `<h2>${inner}</h2>${children}`; break;
      case "heading3": html += `<h3>${inner}</h3>${children}`; break;
      case "heading4": html += `<h4>${inner}</h4>${children}`; break;
      case "heading5": html += `<h5>${inner}</h5>${children}`; break;
      case "todo": html += `<li>${block.checked ? "☑" : "☐"} ${inner}${children}</li>`; break;
      case "bullet":
      case "numbered": html += `<li>${inner}${children}</li>`; break;
      case "quote": html += `<blockquote>${inner}</blockquote>${children}`; break;
      case "code": html += `<pre><code>${escapeHtml(inlinePlainText(block.content))}</code></pre>`; break;
      case "equation": html += `<p>$$${escapeHtml(inlinePlainText(block.content))}$$</p>`; break;
      case "divider": html += "<hr>"; break;
      case "table": {
        const grid = tableGrid(block.table);
        // The copy takes the whole grid: its merges and every cell's
        // alignment and fill travel with it.
        const whole: CellRect = { row: 0, column: 0, rows: grid.rows.length, columns: grid.columns.length };
        const alignments = grid.rows.map((_, r) => grid.columns.map((_, c) => {
          const covered = spanCovering(grid, r, c);
          return alignOf(grid, covered?.rect.row ?? r, covered?.rect.column ?? c);
        }));
        const fills = grid.rows.map((_, r) => grid.columns.map((_, c) => {
          const covered = spanCovering(grid, r, c);
          return colorOf(grid, covered?.rect.row ?? r, covered?.rect.column ?? c);
        }));
        html += tableToHtml(tableCells(grid), grid.header_row, spansInRect(grid, whole), alignments, fills);
        break;
      }
      // A block is its paragraphs; outside HeiNote it has no mark of its own.
      case "page": html += children; break;
      case "file": html += `<p>${escapeHtml(block.file?.name ?? "")}${inner ? ` — ${inner}` : ""}</p>`; break;
      case "embed": {
        const address = normalizeEmbed(block.embed)?.url;
        if (address) html += `<p><a href="${escapeHtml(address)}">${escapeHtml(address)}</a></p>`;
        break;
      }
      default: html += `<p>${inner}</p>${children}`;
    }
  }
  if (open) html += `</${open}>`;
  return html;
}

const MAX_INLINE_HTML_IMAGE_BYTES = 4 * 1024 * 1024;

/** When a copied fragment contains exactly one block whose only content is one
 *  image, returns that image mention so the clipboard can also carry its pixels. */
export function singleCopiedImage(tree: BlockTree): Extract<Mention, { kind: "image" }> | null {
  const blocks = Object.values(tree.by_id);
  if (blocks.length !== 1) return null;
  const block = blocks[0];
  if (!block || block.kind === "code" || block.kind === "file" || block.kind === "table" || block.kind === "embed" || block.kind === "divider" || block.kind === "page") {
    return null;
  }
  return soleImage(block.content)?.mention ?? null;
}

export function writeBlocks(
  data: DataTransfer,
  copied: CopiedBlocks,
  titleOf: (pageId: string) => string,
): void {
  const payload: Payload = { notes: 1, cut: copied.cut, source: copied.source, blocks: Object.values(copied.tree.by_id) };
  const json = JSON.stringify(payload);
  data.setData(BLOCKS_MIME, json);
  data.setData("text/html", `<meta charset="utf-8"><div data-notes-blocks="${escapeHtml(json)}">${blocksHtml(readableTree(copied.tree, titleOf), null)}</div>`);
  data.setData("text/plain", blockTreeToMarkdown(copied.tree, titleOf));
}

/** Upgrades a single-image block copy to carry `image/png` pixels alongside the
 *  HeiNote block payload in `text/html` (with an inline `<img>` for external
 *  rich-text editors) and Markdown in `text/plain`. Returns false if the
 *  selection is not a single image or image clipboard write is unavailable. */
export function copySingleImageBlocks(
  copied: CopiedBlocks,
  titleOf: (pageId: string) => string,
  loadBlob: (image: Extract<Mention, { kind: "image" }>) => Promise<Blob>,
): Promise<void> | null {
  const image = singleCopiedImage(copied.tree);
  if (!image || !canCopyImage()) return null;
  const payload: Payload = { notes: 1, cut: copied.cut, source: copied.source, blocks: Object.values(copied.tree.by_id) };
  const json = JSON.stringify(payload);
  const plain = blockTreeToMarkdown(copied.tree, titleOf);
  return copyImageBlob(
    () => loadBlob(image),
    (pngPromise) => ({
      "text/html": pngPromise.then(async (png) => {
        const imgTag = png.size <= MAX_INLINE_HTML_IMAGE_BYTES
          ? `<img src="${await blobToDataUrl(png)}" alt="${escapeHtml(image.file.name)}">`
          : "";
        return new Blob(
          [`<meta charset="utf-8"><div data-notes-blocks="${escapeHtml(json)}">${imgTag}</div>`],
          { type: "text/html" },
        );
      }),
      "text/plain": new Blob([plain], { type: "text/plain" }),
    }),
  );
}

/* The blocks inside copied HTML: a browser re-serialises it (wrapping it,
   re-quoting it), and reading it as a document undoes whatever it did. */
function payloadFromHtml(html: string): string {
  if (!html.includes("data-notes-blocks")) return "";
  const holder = new DOMParser().parseFromString(html, "text/html").querySelector("[data-notes-blocks]");
  return holder?.getAttribute("data-notes-blocks") ?? "";
}

/** Blocks copied from HeiNote, or null for anything else. */
export function readBlocks(data: DataTransfer): CopiedBlocks | null {
  const raw = data.getData(BLOCKS_MIME) || payloadFromHtml(data.getData("text/html"));
  if (!raw) return null;
  let payload: Partial<Payload>;
  try {
    payload = JSON.parse(raw) as Partial<Payload>;
  } catch {
    return null;
  }
  if (payload?.notes !== 1 || !Array.isArray(payload.blocks)) return null;
  const candidates = Object.fromEntries(payload.blocks
    .filter((block): block is Block => Boolean(block) && typeof block === "object" && typeof block.id === "string")
    .map((block) => [block.id, { ...block, kind: KINDS.has(block.kind) ? block.kind : "text" }]));
  const tree = normalizeBlockTree({ by_id: candidates });
  // A block whose parent did not come along is a root of what was copied.
  for (const block of Object.values(tree.by_id)) {
    if (block.parent_id && !tree.by_id[block.parent_id]) block.parent_id = null;
  }
  if (!Object.keys(tree.by_id).length) return null;
  return { tree, cut: payload.cut === true, source: typeof payload.source === "string" ? payload.source : "" };
}

/** Text of more than one line — or a standalone display equation (`$$...$$` /
 *  `\[...\]`) — as blocks, with Markdown read as the blocks it describes.
 *  A single ordinary line is left to inline paste handling. */
export function textToBlocks(text: string, idFactory: () => string): BlockTree | null {
  const trimmed = text.trim();
  const singleDisplayMath = /^\$\$(.+?)\$\$$/.test(trimmed) || /^\\\[(.+?)\\\]$/.test(trimmed);
  if (!/\r?\n/.test(trimmed) && !singleDisplayMath) return null;
  const tree = markdownToBlockTree(text, idFactory);
  return Object.keys(tree.by_id).length ? tree : null;
}
