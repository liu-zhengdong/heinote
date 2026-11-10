import type { Dispatch, DragEvent, RefObject, SetStateAction } from "react";
import type { CreatePageOptions } from "../../app/workspace-context";
import type { ToastTone } from "../../components/Toast";
import type { InlineContent, BlockTree, NotePage } from "../../core/types";
import type { ToggleableMark } from "../../core/inline-content";
import type { HistoryFocus, HistoryInput } from "../../core/workspace-history";
import type { AnchorRect } from "../../hooks/useAnchoredPosition";
import type { PlatformClient } from "../../platform/client";
import type { WorkspaceDocument } from "../../platform/workspace-document";
import type { CopiedBlocks } from "./block-clipboard";
import type { ShowInPlace } from "./composite";
import type { EditorTransaction } from "./editor-commands";
import type { FormatState } from "./FormatToolbar";
import type { MentionTrigger, TypingResume } from "./inline-markdown";
import type { Rendered } from "./layout";
import type { MentionItem } from "./mentions";
import type { BlockTextRange, PendingTextSelection } from "./selection";
import type { Command } from "./SlashMenu";

/* What the editor and the pieces it is made of share: where the caret goes
   next, what a menu typed in the words is doing, what a page shown in
   another page asks of it. */

/** Where the caret goes once a change is drawn. `force` redraws the block
 *  even though it holds the caret. */
export type PendingFocus = { id: string; start: number; end?: number; force?: boolean };

/** Where a page is shown or folded in a page: on its row (`row`: the row's
 *  id, or a page drawn in place, whose row the drawing stands in for), or
 *  through a link in a line of words (`line`, the link at `at`). */
export type ShownRef = { row: string } | { line: string; at: number };

/** What a block shown in another page asks of that page's editor, whose
 *  paragraph is the place it stands in there. */
export interface MountHandle {
  /** Read only in that page. */
  locked: boolean;
  /** Whoever is reading may change that page: lock it, put it away, move it. */
  canChange: boolean;
  /** The block is the whole line there, so the line moves with it. */
  movable: boolean;
  /** It can be taken off that page alone (a sub-page's own row cannot: the
   *  row is where the page lives). */
  removable: boolean;
  toggleLock(): void;
  showAsLink(): void;
  removeHere(): void;
  dragStart(event: DragEvent<HTMLButtonElement>): void;
  dragEnd(): void;
  /** Enter on its empty last line: a new line in that page, after it. */
  stepOut(): void;
  /** The caret going on past its first or last line, into that page. */
  caretOut(direction: -1 | 1, x: number): boolean;
}

/** A page shown in place in another by a link: the page being read, and the
 *  pages already shown around this one — never shown again inside it. */
export interface EmbedOptions {
  topPageId: string;
  shownPages: readonly string[];
  mount?: MountHandle;
}

/** "/" typed in the words: where, and what follows it. */
export type SlashState = { blockId: string; from: number; query: string; anchor: AnchorRect };
/** "@" or "[[" typed in the words. */
export type MentionState = SlashState & { trigger: MentionTrigger };
/** Where something dragged over the page would land. */
export type DropState = { id: string; edge: "above" | "below" | "inside" };

/** What the editor's parts — typing, keys, the keys of selected blocks,
 *  pictures and files — read of it and do through it: built once a render
 *  (DocumentEditor), each part taking what it needs. */
export interface Editor {
  page: NotePage;
  pages: Record<string, NotePage>;
  pagesRef: RefObject<Record<string, NotePage>>;
  tree: BlockTree;
  rows: readonly Rendered[];
  embed: EmbedOptions | undefined;
  readOnly: boolean;
  platform: PlatformClient | null;
  workspace: WorkspaceDocument | null;
  blocksRef: RefObject<HTMLDivElement | null>;
  caretX: RefObject<number>;
  slash: SlashState | null;
  setSlash: Dispatch<SetStateAction<SlashState | null>>;
  slashIndex: number;
  setSlashIndex: Dispatch<SetStateAction<number>>;
  slashDismissed: RefObject<{ blockId: string; from: number } | null>;
  commands: readonly Command[];
  mention: MentionState | null;
  setMention: Dispatch<SetStateAction<MentionState | null>>;
  mentionIndex: number;
  setMentionIndex: Dispatch<SetStateAction<number>>;
  mentionDismissed: RefObject<{ blockId: string; from: number } | null>;
  mentionOptions: readonly MentionItem[];
  setFormat: Dispatch<SetStateAction<FormatState | null>>;
  resume: RefObject<(TypingResume & { blockId: string }) | null>;
  pendingTextSelection: RefObject<PendingTextSelection | null>;
  blockSelection: { anchor: string; focus: string } | null;
  setBlockSelection: Dispatch<SetStateAction<{ anchor: string; focus: string } | null>>;
  selectedIds: readonly string[];
  setBlockMenu: Dispatch<SetStateAction<{ ids: string[]; anchor: AnchorRect } | null>>;
  showInPlace: ShowInPlace;
  ownerOf(blockId: string): string;
  titleOf(pageId: string): string;
  anchorFor(blockId: string): AnchorRect | null;
  createPage(parentId?: string | null, kind?: NotePage["kind"], options?: CreatePageOptions): string | null;
  checkpointHistory(focus?: HistoryFocus | null): void;
  annotateHistory(input: HistoryInput): void;
  write(change: EditorTransaction, options?: { cut?: readonly string[]; record?: boolean }): void;
  execute(change: EditorTransaction | null, focus?: PendingFocus, options?: { cut?: readonly string[] }): void;
  /** A command on selected blocks, which keeps them selected. */
  executeOnBlocks(transaction: EditorTransaction | null, options?: { cut?: readonly string[] }): void;
  runReplace(transaction: EditorTransaction | null, options?: { cut?: readonly string[] }): boolean;
  replaceSelection(insert?: InlineContent): EditorTransaction | null;
  selectBlocks(anchor: string, focus?: string): void;
  deleteSelected(ids: readonly string[], options?: { cut?: boolean }): void;
  duplicateSelected(ids: readonly string[], options?: { select?: boolean }): void;
  openMoveTo(ids: readonly string[]): void;
  closeMenus(): void;
  applyMarkToBlocks(ranges: BlockTextRange[], mark: ToggleableMark | "link" | "color", value: boolean | string | undefined): void;
  openLink(): void;
  pastedBlocks(data: DataTransfer): { incoming: CopiedBlocks | null; fragment: BlockTree } | null;
  adoptCutPages(incoming: CopiedBlocks | null, fragment: BlockTree, at: string | null): void;
  /** A YouTube or X link pasted onto a line of its own: offer its card, as
   *  Notion's paste menu offers an embed. */
  offerCard(blockId: string, href: string): void;
  toast(message: string, tone?: ToastTone): void;
}

/** Keys that move the caret without typing. */
export const CARET_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

/** What someone who may only read a page is told when they reach for
 *  something that would change it for everyone: folding a block, showing a
 *  sub-page here. */
export const VIEW_ONLY = "You can view this page, but not change what it shows";
