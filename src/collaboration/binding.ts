import type { RichText } from "../platform/schema";
import { deepEqual, normalizeRichText } from "./ot/text";
import { publishRecovery } from "./recovery";

export interface RegisteredField {
  pageId: string;
  key: string;
  epoch: string;
  /** Alias of `epoch` kept for compatibility with existing callers/drafts. */
  generation: string;
  canEdit: boolean;
  revision?: string;
  scope?: string;
  userId?: string;
  runs: RichText;
}

export interface BoundText {
  field: RegisteredField;
  /** Exact normalized runs that the DOM element last rendered or submitted. */
  shown: RichText;
}

let lookup: (pageId: string, key: string) => RegisteredField | null = () => null;
let active: { current: BoundText | null } | null = null;

export function installTextLookup(get: typeof lookup): void {
  lookup = get;
}

export function observedText(): BoundText | null {
  return active?.current ?? null;
}

export function setObservedShown(field: RegisteredField, shown: RichText): void {
  if (!active) return;
  const current = active.current;
  if (current && current.field.pageId === field.pageId && current.field.key === field.key) {
    active.current = { field, shown: normalizeRichText(shown) };
  }
}

/** Capture the field's live runs only when the corresponding shared runs are actually drawn. */
export function renderedText(pageId: string, key: string): BoundText | null {
  const field = lookup(pageId, key);
  return field ? { field, shown: normalizeRichText(field.runs) } : null;
}

/**
 * A new epoch can keep the exact words the DOM observed; in that case its
 * identity may be adopted without discarding the user's next input.
 * Same-epoch remote edits retain the old `shown` basis so local edits are
 * diffed against what the DOM actually displayed and transformed across unseen
 * remote insertions (protecting IME composition and frame-delay races).
 */
export function refreshTextBinding(bound: BoundText): BoundText | null {
  const current = lookup(bound.field.pageId, bound.field.key);
  if (!current) return null;
  if (current.epoch === bound.field.epoch) return bound;
  return deepEqual(bound.shown, normalizeRichText(current.runs))
    ? { field: current, shown: normalizeRichText(current.runs) }
    : null;
}

/** Scope native DOM intent across the synchronous mutation pipeline. */
export function withTextBasis(bound: BoundText | null, action: () => void): BoundText | null {
  const current = bound ? lookup(bound.field.pageId, bound.field.key) : null;
  let prepared = bound;
  if (
    bound
    && current
    && current.epoch === bound.field.epoch
    && deepEqual(bound.shown, normalizeRichText(current.runs))
  ) {
    prepared = { ...bound, field: { ...bound.field, revision: current.revision, runs: current.runs } };
  }
  const previous = active;
  const context = { current: prepared };
  active = context;
  try {
    action();
    return context.current;
  } finally {
    active = previous;
  }
}

/** Keep IME or stale-epoch text if a reset or remote deletion unmounts its active host. */
export function preserveTextDraft(
  bound: BoundText | null,
  content: RichText,
  message = "编辑位置已变化。输入中的文字已保留为草稿。",
): void {
  if (!bound) return;
  const draft = {
    message,
    writes: [],
    documents: [{
      scope: bound.field.scope,
      pageId: bound.field.pageId,
      generation: bound.field.epoch,
      fields: { [bound.field.key]: content },
    }],
  };
  if (bound.field.userId) publishRecovery(bound.field.userId, draft);
  else if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("notes:save-refused", { detail: draft }));
}
