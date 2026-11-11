import { useState } from "react";
import { Check, FileText, Lock, Plus, X } from "lucide-react";
import { Popover } from "../../components/Popover";
import { rectOf, type AnchorRect } from "../../hooks/useAnchoredPosition";
import { imeComposing } from "../../core/keyboard";
import { inTrash } from "../../core/page-tree";
import { pageName } from "../../core/block-tree";
import type { DatabaseProperty, NotePage } from "../../core/types";
import { useWorkspace } from "../../app/workspace-context";
import { useWorkspaceState } from "../../app/workspace-store";
import { databaseRows, relationIds, toMultiValue } from "./database-model";

/* A relation's cell: the linked pages as chips — each its title, opening on
 *  a click — and the pick one popover away: the target database's rows,
 *  searchable, the picked ones marked, "New page" at the foot. A page that
 *  is gone or out of reach draws as a dashed ghost, "No access", and stays:
 *  it may come back, and a drop would lose it for good. */

/** One chip: the page it names, or the ghost of one that cannot be shown. */
function RelationChip({
  page,
  ghost,
  readOnly,
  onOpen,
  onRemove,
}: {
  page: NotePage | undefined;
  ghost: boolean;
  readOnly: boolean;
  onOpen(): void;
  onRemove(): void;
}) {
  if (ghost) {
    return (
      <span className="db-rel db-rel--ghost" title="This page is gone or out of reach">
        <Lock size={11} aria-hidden="true" />
        <span className="db-rel__name">No access</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="db-rel"
      title={pageName(page!) || "Untitled"}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <FileText size={11} aria-hidden="true" />
      <span className="db-rel__name">{pageName(page!) || "Untitled"}</span>
      {readOnly ? null : (
        <span
          role="button"
          tabIndex={-1}
          className="db-rel__remove"
          aria-label={`Remove ${pageName(page!) || "Untitled"}`}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <X size={10} />
        </span>
      )}
    </button>
  );
}

export function RelationPicker({
  property,
  value,
  readOnly,
  onChange,
}: {
  property: DatabaseProperty;
  value: string;
  readOnly: boolean;
  onChange(next: string): void;
}) {
  const { createPage, selectPage, canEdit } = useWorkspace();
  const pages = useWorkspaceState((state) => state.pages);
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const selected = relationIds(value);
  const target = property.relation_database ? pages[property.relation_database] : undefined;
  const targetRows = target ? databaseRows(pages, target.id) : [];
  const typed = query.trim().toLocaleLowerCase();
  const shown = typed ? targetRows.filter((row) => pageName(row).toLocaleLowerCase().includes(typed)) : targetRows;
  const open = Boolean(anchor);
  const one = property.relation_limit === "1";

  const pick = (id: string) => {
    if (selected.includes(id)) onChange(toMultiValue(selected.filter((held) => held !== id)));
    else onChange(toMultiValue(one ? [id] : [...selected, id]));
  };
  const close = () => {
    setAnchor(null);
    setQuery("");
    setActive(0);
  };

  const chips = selected.length ? (
    <span className="db-rel__list">
      {selected.map((id) => {
        const page = pages[id];
        const ghost = !page || inTrash(pages, id);
        return (
          <RelationChip
            key={id}
            page={page}
            ghost={ghost}
            readOnly={readOnly}
            onOpen={() => selectPage(id)}
            onRemove={() => onChange(toMultiValue(selected.filter((held) => held !== id)))}
          />
        );
      })}
    </span>
  ) : (
    <span className="db__multi-empty">Empty</span>
  );

  if (readOnly || !target) return <span className="db-rel-cell">{chips}</span>;

  const make = () => {
    const id = createPage(target.id, "document", { select: false, title: query.trim() || undefined });
    if (!id) return;
    onChange(toMultiValue(one ? [id] : [...selected, id]));
    close();
  };
  const rows = [
    ...shown.map((row) => ({ kind: "row" as const, id: row.id, row })),
    ...(canEdit(target.id) ? [{ kind: "new" as const, id: "", row: null }] : []),
  ];
  const activate = (index: number) => {
    const row = rows[index];
    if (!row) return;
    if (row.kind === "new") make();
    else pick(row.id);
  };

  return (
    <span className="db-rel-cell">
      <div
        role="button"
        tabIndex={0}
        className="db__multi-cell"
        aria-label={property.name}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setAnchor(open ? null : rectOf(event.currentTarget));
        }}
        onKeyDown={(event) => {
          if (imeComposing(event) || open || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          setAnchor(rectOf(event.currentTarget));
        }}
      >
        {chips}
      </div>
      <input
        type="hidden"
        aria-hidden="true"
        value={value}
        data-history-field={`property:${property.id}`}
        readOnly
      />
      <Popover open={open} anchor={anchor} placement="bottom-start" label="Link a page" role="listbox" onDismiss={close}>
        <div className="db-multi-menu">
          <input
            className="db-multi-menu__search"
            autoFocus
            value={query}
            placeholder={`Search ${pageName(target) || "pages"}…`}
            aria-label="Search pages"
            spellCheck={false}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (imeComposing(event)) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (rows.length) setActive((index) => (index + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
              } else if (event.key === "Enter") {
                event.preventDefault();
                activate(active);
              } else if (event.key === "Escape") {
                event.preventDefault();
                close();
              }
            }}
          />
          <div className="db-multi-menu__list" role="group" aria-label="Pages">
            {shown.length ? shown.map((row, index) => (
              <button
                key={row.id}
                type="button"
                role="option"
                aria-selected={selected.includes(row.id)}
                className={`db-multi-menu__option ${index === active ? "is-active" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => activate(index)}
              >
                <span className="db-rel">
                  <FileText size={11} aria-hidden="true" />
                  <span className="db-rel__name">{pageName(row) || "Untitled"}</span>
                </span>
                {selected.includes(row.id) ? <Check size={14} /> : null}
              </button>
            )) : (
              <div className="db-multi-menu__none">No pages</div>
            )}
          </div>
          {canEdit(target.id) ? (
            <button
              type="button"
              className={`db-multi-menu__new ${active === rows.length - 1 ? "is-active" : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(rows.length - 1)}
              onClick={make}
            >
              <Plus size={13} /> New page{query.trim() ? ` "${query.trim()}"` : ""}
            </button>
          ) : null}
        </div>
      </Popover>
    </span>
  );
}
