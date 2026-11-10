import { CalendarDays, Columns3, Database, LayoutGrid, LayoutList } from "lucide-react";
import type { ComponentType } from "react";
import type { BlockKind, DatabaseViewKind } from "../../core/types";
import { BLOCK_DEFINITIONS, DatabaseIcon, PageIcon } from "./block-registry";

/** The menu's two sections: what a line can become, and the pages and
 *  databases it can make. */
type CommandGroup = "Basic" | "Database";

export interface Command {
  id: string;
  label: string;
  /** The Markdown that writes it too, shown beside it: `[]` for a to-do. */
  hint?: string;
  icon: ComponentType<{ size?: number }>;
  group: CommandGroup;
  aliases: string[];
  kind?: BlockKind;
  /** `page` leaves a child page; `database-inline` draws a new database right
   *  here, opening on `view`; `database-page` makes a full-page database and
   *  leaves a link to it, which is what `/database` used to do. */
  action?: "page" | "database-inline" | "database-page";
  view?: DatabaseViewKind;
}

const COMMANDS: Command[] = [
  ...BLOCK_DEFINITIONS.flatMap((definition) => (definition.slash ? [{
    id: definition.kind,
    label: definition.label,
    icon: definition.icon,
    group: "Basic" as const,
    aliases: definition.slash.aliases,
    kind: definition.kind,
    ...(definition.shortcuts[0] ? { hint: definition.shortcuts[0] } : {}),
  }] : [])),
  {
    id: "sub-page", label: "Page",
    icon: PageIcon, group: "Database", aliases: ["subpage", "child", "doc"], action: "page",
  },
  {
    id: "table-view", label: "Table view",
    icon: DatabaseIcon, group: "Database", aliases: ["table", "database", "inline", "grid", "spreadsheet"],
    action: "database-inline", view: "table",
  },
  {
    id: "board-view", label: "Board view",
    icon: Columns3, group: "Database", aliases: ["board", "kanban", "status", "database"],
    action: "database-inline", view: "board",
  },
  {
    id: "list-view", label: "List view",
    icon: LayoutList, group: "Database", aliases: ["list", "rows"],
    action: "database-inline", view: "list",
  },
  {
    id: "gallery-view", label: "Gallery view",
    icon: LayoutGrid, group: "Database", aliases: ["gallery", "cards", "grid"],
    action: "database-inline", view: "gallery",
  },
  {
    id: "calendar-view", label: "Calendar view",
    icon: CalendarDays, group: "Database", aliases: ["calendar", "month", "date", "schedule"],
    action: "database-inline", view: "calendar",
  },
  {
    id: "database-page", label: "Full-page database",
    icon: Database, group: "Database", aliases: ["database", "full page", "collection"], action: "database-page",
  },
];

/* A database entry that matches as well as a basic block ranks after it:
   "/to" is a to-do before anything else, and "/table" the simple table
   before the database's Table view; "/cal" still leads with the view,
   because no basic block answers to it. (What Markdown writes — headings,
   lists, quotes, code, rules — is not in the menu at all.) */
const DATABASE_PENALTY = 2.5;

/** Ranks a query against a command: a prefix of the label beats a prefix of an
 *  alias, which beats a substring anywhere. Anything else is not a match. */
function score(command: Command, query: string): number {
  if (!query) return 0;
  const label = command.label.toLowerCase();
  if (label.startsWith(query)) return 0;
  if (command.aliases.some((alias) => alias.startsWith(query))) return 1;
  if (label.includes(query)) return 2;
  if (command.aliases.some((alias) => alias.includes(query))) return 3;
  return -1;
}

export function slashCommands(query: string): Command[] {
  const normalized = query.replace(/^\//, "").trim().toLowerCase();
  if (!normalized) return COMMANDS;
  return COMMANDS
    .map((command) => ({ command, rank: score(command, normalized) }))
    .filter((entry) => entry.rank >= 0)
    .map((entry) => (entry.command.group === "Database" ? { ...entry, rank: entry.rank + DATABASE_PENALTY } : entry))
    .toSorted((left, right) => left.rank - right.rank)
    .map((entry) => entry.command);
}

const GROUP_ORDER: CommandGroup[] = ["Basic", "Database"];

export function SlashMenu({
  commands,
  activeIndex,
  onSelect,
}: {
  commands: Command[];
  activeIndex: number;
  onSelect(command: Command): void;
}) {
  if (!commands.length) {
    return <div className="menu slash"><div className="slash__empty">No results</div></div>;
  }
  const grouped = GROUP_ORDER
    .map((group) => ({ group, items: commands.filter((command) => command.group === group) }))
    .filter((entry) => entry.items.length);

  return (
    <div className="menu slash" role="listbox" aria-label="Blocks">
      {grouped.map(({ group, items }) => (
        <div className="menu__section" key={group}>
          <div className="menu__section-title">{group}</div>
          {items.map((command) => {
            const Icon = command.icon;
            const index = commands.indexOf(command);
            return (
              <button
                type="button"
                key={command.id}
                role="option"
                aria-selected={index === activeIndex}
                data-slash-index={index}
                className={`menu__item ${index === activeIndex ? "is-active" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelect(command)}
              >
                <span className="menu__icon"><Icon size={16} /></span>
                <span className="menu__label">{command.label}</span>
                {command.hint ? <kbd className="menu__hint slash__hint">{command.hint}</kbd> : null}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
