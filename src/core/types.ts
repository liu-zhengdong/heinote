import type { CollectionHandle } from "../platform/schema";
import type app from "../../schema";
import type { COLOR_NAMES } from "../../schema";

/* What Notes holds. Each record's shape is declared once, in schema.ts, and
   read here from its collection's handle: a page, a paragraph, a file, a
   database, the member's settings. Where the window holds a field otherwise
   — a paragraph's words as the editor's runs, a page's tree of paragraphs,
   the maps a record schema keeps as JSON objects — it says so, and reads the
   record through its checks (platform/records.ts). */

/** A record as its collection's handle reads and writes it. */
type RecordOf<H> = H extends CollectionHandle<infer R> ? R : never;

export type PageRecord = RecordOf<typeof app.pages>;
export type BlockRecord = RecordOf<typeof app.blocks>;
/** A part of a page's checkpoint (platform/history-record.ts). */
export type HistoryPart = RecordOf<typeof app.versions>;
/** The member's `preferences` and `roots`. */
export type SettingsRecord = RecordOf<typeof app.workspace_settings>;

/** What a node of a page's tree is. Every kind is a PARAGRAPH — a line of
 *  text, a heading, a list item, a code block, a file: the smallest piece of
 *  a page. A line holding nothing but a link to a page stands for it, as its
 *  row (block-tree `lineLink`). A BLOCK, paragraphs grouped by hand into one
 *  thought, is a page of its own: its line shows it in place. `page` is the node the editor draws one
 *  as, holding its paragraphs (see features/editor/composite.ts), and is never
 *  stored: a page's tree holds paragraphs and rows only. */
export type BlockKind = BlockRecord["kind"] | "page";

/** Notion's nine colours. A block or a run of text takes one as its text
 *  colour, or — with `_background` — as a highlight behind it. They are the
 *  person's content, never the app's chrome. */
export type ColorName = typeof COLOR_NAMES[number];
export type ContentColor = NonNullable<BlockRecord["color"]>;

/** A run's marks, as a rich-text field keeps them. */
export type InlineMarks = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: string;
  color?: ContentColor;
};

/** A reference drawn among the words as one token that cannot be broken
 *  into: a page, by its title as it is now, a date, or a picture. */
export type Mention =
  /** A page — and a block, which is a page. Shown (`expanded`), its content
   *  is drawn here, and edited here exactly as where it lives; `locked` keeps
   *  it read only here. Both are saved with the link, so everyone reading the
   *  page sees the same. */
  | { kind: "page"; page_id: string; expanded?: boolean; locked?: boolean }
  | { kind: "date"; date: string }
  /** A picture in the words, as Google Docs has one "in line": it stands on
   *  the line like a large letter, `width` CSS pixels wide (its own width,
   *  within the column, when unset). */
  | { kind: "image"; file: StoredFile; width?: number };

export interface InlineRun {
  text: string;
  marks?: InlineMarks;
  /** A mention's run is always exactly one character, MENTION_CHAR, so a
   *  caret offset counts it once — the token is drawn around it. */
  mention?: Mention;
}

/** Words as the window holds them: a record's runs, each mention the run of
 *  MENTION_CHAR that carries it (core/stored-runs.ts). */
export type InlineContent = InlineRun[];

/** Bytes a block shows — a picture or a file someone uploaded. They are
 *  stored beside the workspace's pages: in the member's own storage for a
 *  private page, in the space for a shared one. Written once, never changed:
 *  a new upload is a new path. */
export type StoredFile = NonNullable<BlockRecord["file"]>;

type TableRecord = NonNullable<BlockRecord["table"]>;

/** A simple table's column: the id its cells are kept under in every row
 *  and, once dragged, its width in CSS pixels. */
export type TableColumn = TableRecord["columns"][number];

/** A simple table's row: where it stands among the rows, and its cells by
 *  column id. */
export interface TableRow {
  order: number;
  cells: Record<string, InlineContent>;
}

/** Notion's simple table: a grid of cells holding words, in a page like any
 *  paragraph — not a database. Rows are kept by id, so each is written on its
 *  own; columns are one list, in order. Read through `tableGrid`
 *  (core/simple-table.ts): another member's client wrote it. */
export type SimpleTable = Omit<TableRecord, "rows"> & { rows: Record<string, TableRow> };

/** A paragraph of a page's tree: its record without the page it is in, its
 *  words as the window's runs, at the top of the page with no parent, and
 *  its table and card as Notes reads them. */
export type Block = Omit<BlockRecord, "page" | "kind" | "parent_id" | "content" | "table" | "embed"> & {
  kind: BlockKind;
  parent_id: string | null;
  content: InlineContent;
  table?: SimpleTable;
  embed?: Embed;
};

/** A link shown as a card, as Notion embeds one: a YouTube video or a post
 *  on X. The address is the card's truth — every id is read from it again
 *  — and the rest was read from the provider by whoever made the card,
 *  cleaned, and kept here so that nobody reading the page fetches anything.
 *  Read only through `normalizeEmbed` (core/embeds.ts): another member's
 *  client wrote it. `read` says the provider answered, found or not, so it
 *  is not asked again. */
export type Embed = VideoEmbed | PostEmbed;

export interface VideoEmbed {
  provider: "youtube";
  url: string;
  video_id: string;
  /** Where the video starts, in seconds, from the link's `t=`. */
  start?: number;
  /** A Short: drawn upright. */
  vertical?: boolean;
  title?: string;
  author?: string;
  read?: boolean;
}

export interface PostEmbed {
  provider: "x";
  url: string;
  handle: string;
  post_id: string;
  /** The author's display name. */
  name?: string;
  text?: string;
  /** The date as X's oEmbed wrote it, when that is all there is. */
  date?: string;
  /** When it was posted (ISO), from X's data: shown in the reader's zone. */
  posted?: string;
  /** The author's picture, on X's picture host. */
  avatar?: string;
  /** The post's pictures, a video's still or a GIF's — at most four. */
  media?: PostMedia[];
  /** X marks the post's media as possibly sensitive: none of it is shown. */
  sensitive?: boolean;
  read?: boolean;
}

export interface PostMedia {
  kind: "photo" | "video" | "gif";
  /** On X's picture host (pbs.twimg.com) alone. */
  url: string;
  width?: number;
  height?: number;
}

export interface BlockTree {
  by_id: Record<string, Block>;
}

export type BlockMutation =
  | { action: "put"; block: Block }
  | { action: "delete"; blockId: string };

/** A page is a block with a title: a document, or a database whose rows are
 *  pages. Pages hold pages; there is no folder. */
export type PageKind = PageRecord["kind"];

type DatabaseRecord = NonNullable<PageRecord["database"]>;
type ViewRecord = DatabaseRecord["views"][number];

export type DatabaseProperty = DatabaseRecord["properties"][number];
export type PropertyType = DatabaseProperty["type"];

/** One status a row can be in. A row stores the option's NAME, as it stores
 *  every value, so a column turned into Text and back keeps what it said. */
export type StatusOption = NonNullable<DatabaseProperty["status_options"]>[number];

/** The colour of a status option's pill: Notion's nine, and its default grey. */
export type OptionColor = StatusOption["color"];

/** Notion's three kinds of status: not begun, under way, finished. */
export type StatusGroup = StatusOption["group"];

export type DatabaseViewKind = ViewRecord["kind"];

/** One key of a view's order. */
export type ViewSort = NonNullable<ViewRecord["sorts"]>[number];

/** One way of looking at a database, its widths and wraps as Notes reads
 *  them (`columnWidth`, `columnWraps`). */
export type DatabaseView = Omit<ViewRecord, "widths" | "wrap"> & {
  widths?: Record<string, number>;
  wrap?: Record<string, boolean>;
};

/** A database's properties and views. Its rows are the pages it holds —
 *  every page whose parent it is — in `row_order`: no list of them is kept,
 *  so rows two people add at once are both there. */
export type DatabaseConfig = Omit<DatabaseRecord, "views"> & { views: DatabaseView[] };

/** Notion's three page fonts: the member's UI face, a serif, a mono. */
export type PageFont = NonNullable<PageRecord["font"]>;

/** A page as the window holds it: its record, with its name's plain words
 *  (`title`) beside their runs, which it holds only while a link is among
 *  them (core/title.ts); at the top level with no parent; its paragraphs as
 *  a tree; and its maps as Notes reads them. */
export type NotePage = Omit<PageRecord, "title_content" | "parent_id" | "properties" | "property_files" | "database"> & {
  title: string;
  title_content?: InlineContent;
  parent_id: string | null;
  block_tree: BlockTree;
  properties?: Record<string, string>;
  property_files?: Record<string, StoredFile[]>;
  database?: DatabaseConfig;
};

/** A checkpoint of a page: the page as it was, kept in its history's parts
 *  (platform/history-record.ts). */
export interface PageVersion {
  id: string;
  page_id: string;
  author_id: string;
  author_name: string;
  summary: string;
  created_at: string;
  snapshot: NotePage;
  /** A checkpoint a restore wrote: never coalesced, nor coalesced into. */
  restored?: boolean;
}

export type ThemePreference = NonNullable<SettingsRecord["theme"]>;

/** The page list's four views, as Obsidian's side panel switches between
 *  its file explorer, its bookmarks and its graph. */
export type SidebarView = NonNullable<SettingsRecord["sidebar_view"]>;

/** How the file tree orders the pages under each page — Obsidian's six. */
export type SidebarSort = NonNullable<SettingsRecord["sidebar_sort"]>;

/** How the graph draws the workspace — Obsidian's graph settings: what it
 *  shows (filters), what it colours (groups), how it draws (display) and how
 *  it lays out (forces). */
export type GraphSettings = NonNullable<SettingsRecord["graph"]>;

/** A colour group of the graph: the pages its query finds wear its colour. */
export type GraphGroup = GraphSettings["groups"][number];

/** Chrome preferences that belong to the person, not to the document: every
 *  one of their settings but `roots`, each there (readPreferences). They
 *  ride in personal managed records so a member's workspace looks the same
 *  on every device they sign in from. */
export type WorkspacePreferences = Required<Omit<SettingsRecord, "roots" | "database_views">> & {
  /** The view each database was last open on, by database id. Personal, like
   *  Notion's: switching a shared database to Board does not switch it for
   *  anyone else. */
  database_views: Record<string, string>;
};

export interface WorkspaceState {
  pages: Record<string, NotePage>;
  roots: string[];
  /** Each page's history: its versions, by id — each written, and kept or
   *  let go, on its own. */
  versions: Record<string, Record<string, PageVersion>>;
  preferences: WorkspacePreferences;
}

/** One write to the workspace: a value set at a path, or the path cleared.
 *  It changes the records the path lands in (platform/records.ts), field by
 *  field. `base`: for a write of a paragraph's words or a page's name, the
 *  runs the change started from, when they are not what the window shows —
 *  an undo over someone else's edit — so Terminus merges the two. */
export interface WorkspaceMutation {
  type: "set" | "delete";
  path: string[];
  value?: unknown;
  base?: InlineContent;
}

/** A person's handle, display name and photo. Uploads use immutable same-origin
 *  URLs; a bound GitHub identity supplies the fallback. No photo is null. */
export interface Person {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
}

/** Full access is `admin`, Can edit `editor`, Can view `viewer`; `owner` is
 *  whoever shared the page. */
export type SpaceRole = "owner" | "admin" | "editor" | "viewer";

/** Shared metadata for a knowledge base. Content stays in its space. */
export interface KnowledgeBase {
  homePageId: string;
  description: string;
  archived: boolean;
  sort: SidebarSort;
  revision: number;
  createdAt: string;
  /** Quota figures for owners and admins; absent for other members. */
  storage?: { used: number; limit: number; over: number };
}

/** A space this member belongs to, as Notes needs it: its name, their role
 *  there, and what that role allows. */
export interface SpaceSummary {
  spaceId: string;
  name: string;
  role: SpaceRole;
  canInvite: boolean;
  canManageRoles: boolean;
  canRemoveMembers: boolean;
  canLeave: boolean;
  /** Absent for ordinary page sharing. */
  knowledgeBase?: KnowledgeBase;
}

export interface SpaceMember extends Person {
  role: SpaceRole;
}

/** Someone asked into a space who has not accepted yet: not a member. */
export interface SpaceInvitation {
  id: string;
  invitee: Person;
  role: Exclude<SpaceRole, "owner">;
  status: "pending" | "accepted" | "declined" | "revoked" | "expired";
  expiresAt: string;
}

/** Who is in a space, and who has been asked in. */
export interface SpaceRoster {
  members: SpaceMember[];
  invitations: SpaceInvitation[];
}

/** A place in a block's text: the block, and the offset in UTF-16 units
 *  the editor counts (a mention is one). */
export interface TextPoint {
  blockId: string;
  offset: number;
}

export interface PresenceState {
  pageId?: string;
  blockId?: string;
  status?: "viewing" | "editing";
  color?: string;
  /** Where their caret is (`focus`) and where what they select starts
   *  (`anchor`, the same place for a caret), while it is in a block's text. */
  selection?: { anchor: TextPoint; focus: TextPoint };
}

export interface CollaboratorPresence {
  userId: string;
  online: boolean;
  state?: PresenceState;
}

export interface AppBootstrap {
  appId: string;
  installationId?: string | null;
  appName: string;
  user: Person;
}
