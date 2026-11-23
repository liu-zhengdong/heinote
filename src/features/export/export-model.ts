import { pageName } from "../../core/block-tree";
import { descendantPageIds } from "../../core/page-tree";
import { cleanAttachmentPath, Namer } from "../../core/export-names";
import type { NotePage, StoredFile } from "../../core/types";
import type { PlatformClient } from "../../platform/client";

/* The export's model of a page tree — what the builders (Markdown, HTML)
   share: which pages are in, where each file lands, and how an attachment
   or a page maps to a path inside the archive. */

export type ExportFormat = "markdown" | "html" | "csv";

/** A page inside the archive: where it sits, and the name its file claims. */
export interface Entry {
  page: NotePage;
  /** Directory the file lives in, ending with `/`; "" at the root. */
  dir: string;
  /** The file's name without its extension, already deduplicated. */
  base: string;
}

export interface ExportPage {
  root: NotePage;
  entries: Entry[];
  /** Every reachable page, for resolving mentions and relations. */
  pages: Map<string, NotePage>;
  /** Attachment paths the export references, stored path → file. */
  files: Map<string, StoredFile>;
}

/** The pages under `root`, ordered as a tree: parent first, children by
 *  their position. Only live pages — nothing in the trash is exported. */
function exportEntries(pages: Record<string, NotePage>, root: NotePage): Entry[] {
  const namers = new Map<string, Namer>();
  const namerOf = (dir: string) => {
    let namer = namers.get(dir);
    if (!namer) { namer = new Namer(); namers.set(dir, namer); }
    return namer;
  };
  const childrenOf = (id: string) =>
    descendantPageIds(pages, id)
      .map((child) => pages[child])
      .filter((page): page is NotePage => Boolean(page && !page.archived && page.parent_id === id));
  const entries: Entry[] = [];
  const walk = (page: NotePage, dir: string) => {
    const base = namerOf(dir).claim(pageName(page));
    entries.push({ page, dir, base });
    const inner = `${dir}${base}/`;
    for (const child of childrenOf(page.id)) walk(child, inner);
  };
  walk(root, "");
  return entries;
}

/** Every stored file a page mentions — its images, its file blocks, its
 *  covers and icons, its image and file properties. Preview files ship too:
 *  a reader drawing a thumb reads them. */
function referencedFiles(pages: Map<string, NotePage>): Map<string, StoredFile> {
  const found = new Map<string, StoredFile>();
  const hold = (file: StoredFile | undefined) => {
    if (!file) return;
    for (const path of [file.path, file.preview]) {
      if (path) found.set(path, file);
    }
  };
  for (const page of pages.values()) {
    hold(page.cover_image);
    hold(page.icon_image);
    for (const list of Object.values(page.property_files ?? {})) list.forEach(hold);
    for (const block of Object.values(page.block_tree?.by_id ?? {})) {
      if (block.kind === "file") hold(block.file);
      for (const run of block.content ?? []) {
        if (run.mention?.kind === "image") hold(run.mention.file);
      }
    }
  }
  return found;
}

/** What the export needs of the window: the pages map (live state), a file
 *  reader for attachment bytes, and a page loader so bodies are present. */
export interface ExportSource {
  pages: Record<string, NotePage>;
  files: PlatformClient["files"];
  loadPages(pageIds: readonly string[]): Promise<void>;
}

/** Pull the whole subtree's bodies in, then build the export's model of
 *  `root` — the page as the member sees it now. */
export async function exportPages(source: ExportSource, rootId: string): Promise<ExportPage> {
  const ids = descendantPageIds(source.pages, rootId).filter((id) => !source.pages[id]?.archived);
  await source.loadPages([rootId, ...ids]);
  // Re-read state after loading: bodies may have arrived mid-walk.
  const pages = source.pages;
  const root = pages[rootId];
  const entries = exportEntries(pages, root);
  const reachable = new Map<string, NotePage>();
  for (const { page } of entries) reachable.set(page.id, page);
  return { root, entries, pages: reachable, files: referencedFiles(reachable) };
}

/** The zip path an attachment takes — under attachments/, by its own path. */
export function attachmentZipPath(file: StoredFile | string): string | null {
  const path = typeof file === "string" ? file : file.path;
  const cleaned = cleanAttachmentPath(path);
  return cleaned ? `attachments/${cleaned}` : null;
}

/** A relative href from one entry's directory to a path inside the zip. */
export function relative(fromDir: string, toPath: string): string {
  const depth = fromDir.split("/").filter(Boolean).length;
  return `${"../".repeat(depth)}${toPath}`;
}
