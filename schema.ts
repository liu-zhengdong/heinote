/* What HeiNote is built on, declared once. Its collections: its records
   (src/platform/records.ts), kept in the member's own scope and, for the
   page trees shared there, in a space's (`scopes`), each with its shape
   (`fields`), which every host checks on every write and from which the
   app's types are read (src/core/types.ts). A field is limited only where
   it says so. A paragraph's words and a page's name are rich text
   (`t.richText()`): they merge character by character when two people type
   in them at once; every other field is written by a patch of the fields
   that changed. The server holds each collection to its definition, so a
   definition never changes in place. The services it uses, each at the
   version it is built against: the web's pictures, and the card service
   that reads a YouTube video or a post on X
   (src/features/editor/embed-details.ts). Its typefaces are the app's own
   font stacks, which
   every page has (src/platform/fonts.ts). And what agents may use: the
   records they may read (a collection's `agents` word), and the window's
   operations, which agents call in the person's HeiNote window.

   What it declares — the kinds, the colours, the covers, history's limits —
   the app reads from here. It imports nothing of HeiNote's.

   The browser (src/main.tsx) imports this file first; a `Plane`
   (src/platform/plane.ts) opens a collection through the handle it answers,
   by name, and a space's records through its `.in(spaceId)`. History is
   bounded by the host's retention. */

import { schema, t } from "./src/platform/schema";

/** What a paragraph is: a line of words, a heading, a list item, a code
 *  block, a file. A picture, or a link to a page, is never a paragraph of
 *  its own: it stands among a line's words, and a line that holds nothing
 *  else is it on a line of its own. A page lives in its parent, as a file in
 *  a folder (`parent_id`); its words only link to pages. */
export const BLOCK_KINDS = ["text", "heading1", "heading2", "heading3", "todo", "bullet", "numbered", "quote", "callout", "divider", "code", "file", "table", "embed"] as const;

/** Notion's nine colours, in the order Notion lists them. A block or a run of
 *  text takes one as its text colour, or — with `_background` — as a
 *  highlight behind it. */
export const COLOR_NAMES = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;
export const CONTENT_COLORS = [...COLOR_NAMES, ...COLOR_NAMES.map((name) => `${name}_background` as const)];

/** The gradients a page's cover may be (features/editor/page-decoration.ts). */
export const COVER_IDS = ["slate", "dawn", "moss", "tide", "orchid", "clay", "ink", "paper"] as const;

/** What a database's property holds, and the layouts of its views. The
 *  order is Notion's: words and numbers first, the tags and the moment,
 *  then the pictures; the meta columns — a row's own record read as a
 *  property, never written — close the list. */
export const PROPERTY_TYPES = [
  "text", "number", "select", "multi_select", "status", "date", "person", "image",
  "checkbox", "url", "email", "phone", "relation",
  "created_time", "last_edited_time", "created_by", "last_edited_by", "id",
] as const;
export const VIEW_KINDS = ["table", "board", "list", "gallery", "calendar"] as const;

/** The member's colour schemes: the system's, or one held. */
export const THEMES = ["system", "light", "dark"] as const;

/** The page list's four views and the file tree's six orders. */
export const SIDEBAR_VIEWS = ["files", "favorites", "shared", "graph", "trash"] as const;
export const SIDEBAR_SORTS = ["name", "name-desc", "modified", "modified-asc", "created", "created-asc"] as const;

/** How much history a page keeps: the host retires what is past them. */
export const HISTORY_LIMIT = 20;
export const HISTORY_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const HISTORY_BUDGET_BYTES = 10 * 1024 * 1024;

/** The host retires a complete checkpoint (all parts) as one entry. */
const HISTORY_RETENTION = {
  groupBy: "page", entryBy: "version", timestamp: "created_at",
  maxAgeSeconds: HISTORY_AGE_MS / 1000, maxEntries: HISTORY_LIMIT, maxBytes: HISTORY_BUDGET_BYTES,
};

/* ── What the commands take ───────────────────────────────────────────────
   `t` fields, each saying what it is to the agent choosing it, and left out
   unless it is required. Field names are the agents': snake_case, as
   HeiNote's ids. */

const pageId = t.id().optional().describe("The page: its id (find_pages, list_pages, whats_open). Left out, the page open in the window.");
const databaseId = t.id().optional().describe("The database page: its id. Left out, the page open in the window.");
const paragraphs = t.list(t.id(), 100).describe("The paragraphs.");
const COLORS = ["", ...CONTENT_COLORS];
/** What an agent may make a paragraph: every kind but a table. */
const PARAGRAPH_KINDS = BLOCK_KINDS.filter((kind) => kind !== "table");
const options = t.list(t.name(), 100).optional().describe("A Select's or Multi-select's options.");

/** A run of words with its marks, or a mention. */
const run = t.object({
  text: t.string(32000).describe("The words; a mention's is the one invisible character U+2063."),
  marks: t.object({
    bold: t.bool().optional(), italic: t.bool().optional(), underline: t.bool().optional(), strike: t.bool().optional(), code: t.bool().optional(),
    link: t.string(2048).optional().describe("An http(s) address, or #<page id>."),
    color: t.choice(...COLORS).optional(),
  }).optional(),
  mention: t.object({
    kind: t.choice("page", "date"),
    page_id: t.id().optional(),
    date: t.date().optional(),
    /** A page link shown in place, and the database view it pins. */
    expanded: t.bool().optional(),
    locked: t.bool().optional(),
    view: t.id().optional().describe("A database view's id, when the page link pins one (a linked view)."),
  }).optional(),
});

/** What a paragraph is, as createBlock and updateBlock take it. */
const paragraph = {
  kind: t.choice(...PARAGRAPH_KINDS).optional().describe("Its kind; text unless said."),
  text: t.string(32000).optional().describe("Its words, plain (or content, not both)."),
  content: t.list(run, 500).optional().describe("Its words as runs with marks, links and mentions (or text, not both)."),
  checked: t.bool().optional().describe("A to-do's tick."),
  language: t.string(64).optional().describe("A code paragraph's language."),
  color: t.choice(...COLORS).optional().describe("Its colour, or a _background highlight; empty for none."),
  icon: t.string(64).optional().describe("A callout's emoji."),
  target_page_id: t.id().optional().describe("A page to link to: the link goes at the end of its words."),
  source_file_block_id: t.id().optional().describe("A paragraph holding a picture, or a file paragraph, whose bytes it shows: a file paragraph's become this one's; a picture's go at the end of its words."),
  embed_url: t.string(2048).optional().describe("A YouTube video or a post on X: makes the paragraph its card."),
  width: t.number(1, 10000).optional().describe("A card's width, in pixels."),
  align: t.choice("center", "right").optional().describe("Where its words — and a picture among them — stand across the line; unset, at its start."),
};

/* ── What each record holds ────────────────────────────────────────────
   Its fields, at every depth, as the code writes them. What a record
   schema cannot say is a JSON object here (`t.json`), read through HeiNote's
   own checks: a card, and the maps a database and a table keep. */

const object = () => t.json({ type: "object" });
const option_colors = object().optional().describe("Each option's pill colour, by its name: default, or one of the nine content colours (gray…red).");

/** Bytes a picture or a file paragraph shows, stored beside the pages: in
 *  the member's own storage for a private page, in the space for a shared
 *  one (`space`), each member's apart (`owner`). A picture's own size draws
 *  its box before its bytes arrive; `preview` is a smaller copy beside a
 *  large original. */
const storedFile = t.object({
  path: t.string(), owner: t.string(), space: t.string().optional(), name: t.string(), size: t.number(), type: t.string(),
  width: t.number().optional(), height: t.number().optional(), preview: t.string().optional(),
});

/** A paragraph's own fields, but its words. */
const paragraphFields = {
  id: t.string(),
  kind: t.choice(...BLOCK_KINDS),
  /** The paragraph it is under; none at the top of its page. */
  parent_id: t.string().optional(),
  order: t.number(),
  checked: t.bool().optional(),
  language: t.string().optional(),
  color: t.choice(...CONTENT_COLORS).optional(),
  /** A callout's emoji, in place of the default 💡. */
  icon: t.string().optional(),
  /** A file paragraph's bytes; its caption is its words. */
  file: storedFile.optional(),
  name: t.string().optional(),
  /** How wide a picture is drawn, in CSS pixels; the column's when unset. */
  width: t.number().optional(),
  /** Where its words, pictures among them, stand across the line; unset,
   *  at its start. */
  align: t.choice("center", "right").optional(),
  table: t.object({
    columns: t.list(t.object({ id: t.string(), width: t.number().optional() })),
    rows: object().describe("Its rows by id: each { order, cells }, its cells' words by column id."),
    header_row: t.bool().optional(),
    header_column: t.bool().optional(),
  }).optional(),
  embed: object().optional().describe("A card: the YouTube video or the post on X its address names."),
};

/** A database's properties, as the pages it holds keep their values. */
const property = t.object({
  id: t.string(),
  name: t.string(),
  type: t.choice(...PROPERTY_TYPES),
  options: t.list(t.string()).optional(),
  /** A select's or multi-select's option colours, by the option's name —
   *  each Notion's grey or one of its nine. */
  option_colors: object().optional(),
  /** The mark drawn beside the column's name, a key of `PROPERTY_ICONS`;
   *  unset, or unknown to a build, the type's. */
  icon: t.string().optional(),
  /** A status's options, each in its group — not begun, under way,
   *  finished — its pill Notion's grey or one of its nine. Unset, Notion's
   *  three; kept through a change of type, so a Status turned into Text and
   *  back still has its own. */
  status_options: t.list(t.object({
    id: t.string(), name: t.string(), color: t.choice("default", ...COLOR_NAMES), group: t.choice("todo", "progress", "complete"),
  })).optional(),
  /** The option a row reads as until one is chosen; unset, the first To-do. */
  default_status: t.string().optional(),
  /* A relation's target: the database page its rows link to. On the mirror
   *  a two-way relation makes on that database, `relation_origin` is the
   *  forward property's id on the database that made it; the forward
   *  property has `relation_two_way` and names the mirror. */
  relation_database: t.id().optional(),
  relation_limit: t.choice("unlimited", "1").optional(),
  relation_two_way: t.bool().optional(),
  /** The mirror property's name on the target database; unset, the
   *  database's own title. */
  relation_backlink_name: t.string().optional(),
  /** A mirror's: the forward relation property's id, on `relation_database`. */
  relation_origin: t.string().optional(),
});

const sort = t.object({ property_id: t.string(), direction: t.choice("asc", "desc") });

/** One filter condition: a property, an operator (its type's default when
 *  left out) and, for the operators that need one, a value. */
const filterCondition = t.object({
  property_id: t.string(),
  op: t.string().optional(),
  value: t.string().optional(),
});

/** A view's filter, as Notion's panel builds it: conditions — and at most
 *  one group of them, joined by its own and/or — all AND-ed together. A
 *  group never holds a group. */
const viewFilter = t.union([
  filterCondition,
  t.object({ logic: t.choice("and", "or"), conditions: t.list(filterCondition, 100) }),
]);

/** A saved way of looking at a database. Views belong to the database, so
 *  they are shared with everyone who can see it, as in Notion; which view a
 *  person has open is theirs alone (`database_views`). A column is a
 *  property's id, or the row-name column's (`TITLE_COLUMN`). */
const view = t.object({
  id: t.string(),
  name: t.string(),
  kind: t.choice(...VIEW_KINDS),
  filter: t.object({ property_id: t.string(), value: t.string() }).optional(),
  /** What hides rows, item by item. Written, it replaces `filter` — the
   *  old field — which a view saved this way no longer holds. Read, a
   *  `filters` is used; a view holding only `filter` reads as one `is`. */
  filters: t.list(viewFilter, 100).optional(),
  /** The rows' order, as Notion's sorts: by the first key, rows alike on it
   *  by the next, and so on. */
  sorts: t.list(sort).optional(),
  /** Board: the status or select property whose options are the columns.
   *  Table and list: the property whose values head the row groups. */
  group_by: t.string().optional(),
  /** Table, list and gallery: the properties not drawn. The row-name column
   *  is never in it — a database without a name is a table without a spine. */
  hidden: t.list(t.string(), 100).optional(),
  /** Table: the footer calculation each column runs over the filtered rows,
   *  by column (property id or the row-name column). */
  calcs: t.record(t.string()).optional(),
  /** Calendar: the date property that places each row on a day. */
  date_by: t.string().optional(),
  /** Table: drawn as a plain Markdown table. */
  minimal: t.bool().optional(),
  /** Gallery: what a card shows above its name — an Image property's first
   *  picture (its id), the page's cover ("cover"), its first lines
   *  ("content") or nothing ("none"); unset, the first Image property, else
   *  the first lines. And the properties a card shows; unset, every one. */
  card_preview: t.string().optional(),
  card_properties: t.list(t.string()).optional(),
  /** Table: each column's width in CSS pixels, set by dragging its edge,
   *  and the columns whose words keep to one line (false), by its "Wrap
   *  text"; every other column wraps. */
  widths: object().optional().describe("Each column's width, by property id."),
  wrap: object().optional().describe("The columns whose words keep to one line (false), by property id."),
});

/** How the graph draws the workspace — Obsidian's graph settings: what it
 *  shows (filters: the pages a query finds, database rows or not, pages
 *  joined to nothing or not, how far around a page), what it colours
 *  (groups), how it draws (arrows, when names show, how big the dots and
 *  how thick the lines are) and how it lays out (forces), and which of the
 *  panel's sections are open. */
const graph = t.object({
  search: t.string(), rows: t.bool(), orphans: t.bool(), depth: t.number(),
  groups: t.list(t.object({ query: t.string(), color: t.choice(...COLOR_NAMES) })),
  arrows: t.bool(), text_fade: t.number(), node_size: t.number(), link_thickness: t.number(),
  center_force: t.number(), repel_force: t.number(), link_force: t.number(), link_distance: t.number(),
  open: t.object({ filters: t.bool(), groups: t.bool(), display: t.bool(), forces: t.bool() }),
});

export default schema({
  collections: {
    // A member's own pages, and the page trees shared into a space: the
    // same collections in either scope. Agents read pages and paragraphs as
    // records: a page's record (its id the page's) holds its name, icon,
    // parent and database; a paragraph's, its page, kind and words.
    pages: {
      scopes: ["personal", "space"],
      fields: {
        id: t.string(),
        title_content: t.richText().describe("Its name: the only place it is kept."),
        icon: t.string(),
        kind: t.choice("document", "database", "app"),
        /** The page it is in; none at the top level. */
        parent_id: t.string().optional(),
        /** A database row's values, words, and its pictures apart from them,
         *  so a column can change type and back with neither kind of value
         *  standing in the other's place. */
        properties: object().optional().describe("A database row's values, by property id."),
        property_files: object().optional().describe("A database row's pictures, by the id of the Image property holding them."),
        database: t.object({
          properties: t.list(property),
          views: t.list(view),
          /** The column holding each row's name — Notion's title property —
           *  and its mark; unset, "Name" and Notion's "Aa". */
          title_name: t.string().optional(),
          title_icon: t.string().optional(),
        }).optional(),
        /** An app's HTML source and the databases it may reach. `draft` is
         *  the copy being edited; `enabled` is what members run. Public
         *  shares strip this object before the record leaves the server. */
        app: t.object({
          enabled: t.string().optional(),
          draft: t.string().optional(),
          databases: t.list(t.object({ id: t.string(), read: t.bool(), write: t.bool() })).optional(),
        }).optional(),
        created_at: t.string(),
        updated_at: t.string(),
        created_by: t.string(),
        updated_by: t.string(),
        archived: t.bool().optional(),
        /** When it went to the trash. */
        archived_at: t.string().optional(),
        /** Where it stands among its database's rows, as a moment in
         *  milliseconds; unset, the moment it was made. */
        row_order: t.number().optional(),
        /** The space it was shared into, on the page shared there. */
        share_space_id: t.string().optional(),
        /** A gradient, or a picture from the member's computer, which wins
         *  over it: whatever sets one clears the other. */
        cover: t.choice(...COVER_IDS).optional(),
        cover_image: storedFile.optional(),
        /** A picture icon from the member's computer. It and `icon` set
         *  one another out: whatever sets one clears the other. */
        icon_image: storedFile.optional(),
        /** Notion's "Full width" and font, which travel with the page. */
        full_width: t.bool().optional(),
        font: t.choice("default", "serif", "mono").optional(),
      },
      agents: "read",
    },
    blocks: {
      scopes: ["personal", "space"],
      fields: { page: t.string().describe("The page it is a paragraph of."), ...paragraphFields, content: t.richText() },
      agents: "read",
    },
    // A part of a page's checkpoint (src/platform/history-record.ts).
    versions: {
      scopes: ["personal", "space"],
      fields: {
        page: t.string(), version: t.string(), generation: t.string(), created_at: t.string(),
        part: t.int(), parts: t.int(), payload: t.string(),
      },
      retention: HISTORY_RETENTION,
    },
    // The member's own settings, which nobody else sees: `preferences` and
    // `roots` (the top level's order).
    workspace_settings: {
      fields: {
        theme: t.choice(...THEMES).optional(),
        sidebar_width: t.number().optional(),
        sidebar_collapsed: t.bool().optional(),
        database_views: object().optional().describe("The view each database was last open on, by database id."),
        /** Starred pages, in the order they were starred: this member's alone. */
        favorites: t.list(t.string()).optional(),
        sidebar_view: t.choice(...SIDEBAR_VIEWS).optional(),
        sidebar_sort: t.choice(...SIDEBAR_SORTS).optional(),
        graph: graph.optional(),
        roots: t.list(t.string()).optional(),
      },
      agents: "read",
    },
  },
  services: {
    /** A post's pictures and a video's still, as bytes (embed-details.ts). */
    web: "@heinote/web@0.0.1",
    /** What a card says: a video's title and channel, a post's author,
     *  words and pictures (embed-details.ts). */
    cards: "@heinote/web-card-preview@0.0.1",
  },
  /* The window's operations (src/app/commands.ts): what the app does for
     people in the person's window. Agents reach HeiNote's data through the
     server API; these stay declared so the handlers' types keep checking.
     They see every page the window does — the person's own and
     their spaces' — and change them as the window's own controls do. */
  operations: {
    findPages: {
      runs: "window",
      effect: "read",
      description: "Find pages as ⌘K (Quick Find) does: names that start with the words, then names that contain them, then pages with a line that does (that line comes back as excerpt) — at most 12. Without words, the 8 pages changed last. Never the trash. Each has its id (the page_id of the other commands; open it with open {page: \"/?page=<id>\"}), name, kind and place (the pages above it).",
      input: { query: t.string(200).optional().describe("The words to find.") },
    },
    exportMarkdown: {
      runs: "window",
      effect: "read",
      description: "Read a page as Markdown, as HeiNote copies it: its paragraphs in order with the blocks shown in it — headings, lists, to-dos, quotes, code, tables, dividers, links and page mentions; pictures and files by name. version_id reads a checkpoint from its history (list_versions) instead. A database's rows are list_rows'.",
      input: { page_id: pageId, version_id: t.id().optional().describe("A checkpoint of the page's, from list_versions.") },
    },
    getBacklinks: {
      runs: "window",
      effect: "read",
      description: "The pages that link to a page, as its Backlinks count them: links from outside the page it lives in only.",
      input: { page_id: pageId },
    },
    listRows: {
      runs: "window",
      effect: "read",
      description: "A database's rows in a view's order: its filter, then its sorts (first key first); rows alike keep the order they were added in. view_id is the database's first view unless said; search keeps rows whose name contains the words. Each row is a page — its id, name, and values by property id (property ids and views are in the database page's record, get_page). Paged: pass next_cursor back as after.",
      input: {
        page_id: databaseId,
        view_id: t.id().optional().describe("One of its views."),
        search: t.string(200).optional().describe("Words a row's name contains."),
        filters: t.list(viewFilter, 100).optional().describe("Conditions, or one group of them, AND-ed together — instead of the view's own filter."),
        after: t.id().optional().describe("next_cursor of the page before."),
        limit: t.int(1, 100).default(50).describe("At most this many rows."),
      },
    },
    listVersions: {
      runs: "window",
      effect: "read",
      description: "A page's history: the checkpoints kept of it (at most 20, none older than 30 days), oldest first — each with its id, summary, author and time. Read one with export_markdown {version_id}; bring one back with restore_version.",
      input: { page_id: pageId },
    },
    createPage: {
      runs: "window",
      effect: "write",
      description: "Make a page, as New page does: at the top level, inside a page (it lives there, as a file in a folder, and a link to it goes at the end of that page's words; expanded shows it there in place, as a block), or inside a database (a row of it). kind database makes a database whose first view is view (table unless said). title, icon (an emoji) and text (its first paragraph) are optional; add more with import_markdown. The window stays where it is. Answers the new page.",
      input: {
        title: t.string(500).optional().describe("Its name."),
        icon: t.string(64).optional().describe("An emoji."),
        text: t.string(32000).optional().describe("Its first paragraph."),
        parent_id: t.id().optional().describe("The page or database it goes in; left out, the top level."),
        kind: t.choice("document", "database", "app").default("document").describe("A page of words, a database, or an HTML app."),
        view: t.choice(...VIEW_KINDS).optional().describe("A database's first view."),
        expanded: t.bool().optional().describe("Its link in its parent page shows it in place, as a block."),
        locked: t.bool().optional().describe("Its link in its parent page keeps it read only there; with expanded, on a database, the link pins its first view — a linked view."),
      },
    },
    updatePage: {
      runs: "window",
      effect: "write",
      description: "Rename or decorate a page: its title (a rename keeps the links on the words it leaves), icon (an emoji; empty for none), cover (one of HeiNote's gradients; empty for none — it replaces a cover picture), full_width, and font. A database row's values are set with set_row_property.",
      input: {
        page_id: pageId,
        title: t.string(500).optional().describe("Its new name."),
        icon: t.string(64).optional().describe("An emoji, or empty for none."),
        cover: t.choice("", ...COVER_IDS).optional().describe("A gradient, or empty for none."),
        full_width: t.bool().optional().describe("Words across the whole window."),
        font: t.choice("default", "serif", "mono").optional().describe("Its typeface."),
      },
    },
    movePage: {
      runs: "window",
      effect: "write",
      description: "Move a page — its row, and everything in it — as Move to does: under another page (parent_id), or to the top level (top_level). Never into itself or a page inside it, into a database or into the trash; a shared page stays where it is shared, and a page leaves a shared tree only for someone with Full access.",
      input: {
        page_id: pageId,
        parent_id: t.id().optional().describe("The page it goes in."),
        top_level: t.bool().optional().describe("To the top level."),
      },
    },
    duplicatePage: {
      runs: "window",
      effect: "write",
      description: "Copy a page with everything in it, as Duplicate does: named \"<name> (copy)\", its row right after the original's, every page and paragraph under a fresh id; a database row keeps its values. Answers the copy.",
      input: { page_id: pageId },
    },
    archivePage: {
      runs: "window",
      effect: "write",
      description: "Move a page and everything in it to the trash, as Move to trash does: links to it stay, reading as in the trash, and restore_page brings it back.",
      input: { page_id: pageId },
    },
    restorePage: {
      runs: "window",
      effect: "write",
      description: "Bring a page back from the trash, as Restore does: into the page it lived in, or the top level when that is gone. A page in the trash with a page above it comes back with that one.",
      input: { page_id: t.id().describe("The page in the trash.") },
    },
    deletePage: {
      runs: "window",
      effect: "write",
      description: "Delete a page in the trash for good — everything in it and its history — as Delete permanently does. It cannot be undone, so a page not in the trash is refused: archive_page first.",
      input: { page_id: t.id().describe("The page in the trash.") },
    },
    setFavorite: {
      runs: "window",
      effect: "write",
      description: "Star or unstar a page in the person's own Favorites. Nothing on the page changes — it may be shared — and nobody else sees it.",
      input: { page_id: pageId, favorite: t.bool().describe("true to star, false to unstar.") },
    },
    createBlock: {
      runs: "window",
      effect: "write",
      description: "Add a paragraph to a page: its kind (text unless said; headings, todo, bullet, numbered, quote, callout, divider, code, file, embed) with text or content (runs with marks, http(s) or #page links, page and date mentions), checked, language, color, icon, align. target_page_id links a page at the end of its words — alone, the line stands for the page; file shows an existing file paragraph's bytes, and any other kind takes a picture already in HeiNote at the end of its words (source_file_block_id); embed_url makes a YouTube or X card. At the end unless before_id, after_id or parent_block_id (inside it) says.",
      input: {
        page_id: pageId,
        ...paragraph,
        before_id: t.id().optional().describe("The paragraph it goes before."),
        after_id: t.id().optional().describe("The paragraph it goes after."),
        parent_block_id: t.id().optional().describe("The paragraph or block it goes inside, last."),
      },
    },
    updateBlock: {
      runs: "window",
      effect: "write",
      description: "Change a paragraph — its words (text or content), kind, checked, language, color, icon, link target, file or card — as the editor does. A line holding nothing but a link to a page, or a block shown in place (its id is its page's): expanded true shows the page in place, false folds it into its link; locked keeps it read only there. Its page's name and icon are update_page's.",
      input: {
        page_id: pageId,
        block_id: t.id().describe("The paragraph, or the block shown in place."),
        ...paragraph,
        expanded: t.bool().optional().describe("A sub-page's: shown in place (true) or folded into its row (false)."),
        locked: t.bool().optional().describe("A sub-page shown in place: read only there."),
        view: t.string(256).optional().describe("A database link's: the database view it pins, as a linked view (\"\" pins none again)."),
      },
    },
    deleteBlocks: {
      runs: "window",
      effect: "write",
      description: "Delete paragraphs and everything under them, as Delete does. A block or a sub-page's row among them sends its page to the trash, whole (restore_page brings it back).",
      input: { page_id: pageId, block_ids: paragraphs },
    },
    duplicateBlocks: {
      runs: "window",
      effect: "write",
      description: "Copy paragraphs, with what is under them, right after the last of them — under fresh ids, as Duplicate does. A block shown in place is copied as the page it is; a sub-page's row brings a copy of its page.",
      input: { page_id: pageId, block_ids: paragraphs },
    },
    moveBlocks: {
      runs: "window",
      effect: "write",
      description: "Move paragraphs, with what is under them, above, below or inside another paragraph or block of the page, as dragging them does. Nothing moves into itself.",
      input: {
        page_id: pageId,
        block_ids: paragraphs,
        target_id: t.id().describe("The paragraph they go by."),
        position: t.choice("above", "below", "inside").describe("Where, by the target."),
      },
    },
    groupBlocks: {
      runs: "window",
      effect: "write",
      description: "Make a block of paragraphs, as Turn into block does: the run of them becomes a page of its own, shown in place where they were; title names it. Answers the block's page id.",
      input: { page_id: pageId, block_ids: paragraphs, title: t.string(500).optional().describe("The block's name.") },
    },
    ungroupBlock: {
      runs: "window",
      effect: "write",
      description: "Take a block apart, as Ungroup does: its paragraphs stay where they are, in the page around it, and the block's page goes.",
      input: { page_id: pageId, block_id: t.id().describe("The block shown in place: its page's id.") },
    },
    importMarkdown: {
      runs: "window",
      effect: "write",
      description: "Add Markdown at the end of a page, as pasting it does: headings, lists, to-dos, quotes, code fences, tables, dividers, bold, italic, inline code, strikethrough and links.",
      input: { page_id: pageId, markdown: t.string(100000).describe("The Markdown.") },
    },
    createProperty: {
      runs: "window",
      effect: "write",
      description: "Add a property — a column — to a database, as Add property does: type text, number, select, multi_select, status, date, person, image, checkbox, url, email, phone, or a read-only meta column (created_time, last_edited_time, created_by, last_edited_by, id, which read the row's own record); a name; a Select's or Multi-select's options and their colours; index places it (0 first). copy_of copies a property instead, its values with it, as Duplicate does.",
      input: {
        page_id: databaseId,
        type: t.choice(...PROPERTY_TYPES).optional().describe("What it holds."),
        name: t.string(200).optional().describe("Its name."),
        options,
        option_colors,
        index: t.int(0).optional().describe("Where it goes among the properties; last unless said."),
        copy_of: t.id().optional().describe("A property to copy."),
        /* A relation's: the database it links rows to, a limit of one page,
           and a two-way's mirror named on the target (its own title when
           unnamed). */
        relation_database: t.id().optional().describe("A relation's target: the database page its values link to."),
        relation_limit: t.choice("unlimited", "1").optional().describe("A relation's limit: \"1\" links at most one page."),
        relation_two_way: t.bool().optional().describe("A relation's: the target database shows the links back under a mirror property."),
        relation_backlink_name: t.string(200).optional().describe("A two-way relation's mirror property name; the database's own title when left out."),
      },
    },
    updateProperty: {
      runs: "window",
      effect: "write",
      description: "Rename a database property, change its type (values are kept where the new type can hold them, as Change type does), or set a Select's or Multi-select's options and their colours. The row-name column (property_id name) is only renamed.",
      input: {
        page_id: databaseId,
        property_id: t.id().describe("The property, or name for the row-name column."),
        name: t.string(200).optional().describe("Its new name."),
        type: t.choice(...PROPERTY_TYPES).optional().describe("Its new type."),
        options,
        option_colors,
        relation_limit: t.choice("unlimited", "1").optional().describe("A relation's limit: \"1\" links at most one page."),
        relation_two_way: t.bool().optional().describe("A relation's: turn the mirror on the target database on or off."),
        relation_backlink_name: t.string(200).optional().describe("A two-way relation's mirror property name."),
      },
    },
    deleteProperty: {
      runs: "window",
      effect: "write",
      description: "Remove a property from a database, as Delete does: views stop filtering, sorting, grouping or dating by it, and the rows keep their values.",
      input: { page_id: databaseId, property_id: t.id().describe("The property.") },
    },
    setRowProperty: {
      runs: "window",
      effect: "write",
      description: "Set a database row's value: value for text; number (a real number); url, email or phone (the address); select (one of its options); multi_select (a JSON array of its option names, or the names comma-separated); status (one of its options); date (YYYY-MM-DD, or a range YYYY-MM-DD/YYYY-MM-DD); checkbox (true, false or empty); or person — empty to clear. The meta columns (created_time, last_edited_time, created_by, last_edited_by, id) are read-only. images (picture paragraph ids, their bytes reused) for an Image property. property_id name renames the row.",
      input: {
        page_id: t.id().describe("The row: a page of the database."),
        property_id: t.id().describe("The property, or name for the row's name."),
        value: t.string(2000).optional().describe("Its value; empty clears it."),
        images: t.list(t.id(), 50).optional().describe("An Image property's pictures: picture paragraphs' ids."),
      },
    },
    createView: {
      runs: "window",
      effect: "write",
      description: "Add a saved view to a database — table, board, list, gallery or calendar (a board or calendar adds the Status or Date property it needs when there is none) — or copy_of a view, filters and all. Answers its id.",
      input: {
        page_id: databaseId,
        kind: t.choice(...VIEW_KINDS).optional().describe("Its layout."),
        name: t.string(200).optional().describe("Its name."),
        copy_of: t.id().optional().describe("A view to copy."),
      },
    },
    updateView: {
      runs: "window",
      effect: "write",
      description: "Change a database view: name; layout (kind); filter (a Select or Status property and a value; empty clears); sorts (property ids, name for the row name, first key first, each once) or sort_property_id with sort_direction; group_by (Status or Select); date_by (a Date, for a calendar); minimal (a table drawn as Markdown); a gallery's card_preview (none, cover, content or an Image property) and card_properties. An empty id clears a setting.",
      input: {
        page_id: databaseId,
        view_id: t.id().describe("The view."),
        name: t.string(200).optional().describe("Its name."),
        kind: t.choice(...VIEW_KINDS).optional().describe("Its layout."),
        filter_property_id: t.string(128).optional().describe("One property it filters by, kept — a Select or Status and an option; empty clears the whole filter."),
        filter_value: t.string(200).optional().describe("The value kept."),
        filters: t.list(viewFilter, 100).optional().describe("The full filter: conditions, or one group of them, AND-ed together; an empty list clears it. Written, it replaces filter_property_id's."),
        sort_property_id: t.string(128).optional().describe("One property to sort by; empty for none."),
        sort_direction: t.choice("asc", "desc").default("asc").describe("sort_property_id's direction."),
        sorts: t.list(t.object({ property_id: t.id(), direction: t.choice("asc", "desc").default("asc") }), 20).optional().describe("The sort keys, first key first."),
        group_by: t.string(128).optional().describe("Table or list: the property whose values head the row groups (Status, Select, Multi-select, Person, Checkbox, Date); a board's column property stays Status or Select. Empty for none."),
        date_by: t.string(128).optional().describe("A Date property; empty for none."),
        minimal: t.bool().optional().describe("A table drawn as Markdown."),
        card_preview: t.string(128).optional().describe("none, cover, content or an Image property."),
        card_properties: t.list(t.id(), 50).optional().describe("The properties its cards show."),
        hidden: t.list(t.id(), 100).optional().describe("The properties a table, list or gallery does not draw; an empty list shows them all."),
        calcs: t.record(t.string()).optional().describe("A table's footer calculations, by column (a property id, or name): count, count_unique, count_empty, count_not_empty; number also sum, avg, min, max; checkbox checked, unchecked, percent_checked; date earliest, latest. An empty map clears them."),
      },
    },
    deleteView: {
      runs: "window",
      effect: "write",
      description: "Delete a saved view of a database; its last view stays.",
      input: { page_id: databaseId, view_id: t.id().describe("The view.") },
    },
    checkpointPage: {
      runs: "window",
      effect: "write",
      description: "Keep a checkpoint of a page in its history before a larger change, so restore_version can bring it back. Checkpoints close in time coalesce, and an unchanged page adds none. Answers the newest checkpoint's id.",
      input: { page_id: pageId, summary: t.string(200).optional().describe("What it is before.") },
    },
    restoreVersion: {
      runs: "window",
      effect: "write",
      description: "Bring a page back to a checkpoint from its history, as Restore in page history does: what it said then comes back, while where it lives and the space it is shared into stay as they are; what it held until now stays in its history.",
      input: { page_id: pageId, version_id: t.id().describe("The checkpoint, from list_versions.") },
    },
    setPreferences: {
      runs: "window",
      effect: "write",
      description: "Change the person's own HeiNote settings, which nobody else sees: theme, the page list's view and sort, whether the page list is folded, and the view a database opens on (database_id with view_id).",
      input: {
        theme: t.choice(...THEMES).optional().describe("Its colours."),
        sidebar_view: t.choice(...SIDEBAR_VIEWS).optional().describe("What the page list shows."),
        sidebar_sort: t.choice(...SIDEBAR_SORTS).optional().describe("The page list's order."),
        sidebar_collapsed: t.bool().optional().describe("The page list folded away."),
        database_id: t.id().optional().describe("A database."),
        view_id: t.id().optional().describe("Its view to open on."),
      },
    },
  },
});
