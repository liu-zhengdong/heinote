import type { RichText } from "./schema";
import { createBlock, normalizeBlockTree, normalizePage } from "../core/block-tree";
import { inlineFromText, inlinePlainText } from "../core/inline-content";
import { spaceOfPage, withoutUnhomed } from "../core/page-tree";
import { contentOfRuns, storedRuns } from "../core/stored-runs";
import { pageTitleContent, titleHasLinks, titleRuns } from "../core/title";
import { emptyWorkspace, readPreferences } from "../core/workspace-state";
import type { Block, BlockRecord, HistoryPart, NotePage, PageRecord, PageVersion, SettingsRecord, SimpleTable, WorkspacePreferences, WorkspaceState } from "../core/types";
import { historyParts, versionOfParts } from "./history-record";
import { blockRecordId, parseBlockRecordId, parseHistoryId } from "./record-ids";

/* What HeiNote keeps, as records — and the workspace they make.

   Every field of a record is a top-level field, written by a patch of the
   fields that changed (`writeFor`), so two people changing different fields
   of one page or paragraph both keep their change and the later of two
   changes to one field wins it. A paragraph's words (`content`) and a page's
   name (`title_content`) are rich text: the server merges their runs character
   by character from the value each write started from (`base`).

   - `pages/<page id>`: a page, without its paragraphs.
   - `blocks/<n>_<page id>_<block id>`: one paragraph of a page (`page`).
   - `versions/<n>_<page id>_<version id>[.part.<k>]`: a part of a page's
     checkpoint (history-record.ts).
   - `workspace_settings/preferences` and `workspace_settings/roots`: the
     member's own.

   A member's own records are one plane, the collections' personal scope;
   each space whose pages they read is another, the same collections' scope
   in that space, holding the shared page trees that live there. */

export const COLLECTIONS = ["pages", "blocks", "versions", "workspace_settings"] as const;
export type HeiNoteCollection = typeof COLLECTIONS[number];

/** What a space's plane holds: its page trees. Settings are the member's own. */
export const SPACE_COLLECTIONS = ["pages", "blocks", "versions"] as const satisfies readonly HeiNoteCollection[];

/** The member's own plane; any other is a space's id. */
export const PERSONAL = "personal";

/** Each collection's records, as schema.ts declares them. */
interface NotesRecords {
  pages: PageRecord;
  blocks: BlockRecord;
  versions: HistoryPart;
  workspace_settings: SettingsRecord;
}

/** A record of HeiNote's, as schema.ts declares its collection's. */
export type RecordValue = NotesRecords[HeiNoteCollection];

/** A JSON Merge Patch of a record: its fields that changed, null for one
 *  that went. */
export type RecordPatch = Record<string, unknown>;

/** A record of HeiNote's: its collection and its id. */
export interface RecordRef {
  collection: HeiNoteCollection;
  id: string;
}

export const refKey = (ref: RecordRef) => `${ref.collection}/${ref.id}`;

/** What one plane holds: each collection's records by id. */
export type PlaneRecords = Readonly<Record<HeiNoteCollection, ReadonlyMap<string, RecordValue>>>;

export const emptyPlane = (): PlaneRecords => ({
  pages: new Map(), blocks: new Map(), versions: new Map(), workspace_settings: new Map(),
});

/** One write of a record: made whole, changed field by field, or deleted.
 *  A patch's rich-text fields merge from the runs the window showed, or from
 *  `base` when it says otherwise. */
export type RecordWrite =
  | { action: "put"; collection: HeiNoteCollection; id: string; value: RecordValue }
  | { action: "patch"; collection: HeiNoteCollection; id: string; patch: RecordPatch; base?: Record<string, RichText> }
  | { action: "delete"; collection: HeiNoteCollection; id: string };

/** The page a record belongs to; none for the member's settings. */
export function pageOfRef(ref: RecordRef): string | undefined {
  if (ref.collection === "pages") return ref.id;
  if (ref.collection === "blocks") return parseBlockRecordId(ref.id)?.pageId;
  if (ref.collection === "versions") return parseHistoryId(ref.id)?.pageId;
  return undefined;
}

/* ── From the workspace to records ───────────────────────────────────── */

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A record's fields: nothing unset, and nothing null — a patch says null
 *  to remove a field, so a field is either there or not. */
function fields<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null)) as T;
}

function storedTable(table: SimpleTable): NonNullable<BlockRecord["table"]> {
  return {
    ...table,
    rows: Object.fromEntries(Object.entries(table.rows ?? {}).map(([id, row]) => [id, {
      ...row,
      cells: Object.fromEntries(Object.entries(row.cells ?? {}).map(([column, cell]) => [column, storedRuns(cell)])),
    }])),
  };
}

function tableOfRecord(value: unknown): unknown {
  if (!isObject(value) || !isObject(value.rows)) return value;
  return {
    ...value,
    rows: Object.fromEntries(Object.entries(value.rows).map(([id, row]) => [id, isObject(row) && isObject(row.cells) ? {
      ...row,
      cells: Object.fromEntries(Object.entries(row.cells).map(([column, cell]) => [column, contentOfRuns(cell)])),
    } : row])),
  };
}

/** A paragraph as a record keeps it, its words as runs. A `page` node is
 *  the editor's alone (features/editor/composite.ts), never written as
 *  itself: one that reached here would be kept as the line of its name, as
 *  a page's tree reads one (core/block-tree.ts). */
function storedBlock(block: Block): Omit<BlockRecord, "page"> {
  const { kind, parent_id, content, name, table, embed, ...rest } = block;
  return fields({
    ...rest,
    kind: kind === "page" ? "text" : kind,
    ...(parent_id === null ? {} : { parent_id }),
    content: storedRuns(kind === "page" ? inlineFromText(name ?? "") : content),
    ...(name === undefined || kind === "page" ? {} : { name }),
    ...(table ? { table: storedTable(table) } : {}),
    ...(embed ? { embed: { ...embed } } : {}),
  });
}

/** A paragraph read from a record — another member's client wrote it. */
function blockOfRecord(blockId: string, value: unknown): Block | undefined {
  if (!isObject(value)) return undefined;
  const candidate = { ...value, id: blockId, content: contentOfRuns(value.content), table: tableOfRecord(value.table) };
  return normalizeBlockTree({ by_id: { [blockId]: candidate } }).by_id[blockId];
}

function pageRecord(page: NotePage): PageRecord {
  const { block_tree: _tree, title: _title, parent_id, ...rest } = page;
  return fields({
    ...rest,
    ...(parent_id === null ? {} : { parent_id }),
    // The name is kept only as its runs, links or not, so two people renaming
    // a page at once both keep what they typed — and no plain-text copy of
    // it can be left behind by the merge.
    title_content: storedRuns(pageTitleContent(page)),
  });
}

/** A page's own fields, read from a record: its name's words from its
 *  runs, which are what two renames merge into. */
function pageFieldsOfRecord(pageId: string, value: unknown): Omit<NotePage, "block_tree"> | undefined {
  if (!isObject(value)) return undefined;
  const page = normalizePage({ ...value, id: pageId, parent_id: typeof value.parent_id === "string" ? value.parent_id : null, block_tree: { by_id: {} } }, false);
  if (!page) return undefined;
  const { block_tree: _tree, ...rest } = page;
  const runs = titleRuns(contentOfRuns(value.title_content));
  const title = inlinePlainText(runs);
  const { title_content: _runs, ...others } = rest;
  return {
    ...others,
    title,
    ...(titleHasLinks(runs) ? { title_content: runs } : {}),
  };
}

function versionOf(state: WorkspaceState, ref: RecordRef): { version: PageVersion; part: number } | undefined {
  const parsed = parseHistoryId(ref.id);
  const version = parsed && state.versions[parsed.pageId]?.[parsed.versionId];
  return version && parsed ? { version, part: parsed.part } : undefined;
}

/** The value a record has in this workspace, or none. */
export function recordValue(state: WorkspaceState, ref: RecordRef): RecordValue | undefined {
  switch (ref.collection) {
    case "pages": {
      const page = state.pages[ref.id];
      return page ? pageRecord(page) : undefined;
    }
    case "blocks": {
      const parsed = parseBlockRecordId(ref.id);
      const block = parsed && state.pages[parsed.pageId]?.block_tree.by_id[parsed.blockId];
      return block && parsed ? { page: parsed.pageId, ...storedBlock(block) } : undefined;
    }
    case "versions": {
      const found = versionOf(state, ref);
      return found ? historyParts(found.version)[found.part]?.value : undefined;
    }
    case "workspace_settings":
      if (ref.id === "preferences") return { ...state.preferences };
      if (ref.id === "roots") return { roots: state.roots };
      return undefined;
  }
}

/** The plane a page's records live in: its space's, or the member's own. */
export function planeOfPage(state: WorkspaceState, pageId: string): string | undefined {
  if (!state.pages[pageId]) return undefined;
  return spaceOfPage(state.pages, pageId) ?? PERSONAL;
}

/** What `plane` holds of a record in this workspace. A page shared into a
 *  space lives there, and its sharer's own plane keeps the page's record
 *  too — not its paragraphs or history — which says where it stands among
 *  their own pages. */
export function recordIn(state: WorkspaceState, plane: string, ref: RecordRef): RecordValue | undefined {
  const pageId = pageOfRef(ref);
  if (!pageId) return plane === PERSONAL ? recordValue(state, ref) : undefined;
  const home = planeOfPage(state, pageId);
  if (!home) return undefined;
  if (home === plane) return recordValue(state, ref);
  if (plane === PERSONAL && ref.collection === "pages" && state.pages[pageId].share_space_id === home) return recordValue(state, ref);
  return undefined;
}

/** Every record of a page: the page, its paragraphs and its history. */
export function pageRecords(state: WorkspaceState, pageId: string): RecordRef[] {
  const page = state.pages[pageId];
  if (!page) return [];
  return [
    { collection: "pages", id: pageId },
    ...Object.keys(page.block_tree.by_id).map((blockId) => ({ collection: "blocks" as const, id: blockRecordId(pageId, blockId) })),
    ...versionRecords(state, pageId),
  ];
}

function versionRecords(state: WorkspaceState, pageId: string, versionId?: string): RecordRef[] {
  const versions = state.versions[pageId] ?? {};
  return (versionId ? [versions[versionId]].filter(Boolean) : Object.values(versions))
    .flatMap((version) => historyParts(version).map((part) => ({ collection: "versions" as const, id: part.id })));
}

/** The records a write at `path` lands in, in this workspace. */
export function recordsOfPath(state: WorkspaceState, path: readonly string[]): RecordRef[] {
  const [root, id] = path;
  if (root === "roots" || root === "preferences") return [{ collection: "workspace_settings", id: root }];
  if (root === "versions" && id) return versionRecords(state, id, path[2]);
  if (root !== "pages" || !id) return [];
  const page = state.pages[id];
  if (path[2] === "block_tree" && path[3] === "by_id" && path[4]) return [{ collection: "blocks", id: blockRecordId(id, path[4]) }];
  const blocks = page ? Object.keys(page.block_tree.by_id).map((blockId) => ({ collection: "blocks" as const, id: blockRecordId(id, blockId) })) : [];
  if (path[2] === "block_tree") return blocks;
  if (path.length === 2) return [{ collection: "pages", id }, ...blocks];
  return [{ collection: "pages", id }];
}

/* ── Writes ──────────────────────────────────────────────────────────── */

const json = (value: unknown) => JSON.stringify(value);

/** A value a patch can say: no member of an object anywhere in it is null,
 *  which a patch would read as "remove". */
function patchable(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  if (!isObject(value)) return true;
  return Object.values(value).every((item) => item !== null && patchable(item));
}

/** The JSON Merge Patch that turns `before` into `after`, or null where
 *  none can (a null inside an object). */
export function mergePatch(before: Readonly<Record<string, unknown>>, after: Readonly<Record<string, unknown>>): RecordPatch | null {
  const patch: RecordPatch = {};
  for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) patch[key] = null;
  for (const [key, value] of Object.entries(after)) {
    const old = before[key];
    if (json(old) === json(value)) continue;
    if (isObject(old) && isObject(value)) {
      const inner = mergePatch(old, value);
      if (inner === null) return null;
      patch[key] = inner;
    } else {
      if (!patchable(value)) return null;
      patch[key] = value;
    }
  }
  return patch;
}

/** The write that takes a record from what its plane shows (`before`) to
 *  `after`: a put for a record new to its plane, a delete for one gone, and
 *  otherwise a patch of the fields that changed. None when nothing changed. */
export function writeFor(ref: RecordRef, before: RecordValue | undefined, after: RecordValue | undefined): RecordWrite | null {
  const { collection, id } = ref;
  if (!after) return before ? { action: "delete", collection, id } : null;
  if (!before) return { action: "put", collection, id, value: after };
  const patch = mergePatch(before, after);
  if (patch === null) return { action: "put", collection, id, value: after };
  if (!Object.keys(patch).length) return null;
  return { action: "patch", collection, id, patch };
}

/* ── From records to the workspace ───────────────────────────────────── */

interface Built<T> {
  value: unknown;
  json: string;
  built: T;
}

/** Builds the workspace the planes' records make, keeping every page,
 *  paragraph and version whose record did not change the same object from
 *  one build to the next — the editor skips whatever kept its identity.

 *  Which pages a space may show: its root (the page shared into it, which
 *  names the space) and the pages under it there — never a page of the
 *  member's own, nor one of another space. A root shared from under its
 *  sharer's own page sits there for the sharer, whose plane keeps its
 *  record; for everyone else it opens at the top level. A page whose parents
 *  lead to one this member cannot read is not theirs to see. */
export class Projector {
  private readonly blocks = new Map<string, Built<Block>>();
  private readonly pages = new Map<string, Built<Omit<NotePage, "block_tree">>>();
  private readonly trees = new Map<string, { blocks: Block[]; fields: Omit<NotePage, "block_tree">; page: NotePage }>();
  private readonly versions = new Map<string, { parts: unknown[]; version: PageVersion | null }>();
  private readonly blankBlocks = new Map<string, Block>();
  private preferences: { value: unknown; built: WorkspacePreferences } | null = null;
  private roots: { value: unknown; built: string[] } | null = null;

  private reuse<T>(cache: Map<string, Built<T>>, key: string, value: unknown, build: () => T | undefined): T | undefined {
    const held = cache.get(key);
    if (held && held.value === value) return held.built;
    const built = build();
    if (built === undefined) {
      cache.delete(key);
      return undefined;
    }
    const text = json(built);
    if (held && held.json === text) {
      held.value = value;
      return held.built;
    }
    cache.set(key, { value, json: text, built });
    return built;
  }

  project(planes: ReadonlyMap<string, PlaneRecords>): WorkspaceState {
    const personal = planes.get(PERSONAL) ?? emptyPlane();
    const chosen = new Map<string, { plane: string; fields: Omit<NotePage, "block_tree"> }>();
    for (const [id, value] of personal.pages) {
      const fields = this.reuse(this.pages, `${PERSONAL}|${id}`, value, () => pageFieldsOfRecord(id, value));
      if (fields) chosen.set(id, { plane: PERSONAL, fields });
    }
    for (const [plane, records] of planes) {
      if (plane === PERSONAL) continue;
      const read = new Map<string, Omit<NotePage, "block_tree">>();
      for (const [id, value] of records.pages) {
        const fields = this.reuse(this.pages, `${plane}|${id}`, value, () => pageFieldsOfRecord(id, value));
        if (fields) read.set(id, fields);
      }
      // A page this member has already — their own, or another space's —
      // is never this space's, unless it is the root the member shared here.
      const claimed = (id: string) => {
        const own = chosen.get(id);
        return own !== undefined && !(own.plane === PERSONAL && own.fields.share_space_id === plane);
      };
      // The space's roots, then the pages under them there, level by level.
      const admitted = new Map([...read].filter(([id, fields]) => fields.share_space_id === plane && !claimed(id)));
      for (let frontier = [...admitted.keys()]; frontier.length;) {
        const parents = new Set(frontier);
        frontier = [];
        for (const [id, fields] of read) {
          if (admitted.has(id) || claimed(id) || fields.share_space_id || !fields.parent_id || !parents.has(fields.parent_id)) continue;
          admitted.set(id, fields);
          frontier.push(id);
        }
      }
      for (const [id, fields] of admitted) {
        const own = chosen.get(id);
        // The sharer's own record of the root says where it stands; for
        // anyone else it opens at the top level.
        const parentId = fields.share_space_id === plane ? own?.fields.parent_id ?? null : fields.parent_id;
        chosen.set(id, { plane, fields: fields.parent_id === parentId ? fields : { ...fields, parent_id: parentId } });
      }
    }

    // Each plane's paragraphs and history, by page.
    const blocksByPage = new Map<string, Map<string, Array<[string, RecordValue]>>>();
    const partsByPage = new Map<string, Map<string, Map<string, Array<readonly [string, unknown]>>>>();
    for (const [plane, records] of planes) {
      const blocks = new Map<string, Array<[string, RecordValue]>>();
      for (const [id, value] of records.blocks) {
        const parsed = parseBlockRecordId(id);
        if (!parsed) continue;
        const list = blocks.get(parsed.pageId);
        if (list) list.push([parsed.blockId, value]);
        else blocks.set(parsed.pageId, [[parsed.blockId, value]]);
      }
      blocksByPage.set(plane, blocks);
      const parts = new Map<string, Map<string, Array<readonly [string, unknown]>>>();
      for (const [id, value] of records.versions) {
        const parsed = parseHistoryId(id);
        if (!parsed) continue;
        let page = parts.get(parsed.pageId);
        if (!page) parts.set(parsed.pageId, page = new Map());
        const list = page.get(parsed.versionId);
        if (list) list.push([id, value]);
        else page.set(parsed.versionId, [[id, value]]);
      }
      partsByPage.set(plane, parts);
    }

    const pages: Record<string, NotePage> = {};
    const kept = new Set<string>();
    for (const [id, { plane, fields }] of chosen) {
      const blocks: Block[] = [];
      for (const [blockId, value] of blocksByPage.get(plane)?.get(id) ?? []) {
        const block = this.reuse(this.blocks, `${plane}|${id}|${blockId}`, value, () => blockOfRecord(blockId, value));
        if (block) blocks.push(block);
      }
      // A page with no paragraph yet shows one to write in.
      if (!blocks.length) {
        let blank = this.blankBlocks.get(id);
        if (!blank) this.blankBlocks.set(id, blank = createBlock(`block_${id}_root`));
        blocks.push(blank);
      }
      const held = this.trees.get(id);
      const sameBlocks = held && held.blocks.length === blocks.length && held.blocks.every((block, index) => block === blocks[index]);
      const sameFields = held && (held.fields === fields || json(held.fields) === json(fields));
      const page = held && sameBlocks && sameFields
        ? held.page
        : { ...fields, block_tree: held && sameBlocks ? held.page.block_tree : { by_id: Object.fromEntries(blocks.map((block) => [block.id, block])) } } as NotePage;
      this.trees.set(id, { blocks, fields, page });
      pages[id] = page;
      kept.add(id);
    }
    for (const id of this.trees.keys()) if (!kept.has(id)) this.trees.delete(id);

    const versions: WorkspaceState["versions"] = {};
    for (const [id, { plane }] of chosen) {
      for (const [versionId, parts] of partsByPage.get(plane)?.get(id) ?? []) {
        const cacheKey = `${plane}|${id}|${versionId}`;
        const held = this.versions.get(cacheKey);
        const values = parts.map(([, value]) => value);
        const version = held && held.parts.length === values.length && held.parts.every((value, index) => value === values[index])
          ? held.version
          : versionOfParts(parts);
        this.versions.set(cacheKey, { parts: values, version });
        if (version) (versions[id] ??= {})[version.id] = version;
      }
    }

    const preferencesValue = personal.workspace_settings.get("preferences");
    const preferences = this.preferences && this.preferences.value === preferencesValue ? this.preferences.built : readPreferences(preferencesValue as SettingsRecord | undefined);
    this.preferences = { value: preferencesValue, built: preferences };
    const rootsValue = personal.workspace_settings.get("roots");
    const roots = this.roots && this.roots.value === rootsValue ? this.roots.built : (rootsValue as SettingsRecord | undefined)?.roots ?? [];
    this.roots = { value: rootsValue, built: roots };

    return withoutUnhomed({ ...emptyWorkspace(), pages, versions, roots, preferences });
  }
}
