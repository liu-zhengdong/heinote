import type * as Y from "yjs";
import type { RichText } from "../platform/schema";
import { basisText, captureText, editText, readText, type TextBasis } from "./text";
import { publishRecovery } from "./recovery";

export interface RegisteredField { pageId: string; key: string; generation: string; text: Y.Text; canEdit: boolean; revision?: string; scope?: string; userId?: string }
export interface BoundText { field: RegisteredField; basis: TextBasis }
let lookup: (pageId: string, key: string) => RegisteredField | null = () => null;
let active: { current: BoundText | null } | null = null;
export function installTextLookup(get: typeof lookup): void { lookup = get; }
export function observedText(): BoundText | null { return active?.current ?? null; }
/** Capture this only when the corresponding shared runs are actually drawn. */
export function renderedText(pageId: string, key: string): BoundText | null {
  const field = lookup(pageId, key);
  return field ? { field, basis: captureText(field.text) } : null;
}
/** Scope native DOM intent across the existing synchronous mutation pipeline. */
export function withTextBasis(bound: BoundText | null, action: () => void): BoundText | null {
  const current = bound ? lookup(bound.field.pageId, bound.field.key) : null;
  // Unchanged hosts can retain a memoized basis while another block redraws.
  // Advance only the page revision when this observed field still agrees.
  let prepared = bound;
  if (bound && current && current.text === bound.field.text && current.generation === bound.field.generation && JSON.stringify(basisText(bound.basis)) === JSON.stringify(readText(current.text))) prepared = { ...bound, field: { ...bound.field, revision: current.revision } };
  const previous = active; const context = { current: prepared }; active = context;
  try { action(); return context.current; } finally { active = previous; }
}
/** Keep IME text if a reset or remote deletion unmounts its active host. */
export function preserveTextDraft(bound: BoundText | null, content: RichText, message = "编辑位置已变化。输入中的文字已保留为草稿。"): void {
  if (!bound) return;
  const draft = { message, writes: [], documents: [{ scope: bound.field.scope, pageId: bound.field.pageId, generation: bound.field.generation, fields: { [bound.field.key]: content } }] };
  if (bound.field.userId) publishRecovery(bound.field.userId, draft);
  else window.dispatchEvent(new CustomEvent("notes:save-refused", { detail: draft }));
}
/** Called inside the owning session's local-origin Yjs transaction. */
export function editObservedField(field: RegisteredField, next: RichText): void {
  const observed = active?.current;
  const matching = observed?.field.text === field.text && observed.field.generation === field.generation;
  if (observed && !matching) {
    preserveTextDraft(observed, next, "页面结构或版本已变化。输入中的文字已保留为草稿。");
    throw new Error("The rendered text belongs to an earlier document generation");
  }
  const basis = matching ? observed.basis : captureText(field.text);
  const nextBasis = editText(field.text, basis, next);
  if (active && matching) active.current = { field, basis: nextBasis };
}
