import { useCallback, useEffect, useId, useMemo, useRef } from "react";
import { clearEditSurface, registerEditSurface, updateEditSurface } from "../../app/edit-surface";
import { useUi } from "../../app/ui-context";
import { useWorkspace } from "../../app/workspace-context";
import { titleField } from "../../collaboration/protocol";
import { pageTitleContent, titleFields } from "../../core/title";
import type { NotePage } from "../../core/types";
import { useFold } from "../../hooks/useFold";
import { linkedPageId } from "../editor/mentions";
import { RemoteCarets } from "../editor/RemoteCarets";
import { TitleField } from "../editor/TitleField";
import { IconImage } from "../editor/PageIcon";
import { pageIcon } from "../editor/page-decoration";
import { consumeFresh } from "./fresh";
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
export function DatabaseSheet({ database, readOnly: heldReadOnly = false, surfaceContainer = "main" }: {
  database: NotePage;
  /** Nothing changed from here, whoever is reading: a database in the trash. */
  readOnly?: boolean;
  surfaceContainer?: "main" | "peek";
}) {
  const { updatePage, canEdit, document: workspaceDoc, selectPage, undo, redo, canUndo, canRedo } = useWorkspace();
  const { openPeek } = useUi();
  const mobile = useFold();
  const surfaceId = useId();
  const titleRef = useRef<HTMLElement | null>(null);
  const surfaceRef = useRef<HTMLElement | null>(null);
  const titleFocused = useRef(false);

  const databaseId = database.id;
  const readOnly = heldReadOnly || !canEdit(database.id);
  const untitled = !database.title;
  useEffect(() => {
    if (!untitled || readOnly) return;
    if (mobile && !consumeFresh(databaseId)) return;
    titleRef.current?.focus();
  }, [databaseId, mobile, readOnly, untitled]);

  const endTitleEdit = useCallback(() => {
    titleFocused.current = false;
    titleRef.current?.blur();
    window.getSelection()?.removeAllRanges();
    clearEditSurface(surfaceId);
  }, [surfaceId]);

  useEffect(() => () => clearEditSurface(surfaceId), [surfaceId]);

  useEffect(() => {
    if (!mobile || readOnly) {
      titleFocused.current = false;
      clearEditSurface(surfaceId);
      return;
    }
    if (!titleFocused.current) return;
    updateEditSurface(surfaceId, {
      pageId: databaseId,
      container: surfaceContainer,
      canUndo: canUndo(),
      canRedo: canRedo(),
      undo,
      redo,
    });
  }, [canRedo, canUndo, database.title, database.title_content, databaseId, mobile, readOnly, redo, surfaceContainer, surfaceId, undo]);
  const titleContent = useMemo(() => pageTitleContent({ title: database.title, title_content: database.title_content }), [database.title, database.title_content]);

  if (!database.database) return null;

  return (
    <article ref={surfaceRef} className="db db--page" data-page-id={database.id}>
      <div className="db__head">
        {(() => {
          const icon = pageIcon(database);
          if (!icon) return null;
          return (
            <button
              type="button"
              className="doc__icon"
              aria-label="Remove database icon"
              disabled={readOnly}
              onClick={() => updatePage(database.id, { icon: "" })}
            >
              {icon.kind === "image" ? <IconImage file={icon.file} size={72} className="doc__icon-img" /> : icon.emoji}
            </button>
          );
        })()}
        <TitleField
          elementRef={(element) => { titleRef.current = element; }}
          className="doc__title"
          historyField="title"
          blockId={database.id}
          collaboration={readOnly ? undefined : { pageId: database.id, key: titleField(database.id) }}
          content={titleContent}
          placeholder="New database"
          label="Database title"
          readOnly={readOnly}
          onChange={(next) => updatePage(database.id, titleFields(next))}
          onFocus={() => {
            if (!mobile || readOnly) return;
            titleFocused.current = true;
            registerEditSurface({
              surfaceId,
              mode: "title",
              container: surfaceContainer,
              pageId: database.id,
              canUndo: canUndo(),
              canRedo: canRedo(),
              undo,
              redo,
              done: endTitleEdit,
            });
          }}
          onBlur={() => {
            requestAnimationFrame(() => {
              const active = window.document.activeElement;
              if (active && titleRef.current?.contains(active)) return;
              if (active instanceof Element && active.closest(".topbar--mobile, .side-peek__head--mobile")) return;
              titleFocused.current = false;
              clearEditSurface(surfaceId);
            });
          }}
          onOpenPage={(href, full) => {
            const target = workspaceDoc ? linkedPageId(href, workspaceDoc.state.pages) : null;
            if (!target) return;
            if (full) selectPage(target);
            else openPeek(target);
          }}
        />
      </div>
      <DatabaseViews databaseId={database.id} variant="page" readOnly={heldReadOnly} />
      {heldReadOnly ? null : <RemoteCarets root={surfaceRef} />}
    </article>
  );
}
