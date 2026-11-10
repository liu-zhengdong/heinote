import type { RichText } from "../platform/schema";
import { digest } from "lib0/hash/sha256";

export interface DocumentAddress { scope: string; pageId: string }
export interface DocumentSnapshot extends DocumentAddress {
  generation: string;
  state: string;
  revision: string;
  canEdit: boolean;
  records?: { page: JsonRecord; blocks: Array<{ id: string; value: JsonRecord }> };
}
export interface TextUpdate extends DocumentAddress { generation: string; update: string }
export interface ExpectedPage extends DocumentAddress { generation: string; revision: string }
export type JsonRecord = Record<string, unknown>;
export interface FieldAddress { collection: "pages" | "blocks"; id: string; path: string[] }
export const documentKey = ({ scope, pageId }: DocumentAddress) => JSON.stringify([scope, pageId]);
export const titleField = (pageId: string) => `pages/${encodeURIComponent(pageId)}/title_content`;
export const blockField = (recordId: string) => `blocks/${encodeURIComponent(recordId)}/content`;
export const cellField = (recordId: string, rowId: string, columnId: string) => `blocks/${encodeURIComponent(recordId)}/table/rows/${encodeURIComponent(rowId)}/cells/${encodeURIComponent(columnId)}`;
export const isObject = (value: unknown): value is JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value);

export function fieldAddress(key: string): FieldAddress | null {
  const [collection, rawId, ...rawPath] = key.split("/");
  if ((collection !== "pages" && collection !== "blocks") || !rawId || !rawPath.length) return null;
  try { return { collection, id: decodeURIComponent(rawId), path: rawPath.map(decodeURIComponent) }; } catch { return null; }
}
export function valueAt(record: JsonRecord, path: readonly string[]): unknown {
  let current: unknown = record;
  for (const key of path) { if (!isObject(current)) return undefined; current = current[key]; }
  return current;
}
export function setAt(record: JsonRecord, path: readonly string[], value: unknown): JsonRecord {
  if (!path.length) return record;
  const [key, ...rest] = path;
  if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Invalid field path");
  return { ...record, [key]: rest.length ? setAt(isObject(record[key]) ? record[key] : {}, rest, value) : value };
}
export function fieldsInPage(pageId: string, page: JsonRecord, blocks: Array<{ id: string; value: JsonRecord }>): Record<string, RichText> {
  const fields: Record<string, RichText> = { [titleField(pageId)]: Array.isArray(page.title_content) ? page.title_content : [] };
  for (const { id, value } of blocks) {
    fields[blockField(id)] = Array.isArray(value.content) ? value.content : [];
    if (!isObject(value.table) || !isObject(value.table.rows) || !Array.isArray(value.table.columns)) continue;
    for (const [rowId, row] of Object.entries(value.table.rows)) {
      if (!isObject(row)) continue;
      for (const column of value.table.columns) {
        if (!isObject(column) || typeof column.id !== "string") continue;
        const cells = isObject(row.cells) ? row.cells : {};
        fields[cellField(id, rowId, column.id)] = Array.isArray(cells[column.id]) ? cells[column.id] as RichText : [];
      }
    }
  }
  return fields;
}
export function structureOf(page: JsonRecord, blocks: Array<{ id: string; value: JsonRecord }>): unknown {
  return {
    page: [page.parent_id, page.share_space_id, page.kind, page.archived],
    blocks: blocks.map(({ id, value }) => ({ id, kind: value.kind, parent: value.parent_id, order: value.order,
      table: isObject(value.table) ? { columns: Array.isArray(value.table.columns) ? value.table.columns.map((column) => isObject(column) ? column.id : null) : [], rows: isObject(value.table.rows) ? Object.entries(value.table.rows).sort(([a], [b]) => a.localeCompare(b)).map(([id, row]) => [id, isObject(row) ? row.order : null]) : [] } : undefined,
    })),
  };
}
export function hasMetadataChange(collection: string, before: JsonRecord | undefined, after: JsonRecord | undefined): boolean {
  if (collection !== "pages" && collection !== "blocks") return false;
  if (!before || !after) return true;
  const strip = (record: JsonRecord): JsonRecord => {
    const copy = { ...record }; delete copy.content; delete copy.title_content; delete copy.title; delete copy.updated_at; delete copy.updated_by;
    if (isObject(copy.table) && isObject(copy.table.rows)) copy.table = { ...copy.table, rows: Object.fromEntries(Object.entries(copy.table.rows).map(([id, row]) => { if (!isObject(row)) return [id, row]; const { cells: _cells, ...metadata } = row; return [id, metadata]; })) };
    return copy;
  };
  return pageRevision(strip(before), []) !== pageRevision(strip(after), []);
}
export function isStructureChange(collection: string, before: JsonRecord | undefined, after: JsonRecord | undefined): boolean {
  if (collection !== "pages" && collection !== "blocks") return false;
  if (!before || !after) return true;
  const shape = (value: JsonRecord) => collection === "pages" ? structureOf(value, []) : structureOf({}, [{ id: String(value.id), value }]);
  return JSON.stringify(shape(before)) !== JSON.stringify(shape(after));
}
export function pageRevision(page: JsonRecord | undefined, blocks: Array<{ id: string; value: JsonRecord }>): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!isObject(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, normalize(value[key])]));
  };
  const { updated_at: _at, updated_by: _by, ...content } = page ?? {};
  const bytes = new TextEncoder().encode(JSON.stringify(normalize([content, [...blocks].sort((a, b) => a.id.localeCompare(b.id))])));
  return Array.from(digest(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}
export function base64ToBytes(value: string): Uint8Array { return Uint8Array.from(atob(value), (char) => char.charCodeAt(0)); }
