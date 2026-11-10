import {
  Clock3,
  Copy,
  CornerDownRight,
  CornerUpLeft,
  Link,
  MoreHorizontal,
  MoveHorizontal,
  Redo2,
  Star,
  Trash2,
  Undo2,
  UserPlus,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MenuDivider, MenuItem, MenuList } from "../../components/Menu";
import { Popover } from "../../components/Popover";
import { Tooltip } from "../../components/Tooltip";
import { rectOf, type AnchorRect } from "../../hooks/useAnchoredPosition";
import { imeComposing } from "../../core/keyboard";
import type { NotePage } from "../../core/types";
import { lineLink, pageName } from "../../core/block-tree";
import { useWorkspace } from "../../app/workspace-context";
import { useUi } from "../../app/ui-context";
import { LAND_EVENT, requestLanding } from "../editor/landing";
import { MoveToMenu } from "../editor/MoveToMenu";
import { PAGE_FONTS, pageFont } from "../editor/page-decoration";
import { useCopyPageLink } from "../../hooks/useCopyPageLink";
import { sameItems, usePage, useWorkspaceState } from "../../app/workspace-store";

/* What a page's bar offers for the page it names: Share, the star, and the
   ··· menu — the same wherever the page is shown, full-page or in the side
   peek. The star stays out of the menu because it is a STATE as much as a
   verb: a filled star tells you something before you press it.

   A block is a page and has the same bar; its menu also leads back to its
   place in the page it is shown in. */
export function PageActions({
  page,
  compact,
  link = false,
  onHistory,
  widthOption = false,
  moveShortcut = false,
}: {
  page: NotePage;
  /** Too narrow for the word: Share is an icon. */
  compact: boolean;
  /** Copy link as a button of its own, as Notion's side peek has it. */
  link?: boolean;
  /** The page's history, where this bar's page can show it. */
  onHistory?: () => void;
  /** Full width, for a page in the page pane; a peek has its own width. */
  widthOption?: boolean;
  /** Answers ⌘⇧P — only the page pane's bar does. */
  moveShortcut?: boolean;
}) {
  const {
    selectedPageId,
    selectPage,
    archivePage,
    duplicatePage,
    movePage,
    updatePage,
    undo,
    redo,
    canUndo,
    canRedo,
    isFavorite,
    toggleFavorite,
    canEdit,
    canMovePage,
    canTrashPage,
  } = useWorkspace();
  const { toast, sharePageId, requestShare, closeShare, closePeek } = useUi();
  const [moreAnchor, setMoreAnchor] = useState<AnchorRect | null>(null);
  const [moveAnchor, setMoveAnchor] = useState<AnchorRect | null>(null);
  // Where the page may go, read only while the picker is open.
  const moveTargets = useWorkspaceState(
    (state) => (moveAnchor ? Object.values(state.pages).filter((candidate) => canMovePage(page.id, candidate.id)) : null),
    (left, right) => (left && right ? sameItems(left, right) : left === right),
  );
  const moreRef = useRef<HTMLButtonElement | null>(null);

  const editable = canEdit(page.id);
  const trashable = canTrashPage(page.id);
  // Where to, the picker asks the one move rule.
  const movable = canMovePage(page.id, undefined);
  const font = pageFont(page);
  const favorite = isFavorite(page.id);
  /* The page it is drawn in, in place, when it is a block there. */
  const holder = usePage(page.parent_id);
  const shownIn = holder?.kind === "document"
    && Object.values(holder.block_tree.by_id).some((row) => lineLink(row)?.page_id === page.id && lineLink(row)?.expanded)
    ? holder
    : undefined;
  const sharing = sharePageId === page.id;

  /* ⌘⇧P, Notion's "Move to". With the caret in a block, or blocks selected,
     the editor moves THOSE (and cancels the key); anywhere else it moves the
     page. The selection check is made here too because the editor's selection
     listener may run after this one. While a page is open in the side peek
     the key is left to it: which page it would move is not obvious. */
  const moveState = useRef({ movable, page });
  useLayoutEffect(() => {
    moveState.current = { movable, page };
  });
  useEffect(() => {
    if (!moveShortcut) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey || imeComposing(event)) return;
      if (event.key.toLowerCase() !== "p" || event.defaultPrevented) return;
      if (globalThis.document.querySelector(".block.is-selected, .side-peek")) return;
      const { movable: canMove, page: current } = moveState.current;
      if (!moreRef.current) return;
      event.preventDefault();
      if (!canMove) {
        toast(current.share_space_id ? "A shared page stays where it is shared" : "You can view this page, but not move it", "info");
        return;
      }
      setMoreAnchor(null);
      setMoveAnchor(rectOf(moreRef.current));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [moveShortcut, toast]);

  const copyPageLink = useCopyPageLink();
  const copyLink = () => copyPageLink(page.id);
  /** Back to the page a block is shown in, landed on it there — by that
   *  page's editor in the page pane: the one open already, or the one that
   *  opens. From the side peek, the peek goes. */
  const openInPage = () => {
    if (!shownIn) return;
    closePeek();
    requestLanding(shownIn.id, page.id);
    if (selectedPageId === shownIn.id) window.dispatchEvent(new Event(LAND_EVENT));
    else selectPage(shownIn.id);
  };
  const toggleShare = () => (sharing ? closeShare() : requestShare(page.id));

  return (
    <>
      {compact ? (
        <Tooltip label="Share">
          <button
            type="button"
            className={`icon-btn ${sharing ? "is-on" : ""}`}
            aria-label="Share"
            aria-pressed={sharing}
            onClick={toggleShare}
          >
            <UserPlus size={16} />
          </button>
        </Tooltip>
      ) : (
        <button
          type="button"
          className={`btn topbar__share ${sharing ? "is-on" : ""}`}
          aria-pressed={sharing}
          onClick={toggleShare}
        >
          Share
        </button>
      )}
      {link ? (
        <Tooltip label="Copy link">
          <button type="button" className="icon-btn" aria-label="Copy link" onClick={copyLink}>
            <Link size={16} />
          </button>
        </Tooltip>
      ) : null}
      <Tooltip label={favorite ? "Remove from favorites" : "Add to favorites"}>
        <button
          type="button"
          className={`icon-btn topbar__star ${favorite ? "is-on" : ""}`}
          aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
          aria-pressed={favorite}
          onClick={() => toggleFavorite(page.id)}
        >
          <Star size={16} fill={favorite ? "currentColor" : "none"} />
        </button>
      </Tooltip>
      <button
        ref={moreRef}
        type="button"
        className={`icon-btn ${moreAnchor ? "is-active" : ""}`}
        aria-label="More page actions"
        aria-haspopup="menu"
        aria-expanded={Boolean(moreAnchor)}
        onClick={(event) => setMoreAnchor(moreAnchor ? null : rectOf(event.currentTarget))}
      >
        <MoreHorizontal size={17} />
      </button>

      <Popover
        open={Boolean(moreAnchor)}
        anchor={moreAnchor}
        placement="bottom-end"
        label="Page actions"
        onDismiss={() => setMoreAnchor(null)}
      >
        <MenuList label="Page actions" className="menu--page" autoFocus>
          {/* Notion opens this menu on the page's font. A pick leaves the
              menu open, so the page can be seen changing behind it. */}
          {editable && page.kind === "document" ? (
            <div className="font-row" role="group" aria-label="Page font">
              {PAGE_FONTS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  data-menu-item
                  role="menuitemradio"
                  aria-checked={font === option.id}
                  className={`font-row__option font-row__option--${option.id} ${font === option.id ? "is-selected" : ""}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => { if (font !== option.id) updatePage(page.id, { font: option.id }); }}
                >
                  <span className="font-row__sample" aria-hidden="true">Ag</span>
                  <span className="font-row__label">{option.label}</span>
                </button>
              ))}
            </div>
          ) : null}
          <MenuItem icon={<Link size={16} />} label="Copy link" onSelect={() => { setMoreAnchor(null); copyLink(); }} />
          {shownIn ? (
            <MenuItem
              icon={<CornerUpLeft size={16} />}
              label={`Open in ${pageName(shownIn)}`}
              onSelect={() => { setMoreAnchor(null); openInPage(); }}
            />
          ) : null}
          {editable ? (
            <MenuItem icon={<Copy size={16} />} label="Duplicate" onSelect={() => { setMoreAnchor(null); duplicatePage(page.id); }} />
          ) : null}
          {movable ? (
            <MenuItem
              icon={<CornerDownRight size={16} />}
              label="Move to"
              hint={moveShortcut ? "⌘⇧P" : undefined}
              onSelect={() => { setMoveAnchor(moreAnchor); setMoreAnchor(null); }}
            />
          ) : null}
          {(widthOption && editable) || onHistory ? <MenuDivider /> : null}
          {widthOption && editable ? (
            <MenuItem
              icon={<MoveHorizontal size={16} />}
              label="Full width"
              selected={Boolean(page.full_width)}
              onSelect={() => { updatePage(page.id, { full_width: !page.full_width }); setMoreAnchor(null); }}
            />
          ) : null}
          {onHistory ? (
            <MenuItem icon={<Clock3 size={16} />} label="Page history" onSelect={() => { setMoreAnchor(null); onHistory(); }} />
          ) : null}
          <MenuDivider />
          {/* Where Notion keeps Undo too: in the page's own menu, with the
              shortcut that does the same thing from anywhere. */}
          <MenuItem icon={<Undo2 size={16} />} label="Undo" hint="⌘Z" disabled={!canUndo()} onSelect={() => { setMoreAnchor(null); undo(); }} />
          <MenuItem icon={<Redo2 size={16} />} label="Redo" hint="⌘⇧Z" disabled={!canRedo()} onSelect={() => { setMoreAnchor(null); redo(); }} />
          {trashable ? (
            <>
              <MenuDivider />
              <MenuItem
                icon={<Trash2 size={16} />}
                label="Move to trash"
                tone="danger"
                onSelect={() => { setMoreAnchor(null); archivePage(page.id); toast("Moved to trash", "success"); }}
              />
            </>
          ) : null}
        </MenuList>
      </Popover>

      {/* The page's own "Move to": the list's move rule decides every place it
          offers, and the top of Files leads when the page may go there. */}
      {moveAnchor ? (
        <MoveToMenu
          anchor={moveAnchor}
          pages={moveTargets ?? []}
          count={1}
          placeholder="Move page to…"
          onMove={(targetId) => { setMoveAnchor(null); movePage(page.id, targetId); }}
          onMoveToTop={canMovePage(page.id, null)
            ? () => { setMoveAnchor(null); movePage(page.id, null); }
            : undefined}
          onClose={() => setMoveAnchor(null)}
        />
      ) : null}
    </>
  );
}
