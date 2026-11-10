import { Table2 } from "lucide-react";
import { useCallback, useLayoutEffect, useRef } from "react";
import { useWorkspace } from "../../app/workspace-context";
import { DatabaseViews } from "./DatabaseViews";
import { consumeFresh } from "./fresh";
import { usePage } from "../../app/workspace-store";

/** A database drawn inside a document, where the `/table`, `/board`, `/list`,
 *  `/gallery` or `/calendar` command was typed. It is a real database page —
 *  it has its own place in the page tree and opens full-page from its toolbar —
 *  and this block is only where the document shows it.
 *
 *  Nothing in here is part of the document's text: the whole widget is
 *  `contentEditable={false}`, so the editor never tries to put a caret in a
 *  table cell or read a board card back as prose. */
export function InlineDatabase({
  databaseId,
  readOnly,
  historical,
}: {
  databaseId: string;
  /** Nothing in it is changed from here: a reader who may only view, a page
   *  shown "Read only here", an old version. They still look around in it —
   *  switch views, search, open a row — as on the database's own page. */
  readOnly: boolean;
  /** Drawn in an old version of the page, from its history: a picture of the
   *  past, not to be used — the database it shows is the live one. */
  historical: boolean;
}) {
  const { updatePage } = useWorkspace();
  const inlineRef = useRef<HTMLDivElement | null>(null);
  const database = usePage(databaseId);

  // A database made a moment ago asks to be named, the way a new page asks for
  // its title. Only then: opening a page that holds an untitled database later
  // must not pull the caret out of whatever you were writing. The name is
  // drawn with the views, which load on first use, so it is focused as it
  // appears rather than when this block does.
  const nameRef = useCallback((element: HTMLInputElement | null) => {
    if (element && consumeFresh(databaseId)) element.focus();
  }, [databaseId]);

  // The page's right margin beside it, where its table may scroll on. Nesting
  // only moves a block in from the left, so it is the page's edge less ours.
  const shown = Boolean(database?.database) && !database?.archived;
  useLayoutEffect(() => {
    const inline = inlineRef.current;
    const page = inline?.closest<HTMLElement>(".doc");
    if (!inline || !page) return;
    const measure = () => {
      const margin = page.getBoundingClientRect().right - inline.getBoundingClientRect().right;
      inline.style.setProperty("--bleed-end", `${Math.max(0, margin)}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(page);
    observer.observe(inline);
    return () => observer.disconnect();
  }, [shown]);

  if (!shown || !database) {
    return (
      <div className="dbv-missing" contentEditable={false}>
        <Table2 size={15} />
        {database?.archived ? "This database is in the trash" : "This database no longer exists"}
      </div>
    );
  }

  return (
    // In an older version of the document the database it points at is live,
    // so it is shown but not used from the old copy: inert. Anywhere else
    // someone who may not change it can still read it as they would on its
    // own page; `readOnly` refuses every change.
    <div ref={inlineRef} className="dbv-inline" contentEditable={false} inert={historical || undefined} data-page-id={databaseId}>
      <DatabaseViews
        databaseId={databaseId}
        variant="inline"
        readOnly={readOnly}
        // Its icon before its name, in the page's text column, as Notion's
        // inline database stands — no column of its own for a mark.
        title={(
          <>
            <span className="dbv-inline__icon" aria-hidden="true">{database.icon || <Table2 size={16} />}</span>
            <input
              ref={nameRef}
              className="dbv-inline__title t-control-size-keep"
              data-history-field="title"
              value={database.title}
              placeholder="Untitled database"
              aria-label="Database title"
              readOnly={readOnly}
              onChange={(event) => { if (!readOnly) updatePage(databaseId, { title: event.target.value }); }}
            />
          </>
        )}
      />
    </div>
  );
}
