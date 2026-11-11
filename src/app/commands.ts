/* What Notes does for people, by name: each a function of one input object,
   doing what the window's own controls do — through the workspace's actions
   (createPage, updatePage, movePage…), the editor's commands on a page's
   composed tree (composite.ts, editor-commands.ts) and the databases' own
   rules (database-model.ts) — and saved before it answers.

   schema.ts declares each as a window operation agents may call, and how
   (description, input, effect); the window registers them once, as it
   opens (`useWindowCommands`, workspace-context.tsx), and the Terminus
   desktop runs them in the person's window when an agent the person allowed
   calls one. A command may rely on what is on screen, as a person does: a
   `page_id` left out is the page open in the window.

   How they can go wrong, and what each does about it:
   - Notes is still opening: wait for the workspace (OPEN_WAIT_MS), else
     `not_ready`.
   - A page, paragraph, property, view or version that is not there — or a
     page in the trash where only a live one will do: `not_found`,
     `in_trash`, never a write.
   - A page the person may only view (a space's Can view): `read_only`, as
     the window refuses them; nothing is written.
   - An input the window's controls could never make (a Select value not
     among its options, a date that is no day, a link that is not http(s) or
     a page, a sort on pictures): `bad_request` before anything is written.
   - A write the platform does not store at once: the change is in the
     window and queued (it is saved when Terminus can be reached), and the
     agent is told `not_saved` rather than that it is done.
   - An agent's change landing inside the person's typing: a write command
     is one step of the window's undo of its own (checkpointed before and
     after), so ⌘Z takes back the agent's change whole and never the
     person's words with it — and what the window keeps out of undo (a
     setting, a favorite, a checkpoint, a delete for good) stays out. */

import type app from "../../schema";
import { createId } from "../core/ids";
import { createBlock, lineLink, linesFor, orderedBlocks, pageName, withLineLink } from "../core/block-tree";
import { embedFromUrl, normalizeEmbed } from "../core/embeds";
import { inlineFromText, isKeptLink, MENTION_CHAR, normalizeInlineContent, normalizeMention } from "../core/inline-content";
import { descendantPageIds, inTrash } from "../core/page-tree";
import { versionList } from "../core/versions";
import type { Block, DatabaseConfig, DatabaseView, InlineContent, NotePage, StoredFile } from "../core/types";
import {
  changePropertyType,
  changeViewKind,
  copiedColumn,
  createView,
  databaseRows,
  duplicateProperty,
  duplicateView,
  insertProperty,
  MAX_ROW_IMAGES,
  newDatabaseConfig,
  removeProperty,
  removeView,
  renameProperty,
  rowValues,
  sortable,
  statusOptions,
  TITLE_COLUMN,
  viewRows,
  withSorts,
  withView,
} from "../features/database/database-model";
import { blockTreeToMarkdown, markdownToBlockTree } from "../features/editor/adapters";
import {
  composeTree,
  duplicateSelection,
  routeTransaction,
  type Composite,
  type ShowInPlace,
} from "../features/editor/composite";
import {
  appendFragment,
  deleteBlocks as deleteBlocksIn,
  moveBlocks as moveBlocksIn,
  ordersBetween,
  pageFromBlocks,
  unwrapPage,
  withoutEmptyPages,
  type EditorTransaction,
} from "../features/editor/editor-commands";
import { backlinksTo } from "../features/editor/mentions";
import { quickFind } from "../features/quickfind/QuickFind";
import type { WorkspaceDocument, WorkspaceMutation } from "../platform/workspace-document";
import type { PagePatch, WorkspaceContextValue } from "./workspace-context";

/** A refusal in the command's own words: the SDK answers its `code`, which
 *  agents branch on, and its message. */
function refuse(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** The window, once Notes has opened in it. */
export interface CommandHost {
  /** Its workspace's actions, as the provider has them now. */
  workspace: WorkspaceContextValue;
  document: WorkspaceDocument;
  /** Who is signed in: the name pages are stamped with. */
  author: string;
  /** The page open in the window, or "". */
  selectedPageId: string;
}

/** The window's operations as schema.ts declares them, each handed its
 *  input typed and checked by the SDK. */
type NotesCommands = Parameters<typeof app.commands>[0];

/** What createBlock and updateBlock both take: a paragraph's words and
 *  fields (schema.ts `paragraph`). */
type ParagraphInput = Omit<Parameters<NonNullable<NotesCommands["createBlock"]>>[0], "page_id" | "before_id" | "after_id" | "parent_block_id">;

/** How long a command waits for Notes to open in a window just started. */
const OPEN_WAIT_MS = 15_000;

const pause = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

/* ── Reading the workspace ─────────────────────────────────────────────── */

const pagesOf = (host: CommandHost) => host.document.state.pages;

/** A page by id — the open page when none is given. */
function pageOf(host: CommandHost, id: string | undefined, options: { trash?: boolean } = {}): NotePage {
  const pageId = id ?? host.selectedPageId;
  if (!pageId) refuse("not_found", "No page is open in the window: name one with page_id (find_pages finds it).");
  const page = pagesOf(host)[pageId];
  if (!page) refuse("not_found", `There is no page ${pageId} in this person's Notes.`);
  if (!options.trash && inTrash(pagesOf(host), page.id)) {
    refuse("in_trash", `${describe(page)} is in the trash: restore_page brings it back first.`);
  }
  return page;
}

const describe = (page: NotePage) => `“${pageName(page) || "Untitled"}”`;

/** A page this person may change — not one of a space where they can only
 *  view. */
function writablePage(host: CommandHost, id: string | undefined, options: { trash?: boolean } = {}): NotePage {
  const page = pageOf(host, id, options);
  if (!host.workspace.canEdit(page.id)) refuse("read_only", `${describe(page)} is in a space where this person can only view.`);
  return page;
}

function documentPage(host: CommandHost, id: string | undefined): NotePage {
  const page = writablePage(host, id);
  if (page.kind !== "document") refuse("bad_request", `${describe(page)} is a database: its rows are pages of their own, and its properties and views are changed with the database commands.`);
  return page;
}

function databasePage(host: CommandHost, id: string | undefined, write = true): { page: NotePage; config: DatabaseConfig } {
  const page = write ? writablePage(host, id) : pageOf(host, id);
  if (page.kind !== "database" || !page.database) refuse("bad_request", `${describe(page)} is not a database.`);
  return { page, config: page.database };
}

/** What a page is, in a few words agents can act on. */
function summary(pages: Record<string, NotePage>, page: NotePage) {
  return {
    id: page.id,
    name: pageName(page),
    kind: page.kind,
    parent_id: page.parent_id,
    ...(page.icon ? { icon: page.icon } : {}),
    ...(page.icon_image ? { icon_image: true } : {}),
    ...(inTrash(pages, page.id) ? { in_trash: true } : {}),
    updated_at: page.updated_at,
  };
}

/* ── Changing it ───────────────────────────────────────────────────────── */

/** One change of an agent's: a step of the window's undo of its own, then
 *  saved — the answer says it is stored, or that it is not yet. */
async function change<T>(host: CommandHost, run: () => T): Promise<T> {
  host.workspace.checkpointHistory();
  let result: T;
  try {
    result = run();
  } finally {
    host.workspace.checkpointHistory();
  }
  try {
    await host.document.flush();
  } catch {
    refuse("not_saved", "Notes made the change in the window but could not save it yet: it stays queued there and is saved once Terminus takes it.");
  }
  return result;
}

/** What is drawn in place in a page — the blocks this person may write in,
 *  as the editor composes them for them. */
function showInPlaceFor(host: CommandHost): ShowInPlace {
  return (_row, target) => host.workspace.canEdit(target.id);
}

/** A page's tree as the editor draws and edits it: its paragraphs, with the
 *  blocks shown in place among them (composite.ts). */
function composed(host: CommandHost, page: NotePage, showInPlace = showInPlaceFor(host)): Composite {
  const pages = pagesOf(host);
  return composeTree(pages, pages[page.id] ?? page, showInPlace);
}

/** What the editor did to a page's tree, written to the pages holding each
 *  node — the editor's own write (DocumentEditor `write`). */
function writeTree(host: CommandHost, page: NotePage, edit: EditorTransaction | null, options: { extra?: WorkspaceMutation[] } = {}): EditorTransaction {
  if (!edit) refuse("bad_request", "That change cannot be made to those paragraphs.");
  const pages = pagesOf(host);
  const current = composed(host, page);
  const transaction = withoutEmptyPages(current.tree, edit, () => createId("block"));
  host.workspace.commitWrites([...(options.extra ?? []), ...routeTransaction(current, pages, transaction, {
    author: host.author,
    now: new Date().toISOString(),
    newId: () => createId("block"),
  })]);
  return transaction;
}

function blockIn(tree: Composite["tree"], id: string): Block {
  const block = Object.hasOwn(tree.by_id, id) ? tree.by_id[id] : undefined;
  if (!block) refuse("not_found", `There is no paragraph ${id} in this page (or a block shown in it).`);
  return block;
}

function blockIds(tree: Composite["tree"], ids: string[]): string[] {
  if (!ids.length || new Set(ids).size !== ids.length) refuse("bad_request", "block_ids lists distinct paragraphs, at least one.");
  ids.forEach((id) => blockIn(tree, id));
  return ids;
}

/* ── Paragraphs as agents write them ───────────────────────────────────── */

/** Rich words from `text` or `content`: links only to the web or a page,
 *  mentions only of pages this person has. */
function richContent(host: CommandHost, input: ParagraphInput): InlineContent | undefined {
  if (input.text !== undefined && input.content !== undefined) refuse("bad_request", "Give text or content, not both.");
  if (input.text !== undefined) return inlineFromText(input.text);
  if (input.content === undefined) return undefined;
  for (const run of input.content) {
    if (run.mention && !normalizeMention(run.mention)) refuse("bad_request", "A mention is a page's (kind page, page_id) or a day's (kind date, date YYYY-MM-DD).");
    if (run.marks?.link && !isKeptLink(run.marks.link)) refuse("bad_request", "A link goes to an http(s) address or a page (#<page id>).");
    if (run.mention?.kind === "page") pageOf(host, run.mention.page_id, { trash: true });
  }
  return normalizeInlineContent(input.content);
}

/** The bytes of a file paragraph this person has, or of the first picture
 *  among a paragraph's words, to use again. */
function fileOf(host: CommandHost, blockId: string): StoredFile {
  for (const page of Object.values(pagesOf(host))) {
    const block = page.block_tree.by_id[blockId];
    const picture = block?.content.find((run) => run.mention?.kind === "image")?.mention;
    const file = block?.file ?? (picture?.kind === "image" ? picture.file : undefined);
    if (file) return structuredClone(file);
  }
  return refuse("not_found", "source_file_block_id names no file paragraph, nor a paragraph holding a picture, in this person's Notes: new bytes are added in Notes itself.");
}

/** A paragraph with what an agent asked of it, held to what the editor can
 *  make: a page row needs its page, media its bytes, a card its address. */
function shaped(host: CommandHost, input: ParagraphInput, original: Block): Block {
  if (original.kind === "page") refuse("bad_request", "That is a block shown in place: its name and icon are its page's (update_page), and it folds with expanded.");
  const next: Block = { ...original };
  const rich = richContent(host, input);
  if (rich !== undefined) next.content = rich;
  for (const key of ["kind", "checked", "language", "color", "icon", "width", "align"] as const) {
    if (input[key] !== undefined) Object.assign(next, { [key]: input[key] });
  }
  // A to-do has its tick, ticked or not; nothing else has one (editor-commands
  // `convertBlock`).
  if (next.kind === "todo") next.checked = next.checked ?? false;
  else delete next.checked;
  // A link to a page goes at the end of the words: alone, the line stands
  // for the page.
  if (input.target_page_id !== undefined) {
    next.content = [...next.content, { text: MENTION_CHAR, mention: { kind: "page", page_id: pageOf(host, input.target_page_id).id } }];
  }
  if (input.source_file_block_id !== undefined) {
    const file = fileOf(host, input.source_file_block_id);
    // A file paragraph's bytes are the paragraph; a picture stands at the
    // end of any other's words.
    if (next.kind === "file") next.file = file;
    else if (file.type.startsWith("image/")) next.content = [...next.content, { text: MENTION_CHAR, mention: { kind: "image", file } }];
    else refuse("bad_request", "That is a file, not a picture: it goes in a paragraph of kind file.");
  }
  if (next.kind === "file" && !next.file) refuse("bad_request", "A file paragraph reuses the bytes of one already in Notes: source_file_block_id.");
  // A card is its link: a YouTube video or a post on X. Its words are read
  // by the first editor who sees it (EmbedBlock), not here.
  if (input.embed_url !== undefined) {
    if (input.kind !== undefined && input.kind !== "embed") refuse("bad_request", "embed_url makes a card: leave kind out, or make it embed.");
    const embed = embedFromUrl(input.embed_url);
    if (!embed) refuse("bad_request", "embed_url is a YouTube video or a post on X.");
    next.kind = "embed";
    next.embed = embed;
  }
  if (next.kind === "embed") {
    if (!normalizeEmbed(next.embed)) refuse("bad_request", "A card needs embed_url: a YouTube video or a post on X.");
    // As a line the editor turns into its card: the words and a line's
    // settings go (editor-commands `embedLink`).
    next.content = [];
    delete next.checked;
    delete next.language;
    delete next.icon;
    delete next.color;
  } else {
    delete next.embed;
  }
  return next;
}

/* ── Databases ─────────────────────────────────────────────────────────── */

function propertyIn(config: DatabaseConfig, id: string, options: { title?: boolean } = {}): string {
  if (options.title && id === TITLE_COLUMN) return TITLE_COLUMN;
  if (!config.properties.some((property) => property.id === id)) {
    refuse("not_found", `No property ${id} in this database: its properties are ${JSON.stringify(config.properties.map(({ id: pid, name, type }) => ({ id: pid, name, type })))}.`);
  }
  return id;
}

function viewIn(config: DatabaseConfig, id: string | undefined): DatabaseView {
  if (id === undefined) return config.views[0];
  const view = config.views.find((candidate) => candidate.id === id);
  if (!view) refuse("not_found", `No view ${id} in this database: its views are ${JSON.stringify(config.views.map(({ id: vid, name, kind }) => ({ id: vid, name, kind })))}.`);
  return view;
}

/** Select options as a list of distinct names. */
function withOptions(config: DatabaseConfig, propertyId: string, options: string[] | undefined): DatabaseConfig {
  if (options === undefined) return config;
  const property = config.properties.find((candidate) => candidate.id === propertyId);
  if (property?.type !== "select") refuse("bad_request", "Only a Select property takes options here; a Status's options are edited in Notes.");
  return { ...config, properties: config.properties.map((candidate) => candidate.id === propertyId ? { ...candidate, options: [...new Set(options)] } : candidate) };
}

/** A row's values as agents read them. */
function rowSummary(pages: Record<string, NotePage>, row: NotePage) {
  const images = Object.fromEntries(Object.entries(row.property_files ?? {}).map(([key, files]) => [key, (files ?? []).map((file) => file.name)]));
  return {
    ...summary(pages, row),
    properties: row.properties ?? {},
    ...(Object.keys(images).length ? { images } : {}),
  };
}

/* ── The commands ──────────────────────────────────────────────────────── */

/** Notes' commands over the window `host()` answers — null until Notes has
 *  opened there. */
export function notesCommands(host: () => CommandHost | null): NotesCommands {
  async function opened(): Promise<CommandHost> {
    for (const started = Date.now(); ;) {
      const current = host();
      if (current) return current;
      if (Date.now() - started > OPEN_WAIT_MS) refuse("not_ready", "Notes is still opening in this window: try again in a moment.");
      await pause(100);
    }
  }

  return {
    /* Reading */

    async findPages(input) {
      const h = await opened();
      const pages = pagesOf(h);
      return {
        pages: quickFind(pages, input.query ?? "").map((hit) => ({
          ...summary(pages, hit.page),
          place: hit.crumb,
          ...(hit.excerpt ? { excerpt: hit.excerpt } : {}),
        })),
      };
    },

    async exportMarkdown(input) {
      const h = await opened();
      const page = pageOf(h, input.page_id, { trash: true });
      let drawn = page;
      if (input.version_id !== undefined) {
        const version = versionList(h.document.state.versions[page.id]).find((candidate) => candidate.id === input.version_id);
        if (!version) refuse("not_found", `${describe(page)} keeps no version ${input.version_id}: list_versions lists the ones it keeps.`);
        drawn = version.snapshot;
      }
      // Read, a page shows every block in it, as a reader sees it.
      const tree = composeTree(pagesOf(h), drawn, () => true).tree;
      return {
        page: summary(pagesOf(h), page),
        ...(input.version_id !== undefined ? { version_id: input.version_id } : {}),
        markdown: blockTreeToMarkdown(tree, (pageId) => pagesOf(h)[pageId]?.title ?? ""),
      };
    },

    async getBacklinks(input) {
      const h = await opened();
      const pages = pagesOf(h);
      const page = pageOf(h, input.page_id, { trash: true });
      return { page_id: page.id, pages: backlinksTo(pages, page).map((linking) => summary(pages, linking)) };
    },

    async listRows(input) {
      const h = await opened();
      const pages = pagesOf(h);
      const { page, config } = databasePage(h, input.page_id, false);
      const view = viewIn(config, input.view_id);
      const rows = viewRows(databaseRows(pages, page.id), view, config.properties, input.search ?? "");
      const at = input.after === undefined ? -1 : rows.findIndex((row) => row.id === input.after);
      if (input.after !== undefined && at < 0) refuse("not_found", "That cursor is no longer a row of this view: list again from the start.");
      const shown = rows.slice(at + 1, at + 1 + input.limit);
      return {
        database_id: page.id,
        view: { id: view.id, name: view.name, kind: view.kind },
        rows: shown.map((row) => rowSummary(pages, row)),
        next_cursor: at + 1 + shown.length < rows.length ? shown.at(-1)?.id ?? null : null,
      };
    },

    async listVersions(input) {
      const h = await opened();
      const page = pageOf(h, input.page_id, { trash: true });
      return {
        page_id: page.id,
        versions: versionList(h.document.state.versions[page.id]).map((version) => ({
          id: version.id,
          summary: version.summary,
          author: version.author_name,
          created_at: version.created_at,
        })),
      };
    },

    /* Pages */

    async createPage(input) {
      const h = await opened();
      const parent = input.parent_id === undefined ? null : writablePage(h, input.parent_id);
      const { kind } = input;
      if (input.view !== undefined && kind !== "database") refuse("bad_request", "view is a database's first view: give kind database.");
      if (input.expanded !== undefined && parent?.kind !== "document") refuse("bad_request", "expanded shows a page in place in the page that holds it: give parent_id, a document.");
      return change(h, () => {
        const id = h.workspace.createPage(parent?.id ?? null, kind, {
          select: false,
          block: parent?.kind === "document",
          title: input.title,
          ...(kind === "database"
            ? { database: newDatabaseConfig(input.view ?? "table", createId("view"), () => createId("property")) }
            : {}),
        });
        if (!id) refuse("not_ready", "Notes is still opening in this window: try again in a moment.");
        if (input.icon) h.workspace.updatePage(id, { icon: input.icon });
        const made = pagesOf(h)[id];
        if (input.text && made) {
          const first = orderedBlocks(made.block_tree)[0];
          if (first) h.workspace.applyBlockMutations(id, [{ action: "put", block: { ...first, content: inlineFromText(input.text) } }]);
        }
        if (input.expanded && parent) {
          const row = linesFor(pagesOf(h)[parent.id]?.block_tree, id)[0];
          if (row) h.workspace.applyBlockMutations(parent.id, [{ action: "put", block: withLineLink(row, (link) => ({ ...link, expanded: true })) }]);
        }
        return { page: summary(pagesOf(h), pagesOf(h)[id]) };
      });
    },

    async updatePage(input) {
      const h = await opened();
      const page = writablePage(h, input.page_id);
      const patch: PagePatch = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.icon !== undefined) patch.icon = input.icon;
      if (input.cover !== undefined) {
        patch.cover = input.cover || undefined;
        // A cover chosen replaces a picture uploaded as the cover, which
        // would otherwise still be drawn over it — as the cover picker does.
        if (page.cover_image !== undefined) patch.cover_image = undefined;
      }
      if (input.full_width !== undefined) patch.full_width = input.full_width || undefined;
      if (input.font !== undefined) patch.font = input.font === "default" ? undefined : input.font;
      if (!Object.keys(patch).length) refuse("bad_request", "Say what to change: title, icon, cover, full_width or font.");
      return change(h, () => {
        h.workspace.updatePage(page.id, patch);
        return { page: summary(pagesOf(h), pagesOf(h)[page.id]) };
      });
    },

    async movePage(input) {
      const h = await opened();
      const page = writablePage(h, input.page_id);
      if ((input.parent_id !== undefined) === (input.top_level === true)) refuse("bad_request", "Give parent_id, or top_level: true — one of them.");
      const target = input.parent_id === undefined ? null : pageOf(h, input.parent_id).id;
      if ((page.parent_id ?? null) === target) return { page: summary(pagesOf(h), page) };
      if (!h.workspace.canMovePage(page.id, target)) {
        refuse("bad_request", "It cannot go there: never into itself or a page inside it, a database or the trash; a shared page stays where it is shared, and a page leaves a shared tree only for someone with Full access.");
      }
      return change(h, () => {
        h.workspace.movePage(page.id, target);
        return { page: summary(pagesOf(h), pagesOf(h)[page.id]) };
      });
    },

    async duplicatePage(input) {
      const h = await opened();
      const page = writablePage(h, input.page_id);
      return change(h, () => {
        const copy = h.workspace.duplicatePage(page.id);
        if (!copy) refuse("not_ready", "Notes is still opening in this window: try again in a moment.");
        return { page: summary(pagesOf(h), pagesOf(h)[copy]) };
      });
    },

    async archivePage(input) {
      const h = await opened();
      const page = writablePage(h, input.page_id);
      if (!h.workspace.canTrashPage(page.id)) refuse("read_only", `${describe(page)} is shared: only someone with Full access moves it to the trash.`);
      return change(h, () => {
        h.workspace.archivePage(page.id);
        return { page_id: page.id, in_trash: true };
      });
    },

    async restorePage(input) {
      const h = await opened();
      const page = writablePage(h, input.page_id, { trash: true });
      if (!page.archived) {
        refuse("bad_request", inTrash(pagesOf(h), page.id)
          ? `${describe(page)} is in the trash with a page above it: restore that page.`
          : `${describe(page)} is not in the trash.`);
      }
      return change(h, () => {
        h.workspace.restorePage(page.id, { select: false });
        return { page: summary(pagesOf(h), pagesOf(h)[page.id]) };
      });
    },

    async deletePage(input) {
      const h = await opened();
      const page = writablePage(h, input.page_id, { trash: true });
      if (!page.archived) refuse("bad_request", `${describe(page)} is not in the trash: only a page in the trash is deleted for good (archive_page first).`);
      if (!h.workspace.canDeletePage(page.id)) refuse("read_only", "Only a knowledge base owner or administrator can permanently delete its pages.");
      const pages = pagesOf(h);
      const gone = [page.id, ...descendantPageIds(pages, page.id)];
      return change(h, async () => {
        await h.workspace.deletePage(page.id);
        return { deleted_page_ids: gone };
      });
    },

    async setFavorite(input) {
      const h = await opened();
      const page = pageOf(h, input.page_id);
      const { favorite } = input;
      if (h.workspace.isFavorite(page.id) === favorite) return { page_id: page.id, favorite };
      return change(h, () => {
        h.workspace.toggleFavorite(page.id);
        return { page_id: page.id, favorite };
      });
    },

    /* Paragraphs */

    async createBlock(input) {
      const h = await opened();
      const page = documentPage(h, input.page_id);
      const { tree } = composed(h, page);
      const anchors = [input.before_id, input.after_id, input.parent_block_id].filter((value) => value !== undefined);
      if (anchors.length > 1) refuse("bad_request", "Give one of before_id, after_id or parent_block_id, or none for the end of the page.");
      let parentId: string | null = null;
      let order: number;
      const anchorId = input.before_id ?? input.after_id;
      if (anchorId !== undefined) {
        const anchor = blockIn(tree, anchorId);
        parentId = anchor.parent_id;
        const siblings = orderedBlocks(tree, parentId);
        const at = siblings.findIndex((block) => block.id === anchor.id);
        const left = input.before_id !== undefined ? siblings[at - 1]?.order : anchor.order;
        const right = input.before_id !== undefined ? anchor.order : siblings[at + 1]?.order;
        order = ordersBetween(left, right, 1)[0];
      } else {
        if (input.parent_block_id !== undefined) parentId = blockIn(tree, input.parent_block_id).id;
        order = ordersBetween(orderedBlocks(tree, parentId).at(-1)?.order, undefined, 1)[0];
      }
      const id = createId("block");
      const block = shaped(h, input, createBlock(id, input.kind ?? "text", { parent_id: parentId, order }));
      return change(h, () => {
        writeTree(h, page, { mutations: [{ action: "put", block }] });
        return { page_id: page.id, block_id: id };
      });
    },

    async updateBlock(input) {
      const h = await opened();
      const page = documentPage(h, input.page_id);
      const current = composed(h, page);
      const original = blockIn(current.tree, input.block_id);
      const fields = Object.keys(input).filter((key) => !["page_id", "block_id", "expanded", "locked"].includes(key));
      const shows = input.expanded !== undefined || input.locked !== undefined;
      if (!fields.length && !shows) refuse("bad_request", "Say what to change.");
      // A page shown in place, or folded on its line: shown, folded or read
      // only here is its link's, in the page that holds it — as the block's
      // mark and menu do it (DocumentEditor `setShown`, `setLocked`).
      const rowId = current.rows.get(original.id) ?? (lineLink(original) ? original.id : undefined);
      const holder = current.owner.get(original.id) ?? page.id;
      if (shows && !rowId) refuse("bad_request", "expanded and locked are a page's link's: block_id is a line holding nothing but a link to a page, or the block shown in place.");
      // The paragraph whole, as the editor puts one: a field taken away (a
      // card's address, once it is words again) is gone from it.
      const edited = fields.length ? shaped(h, input, original) : null;
      return change(h, () => {
        if (edited) writeTree(h, page, { mutations: [{ action: "put", block: edited }] });
        if (shows && rowId) {
          const row = pagesOf(h)[holder]?.block_tree.by_id[rowId];
          if (!row) refuse("not_found", "That row is no longer in its page.");
          const next: Block = withLineLink(row, (link) => {
            const shown = { ...link };
            if (input.expanded === true) shown.expanded = true;
            if (input.expanded === false) {
              delete shown.expanded;
              delete shown.locked;
            }
            if (input.locked === true) shown.locked = true;
            if (input.locked === false) delete shown.locked;
            return shown;
          });
          h.workspace.applyBlockMutations(holder, [{ action: "put", block: next }]);
        }
        return { page_id: page.id, block_id: rowId && shows && !fields.length ? rowId : original.id };
      });
    },

    async deleteBlocks(input) {
      const h = await opened();
      const page = documentPage(h, input.page_id);
      const { tree } = composed(h, page);
      const ids = blockIds(tree, input.block_ids);
      return change(h, () => {
        writeTree(h, page, deleteBlocksIn(tree, ids, createId("block")));
        return { page_id: page.id, deleted_block_ids: ids };
      });
    },

    async duplicateBlocks(input) {
      const h = await opened();
      const page = documentPage(h, input.page_id);
      const current = composed(h, page);
      const ids = blockIds(current.tree, input.block_ids);
      // As the editor duplicates a selection (DocumentEditor
      // `duplicateSelected`): a block shown in place is copied as the page it
      // is, under its name; lines are copied in place, a link among them a
      // link to the same page.
      return change(h, () => {
        const { transaction, copies } = duplicateSelection(current, ids, {
          duplicatePage: h.workspace.duplicatePage,
          newId: () => createId("block"),
        });
        if (transaction) writeTree(h, page, transaction);
        return { page_id: page.id, block_ids: copies };
      });
    },

    async moveBlocks(input) {
      const h = await opened();
      const page = documentPage(h, input.page_id);
      const { tree } = composed(h, page);
      const ids = blockIds(tree, input.block_ids);
      const target = blockIn(tree, input.target_id);
      const edit = moveBlocksIn(tree, ids, { id: target.id, edge: input.position });
      if (!edit) refuse("bad_request", "Paragraphs cannot move into themselves or what is under them.");
      return change(h, () => {
        writeTree(h, page, edit);
        return { page_id: page.id, block_ids: ids };
      });
    },

    async groupBlocks(input) {
      const h = await opened();
      const page = documentPage(h, input.page_id);
      const { tree } = composed(h, page);
      const ids = blockIds(tree, input.block_ids);
      const result = pageFromBlocks(tree, ids, createId("page"));
      if (!result) refuse("bad_request", "Those paragraphs cannot become a block.");
      return change(h, () => {
        if (result.transaction) writeTree(h, page, result.transaction);
        if (input.title !== undefined && pagesOf(h)[result.pageId]) h.workspace.updatePage(result.pageId, { title: input.title });
        return { page_id: page.id, block_page_id: result.pageId };
      });
    },

    async ungroupBlock(input) {
      const h = await opened();
      const page = documentPage(h, input.page_id);
      const { tree } = composed(h, page);
      const block = blockIn(tree, input.block_id);
      const edit = unwrapPage(tree, block.id);
      if (!edit) refuse("bad_request", "That is not a block shown in place: block_id is the block's page id.");
      return change(h, () => {
        writeTree(h, page, edit);
        return { page_id: page.id };
      });
    },

    async importMarkdown(input) {
      const h = await opened();
      const page = documentPage(h, input.page_id);
      const { tree } = composed(h, page);
      const fragment = markdownToBlockTree(input.markdown, () => createId("block"));
      if (!Object.keys(fragment.by_id).length) refuse("bad_request", "markdown holds nothing to add.");
      return change(h, () => {
        writeTree(h, page, { mutations: appendFragment(tree, fragment) });
        return { page_id: page.id, block_ids: orderedBlocks(fragment).map((block) => block.id) };
      });
    },

    /* Databases */

    async createProperty(input) {
      const h = await opened();
      const { page, config } = databasePage(h, input.page_id);
      const oneOf = "Give type for a new property, or copy_of to copy one — one of them.";
      if (input.copy_of !== undefined) {
        if (input.type !== undefined) refuse("bad_request", oneOf);
        const source = propertyIn(config, input.copy_of);
        const copied = duplicateProperty(config, source, createId("property"));
        if (!copied) refuse("bad_request", "That property cannot be copied.");
        let next = copied.config;
        if (input.name !== undefined) next = renameProperty(next, copied.property.id, input.name);
        return change(h, () => {
          h.workspace.updatePage(page.id, { database: next });
          for (const { id, patch } of copiedColumn(databaseRows(pagesOf(h), page.id), source, copied.property)) h.workspace.updatePage(id, patch);
          return { database_id: page.id, property_id: copied.property.id };
        });
      }
      if (input.type === undefined) refuse("bad_request", oneOf);
      const index = Math.min(input.index ?? config.properties.length, config.properties.length);
      const added = insertProperty(config, createId("property"), input.type, index);
      let next = added.config;
      if (input.name !== undefined) next = renameProperty(next, added.property.id, input.name);
      next = withOptions(next, added.property.id, input.options);
      return change(h, () => {
        h.workspace.updatePage(page.id, { database: next });
        return { database_id: page.id, property_id: added.property.id };
      });
    },

    async updateProperty(input) {
      const h = await opened();
      const { page, config } = databasePage(h, input.page_id);
      const key = propertyIn(config, input.property_id, { title: true });
      if (key === TITLE_COLUMN && (input.type !== undefined || input.options !== undefined)) refuse("bad_request", "The row-name column can only be renamed.");
      if (input.name === undefined && input.type === undefined && input.options === undefined) refuse("bad_request", "Say what to change: name, type or options.");
      let next = input.type !== undefined ? changePropertyType(config, key, input.type, databaseRows(pagesOf(h), page.id)) : config;
      if (input.name !== undefined) next = renameProperty(next, key, input.name);
      next = withOptions(next, key, input.options);
      return change(h, () => {
        h.workspace.updatePage(page.id, { database: next });
        return { database_id: page.id, property_id: key };
      });
    },

    async deleteProperty(input) {
      const h = await opened();
      const { page, config } = databasePage(h, input.page_id);
      const key = propertyIn(config, input.property_id);
      return change(h, () => {
        h.workspace.updatePage(page.id, { database: removeProperty(config, key) });
        return { database_id: page.id, property_id: key };
      });
    },

    async setRowProperty(input) {
      const h = await opened();
      const row = writablePage(h, input.page_id);
      const database = row.parent_id ? pagesOf(h)[row.parent_id] : undefined;
      if (database?.kind !== "database" || !database.database) refuse("bad_request", `${describe(row)} is not a row of a database.`);
      const config = database.database;
      const key = propertyIn(config, input.property_id, { title: true });
      const property = config.properties.find((candidate) => candidate.id === key);
      const oneOf = "Give value, or images for an Image property — one of them.";
      if (input.images !== undefined) {
        if (input.value !== undefined) refuse("bad_request", oneOf);
        if (property?.type !== "image") refuse("bad_request", "images is an Image property's: give value for any other.");
        const files = input.images.map((blockId) => {
          const file = fileOf(h, blockId);
          if (!file.type.startsWith("image/")) refuse("bad_request", `${blockId} is a file, not a picture.`);
          return file;
        });
        if (files.length > MAX_ROW_IMAGES) refuse("bad_request", `A cell holds at most ${MAX_ROW_IMAGES} pictures.`);
        return change(h, () => {
          h.workspace.updatePage(row.id, { property_files: { ...(row.property_files ?? {}), [key]: files } });
          return { page_id: row.id, property_id: key, images: files.length };
        });
      }
      if (input.value === undefined) refuse("bad_request", oneOf);
      const { value } = input;
      if (property?.type === "image") refuse("bad_request", "An Image property takes images: file paragraph ids.");
      if (property?.type === "status" && value && !statusOptions(property).some((option) => option.name === value)) {
        refuse("bad_request", `A status is one of ${JSON.stringify(statusOptions(property).map((option) => option.name))}.`);
      }
      if (property?.type === "select" && value && !property.options?.includes(value)) {
        refuse("bad_request", `A Select value is one of its options (${JSON.stringify(property.options ?? [])}): add it with update_property first.`);
      }
      if (property?.type === "date" && value && !isDay(value)) refuse("bad_request", "A date is a real day, YYYY-MM-DD.");
      return change(h, () => {
        if (key === TITLE_COLUMN) h.workspace.updatePage(row.id, { title: value });
        else h.workspace.updatePage(row.id, rowValues(row, { [key]: value }));
        return { page_id: row.id, property_id: key, value };
      });
    },

    async createView(input) {
      const h = await opened();
      const { page, config } = databasePage(h, input.page_id);
      const oneOf = "Give kind for a new view, or copy_of to copy one — one of them.";
      let next: DatabaseConfig;
      let viewId: string;
      if (input.copy_of !== undefined) {
        if (input.kind !== undefined) refuse("bad_request", oneOf);
        const copied = duplicateView(config, viewIn(config, input.copy_of).id, createId("view"));
        if (!copied) refuse("bad_request", "That view cannot be copied.");
        next = copied.config;
        viewId = copied.view.id;
      } else {
        if (input.kind === undefined) refuse("bad_request", oneOf);
        const created = createView(createId("view"), input.kind, config, () => createId("property"));
        next = created.config;
        viewId = created.view.id;
      }
      if (input.name !== undefined) next = withView(next, { ...viewIn(next, viewId), name: input.name });
      return change(h, () => {
        h.workspace.updatePage(page.id, { database: next });
        return { database_id: page.id, view_id: viewId };
      });
    },

    async updateView(input) {
      const h = await opened();
      const { page, config } = databasePage(h, input.page_id);
      const original = viewIn(config, input.view_id);
      const changed = input.kind !== undefined
        ? changeViewKind(original, input.kind, config, () => createId("property"))
        : { view: original, config };
      let view: DatabaseView = { ...changed.view };
      const properties = changed.config.properties;
      const typed = (key: string, types?: string[]) => {
        const property = properties.find((candidate) => candidate.id === key);
        if (!property || (types && !types.includes(property.type))) refuse("bad_request", `The view names a property it cannot use (${key}): ${types ? `one of type ${types.join(" or ")}` : "a property of this database"}.`);
        return property;
      };
      if (input.name !== undefined) view.name = input.name;
      if (input.filter_property_id !== undefined) {
        if (!input.filter_property_id) delete view.filter;
        else {
          typed(input.filter_property_id, ["select", "status"]);
          if (input.filter_value === undefined) refuse("bad_request", "A filter needs filter_value.");
          view.filter = { property_id: input.filter_property_id, value: input.filter_value };
        }
      }
      const sortKey = (key: string) => {
        if (key !== TITLE_COLUMN && !sortable(typed(key))) refuse("bad_request", "Rows never sort by pictures.");
        return key;
      };
      if (input.sort_property_id !== undefined && input.sorts !== undefined) refuse("bad_request", "Give sort_property_id or sorts, not both.");
      if (input.sort_property_id !== undefined) {
        view = withSorts(view, input.sort_property_id ? [{ property_id: sortKey(input.sort_property_id), direction: input.sort_direction }] : []);
      }
      if (input.sorts !== undefined) {
        const keys = input.sorts.map((sort) => ({ property_id: sortKey(sort.property_id), direction: sort.direction }));
        if (new Set(keys.map((sort) => sort.property_id)).size !== keys.length) refuse("bad_request", "Sort by each property once.");
        view = withSorts(view, keys);
      }
      if (input.group_by !== undefined) {
        if (!input.group_by) delete view.group_by;
        else {
          typed(input.group_by, ["status", "select"]);
          view.group_by = input.group_by;
        }
      }
      if (input.date_by !== undefined) {
        if (!input.date_by) delete view.date_by;
        else {
          typed(input.date_by, ["date"]);
          view.date_by = input.date_by;
        }
      }
      if (input.minimal !== undefined) view.minimal = input.minimal;
      if (input.card_preview !== undefined) {
        if (input.card_preview && !["none", "cover", "content"].includes(input.card_preview)) typed(input.card_preview, ["image"]);
        view.card_preview = input.card_preview;
      }
      if (input.card_properties !== undefined) {
        input.card_properties.forEach((key) => typed(key));
        view.card_properties = input.card_properties;
      }
      const next = withView(changed.config, view);
      return change(h, () => {
        h.workspace.updatePage(page.id, { database: next });
        return { database_id: page.id, view_id: view.id };
      });
    },

    async deleteView(input) {
      const h = await opened();
      const { page, config } = databasePage(h, input.page_id);
      const view = viewIn(config, input.view_id);
      const next = removeView(config, view.id);
      if (!next) refuse("bad_request", "A database keeps at least one view.");
      return change(h, () => {
        h.workspace.updatePage(page.id, { database: next });
        return { database_id: page.id, view_id: view.id };
      });
    },

    /* History */

    async checkpointPage(input) {
      const h = await opened();
      const page = writablePage(h, input.page_id);
      const summaryText = input.summary?.trim() || "Checkpoint";
      return change(h, () => {
        if (!h.workspace.checkpointPage(page.id, summaryText)) refuse("too_large", `${describe(page)} is too large for a checkpoint: its history keeps at most 10 MiB.`);
        const newest = versionList(h.document.state.versions[page.id]).at(-1);
        return { page_id: page.id, version_id: newest?.id ?? null };
      });
    },

    async restoreVersion(input) {
      const h = await opened();
      const page = writablePage(h, input.page_id);
      const version = versionList(h.document.state.versions[page.id]).find((candidate) => candidate.id === input.version_id);
      if (!version) refuse("not_found", `${describe(page)} keeps no version ${input.version_id}: list_versions lists the ones it keeps.`);
      return change(h, () => {
        h.workspace.restoreVersion(page.id, version);
        return { page: summary(pagesOf(h), pagesOf(h)[page.id]), restored_version_id: version.id };
      });
    },

    /* The person's own settings */

    async setPreferences(input) {
      const h = await opened();
      const writes: WorkspaceMutation[] = (["theme", "sidebar_view", "sidebar_sort", "sidebar_collapsed"] as const)
        .filter((field) => input[field] !== undefined)
        .map((field) => ({ type: "set", path: ["preferences", field], value: input[field] }));
      if ((input.database_id !== undefined) !== (input.view_id !== undefined)) refuse("bad_request", "A database's view is database_id with view_id.");
      if (input.database_id !== undefined) {
        const { page, config } = databasePage(h, input.database_id, false);
        const view = viewIn(config, input.view_id);
        writes.push({ type: "set", path: ["preferences", "database_views"], value: { ...h.document.state.preferences.database_views, [page.id]: view.id } });
      }
      if (!writes.length) refuse("bad_request", "Say what to change.");
      return change(h, () => {
        h.workspace.commitWrites(writes);
        const { preferences } = h.document.state;
        return {
          theme: preferences.theme,
          sidebar_view: preferences.sidebar_view,
          sidebar_sort: preferences.sidebar_sort,
          sidebar_collapsed: preferences.sidebar_collapsed,
          ...(input.database_id !== undefined ? { database_views: preferences.database_views } : {}),
        };
      });
    },
  };
}

/** Whether `value` is a real calendar day, YYYY-MM-DD. */
function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
}
