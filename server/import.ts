import { inflateRawSync } from "node:zlib";
import { createId } from "../src/core/ids.ts";
import { analyzeBase, evalFormulas, parseFrontmatter, rowFacts, scanInlineTags, type BaseRow, type RowFacts } from "../src/core/base.ts";
import { indexVault, noteToBlocks, planVault } from "../src/core/obsidian.ts";
import { indexNotion, notionPageToBlocks, notionTitle } from "../src/core/notion.ts";
import { storedRuns } from "../src/core/stored-runs.ts";
import type { Block } from "../src/core/types.ts";
import { blockRecordId } from "../src/platform/record-ids.ts";
import type { Actor, Row, Store, Write } from "./store.ts";

/* Notes from elsewhere: an Obsidian vault (its folder zipped in the browser,
   or a zip the user made) or the Notion export zip. Everything lands under
   one new root page in one transaction — an import that fails leaves
   nothing behind. Attachments come along for the pictures and files pages
   hold, so an archive is complete where its links resolve. */

/* ── A zip's entries ────────────────────────────────────────────────────── */

interface ZipEntryRead {
  name: string;
  size: number;
  /** Modified time as epoch ms, decoded from the DOS stamp. */
  mtime: number;
  /** Inflate if stored under deflate. */
  bytes(): Buffer;
}

const decoder = new TextDecoder();

/** The central directory, read from the end: enough to pull entries out. */
export function readZip(file: Buffer): ZipEntryRead[] {
  let end = -1;
  for (let at = file.length - 22; at >= Math.max(0, file.length - 65557); at -= 1) {
    if (file.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new Error("不是有效的 zip 文件。");
  const count = file.readUInt16LE(end + 10);
  let at = file.readUInt32LE(end + 16);
  const entries: ZipEntryRead[] = [];
  for (let i = 0; i < count; i += 1) {
    if (file.readUInt32LE(at) !== 0x02014b50) break;
    const flags = file.readUInt16LE(at + 8);
    const method = file.readUInt16LE(at + 10);
    const size = file.readUInt32LE(at + 24);
    // Deflate can leave the payload larger than the input; slice the entry
    // by its compressed size or inflate reads a truncated stream.
    const compressedSize = file.readUInt32LE(at + 20);
    const nameLength = file.readUInt16LE(at + 28);
    const extraLength = file.readUInt16LE(at + 30);
    const commentLength = file.readUInt16LE(at + 32);
    const offset = file.readUInt32LE(at + 42);
    const name = decoder.decode(file.subarray(at + 46, at + 46 + nameLength));
    const dosTime = file.readUInt16LE(at + 12);
    const dosDate = file.readUInt16LE(at + 14);
    const mtime = dosDate
      ? new Date(((dosDate >> 9) & 0x7f) + 1980, ((dosDate >> 5) & 0xf) - 1, dosDate & 0x1f,
          (dosTime >> 11) & 0x1f, (dosTime >> 5) & 0x3f, (dosTime & 0x1f) * 2).getTime()
      : 0;
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if (flags & 1) throw new Error(`加密的 zip 条目无法导入：${name}`);
    entries.push({
      name,
      size,
      mtime,
      bytes() {
        if (file.readUInt32LE(offset) !== 0x04034b50) throw new Error(`zip 条目损坏：${name}`);
        const headName = file.readUInt16LE(offset + 26);
        const headExtra = file.readUInt16LE(offset + 28);
        const start = offset + 30 + headName + headExtra;
        const body = file.subarray(start, start + compressedSize);
        if (method === 0) return Buffer.from(body);
        if (method === 8) return inflateRawSync(body);
        throw new Error(`zip 条目使用了不支持的压缩方式（${method}）：${name}`);
      },
    });
  }
  return entries;
}

/* ── Jobs ───────────────────────────────────────────────────────────────── */

export interface ImportJob {
  id: string;
  userId: string;
  status: "queued" | "scanning" | "importing" | "done" | "failed";
  source: "obsidian" | "notion";
  phase: string;
  done: number;
  total: number;
  result?: ImportReport;
  error?: string;
  created: number;
}

export interface ImportReport {
  rootPageId: string;
  title: string;
  pages: number;
  attachments: number;
  links: number;
  unresolved: string[];
  warnings: string[];
}

const jobs = new Map<string, ImportJob>();

export function importJob(userId: string, id: string): ImportJob | undefined {
  const job = jobs.get(id);
  return job?.userId === userId ? job : undefined;
}

const MAX_ZIP_BYTES = 1024 * 1024 * 1024;
const MAX_ATTACHMENT = 7.5 * 1024 * 1024;

/** Start an import: the zip is already read, work runs async. */
export function startImport(store: Store, actor: Actor, source: "obsidian" | "notion", zip: Buffer): ImportJob {
  if (zip.length > MAX_ZIP_BYTES) throw new Error("导入文件超过 1 GiB 上限。");
  const job: ImportJob = {
    id: `import_${createId("x")}`,
    userId: actor.user.id,
    status: "queued",
    source,
    phase: "读取文件…",
    done: 0,
    total: 0,
    created: Date.now(),
  };
  jobs.set(job.id, job);
  for (const [id, other] of jobs) {
    if ((other.status === "done" || other.status === "failed") && Date.now() - other.created > 3600_000) jobs.delete(id);
  }
  setImmediate(() => {
    try {
      runImport(store, actor, job, zip);
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
    }
  });
  return job;
}

/* ── Shared pipeline parts ──────────────────────────────────────────────── */

interface ScannedEntry {
  path: string;
  size: number;
  mtime: number;
  read(): Buffer;
}

const now = () => new Date().toISOString();

const guessType = (name: string): string => {
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp",
    pdf: "application/pdf", mp3: "audio/mpeg", mp4: "video/mp4", zip: "application/zip",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  return map[name.split(".").at(-1)?.toLowerCase() ?? ""] ?? "application/octet-stream";
};

function runImport(store: Store, actor: Actor, job: ImportJob, zip: Buffer): void {
  job.status = "scanning";
  job.phase = "扫描文件…";
  const entries: ScannedEntry[] = readZip(zip).map((entry) => ({ path: entry.name, size: entry.size, mtime: entry.mtime, read: entry.bytes }));
  job.total = entries.length;
  // Attachments defer directory fsyncs and index rows to endBatch; the
  // deferred work still lands before the records transaction reads the index.
  store.files.beginBatch();
  try {
    if (job.source === "obsidian") importObsidian(store, actor, job, entries);
    else importNotion(store, actor, job, entries);
  } finally {
    store.files.endBatch();
  }
}

interface PageBuild {
  id: string;
  title: string;
  blocks: Block[];
  parentId?: string;
  /** "database" makes the page a database; unset stays "document". */
  kind?: "document" | "database";
  /** Database config: the page is a database, its rows hang under it. */
  database?: { properties: Row[]; views: Row[]; title_name?: string };
  /** Row values for a database row page, keyed by property id. */
  properties?: Record<string, string>;
  /** Row ordering inside its database. */
  row_order?: number;
}

/** Write pages + their blocks in one transaction. Nothing lands on failure. */
function commit(store: Store, actor: Actor, _scope: string, _job: ImportJob, built: PageBuild[]): void {
  const writes: Write[] = [];
  const stamp = now();
  const who = actor.user.displayName;
  const scope = "personal";
  for (const page of built) {
    writes.push({
      scope, collection: "pages", id: page.id, action: "put",
      value: {
        id: page.id,
        title_content: storedRuns([{ text: page.title }]),
        icon: "", kind: page.kind ?? "document",
        ...(page.parentId ? { parent_id: page.parentId } : {}),
        ...(page.properties ? { properties: page.properties } : {}),
        ...(page.row_order !== undefined ? { row_order: page.row_order } : {}),
        ...(page.database ? { database: page.database } : {}),
        created_at: stamp, updated_at: stamp, created_by: who, updated_by: who,
      } as Row,
    });
    for (const block of page.blocks) {
      writes.push({
        scope, collection: "blocks", id: blockRecordId(page.id, block.id), action: "put",
        value: {
          id: block.id, page: page.id, kind: block.kind,
          ...(block.parent_id ? { parent_id: block.parent_id } : {}),
          order: block.order,
          content: storedRuns(block.content),
          ...(block.checked === undefined ? {} : { checked: block.checked }),
          ...(block.language ? { language: block.language } : {}),
          ...(block.table ? { table: block.table } : {}),
          ...(block.file ? { file: block.file } : {}),
          ...(block.name ? { name: block.name } : {}),
          ...(block.color ? { color: block.color } : {}),
          ...(block.icon ? { icon: block.icon } : {}),
          ...(block.width ? { width: block.width } : {}),
        } as Row,
      });
    }
  }
  // No requestId: job ids never repeat, so caching a giant digest buys
  // nothing. The limit covers whole-vault imports — a real library is far
  // above the interactive 10k cap but must still land in one transaction.
  // Bulk mode trims the per-write lookups that make cold-cache commits crawl.
  store.bulkTransaction(() => store.apply(actor, writes, undefined, [], [], 50_000_000));
}

/** Per-import helpers: page ids, attachment writing, unresolved links. */
function makeHooks(
  store: Store,
  actor: Actor,
  scope: string,
  job: ImportJob,
  entryOf: (path: string) => ScannedEntry | undefined,
  idOf: Map<string, string>,
) {
  const warnings: string[] = [];
  const unresolved: string[] = [];
  const stored = new Map<string, { path: string; name: string; size: number; type: string; owner: string }>();
  const hooks = {
    pageIdOf: (note: { path: string }) => idOf.get(note.path) ?? "",
    storedOf: (file: { path: string }) => {
      const cached = stored.get(file.path);
      if (cached) return cached;
      const entry = entryOf(file.path);
      if (!entry) return undefined;
      const name = entry.path.split("/").at(-1) ?? "file";
      if (entry.size > MAX_ATTACHMENT) {
        warnings.push(`附件 ${entry.path} 超过 7.5 MB 上限，已跳过。`);
        return undefined;
      }
      job.phase = `写入附件 ${file.path}…`;
      const path = `files/${job.id}/${entry.path.split("/").map((s) => s.replace(/[^\w.-]+/g, "-")).join("/")}`;
      const bytes = entry.read();
      const ok = store.files.write(scope, path, guessType(name), bytes);
      if (!ok) {
        warnings.push(`附件 ${entry.path} 写入失败，已跳过。`);
        return undefined;
      }
      const written = { path, name, size: bytes.length, type: guessType(name), owner: actor.user.id };
      stored.set(file.path, written);
      return written;
    },
    unresolved: (target: string) => { if (unresolved.length < 50) unresolved.push(target); },
  };
  return { hooks, warnings, unresolved, stored };
}

/** Entry lookup by vault-relative path (exact, then by suffix). */
function entryOfFactory(entries: ScannedEntry[]): (path: string) => ScannedEntry | undefined {
  const byPath = new Map(entries.map((e) => [e.path, e]));
  return (path) => byPath.get(path)
    ?? entries.find((e) => e.path.endsWith(`/${path}`))
    ?? byPath.get(path.split("/").map((s) => encodeURIComponent(s)).join("/"));
}

/* ── Obsidian ───────────────────────────────────────────────────────────── */

function importObsidian(store: Store, actor: Actor, job: ImportJob, entries: ScannedEntry[]): void {
  const thin = entries.map((e) => ({ path: e.path, bytes: new Uint8Array(), size: e.size, mtime: e.mtime }));
  const plan = planVault(thin);
  if (!plan) throw new Error("没有找到 Markdown 笔记。");
  const scope = `user:${actor.user.id}`;
  const index = indexVault(plan);
  const entryOf = entryOfFactory(entries);
  const idOf = new Map(plan.notes.map((note) => [note.path, createId("page")]));
  const { hooks, warnings, unresolved, stored } = makeHooks(store, actor, scope, job, entryOf, idOf);
  if (!plan.configured) warnings.push("未发现 .obsidian 目录，按普通 Markdown 文件夹导入。");

  const rootId = createId("page");
  const rootTitle = `Obsidian 导入 — ${plan.name}`;
  const pages: PageBuild[] = [{ id: rootId, title: rootTitle, blocks: [] }];

  // Directory → its page, parents first.
  const folderIds = new Map<string, string>();
  const folderOf = (dir: string): string | undefined => {
    if (!dir) return undefined;
    const known = folderIds.get(dir);
    if (known) return known;
    const parent = dir.includes("/") ? folderOf(dir.split("/").slice(0, -1).join("/")) : undefined;
    const id = createId("page");
    folderIds.set(dir, id);
    pages.push({ id, title: dir.split("/").at(-1)!, blocks: [], parentId: parent ?? rootId });
    return id;
  };

  job.status = "importing";
  let links = 0;

  /* Pass 1 — analyze every .base and decide which notes it claims. The
   *  claim is recorded before any page is written, so a matched note's
   *  parent lands on the database, not its folder. */
  const baseNotes: BaseRow[] = plan.notes.map((note) => {
    const entry = entryOf(note.path);
    const body = entry ? entry.read().toString("utf8").replace(/\r\n?/g, "\n") : "";
    const matter = /^---\n([\s\S]*?)\n---\n?/.exec(body);
    const frontmatter = matter ? matter[1] : "";
    const rest = matter ? body.slice(matter[0].length) : body;
    return {
      path: note.path,
      props: parseFrontmatter(frontmatter),
      tags: [...new Set([...scanInlineTags(rest), ...tagsOf(frontmatter)])],
      mtime: entry ? entry.mtime : 0,
      ctime: entry ? entry.mtime : 0,
      size: entry ? entry.size : 0,
    };
  });
  const facts: RowFacts[] = baseNotes.map(rowFacts);
  const claims = new Map<string, { dbId: string; spec: ReturnType<typeof analyzeBase>; title: string }>();
  const baseWarnings: string[] = [];
  interface PlannedBase {
    entry: ScannedEntry;
    spec: NonNullable<ReturnType<typeof analyzeBase>>;
    dbId: string;
    title: string;
    dir: string;
    rows: BaseRow[];
  }
  const plannedBases: PlannedBase[] = [];
  for (const entry of entries) {
    if (!entry.path.toLowerCase().endsWith(".base")) continue;
    const spec = analyzeBase(entry.read().toString("utf8"));
    if (!spec) {
      baseWarnings.push(`${entry.path}：YAML 解析失败，按普通页面导入`);
      continue;
    }
    const title = entry.path.split("/").at(-1)!.replace(/\.base$/i, "");
    const dir = entry.path.includes("/") ? entry.path.split("/").slice(0, -1).join("/") : "";
    const matched = baseNotes.filter((_row, index) => spec.predicate(facts[index]));
    const dbId = createId("page");
    for (const row of matched) {
      if (claims.has(row.path)) {
        baseWarnings.push(`${entry.path}：笔记 ${row.path} 已被其他 database 占用，该行未移动`);
        continue;
      }
      claims.set(row.path, { dbId, spec, title });
    }
    plannedBases.push({ entry, spec, dbId, title, dir, rows: matched.filter((row) => claims.get(row.path)?.dbId === dbId) });
  }

  /* Pass 2 — write every note. A claimed note's parent is its database
   *  and it carries the property map; unclaimed notes stay in their
   *  folders as before. */
  const noteProperties = new Map<string, Record<string, string>>();
  const noteOrder = new Map<string, number>();
  for (const base of plannedBases) {
    const spec = base.spec;
    const propertyIds = new Map<string, string>();
    const properties: Row[] = [];
    const inferType = (key: string, values: YamlValue[]): { type: string; options?: string[] } => {
      if (key.startsWith("formula.")) return { type: "text" };
      if (key === "tags" || key === "file.tags") return { type: "select", options: [] };
      const iso = values.every((value) => value === null || (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?/.test(value)));
      if (iso && values.some((value) => value !== null)) return { type: "date" };
      const discrete = new Set<string>();
      let multi = false;
      for (const value of values) {
        if (Array.isArray(value)) { multi = true; for (const item of value) discrete.add(String(item)); }
        else if (value !== null) discrete.add(String(value));
      }
      if (!multi && discrete.size && discrete.size <= 12) return { type: "select", options: [...discrete].sort() };
      return { type: "text" };
    };
    const display = (key: string): string => spec.displayNames[key] ?? (key.startsWith("file.") ? fileFieldLabel(key) : key);
    for (const key of spec.columnKeys) {
      if (key === "file.name" || key === "file.basename") continue;
      const values = base.rows.map((row) => valueForKey(key, row, spec));
      const { type, options } = inferType(key, values);
      const id = `property_${createId("p")}`;
      propertyIds.set(key, id);
      properties.push({ id, name: display(key), type, ...(options ? { options } : {}) } as Row);
    }
    base.rows.forEach((row, index) => {
      const rowFactsLocal = facts[baseNotes.indexOf(row)];
      const formulaValues = evalFormulas(spec.formulas, rowFactsLocal, []);
      const map: Record<string, string> = {};
      for (const key of spec.columnKeys) {
        if (key === "file.name" || key === "file.basename") continue;
        const id = propertyIds.get(key);
        if (!id) continue;
        const raw = valueForKey(key, row, spec, formulaValues);
        if (raw === null || raw === undefined || raw === "") continue;
        map[id] = Array.isArray(raw) ? raw.map(String).join("、") : String(raw);
      }
      noteProperties.set(row.path, map);
      noteOrder.set(row.path, index * 1024);
    });
    const propertyFor = (key: string) => properties.find((row) => row.id === propertyIds.get(key));
    const views: Row[] = spec.views.map((view) => {
      const kind = view.type === "cards" ? (view.groupBy ? "board" : "gallery")
        : view.type === "table" ? "table"
        : view.type === "list" ? "list"
        : "table";
      const sorts = view.sort
        .map((s) => ({ property_id: s.property === "file.name" ? "name" : propertyFor(s.property)?.id, direction: s.direction }))
        .filter((s) => s.property_id) as Array<{ property_id: string; direction: string }>;
      const filter = view.filter && view.filter.property !== "file.name"
        ? { property_id: propertyFor(view.filter.property)?.id ?? "", value: view.filter.value }
        : undefined;
      const group_by = view.groupBy ? propertyFor(view.groupBy)?.id : undefined;
      const widths: Record<string, number> = {};
      for (const [key, width] of Object.entries(view.widths)) {
        const id = key === "file.name" ? "name" : String(propertyFor(key)?.id ?? "");
        if (id) widths[id] = width;
      }
      return {
        id: `view_${createId("v")}`, name: view.name, kind,
        ...(filter ? { filter } : {}),
        ...(sorts.length ? { sorts } : {}),
        ...(group_by ? { group_by } : {}),
        ...(Object.keys(widths).length ? { widths } : {}),
      } as Row;
    });
    // groupOrder reorders the grouped select's options: declared order
    // first, then the rest in their inferred order.
    for (const view of spec.views) {
      if (!view.groupBy || !view.groupOrder.length) continue;
      const property = propertyFor(view.groupBy) as Row | undefined;
      const options = property?.options as string[] | undefined;
      if (!options?.length) continue;
      const ordered = [
        ...view.groupOrder.filter((name) => options.includes(name)),
        ...options.filter((name) => !view.groupOrder.includes(name)),
      ];
      if (property) property.options = ordered;
    }
    pages.push({
      id: base.dbId, title: base.title, blocks: [], kind: "database",
      database: { properties, views, title_name: spec.displayNames["file.name"] ?? "笔记" },
      parentId: base.dir ? folderOf(base.dir) : rootId,
    });
    for (const warning of spec.warnings) baseWarnings.push(`${base.entry.path}：${warning}`);
  }

  for (const note of plan.notes) {
    const entry = entryOf(note.path);
    if (!entry) continue;
    job.phase = `导入 ${note.path}…`;
    job.done += 1;
    const dir = note.path.includes("/") ? note.path.split("/").slice(0, -1).join("/") : "";
    const { blocks } = noteToBlocks(entry.read().toString("utf8"), index, hooks, () => createId("block"));
    links += blocks.filter((b) => b.content.some((r) => r.mention?.kind === "page")).length;
    const claim = claims.get(note.path);
    pages.push({
      id: idOf.get(note.path)!,
      title: note.path.split("/").at(-1)!.replace(/\.md$/i, ""),
      blocks,
      parentId: claim ? claim.dbId : (dir ? folderOf(dir) : rootId),
      ...(claim && noteProperties.get(note.path) ? { properties: noteProperties.get(note.path) } : {}),
      ...(claim ? { row_order: noteOrder.get(note.path) } : {}),
    });
  }

  job.phase = "写入记录…";
  commit(store, actor, scope, job, pages);
  job.result = { rootPageId: rootId, title: rootTitle, pages: pages.length, attachments: stored.size, links, unresolved, warnings: [...warnings, ...baseWarnings] };
  job.status = "done";
  job.phase = "完成";
}

const FILE_FIELD_LABELS: Record<string, string> = {
  "file.ext": "扩展名",
  "file.path": "路径",
  "file.folder": "文件夹",
  "file.size": "大小",
  "file.mtime": "更新时间",
  "file.ctime": "创建时间",
  "file.tags": "标签",
};

function fileFieldLabel(key: string): string {
  return FILE_FIELD_LABELS[key] ?? key;
}

/** Frontmatter `tags` normalized: a string or list → lowercase names. */
function tagsOf(frontmatter: string): string[] {
  const match = frontmatter.match(/^tags:\s*(.*)$/m);
  if (!match) return [];
  const raw = match[1].trim();
  if (!raw) return [];
  const values = raw.startsWith("[") ? raw.slice(1, -1).split(",") : [raw];
  return values.map((value) => value.trim().replace(/^["']|["']$/g, "").toLowerCase()).filter(Boolean);
}

/** Pull a column's value for one row: file.* derived, formula.* computed,
 *  bare keys from frontmatter, tags merged. */
function valueForKey(
  key: string,
  row: BaseRow,
  spec: { formulas: Array<{ name: string; expr: unknown }> },
  formulaValues?: Record<string, YamlValue>,
): YamlValue {
  if (key.startsWith("formula.")) {
    const computed = formulaValues ?? evalFormulas(spec.formulas as never, rowFacts(row), []);
    return computed[key] ?? null;
  }
  if (key === "tags" || key === "file.tags") return row.tags;
  if (key.startsWith("file.")) {
    const raw = rowFacts(row)[key];
    if ((key === "file.mtime" || key === "file.ctime") && typeof raw === "number" && raw > 0) {
      return new Date(raw).toISOString().slice(0, 10);
    }
    return raw ?? null;
  }
  return row.props[key] ?? null;
}

type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

/* ── Notion ─────────────────────────────────────────────────────────────── */

function importNotion(store: Store, actor: Actor, job: ImportJob, entries: ScannedEntry[]): void {
  const thin = entries.map((e) => ({ path: e.path, bytes: new Uint8Array(), size: e.size, mtime: e.mtime }));
  const index = indexNotion(thin);
  const notes = entries.filter((e) => e.path.toLowerCase().endsWith(".md"));
  if (!notes.length) throw new Error("没有找到 Markdown 笔记。");
  const scope = `user:${actor.user.id}`;
  const entryOf = entryOfFactory(entries);
  const idOf = new Map(notes.map((note) => [note.path, createId("page")]));
  const { hooks, warnings, unresolved, stored } = makeHooks(store, actor, scope, job, entryOf, idOf);

  const rootId = createId("page");
  const rootTitle = "Notion 导入";
  const pages: PageBuild[] = [{ id: rootId, title: rootTitle, blocks: [] }];
  const seen = new Set<string>();

  /** A file `Title [id].md` matching a sibling dir `Title/` is that dir's
   *  own page; its children hang under the page. */
  const pageForDir = (dir: string, dirName: string): ScannedEntry | undefined =>
    notes.find((note) => {
      const base = note.path.split("/").at(-1)!;
      const parent = note.path.split("/").slice(0, -1).join("/");
      return parent === dir && notionTitle(base.replace(/\.md$/i, "")) === dirName;
    });

  const emit = (dir: string, parentId: string) => {
    const prefix = dir ? `${dir}/` : "";
    // Subdirectories, by name.
    const subdirs = new Set<string>();
    for (const entry of entries) {
      if (!entry.path.startsWith(prefix)) continue;
      const rest = entry.path.slice(prefix.length);
      if (rest.includes("/")) subdirs.add(rest.split("/")[0]);
    }
    for (const name of [...subdirs].sort((a, b) => a.localeCompare(b))) {
      const childPath = `${prefix}${name}`;
      const own = pageForDir(childPath.split("/").slice(0, -1).join("/"), name)
        ?? notes.find((note) => note.path === `${childPath}.md`);
      // The dir's own page may sit beside it: `…/X [id].md` next to `X/`.
      const ownFile = pageForDir(dir, name);
      let holder: string;
      const page = ownFile ?? own;
      if (page) {
        holder = idOf.get(page.path)!;
        job.status = "importing";
        job.phase = `导入 ${page.path}…`;
        job.done += 1;
        const blocks = notionPageToBlocks(entryOf(page.path)!.read().toString("utf8"), index, hooks, () => createId("block"));
        pages.push({ id: holder, title: notionTitle(page.path.split("/").at(-1)!.replace(/\.md$/i, "")), blocks, parentId });
        seen.add(page.path);
      } else {
        holder = createId("page");
        pages.push({ id: holder, title: name, blocks: [], parentId });
      }
      emit(childPath, holder);
    }
    // Files directly in this directory, not used as a subdirectory's own page.
    for (const note of notes.filter((n) => n.path.split("/").slice(0, -1).join("/") === dir)) {
      if (seen.has(note.path)) continue;
      // Skip when this file is a subdirectory's own page.
      if (subdirs.has(notionTitle(note.path.split("/").at(-1)!.replace(/\.md$/i, "")))) {
        // It is the page of the matching subdir — handled there; mark seen.
        seen.add(note.path);
        continue;
      }
      const id = idOf.get(note.path)!;
      job.status = "importing";
      job.phase = `导入 ${note.path}…`;
      job.done += 1;
      const blocks = notionPageToBlocks(entryOf(note.path)!.read().toString("utf8"), index, hooks, () => createId("block"));
      pages.push({ id, title: notionTitle(note.path.split("/").at(-1)!.replace(/\.md$/i, "")), blocks, parentId });
      seen.add(note.path);
    }
  };
  // A single shared top directory is the export's own root, not a page.
  const tops = new Set(entries.map((e) => e.path.split("/")[0]));
  const root = tops.size === 1 && entries.every((e) => e.path.includes("/")) ? [...tops][0] : "";
  emit(root, rootId);

  job.phase = "写入记录…";
  commit(store, actor, scope, job, pages);
  job.result = { rootPageId: rootId, title: rootTitle, pages: pages.length, attachments: stored.size, links: 0, unresolved, warnings };
  job.status = "done";
  job.phase = "完成";
}
