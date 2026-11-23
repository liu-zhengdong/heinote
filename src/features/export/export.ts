import { pageName } from "../../core/block-tree";
import { inTrash } from "../../core/page-tree";
import { blockTreeToMarkdown, wikilinkDescriber } from "../../core/export-markdown";
import { safeName } from "../../core/export-names";
import { ZipStream } from "../../core/zip";
import type { NotePage, StoredFile } from "../../core/types";
import { databaseRows, multiValues, relationIds, titleName, visibleProperties, viewRows } from "../database/database-model";
import { buildHtml } from "./export-html";
import { attachmentZipPath, relative, type ExportFormat, type ExportPage, type ExportSource } from "./export-model";

export type { ExportFormat, ExportPage, ExportSource } from "./export-model";
export { exportPages } from "./export-model";

/* One page — or one database — as a downloadable file: Markdown or HTML as
   the window's own read view shows it, CSV as the database's visible view.
   The window's in-memory document is the source of truth (UC-48 loads make
   bodies present), so what downloads is what the member is looking at —
   not a possibly-stale server projection. */

/* ── CSV ───────────────────────────────────────────────────────────────── */

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** What a property value reads as outside HeiNote: stored values as they
 *  are (dates stay ISO so they round-trip), multi-values joined, relations
 *  by name, pictures and files by name. */
function cellText(row: NotePage, property: { id: string; type: string }, pages: Map<string, NotePage>): string {
  const raw = row.properties?.[property.id] ?? "";
  switch (property.type) {
    case "checkbox": return raw === "true" ? "TRUE" : "FALSE";
    case "multi_select": return multiValues(raw).join("; ");
    case "relation": return relationIds(raw).map((id) => { const page = pages.get(id); return page && !inTrash(pages, id) ? pageName(page) : ""; }).filter(Boolean).join("; ");
    case "image":
    case "file": return (row.property_files?.[property.id] ?? []).map((file) => file.name).join("; ");
    default: return raw;
  }
}

/** The database's visible view as CSV: the title column, then the columns
 *  the view shows (hidden stay out), rows in the view's own order. BOM leads
 *  so Excel reads the UTF-8 right. */
export function databaseCsv(database: NotePage, pages: Map<string, NotePage>, viewId?: string): string | null {
  const config = database.database;
  if (!config) return null;
  const view = config.views.find((item) => item.id === viewId) ?? config.views[0];
  if (!view) return null;
  const all = Object.fromEntries(pages.entries());
  const rows = viewRows(databaseRows(all, database.id), view, config.properties, "", (pageId) => all[pageId]?.title);
  const properties = visibleProperties(view, config.properties);
  const header = [titleName(config), ...properties.map((property) => property.name)].map(csvCell);
  const lines = [header.join(",")];
  for (const row of rows) {
    const cells = [csvCell(pageName(row)), ...properties.map((property) => csvCell(cellText(row, property, pages)))];
    lines.push(cells.join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

/* ── Markdown ──────────────────────────────────────────────────────────── */

/** A page's own body as Markdown: database pages get their property and
 *  view lists first, so a database survives as data not only as a table.
 *  Page mentions keep `[[wikilinks]]`; file links point into attachments/. */
export function pageMarkdown(page: NotePage, dir: string, pages: Map<string, NotePage>): string {
  const titleOf = (id: string) => { const target = pages.get(id); return target && !inTrash(pages, id) ? pageName(target) : ""; };
  const fileHref = (file: StoredFile) => {
    const zipPath = attachmentZipPath(file);
    return zipPath ? relative(dir, zipPath) : file.name || "file";
  };
  const markdown = page.block_tree
    ? blockTreeToMarkdown(page.block_tree, titleOf, fileHref, wikilinkDescriber(titleOf))
    : "";
  const name = pageName(page);
  if (page.kind === "database" && page.database) {
    const properties = page.database.properties.map((property) =>
      `- ${property.name}（${property.type}${property.options?.length ? `：${property.options.join("、")}` : ""}）`).join("\n");
    const views = page.database.views.map((view) => `- ${view.name}（${view.kind}）`).join("\n");
    return `# ${name}\n\n## 属性\n\n${properties || "- （无）"}\n\n## 视图\n\n${views || "- （无）"}\n\n${markdown}\n`;
  }
  return markdown ? `# ${name}\n\n${markdown}\n` : `# ${name}\n`;
}

/* ── The archive ───────────────────────────────────────────────────────── */

export interface ExportFile {
  /** The download's file name, extension included. */
  name: string;
  type: string;
  body: Blob;
  /** Attachment paths that could not be read — the export kept going. */
  missing: string[];
}

/** A Blob from everything written into the zip. */
function zipSink(): { sink: { write(chunk: Uint8Array): void }; blob(): Blob } {
  const chunks: Uint8Array[] = [];
  return {
    sink: { write: (chunk) => chunks.push(chunk) },
    blob: () => new Blob(chunks.map((chunk) => new Uint8Array(chunk)), { type: "application/zip" }),
  };
}

/** Downloaded bytes for one stored file, or null when it cannot be read. */
async function fileBytes(files: ExportSource["files"], file: StoredFile, path: string): Promise<Uint8Array | null> {
  try {
    const blob = await files.read(path, { spaceId: file.space });
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

/** Build the export's download: one bare file when nothing more than text
 *  needs shipping; a zip once attachments or child pages ride along. */
export async function buildExport(source: ExportSource, exportPage: ExportPage, format: ExportFormat, options: { viewId?: string } = {}): Promise<ExportFile> {
  const { root, entries, pages, files } = exportPage;
  const missing: string[] = [];

  if (format === "csv") {
    const csv = databaseCsv(root, pages, options.viewId);
    if (csv === null) throw new Error("该页没有可导出的数据库视图。");
    return { name: `${safeName(pageName(root))}.csv`, type: "text/csv", body: new Blob([csv], { type: "text/csv" }), missing };
  }

  const html = format === "html" ? buildHtml(exportPage) : null;
  const needsArchive = files.size > 0 || entries.length > 1;

  if (!needsArchive) {
    const body = format === "markdown"
      ? new Blob([pageMarkdown(root, "", pages)], { type: "text/markdown" })
      : new Blob([html!.get(root.id)!], { type: "text/html" });
    const name = `${safeName(pageName(root))}.${format === "markdown" ? "md" : "html"}`;
    return { name, type: format === "markdown" ? "text/markdown" : "text/html", body, missing };
  }

  const { sink, blob } = zipSink();
  const zip = new ZipStream(sink);
  for (const entry of entries) {
    const path = `${entry.dir}${entry.base}.${format === "markdown" ? "md" : "html"}`;
    await zip.add(path, format === "markdown" ? pageMarkdown(entry.page, entry.dir, pages) : html!.get(entry.page.id)!);
  }
  for (const [path, file] of files) {
    const zipPath = attachmentZipPath(path);
    if (!zipPath) continue;
    const bytes = await fileBytes(source.files, file, path);
    if (bytes) await zip.add(zipPath, bytes);
    else missing.push(zipPath);
  }
  if (missing.length) {
    await zip.add("missing.txt", `以下附件未能导出：\n${missing.join("\n")}\n`);
  }
  zip.finish();
  return { name: `${safeName(pageName(root))}.zip`, type: "application/zip", body: blob(), missing };
}
