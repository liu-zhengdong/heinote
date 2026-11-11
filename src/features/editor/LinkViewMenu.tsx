import { ChevronLeft, Table2 } from "lucide-react";
import { useMemo, useState } from "react";
import { MenuItem, MenuList } from "../../components/Menu";
import { Popover } from "../../components/Popover";
import { pageName } from "../../core/block-tree";
import { inTrash } from "../../core/page-tree";
import type { AnchorRect } from "../../hooks/useAnchoredPosition";
import type { NotePage } from "../../core/types";
import { sameItems, useWorkspaceState } from "../../app/workspace-store";
import { viewKindLabel } from "../database/database-model";
import { ViewIcon } from "../database/view-icons";

/* The two steps `/linked` asks for: which database, then which of its
   views. Each list searches what it shows; the second keeps a way back. */
export function LinkViewMenu({
  anchor,
  onPick,
  onClose,
}: {
  /** Where the slash menu stood — the link lands on that line. */
  anchor: AnchorRect | null;
  /** A database and one of its views, chosen together. */
  onPick(databaseId: string, viewId: string): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [databaseId, setDatabaseId] = useState<string | null>(null);

  /* Every database the reader can reach, named — trash excluded; a database
     with no views cannot give the link its second answer, so it does not
     stand in the list. */
  const databases = useWorkspaceState((state) => Object.values(state.pages)
    .filter((page): page is NotePage => Boolean(page) && page.kind === "database" && !page.archived && !inTrash(state.pages, page.id) && Boolean(page.database?.views.length))
    .sort((a, b) => pageName(a).localeCompare(pageName(b))), sameItems);
  const pages = useWorkspaceState((state) => state.pages);
  const database = databaseId ? pages[databaseId] : undefined;
  const views = useMemo(() => database?.database?.views ?? [], [database]);

  const needle = query.trim().toLowerCase();
  const shown = databases.filter((page) => !needle || pageName(page).toLowerCase().includes(needle));

  return (
    <Popover open anchor={anchor} placement="bottom-start" label="Link to a view" onDismiss={onClose}>
      {database ? (
        /* Second step — the chosen database's views; its name is the list's
           title, and the arrow goes back to choosing a database. */
        <MenuList label={`${pageName(database) || "Untitled"} — views`} autoFocus>
          <MenuItem icon={<ChevronLeft size={16} />} label="Back" onSelect={() => setDatabaseId(null)} />
          {views.map((view) => (
            <MenuItem
              key={view.id}
              icon={<ViewIcon kind={view.kind} />}
              label={view.name || viewKindLabel(view.kind)}
              onSelect={() => onPick(database.id, view.id)}
            />
          ))}
        </MenuList>
      ) : (
        <div className="db-multi-menu">
          <input
            autoFocus
            className="db-multi-menu__search"
            placeholder="Search databases…"
            aria-label="Search databases"
            value={query}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="db-multi-menu__list">
            {shown.map((page) => (
              <MenuItem
                key={page.id}
                icon={<Table2 size={16} />}
                label={pageName(page) || "Untitled"}
                onSelect={() => { setDatabaseId(page.id); setQuery(""); }}
              />
            ))}
            {!shown.length ? <div className="db-multi-menu__none">No databases</div> : null}
          </div>
        </div>
      )}
    </Popover>
  );
}
