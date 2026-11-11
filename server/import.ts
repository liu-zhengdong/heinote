import { inflateRawSync } from "node:zlib";
import { createId } from "../src/core/ids.ts";
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
    const nameLength = file.readUInt16LE(at + 28);
    const extraLength = file.readUInt16LE(at + 30);
    const commentLength = file.readUInt16LE(at + 32);
    const offset = file.readUInt32LE(at + 42);
    const name = decoder.decode(file.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if (flags & 1) throw new Error(`加密的 zip 条目无法导入：${name}`);
    entries.push({
      name,
      size,
      bytes() {
        if (file.readUInt32LE(offset) !== 0x04034b50) throw new Error(`zip 条目损坏：${name}`);
        const headName = file.readUInt16LE(offset + 26);
        const headExtra = file.readUInt16LE(offset + 28);
        const start = offset + 30 + headName + headExtra;
        const body = file.subarray(start, start + size);
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
  const entries: ScannedEntry[] = readZip(zip).map((entry) => ({ path: entry.name, size: entry.size, read: entry.bytes }));
  job.total = entries.length;
  if (job.source === "obsidian") importObsidian(store, actor, job, entries);
  else importNotion(store, actor, job, entries);
}

interface PageBuild {
  id: string;
  title: string;
  blocks: Block[];
  parentId?: string;
}

/** Write pages + their blocks in one transaction. Nothing lands on failure. */
function commit(store: Store, actor: Actor, _scope: string, job: ImportJob, built: PageBuild[]): void {
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
        icon: "", kind: "document",
        ...(page.parentId ? { parent_id: page.parentId } : {}),
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
  store.apply(actor, writes, job.id, [], [], 100000);
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
  const thin = entries.map((e) => ({ path: e.path, bytes: new Uint8Array(), size: e.size }));
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
  for (const note of plan.notes) {
    const entry = entryOf(note.path);
    if (!entry) continue;
    job.phase = `导入 ${note.path}…`;
    job.done += 1;
    const dir = note.path.includes("/") ? note.path.split("/").slice(0, -1).join("/") : "";
    const { blocks } = noteToBlocks(entry.read().toString("utf8"), index, hooks, () => createId("block"));
    links += blocks.filter((b) => b.content.some((r) => r.mention?.kind === "page")).length;
    pages.push({
      id: idOf.get(note.path)!,
      title: note.path.split("/").at(-1)!.replace(/\.md$/i, ""),
      blocks,
      parentId: dir ? folderOf(dir) : rootId,
    });
  }

  job.phase = "写入记录…";
  commit(store, actor, scope, job, pages);
  job.result = { rootPageId: rootId, title: rootTitle, pages: pages.length, attachments: stored.size, links, unresolved, warnings };
  job.status = "done";
  job.phase = "完成";
}

/* ── Notion ─────────────────────────────────────────────────────────────── */

function importNotion(store: Store, actor: Actor, job: ImportJob, entries: ScannedEntry[]): void {
  const thin = entries.map((e) => ({ path: e.path, bytes: new Uint8Array(), size: e.size }));
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
