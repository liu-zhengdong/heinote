import { AppWindow, ArrowUpRight, ImageIcon, Link2, MoreHorizontal, RefreshCw, Smile, X } from "lucide-react";
import "./editor.css";
import "./picker.css";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type ComponentProps,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import { Popover } from "../../components/Popover";
import { PageOutline } from "../../components/PageOutline";
import { extractOutline } from "../../core/outline";
import { pointRect, rectOf, type AnchorRect } from "../../hooks/useAnchoredPosition";
import { useWorkspace } from "../../app/workspace-context";
import { clearEditSurface, registerEditSurface } from "../../app/edit-surface";
import { useUi } from "../../app/ui-context";
import { useFold } from "../../hooks/useFold";
import { createId } from "../../core/ids";
import { copyText } from "../../core/clipboard";
import { pageTitleContent, titleFields } from "../../core/title";
import { stopTextHistory } from "../../collaboration/client";
import { transformSelection } from "../../collaboration/ot/page";
import { titleField, type PageOp } from "../../collaboration/protocol";
import { storedTable } from "../../platform/records";
import {
  blockOrderBetween,
  createBlock,
  descendantsOf,
  lineLink,
  pageLine,
  withLineLink,
  orderedBlocks,
  pageFirstLine,
  pageName,
} from "../../core/block-tree";
import { normalizeStoredFile } from "../../core/files";
import {
  applyTableWrites,
  normalizeSimpleTable,
  TABLE_BYTE_BUDGET,
  tableBytes,
  tableFromCells,
  newSimpleTable,
  type TableWrite,
} from "../../core/simple-table";
import { markFreshTable } from "./SimpleTable";
import type { WorkspaceMutation } from "../../platform/workspace-document";
import { readGrid } from "./table-clipboard";
import { databaseFromList, databaseFromTable, isList, listRefusal, type ConversionIds } from "../database/convert";
import { viewKindLabel } from "../database/database-model";
import { consumeFresh, markFresh } from "../database/fresh";
import {
  hasCjkItalic,
  inlineFromText,
  inlinePlainText,
  mentionAt,
  MENTION_CHAR,
  mountedLink,
  normalizeInlineContent,
  replaceRange,
  insertToken,
  tokenSpan,
  sliceInlineContent,
  soleImage,
  soleLink,
  splitInlineContent,
  updateMentionAt,
  mentionFromAttributes,
  type ShownLink,
  type ToggleableMark,
} from "../../core/inline-content";
import type { Block, BlockKind, BlockMutation, BlockTree, ContentColor, Embed, InlineContent, InlineMarks, Mention, NotePage, StoredFile } from "../../core/types";
import { imeComposing } from "../../core/keyboard";
import { CardOffer, LinkHoverCard, useLinkHover, type CardOfferState, type HoveredLink } from "./LinkHoverCard";
import { copySingleImageBlocks, readBlocks, textToBlocks, writeBlocks, type CopiedBlocks } from "./block-clipboard";
import { editableHtml } from "./block-html";
import { blockDefinition, DatabaseIcon, PageIcon, pageGlyph } from "./block-registry";
import { copyStoredImage, downloadFile, isImageType, notShown, readFileBlob, refuseFiles, showFile, stageFile, type StagedFile } from "./file-store";
import { CoverImage, settleCover, useHomedCovers } from "./CoverImage";
import { IconImage, PageIconMark, recentsFile, rememberIconFile, settleIcon, useHomedIcons } from "./PageIcon";
import { ImageViewer } from "./ImageViewer";
import { rememberCodeLanguage } from "./code-highlight";
import { BlockMenu } from "./BlockMenu";
import { BlockRow, type BlockActions, type LinkLine } from "./BlockRow";
import {
  appendFragment,
  applyEditorTransaction,
  colorBlocks,
  convertBlock,
  convertBlocks,
  deleteAcrossBlocks,
  deleteBlocks,
  embedLink,
  embedToLink,
  extractFragment,
  insertBlockAfter,
  insertFirstChild,
  insertBlockBefore,
  lineIsOnlyLink,
  moveBlocks,
  pageFromBlocks,
  pageSpan,
  reidentify,
  selectionFragment,
  topLevelBlocks,
  unwrapPage,
  updateBlockContent,
  updateBlockFields,
  withoutEmptyPages,
  type EditorTransaction,
} from "./editor-commands";
import { embedFromUrl, normalizeEmbed } from "../../core/embeds";
import { readEmbedDetails } from "./embed-details";
import { FormatToolbar, type FormatState } from "./FormatToolbar";
import { MARKS } from "./marks";
import { TitleField } from "./TitleField";
import { layout, type Item, type Rendered } from "../../core/block-layout";
import { PageFrame } from "./PageFrame";
import { AppSurface } from "../artifact/AppSurface";
import { KnowledgeBaseHome } from "../knowledge/KnowledgeBaseHome";
import { PageMenu, PageNameEditor } from "./PageMenu";
import { HISTORY_REPLAY_EVENT, SELECT_BLOCK_EVENT } from "./history-cursor";
import { MoveToMenu } from "./MoveToMenu";
import type { TypingResume } from "../../core/inline-markdown";
import { MentionMenu } from "./MentionMenu";
import { LAND_EVENT, requestLanding, takeLanding } from "./landing";
import {
  backlinksTo,
  homeOf,
  linkedPageId,
  mentionDescriber,
  mentionItems,
  outsideLinks,
  referenceIndex,
  repaintMentions,
  type BlockReference,
} from "./mentions";
import { BlockBacklinks } from "./BlockBacklinks";
import { composeTree, duplicateSelection, extractSinglePageOps, routeTransaction, storedFragment } from "./composite";
import { coverId, pageCover, pageFont, pageIcon, randomCoverId, randomEmoji } from "./page-decoration";
import { loadPageFonts } from "../../platform/fonts";
import {
  caretOffset,
  caretOnLastLine,
  caretPointFromViewport,
  caretPointNear,
  rowNear,
  editableWithin,
  focusAtEnd,
  focusRange,
  placeCaretNear,
  rowsWithin,
  selectBetweenPoints,
  selectedBlockRanges,
  selectionOffsets,
  selectionPoints,
  selectRanges,
  type BlockTextRange,
  type DomCaretPoint,
  type PendingTextSelection,
} from "./selection";
import { slashCommands, SlashMenu } from "./SlashMenu";
import { LinkViewMenu } from "./LinkViewMenu";
import { InlineDatabase } from "../database/InlineDatabase";
import { useCopyPageLink } from "../../hooks/useCopyPageLink";
import { usePages, useWorkspaceStore } from "../../app/workspace-store";
import { useMedia, type MediaInsertKind, mediaLanding } from "./useMedia";
import { useInlineEquations } from "./useInlineEquations";
import { EquationPopover } from "./EquationPopover";
import { useFormatToolbar } from "./useFormatToolbar";
import { useMarquee } from "./useMarquee";
import { usePictures } from "./pictures";
import { carry } from "./carry";
import { PictureMenu, PictureTools } from "./PictureTools";
import { hideMarker, landingAt, sameSpot, showMarker, type Spot } from "./drop-spot";
import {
  VIEW_ONLY,
  type DropState,
  type Editor,
  type EmbedOptions,
  type EquationEditState,
  type MentionState,
  type MountHandle,
  type PendingFocus,
  type ShownRef,
  type SlashState,
} from "./editor-state";
import { blockKeys } from "./useBlockKeys";
import { useSelectedBlockKeys } from "./useSelectedBlockKeys";
import { blockTyping } from "./useBlockTyping";
import { inTrash, isPurging, spaceOfPage } from "../../core/page-tree";
import { followHref } from "./RichField";
import { RemoteCarets } from "./RemoteCarets";

/* The icon and cover pickers are loaded the first time one opens. */
const IconPicker = lazy(() => import("./IconPicker").then((module) => ({ default: module.IconPicker })));

/* Long documents mount the first ~2 screens immediately so switching pages
   paints without blocking, then append remaining top-level items in chunks. */
const PROGRESSIVE_INITIAL = 60;
const PROGRESSIVE_BATCH = 60;

/** Where the one link of a line that is nothing but a link sits among its
 *  characters. */
function soleLinkOffset(content: InlineContent): number {
  const at = content.findIndex((run) => run.mention);
  return content.slice(0, Math.max(0, at)).reduce((sum, run) => sum + run.text.length, 0);
}

/** The page menu open, and what it was opened from: a page drawn here as a
 *  block, this page's own frame when it is shown whole in another, a
 *  sub-page's row (or a folded database's), a line that is nothing but a
 *  page's link, or a database shown here. */
type PageMenuOpen =
  | { from: "block"; id: string; anchor: AnchorRect }
  | { from: "frame"; anchor: AnchorRect }
  | { from: "link"; blockId: string; anchor: AnchorRect }
  | { from: "database" | "app"; key: string; pageId: string; anchor: AnchorRect; mount: MountHandle };

/** The picker open: a page's icon (this page's, or a block's — a block is a
 *  page), this page's cover, or a callout's emoji. */
type PickerOpen =
  | { kind: "icon"; pageId: string; anchor: AnchorRect }
  | { kind: "cover"; anchor: AnchorRect }
  | { kind: "callout"; blockId: string; anchor: AnchorRect };

type PageMenuProps = ComponentProps<typeof PageMenu>;

/** What a row does, by name: each forwarded to the editor's handlers as
 *  they were drawn last (all but those with an answer of their own). */
const ROW_ACTIONS: Record<Exclude<keyof BlockActions, "describeMention" | "showFile" | "writeTable">, true> = {
  add: true, dragOver: true, drop: true, toggleCheck: true, openBacklinks: true,
  toggleLink: true, openLinkMenu: true, rowDragStart: true, rowDragEnd: true, openBlockMenu: true,
  openLinkedPage: true, setLanguage: true, copyCode: true, editEquation: true, change: true, keyDown: true, beforeInput: true, paste: true, pickIcon: true,
  pickFile: true, downloadFile: true, resizeCard: true,
  retryUpload: true, leaveTable: true, selectTable: true, readEmbed: true,
};

/** Where blocks let go over `target`'s row land: above it or below it — or
 *  inside it, past its middle and in from its left, when it holds blocks.
 *  A folded block takes what is dropped beside it, never into it, where it
 *  would vanish from sight. */
function dropEdge(target: Block, bounds: DOMRect, x: number, y: number): "above" | "below" | "inside" {
  const past = y > bounds.top + bounds.height / 2;
  const nested = past && blockDefinition(target.kind).canHaveChildren && target.kind !== "page" && x > bounds.left + 48;
  return nested ? "inside" : past ? "below" : "above";
}

/** A function for each of `names` calling `latest`'s of that name: the same
 *  functions however often `latest` is drawn again, so a row is drawn again
 *  only when it changes. */
function forwarded<T>(latest: RefObject<T | null>, names: Partial<Record<keyof T, true>>): T {
  return Object.fromEntries(Object.keys(names).map((name) => [
    name,
    (...args: unknown[]) => (latest.current?.[name as keyof T] as ((...given: unknown[]) => unknown) | undefined)?.(...args),
  ])) as T;
}

export interface StandaloneEditorOptions {
  onTreeChange(nextTree: BlockTree): void;
  autoFocus?: boolean;
  compact?: boolean;
  onBlurOutside?(): void;
  onShortcut?(event: ReactKeyboardEvent): boolean;
  onFollowLink?(pageId: string, full: boolean): void;
}

export function DocumentEditor({
  page,
  readOnly = false,
  historical = false,
  properties,
  embed,
  standalone,
  surfaceContainer = "main",
}: {
  page: NotePage;
  readOnly?: boolean;
  /** An older version of the page, from its history. It is drawn and never
   *  written from — nor is anything shown in it, though what it shows (a
   *  page, a database) is the live one. `readOnly` alone is also a viewer's,
   *  who may still look around inside a database here. */
  historical?: boolean;
  /** Drawn between the title and the first block — where Notion lists a
   *  database page's properties, so its name, its status and its body read as
   *  one page rather than a form above a document. */
  properties?: ReactNode;
  /** Set when the editor is a page shown in place in another page by a link:
   *  the page being read, and the pages already shown around this one — never
   *  shown again inside it. */
  embed?: EmbedOptions;
  /** Runs the full block editor over a caller-owned `BlockTree` (used by Memos)
   *  without chrome, title fields, or workspace OT side effects. */
  standalone?: StandaloneEditorOptions;
  surfaceContainer?: "main" | "peek";
}) {
  const {
    annotateHistory,
    applyBlockMutations,
    archivePage,
    checkpointHistory,
    checkpointPage,
    commitPageOps,
    commitWrites,
    createPage,
    document: workspace,
    duplicatePage,
    platform,
    movePage,
    selectPage,
    openInNewTab,
    openInRightSplit,
    updatePage,
    canEdit,
    canMovePage,
    canTrashPage,
    spaces,
    undo,
    redo,
    canUndo,
    canRedo,
  } = useWorkspace();
  const { sharePageId, toast, openPeek, requestShare } = useUi();
  const mobile = useFold();
  const surfaceId = useId();
  /* Mentions read the workspace as it is at the moment they are drawn: a
     title changed anywhere is redrawn in every mention of that page. What
     happens on a press reads it as it is then (`store.getState()`). */
  const store = useWorkspaceStore();
  const pages = usePages();
  /* The tree drawn and edited here: this page's own paragraphs, with each of
     its blocks — a page of its own — shown in place among them as itself,
     holding its own (see composite.ts). A block this reader may not write in
     keeps the read-only frame it is shown in. */
  const showInPlace = useCallback((_row: Block, target: NotePage) => readOnly || canEdit(target.id), [canEdit, readOnly]);
  const composite = useMemo(() => composeTree(pages, page, showInPlace), [page, pages, showInPlace]);
  const tree = composite.tree;
  const latestTree = useRef(tree);
  latestTree.current = tree;
  /* Pages shown in place arrive as their lines load them (UC-48): an
     expanded link's page is pulled in, then redrawn where it stands. */
  const { loadPages } = useWorkspace();
  useEffect(() => { if (composite.unloaded.size) loadPages([...composite.unloaded]); }, [composite, loadPages]);
  /** The page holding a line drawn here: the block it is written in, or this
   *  page. */
  const ownerOf = useCallback((blockId: string): string => composite.owner.get(blockId) ?? page.id, [composite, page.id]);

  /* Blocks selected as blocks, Notion's blue selection: every block, in
     reading order, from the one it started on to the one it reached. */
  const [blockSelection, setBlockSelection] = useState<{ anchor: string; focus: string } | null>(null);
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [backlinksOpen, setBacklinksOpen] = useState(false);
  /* Uploads this session is making, by block — for the veil over a picture
     on its way, and a way to try again when one fails. */
  const [blockMenu, setBlockMenu] = useState<{ ids: string[]; anchor: AnchorRect } | null>(null);
  /* The page menu, open from a page's mark wherever it is drawn here, and
     the box that names a page — a block being a page, it names the page
     (`id`), as a sub-page's row does. */
  const [pageMenu, setPageMenu] = useState<PageMenuOpen | null>(null);
  const [naming, setNaming] = useState<{ id: string; anchor: AnchorRect } | null>(null);
  const [backlinksFor, setBacklinksFor] = useState<{ id: string; anchor: AnchorRect } | null>(null);
  // A YouTube or X link just pasted onto a line of its own, its card offered.
  const [cardOffer, setCardOffer] = useState<CardOfferState | null>(null);
  const [moveTo, setMoveTo] = useState<{ ids: string[]; anchor: AnchorRect } | null>(null);
  /* The `/linked` pick in flight: the slash's block and the pick it embeds
     a linked view with once a database and a view are chosen. */
  const [linkedPick, setLinkedPick] = useState<{
    blockId: string;
    stripped: InlineContent;
    pick: (databaseId: string, viewId: string) => void;
    anchor: AnchorRect | null;
  } | null>(null);
  const [format, setFormat] = useState<FormatState | null>(null);
  const [equationEdit, setEquationEdit] = useState<EquationEditState | null>(null);
  const equationEditRef = useRef<EquationEditState | null>(null);
  equationEditRef.current = equationEdit;
  const [focusedBlockId, setFocusedBlockId] = useState<string | null>(null);
  const [editingMode, setEditingMode] = useState<"block" | "title" | null>(null);
  const [caretMarks, setCaretMarks] = useState<Partial<Record<ToggleableMark, boolean>>>({});
  const subOverlayOpenRef = useRef(false);
  const savedBlockIdRef = useRef<string | null>(null);
  const savedCaretRef = useRef<{ blockId: string; start: number; end: number } | null>(null);
  const savedFormatRef = useRef<FormatState | null>(null);
  const mountDocRef = useRef<HTMLDivElement | null>(null);
  const standaloneUndoRef = useRef<BlockTree[]>([]);
  const standaloneRedoRef = useRef<BlockTree[]>([]);
  const standaloneRef = useRef(standalone);
  standaloneRef.current = standalone;
  const [dragIds, setDragIds] = useState<string[] | null>(null);
  const [drop, setDrop] = useState<DropState | null>(null);
  const [picker, setPicker] = useState<PickerOpen | null>(null);

  const pendingFocus = useRef<PendingFocus | null>(null);
  /* A slash the writer has waved away — with Escape, or by typing on past a
     query nothing answers to — stays away until they type another. */
  const slashDismissed = useRef<{ blockId: string; from: number } | null>(null);
  const mentionDismissed = useRef<{ blockId: string; from: number } | null>(null);
  /** Set when inline Markdown collapses: what is typed next, right there,
   *  carries on without the new mark (see `resumeTyping`). */
  const resume = useRef<(TypingResume & { blockId: string }) | null>(null);
  const pendingTextSelection = useRef<PendingTextSelection | null>(null);
  const blocksRef = useRef<HTMLDivElement | null>(null);
  /* A drag from a press in the page: across words from `start`, until it
     reaches a line with none, and from then on across whole lines, from
     `from` to the line it last reached (`blocks`). */
  const pointerSelection = useRef<{ start: DomCaretPoint | null; from: string; crossed: boolean; blocks: string | null } | null>(null);
  /* True from a press in the text until its release. The format toolbar waits
     for the release, as Notion's does — shown mid-drag it jumps about under the
     pointer and covers the very lines being selected. */
  const pointerDown = useRef(false);
  const titleRef = useRef<HTMLElement | null>(null);
  const articleRef = useRef<HTMLElement | null>(null);
  const [articleEl, setArticleEl] = useState<HTMLElement | null>(null);
  const setArticleRef = useCallback((element: HTMLElement | null) => {
    articleRef.current = element;
    setArticleEl(element);
  }, []);
  const caretX = useRef(0);

  const { rows, items } = useMemo(() => layout(tree), [tree]);
  const [renderWindow, setRenderWindow] = useState<{ pageId: string; count: number }>(() => ({
    pageId: page.id,
    count: !embed && !standalone && items.length > PROGRESSIVE_INITIAL ? PROGRESSIVE_INITIAL : Number.POSITIVE_INFINITY,
  }));
  const effectiveLimit = renderWindow.pageId === page.id
    ? renderWindow.count
    : (!embed && !standalone && items.length > PROGRESSIVE_INITIAL ? PROGRESSIVE_INITIAL : Number.POSITIVE_INFINITY);
  const visibleCount = embed || standalone ? items.length : Math.min(items.length, effectiveLimit);
  const hasMoreItems = visibleCount < items.length;
  const tailSentinelRef = useRef<HTMLDivElement | null>(null);
  const progressiveRef = useRef({ pageId: page.id, hasMore: hasMoreItems });
  progressiveRef.current = { pageId: page.id, hasMore: hasMoreItems };

  const ensureAllRendered = useCallback(() => {
    if (!progressiveRef.current.hasMore) return;
    const targetPageId = progressiveRef.current.pageId;
    flushSync(() => {
      setRenderWindow({ pageId: targetPageId, count: Number.POSITIVE_INFINITY });
    });
  }, []);

  useEffect(() => {
    if (!hasMoreItems) return;
    let frame = 0;
    let timer = 0;
    frame = window.requestAnimationFrame(() => {
      timer = window.setTimeout(() => {
        setRenderWindow((current) => {
          const base = current.pageId === page.id ? current.count : PROGRESSIVE_INITIAL;
          const next = base + PROGRESSIVE_BATCH;
          return { pageId: page.id, count: next >= items.length ? Number.POSITIVE_INFINITY : next };
        });
      }, 0);
    });
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      if (timer) window.clearTimeout(timer);
    };
  }, [hasMoreItems, items.length, page.id, visibleCount]);

  useEffect(() => {
    if (!hasMoreItems || typeof IntersectionObserver === "undefined") return;
    const sentinel = tailSentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setRenderWindow((current) => {
          const base = current.pageId === page.id ? current.count : PROGRESSIVE_INITIAL;
          const next = base + PROGRESSIVE_BATCH * 2;
          return { pageId: page.id, count: next >= items.length ? Number.POSITIVE_INFINITY : next };
        });
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMoreItems, items.length, page.id, visibleCount]);
  const selectedIds = useMemo(() => {
    if (!blockSelection) return [] as string[];
    const from = rows.findIndex((row) => row.block.id === blockSelection.anchor);
    const to = rows.findIndex((row) => row.block.id === blockSelection.focus);
    if (from < 0 || to < 0) return [] as string[];
    return rows.slice(Math.min(from, to), Math.max(from, to) + 1).map((row) => row.block.id);
  }, [blockSelection, rows]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  /* Everything a drag carries: the dragged blocks and all that is inside them. */
  const dragging = useMemo(
    () => new Set((dragIds ?? []).flatMap((id) => [id, ...descendantsOf(tree, id).map((block) => block.id)])),
    [dragIds, tree],
  );
  const commands = useMemo(() => (slash ? slashCommands(slash.query) : []), [slash]);

  const pagesRef = useRef(pages);
  /* The page being read: the one this editor shows, or — shown in place —
     the page around it. */
  const here = embed?.topPageId ?? page.id;
  /* Pages on screen already, whole: the page being read, pages shown in it,
     this one and the blocks drawn in it. What is in them is never shown a
     second time inside this editor. */
  const shownKey = [...(embed?.shownPages ?? []), ...composite.sources.keys()].join(" ");
  const shownPages = useMemo(() => shownKey.split(" ").filter(Boolean), [shownKey]);
  const describeMention = useMemo(() => mentionDescriber(() => pagesRef.current, undefined, shownPages), [shownPages]);
  const mentionOptions = useMemo(
    () => (mention ? mentionItems(mention.query, mention.trigger, pages, page.id) : []),
    [mention, page.id, pages],
  );
  const backlinks = useMemo(() => backlinksTo(pages, page), [page, pages]);
  /* Every link to every page and block, across the workspace. */
  const references = useMemo(() => referenceIndex(pages), [pages]);
  const lonely = rows.length === 1 && rows[0].block.kind === "text";

  /* The one place the editor writes to the DOM under a live caret: after a
     transaction that changed the focused block's own content. */
  useLayoutEffect(() => {
    const textSelection = pendingTextSelection.current;
    if (textSelection) {
      if (hasMoreItems && textSelection.ranges.some((range) => !editableWithin(blocksRef.current, range.blockId))) {
        setRenderWindow({ pageId: page.id, count: Number.POSITIVE_INFINITY });
        return;
      }
      pendingTextSelection.current = null;
      for (const blockId of textSelection.forceIds) {
        const element = editableWithin(blocksRef.current, blockId);
        const block = tree.by_id[blockId];
        if (element && block) element.innerHTML = editableHtml(block, describeMention);
      }
      selectRanges(blocksRef.current, textSelection.ranges);
      return;
    }
    const focus = pendingFocus.current;
    if (!focus) return;
    const element = editableWithin(blocksRef.current, focus.id);
    if (!element) {
      if (hasMoreItems && tree.by_id[focus.id]) {
        setRenderWindow({ pageId: page.id, count: Number.POSITIVE_INFINITY });
      } else {
        pendingFocus.current = null;
      }
      return;
    }
    pendingFocus.current = null;
    const forced = tree.by_id[focus.id];
    if (focus.force && forced) element.innerHTML = editableHtml(forced, describeMention);
    focusRange(element, focus.start, focus.end ?? focus.start);
  }, [describeMention, hasMoreItems, page.id, tree, visibleCount]);

  /* A page renamed, a page trashed, a new day: every mention on screen is
     brought up to date by attribute, never by rewriting the text it sits in. */
  useLayoutEffect(() => {
    pagesRef.current = pages;
    if (blocksRef.current) repaintMentions(blocksRef.current, describeMention);
  }, [describeMention, pages]);

  useEffect(() => {
    setBlockSelection(null);
    setSlash(null);
    setMention(null);
    setBacklinksOpen(false);
    setFormat(null);
    setFocusedBlockId(null);
    setEditingMode(null);
    setCaretMarks({});
    subOverlayOpenRef.current = false;
    savedBlockIdRef.current = null;
    savedCaretRef.current = null;
    savedFormatRef.current = null;
    clearEditSurface(surfaceId);
  }, [page.id, surfaceId]);

  /* A collapse holds only what is typed on from where it left the caret. A
     press anywhere lets go (and an arrow key, below), so coming back to the
     end of the word later carries its mark on, as it does everywhere else.
     Mobile formatting controls live in `.mobile-edit-bar` and `.bottom-sheet`:
     tapping them accumulates pending marks without wiping `resume`. */
  useEffect(() => {
    const letGo = (event: PointerEvent) => {
      if ((event.target as Element | null)?.closest(".mobile-edit-bar, .bottom-sheet")) return;
      resume.current = null;
    };
    document.addEventListener("pointerdown", letGo, true);
    return () => document.removeEventListener("pointerdown", letGo, true);
  }, []);

  /* A page you just made opens with the caret in its title, so naming it is
     the first thing that happens rather than a second click. On mobile only
     newly created pages open the title caret so browsing existing untitled
     notes does not immediately raise the soft keyboard. */
  const caretClaimed = useRef(false);
  useEffect(() => {
    if (readOnly || embed || standalone || page.title || sharePageId || !page.block_tree) return;
    if (caretClaimed.current) return;
    if (mobile && !consumeFresh(page.id)) return;
    const blocks = Object.values(page.block_tree.by_id);
    if (blocks.length > 1 || blocks.some((block) => inlinePlainText(block.content))) return;
    caretClaimed.current = true;
    titleRef.current?.focus();
    // Only when the page identity or the dialog above it changes — never on
    // every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mobile, page.id, readOnly, sharePageId]);
  const claimCaret = useCallback(() => { caretClaimed.current = true; }, []);
  /* A different page gets its own chance at the title caret. */
  useEffect(() => { caretClaimed.current = false; }, [page.id]);

  /* Every change goes to the pages holding what it touches (composite.ts):
     a line written in a block to the block's page, a block made from lines
     to a new page, a block deleted to the trash with all it holds — and a
     page's row taken out of the page it lives in sends that page to the trash
     too, back with ⌘Z or from there. A cut is the exception: what it takes
     is on its way somewhere else. A block is at least one paragraph, so
     whatever leaves one empty takes it out too. All read against the pages as
     they are now, not as this render saw them. */
  useEffect(() => {
    standaloneUndoRef.current = [];
    standaloneRedoRef.current = [];
  }, [page.id]);

  useEffect(() => {
    if (!standalone?.autoFocus || readOnly) return;
    const frame = requestAnimationFrame(() => {
      const first = orderedBlocks(latestTree.current)[0];
      if (!first) return;
      const element = editableWithin(blocksRef.current, first.id);
      if (element) focusAtEnd(element);
    });
    return () => cancelAnimationFrame(frame);
  }, [page.id, readOnly, standalone?.autoFocus]);

  const effectiveCanUndo = useCallback(
    () => (standaloneRef.current ? standaloneUndoRef.current.length > 0 : canUndo()),
    [canUndo],
  );
  const effectiveCanRedo = useCallback(
    () => (standaloneRef.current ? standaloneRedoRef.current.length > 0 : canRedo()),
    [canRedo],
  );
  const effectiveUndo = useCallback(() => {
    if (!standaloneRef.current) return undo();
    const prev = standaloneUndoRef.current.pop();
    if (!prev) return false;
    standaloneRedoRef.current.push(latestTree.current);
    latestTree.current = prev;
    const first = orderedBlocks(prev)[0];
    if (first) pendingFocus.current = { id: first.id, start: inlinePlainText(first.content).length, force: true };
    standaloneRef.current.onTreeChange(prev);
    return true;
  }, [undo]);
  const effectiveRedo = useCallback(() => {
    if (!standaloneRef.current) return redo();
    const next = standaloneRedoRef.current.pop();
    if (!next) return false;
    standaloneUndoRef.current.push(latestTree.current);
    latestTree.current = next;
    const first = orderedBlocks(next)[0];
    if (first) pendingFocus.current = { id: first.id, start: inlinePlainText(first.content).length, force: true };
    standaloneRef.current.onTreeChange(next);
    return true;
  }, [redo]);

  const write = useCallback((change: EditorTransaction, options: {
    cut?: readonly string[];
    record?: boolean;
    fold?: boolean;
    /** Writes that go with the change, in the same step — pages it makes. */
    extra?: readonly WorkspaceMutation[];
  } = {}): EditorTransaction | null => {
    if (standaloneRef.current) {
      const base = latestTree.current;
      let nextTree = applyEditorTransaction(base, change);
      if (!Object.keys(nextTree.by_id).length) {
        const blankId = createId("block");
        nextTree = { by_id: { [blankId]: createBlock(blankId) } };
        if (pendingFocus.current) pendingFocus.current = { id: blankId, start: 0, force: true };
      }
      if (options.record !== false) {
        standaloneUndoRef.current.push(base);
        if (standaloneUndoRef.current.length > 40) standaloneUndoRef.current.shift();
        standaloneRedoRef.current = [];
      }
      latestTree.current = nextTree;
      standaloneRef.current.onTreeChange(nextTree);
      return change;
    }
    if (!platform) return null;
    const live = workspace?.state.pages ?? pages;
    const current = composeTree(live, live[page.id] ?? page, showInPlace);
    const transaction = withoutEmptyPages(current.tree, change, () => createId("block"));
    if (!options.extra?.length) {
      const semantic = extractSinglePageOps(current, transaction, options.cut);
      if (semantic && commitPageOps(semantic.pageId, semantic.ops, { record: options.record ?? true, fold: options.fold })) {
        return transaction;
      }
    }
    commitWrites([...(options.extra ?? []), ...routeTransaction(current, live, transaction, {
      author: platform.bootstrap.user.displayName,
      now: new Date().toISOString(),
      newId: () => createId("block"),
      cut: options.cut,
    })], options.record ?? true);
    return transaction;
  }, [commitPageOps, commitWrites, page, pages, platform, showInPlace, workspace]);

  const execute = useCallback((change: EditorTransaction | null, focus?: PendingFocus, options: { cut?: readonly string[]; fold?: boolean } = {}) => {
    if (!change) return;
    /* A non-typing transaction is its own undo step: without this the capture
     *  window folds a mark or a menu write into keystrokes before it. */
    if (!options.fold) stopTextHistory();
    if (focus) pendingFocus.current = focus;
    else if (change.focus) pendingFocus.current = { id: change.focus.id, start: change.focus.offset };
    write(change, options);
  }, [write]);

  /* If a collaborator splits or merges the block holding our live caret,
     transform the caret cleanly into the target block and offset. */
  useEffect(() => {
    const onCaretShift = (event: Event) => {
      const detail = (event as CustomEvent<{ pageId?: string; ops?: PageOp[] }>).detail;
      if (!detail?.ops?.length || !blocksRef.current) return;
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !blocksRef.current.contains(active)) return;
      const currentSel = selectionPoints();
      if (!currentSel) return;
      const shifted = transformSelection(currentSel, detail.ops);
      if (shifted.focus.blockId !== currentSel.focus.blockId) {
        pendingFocus.current = { id: shifted.focus.blockId, start: shifted.focus.offset, end: shifted.focus.offset };
        requestAnimationFrame(() => {
          const el = editableWithin(blocksRef.current, shifted.focus.blockId);
          if (el) focusRange(el, shifted.focus.offset, shifted.focus.offset);
        });
      }
    };
    window.addEventListener("notes:collaboration-caret-shift", onCaretShift);
    return () => window.removeEventListener("notes:collaboration-caret-shift", onCaretShift);
  }, []);

  const closeMenus = useCallback(() => {
    setSlash(null);
    setMention(null);
    setBlockMenu(null);
    setFormat(null);
  }, []);

  const { updateFormat, applyMark, applyMarkToBlocks, openLink } = useFormatToolbar({
    readOnly,
    tree,
    blocksRef,
    pointerDown,
    pendingTextSelection,
    format,
    setFormat,
    execute,
  });

  const marksAtBlockCaret = useCallback((block: Block, element: HTMLElement | null): Partial<Record<ToggleableMark, boolean>> => {
    if (!element) return {};
    const at = caretOffset(element);
    const active = resume.current && resume.current.blockId === block.id && resume.current.at === at
      ? (resume.current.marks ?? {})
      : (at > 0 ? sliceInlineContent(block.content, at - 1, at)[0]?.marks ?? {} : {});
    return Object.fromEntries(MARKS.map(({ mark }) => [mark, Boolean(active[mark])])) as Partial<Record<ToggleableMark, boolean>>;
  }, []);

  useEffect(() => {
    if (!mobile || readOnly || editingMode !== "block" || !focusedBlockId) return;
    let frame = 0;
    const syncCaret = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (document.activeElement?.closest(".mobile-edit-bar, .bottom-sheet")) return;
        const element = editableWithin(blocksRef.current, focusedBlockId);
        const block = latestTree.current.by_id[focusedBlockId];
        if (!block || !element || !element.contains(document.activeElement)) return;
        setCaretMarks(marksAtBlockCaret(block, element));
      });
    };
    document.addEventListener("selectionchange", syncCaret);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", syncCaret);
    };
  }, [editingMode, focusedBlockId, marksAtBlockCaret, mobile, readOnly]);

  const mobileSurfaceActions = useRef({
    done: () => {},
    toggleMark: (_mark: ToggleableMark) => {},
    turnInto: (_kind: BlockKind) => {},
    insertBlock: (_kind: BlockKind) => {},
    insertMedia: (_kind: MediaInsertKind) => {},
    setLink: (_href: string | undefined) => {},
    setColor: (_color: ContentColor | undefined) => {},
    setSubOverlayOpen: (_open: boolean) => {},
  });
  mobileSurfaceActions.current = {
    done: () => {
      subOverlayOpenRef.current = false;
      savedBlockIdRef.current = null;
      savedCaretRef.current = null;
      savedFormatRef.current = null;
      const root = embed ? mountDocRef.current : articleRef.current;
      const active = document.activeElement;
      if (active instanceof HTMLElement && root?.contains(active)) active.blur();
      window.getSelection()?.removeAllRanges();
      setFormat(null);
      setEditingMode(null);
      setFocusedBlockId(null);
      clearEditSurface(surfaceId);
    },
    toggleMark: (mark) => {
      const activeFormat = format ?? savedFormatRef.current;
      if (activeFormat?.ranges.length) {
        applyMarkToBlocks(activeFormat.ranges, mark, !activeFormat.marks[mark]);
        return;
      }
      const targetId = focusedBlockId ?? savedBlockIdRef.current;
      if (!targetId) return;
      const block = latestTree.current.by_id[targetId];
      const element = editableWithin(blocksRef.current, targetId);
      if (!block || !element || block.kind === "code") return;
      const at = caretOffset(element);
      const current = resume.current && resume.current.blockId === block.id && resume.current.at === at
        ? (resume.current.marks ?? {})
        : (at > 0 ? sliceInlineContent(block.content, at - 1, at)[0]?.marks ?? {} : {});
      const next: InlineMarks = { ...current };
      if (next[mark]) delete next[mark];
      else next[mark] = true;
      resume.current = {
        blockId: block.id,
        at,
        content: block.content,
        marks: Object.keys(next).length ? next : undefined,
      };
      setCaretMarks(Object.fromEntries(MARKS.map(({ mark: item }) => [item, Boolean(next[item])])) as Partial<Record<ToggleableMark, boolean>>);
      if (document.activeElement !== element) focusRange(element, at, at);
    },
    turnInto: (kind) => {
      const currentTree = latestTree.current;
      const activeFormat = format ?? savedFormatRef.current;
      if (activeFormat && activeFormat.ranges.length > 1) {
        executeOnBlocks(convertBlocks(currentTree, activeFormat.ranges.map((range) => range.blockId), kind));
        return;
      }
      const targetId = activeFormat?.ranges[0]?.blockId ?? savedBlockIdRef.current ?? focusedBlockId;
      if (!targetId) return;
      execute(convertBlock(currentTree, targetId, kind));
      setFocusedBlockId(targetId);
      setEditingMode("block");
    },
    insertBlock: (kind) => {
      const currentTree = latestTree.current;
      const afterId = savedBlockIdRef.current ?? focusedBlockId ?? rows.at(-1)?.block.id;
      if (!afterId) return;
      if (kind === "table") {
        const tableId = createId("block");
        const inserted = insertBlockAfter(currentTree, afterId, tableId, "table");
        if (!inserted) return;
        const made = (inserted.mutations[0] as Extract<BlockMutation, { action: "put" }>).block;
        const mutations: BlockMutation[] = [
          { action: "put", block: { ...made, table: newSimpleTable(3, 2, (part) => createId(part === "column" ? "col" : "row")) } },
        ];
        const placed = applyEditorTransaction(currentTree, { mutations });
        const parentId = placed.by_id[tableId]?.parent_id ?? null;
        if (orderedBlocks(placed, parentId).at(-1)?.id === tableId) {
          const trailing = insertBlockAfter(placed, tableId, createId("block"));
          if (trailing) mutations.push(...trailing.mutations);
        }
        markFreshTable(tableId);
        execute({ mutations });
        return;
      }
      if (kind === "divider") {
        const dividerId = createId("block");
        const inserted = insertBlockAfter(currentTree, afterId, dividerId, "divider");
        if (!inserted) return;
        const mutations: BlockMutation[] = [...inserted.mutations];
        const nextId = createId("block");
        const placed = applyEditorTransaction(currentTree, { mutations });
        const trailing = insertBlockAfter(placed, dividerId, nextId, "text");
        if (trailing) mutations.push(...trailing.mutations);
        execute({ mutations }, { id: nextId, start: 0, force: true });
        setFocusedBlockId(nextId);
        setEditingMode("block");
        return;
      }
      const nextId = createId("block");
      const inserted = insertBlockAfter(currentTree, afterId, nextId, kind);
      if (!inserted) return;
      if (kind === "todo") {
        const block = (inserted.mutations[0] as Extract<BlockMutation, { action: "put" }>).block;
        block.checked = false;
      }
      execute(inserted, { id: nextId, start: 0, force: true });
      setFocusedBlockId(nextId);
      setEditingMode("block");
    },
    insertMedia: (kind) => {
      const currentTree = latestTree.current;
      const targetId = (subOverlayOpenRef.current ? savedBlockIdRef.current : null)
        ?? focusedBlockId
        ?? savedBlockIdRef.current
        ?? rows.at(-1)?.block.id;
      if (!targetId) return;
      const block = currentTree.by_id[targetId];
      if (!block) return;
      const element = editableWithin(blocksRef.current, targetId);
      let range: { start: number; end: number } | null = null;
      if (element && element.contains(document.activeElement)) {
        const caret = caretOffset(element);
        range = selectionOffsets(element) ?? { start: caret, end: caret };
      } else if (savedCaretRef.current?.blockId === targetId) {
        range = { start: savedCaretRef.current.start, end: savedCaretRef.current.end };
      }
      subOverlayOpenRef.current = false;
      pickMedia(
        mediaLanding(block, kind, block.content, range),
        { accept: kind === "image" ? "image/*" : "", multiple: true },
      );
    },
    setLink: (href) => {
      const activeFormat = format ?? savedFormatRef.current;
      if (activeFormat?.ranges.length) applyMarkToBlocks(activeFormat.ranges, "link", href);
    },
    setColor: (color) => {
      const activeFormat = format ?? savedFormatRef.current;
      if (activeFormat?.ranges.length) {
        applyMarkToBlocks(activeFormat.ranges, "color", color);
        return;
      }
      const targetId = savedBlockIdRef.current ?? focusedBlockId;
      if (targetId) execute(colorBlocks(latestTree.current, [targetId], color));
    },
    setSubOverlayOpen: (open) => {
      if (open) {
        savedBlockIdRef.current = focusedBlockId;
        savedFormatRef.current = format;
        const element = focusedBlockId ? editableWithin(blocksRef.current, focusedBlockId) : null;
        if (focusedBlockId && element && element.contains(document.activeElement)) {
          const caret = caretOffset(element);
          const range = selectionOffsets(element) ?? { start: caret, end: caret };
          savedCaretRef.current = { blockId: focusedBlockId, start: range.start, end: range.end };
        } else {
          savedCaretRef.current = null;
        }
        subOverlayOpenRef.current = true;
        return;
      }
      subOverlayOpenRef.current = false;
      const savedRanges = savedFormatRef.current?.ranges;
      const savedBlock = savedBlockIdRef.current;
      requestAnimationFrame(() => {
        if (savedRanges?.length) {
          selectRanges(blocksRef.current, savedRanges);
          return;
        }
        if (savedBlock) {
          const element = editableWithin(blocksRef.current, savedBlock);
          if (element && document.activeElement !== element) focusRange(element, caretOffset(element));
        }
      });
    },
  };

  useEffect(() => () => clearEditSurface(surfaceId), [surfaceId]);

  useEffect(() => {
    if (!mobile || readOnly || !editingMode) {
      clearEditSurface(surfaceId);
      return;
    }
    const block = focusedBlockId ? tree.by_id[focusedBlockId] : undefined;
    const isBlock = editingMode === "block" && Boolean(block);
    registerEditSurface({
      surfaceId,
      mode: editingMode === "title" || !isBlock ? "title" : "block",
      container: surfaceContainer,
      pageId: page.id,
      blockId: editingMode === "title" ? page.id : (block?.id ?? null),
      blockKind: block?.kind,
      marks: format ? format.marks : caretMarks,
      link: format?.link,
      color: format?.color ?? block?.color,
      canUndo: effectiveCanUndo(),
      canRedo: effectiveCanRedo(),
      subOverlayOpen: subOverlayOpenRef.current,
      undo: effectiveUndo,
      redo: effectiveRedo,
      done: () => mobileSurfaceActions.current.done(),
      toggleMark: (mark) => mobileSurfaceActions.current.toggleMark(mark),
      turnInto: (kind) => mobileSurfaceActions.current.turnInto(kind),
      insertBlock: (kind) => mobileSurfaceActions.current.insertBlock(kind),
      insertMedia: isBlock ? (kind) => mobileSurfaceActions.current.insertMedia(kind) : undefined,
      setLink: (href) => mobileSurfaceActions.current.setLink(href),
      setColor: (color) => mobileSurfaceActions.current.setColor(color),
      setSubOverlayOpen: (open) => mobileSurfaceActions.current.setSubOverlayOpen(open),
    });
  }, [caretMarks, editingMode, effectiveCanRedo, effectiveCanUndo, effectiveRedo, effectiveUndo, focusedBlockId, format, mobile, page.id, readOnly, surfaceContainer, surfaceId, tree]);

  const handleContainerBlur = useCallback(() => {
    if (readOnly) return;
    if (standaloneRef.current) {
      if (subOverlayOpenRef.current || equationEditRef.current) return;
      if (standaloneRef.current.onBlurOutside) {
        requestAnimationFrame(() => {
          if (subOverlayOpenRef.current || equationEditRef.current) return;
          const active = document.activeElement;
          const root = mountDocRef.current;
          if (active instanceof Element && (
            root?.contains(active)
            || active.closest(".popover, .pop, .overlay, .format-bar, .menu, .slash, .mobile-edit-bar, .bottom-sheet, .memo-entry__actions, .memo-inline-edit__foot")
          )) return;
          standaloneRef.current?.onBlurOutside?.();
        });
      }
      return;
    }
    if (!mobile) return;
    requestAnimationFrame(() => {
      if (subOverlayOpenRef.current) return;
      const active = document.activeElement;
      const root = embed ? mountDocRef.current : articleRef.current;
      if (active instanceof Element && (root?.contains(active) || active.closest(".mobile-edit-bar, .bottom-sheet, .topbar--mobile, .side-peek__head--mobile"))) return;
      setEditingMode(null);
      setFocusedBlockId(null);
      clearEditSurface(surfaceId);
    });
  }, [embed, mobile, readOnly, surfaceId]);

  const titleOf = useCallback((pageId: string) => {
    const target = store.getState().pages[pageId];
    return target ? pageName(target) : "";
  }, [store]);

  /* A YouTube or X link pasted onto a line of its own: its card is offered
     under the line once the line is drawn, as Notion's paste menu offers an
     embed; the link stays unless the card is taken. */
  const offerCard = useCallback((blockId: string, href: string) => {
    const embed = embedFromUrl(href);
    if (!embed || readOnly) return;
    requestAnimationFrame(() => {
      const line = editableWithin(blocksRef.current, blockId);
      if (line) setCardOffer({ blockId, href, embed, anchor: rectOf(line), index: 0 });
    });
  }, [readOnly]);

  /** The card taken: the line that is nothing but its link becomes the card,
   *  and the caret goes on below it — into the empty line there, or a new
   *  one — as after Notion's embed. */
  const takeCardOffer = useCallback((offer: CardOfferState) => {
    const block = tree.by_id[offer.blockId];
    if (!block || !lineIsOnlyLink(block, offer.href)) return;
    const change = embedLink(tree, offer.blockId, offer.href, offer.embed, createId("block"));
    if (!change) return;
    if (orderedBlocks(tree, block.id).length) {
      execute(change);
      return;
    }
    const siblings = orderedBlocks(tree, block.parent_id);
    const next = siblings[siblings.findIndex((item) => item.id === block.id) + 1];
    const reuse = Boolean(next && next.kind === "text" && !inlinePlainText(next.content).trim() && !orderedBlocks(tree, next.id).length);
    const lineId = reuse && next ? next.id : createId("block");
    const mutations = [...change.mutations];
    if (!reuse) {
      mutations.push({ action: "put", block: createBlock(lineId, "text", {
        parent_id: block.parent_id,
        order: blockOrderBetween(tree, block.parent_id, block.id, next?.id),
      }) });
    }
    execute({ mutations }, { id: lineId, start: 0, force: true });
  }, [execute, tree]);

  /* The offer answers the keys while the caret stays in the line: ↑ ↓
     choose, Enter takes, Escape keeps the link — and so does typing on. */
  useEffect(() => {
    if (!cardOffer) return;
    const onKey = (event: KeyboardEvent) => {
      if (imeComposing(event)) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setCardOffer((current) => current && { ...current, index: current.index === 0 ? 1 : 0 });
        return;
      }
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setCardOffer(null);
        if (event.key === "Enter" && cardOffer.index === 0) takeCardOffer(cardOffer);
        return;
      }
      if (!["Shift", "Meta", "Control", "Alt", "CapsLock"].includes(event.key)) setCardOffer(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cardOffer, takeCardOffer]);

  // An offer for a line that is gone, or no longer the link, goes too.
  const offeredLine = cardOffer ? tree.by_id[cardOffer.blockId] : undefined;
  const offerStands = Boolean(cardOffer && offeredLine && lineIsOnlyLink(offeredLine, cardOffer.href));
  useEffect(() => {
    if (cardOffer && !offerStands) setCardOffer(null);
  }, [cardOffer, offerStands]);

  /* Notion's link card: a web link rested on shows where it goes, to copy,
     edit or — a YouTube video, a post on X — show as its card. */
  const linkHover = useLinkHover();
  const copyHoveredLink = (link: HoveredLink) => {
    linkHover.close();
    void copyText(link.href)
      .then(() => toast("Link copied", "success"))
      .catch(() => toast("Could not copy that link", "error"));
  };
  /** Edit: the link's words selected and the Link box open on them, as ⌘K
   *  opens it — holding the address, with Update and Remove. */
  const editHoveredLink = (link: HoveredLink) => {
    linkHover.close();
    const editable = link.element.closest<HTMLElement>(".block__editable");
    if (!link.element.isConnected || !editable) return;
    editable.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(link.element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    openLink();
  };
  const embedHoveredLink = (link: HoveredLink, embed: Embed) => {
    linkHover.close();
    execute(embedLink(tree, link.blockId, link.href, embed, createId("block")));
  };

  /* Text selected across blocks is copied AS blocks — each keeps its kind —
     so pasting it back makes the same headings and lists, not plain lines. */
  const copyTextSelection = useCallback((data: DataTransfer, cut: boolean): boolean => {
    const ranges = blocksRef.current ? selectedBlockRanges(blocksRef.current) : [];
    if (ranges.length === 1) {
      // Words from one block are the browser's to copy — unless a mention is
      // among them, whose title the browser cannot see: it would copy the
      // token's invisible character. Those go as a line of blocks, which pastes
      // back in among the words, mention and all, and reads as titles outside.
      const [range] = ranges;
      const words = sliceInlineContent(tree.by_id[range.blockId]?.content ?? [], range.start, range.end);
      if (!words.some((run) => run.mention)) return false;
      const lineId = createId("block");
      const payload: CopiedBlocks = { tree: { by_id: { [lineId]: createBlock(lineId, "text", { content: words }) } }, cut, source: page.id };
      writeBlocks(data, payload, titleOf);
      if (platform) {
        void copySingleImageBlocks(payload, titleOf, (image) => readFileBlob(platform.files, image.file))?.catch(() => undefined);
      }
      return true;
    }
    if (ranges.length < 2) return false;
    writeBlocks(data, { tree: selectionFragment(tree, ranges), cut, source: page.id }, titleOf);
    return true;
  }, [page.id, platform, titleOf, tree]);

  const onCopySelection = useCallback((event: ClipboardEvent<HTMLDivElement>) => {
    if (copyTextSelection(event.clipboardData, false)) event.preventDefault();
  }, [copyTextSelection]);

  /** Selects blocks as blocks. The caret lets go — typing must not reach a
   *  block — and any text selection goes, since it would read as theirs. */
  const selectBlocks = useCallback((anchor: string, focus: string = anchor) => {
    if (progressiveRef.current.hasMore) {
      setRenderWindow({ pageId: progressiveRef.current.pageId, count: Number.POSITIVE_INFINITY });
    }
    const active = document.activeElement;
    if (active instanceof HTMLElement && blocksRef.current?.contains(active)) active.blur();
    window.getSelection()?.removeAllRanges();
    setSlash(null);
    setFormat(null);
    setBlockSelection({ anchor, focus });
  }, []);

  /* Native dragging cannot cross independent contenteditable roots. Preserve
     the browser's ordinary selection within one block, then bridge the range
     ourselves as soon as the pointer enters another block. */
  const beginPointerSelection = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    // Shift+click selects blocks (below), rather than starting a text drag.
    if (event.button !== 0 || event.shiftKey) return;
    const root = blocksRef.current;
    const target = event.target as Element | null;
    const row = target?.closest<HTMLElement>("[data-block-id]");
    // A block shown in place has its own editor, and its own selection; a
    // press on selected blocks drags them, or is a click into one.
    if (!root || !row || row.closest(".blocks") !== root || selectedSet.has(row.dataset.blockId ?? "")) return;
    const editable = target?.closest(".block__editable");
    // A line with no words of its own — a divider — is selected whole, from
    // the first move onto another line. A page's row is moved by its name.
    const whole = !editable && Boolean(target?.closest(".block__rule"));
    if (!editable && !whole) return;
    pointerDown.current = true;
    // Block handles stay out of the way while text is being selected; shown,
    // the hovered block's handle chases the pointer down the page.
    root.classList.add("is-selecting");
    const start = editable ? caretPointFromViewport(root, event.clientX, event.clientY) : null;
    if (start || whole) pointerSelection.current = { start, from: start?.blockId ?? row.dataset.blockId ?? "", crossed: false, blocks: null };
  }, [selectedSet]);

  useEffect(() => {
    let frame = 0;
    /* Inside the block the press began in, the browser's own drag-selection is
       left alone. Once the pointer is over another block the selection is
       ours: the browser cannot carry a selection across editing hosts, and
       left running it snaps the range back into the first block on every move
       while this handler pushes it out again — the stutter. Cancelling the
       MOUSEmove (a cancelled pointermove does not stop it) switches it off, and
       the range is set in the same event rather than a frame later. */
    const onMove = (event: MouseEvent) => {
      const drag = pointerSelection.current;
      const root = blocksRef.current;
      if (!drag || !root) return;
      if (!(event.buttons & 1)) return;
      /* Words can be selected only between lines of words. Over a line with
         none — a page's row, a divider — the selection becomes the lines
         themselves, as Notion's does, from the line the press began on. */
      const row = rowNear(root, event.clientY);
      const over = row?.dataset.blockId;
      // A picture's or a file's caption is words, but the line is the picture.
      const wordless = Boolean(over && (!editableWithin(root, over) || row?.querySelector(":scope > .block__content > .block__media")));
      if (!drag.start || drag.blocks || (over && over !== drag.from && wordless)) {
        if (!over || (!drag.blocks && over === drag.from)) return;
        event.preventDefault();
        if (over !== drag.blocks) {
          drag.blocks = over;
          selectBlocks(drag.from, over);
        }
        return;
      }
      const end = caretPointNear(root, event.clientX, event.clientY);
      if (!end) return;
      if (!drag.crossed && end.blockId === drag.start.blockId) return;
      drag.crossed = true;
      event.preventDefault();
      selectBetweenPoints(drag.start, end);
    };
    const finish = () => {
      if (!pointerDown.current && !pointerSelection.current) return;
      pointerDown.current = false;
      pointerSelection.current = null;
      blocksRef.current?.classList.remove("is-selecting");
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => updateFormat.current());
    };
    document.addEventListener("mousemove", onMove, { passive: false });
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
    };
  }, [selectBlocks, updateFormat]);

  /* A selection is never picked up and dragged as text: the editor has no text
     drop target, so the translucent copy that follows the pointer would land
     nowhere. Block handles and database cards drag as before. */
  const blockTextDrags = useCallback((event: DragEvent<HTMLDivElement>) => {
    if ((event.target as Element | null)?.closest?.(".block__editable")) event.preventDefault();
  }, []);

  /* A selection that runs across blocks is edited here, because the browser
     cannot: each block is its own editing host, so left to itself Delete only
     reaches the block the caret started in. The selection is replaced by
     `insert` — nothing for Delete, a character for typing, the clipboard for
     paste — and the caret lands after it. */
  const replaceSelection = useCallback((insert: InlineContent = []): EditorTransaction | null => {
    const root = blocksRef.current;
    const ranges = root ? selectedBlockRanges(root) : [];
    if (ranges.length < 2) return null;
    return deleteAcrossBlocks(tree, ranges, insert, (block: Block) => blockDefinition(block.kind).canHaveChildren);
  }, [tree]);

  const runReplace = useCallback((transaction: EditorTransaction | null, options: { cut?: readonly string[] } = {}): boolean => {
    if (!transaction?.focus) return false;
    setFormat(null);
    execute(transaction, { id: transaction.focus.id, start: transaction.focus.offset, force: true }, options);
    return true;
  }, [execute]);

  const onCutSelection = useCallback((event: ClipboardEvent<HTMLDivElement>) => {
    const ranges = blocksRef.current ? selectedBlockRanges(blocksRef.current) : [];
    const single = ranges.length === 1 ? tree.by_id[ranges[0].blockId] : undefined;
    if (single && copyTextSelection(event.clipboardData, true)) {
      event.preventDefault();
      execute(updateBlockContent(tree, single.id, replaceRange(single.content, ranges[0].start, ranges[0].end, "")), {
        id: single.id, start: ranges[0].start, force: true,
      });
      return;
    }
    const transaction = replaceSelection();
    if (!transaction || !copyTextSelection(event.clipboardData, true)) return;
    event.preventDefault();
    // What the words were in goes with them: a page's row among them keeps
    // its page, to be pasted.
    runReplace(transaction, { cut: Object.keys(selectionFragment(tree, ranges).by_id) });
  }, [copyTextSelection, execute, replaceSelection, runReplace, tree]);

  /* ── Blocks selected as blocks ──────────────────────────────────────── */

  const anchorFor = useCallback((blockId: string): AnchorRect | null => {
    const row = blocksRef.current?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"] > :is(.block__content, .mount, .db-frame)`);
    return row ? rectOf(row) : null;
  }, []);

  /** Deletes blocks — a page's block taking its page to the trash, unless the
   *  blocks are being cut. The block before them is selected next, as Notion
   *  does, so the keyboard stays in blocks. */
  const deleteSelected = useCallback((ids: readonly string[], options: { cut?: boolean } = {}) => {
    const tops = topLevelBlocks(tree, ids);
    if (!tops.length) return;
    const chosen = new Set(ids);
    const first = rows.findIndex((row) => chosen.has(row.block.id));
    const gone = new Set(ids);
    const after = rows.slice(first + 1).find((row) => !gone.has(row.block.id) && !tops.some((top) => row.block.parent_id === top.id));
    const fallback = rows[first - 1]?.block.id ?? after?.block.id ?? null;
    execute(deleteBlocks(tree, ids, createId("block")), undefined, options.cut ? { cut: ids } : {});
    setBlockSelection(fallback ? { anchor: fallback, focus: fallback } : null);
  }, [execute, rows, tree]);

  /** Whether blocks can become a database: one table, or lines of a list
   *  standing side by side. */
  const databaseReady = useCallback((blockIds: readonly string[]): boolean => {
    const tops = topLevelBlocks(tree, blockIds);
    return !readOnly && ((tops.length === 1 && tops[0].kind === "table") || isList(tops));
  }, [readOnly, tree]);

  /* A list's lines — or a table — turned into a database drawn right where
     they stood (features/database/convert.ts has the rules). One step of
     undo: the pages it makes and the lines it takes go in one write. */
  const convertToDatabase = useCallback((blockIds: readonly string[]) => {
    if (readOnly || !platform || !databaseReady(blockIds)) return;
    const tops = topLevelBlocks(tree, blockIds);
    const table = tops[0].kind === "table" ? tops[0] : undefined;
    const span = pageSpan(tree, tops.map((top) => top.id));
    if (!span || span.blocks.length !== tops.length) {
      toast("Only lines that stand together can become a database.", "error");
      return;
    }
    const refusal = table ? null : listRefusal(tree, tops);
    if (refusal) {
      toast(refusal, "error");
      return;
    }
    const holder = ownerOf(tops[0].id);
    const stamp = { now: new Date().toISOString(), author: platform.bootstrap.user.displayName };
    const ids: ConversionIds = {
      page: (kind) => createId(kind),
      block: () => createId("block"),
      property: () => createId("property"),
      view: () => createId("view"),
      column: () => createId("col"),
      row: () => createId("row"),
    };
    const made = table ? databaseFromTable(table, holder, ids, stamp) : databaseFromList(tree, tops, holder, ids, stamp, describeMention);
    const database = made[0];
    const rowId = createId("block");
    const mutations: BlockMutation[] = [
      ...tops.flatMap((top) => [top, ...descendantsOf(tree, top.id)]).map((block) => ({ action: "delete" as const, blockId: block.id })),
      { action: "put", block: pageLine(rowId, database.id, { parent_id: tops[0].parent_id, order: tops[0].order, expanded: true }) },
    ];
    // A database shown here takes no caret: a line follows it when it would
    // otherwise end its run.
    const placed = applyEditorTransaction(tree, { mutations });
    if (orderedBlocks(placed, tops[0].parent_id).at(-1)?.id === rowId) {
      const trailing = insertBlockAfter(placed, rowId, createId("block"));
      if (trailing) mutations.push(...trailing.mutations);
    }
    setBlockSelection(null);
    setBlockMenu(null);
    setFormat(null);
    markFresh(database.id);
    write({ mutations }, {
      extra: made.map((made): WorkspaceMutation => ({ type: "set", path: ["pages", made.id], value: made })),
    });
  }, [databaseReady, describeMention, ownerOf, platform, readOnly, toast, tree, write]);

  /* A block is duplicated as the page it is — everything in it, the blocks
     and pages inside it too — right after it, under the same name. Lines are
     copied in place; a link among them links the same page. */
  const duplicateSelected = useCallback((ids: readonly string[], options: { select?: boolean } = {}) => {
    const { transaction, copies } = duplicateSelection(composite, ids, {
      duplicatePage,
      newId: () => createId("block"),
    });
    if (transaction) execute(transaction);
    if (options.select === false) return;
    const [first, last] = [copies[0], copies.at(-1)];
    if (first && last) setBlockSelection({ anchor: first, focus: last });
  }, [composite, duplicatePage, execute]);

  const openMoveTo = useCallback((ids: readonly string[]) => {
    const anchor = ids[0] ? anchorFor(ids[0]) : null;
    if (anchor) setMoveTo({ ids: [...ids], anchor });
  }, [anchorFor]);

  /** The pages "Move to" carries along: each block among the lines, shown in
   *  place — a link among them is only a link, and leaves its page where it
   *  is. */
  const movingPages = useCallback((ids: readonly string[]): string[] => (
    topLevelBlocks(tree, ids).filter((block) => composite.rows.has(block.id)).map((block) => block.id)
  ), [composite, tree]);

  /** Pages the blocks can go to: any other page with a body this member can
   *  edit, but not a page among the ones named in them, nor anything inside
   *  those; every page carried along must be one this member may move there
   *  (`canMovePage`, the rule dragging in the page list follows too); and
   *  across spaces only between spaces this member owns (never into or out of
   *  someone else's shared tree or a knowledge base). */
  const moveTargets = useCallback((ids: readonly string[]) => {
    const pages = store.getState().pages;
    const moving = movingPages(ids);
    const carried = new Set(moving);
    const reachable = (candidate: NotePage) => {
      const seen = new Set<string>();
      let cursor: NotePage | undefined = candidate;
      while (cursor && !seen.has(cursor.id)) {
        if (cursor.archived || cursor.purging || carried.has(cursor.id)) return false;
        seen.add(cursor.id);
        cursor = cursor.parent_id ? pages[cursor.parent_id] : undefined;
      }
      return true;
    };
    const here = spaceOfPage(pages, page.id);
    const ownsHere = !here || spaces[here]?.role === "owner";
    return Object.values(pages).filter((candidate) => {
      const there = spaceOfPage(pages, candidate.id);
      const sameSpace = there === here;
      const ownsThere = !there || spaces[there]?.role === "owner";
      const crossesLibrary = !sameSpace && Boolean((here && spaces[here]?.knowledgeBase) || (there && spaces[there]?.knowledgeBase));
      return candidate.kind === "document"
        && !composite.sources.has(candidate.id)
        && reachable(candidate)
        && canEdit(candidate.id)
        && (sameSpace || (!crossesLibrary && ownsHere && ownsThere))
        && moving.every((pageId) => canMovePage(pageId, candidate.id));
    });
  }, [canEdit, canMovePage, composite, movingPages, page.id, spaces, store]);

  /** "Move to": the blocks leave for the end of another page. A block goes
   *  as the page it is, whole; a link goes as a link. */
  const moveToPage = useCallback((ids: readonly string[], targetId: string) => {
    const pages = store.getState().pages;
    const target = pages[targetId];
    const tops = topLevelBlocks(tree, ids);
    // The target must be loaded: its blocks carry what is moved there.
    if (!target?.block_tree || !tops.length) return;
    const blocks = new Set(tops.filter((block) => composite.rows.has(block.id)).map((block) => block.id));
    // A block goes as the page it is, its line with it.
    for (const pageId of movingPages(ids)) movePage(pageId, targetId);
    const lines = tops.filter((block) => !blocks.has(block.id)).map((block) => block.id);
    if (lines.length) {
      const fragment = storedFragment(composite, extractFragment(tree, lines));
      execute(deleteBlocks(tree, lines, createId("block")), undefined, { cut: lines });
      const latest = (workspace?.state.pages ?? pages)[targetId] ?? target;
      applyBlockMutations(targetId, appendFragment(latest.block_tree!, fragment));
    }
    setBlockSelection(null);
    toast(`Moved to ${pageName(target)}`, "success");
  }, [applyBlockMutations, composite, execute, movePage, movingPages, store, toast, tree, workspace]);

  /* Pasting a block that was CUT moves its page to where it is pasted: what
     is shown in place is the page. A link, cut or copied, is a link. */
  const adoptCutPages = useCallback((incoming: CopiedBlocks | null, fragment: BlockTree, at: string | null) => {
    if (!incoming?.cut) return;
    const pages = store.getState().pages;
    const holder = at ? ownerOf(at) : page.id;
    for (const block of Object.values(fragment.by_id)) {
      const link = lineLink(block);
      const moved = link?.expanded ? pages[link.page_id] : undefined;
      if (moved && !inTrash(pages, moved.id) && moved.parent_id !== holder) movePage(moved.id, holder);
    }
  }, [movePage, ownerOf, page.id, store]);

  /** What a paste brings, as blocks: blocks copied from HeiNote, or text of
   *  more than one line. Null for one line of text, which is typed in. A
   *  block that was cut keeps its id, so the paste moves that very page. */
  const pastedBlocks = useCallback((data: DataTransfer): { incoming: CopiedBlocks | null; fragment: BlockTree } | null => {
    const incoming = readBlocks(data);
    // A grid — a spreadsheet's cells, a web page's table, a Markdown table —
    // comes in as a simple table.
    const grid = incoming ? null : readGrid(data, false);
    const tableId = createId("block");
    const table = grid ? { by_id: { [tableId]: createBlock(tableId, "table", {
      table: tableFromCells(grid.rows, (kind) => createId(kind === "column" ? "col" : "row"), { headerRow: grid.header, spans: grid.spans, aligns: grid.aligns, colors: grid.colors }),
    }) } } : null;
    const blocks = incoming?.tree ?? table ?? textToBlocks(data.getData("text/plain"), () => createId("block"));
    if (!blocks) return null;
    const pages = store.getState().pages;
    let cleaned = blocks;
    if (incoming?.cut) {
      const targetSpace = spaceOfPage(pages, page.id);
      const blockedIds = new Set<string>();
      for (const block of Object.values(blocks.by_id)) {
        const link = lineLink(block);
        const moved = link?.expanded ? pages[link.page_id] : undefined;
        if (moved && spaceOfPage(pages, moved.id) !== targetSpace && !canMovePage(moved.id, page.id)) {
          blockedIds.add(block.id);
        }
      }
      if (blockedIds.size) {
        let changed = true;
        while (changed) {
          changed = false;
          for (const block of Object.values(blocks.by_id)) {
            if (!blockedIds.has(block.id) && block.parent_id && blockedIds.has(block.parent_id)) {
              blockedIds.add(block.id);
              changed = true;
            }
          }
        }
        cleaned = {
          by_id: Object.fromEntries(Object.entries(blocks.by_id).filter(([id]) => !blockedIds.has(id))),
        };
        toast("不能跨空间移动子页面，请使用「拷贝到…」", "info");
      }
    }
    const keep = (block: Block) => Boolean(incoming?.cut && block.kind === "page" && pages[block.id] && !composite.sources.has(block.id));
    return { incoming, fragment: reidentify(cleaned, () => createId("block"), keep) };
  }, [canMovePage, composite, page.id, store, toast]);

  /** A command on selected blocks keeps them selected: none of these puts a
   *  caret anywhere. */
  const executeOnBlocks = useCallback((transaction: EditorTransaction | null, options: { cut?: readonly string[] } = {}) => {
    execute(transaction ? { ...transaction, focus: undefined } : null, undefined, options);
  }, [execute]);

  /* The editor as its parts read it — typing, keys, selected blocks' keys,
     pictures and files — and act through it. */
  const editor: Editor = {
    page, pages, pagesRef, tree, rows, embed, readOnly, platform, workspace, blocksRef, caretX,
    slash, setSlash, slashIndex, setSlashIndex, slashDismissed, commands,
    mention, setMention, mentionIndex, setMentionIndex, mentionDismissed, mentionOptions,
    setFormat, resume, pendingTextSelection, latestTree, undo: effectiveUndo, redo: effectiveRedo, canUndo: effectiveCanUndo, canRedo: effectiveCanRedo, blockSelection, setBlockSelection, selectedIds, setBlockMenu,
    showInPlace, ownerOf, titleOf, anchorFor, createPage, checkpointHistory, annotateHistory,
    write, execute, executeOnBlocks, runReplace, replaceSelection, selectBlocks, deleteSelected, duplicateSelected,
    openMoveTo, closeMenus, applyMarkToBlocks, openLink, pastedBlocks, adoptCutPages, offerCard, toast,
    openEquation: (request) => { if (!readOnly) setEquationEdit(request); },
    pickLinkedView: (blockId, stripped, pick) => {
      // The picker stands where the slash was typed; a block it cannot be
      // drawn beside is a pick that never happens — the link is not written.
      const anchor = anchorFor(blockId);
      if (anchor) setLinkedPick({ blockId, stripped, pick, anchor });
    },
  };
  const { uploads, pictureUploads, retries, fileInput, placeFiles, pickMedia, pickFile, pickPictureReplacement, onFileInputChange } = useMedia(editor);
  const typing = blockTyping({ ...editor, placeFiles, pickMedia });
  const { onBlockChange, chooseMention, onBlockPaste, nextEditable, runCommand } = typing;
  const { onBlockKeyDown, onBlockBeforeInput } = blockKeys({ ...editor, ...typing, latestTree });
  useSelectedBlockKeys({ ...editor, placeFiles });

  /** Follows a link — to a page, or to a block where it is now (found by its
   *  own id, so a block moved since it was linked is still found): beside the
   *  page, in the side peek, the way Notion opens a link. ⌘-click (Ctrl-click)
   *  opens it full-page instead — a block as a page of its own. */
  const followLink = useCallback((pageId: string, full: boolean | "split-right" = false) => {
    if (!pagesRef.current[pageId]) return;
    if (standaloneRef.current?.onFollowLink) {
      standaloneRef.current.onFollowLink(pageId, Boolean(full));
      return;
    }
    if (full === "split-right") openInRightSplit(pageId);
    else if (full) openInNewTab(pageId);
    else openPeek(pageId);
  }, [openInNewTab, openInRightSplit, openPeek]);

  /** Shows a page here, or folds it — on its row (`row`: a row in the tree
   *  drawn here, or a page drawn in place, whose row the drawing stands in
   *  for) or through a link in a line of words (`line` at `at`). Shown or
   *  folded, it is so for everyone who reads the page, so someone who may
   *  only read the page is told so instead. The one way anything is shown or
   *  folded: row marks, frame marks, link triangles, menus. */
  const setShown = useCallback((ref: ShownRef, shown: boolean) => {
    if (readOnly) {
      toast(VIEW_ONLY, "info");
      return;
    }
    if ("line" in ref) {
      const line = tree.by_id[ref.line];
      // Put away, a link forgets it was read only here: shown again, it reads first.
      if (line) execute(updateBlockContent(tree, line.id, updateMentionAt(line.content, ref.at, (mention) => (
        mention.kind === "page" ? { kind: "page", page_id: mention.page_id, ...(shown ? { expanded: true } : {}) } : mention
      ))));
      return;
    }
    const fold = (link: ShownLink): ShownLink => (shown ? { ...link, expanded: true } : { kind: "page", page_id: link.page_id });
    const drawn = tree.by_id[ref.row];
    if (drawn && lineLink(drawn)) {
      execute(updateBlockContent(tree, drawn.id, withLineLink(drawn, fold).content));
      return;
    }
    // A page drawn in place: the drawing stands where its line is, so the
    // line is written in the page that holds it.
    const live = workspace?.state.pages ?? pages;
    const holder = composite.owner.get(ref.row);
    const rowId = composite.rows.get(ref.row);
    const row = holder && rowId ? live[holder]?.block_tree?.by_id[rowId] : undefined;
    if (!platform || !holder || !row || Boolean(lineLink(row)?.expanded) === shown) return;
    const next: Block = withLineLink(row, fold);
    commitWrites([
      { type: "set", path: ["pages", holder, "block_tree", "by_id", row.id], value: next },
      { type: "set", path: ["pages", holder, "updated_at"], value: new Date().toISOString() },
      { type: "set", path: ["pages", holder, "updated_by"], value: platform.bootstrap.user.displayName },
    ]);
  }, [commitWrites, composite, execute, pages, platform, readOnly, toast, tree, workspace]);

  /** Read only here, or not, for a page shown here: on its row, or through
   *  a link. Everyone reads it so, so only someone who may change the page
   *  locks it. */
  const setLocked = useCallback((ref: ShownRef, locked: boolean) => {
    if (readOnly) {
      toast(VIEW_ONLY, "info");
      return;
    }
    if ("line" in ref) {
      const line = tree.by_id[ref.line];
      if (line) execute(updateBlockContent(tree, line.id, updateMentionAt(line.content, ref.at, (mention) => (
        mention.kind === "page" ? { ...mention, locked: locked || undefined } : mention
      ))));
      return;
    }
    const drawn = tree.by_id[ref.row];
    if (drawn && lineLink(drawn)) {
      execute(updateBlockContent(tree, drawn.id, withLineLink(drawn, (link) => ({ ...link, locked: locked || undefined })).content));
    }
  }, [execute, readOnly, toast, tree]);

  /** A link's place among its paragraph's words, from its token. */
  const linkAt = useCallback((token: HTMLElement): { block: Block; offset: number } | null => {
    const editable = token.closest<HTMLElement>(".block__editable");
    const blockId = editable?.closest<HTMLElement>("[data-block-id]")?.dataset.blockId;
    const block = blockId ? tree.by_id[blockId] : undefined;
    if (!editable || !block) return null;
    const range = document.createRange();
    range.selectNodeContents(editable);
    range.setEndBefore(token);
    return { block, offset: range.toString().length };
  }, [tree]);

  /* Every inline picture on this page in reading order — powers next/previous
     stepping in ImageViewer and keeps viewer actions synced after edits. */
  const pageImages = useMemo(() => {
    const list: Array<{ blockId: string; offset: number; mention: Extract<Mention, { kind: "image" }>; file: StoredFile }> = [];
    for (const { block } of rows) {
      if (block.kind === "code" || block.kind === "file") continue;
      let offset = 0;
      for (const run of block.content) {
        if (run.mention?.kind === "image") {
          list.push({ blockId: block.id, offset, mention: run.mention, file: run.mention.file });
        }
        offset += run.text.length;
      }
    }
    return list;
  }, [rows]);

  const [viewingTarget, setViewingTarget] = useState<{ blockId: string; offset: number } | null>(null);
  const [pictureMenu, setPictureMenu] = useState<{ blockId: string; offset: number; anchor: AnchorRect; inViewer?: boolean } | null>(null);

  const viewingIndex = useMemo(() => {
    if (!viewingTarget) return -1;
    return pageImages.findIndex((item) => item.blockId === viewingTarget.blockId && item.offset === viewingTarget.offset);
  }, [pageImages, viewingTarget]);
  const viewingEntry = viewingIndex >= 0 ? pageImages[viewingIndex] : null;

  const copyPicture = useCallback(async (file: StoredFile): Promise<boolean> => {
    if (!platform) return false;
    try {
      await copyStoredImage(platform.files, file);
      toast("图片已复制", "success");
      return true;
    } catch (error) {
      toast(error instanceof Error && error.message ? error.message : "复制图片失败，请尝试下载", "error");
      return false;
    }
  }, [platform, toast]);

  const downloadPicture = useCallback((file: StoredFile) => {
    if (!platform) return;
    void downloadFile(platform.files, file).catch(() => toast("Could not download that file", "error"));
  }, [platform, toast]);

  const resetPictureWidth = useCallback((blockId: string, offset: number) => {
    const block = tree.by_id[blockId];
    if (!block) return;
    execute(updateBlockContent(tree, block.id, updateMentionAt(block.content, offset, (mention) => (
      mention.kind === "image" ? { kind: "image", file: mention.file } : mention
    ))));
  }, [execute, tree]);

  const deletePicture = useCallback((blockId: string, offset: number) => {
    const block = tree.by_id[blockId];
    if (!block) return;
    const span = tokenSpan(block.content, offset);
    const without = replaceRange(block.content, offset, offset + span, "");
    const emptied = !inlinePlainText(without).trim() && !orderedBlocks(tree, block.id).length;
    if (emptied) execute(deleteBlocks(tree, [block.id], createId("block")));
    else execute(updateBlockContent(tree, block.id, without));
  }, [execute, tree]);

  /* The picture the pointer is on, for its tools: let go of a moment after
     the pointer leaves it, so the pointer can reach them. */
  const [pictureHover, setPictureHover] = useState<HTMLElement | null>(null);
  const leavingPicture = useRef(0);
  const holdPicture = useCallback((token: HTMLElement | null) => {
    window.clearTimeout(leavingPicture.current);
    if (token) setPictureHover(token);
    else leavingPicture.current = window.setTimeout(() => setPictureHover(null), 160);
  }, []);
  useEffect(() => {
    if (!pictureHover) return;
    // A page that scrolls takes the picture from under its tools.
    const away = () => setPictureHover(null);
    window.addEventListener("scroll", away, true);
    return () => window.removeEventListener("scroll", away, true);
  }, [pictureHover]);

  /* Pictures and inline equations among the words. */
  useInlineEquations(blocksRef);
  usePictures({
    hover: holdPicture,
    root: blocksRef,
    readOnly,
    uploads: pictureUploads,
    show: (file) => (platform ? showFile(platform.files, file, "page") : notShown()),
    resize: (token, picture, width) => {
      const link = linkAt(token);
      if (link) execute(updateBlockContent(tree, link.block.id, updateMentionAt(link.block.content, link.offset, () => ({ ...picture, width }))));
    },
    resetWidth: (token) => {
      const link = linkAt(token);
      if (link) resetPictureWidth(link.block.id, link.offset);
    },
    /* Out of its place and into where it lands, in one step of undo: among
       a line's words, or on a line of its own beside one. A line that keeps
       words as its own characters — code — or a file's caption takes none,
       and a line it leaves with nothing in it goes, unless lines are under
       it. */
    move: (token, picture, to) => {
      const from = linkAt(token);
      const target = tree.by_id[to.blockId];
      if (!from || !target) return;
      const span = tokenSpan(from.block.content, from.offset);
      const without = replaceRange(from.block.content, from.offset, from.offset + span, "");
      const emptied = !inlinePlainText(without).trim() && !orderedBlocks(tree, from.block.id).length;
      const leave = () => (emptied && from.block.id !== target.id
        ? deleteBlocks(tree, [from.block.id], createId("block"))
        : updateBlockContent(tree, from.block.id, without));
      if (to.kind === "words") {
        if (target.kind === "code" || target.kind === "file") return;
        if (from.block.id === target.id) {
          if (to.offset >= from.offset && to.offset <= from.offset + span) return;
          const at = to.offset > from.offset ? to.offset - span : to.offset;
          const placed = insertToken(without, at, at, picture);
          execute(updateBlockContent(tree, target.id, placed.content), { id: target.id, start: placed.caret, force: true });
          return;
        }
        const placed = insertToken(target.content, to.offset, to.offset, picture);
        const removed = leave();
        const added = updateBlockContent(tree, target.id, placed.content);
        if (removed && added) execute({ mutations: [...removed.mutations, ...added.mutations] }, { id: target.id, start: placed.caret, force: true });
        return;
      }
      // Already alone on its line, beside itself: nowhere new.
      if (emptied && from.block.id === target.id) return;
      const id = createId("block");
      const inserted = to.inside
        ? insertFirstChild(tree, target.id, id)
        : (to.edge === "before" ? insertBlockBefore : insertBlockAfter)(tree, target.id, id);
      const removed = leave();
      if (!inserted || !removed) return;
      const line = insertToken([], 0, 0, picture).content;
      const mutations = inserted.mutations.map((mutation) => (
        mutation.action === "put" && mutation.block.id === id ? { ...mutation, block: { ...mutation.block, content: line } } : mutation
      ));
      execute({ mutations: [...removed.mutations, ...mutations] }, { id, start: 1, force: true });
    },
  });

  /** A link's triangle pressed: its page shown under its line, or put away. */
  const toggleShownAt = useCallback((token: HTMLElement): boolean => {
    const link = linkAt(token);
    if (!link) return false;
    const mention = mentionAt(link.block.content, link.offset);
    setShown({ line: link.block.id, at: link.offset }, !(mention?.kind === "page" && mention.expanded));
    return true;
  }, [linkAt, setShown]);

  /** Takes a page shown here off this page — and only this page. A line
   *  that was nothing but the page goes with it; words around it stay. */
  const removeMount = useCallback((block: Block, offset: number) => {
    const words = replaceRange(block.content, offset, offset + 1, "");
    if (inlinePlainText(words).trim()) execute(updateBlockContent(tree, block.id, words));
    else execute(deleteBlocks(tree, [block.id], createId("block")));
  }, [execute, tree]);

  /** The links to a page from outside where it lives — the one count, the
   *  same wherever it is drawn: on its mark, in its backlinks, in the page
   *  list. A block is a page, and counts the same way. */
  const linksOf = useCallback((id: string): BlockReference[] => (
    outsideLinks(references, id, pages[id] ? homeOf(pages, id) : ownerOf(id))
  ), [ownerOf, pages, references]);

  /** What a page drawn here is called: as it is everywhere it is listed. */
  const nameOf = useCallback((id: string) => (
    pages[id] ? pageName(pages[id], describeMention) : "Untitled"
  ), [describeMention, pages]);

  /** Where a block drawn here is shown in other pages: each paragraph whose
   *  link to it is shown. */
  const mountsOf = useCallback((pageId: string): BlockReference[] => (references.get(pageId) ?? []).filter((reference) => {
    if (reference.pageId === ownerOf(pageId)) return false;
    if (!canMovePage(pageId, reference.pageId)) return false;
    const paragraph = pages[reference.pageId]?.block_tree?.by_id[reference.paragraphId];
    return Boolean(paragraph?.content.some((run) => run.mention?.kind === "page" && run.mention.page_id === pageId && run.mention.expanded));
  }), [canMovePage, ownerOf, pages, references]);

  /** Takes a block drawn here off this page while another page shows it: it
   *  goes to live there, standing on its own row where it was shown, so no
   *  page loses it — and every link to it still finds it. */
  const rehomeBlock = useCallback((blockId: string) => {
    const mount = mountsOf(blockId)[0];
    const target = mount ? pages[mount.pageId] : undefined;
    const paragraph = mount ? target?.block_tree?.by_id[mount.paragraphId] : undefined;
    if (!mount || !target?.block_tree || !paragraph) return;
    const shownLink = mountedLink(paragraph.content);
    const whole = shownLink?.kind === "page" && shownLink.page_id === blockId;
    const siblings = orderedBlocks(target.block_tree, paragraph.parent_id);
    const next = siblings[siblings.findIndex((block) => block.id === paragraph.id) + 1];
    const row = pageLine(createId("block"), blockId, {
      expanded: true,
      parent_id: paragraph.parent_id,
      order: whole ? paragraph.order : blockOrderBetween(target.block_tree, paragraph.parent_id, paragraph.id, next?.id),
    });
    const offset = paragraph.content.findIndex((run) => run.mention?.kind === "page" && run.mention.page_id === blockId);
    const at = paragraph.content.slice(0, Math.max(0, offset)).reduce((sum, run) => sum + run.text.length, 0);
    // The line that stood for it there was the block; words around its link
    // stay, the link folded to a plain link to the block below it.
    const mutations: BlockMutation[] = whole
      ? [{ action: "delete", blockId: paragraph.id }, { action: "put", block: row }]
      : [
        { action: "put", block: { ...paragraph, content: updateMentionAt(paragraph.content, at, (mention) => (
          mention.kind === "page" ? { kind: "page", page_id: mention.page_id } : mention
        )) } },
        { action: "put", block: row },
      ];
    execute(deleteBlocks(tree, [blockId], createId("block")), undefined, { cut: [blockId] });
    movePage(blockId, target.id);
    applyBlockMutations(target.id, mutations);
    toast(`Removed from this page — it stays in ${pageName(target)}`, "success");
  }, [applyBlockMutations, execute, mountsOf, movePage, pages, toast, tree]);

  /** Opens a page on one of its paragraphs — where a backlink was written:
   *  landed on here, when it is on screen here, or beside the page, in the
   *  side peek, landed on there. */
  const openParagraph = useCallback((reference: BlockReference) => {
    // On screen here: the page being read, or a block drawn in it.
    const onScreen = reference.pageId === here || (!embed && composite.sources.has(reference.pageId));
    requestLanding(onScreen ? here : reference.pageId, reference.paragraphId);
    if (onScreen) window.dispatchEvent(new Event(LAND_EVENT));
    else openPeek(reference.pageId);
  }, [composite, embed, here, openPeek]);

  /* A mention opens what it names, the way a link does — beside the page, in
     the side peek. A block is a page, and opens as one. */
  const openMentionedPage = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.shiftKey) return;
    /* A link opens where it goes, in a new tab, as in Notion — a browser
       follows no link clicked in words being edited. One to a page of this
       workspace ("#page") opens that page, as a mention does. A click that
       ends a drag was selecting words, not pressing the link. */
    const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>(".block__editable a[href]");
    if (anchor && anchor.closest(".blocks") === event.currentTarget) {
      if (window.getSelection()?.isCollapsed === false) return;
      event.preventDefault();
      followHref(anchor.getAttribute("href") ?? "", event.metaKey || event.ctrlKey, (href, full) => {
        const target = linkedPageId(href, pagesRef.current);
        if (target) followLink(target, event.altKey ? "split-right" : full);
      });
      return;
    }
    const token = (event.target as Element | null)?.closest<HTMLElement>(".mention[data-mention]");
    // A block shown in place has an editor of its own, which answers for it.
    if (!token || token.closest(".blocks") !== event.currentTarget) return;
    const pageId = token.dataset.page;
    const kind = token.dataset.mention;
    if (kind === "equation") {
      if (readOnly) return;
      const mention = mentionFromAttributes((name) => token.getAttribute(`data-${name}`) ?? undefined);
      const link = linkAt(token);
      if (mention?.kind === "equation" && link) {
        event.preventDefault();
        event.stopPropagation();
        setEquationEdit({
          mode: "inline",
          blockId: link.block.id,
          offset: link.offset,
          expression: mention.expression,
          anchor: rectOf(token),
        });
      }
      return;
    }
    // A picture opens to be looked at — or, when its upload failed, tries
    // it again.
    if (kind === "image") {
      const mention = mentionFromAttributes((name) => token.getAttribute(`data-${name}`) ?? undefined);
      if (mention?.kind !== "image") return;
      if (token.dataset.upload === "failed") {
        retries.current.get(mention.file.path)?.();
        return;
      }
      const link = linkAt(token);
      if (link) {
        setPictureHover(null);
        setViewingTarget({ blockId: link.block.id, offset: link.offset });
      }
      return;
    }
    // The mark before a link to a page shows it here, or folds it; the words
    // take you to it.
    if (kind === "page") {
      const bounds = token.getBoundingClientRect();
      const triangle = parseFloat(getComputedStyle(token).fontSize) * 1.15;
      // A line that is nothing but the link has its row's mark before it;
      // its name, all of it, opens what it names.
      if (!readOnly && !token.dataset.state && !token.closest(".is-link-line") && event.clientX - bounds.left <= triangle) {
        event.preventDefault();
        if (toggleShownAt(token)) return;
      }
    }
    if (!pageId || !pagesRef.current[pageId]) return;
    event.preventDefault();
    followLink(pageId, event.altKey ? "split-right" : (event.metaKey || event.ctrlKey));
  }, [followLink, linkAt, readOnly, retries, toggleShownAt]);

  /* Right-clicking an inline picture opens its dedicated context menu (copy,
     view, download, replace, reset size, align, delete) because inline images
     render as CSS-backed tokens rather than native <img> elements. */
  const onBlocksContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const token = (event.target as Element | null)?.closest<HTMLElement>('.mention[data-mention="image"]');
    if (!token || token.closest(".blocks") !== event.currentTarget) return;
    const link = linkAt(token);
    if (!link) return;
    event.preventDefault();
    event.stopPropagation();
    setPictureHover(null);
    setPictureMenu({ blockId: link.block.id, offset: link.offset, anchor: pointRect(event.clientX, event.clientY) });
  }, [linkAt]);

  /* Shift+click selects blocks: from the selected ones, or from the block that
     has the caret, to the one clicked. */
  const onBlocksMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!event.shiftKey || event.button !== 0 || readOnly) return;
    const target = event.target as Element;
    if (target.closest(".blocks") !== event.currentTarget) return;
    const clicked = target.closest<HTMLElement>("[data-block-id]")?.dataset.blockId;
    if (!clicked || target.closest(".page-frame__mark, .page-frame__refs")) return;
    const caretRow = document.activeElement?.closest<HTMLElement>(".blocks [data-block-id]");
    const from = blockSelection?.anchor ?? (caretRow && blocksRef.current?.contains(caretRow) ? caretRow.dataset.blockId : undefined);
    // Shift+click inside the block with the caret is the browser's: it grows
    // the text selection.
    if (!from || (from === clicked && !blockSelection)) return;
    event.preventDefault();
    selectBlocks(from, clicked);
  }, [blockSelection, readOnly, selectBlocks]);

  const clearBlockSelection = useCallback(() => setBlockSelection(null), []);
  const { marquee, marqueeStart, marqueeDragged, beginMarquee } = useMarquee({
    readOnly,
    articleRef,
    blocksRef,
    selectBlocks,
    clearSelection: clearBlockSelection,
  });

  /* Asked to land on a paragraph or a block — a backlink, "Open in" a block's
     page — the page scrolls to it and it flashes, the way Notion lands you on
     one. A block folded away is its row there, so that is where it lands. */
  useEffect(() => {
    if (embed) return;
    const drawnAs = (id: string): string | null => {
      if (tree.by_id[id]) return id;
      const row = Object.values(tree.by_id).find((block) => lineLink(block)?.page_id === id);
      return row?.id ?? null;
    };
    const land = () => {
      const asked = takeLanding(page.id, (id) => drawnAs(id) !== null);
      const blockId = asked ? drawnAs(asked) : null;
      if (!blockId) return;
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        const container = blocksRef.current;
        const findRow = () => rowsWithin(container).find((item) => item.dataset.blockId === blockId)
          ?? container?.querySelector<HTMLElement>(`[data-frame-of="${CSS.escape(blockId)}"]`);
        let row = findRow();
        if (!row && progressiveRef.current.hasMore) {
          ensureAllRendered();
          row = findRow();
        }
        if (!row) return;
        row.scrollIntoView({ block: row.offsetHeight > window.innerHeight / 2 ? "start" : "center" });
        // A timer, not animationend: with reduced motion the flash is a
        // steady tint that never animates, and it still has to go.
        row.classList.add("is-flash");
        window.setTimeout(() => row.classList.remove("is-flash"), 1800);
      }));
    };
    land();
    window.addEventListener(LAND_EVENT, land);
    return () => window.removeEventListener(LAND_EVENT, land);
  }, [embed, page.id, tree]);

  /* Undo and redo close the menus opened on the text as it was: a slash menu
     left open over text that undo took away would strip the wrong letters. */
  useEffect(() => {
    window.addEventListener(HISTORY_REPLAY_EVENT, closeMenus);
    return () => window.removeEventListener(HISTORY_REPLAY_EVENT, closeMenus);
  }, [closeMenus]);

  /* Undo puts a block selection back the way it puts a caret back. */
  useEffect(() => {
    const root = blocksRef.current;
    if (!root || readOnly) return;
    const onSelect = (event: Event) => {
      const ids = event instanceof CustomEvent && Array.isArray(event.detail)
        ? event.detail.filter((id): id is string => typeof id === "string")
        : [];
      const last = ids.at(-1);
      if (ids[0] && last) setBlockSelection({ anchor: ids[0], focus: last });
    };
    root.addEventListener(SELECT_BLOCK_EVENT, onSelect);
    return () => root.removeEventListener(SELECT_BLOCK_EVENT, onSelect);
  }, [readOnly]);

  /* ── Blocks: paragraphs grouped by hand ────────────────────────────── */

  /** Draws the eye to a block for a moment, once it is drawn. */
  const flashFrame = useCallback((id: string) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const frame = blocksRef.current?.querySelector<HTMLElement>(`[data-frame-of="${CSS.escape(id)}"]`);
      if (!frame) return;
      frame.classList.add("is-flash");
      window.setTimeout(() => frame.classList.remove("is-flash"), 1800);
    }));
  }, []);

  /** Groups the paragraphs `ids` touch into a block and says which block it
   *  is — the one they already are, when they are exactly one. Text that was
   *  selected across them stays selected. */
  const makeBlock = useCallback((ids: readonly string[], ranges?: BlockTextRange[]): string | null => {
    const result = pageFromBlocks(tree, ids, createId("page"));
    if (!result) return null;
    if (result.transaction) {
      if (ranges?.length) pendingTextSelection.current = { ranges, forceIds: [] };
      execute(result.transaction);
    }
    flashFrame(result.pageId);
    return result.pageId;
  }, [execute, flashFrame, tree]);

  const copyPageLink = useCopyPageLink();

  /** A block's grip picks the whole block up; the block itself is what the
   *  pointer carries. */
  const startFrameDrag = useCallback((id: string, event: DragEvent<HTMLButtonElement>) => {
    const frame = event.currentTarget.closest<HTMLElement>(".page-frame");
    if (frame) event.dataTransfer.setDragImage(frame, 12, 12);
    event.dataTransfer.effectAllowed = "move";
    setBlockSelection(null);
    setDragIds([id]);
  }, []);

  const endDrag = useCallback(() => {
    setDragIds(null);
    setDrop(null);
  }, []);

  /** A table moved by its handle, as a block is by its own. */
  // A line's handle dragged carries the line — or, the line being one of
  // several selected, all of them.
  const startRowDrag = useCallback((block: Block, event: DragEvent<HTMLButtonElement>) => {
    const row = event.currentTarget.closest<HTMLElement>(".block");
    if (row) event.dataTransfer.setDragImage(row, 12, 12);
    event.dataTransfer.effectAllowed = "move";
    const selected = moveContext.current.selectedIds;
    setBlockSelection(null);
    setDragIds(selected.includes(block.id) && selected.length > 1 ? [...selected] : [block.id]);
  }, []);

  /* ── Drag and drop ──────────────────────────────────────────────────── */

  /* Selected blocks are picked up by any of them and carried together, as
     Notion's are — carried as a picture is (carry.ts): the lines wait faded
     where they are, a copy of the first is held where it was picked up, and
     a line between lines marks where they would land. A press that does not
     move is a click into the block. (A link to a page, on its own line or
     among words, is carried by its own press: pictures.ts.) Pointer events,
     not the browser's drag: a press inside a block's words is the browser's
     text selection. */
  const blockMove = useRef<{ x: number; y: number } | null>(null);
  const beginBlockMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as Element | null;
    const row = target?.closest<HTMLElement>("[data-block-id]");
    const id = row?.dataset.blockId ?? "";
    if (readOnly || event.button !== 0 || event.shiftKey || !row || row.closest(".blocks") !== blocksRef.current) return;
    if (!selectedSet.has(id)) return;
    blockMove.current = { x: event.clientX, y: event.clientY };
  };
  const moveContext = useRef({ tree, selectedIds, blockSelection, executeOnBlocks, selectBlocks });
  useLayoutEffect(() => {
    moveContext.current = { tree, selectedIds, blockSelection, executeOnBlocks, selectBlocks };
  });
  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const gesture = blockMove.current;
      const root = blocksRef.current;
      if (!gesture || !root || !(event.buttons & 1)) return;
      if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 4) return;
      blockMove.current = null;
      event.preventDefault();
      const { tree: current, selectedIds, blockSelection: selection, selectBlocks: select } = moveContext.current;
      const ids = [...selectedIds];
      // What moves is selected, and keeps the keys: a press in a block's
      // words put a caret there.
      if (selection) select(selection.anchor, selection.focus);
      const carried = new Set(ids.flatMap((id) => [id, ...descendantsOf(current, id).map((block) => block.id)]));
      const rows = rowsWithin(root).filter((row) => carried.has(row.dataset.blockId ?? ""));
      const first = rows[0]?.querySelector<HTMLElement>(":scope > :is(.block__content, .mount, .db-frame)");
      if (!first) return;
      carry({
        root,
        grab: { x: gesture.x, y: gesture.y },
        carried: rows,
        width: Math.min(first.getBoundingClientRect().width, 420),
        draw: (copy) => {
          copy.classList.add("carry-copy--lines");
          const shown = first.cloneNode(true) as HTMLElement;
          shown.querySelectorAll("[contenteditable]").forEach((node) => node.removeAttribute("contenteditable"));
          copy.append(shown);
          const more = ids.length - 1;
          if (more > 0) {
            const count = copy.ownerDocument.createElement("span");
            count.className = "carry-copy__count";
            count.textContent = `+${more}`;
            copy.append(count);
          }
        },
        spotAt: (x, y) => {
          const row = rowNear(root, y, (candidate) => "carried" in candidate.dataset);
          const target = row ? moveContext.current.tree.by_id[row.dataset.blockId ?? ""] : undefined;
          if (!row || !target || carried.has(target.id)) return null;
          const edge = dropEdge(target, row.getBoundingClientRect(), x, y);
          return { kind: "line", blockId: target.id, edge: edge === "above" ? "before" : "after", ...(edge === "inside" ? { inside: true } : {}) };
        },
        land: (spot) => {
          if (spot.kind !== "line") return;
          const { tree: now, executeOnBlocks: run } = moveContext.current;
          run(moveBlocks(now, ids, { id: spot.blockId, edge: spot.edge === "before" ? "above" : spot.inside ? "inside" : "below" }));
        },
      }, event);
    };
    const finish = () => {
      blockMove.current = null;
    };
    document.addEventListener("mousemove", onMove, { passive: false });
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
    };
  }, []);

  /* Files from the desktop land as a carried picture does (drop-spot.ts):
     pictures among the words or on a line of their own, any other file on a
     line of its own — where they would land marked as they move. */
  const fileSpot = useRef<Spot | null>(null);
  const overFiles = useCallback((event: DragEvent<HTMLElement>) => {
    const root = blocksRef.current;
    if (readOnly || !root || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    const items = [...event.dataTransfer.items].filter((item) => item.kind === "file");
    const pictures = items.length > 0 && items.every((item) => isImageType(item.type));
    const spot = landingAt(root, event.clientX, event.clientY, pictures);
    if (sameSpot(spot, fileSpot.current)) return;
    fileSpot.current = spot;
    showMarker(root, spot);
  }, [readOnly]);
  const leaveFiles = useCallback(() => {
    fileSpot.current = null;
    if (blocksRef.current) hideMarker(blocksRef.current);
  }, []);

  const onDragOver = useCallback((target: Block, event: DragEvent<HTMLDivElement>) => {
    if (!dragIds) {
      overFiles(event);
      return;
    }
    if (dragging.has(target.id)) return;
    event.preventDefault();
    setDrop({ id: target.id, edge: dropEdge(target, event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY) });
  }, [dragIds, dragging, overFiles]);

  /* A drag carries the selected blocks when it starts on one of them, all
     together; otherwise the one block whose handle was taken. */
  const onDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const moving = dragIds;
    const target = drop;
    setDragIds(null);
    setDrop(null);
    if (!moving) {
      const files = [...event.dataTransfer.files];
      const spot = fileSpot.current;
      leaveFiles();
      if (!spot || !files.length) return;
      void placeFiles(files, spot.kind === "words"
        ? { kind: "words", blockId: spot.blockId, start: spot.offset, end: spot.offset }
        : { kind: "line", blockId: spot.blockId, edge: spot.edge, ...(spot.inside ? { inside: true } : {}) });
      return;
    }
    if (!target) return;
    executeOnBlocks(moveBlocks(tree, moving, target));
  }, [dragIds, drop, executeOnBlocks, leaveFiles, placeFiles, tree]);

  /* ── What rows ask of the editor ───────────────────────────────────── */

  /* Every row gets the same actions object for the editor's whole life, so a
     row whose block did not change is not rendered again on each keystroke;
     each call reaches the editor as it is now, through a ref set after every
     render (events never fall between a render and its commit). */
  /* A table's cells, rows, columns and headers are written where they are
     kept — a row on its own path, so two people typing in two rows both keep
     their words — in the page holding the table. A change that would take
     the table past its budget is refused, and the reader told. */
  const writeTable = useCallback((block: Block, writes: readonly TableWrite[]): boolean => {
    if (readOnly || !writes.length) return false;
    if (standaloneRef.current) {
      const current = latestTree.current;
      const stored = current.by_id[block.id];
      if (stored?.kind !== "table") return false;
      const before = stored.table ?? normalizeSimpleTable(undefined);
      const afterTable = applyTableWrites(before, writes);
      const size = tableBytes(afterTable);
      if (size > TABLE_BYTE_BUDGET && size > tableBytes(before)) {
        toast("This table is full — turn it into a database to keep adding to it.", "error");
        return false;
      }
      const nextTree: BlockTree = {
        by_id: {
          ...current.by_id,
          [block.id]: { ...stored, table: afterTable },
        },
      };
      standaloneUndoRef.current.push(current);
      if (standaloneUndoRef.current.length > 40) standaloneUndoRef.current.shift();
      standaloneRedoRef.current = [];
      latestTree.current = nextTree;
      standaloneRef.current.onTreeChange(nextTree);
      return true;
    }
    if (!platform) return false;
    const live = workspace?.state.pages ?? pages;
    const owner = ownerOf(block.id);
    const stored = live[owner]?.block_tree?.by_id[block.id];
    if (stored?.kind !== "table") return false;
    const before = stored.table ?? normalizeSimpleTable(undefined);
    const afterTable = applyTableWrites(before, writes);
    const size = tableBytes(afterTable);
    if (size > TABLE_BYTE_BUDGET && size > tableBytes(before)) {
      toast("This table is full — turn it into a database to keep adding to it.", "error");
      return false;
    }
    const removedTableRows = writes
      .filter((item): item is Extract<TableWrite, { kind: "row" }> => item.kind === "row" && !item.row)
      .map((item) => item.rowId);
    const afterColIds = new Set(afterTable.columns.map((col) => col.id));
    const removedTableColumns = before.columns
      .map((col) => col.id)
      .filter((colId) => !afterColIds.has(colId));
    if ((removedTableRows.length || removedTableColumns.length) && commitPageOps(owner, [{
      op: {
        type: "set_block_fields",
        blockId: block.id,
        patch: { table: storedTable(afterTable) },
        ...(removedTableRows.length ? { removedTableRows } : {}),
        ...(removedTableColumns.length ? { removedTableColumns } : {}),
      },
    }])) {
      return true;
    }
    const base = ["pages", owner, "block_tree", "by_id", block.id, "table"];
    const mutations: WorkspaceMutation[] = writes.map((item): WorkspaceMutation => {
      if (item.kind === "row") {
        return item.row ? { type: "set", path: [...base, "rows", item.rowId], value: item.row } : { type: "delete", path: [...base, "rows", item.rowId] };
      }
      if (item.kind === "columns") return { type: "set", path: [...base, "columns"], value: item.columns };
      if (item.kind === "spans") return item.spans.length ? { type: "set", path: [...base, "spans"], value: item.spans } : { type: "delete", path: [...base, "spans"] };
      if (item.kind === "aligns") return Object.keys(item.aligns).length ? { type: "set", path: [...base, "aligns"], value: item.aligns } : { type: "delete", path: [...base, "aligns"] };
      if (item.kind === "colors") return Object.keys(item.colors).length ? { type: "set", path: [...base, "colors"], value: item.colors } : { type: "delete", path: [...base, "colors"] };
      return item.on ? { type: "set", path: [...base, item.which], value: true } : { type: "delete", path: [...base, item.which] };
    });
    commitWrites([
      ...mutations,
      { type: "set", path: ["pages", owner, "updated_at"], value: new Date().toISOString() },
      { type: "set", path: ["pages", owner, "updated_by"], value: platform.bootstrap.user.displayName },
    ]);
    return true;
  }, [commitPageOps, commitWrites, ownerOf, pages, platform, readOnly, toast, workspace]);

  const rowHandlers = useRef<Omit<BlockActions, "describeMention"> | null>(null);
  useLayoutEffect(() => {
    rowHandlers.current = {
      /* Notion's "+": an empty line takes the menu itself; any other gets a
         new line — below, or above with Alt — holding the "/" that opens it,
         so what is typed next narrows the menu as it would after a "/". */
      add: (block, anchor, above) => {
        const opened: InlineContent = [{ text: "/" }];
        let id = block.id;
        if (block.kind === "text" && !inlinePlainText(block.content)) {
          execute(updateBlockContent(tree, block.id, opened), { id, start: 1, force: true });
        } else {
          id = createId("block");
          const inserted = (above ? insertBlockBefore : insertBlockAfter)(tree, block.id, id);
          if (!inserted) return;
          execute({
            ...inserted,
            mutations: inserted.mutations.map((mutation) => (
              mutation.action === "put" && mutation.block.id === id ? { ...mutation, block: { ...mutation.block, content: opened } } : mutation
            )),
          }, { id, start: 1, force: true });
        }
        setSlash({ blockId: id, from: 0, query: "", anchor });
        setSlashIndex(0);
        // The menu hangs under the line it opened on — as after a typed "/" —
        // so what is typed into it is seen; placed once that line is drawn.
        requestAnimationFrame(() => {
          const line = editableWithin(blocksRef.current, id);
          if (line) setSlash((current) => (current?.blockId === id ? { ...current, anchor: rectOf(line) } : current));
        });
      },
      dragOver: onDragOver,
      drop: onDrop,
      toggleCheck: (block) => execute(updateBlockFields(tree, block.id, { checked: !block.checked })),
      openBacklinks: (pageId, anchor) => setBacklinksFor({ id: pageId, anchor }),
      toggleLink: (block) => setShown({ line: block.id, at: soleLinkOffset(block.content) }, !soleLink(block.content)?.expanded),
      openLinkMenu: (block, anchor) => setPageMenu({ from: "link", blockId: block.id, anchor }),
      rowDragStart: startRowDrag,
      rowDragEnd: endDrag,
      // A line's handle pressed: its menu — or, the line being one of
      // several selected, theirs, as Notion's ⋮⋮ does.
      openBlockMenu: (block, anchor) => {
        if (selectedSet.has(block.id) && selectedIds.length > 1) {
          setBlockMenu({ ids: [...selectedIds], anchor });
          return;
        }
        selectBlocks(block.id);
        setBlockMenu({ ids: [block.id], anchor });
      },
      openLinkedPage: (pageId, full) => followLink(pageId, full),
      setLanguage: (block, language) => {
        rememberCodeLanguage(language);
        execute(updateBlockFields(tree, block.id, { language }));
      },
      copyCode: (block) => {
        void copyText(inlinePlainText(block.content))
          .then(() => toast("Code copied", "success"))
          .catch(() => toast("Could not copy that code", "error"));
      },
      editEquation: (block, anchor) => {
        if (readOnly) return;
        setEquationEdit({
          mode: "block",
          blockId: block.id,
          expression: inlinePlainText(block.content),
          anchor,
        });
      },
      change: onBlockChange,
      keyDown: onBlockKeyDown,
      beforeInput: onBlockBeforeInput,
      paste: onBlockPaste,
      pickIcon: (block, anchor) => setPicker({ kind: "callout", blockId: block.id, anchor }),
      showFile: (file, which) => (platform ? showFile(platform.files, file, which) : notShown()),
      pickFile,
      downloadFile: (block) => {
        const file = normalizeStoredFile(block.file);
        if (!file || !platform) return;
        void downloadFile(platform.files, file).catch(() => toast("Could not download that file", "error"));
      },
      resizeCard: (block, width) => execute(updateBlockFields(tree, block.id, { width })),
      retryUpload: (block) => retries.current.get(block.id)?.(),
      writeTable,
      /* Out of a table's first row upward, or its last downward: the line
         there takes the caret — past the table's end with nothing after it,
         a new one. */
      leaveTable: (block, direction, x) => {
        caretX.current = x;
        const next = nextEditable(block.id, direction);
        if (next) {
          placeCaretNear(next, x, direction === 1 ? "top" : "bottom");
          return;
        }
        if (direction === 1 && !readOnly) {
          const id = createId("block");
          execute(insertBlockAfter(tree, block.id, id), { id, start: 0, force: true });
          return;
        }
        embed?.mount?.caretOut(direction, x);
      },
      selectTable: (block) => selectBlocks(block.id),
      /* A card's words, read from its provider once and kept on the card as
         bookkeeping — never a step of undo — unless the card has moved on
         meanwhile: deleted, undone, pointed elsewhere, read already. */
      readEmbed: (block) => {
        const embed = normalizeEmbed(block.embed);
        if (!embed || embed.read || readOnly) return;
        void readEmbedDetails(embed).then((found) => {
          const live = workspace?.state.pages;
          if (!found || !live) return;
          const current = composeTree(live, live[page.id] ?? page, showInPlace).tree.by_id[block.id];
          const now = normalizeEmbed(current?.embed);
          if (!current || current.kind !== "embed" || now?.url !== embed.url || now.read) return;
          write({ mutations: [{ action: "put", block: { ...current, embed: found } }] }, { record: false });
        });
      },
    };
  });
  const actions = useMemo<BlockActions>(() => ({
    ...forwarded(rowHandlers, ROW_ACTIONS),
    showFile: (file, which) => rowHandlers.current?.showFile(file, which) ?? notShown(),
    writeTable: (block, writes) => rowHandlers.current?.writeTable(block, writes) ?? false,
    describeMention,
  }), [describeMention]);

  /* ── Page head ──────────────────────────────────────────────────────── */

  const cover = useMemo(() => pageCover({ cover: page.cover, cover_image: page.cover_image }), [page.cover, page.cover_image]);
  const titleContent = useMemo(() => pageTitleContent({ title: page.title, title_content: page.title_content }), [page.title, page.title_content]);
  const icon = useMemo(() => pageIcon({ icon: page.icon, icon_image: page.icon_image }), [page.icon, page.icon_image]);
  const font = pageFont(page);
  /* A cover from the member's computer is drawn at once from the bytes in
     hand and saved behind them, as an image block is; its smaller copy, once
     made, is swapped in as bookkeeping (`settleCover`). One that cannot be
     saved is taken back out, and the reader told. */
  const uploadCover = useCallback(async (source: File) => {
    if (!platform || readOnly) return;
    if (!isImageType(source.type)) {
      toast("A cover is a picture — PNG, JPEG, GIF or WebP.", "error");
      return;
    }
    const refusal = refuseFiles([source]);
    if (refusal) {
      toast(refusal, "error");
      return;
    }
    const pageId = page.id;
    const before = { cover: page.cover, cover_image: page.cover_image };
    let staged: StagedFile;
    try {
      staged = await stageFile(platform.files, source, { pageId, owner: platform.bootstrap.user.id, space: spaceOfPage(pages, pageId) });
    } catch {
      toast("Could not read that picture", "error");
      return;
    }
    updatePage(pageId, { cover_image: staged.file, cover: undefined });
    try {
      const stored = await staged.transfer();
      if (stored.preview) settleCover({ document: workspace, commitWrites }, pageId, staged.file.path, stored);
    } catch {
      const current = workspace?.state.pages[pageId];
      if (current && normalizeStoredFile(current.cover_image)?.path === staged.file.path) {
        commitWrites((["cover", "cover_image"] as const).map((key) => (before[key] === undefined
          ? { type: "delete" as const, path: ["pages", pageId, key] }
          : { type: "set" as const, path: ["pages", pageId, key], value: before[key] })), false);
      }
      toast("Could not upload that picture", "error");
    }
  }, [commitWrites, page.cover, page.cover_image, page.id, pages, platform, readOnly, toast, updatePage, workspace]);

  /* An icon from the member's computer: the picture is drawn at once from
     the bytes in hand and saved behind them, as a cover is; its smaller
     copy, once made, is swapped in as bookkeeping. One that cannot be saved
     is taken back out, and the reader told. */
  const uploadIcon = useCallback(async (source: File, pageId: string) => {
    if (!platform || readOnly) return;
    if (!isImageType(source.type)) {
      toast("An icon is a picture — PNG, JPEG, GIF or WebP.", "error");
      return;
    }
    const refusal = refuseFiles([source]);
    if (refusal) {
      toast(refusal, "error");
      return;
    }
    const before = { icon: pages[pageId]?.icon, icon_image: pages[pageId]?.icon_image };
    let staged: StagedFile;
    try {
      staged = await stageFile(platform.files, source, { pageId, owner: platform.bootstrap.user.id, space: spaceOfPage(pages, pageId) });
    } catch {
      toast("Could not read that picture", "error");
      return;
    }
    updatePage(pageId, { icon_image: staged.file });
    try {
      const stored = await staged.transfer();
      if (stored.preview) settleIcon({ document: workspace, commitWrites }, pageId, staged.file.path, stored);
      rememberIconFile(platform.bootstrap.user.id, stored);
    } catch {
      const current = workspace?.state.pages[pageId];
      if (current && normalizeStoredFile(current.icon_image)?.path === staged.file.path) {
        commitWrites((["icon", "icon_image"] as const).map((key) => (before[key] === undefined
          ? { type: "delete" as const, path: ["pages", pageId, key] }
          : { type: "set" as const, path: ["pages", pageId, key], value: before[key] })), false);
      }
      toast("Could not upload that picture", "error");
    }
  }, [commitWrites, pages, platform, readOnly, toast, updatePage, workspace]);

  // A cover or icon uploaded before the page was shared moves to where its
  // readers can reach it — the page's own editor sees to it, never a page
  // shown here.
  useHomedCovers(embed || readOnly || standalone ? [] : [page], spaceOfPage(pages, page.id));
  useHomedIcons(embed || readOnly || standalone ? [] : [page], spaceOfPage(pages, page.id));

  // What the words here are set in: this page's font — or, shown inside
  // another page, that page's, which sets the font for everything it shows.
  const setIn = embed ? pageFont(pages[embed.topPageId] ?? page) : font;
  // The Chinese families are large, so each waits for a page that needs it:
  // Serif's Ming for words set in Serif, Kai for Chinese in an italic run.
  const cjkItalic = useMemo(() => Object.values(tree.by_id).some((block) => hasCjkItalic(block.content)), [tree]);
  useEffect(() => loadPageFonts(setIn, cjkItalic), [cjkItalic, setIn]);

  const appendBlock = useCallback(() => {
    if (readOnly) return;
    if (progressiveRef.current.hasMore) ensureAllRendered();
    const last = rows.at(-1);
    if (!last) return;
    if (last.block.kind === "text" && !inlinePlainText(last.block.content)) {
      const element = editableWithin(blocksRef.current, last.block.id);
      if (element) focusAtEnd(element);
      return;
    }
    const end = orderedBlocks(tree).at(-1) ?? last.block;
    execute(insertBlockAfter(tree, end.id, createId("block")));
  }, [ensureAllRendered, execute, readOnly, rows, tree]);

  /* A page or block shown in this page from another is drawn exactly as it
     is there — a block with its line, grip and count, a page as the block it
     is, with its title over its words — at this page's measure and in this
     page's font, by an editor of its own. What is on screen already (a page
     shown whole, or a block in one), or open around this one, is never shown
     again. */
  const mountHandle = (row: Block, options: {
    locked: boolean;
    whole: boolean;
    removable: boolean;
    toggleLock(): void;
    showAsLink(): void;
    removeHere(): void;
  }): MountHandle => ({
    locked: options.locked,
    canChange: !readOnly,
    movable: !readOnly && options.whole,
    removable: options.removable,
    toggleLock: options.toggleLock,
    showAsLink: options.showAsLink,
    removeHere: options.removeHere,
    dragStart: (event) => {
      const element = rowsWithin(blocksRef.current).find((item) => item.dataset.blockId === row.id);
      if (element) event.dataTransfer.setDragImage(element, 12, 12);
      event.dataTransfer.effectAllowed = "move";
      setBlockSelection(null);
      setDragIds([row.id]);
    },
    dragEnd: endDrag,
    stepOut: () => execute(insertBlockAfter(tree, row.id, createId("block"))),
    caretOut: (direction, x) => {
      const next = nextEditable(row.id, direction);
      if (!next) return false;
      placeCaretNear(next, x, direction === 1 ? "top" : "bottom");
      return true;
    },
  });

  const mountFrame = (key: string, content: ReactNode) => (
    <div
      key={key}
      className="mount"
      // Its own editor answers for everything inside; nothing reaches this one.
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onCopy={(event) => event.stopPropagation()}
      onCut={(event) => event.stopPropagation()}
      onDragStart={(event) => event.stopPropagation()}
      onDragOver={(event) => event.stopPropagation()}
      onDrop={(event) => event.stopPropagation()}
    >
      {content}
    </div>
  );

  /* A database shown in a page — a sub-page's row or a link, shown — is
     drawn as a page shown in place is: its mark and count at the start of
     its title, and under its title its views, live, one step in. Its mark
     folds it back into its row or link, for everyone.

     A link that pins a view draws a linked view instead: a caption in the
     title's place names what it is and which view it is, and the database
     is read-only inside — the caption's Open is the way out to it. */
  const renderDatabase = (key: string, target: NotePage, handle: MountHandle, pinnedViewId?: string): ReactNode => {
    const pinnedView = pinnedViewId ? target.database?.views.find((item) => item.id === pinnedViewId) : undefined;
    const caption = pinnedViewId ? (
      <span className="block-cap">
        <Link2 size={13} aria-hidden="true" />
        <span className="block-cap__text">
          Linked to {pageName(target) || "Untitled"}
          {pinnedView ? <> · {pinnedView.name || viewKindLabel(pinnedView.kind)}</> : null}
        </span>
        <button
          type="button"
          className="block-cap__open"
          onClick={() => selectPage(target.id)}
        >
          Open
        </button>
      </span>
    ) : undefined;
    return (
      <div key={key} className="db-frame">
        <PageFrame
          pageId={target.id}
          name={pageName(target)}
          title={caption}
          depth={0}
          readOnly={!handle.movable}
          locked={handle.locked}
          menuOpen={pageMenu?.from === "database" && pageMenu.key === key}
          dragging={false}
          references={linksOf(target.id).length}
          onMenu={(anchor) => setPageMenu({ from: "database", key, pageId: target.id, anchor, mount: handle })}
          onDragStart={handle.dragStart}
          onDragEnd={handle.dragEnd}
          onReferences={(anchor) => setBacklinksFor({ id: target.id, anchor })}
          mark={target.icon ? <span className="page-frame__mark-emoji">{target.icon}</span> : <DatabaseIcon size={16} />}
          headKind="database"
          onToggle={handle.showAsLink}
        >
          <InlineDatabase
            databaseId={target.id}
            readOnly={historical || handle.locked || !canEdit(target.id)}
            historical={historical}
            pinnedViewId={pinnedViewId}
          />
        </PageFrame>
      </div>
    );
  };

  /* An app shown in a page is its run surface, not a page's words: the same
   *  surface its own page gives it, framed as a database is. Unscripted
   *  HTML renders on sight; a scripted app waits for the member to run it. */
  const renderApp = (key: string, target: NotePage, handle: MountHandle): ReactNode => (
    <div key={key} className="db-frame">
      <PageFrame
        pageId={target.id}
        name={pageName(target)}
        depth={0}
        readOnly={!handle.movable}
        locked={handle.locked}
        menuOpen={pageMenu?.from === "app" && pageMenu.key === key}
        dragging={false}
        references={linksOf(target.id).length}
        onMenu={(anchor) => setPageMenu({ from: "app", key, pageId: target.id, anchor, mount: handle })}
        onDragStart={handle.dragStart}
        onDragEnd={handle.dragEnd}
        onReferences={(anchor) => setBacklinksFor({ id: target.id, anchor })}
        mark={target.icon ? <span className="page-frame__mark-emoji">{target.icon}</span> : <AppWindow size={16} />}
        headKind="app"
        onToggle={handle.showAsLink}
      >
        <AppSurface page={target} embedded onOpen={() => selectPage(target.id)} />
      </PageFrame>
    </div>
  );

  const renderPage = (key: string, target: NotePage, handle: MountHandle, pinnedViewId?: string): ReactNode => {
    if (target.id === here) return null;
    // A database is drawn as the database it is, never as a page's words.
    if (target.kind === "database") return renderDatabase(key, target, handle, pinnedViewId);
    if (target.kind === "app") return renderApp(key, target, handle);
    if (shownPages.includes(target.id)) return <p key={key} className="mount-note" role="note">This page is shown above.</p>;
    return mountFrame(key, (
      <DocumentEditor
        page={target}
        readOnly={historical || handle.locked || !canEdit(target.id)}
        historical={historical}
        embed={{ topPageId: here, shownPages, mount: handle }}
        surfaceContainer={surfaceContainer}
      />
    ));
  };

  const renderMount = (block: Block, link: ShownLink, at: number, whole: boolean): ReactNode => {
    const handle = mountHandle(block, {
      locked: Boolean(link.locked),
      whole,
      removable: true,
      toggleLock: () => setLocked({ line: block.id, at }, !link.locked),
      showAsLink: () => setShown({ line: block.id, at }, false),
      removeHere: () => removeMount(block, at),
    });
    const target = pages[link.page_id];
    const shown = Boolean(target && !target.archived && !isPurging(pages, target.id) && (inTrash(pages, page.id) || !inTrash(pages, target.id)));
    return shown && target ? renderPage(`${link.page_id}:${at}`, target, handle, link.view) : null;
  };

  /* A paragraph that is nothing but a shown link IS the page or block, in its
     place. One with words around its links keeps its line, and each thing it
     shows follows under it. */
  const renderMounts = (block: Block): { replace?: ReactNode; after?: ReactNode } => {
    if (!block.content.some((run) => run.mention?.kind === "page" && run.mention.expanded)) return {};
    const whole = mountedLink(block.content);
    if (whole) {
      const at = block.content.findIndex((run) => run.mention);
      const offset = block.content.slice(0, at).reduce((sum, run) => sum + run.text.length, 0);
      const drawn = renderMount(block, whole, offset, true);
      if (drawn) return { replace: drawn };
    }
    const mounts: ReactNode[] = [];
    let offset = 0;
    for (const run of block.content) {
      const at = offset;
      offset += run.text.length;
      if (run.mention?.kind !== "page" || !run.mention.expanded) continue;
      const drawn = renderMount(block, run.mention, at, false);
      if (drawn) mounts.push(drawn);
    }
    return mounts.length ? { after: <div className="mounts">{mounts}</div> } : {};
  };

  /* A line that is nothing but a link, folded, is drawn as the row of the
     page it links — a block is a page: its mark and count at the start of
     the line, its name after them. Read against the workspace as it is this
     render. */
  const linkLineOf = (block: Block): LinkLine | undefined => {
    if (block.kind !== "text") return undefined;
    const link = soleLink(block.content);
    if (!link || link.expanded) return undefined;
    const view = mentionDescriber(() => pages, undefined, shownPages)(link);
    const target = link.page_id;
    return {
      target,
      label: view.label,
      mark: view.icon || (view.glyph === "database" ? <DatabaseIcon size={16} /> : view.glyph === "app" ? <AppWindow size={16} /> : <PageIcon size={16} />),
      count: view.state === "missing" ? 0 : linksOf(target).length,
      still: Boolean(view.state),
    };
  };

  const renderRow = (row: Rendered, lineMarks: number, frames: number) => (
    <BlockRow
      key={row.block.id}
      {...renderMounts(row.block)}
      block={row.block}
      owningPageId={historical || standalone ? undefined : ownerOf(row.block.id)}
      depth={row.depth}
      index={row.index}
      lineMarks={lineMarks}
      frames={frames}
      readOnly={readOnly}
      selected={selectedSet.has(row.block.id)}
      lonely={lonely}
      references={lineLink(row.block) ? linksOf(lineLink(row.block)!.page_id).length : undefined}
      linkLine={linkLineOf(row.block)}
      dragging={dragging.has(row.block.id)}
      dropEdge={drop?.id === row.block.id ? drop.edge : null}
      upload={uploads[row.block.id]}
      surfaceContainer={surfaceContainer}
      slot={slash?.blockId === row.block.id ? (
        <Popover
          open
          anchor={slash.anchor}
          placement="bottom-start"
          role="presentation"
          label="Blocks"
          onDismiss={() => setSlash(null)}
          closeOnScroll={false}
        >
          <SlashMenu commands={commands} activeIndex={slashIndex} onSelect={(command) => runCommand(row.block, command)} />
        </Popover>
      ) : mention?.blockId === row.block.id ? (
        <Popover
          open
          anchor={mention.anchor}
          placement="bottom-start"
          role="presentation"
          label={mention.trigger === "[[" ? "Link to page" : "Mention"}
          onDismiss={() => setMention(null)}
          closeOnScroll={false}
        >
          <MentionMenu
            trigger={mention.trigger}
            items={mentionOptions}
            activeIndex={mentionIndex}
            onSelect={(item) => chooseMention(row.block, item)}
          />
        </Popover>
      ) : undefined}
      actions={actions}
    />
  );

  /* What a block's first line is — a heading sits lower, a title higher —
     so its mark sits level with it. A block that is named opens on a line of
     its own, its name; one that is not opens on its first paragraph's line,
     which the marks of every block opening there stand before. */
  const headKindOf = (list: Item[]): string => {
    const first = list[0];
    if (!first) return "text";
    if (first.kind === "page") return first.page.name ? "title" : headKindOf(first.items);
    const { block } = first.row;
    // A line that is nothing but a link: a row's height.
    if (linkLineOf(block)) return "row";
    return block.kind;
  };

  /* `opening`: how many blocks' marks stand on the first line of `list` —
     the "+" of that line stands before them. `base`: the list depth the
     lines of `list` count their indent from (the block holding them).
     `level`: how many blocks hold `list` — with a line's list depth, how far
     in from the page's column its words are, so every line's "+" and handle
     stand in the one column before it. */
  const renderItems = (list: Item[], opening = 0, base = 0, level = 0): ReactNode[] => list.map((item, index) => {
    const marks = index === 0 ? opening : 0;
    if (item.kind === "row") return renderRow(item.row, marks, level);
    return (
      <PageFrame
        key={item.page.id}
        pageId={item.page.id}
        name={nameOf(item.page.id)}
        depth={item.depth}
        level={level}
        shift={item.depth - base}
        readOnly={readOnly}
        menuOpen={pageMenu?.from === "block" && pageMenu.id === item.page.id}
        dragging={dragging.has(item.page.id)}
        references={linksOf(item.page.id).length}
        onMenu={(anchor) => setPageMenu({ from: "block", id: item.page.id, anchor })}
        onDragStart={(event) => startFrameDrag(item.page.id, event)}
        onDragEnd={endDrag}
        onReferences={(anchor) => setBacklinksFor({ id: item.page.id, anchor })}
        mark={item.page.icon ? <span className="page-frame__mark-emoji">{item.page.icon}</span> : undefined}
        // Named, its name is its first line, and opens it — as a page shown
        // in another has its title over its words.
        title={item.page.name ? (
          <button
            type="button"
            className="page-frame__title-open"
            onClick={(event) => { if (!event.shiftKey) followLink(item.page.id, event.metaKey || event.ctrlKey); }}
          >
            <span className="page-frame__title-label">{item.page.name}</span>
          </button>
        ) : undefined}
        headKind={item.page.name ? "title" : headKindOf(item.items)}
        onToggle={(id) => setShown({ row: id }, false)}
      >
        {renderItems(item.items, item.page.name ? 0 : marks + 1, item.depth, level + 1)}
      </PageFrame>
    );
  });

  const renderDocumentItems = (): ReactNode[] => {
    if (embed || standalone || items.length <= PROGRESSIVE_INITIAL) {
      return renderItems(items, embed && !page.title ? 1 : 0);
    }
    const firstEnd = Math.min(PROGRESSIVE_INITIAL, visibleCount);
    const nodes: ReactNode[] = renderItems(items.slice(0, firstEnd), 0);
    for (let start = PROGRESSIVE_INITIAL; start < visibleCount; start += PROGRESSIVE_BATCH) {
      const slice = items.slice(start, Math.min(start + PROGRESSIVE_BATCH, visibleCount));
      nodes.push(
        <div
          key={`chunk-${start}`}
          className="blocks__chunk"
          style={{ "--chunk-height": `${Math.max(240, slice.length * 34)}px` } as CSSProperties}
        >
          {renderItems(slice, 0)}
        </div>,
      );
    }
    if (hasMoreItems) {
      nodes.push(<div key="tail-sentinel" ref={tailSentinelRef} className="blocks__tail" aria-hidden="true" />);
    }
    return nodes;
  };

  const blocksContainer = (
    <div
      ref={blocksRef}
      className={`blocks${readOnly ? " is-read-only" : ""}`}
      onPointerDown={(event) => {
        beginBlockMove(event);
        beginPointerSelection(event);
      }}
      onFocusCapture={(event) => {
        if (!mobile || readOnly) return;
        const target = event.target as HTMLElement | null;
        if (!target || target.closest(".stbl, .mount, .block__code-bar, button")) return;
        const editable = target.closest<HTMLElement>(".block__editable");
        if (!editable) return;
        const row = editable.closest<HTMLElement>("[data-block-id]");
        const blockId = row?.dataset.blockId;
        if (!blockId || row.closest(".blocks") !== blocksRef.current) return;
        setFocusedBlockId(blockId);
        setEditingMode("block");
        const blk = latestTree.current.by_id[blockId];
        if (blk) setCaretMarks(marksAtBlockCaret(blk, editable));
      }}
      onMouseDownCapture={onBlocksMouseDown}
      onContextMenu={onBlocksContextMenu}
      onCopy={onCopySelection}
      onCut={onCutSelection}
      onClick={openMentionedPage}
      onPointerOver={linkHover.onPointerOver}
      onPointerOut={linkHover.onPointerOut}
      onDragLeave={(event) => {
        // Files dragged out of the page again close where they would land.
        if (!dragIds && !event.currentTarget.contains(event.relatedTarget as Node | null)) leaveFiles();
      }}
      onDragStart={blockTextDrags}
    >
      {/* Shown in another page untitled, its first line is its frame's. */}
      {renderDocumentItems()}
      {historical ? null : <RemoteCarets root={blocksRef} />}
    </div>
  );

  /** How a page shown here is shown — locked, folded, taken off this page —
   *  for whoever may change the page around it. */
  const shownActions = (mount: MountHandle): Partial<PageMenuProps> => (mount.canChange ? {
    locked: mount.locked,
    onLock: mount.toggleLock,
    onFold: mount.showAsLink,
    ...(mount.removable ? { onRemoveHere: mount.removeHere } : {}),
  } : {});

  /** What may be done with a page drawn here by its block (`blockId`: the
   *  page itself, or its row): share, name and mark the page; move, copy or
   *  delete the block. */
  const blockActions = (pageId: string, blockId: string, anchor: AnchorRect): Partial<PageMenuProps> => ({
    onShare: () => requestShare(pageId),
    onRename: () => setNaming({ id: pageId, anchor }),
    onIcon: () => setPicker({ kind: "icon", pageId, anchor }),
    // A shared page stays where it is shared (`canMovePage`).
    ...(pages[pageId]?.share_space_id ? {} : { onMoveTo: () => setMoveTo({ ids: [blockId], anchor }) }),
    onDuplicate: () => duplicateSelected([blockId], { select: false }),
    onDelete: () => execute(deleteBlocks(tree, [blockId], createId("block"))),
  });

  /** The page menu's page, its name and what may be done with it, by what it
   *  was opened from — null once that is gone. */
  const pageMenuOf = (open: PageMenuOpen): (Partial<PageMenuProps> & { pageId: string; name: string }) | null => {
    switch (open.from) {
      case "block": {
        // A block is a page: its menu is a page's, for the block drawn here.
        const { id, anchor } = open;
        if (!tree.by_id[id]) return null;
        return {
          pageId: id,
          name: nameOf(id),
          ...(readOnly ? {} : {
            ...blockActions(id, id, anchor),
            onFold: () => setShown({ row: id }, false),
            onUngroup: () => execute(unwrapPage(tree, id)),
            // Shown elsewhere too, it can leave this page and live there.
            ...(mountsOf(id).length ? { onRemoveHere: () => rehomeBlock(id) } : {}),
          }),
        };
      }
      case "frame": {
        // Shown here from where it lives, it has the menu it has there —
        // both pages are its parents — with how it is shown here in place of
        // what only the page it lives in can do.
        if (!embed?.mount) return null;
        const { anchor } = open;
        return {
          pageId: page.id,
          name: pageName(page, describeMention),
          ...(readOnly ? {} : {
            onShare: () => requestShare(page.id),
            onRename: () => setNaming({ id: page.id, anchor }),
            onIcon: () => setPicker({ kind: "icon", pageId: page.id, anchor }),
            ...(canTrashPage(page.id) ? {
              onDelete: () => {
                archivePage(page.id);
                toast("Moved to trash", "success");
              },
            } : {}),
          }),
          ...shownActions(embed.mount),
        };
      }
      case "link": {
        // A line that is nothing but a link: what it links — to open, copy,
        // count or show here — and taking the line off this page.
        const line = tree.by_id[open.blockId];
        const link = line ? soleLink(line.content) : null;
        if (!line || link?.kind !== "page") return null;
        const at = soleLinkOffset(line.content);
        const view = mentionDescriber(() => pages, undefined, shownPages)(link);
        return {
          pageId: link.page_id,
          name: view.label,
          ...(view.state === "missing" ? { references: 0, onOpen: undefined } : {}),
          onShow: readOnly || view.state ? undefined : () => setShown({ line: line.id, at }, true),
          onRemoveHere: readOnly ? undefined : () => removeMount(line, at),
          // A page that lives here, on its own line, is a block folded into
          // its line: its menu is the block's too.
          ...(readOnly || !canEdit(link.page_id) || pages[link.page_id]?.parent_id !== ownerOf(line.id) ? {} : blockActions(link.page_id, line.id, open.anchor)),
        };
      }
      case "database":
      case "app": {
        const target = pages[open.pageId];
        return target ? { pageId: target.id, name: pageName(target), ...shownActions(open.mount) } : null;
      }
    }
  };

  /** What the picker picks for, and where the choice goes — each closing
   *  it; null once that is gone. */
  const pickerOf = (open: PickerOpen): Omit<ComponentProps<typeof IconPicker>, "anchor" | "onClose"> | null => {
    const close = () => setPicker(null);
    if (open.kind === "cover") {
      return {
        tab: "cover",
        current: cover?.kind === "gradient" ? cover.id : cover ? "upload" : undefined,
        onPick: (value) => {
          updatePage(page.id, { cover: coverId(value), cover_image: undefined });
          close();
        },
        onUpload: (file) => {
          close();
          void uploadCover(file);
        },
        onRemove: () => {
          updatePage(page.id, { cover: undefined, cover_image: undefined });
          close();
        },
      };
    }
    if (open.kind === "callout") {
      const block = tree.by_id[open.blockId];
      if (!block) return null;
      return {
        tab: "emoji",
        label: "Callout icon",
        current: block.icon || "💡",
        onPick: (icon) => {
          execute(updateBlockFields(tree, block.id, { icon }));
          close();
        },
        onRemove: () => {
          execute(updateBlockFields(tree, block.id, { icon: undefined }));
          close();
        },
      };
    }
    const target = pages[open.pageId];
    if (!target) return null;
    return {
      tab: "emoji",
      current: target.icon || (target.icon_image ? "upload" : undefined),
      onPick: (picked) => {
        if (picked.startsWith("file:")) {
          const file = recentsFile(picked.slice(5), platform?.bootstrap.user.id);
          if (file) updatePage(target.id, { icon_image: file });
          close();
          return;
        }
        updatePage(target.id, { icon: picked });
        close();
      },
      onUpload: (file) => {
        close();
        void uploadIcon(file, target.id);
      },
      onRemove: () => {
        updatePage(target.id, { icon: "" });
        close();
      },
    };
  };

  const overlays = (
    <>
      {linkHover.hovered ? (
        <LinkHoverCard
          link={linkHover.hovered}
          readOnly={readOnly}
          onKeep={linkHover.keep}
          onRelease={linkHover.release}
          onClose={linkHover.close}
          onCopy={copyHoveredLink}
          onEdit={editHoveredLink}
          onEmbed={embedHoveredLink}
        />
      ) : null}
      {cardOffer && offerStands ? (
        <CardOffer
          offer={cardOffer}
          onTake={() => {
            setCardOffer(null);
            takeCardOffer(cardOffer);
          }}
          onKeepLink={() => setCardOffer(null)}
          onPoint={(index) => setCardOffer((current) => current && { ...current, index })}
        />
      ) : null}
      {blockMenu ? (
        <BlockMenu
          anchor={blockMenu.anchor}
          blocks={blockMenu.ids.map((blockId) => tree.by_id[blockId]).filter((block): block is Block => Boolean(block))}
          onClose={() => setBlockMenu(null)}
          onDelete={() => deleteSelected(blockMenu.ids)}
          onDuplicate={() => duplicateSelected(blockMenu.ids)}
          onTurnInto={(kind: BlockKind) => executeOnBlocks(convertBlocks(tree, blockMenu.ids, kind))}
          onTurnIntoDatabase={databaseReady(blockMenu.ids) ? () => convertToDatabase(blockMenu.ids) : undefined}
          onTableHeader={(block, which) => {
            const on = !normalizeSimpleTable(block.table)[which];
            writeTable(block, [{ kind: "header", which, on }]);
          }}
          onColor={(color) => executeOnBlocks(colorBlocks(tree, blockMenu.ids, color))}
          onMoveTo={() => openMoveTo(blockMenu.ids)}
          onMakeBlock={() => {
            makeBlock(blockMenu.ids);
            setBlockSelection(null);
          }}
          onCopyBlockLink={() => {
            const made = makeBlock(blockMenu.ids);
            setBlockSelection(null);
            if (made) copyPageLink(made);
          }}
          onCopyImage={() => {
            const block = tree.by_id[blockMenu.ids[0]];
            const found = block ? soleImage(block.content) : null;
            if (found) void copyPicture(found.mention.file);
          }}
          onReplace={() => {
            const block = tree.by_id[blockMenu.ids[0]];
            if (!block) return;
            const found = block.kind !== "file" ? soleImage(block.content) : null;
            if (found) pickPictureReplacement(block.id, found.offset);
            else pickFile(block);
          }}
          onDownload={() => {
            const block = tree.by_id[blockMenu.ids[0]];
            if (!block) return;
            const found = block.kind !== "file" ? soleImage(block.content) : null;
            if (found) downloadPicture(found.mention.file);
            else actions.downloadFile(block);
          }}
          onTurnIntoLink={() => {
            const change = embedToLink(tree, blockMenu.ids[0]);
            if (!change) return;
            setBlockSelection(null);
            execute(change, { id: blockMenu.ids[0], start: change.focus?.offset ?? 0, force: true });
          }}
        />
      ) : null}

      {pageMenu ? (() => {
        const menu = pageMenuOf(pageMenu);
        if (!menu) return null;
        const { pageId, ...shown } = menu;
        return (
          <PageMenu
            anchor={pageMenu.anchor}
            references={linksOf(pageId).length}
            onClose={() => setPageMenu(null)}
            onOpen={() => followLink(pageId)}
            onCopyLink={() => copyPageLink(pageId)}
            onBacklinks={() => setBacklinksFor({ id: pageId, anchor: pageMenu.anchor })}
            {...shown}
          />
        );
      })() : null}

      {backlinksFor && (tree.by_id[backlinksFor.id] || pages[backlinksFor.id]) ? (
        <BlockBacklinks
          anchor={backlinksFor.anchor}
          name={nameOf(backlinksFor.id)}
          references={linksOf(backlinksFor.id)}
          pages={pages}
          describe={describeMention}
          onOpen={openParagraph}
          onClose={() => setBacklinksFor(null)}
        />
      ) : null}

      {naming && pages[naming.id] ? (
        <PageNameEditor
          anchor={naming.anchor}
          name={pages[naming.id].title || undefined}
          firstLine={pageFirstLine(pages[naming.id], describeMention) || "Untitled"}
          onSave={(name) => updatePage(naming.id, { title: name ?? "" })}
          onClose={() => setNaming(null)}
        />
      ) : null}

      {moveTo ? (
        <MoveToMenu
          anchor={moveTo.anchor}
          pages={moveTargets(moveTo.ids)}
          count={topLevelBlocks(tree, moveTo.ids).length}
          onMove={(targetId) => { setMoveTo(null); moveToPage(moveTo.ids, targetId); }}
          onClose={() => setMoveTo(null)}
        />
      ) : null}

      {linkedPick ? (
        <LinkViewMenu
          anchor={linkedPick.anchor}
          onPick={(databaseId, viewId) => {
            const pick = linkedPick.pick;
            setLinkedPick(null);
            pick(databaseId, viewId);
          }}
          onClose={() => setLinkedPick(null)}
        />
      ) : null}

      {format && !readOnly && !mobile ? (
        <FormatToolbar
          state={format}
          onToggleMark={(mark) => applyMark(mark, !format.marks[mark])}
          onTurnInto={(kind) => execute(convertBlock(tree, format.blockId, kind))}
          onTurnIntoAll={(kind) => executeOnBlocks(convertBlocks(tree, format.ranges.map((range) => range.blockId), kind))}
          onTurnIntoDatabase={databaseReady(format.ranges.map((range) => range.blockId))
            ? () => convertToDatabase(format.ranges.map((range) => range.blockId))
            : undefined}
          onMakeBlock={() => makeBlock(format.ranges.map((range) => range.blockId), format.ranges)}
          onCopyBlockLink={() => {
            const made = makeBlock(format.ranges.map((range) => range.blockId), format.ranges);
            if (made) copyPageLink(made);
          }}
          onSetLink={(href) => applyMark("link", href)}
          onColor={(color) => applyMark("color", color)}
          onCreateEquation={format.ranges.length === 1 ? () => {
            const range = format.ranges[0];
            const block = tree.by_id[range.blockId];
            if (!block || block.kind === "code") return;
            const initial = inlinePlainText(sliceInlineContent(block.content, range.start, range.end));
            const [head, rest] = splitInlineContent(block.content, range.start);
            const [, tail] = splitInlineContent(rest, Math.max(0, range.end - range.start));
            const nextContent = normalizeInlineContent([
              ...head,
              { text: MENTION_CHAR, mention: { kind: "equation", expression: initial } },
              ...tail,
            ]);
            const anchorFallback = format.anchor;
            setFormat(null);
            execute(updateBlockContent(tree, block.id, nextContent), { id: block.id, start: range.start + 1, force: true });
            requestAnimationFrame(() => {
              const rowEl = blocksRef.current?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(block.id)}"]`);
              const tokens = rowEl?.querySelectorAll<HTMLElement>('.mention[data-mention="equation"]');
              let matched: HTMLElement | null = null;
              if (tokens) {
                for (const el of tokens) {
                  const at = linkAt(el);
                  if (at && at.offset === range.start) {
                    matched = el;
                    break;
                  }
                }
              }
              setEquationEdit({
                mode: "inline",
                blockId: block.id,
                offset: range.start,
                expression: initial,
                anchor: matched ? rectOf(matched) : anchorFallback,
                removeIfEmpty: true,
              });
            });
          } : undefined}
          onClose={() => setFormat(null)}
          onReturn={() => selectRanges(blocksRef.current, format.ranges)}
        />
      ) : null}

      {equationEdit && !readOnly ? (
        <EquationPopover
          anchor={equationEdit.anchor}
          mode={equationEdit.mode}
          initialExpression={equationEdit.expression}
          onCommit={(nextExpr) => {
            const currentEdit = equationEdit;
            setEquationEdit(null);
            const currentTree = latestTree.current;
            const block = currentTree.by_id[currentEdit.blockId];
            if (!block) return;
            if (currentEdit.mode === "inline") {
              if (!nextExpr.trim()) {
                execute(
                  updateBlockContent(currentTree, block.id, replaceRange(block.content, currentEdit.offset, currentEdit.offset + 1, "")),
                  { id: block.id, start: currentEdit.offset, force: true },
                );
              } else {
                execute(
                  updateBlockContent(
                    currentTree,
                    block.id,
                    updateMentionAt(block.content, currentEdit.offset, () => ({ kind: "equation", expression: nextExpr })),
                  ),
                  { id: block.id, start: currentEdit.offset + 1, force: true },
                );
              }
            } else {
              const keepFocus = !document.activeElement || document.activeElement === document.body
                || Boolean(document.activeElement.closest(".equation-popover"));
              execute(updateBlockContent(currentTree, block.id, inlineFromText(nextExpr)));
              if (keepFocus) {
                requestAnimationFrame(() => {
                  blocksRef.current
                    ?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(currentEdit.blockId)}"] .block__equation`)
                    ?.focus({ preventScroll: true });
                });
              }
            }
          }}
          onRemove={() => {
            const currentEdit = equationEdit;
            setEquationEdit(null);
            const currentTree = latestTree.current;
            const block = currentTree.by_id[currentEdit.blockId];
            if (!block) return;
            if (currentEdit.mode === "inline") {
              execute(
                updateBlockContent(currentTree, block.id, replaceRange(block.content, currentEdit.offset, currentEdit.offset + 1, "")),
                { id: block.id, start: currentEdit.offset, force: true },
              );
            } else {
              execute(deleteBlocks(currentTree, [block.id], createId("block")));
            }
          }}
          onCancel={() => {
            const currentEdit = equationEdit;
            setEquationEdit(null);
            if (currentEdit.mode === "inline" && currentEdit.removeIfEmpty && !currentEdit.expression.trim()) {
              const currentTree = latestTree.current;
              const block = currentTree.by_id[currentEdit.blockId];
              if (!block) return;
              execute(
                updateBlockContent(currentTree, block.id, replaceRange(block.content, currentEdit.offset, currentEdit.offset + 1, "")),
                { id: block.id, start: currentEdit.offset, force: true },
              );
              return;
            }
            requestAnimationFrame(() => {
              if (currentEdit.mode === "inline") {
                const el = editableWithin(blocksRef.current, currentEdit.blockId);
                if (el) focusRange(el, Math.min(currentEdit.offset + 1, el.textContent?.length ?? 0));
              } else {
                blocksRef.current
                  ?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(currentEdit.blockId)}"] .block__equation`)
                  ?.focus({ preventScroll: true });
              }
            });
          }}
        />
      ) : null}

      <input
        ref={fileInput}
        type="file"
        hidden
        onChange={onFileInputChange}
      />

      {pictureHover?.isConnected ? (() => {
        const mention = mentionFromAttributes((name) => pictureHover.getAttribute(`data-${name}`) ?? undefined);
        const link = linkAt(pictureHover);
        if (mention?.kind !== "image" || !link) return null;
        const menuOpen = Boolean(pictureMenu && !pictureMenu.inViewer && pictureMenu.blockId === link.block.id && pictureMenu.offset === link.offset);
        return (
          <PictureTools
            rect={pictureHover.getBoundingClientRect()}
            align={link.block.align}
            readOnly={readOnly}
            menuOpen={menuOpen}
            onAlign={(align) => execute(updateBlockFields(tree, link.block.id, { align }))}
            onCopy={() => copyPicture(mention.file)}
            onDownload={() => downloadPicture(mention.file)}
            onView={() => {
              setPictureHover(null);
              setViewingTarget({ blockId: link.block.id, offset: link.offset });
            }}
            onMore={(anchor) => setPictureMenu({ blockId: link.block.id, offset: link.offset, anchor })}
            onEnter={() => holdPicture(pictureHover)}
            onLeave={() => holdPicture(null)}
          />
        );
      })() : null}

      {pictureMenu ? (() => {
        const block = tree.by_id[pictureMenu.blockId];
        const mention = block ? mentionAt(block.content, pictureMenu.offset) : undefined;
        if (!block || mention?.kind !== "image") return null;
        return (
          <PictureMenu
            anchor={pictureMenu.anchor}
            align={block.align}
            resized={mention.width !== undefined}
            readOnly={readOnly}
            onClose={() => setPictureMenu(null)}
            onCopy={pictureMenu.inViewer ? undefined : () => { void copyPicture(mention.file); }}
            onView={pictureMenu.inViewer ? undefined : () => setViewingTarget({ blockId: block.id, offset: pictureMenu.offset })}
            onDownload={pictureMenu.inViewer ? undefined : () => downloadPicture(mention.file)}
            onAlign={(align) => execute(updateBlockFields(tree, block.id, { align }))}
            onReplace={() => pickPictureReplacement(block.id, pictureMenu.offset)}
            onResetSize={() => resetPictureWidth(block.id, pictureMenu.offset)}
            onDelete={() => {
              if (pictureMenu.inViewer) setViewingTarget(null);
              deletePicture(block.id, pictureMenu.offset);
            }}
          />
        );
      })() : null}

      {viewingEntry ? (
        <ImageViewer
          file={viewingEntry.file}
          actions={actions}
          browse={pageImages.length > 1 ? {
            index: viewingIndex,
            count: pageImages.length,
            onStep: (delta) => {
              const target = pageImages[viewingIndex + delta];
              if (target) setViewingTarget({ blockId: target.blockId, offset: target.offset });
            },
          } : undefined}
          onDownload={() => downloadPicture(viewingEntry.file)}
          onCopyResult={(ok, message) => toast(message, ok ? "success" : "error")}
          extraActions={!readOnly ? (
            <button
              type="button"
              className="icon-btn"
              aria-label="More image actions"
              aria-haspopup="menu"
              aria-expanded={Boolean(pictureMenu?.inViewer)}
              title="More image actions"
              onClick={(event) => {
                setPictureMenu({
                  blockId: viewingEntry.blockId,
                  offset: viewingEntry.offset,
                  anchor: rectOf(event.currentTarget),
                  inViewer: true,
                });
              }}
            >
              <MoreHorizontal size={15} aria-hidden="true" />
            </button>
          ) : undefined}
          onClose={() => {
            setPictureMenu((current) => (current?.inViewer ? null : current));
            setViewingTarget(null);
          }}
        />
      ) : null}

      {picker ? (() => {
        const chosen = pickerOf(picker);
        return chosen ? (
          <Suspense fallback={null}>
            <IconPicker anchor={picker.anchor} onClose={() => setPicker(null)} {...chosen} />
          </Suspense>
        ) : null;
      })() : null}
    </>
  );

  if (standalone) {
    return (
      <div
        ref={mountDocRef}
        className={`memo-doc ${standalone.compact ? "memo-doc--compact" : ""}`}
        data-page-id={page.id}
        onKeyDownCapture={(event) => {
          if (imeComposing(event)) return;
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
            event.preventDefault();
            event.stopPropagation();
            if (event.shiftKey) effectiveRedo();
            else effectiveUndo();
            return;
          }
          if (slash || mention || cardOffer || blockMenu || pageMenu || linkedPick || equationEdit) return;
          if (standalone.onShortcut?.(event)) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onBlurCapture={handleContainerBlur}
      >
        {blocksContainer}
        {overlays}
      </div>
    );
  }

  /* Shown in another page: the block and what editing it needs — no cover
     or foot, and no font of its own: the page around it sets that, as for
     its own blocks. A whole page is the block it is: framed with its line,
     grip and count, its title over its words. */
  if (embed) {
    const mount = embed.mount;
    return (
      <div ref={mountDocRef} className="mount-doc" data-page-id={page.id} onBlurCapture={handleContainerBlur}>
        <PageFrame
          pageId={page.id}
          name={pageName(page)}
          depth={0}
          readOnly={!mount?.movable}
          locked={mount?.locked}
          menuOpen={pageMenu?.from === "frame"}
          dragging={false}
          references={linksOf(page.id).length}
          onMenu={(anchor) => setPageMenu({ from: "frame", anchor })}
          onDragStart={(event) => mount?.dragStart(event)}
          onDragEnd={() => mount?.dragEnd()}
          onReferences={(anchor) => setBacklinksFor({ id: page.id, anchor })}
          // Its mark is the page's icon, where a block's is: pressed, the
          // page folds back into its row or link.
          mark={page.icon || page.icon_image ? <span className="page-frame__mark-emoji"><PageIconMark page={page} size={15} /></span> : <PageIcon size={16} />}
          headKind={page.title ? "page-title" : headKindOf(items)}
          onToggle={() => mount?.showAsLink()}
        >
          {/* Named, its title over its words, and the title opens it; unnamed
              — a block made from paragraphs — it is drawn as a block is, its
              first line its head. */}
          {page.title ? (
            <div className="mount-title">
              <button type="button" className="mount-title__open" onClick={(event) => followLink(page.id, event.metaKey || event.ctrlKey)}>
                <span className="mount-title__label">{page.title}</span>
              </button>
            </div>
          ) : null}
          {blocksContainer}
        </PageFrame>
        {overlays}
      </div>
    );
  }

  const showOutline = !embed && surfaceContainer === "main";
  const outlineItems = useMemo(
    () => (showOutline ? extractOutline(tree, describeMention) : []),
    [describeMention, showOutline, tree],
  );

  return (
    <article
      ref={setArticleRef}
      className={`doc ${cover ? "doc--covered" : ""} ${icon ? "doc--iconed" : ""} ${page.full_width ? "doc--full" : ""} ${font === "default" ? "" : `doc--font-${font}`}`}
      data-page-id={page.id}
      onPointerDownCapture={claimCaret}
      onKeyDownCapture={claimCaret}
      onBlurCapture={handleContainerBlur}
      onPointerDown={beginMarquee}
      // A box selection must not start a text selection, nor take the caret.
      onMouseDown={(event) => { if (marqueeStart.current) event.preventDefault(); }}
    >
      {/* The others' caret in the title — the page's own fields, outside
          `.blocks`, are drawn by this layer; the blocks' own layer is inside
          the `.blocks` row. */}
      {historical ? null : <RemoteCarets root={articleRef} />}
      {cover ? (
        <div
          className={`doc__cover ${cover.kind === "image" ? "doc__cover--image" : ""}`}
          style={cover.kind === "gradient" ? { background: cover.background } : undefined}
        >
          {cover.kind === "image" ? <CoverImage file={cover.file} className="doc__cover-image" /> : null}
          {/* Read-only covers keep no controls: in history `page` is the OLD
              version, and a shuffle would have written all of it back. */}
          {readOnly ? null : (
            <div className="doc__cover-actions">
              <button type="button" className="btn" onClick={(event) => setPicker({ kind: "cover", anchor: rectOf(event.currentTarget) })}>
                Change cover
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => updatePage(page.id, { cover: randomCoverId(cover.kind === "gradient" ? cover.id : undefined), cover_image: undefined })}
              >
                <RefreshCw size={13} />Shuffle
              </button>
              <button type="button" className="btn" aria-label="Remove cover" onClick={() => updatePage(page.id, { cover: undefined, cover_image: undefined })}>
                <X size={14} />
              </button>
            </div>
          )}
        </div>
      ) : null}

      <div className="doc__inner">
        <div className="doc__head">
          {readOnly ? null : (
            <div className="doc__decorate">
              {icon ? null : (
                <button type="button" className="btn" onClick={() => updatePage(page.id, { icon: randomEmoji() })}>
                  <Smile size={15} />Add icon
                </button>
              )}
              {cover ? null : (
                <button type="button" className="btn" onClick={() => updatePage(page.id, { cover: randomCoverId(), cover_image: undefined })}>
                  <ImageIcon size={15} />Add cover
                </button>
              )}
            </div>
          )}

          {icon ? (
            <button
              type="button"
              className="doc__icon"
              aria-label="Change page icon"
              disabled={readOnly}
              onClick={(event) => setPicker({ kind: "icon", pageId: page.id, anchor: rectOf(event.currentTarget) })}
            >
              {icon.kind === "image" ? <IconImage file={icon.file} size={72} className="doc__icon-img" fallback={<PageIcon size={72} />} /> : icon.emoji}
            </button>
          ) : null}

          {/* Unnamed — a block made from paragraphs is, until it is named —
              a page shows the first line it goes by, greyed, to be named
              over. */}
          <TitleField
            elementRef={(element) => { titleRef.current = element; }}
            className="doc__title"
            label="Page title"
            historyField="title"
            blockId={page.id}
            collaboration={historical ? undefined : { pageId: page.id, key: titleField(page.id) }}
            content={titleContent}
            readOnly={readOnly}
            placeholder={pageFirstLine(page, describeMention) || "Untitled"}
            onChange={(next) => updatePage(page.id, titleFields(next))}
            onFocus={() => {
              if (!mobile || readOnly) return;
              setFocusedBlockId(null);
              setEditingMode("title");
            }}
            onBlur={() => checkpointPage(page.id, "Renamed page")}
            onOpenPage={(href, full) => {
              const target = linkedPageId(href, pagesRef.current);
              if (target) followLink(target, full);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== "ArrowDown") return;
              // A name on two lines is gone down within first.
              if (event.key === "ArrowDown" && !caretOnLastLine(event.currentTarget)) return;
              event.preventDefault();
              // The first line that takes words: past a folded block or a sub-page's row.
              const first = rows[0] ? editableWithin(blocksRef.current, rows[0].block.id) ?? nextEditable(rows[0].block.id, 1) : null;
              if (first) focusRange(first, 0);
            }}
          />

          {/* Notion's backlinks: the pages that link here from outside,
              under the title, folded to a count until asked for. */}
          {backlinks.length ? (
            <div className="doc__backlinks">
              <button
                type="button"
                className="doc__backlinks-toggle"
                aria-expanded={backlinksOpen}
                onClick={() => setBacklinksOpen((open) => !open)}
              >
                <ArrowUpRight size={15} />
                {backlinks.length} backlink{backlinks.length === 1 ? "" : "s"}
              </button>
              {backlinksOpen ? (
                <ul className="doc__backlinks-list">
                  {backlinks.map((source) => (
                    <li key={source.id}>
                      <button type="button" className="doc__backlink" onClick={(event) => followLink(source.id, event.metaKey || event.ctrlKey)}>
                        <span className="doc__backlink-icon">{pageGlyph(source, 15)}</span>
                        <span className="doc__backlink-title">{pageName(source, describeMention)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>

        <KnowledgeBaseHome pageId={page.id} />

        {properties}

        {blocksContainer}

        <div
          className="doc__pad"
          aria-hidden="true"
          onDragOver={(event) => {
            // Files dropped below the last block go at the end of the page.
            if (!dragIds) overFiles(event);
          }}
          onDrop={(event) => { if (!dragIds) onDrop(event); }}
          onClick={() => {
            // The end of a box selection is not a click on the page's foot.
            if (marqueeDragged.current) marqueeDragged.current = false;
            else appendBlock();
          }}
        />
      </div>

      {marquee ? (
        <div className="marquee" style={{ left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height }} aria-hidden="true" />
      ) : null}

      {showOutline && outlineItems.length > 0 ? (
        <PageOutline
          items={outlineItems}
          contentRoot={articleEl}
          topOffset={0}
          pinnedTopOffset={24}
          onEnsureBlock={ensureAllRendered}
          renderRevision={visibleCount}
        />
      ) : null}

      {overlays}
    </article>
  );
}
