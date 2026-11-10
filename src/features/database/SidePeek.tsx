import { ChevronsRight, Maximize2 } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Tooltip } from "../../components/Tooltip";
import { useMountTransition } from "../../hooks/useMountTransition";
import { pageName } from "../../core/block-tree";
import type { NotePage } from "../../core/types";
import { imeComposing } from "../../core/keyboard";
import { useWorkspace, type PagePatch } from "../../app/workspace-context";
import { useUi } from "../../app/ui-context";
import { DocumentEditor } from "../editor/DocumentEditor";
import { PageActions } from "../topbar/PageActions";
import { DatabaseSheet } from "./DatabasePage";
import { PropertyEditor, PropertyIcon } from "./properties";
import { propertyName, rowValues } from "./database-model";
import { usePage, useWorkspaceState } from "../../app/workspace-store";
import { spaceOfPage } from "../../core/page-tree";
import { useHomedImages } from "./ImageProperty";

const PEEK_EXIT_MS = 180;
/** The narrowest a docked peek gets, and the narrowest the page beside it. */
export const PEEK_MIN = 360;
export const PANE_MIN = 360;
/** Lying over the page, the peek leaves this much of it to press to go back. */
const PEEK_STRIP = 44;
/** Narrower than this, Share is an icon. */
const COMPACT_BELOW = 420;
/** How wide the docked peek was dragged is the reader's, on this device. */
const WIDTH_KEY = "notes.peek.width";

function readWidth(): number | null {
  try {
    const stored = Number(window.localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  } catch {
    return null;
  }
}

function writeWidth(width: number): void {
  try {
    window.localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
  } catch {
    // Not remembered: the next peek opens at half the pane.
  }
}

export function clampPeekWidth(width: number, pane: number): number {
  return Math.round(Math.min(Math.max(width, PEEK_MIN), Math.max(PEEK_MIN, pane - PANE_MIN)));
}

/** Where the side peek goes in this window: docked beside the page when the
 *  page pane holds both at a readable width, over the page when it does not.
 *  `shell` is the app shell once it is drawn (it is not while the workspace
 *  loads); `paneLeft` is where the page pane starts — the list's track. */
export function usePeekLayout(shell: HTMLElement | null, paneLeft: number) {
  const [shellWidth, setShellWidth] = useState(0);
  const [stored, setStored] = useState<number | null>(readWidth);
  useLayoutEffect(() => {
    if (!shell) return;
    const measure = () => setShellWidth(Math.round(shell.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [shell]);
  const pane = Math.max(0, shellWidth - paneLeft);
  const docked = pane >= PEEK_MIN + PANE_MIN;
  const width = docked ? clampPeekWidth(stored ?? pane / 2, pane) : Math.max(0, pane - PEEK_STRIP);
  return {
    docked,
    width,
    pane,
    resize: (next: number) => {
      const clamped = clampPeekWidth(next, pane);
      setStored(clamped);
      writeWidth(clamped);
    },
  };
}

/** A database row's properties, set in the page between its title and its
 *  body — Notion's arrangement, so the row reads as one page. */
function PageProperties({ page }: { page: NotePage }) {
  const { updatePage: writePage, canEdit } = useWorkspace();
  const updatePage = (pageId: string, patch: PagePatch) => { if (canEdit(pageId)) writePage(pageId, patch); };
  const database = usePage(page.parent_id)?.database;
  const properties = database?.properties ?? [];
  const space = useWorkspaceState((state) => spaceOfPage(state.pages, page.id));
  useHomedImages([page], properties, space);
  if (!properties.length) return null;
  const values = page.properties ?? {};
  return (
    <div className="page-props" aria-label="Properties">
      {properties.map((property) => (
        <label className="page-props__row" key={property.id} data-type={property.type}>
          <span className="page-props__name"><PropertyIcon property={property} />{propertyName(property)}</span>
          <span className="page-props__value">
            <PropertyEditor
              property={property}
              value={values[property.id] ?? ""}
              row={page}
              readOnly={!canEdit(page.id)}
              onChange={(next) => updatePage(page.id, rowValues(page, { [property.id]: next }))}
            />
          </span>
        </label>
      ))}
    </div>
  );
}

/** Notion's side peek: a page opened on the right, beside the page it came
 *  from, which stays open and live — a database row pressed, or a link
 *  followed (a page's, a database's, or a block's, which opens as a page of
 *  its own). Press another and the peek follows. It is the real editor, not
 *  a preview: the name, the properties and the whole body are edited in
 *  place, and its bar carries the page's own Share, link, star and ··· menu.
 *  » closes it, putting you back where you were; ⤢ opens it full-page.
 *
 *  Too narrow for two pages side by side, it lies over the page instead,
 *  leaving a strip of it to press to go back. */
export function SidePeek({
  docked,
  width,
  pane,
  onResize,
}: {
  docked: boolean;
  width: number;
  pane: number;
  onResize(width: number): void;
}) {
  const { canEdit, selectPage } = useWorkspace();
  const { peekPageId, closePeek } = useUi();
  const page = usePage(peekPageId);
  const open = Boolean(page && !page.archived);
  const { mounted, shown } = useMountTransition(open, PEEK_EXIT_MS);
  const panelRef = useRef<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  // What it shows outlives the close, so the panel still has something to
  // draw while it slides away.
  const shownPageId = page?.id ?? null;
  const [lastPageId, setLastPageId] = useState<string | null>(shownPageId);
  const lastPage = usePage(lastPageId);
  useEffect(() => {
    if (open && shownPageId) setLastPageId(shownPageId);
  }, [open, shownPageId]);

  /* Opening moves the keyboard into the peek, and closing gives it back to
     whatever had it — the row that was pressed. Another row pressed while it
     is open keeps the first place to go back to. */
  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      returnFocus.current?.focus({ preventScroll: true });
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    // Each page opens at its top.
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    const panel = panelRef.current;
    // A page with a name opens with the panel itself focused, so the keyboard
    // is inside the peek; a new page's editor moves the caret to its title.
    const frame = window.requestAnimationFrame(() => {
      if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, peekPageId]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // The Escape that cancels a composition is the input method's.
      if (event.key !== "Escape" || event.defaultPrevented || imeComposing(event)) return;
      // Escape is spent one layer at a time, as in Notion: a menu open inside
      // the page closes first, and Escape while typing selects the block (the
      // editor claims that one). The next Escape closes the peek — the block
      // selection goes with it.
      if (document.querySelector(".pop.is-shown")) return;
      closePeek();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closePeek, open]);

  /* The seam follows the pointer, written straight to the shell's variable,
     and commits the width on release — as the list's seam does. */
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const shell = panelRef.current?.closest<HTMLElement>(".app-shell");
    if (!shell) return;
    const startX = event.clientX;
    let next = width;
    shell.classList.add("is-resizing-peek");
    const onMove = (move: PointerEvent) => {
      next = clampPeekWidth(width + startX - move.clientX, pane);
      shell.style.setProperty("--peek-w", `${Math.round(next)}px`);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      shell.classList.remove("is-resizing-peek");
      onResize(next);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const drawn = open && page ? page : lastPage;
  if (!mounted || !drawn) return null;
  const title = pageName(drawn);

  return (
    <>
      {docked ? null : (
        // The strip of the page left showing is a way back, not a control:
        // the close button and Escape are how the keyboard leaves.
        <div className={`side-peek__strip ${shown ? "is-shown" : ""}`} aria-hidden="true" onClick={closePeek} />
      )}
      <aside
        ref={panelRef}
        className={`side-peek ${docked ? "side-peek--docked" : "side-peek--over"} ${shown ? "is-shown" : ""}`}
        aria-label={title}
        tabIndex={-1}
      >
        {docked ? (
          <div
            className="side-peek__seam"
            role="separator"
            aria-label="Resize the side peek"
            aria-orientation="vertical"
            onPointerDown={startResize}
          />
        ) : null}
        <header className="side-peek__bar">
          <Tooltip label="Close" hint="Esc">
            <button type="button" className="icon-btn" aria-label="Close side peek" onClick={closePeek}>
              <ChevronsRight size={17} />
            </button>
          </Tooltip>
          <Tooltip label="Open as full page">
            <button
              type="button"
              className="icon-btn"
              aria-label="Open as full page"
              onClick={() => {
                selectPage(drawn.id);
                closePeek();
              }}
            >
              <Maximize2 size={15} />
            </button>
          </Tooltip>
          <span className="side-peek__spacer" />
          <PageActions page={drawn} compact={width < COMPACT_BELOW} link />
        </header>
        <div ref={scrollRef} className="side-peek__scroll scroller">
          {/* A database is its views, never a page's words. */}
          {drawn.kind === "database" ? (
            <DatabaseSheet database={drawn} />
          ) : (
            <DocumentEditor key="page" page={drawn} readOnly={!canEdit(drawn.id)} properties={<PageProperties page={drawn} />} />
          )}
        </div>
      </aside>
    </>
  );
}
