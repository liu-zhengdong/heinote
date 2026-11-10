import {
  Group,
  Code2,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Minus,
  Quote,
  SquareCheck,
  Table,
  Table2,
  Text as TextIcon,
  MessageSquareQuote,
  Paperclip,
  SquarePlay,
  type LucideIcon,
} from "lucide-react";
import type { ElementType, ReactNode } from "react";
import type { BlockKind, NotePage } from "../../core/types";

export interface BlockDefinition {
  kind: BlockKind;
  label: string;
  icon: LucideIcon;
  /** Its words can be typed in: drawn as `tag`, `placeholder` inside it
   *  while empty, and Enter at its end starts a `continueAs`. */
  editable: boolean;
  tag?: ElementType;
  continueAs?: BlockKind;
  /** Shown inside an empty block. Notion prints it only for the focused block,
   *  except on a page's single empty paragraph. */
  placeholder?: string;
  shortcuts: string[];
  canHaveChildren: boolean;
  /** Offered by the slash menu, matched on its label and these keywords as
   *  well, so "check" finds the to-do the way Notion's aliases do. What
   *  Markdown already writes — a heading's `#`, a list's `-`, a quote's `>`,
   *  a fence's ```, a rule's `---` — is typed, not picked; the menu keeps
   *  what typing cannot reach. */
  slash?: { aliases: string[] };
}

export const BLOCK_DEFINITIONS: readonly BlockDefinition[] = [
  {
    kind: "text", label: "Text",
    icon: TextIcon, tag: "div", editable: true, continueAs: "text", shortcuts: [], canHaveChildren: true,
    placeholder: "Write something, or press ‘/’ for commands",
  },
  {
    kind: "heading1", label: "Heading 1",
    icon: Heading1, tag: "h1", editable: true, continueAs: "text", shortcuts: ["#"], canHaveChildren: true,
    placeholder: "Heading 1",
  },
  {
    kind: "heading2", label: "Heading 2",
    icon: Heading2, tag: "h2", editable: true, continueAs: "text", shortcuts: ["##"], canHaveChildren: true,
    placeholder: "Heading 2",
  },
  {
    kind: "heading3", label: "Heading 3",
    icon: Heading3, tag: "h3", editable: true, continueAs: "text", shortcuts: ["###"], canHaveChildren: true,
    placeholder: "Heading 3",
  },
  {
    kind: "todo", label: "To-do list",
    icon: SquareCheck, tag: "div", editable: true, continueAs: "todo",
    shortcuts: ["[]", "[ ]", "- [ ]", "[x]", "[X]", "- [x]", "- [X]"], canHaveChildren: true,
    placeholder: "To-do",
    slash: { aliases: ["checkbox", "task", "todo"] },
  },
  {
    kind: "bullet", label: "Bulleted list",
    icon: List, tag: "div", editable: true, continueAs: "bullet", shortcuts: ["-", "*", "+"],
    canHaveChildren: true, placeholder: "List",
  },
  {
    kind: "numbered", label: "Numbered list",
    icon: ListOrdered, tag: "div", editable: true, continueAs: "numbered", shortcuts: ["1.", "1)"],
    canHaveChildren: true, placeholder: "List",
  },
  {
    kind: "quote", label: "Quote",
    icon: Quote, tag: "blockquote", editable: true, continueAs: "text", shortcuts: [">", '"', "|"],
    canHaveChildren: true, placeholder: "Empty quote",
  },
  {
    kind: "callout", label: "Callout",
    icon: MessageSquareQuote, tag: "div", editable: true, continueAs: "text", shortcuts: [], canHaveChildren: true,
    placeholder: "Type something…",
    slash: { aliases: ["note", "info", "aside"] },
  },
  {
    kind: "code", label: "Code",
    icon: Code2, tag: "pre", editable: true, continueAs: "text", shortcuts: ["```"], canHaveChildren: false,
    placeholder: "Code",
  },
  {
    kind: "file", label: "File",
    icon: Paperclip, tag: "div", editable: true, continueAs: "text", shortcuts: [],
    canHaveChildren: false, placeholder: "Write a caption…",
  },
  {
    // A link shown as a card, as Notion embeds one: a YouTube video, a post
    // on X (`EmbedBlock`). Made from the link — its paste menu, or Embed on
    // its hover card — never picked or typed; its address is its truth.
    kind: "embed", label: "Embed",
    icon: SquarePlay, editable: false, shortcuts: [],
    canHaveChildren: false,
  },
  {
    // A block in the product's sense: paragraphs grouped into one thought, a
    // page of its own drawn in place — a `page` node. It is drawn around its
    // paragraphs (see PageFrame), never as a line of its own; "/group" makes
    // the paragraph it is typed in one. Group, as the block menu's Group and
    // Ungroup say it.
    kind: "page", label: "Group",
    icon: Group, editable: false, shortcuts: [], canHaveChildren: true,
    slash: { aliases: ["block", "section", "thought"] },
  },
  {
    // Notion's simple table: a grid of cells in the page, drawn and edited by
    // `SimpleTable` — not a database ("Table view" is one of those).
    kind: "table", label: "Table",
    icon: Table, editable: false, shortcuts: [],
    canHaveChildren: false,
    slash: { aliases: ["simple table", "grid", "cells", "rows", "columns", "spreadsheet"] },
  },
  {
    kind: "divider", label: "Divider",
    icon: Minus, editable: false, shortcuts: ["---", "___", "***"],
    canHaveChildren: false,
  },
] as const;

const DEFINITIONS_BY_KIND = new Map(BLOCK_DEFINITIONS.map((definition) => [definition.kind, definition]));
const SHORTCUTS = new Map(BLOCK_DEFINITIONS.flatMap((definition) => definition.shortcuts.map((shortcut) => [shortcut, definition.kind] as const)));

export function blockDefinition(kind: BlockKind): BlockDefinition {
  return DEFINITIONS_BY_KIND.get(kind) ?? BLOCK_DEFINITIONS[0];
}

export function blockShortcut(value: string): { kind: BlockKind; checked?: boolean } | null {
  const kind = SHORTCUTS.get(value);
  if (!kind) return null;
  if (kind !== "todo") return { kind };
  return { kind, checked: /x/i.test(value) };
}

export { Table2 as DatabaseIcon, FileText as PageIcon };

/** How a page is marked wherever it is named — its row, its link, a menu:
 *  the emoji it was given, or its glyph, a database's being its table. A
 *  block is marked as a page is. */
export function pageGlyph(page: Pick<NotePage, "icon" | "kind"> | undefined, size = 16): ReactNode {
  if (page?.icon) return page.icon;
  return page?.kind === "database" ? <Table2 size={size} /> : <FileText size={size} />;
}
