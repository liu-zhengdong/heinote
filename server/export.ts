import type { Actor, Row, Store } from "./store.ts";
import { pageName } from "../src/core/block-tree.ts";
import { blockTreeToMarkdown, wikilinkDescriber } from "../src/core/export-markdown.ts";
import type { NotePage, StoredFile } from "../src/core/types.ts";
import { ZipStream } from "../src/core/zip.ts";

/* The member's whole workspace as one zip: each page a Markdown file, the
   attachments beside them, and every record raw in records.json (the
   lossless half — history and fields a Markdown cannot hold). The archive
   is self-contained: a picture's link points into its attachments/. */

/* ── Names and places inside the archive ───────────────────────────────── */

const ILLEGAL = /[\\/:*?"<>|\x00-\x1f]/g;

/** A page or folder name safe on every filesystem and inside the zip. */
function safeName(value: string): string {
  const cleaned = value.replace(ILLEGAL, "-").replace(/\s+/g, " ").trim().replace(/^\.+$/, "").slice(0, 120);
  return cleaned || "未命名";
}

/** Distinct names within one directory. */
class Namer {
  private readonly taken = new Set<string>();
  claim(wanted: string): string {
    const base = safeName(wanted);
    if (!this.taken.has(base.toLowerCase())) {
      this.taken.add(base.toLowerCase());
      return base;
    }
    for (let suffix = 2; ; suffix += 1) {
      const candidate = `${base.slice(0, 112)} (${suffix})`;
      if (!this.taken.has(candidate.toLowerCase())) {
        this.taken.add(candidate.toLowerCase());
        return candidate;
      }
    }
  }
}

/** An attachment's stored path, kept only if it stays inside attachments/. */
function cleanAttachmentPath(path: string): string | null {
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.map((part) => part.replace(ILLEGAL, "-")).join("/");
}

/** The page's home plane: the space its shared root points to, else the
 *  plane its own record sits in. (store.page resolves scope the same way.) */
function homeOfPage(pages: Record<string, NotePage>, planes: Map<string, string[]>, pageId: string, fallback: string): string {
  let current: NotePage | undefined = pages[pageId];
  const seen = new Set<string>();
  while (current && !current.share_space_id && current.parent_id && !seen.has(current.id)) {
    seen.add(current.id);
    current = pages[current.parent_id];
  }
  return current?.share_space_id ?? planes.get(pageId)?.[0] ?? fallback;
}

const COLLECTIONS = ["pages", "blocks", "versions", "workspace_settings"] as const;

interface ScopeExport {
  scope: string;
  label: string;
  dir: string;
  pages: NotePage[];
  records: Record<string, Record<string, Row>>;
}

export async function writeExport(out: NodeJS.WritableStream, store: Store, who: Actor): Promise<void> {
  // One consistent snapshot of the index; attachment bytes are immutable
  // and read by hash afterwards, outside the transaction.
  store.db.exec("BEGIN DEFERRED");
  let scopeExports: ScopeExport[];
  let state: { pages: Record<string, NotePage> };
  try {
    state = store.state(who);
    const personal = `user:${who.user.id}`;
    const spaces = store.all("SELECT s.id,s.name FROM spaces s JOIN members m ON s.id=m.space_id WHERE m.user_id=? ORDER BY s.name", who.user.id);
    const scopes = [personal, ...spaces.map((space) => String(space.id))];
    // Each page's record lives in exactly one plane — a shared root's twice:
    // the sharer's plane keeps a pointer record under the same id.
    const planes = new Map<string, string[]>();
    const recordsByScope = new Map<string, Record<string, Record<string, Row>>>();
    for (const scope of scopes) {
      const held: Record<string, Record<string, Row>> = {};
      for (const collection of COLLECTIONS) {
        held[collection] = Object.fromEntries(store.records(scope, collection).map((row) => [row.id, row.value]));
      }
      recordsByScope.set(scope, held);
      for (const id of Object.keys(held.pages)) planes.set(id, [...planes.get(id) ?? [], scope]);
    }
    const homes = new Map(Object.keys(state.pages).map((id) => [id, homeOfPage(state.pages, planes, id, personal)]));

    const dirs = new Namer();
    const scopeDir = new Map(scopes.map((scope, index) => [
      scope,
      dirs.claim(index === 0 ? "个人笔记" : `空间-${safeName(scope === spaces[index - 1]?.id ? String(spaces[index - 1].name) : scope)}`),
    ]));
    scopeExports = scopes.map((scope) => ({
      scope,
      label: scope === personal ? "个人笔记" : String(spaces.find((space) => String(space.id) === scope)?.name ?? scope),
      dir: scopeDir.get(scope)!,
      pages: Object.values(state.pages).filter((page) => homes.get(page.id) === scope),
      records: recordsByScope.get(scope)!,
    }));
    store.db.exec("COMMIT");
  } catch (error) {
    try { store.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw error;
  }

  const missing: string[] = [];
  const manifest = {
    version: 1,
    generated_at: new Date().toISOString(),
    account: { handle: who.user.handle, display_name: who.user.displayName },
    scopes: [] as unknown[],
    missing,
  };
  const zip = new ZipStream({ write: (chunk) => { out.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)); } });
  await zip.add("README.md", readme(scopeExports));

  for (const part of scopeExports) {
    // Every page's zip path: ancestors name directories (each claimed once
    // per directory); a trashed page or ancestor rebases the same relative
    // path under trash/.
    const inScope = new Set(part.pages.map((page) => page.id));
    const namers = new Map<string, Namer>();
    const namerOf = (dir: string) => {
      let namer = namers.get(dir);
      if (!namer) namers.set(dir, namer = new Namer());
      return namer;
    };
    const containers = new Map<string, { path: string; trashed: boolean }>();
    const folders = new Map<string, { path: string; trashed: boolean }>();
    /** One logical directory (pages/…/Parent/) may exist under pages/ and
     *  trash/ at once; names dedupe by the logical path, not the zip path. */
    const logical = (path: string) => path.replace(`${part.dir}/trash/`, `${part.dir}/`);
    const container = (page: NotePage, guard: Set<string>): { path: string; trashed: boolean } => {
      const held = containers.get(page.id);
      if (held) return held;
      const parent = page.parent_id && !guard.has(page.parent_id) ? state.pages[page.parent_id] : undefined;
      let result: { path: string; trashed: boolean };
      if (parent && inScope.has(parent.id)) {
        const above = folder(parent, new Set([...guard, parent.id]));
        // A trashed subtree keeps the parent's relative path under trash/.
        result = above.trashed || page.archived
          ? { path: above.path.replace(`${part.dir}/pages/`, `${part.dir}/trash/pages/`), trashed: true }
          : above;
      } else {
        result = { path: `${part.dir}/${page.archived ? "trash/" : ""}pages/`, trashed: page.archived === true };
      }
      containers.set(page.id, result);
      return result;
    };
    // A page's `.md` and the directory holding its children share one name
    // inside its directory — the file's claim decides both.
    const fileNameOf = (page: NotePage, inside: { path: string }): string =>
      namerOf(logical(inside.path)).claim(pageName(page));
    const folder = (page: NotePage, guard: Set<string>): { path: string; trashed: boolean } => {
      const held = folders.get(page.id);
      if (held) return held;
      const inside = container(page, guard);
      const result = { path: `${inside.path}${fileNameOf(page, inside)}/`, trashed: inside.trashed };
      folders.set(page.id, result);
      return result;
    };
    const paths = new Map<string, string>();
    for (const page of part.pages.sort((a, b) => pageName(a).localeCompare(pageName(b), "zh-Hans") || a.id.localeCompare(b.id))) {
      const inside = container(page, new Set([page.id]));
      if (folders.has(page.id)) {
        // Its directory name was already claimed by a child's folder walk:
        // the file takes the same name without claiming again.
        const claimed = folders.get(page.id)!.path.slice(inside.path.length, -1);
        paths.set(page.id, `${inside.path}${claimed}.md`);
      } else {
        const claimed = fileNameOf(page, inside);
        // The page's file and its children directory are one name.
        folders.set(page.id, { path: `${inside.path}${claimed}/`, trashed: inside.trashed });
        paths.set(page.id, `${inside.path}${claimed}.md`);
      }
    }
    for (const page of part.pages) {
      const path = paths.get(page.id)!;
      const depth = path.split("/").length - 1; // directories between the file and the scope root
      await zip.add(path, pageMarkdown(state.pages, page, depth));
    }

    const fileRows = store.all("SELECT path FROM files WHERE scope=? ORDER BY path", part.scope);
    for (const row of fileRows) {
      const path = cleanAttachmentPath(String(row.path));
      if (!path) continue;
      const file = store.files.read(part.scope, path);
      if (!file) {
        missing.push(`${part.dir}/attachments/${path}`);
        continue;
      }
      await zip.add(`${part.dir}/attachments/${path}`, file.stream);
    }

    await zip.add(`${part.dir}/records.json`, JSON.stringify(part.records));
    manifest.scopes.push({
      scope: part.scope,
      label: part.label,
      directory: part.dir,
      pages: part.pages.length,
      attachments: fileRows.length,
    });
  }

  await zip.add("export.json", JSON.stringify(manifest, null, 2));
  zip.finish();
}

function pageMarkdown(pages: Record<string, NotePage>, page: NotePage, depth: number): string {
  const titleOf = (id: string) => pages[id] ? pageName(pages[id]) : "";
  const prefix = "../".repeat(depth);
  const markdown = blockTreeToMarkdown(page.block_tree, titleOf,
    (file: StoredFile) => `${prefix}attachments/${encodeURI(cleanAttachmentPath(file.path) ?? file.path)}`,
    wikilinkDescriber(titleOf));
  const name = pageName(page);
  if (page.kind === "database" && page.database) {
    const columns = page.database.properties.map((property) =>
      `- ${property.name}（${property.type}${property.options?.length ? `：${property.options.join("、")}` : ""}）`).join("\n");
    const views = page.database.views.map((view) => `- ${view.name}（${view.kind}）`).join("\n");
    return `# ${name}\n\n## 属性\n\n${columns || "- （无）"}\n\n## 视图\n\n${views || "- （无）"}\n\n${markdown}\n`;
  }
  return markdown ? `# ${name}\n\n${markdown}\n` : `# ${name}\n`;
}

function readme(exports: ScopeExport[]): string {
  const scopes = exports.map((part) =>
    `- \`${part.dir}/\` — ${part.label}：\`pages/\` 每页一个 Markdown、\`trash/\` 回收站、\`attachments/\` 图片与文件、\`records.json\` 无损原始记录（含历史版本）`).join("\n");
  return `# Notes 导出\n\n每个目录对应一个可见范围（个人笔记或空间）：\n\n${scopes || "- （无可导出内容）"}\n\n\`export.json\` 说明导出的范围与时间。\n\n- Markdown 中的图片与文件链接指向本压缩包内的 \`attachments/\`。\n- 页面引用保持为页面名称。\n- 完整字段、历史版本与数据库视图定义见各目录的 \`records.json\`。\n`;
}
