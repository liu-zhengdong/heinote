import { useEffect, useMemo, useRef } from "react";
import { useUi } from "../../app/ui-context";
import { useWorkspace } from "../../app/workspace-context";
import { pageTitleContent, titleFields } from "../../core/title";
import type { NotePage } from "../../core/types";
import { linkedPageId } from "../editor/mentions";
import { TitleField } from "../editor/TitleField";
import { DatabaseViews } from "./DatabaseViews";
import { usePage } from "../../app/workspace-store";

/** A database opened as a page of its own: its name, large, above the same
 *  database a document shows inline. */
export function DatabasePage({ readOnly }: { readOnly?: boolean }) {
  const { selectedPageId } = useWorkspace();
  const database = usePage(selectedPageId);
  return database ? <DatabaseSheet database={database} readOnly={readOnly} /> : null;
}

/** A database as a page — full-page, or opened beside the page in the side
 *  peek from a link to it. */
export function DatabaseSheet({ database, readOnly: heldReadOnly = false }: {
  database: NotePage;
  /** Nothing changed from here, whoever is reading: a database in the trash. */
  readOnly?: boolean;
}) {
  const { updatePage, canEdit, document, selectPage } = useWorkspace();
  const { openPeek } = useUi();
  const titleRef = useRef<HTMLElement | null>(null);

  const databaseId = database.id;
  const readOnly = heldReadOnly || !canEdit(database.id);
  const untitled = !database.title;
  useEffect(() => {
    if (untitled && !readOnly) titleRef.current?.focus();
  }, [databaseId, readOnly, untitled]);
  const titleContent = useMemo(() => pageTitleContent({ title: database.title, title_content: database.title_content }), [database.title, database.title_content]);

  if (!database.database) return null;

  return (
    <article className="db db--page" data-page-id={database.id}>
      <div className="db__head">
        {database.icon ? (
          <button
            type="button"
            className="doc__icon"
            aria-label="Remove database icon"
            disabled={readOnly}
            onClick={() => updatePage(database.id, { icon: "" })}
          >
            {database.icon}
          </button>
        ) : null}
        <TitleField
          elementRef={(element) => { titleRef.current = element; }}
          className="doc__title"
          historyField="title"
          content={titleContent}
          placeholder="New database"
          label="Database title"
          readOnly={readOnly}
          onChange={(next) => updatePage(database.id, titleFields(next))}
          onOpenPage={(href, full) => {
            const target = document ? linkedPageId(href, document.state.pages) : null;
            if (!target) return;
            if (full) selectPage(target);
            else openPeek(target);
          }}
        />
      </div>
      <DatabaseViews databaseId={database.id} variant="page" readOnly={heldReadOnly} />
    </article>
  );
}
