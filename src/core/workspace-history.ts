/* Notion's undo. Every change made in this window — a keystroke, a block moved,
   a page sent to the trash, a database view renamed — is taken back with ⌘Z
   and put back with ⌘⇧Z, and the caret goes back to where the change was made.

   History sits at the one place every edit passes through: the workspace's
   list of mutations. A step keeps, for each path it touched, the value that
   path held before and after; undo writes the befores back, redo the afters.
   Everything one press, click, paste or drop does is one step, and a run of
   typing in one place folds into one step, so ⌘Z takes back a phrase rather
   than a letter.

   Nobody else's work is ever undone. When another person — or this person
   in another window — has written a path since, the step is replayed on top
   of what they wrote rather than over it: in a block, field by field; in its
   words (or a page's name), as a change from the runs the step started
   from, which the server merges with theirs character by character, so taking
   back your words leaves theirs beside them; in the two id lists (the
   top-level pages and a database's rows), only this step's own insertions
   and removals. Where both touched the same field, theirs stands.

   History is the document, not the chrome: the person's preferences, page
   history checkpoints, favourites, sharing and the updated stamp are never
   steps. */

import { inlineFromText, normalizeInlineContent } from "./inline-content";
import { nextHistoryOrder } from "./history-clock";
import type { Block, InlineContent, WorkspaceMutation, WorkspaceState } from "./types";

export interface HistoryTextRange {
  blockId: string;
  start: number;
  end: number;
}

/** What had the caret: text in blocks (one range for a caret, several for a
 *  selection across blocks), blocks selected as blocks, or a field such as a
 *  title. */
export type HistoryFocus =
  | { kind: "text"; pageId: string; ranges: HistoryTextRange[] }
  | { kind: "blocks"; pageId: string; blockIds: string[] }
  | { kind: "field"; pageId: string; field: string; start: number; end: number; peek: boolean };

/** Where the person was: the page open in the window, and what had the caret. */
export interface HistoryCursor {
  view: string;
  focus: HistoryFocus | null;
}

/** Typing, by direction. Consecutive steps of the same direction in the same
 *  place fold into one; anything else is a step of its own. */
export type HistoryInput = "insert" | "delete" | null;

interface HistoryChange {
  path: string[];
  key: string;
  before: unknown;
  after: unknown;
}

export class HistoryConflict extends Error {
  constructor(readonly changes: readonly HistoryChange[]) { super("协作者已修改这次结构操作涉及的内容，未执行撤销或重做。"); }
}

interface HistoryStep {
  atomic: boolean;
  order: number;
  changes: HistoryChange[];
  before: HistoryCursor | null;
  /** Unknown until the next thing the person does says where they went. */
  after: HistoryCursor | null | undefined;
  input: HistoryInput;
  startedAt: number;
  endedAt: number;
}

export interface HistoryReplay {
  mutations: WorkspaceMutation[];
  /** Pages whose contents the replay rewrote, for their updated stamp. */
  pageIds: string[];
  /** Where to put the person back: before the step for undo, after it for redo. */
  cursor: HistoryCursor | null;
  /** The blocks the replay wrote, for bringing the change into view. */
  blockIds: string[];
}

/** Steps kept; the oldest go first. */
const LIMIT = 200;
/** A pause longer than this ends a run of typing. */
const FOLD_MS = 1000;

const UNRECORDED_PAGE_FIELDS = new Set(["updated_at", "updated_by"]);
/* Compared away on a whole page: they change without being steps. The share
   space is deliberately NOT here — a page shared since it was made must not be
   deleted by undoing its creation. */
const UNCOMPARED_PAGE_FIELDS = new Set(["updated_at", "updated_by"]);

export function isHistoryPath(path: readonly string[]): boolean {
  if (path[0] === "roots") return path.length === 1;
  if (path[0] !== "pages" || path.length < 2) return false;
  return path.length === 2 || !UNRECORDED_PAGE_FIELDS.has(path[2]);
}

/** The typing direction of a `beforeinput`, or null for input that is a step
 *  of its own — a paste, a drop, a spelling fix, a line break. */
export function historyInputFor(inputType: string): HistoryInput {
  if (inputType === "insertText" || inputType === "insertCompositionText") return "insert";
  if (inputType.startsWith("delete") && !inputType.startsWith("deleteBy")) return "delete";
  return null;
}

function valueAt(root: unknown, path: readonly string[]): unknown {
  let node = root;
  for (const key of path) {
    if (!node || typeof node !== "object" || !Object.hasOwn(node, key)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** Writes `value` at `path` inside `root`, which must be a private copy. */
function withValueAt(root: unknown, path: readonly string[], value: unknown): unknown {
  if (!path.length) return clone(value);
  if (!root || typeof root !== "object") return root;
  const [key, ...rest] = path;
  const node = root as Record<string, unknown>;
  if (rest.length) node[key] = withValueAt(node[key], rest, value);
  else if (value === undefined) delete node[key];
  else node[key] = clone(value);
  return root;
}

function isPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((key, index) => path[index] === key);
}

function overlaps(left: readonly string[], right: readonly string[]): boolean {
  return isPrefix(left, right) || isPrefix(right, left);
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

/** Equality that ignores key order and keys holding `undefined` — the two ways
 *  one value comes back different after the workspace re-normalises a page. */
export function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => sameValue(item, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftEntries = Object.entries(left).filter(([, value]) => value !== undefined);
  const rightValues = right as Record<string, unknown>;
  const rightCount = Object.values(rightValues).filter((value) => value !== undefined).length;
  return leftEntries.length === rightCount
    && leftEntries.every(([key, value]) => sameValue(value, rightValues[key]));
}

function comparable(path: readonly string[], value: unknown): unknown {
  if (isBlock(value)) return { ...value, content: normalizeInlineContent(value.content) };
  if (path.length !== 2 || path[0] !== "pages" || !value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !UNCOMPARED_PAGE_FIELDS.has(key)));
}

function isIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Replays the insertions and removals that turned `from` into `to` on top of
 *  `current`: how a step's change to an id list is undone or redone after
 *  someone else has changed the same list. Each insertion lands after the
 *  nearest earlier neighbour it had, so a restored page comes back in place. */
export function rebaseIdList(current: readonly string[], from: readonly string[], to: readonly string[]): string[] {
  const removed = new Set(from.filter((id) => !to.includes(id)));
  const result = current.filter((id) => !removed.has(id));
  to.forEach((id, index) => {
    if (from.includes(id) || result.includes(id)) return;
    let at = -1;
    for (let back = index - 1; back >= 0 && at < 0; back -= 1) {
      const found = result.indexOf(to[back]);
      if (found >= 0) at = found + 1;
    }
    for (let ahead = index + 1; ahead < to.length && at < 0; ahead += 1) {
      const found = result.indexOf(to[ahead]);
      if (found >= 0) at = found;
    }
    result.splice(at < 0 ? result.length : at, 0, id);
  });
  return result;
}

function isBlock(value: unknown): value is Block {
  return Boolean(value) && typeof value === "object"
    && typeof (value as Block).id === "string" && Array.isArray((value as Block).content);
}

/** A step's change to a block, replayed field by field over a block someone
 *  else has changed since: each field the step changed goes back only if they
 *  left it alone. Rich-text compensation carries its original `base`.
 *  The server rejects a stale base. Null means no field can change. */
export function replayBlock(current: Block, from: Block, to: Block): { value: Block; base?: InlineContent } | null {
  const result: Record<string, unknown> = { ...current };
  const was = from as unknown as Record<string, unknown>;
  const next = to as unknown as Record<string, unknown>;
  const now = current as unknown as Record<string, unknown>;
  let changed = false;
  let base: InlineContent | undefined;
  for (const key of new Set([...Object.keys(was), ...Object.keys(next), ...Object.keys(now)])) {
    if (key === "id" || sameValue(was[key], next[key])) continue;
    if (!sameValue(now[key], was[key])) {
      if (key !== "content") continue;
      base = from.content;
    }
    if (next[key] === undefined) delete result[key];
    else result[key] = clone(next[key]);
    changed = true;
  }
  return changed ? { value: result as unknown as Block, ...(base ? { base } : {}) } : null;
}

/** What a path should hold after the step is replayed from `from` to `to`
 *  given it holds `current` now; `undefined` target means delete, and a null
 *  result means the path is left as it is. `base`: the runs a change of rich
 *  text starts from, when someone else changed it since. */
function replayTarget(path: readonly string[], current: unknown, from: unknown, to: unknown): { value: unknown; base?: InlineContent } | null {
  if (sameValue(comparable(path, current), comparable(path, from))) return { value: to };
  if (isIdList(from) && isIdList(to) && (current === undefined || isIdList(current))) {
    return { value: rebaseIdList(current ?? [], from, to) };
  }
  if (isBlock(current) && isBlock(from) && isBlock(to)) return replayBlock(current, from, to);
  // A page's name someone else renamed since: its words or its runs, as a
  // change from what the step started from.
  if (path.length === 3 && path[0] === "pages") {
    if (path[2] === "title" && typeof from === "string" && typeof to === "string") return { value: to, base: inlineFromText(from) };
    if (path[2] === "title_content" && Array.isArray(from) && Array.isArray(to)) return { value: to, base: from as InlineContent };
  }
  return null;
}

export class WorkspaceHistory {
  private undoStack: HistoryStep[] = [];
  private redoStack: HistoryStep[] = [];
  private open: HistoryStep | null = null;
  private pendingCursor: HistoryCursor | null = null;
  private pendingInput: HistoryInput = null;
  /** Set by undo and redo: the next step never folds into the one below it. */
  private sealed = false;

  canUndo(): boolean {
    return Boolean(this.open) || this.undoStack.length > 0;
  }
  lastOrder(direction: "undo" | "redo"): number { return direction === "undo" ? this.open?.order ?? this.undoStack.at(-1)?.order ?? 0 : this.redoStack.at(-1)?.order ?? 0; }
  discardRedo(): void { this.redoStack = []; }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Something the person just did — a key, a press, a paste, a drop. It ends
   *  the step in progress, and where they are now is where that step left
   *  them and where the next one begins. `input` is set for typing. */
  boundary(cursor: HistoryCursor | null, input: HistoryInput = null): void {
    if (this.open) this.close(cursor);
    else {
      const top = this.undoStack.at(-1);
      if (top && top.after === undefined) top.after = cursor;
    }
    this.pendingCursor = cursor;
    this.pendingInput = input;
  }

  /** Adds one write to the step in progress; `before` and `after` are the
   *  workspace either side of it. */
  record(before: WorkspaceState, after: WorkspaceState, mutations: readonly WorkspaceMutation[], atomic = false): void {
    const paths = mutations.map((mutation) => mutation.path).filter(isHistoryPath);
    if (!paths.length) return;
    const now = Date.now();
    this.open ??= {
      atomic,
      order: nextHistoryOrder(),
      changes: [],
      before: this.pendingCursor,
      after: undefined,
      input: this.pendingInput,
      startedAt: now,
      endedAt: now,
    };
    const step = this.open;
    step.atomic ||= atomic;
    step.order = nextHistoryOrder();
    step.endedAt = now;
    for (const path of paths) {
      if (step.changes.some((change) => isPrefix(change.path, path))) continue;
      // A write over paths this step already changed takes them in: its
      // "before" is the parent as it was, with their befores put back.
      const covered = step.changes.filter((change) => isPrefix(path, change.path));
      let value = clone(valueAt(before, path));
      for (const child of covered) value = withValueAt(value, child.path.slice(path.length), child.before);
      step.changes = step.changes.filter((change) => !covered.includes(change));
      step.changes.push({ path: [...path], key: JSON.stringify(path), before: value, after: undefined });
    }
    for (const change of step.changes) {
      if (paths.some((path) => overlaps(path, change.path))) change.after = clone(valueAt(after, change.path));
    }
    this.redoStack = [];
  }

  /** The editor knows better than the DOM, at the moment of a write, that
   *  the write was typing. */
  annotate(input: HistoryInput): void {
    if (this.open) this.open.input = input;
  }

  /** Ends the step in progress here, so the next write is a step of its own —
   *  how a Markdown shortcut is undone back to the characters that were typed. */
  checkpoint(cursor?: HistoryCursor | null): void {
    if (!this.open) return;
    this.close(cursor);
    if (cursor !== undefined) this.pendingCursor = cursor;
    this.pendingInput = null;
  }

  undo(state: WorkspaceState): HistoryReplay | null {
    this.close(undefined);
    while (this.undoStack.length) {
      const step = this.undoStack.at(-1)!;
      const replay = this.replay(state, step, "undo");
      this.undoStack.pop();
      // A step with nothing left to take back — someone else has since
      // rewritten all of it — is dropped, and the one below is tried.
      if (!replay) continue;
      step.order = nextHistoryOrder();
      this.redoStack.push(step);
      this.sealed = true;
      return replay;
    }
    return null;
  }

  redo(state: WorkspaceState): HistoryReplay | null {
    this.close(undefined);
    while (this.redoStack.length) {
      const step = this.redoStack.at(-1)!;
      const replay = this.replay(state, step, "redo");
      this.redoStack.pop();
      if (!replay) continue;
      step.order = nextHistoryOrder();
      this.undoStack.push(step);
      this.sealed = true;
      return replay;
    }
    return null;
  }

  private close(after: HistoryCursor | null | undefined): void {
    const step = this.open;
    this.open = null;
    if (!step) return;
    if (after !== undefined && step.after === undefined) step.after = after;
    step.changes = step.changes.filter((change) => !sameValue(change.before, change.after));
    if (!step.changes.length) return;
    const top = this.undoStack.at(-1);
    if (top && !this.sealed && this.folds(top, step)) {
      const change = step.changes[0];
      top.changes[0].after = change.after;
      top.after = step.after;
      top.endedAt = step.endedAt;
      top.order = step.order;
      return;
    }
    this.sealed = false;
    this.undoStack.push(step);
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
  }

  /** Typing folds into the typing before it: same direction, same single
   *  path, no pause, the caret right where the last keystroke left it, and
   *  the text exactly as it left it — an edit from someone else in between
   *  starts a new step, so neither step claims their words as its own. */
  private folds(top: HistoryStep, step: HistoryStep): boolean {
    if (top.atomic || step.atomic) return false;
    if (!step.input || top.input !== step.input) return false;
    if (step.startedAt - top.endedAt > FOLD_MS) return false;
    if (top.changes.length !== 1 || step.changes.length !== 1) return false;
    if (top.changes[0].key !== step.changes[0].key) return false;
    if (!sameValue(top.changes[0].after, step.changes[0].before)) return false;
    return top.after !== undefined && sameValue(top.after, step.before);
  }

  private replay(state: WorkspaceState, step: HistoryStep, direction: "undo" | "redo"): HistoryReplay | null {
    const undoing = direction === "undo";
    if (step.atomic && step.changes.some((change) => !sameValue(comparable(change.path, valueAt(state, change.path)), comparable(change.path, undoing ? change.after : change.before)))) throw new HistoryConflict(step.changes);
    const mutations: WorkspaceMutation[] = [];
    for (const change of undoing ? [...step.changes].reverse() : step.changes) {
      const from = undoing ? change.after : change.before;
      const to = undoing ? change.before : change.after;
      const current = valueAt(state, change.path);
      const replayed = replayTarget(change.path, current, from, to);
      if (!replayed) continue;
      const target = replayed.value;
      if (sameValue(current, target)) continue;
      // A field of a page that is gone is not brought back on its own.
      if (change.path[0] === "pages" && change.path.length > 2 && target !== undefined && !state.pages[change.path[1]]) continue;
      mutations.push(target === undefined
        ? { type: "delete", path: [...change.path] }
        : { type: "set", path: [...change.path], value: clone(target), ...(replayed.base ? { base: replayed.base } : {}) });
    }
    if (!mutations.length) return null;

    const deleted = new Set(mutations
      .filter((mutation) => mutation.type === "delete" && mutation.path[0] === "pages" && mutation.path.length === 2)
      .map((mutation) => mutation.path[1]));
    const pageIds = [...new Set(mutations
      .filter((mutation) => mutation.path[0] === "pages" && mutation.path.length > 2)
      .map((mutation) => mutation.path[1]))]
      .filter((pageId) => !deleted.has(pageId));
    const blockIds = [...new Set(mutations
      .filter((mutation) => mutation.path[2] === "block_tree" && mutation.path[3] === "by_id" && mutation.path[4])
      .map((mutation) => mutation.path[4]))];
    return { mutations, pageIds, cursor: undoing ? step.before : step.after ?? null, blockIds };
  }
}
