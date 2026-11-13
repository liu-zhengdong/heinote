import * as Y from "yjs";
import { diffArrays } from "diff";
import type { RichText } from "../platform/schema";
import { fieldAddress } from "./protocol";

type Marks = Record<string, unknown>;
type Atom = { text: string; marks: Marks } | { embed: Record<string, unknown>; marks: Marks };
type Unit = { before: Y.RelativePosition; after: Y.RelativePosition };
type Observed = { atom: Atom; units: Unit[] };
type BasisData = { text: Y.Text; atoms: Observed[]; empty: Y.RelativePosition };

declare const basisBrand: unique symbol;
declare const selectionBrand: unique symbol;
/** A DOM snapshot with identities in its actual shared field. */
export interface TextBasis { readonly [basisBrand]: true }
/** Selection anchors that can resolve in replicas of the same shared field. */
export interface TextSelection { readonly [selectionBrand]: true }
const bases = new WeakMap<TextBasis, BasisData>();
const selections = new WeakMap<TextSelection, { start: Y.RelativePosition; end: Y.RelativePosition }>();
const seedOrigin = Symbol("initialize shared fields");

function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
const equal = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const attrs = (value?: Marks): Marks => Object.fromEntries(Object.entries(value ?? {}).filter(([, item]) => item !== undefined && item !== null).map(([key, item]) => [key, structuredClone(item)]));
const size = (atom: Atom) => "text" in atom ? atom.text.length : 1;
const sameValue = (left: Atom, right: Atom) => "text" in left ? "text" in right && left.text === right.text : "embed" in right && equal(left.embed, right.embed);

function atomsOf(runs: RichText): Atom[] {
  const atoms: Atom[] = [];
  for (const run of runs) {
    const marks = attrs(run.marks);
    if (run.embed !== undefined) atoms.push({ embed: structuredClone(run.embed), marks });
    else if (run.text) for (const char of run.text) atoms.push({ text: char, marks });
  }
  return atoms;
}
function runsOf(atoms: readonly Atom[]): RichText {
  const runs: RichText = [];
  for (const atom of atoms) {
    const marks = Object.keys(atom.marks).length ? { marks: structuredClone(atom.marks) } : {};
    const previous = runs.at(-1);
    if ("text" in atom) {
      if (previous?.text !== undefined && equal(attrs(previous.marks), atom.marks)) previous.text += atom.text;
      else runs.push({ text: atom.text, ...marks });
    } else runs.push({ embed: structuredClone(atom.embed), ...marks });
  }
  return runs;
}
function integrated(text: Y.Text): Y.Doc {
  if (!text.doc) throw new Error("Shared text must belong to a Y.Doc");
  return text.doc;
}
function observe(text: Y.Text, atom: Atom, index: number): Observed {
  return { atom, units: Array.from({ length: size(atom) }, (_, offset) => ({
    before: Y.createRelativePositionFromTypeIndex(text, index + offset, 0),
    after: Y.createRelativePositionFromTypeIndex(text, index + offset + 1, -1),
  })) };
}
function makeBasis(data: BasisData): TextBasis {
  const basis = Object.freeze({}) as TextBasis;
  bases.set(basis, data); return basis;
}
function dataOf(basis: TextBasis): BasisData {
  const data = bases.get(basis);
  if (!data) throw new Error("Invalid text basis");
  return data;
}
function unitsOf(atoms: readonly Observed[]): Unit[] { return atoms.flatMap((item) => item.units); }
function boundary(data: BasisData, offset: number, side: "left" | "right"): Y.RelativePosition {
  const units = unitsOf(data.atoms);
  const at = Math.min(units.length, Math.max(0, Math.trunc(offset)));
  if (side === "right" && units[at]) return units[at].before;
  if (at > 0) return units[at - 1].after;
  return units[0]?.before ?? data.empty;
}
function absolute(text: Y.Text, position: Y.RelativePosition): number | null {
  const resolved = Y.createAbsolutePositionFromRelativePosition(position, integrated(text));
  return resolved?.type === text ? resolved.index : null;
}
function identity(position: Y.RelativePosition): string | null {
  return position.item ? `${position.item.client}:${position.item.clock}` : null;
}
// A deleted item's anchor resolves nearby. Verify identity before editing it.
function survivingIndex(text: Y.Text, unit: Unit): number | null {
  const index = absolute(text, unit.before);
  if (index === null || index >= text.length) return null;
  return identity(Y.createRelativePositionFromTypeIndex(text, index, 0)) === identity(unit.before) ? index : null;
}
function rangesOf(text: Y.Text, atoms: readonly Observed[]): Array<{ index: number; length: number }> {
  const indices = [...new Set(unitsOf(atoms).flatMap((unit) => { const index = survivingIndex(text, unit); return index === null ? [] : [index]; }))].sort((a, b) => a - b);
  const ranges: Array<{ index: number; length: number }> = [];
  for (const index of indices) {
    const previous = ranges.at(-1);
    if (previous && previous.index + previous.length === index) previous.length += 1;
    else ranges.push({ index, length: 1 });
  }
  return ranges;
}

function validKey(key: string): boolean {
  const address = fieldAddress(key);
  if (!address?.id) return false;
  const { collection, path } = address;
  if (path.some((part) => !part || ["__proto__", "prototype", "constructor"].includes(part))) return false;
  return collection === "pages" ? path.length === 1 && path[0] === "title_content"
    : path.length === 1 && path[0] === "content" || path.length === 5 && path[0] === "table" && path[1] === "rows" && path[3] === "cells";
}
export function fieldOf(doc: Y.Doc, key: string): Y.Text {
  if (!validKey(key)) throw new Error("Invalid collaborative text field");
  const fields = doc.getMap<Y.Text>("fields");
  const existing = fields.get(key);
  if (existing !== undefined) {
    if (!(existing instanceof Y.Text)) throw new Error("Collaborative field is not Y.Text");
    return existing;
  }
  const text = new Y.Text(); fields.set(key, text); return text;
}
export function readText(text: Y.Text): RichText {
  integrated(text);
  const runs: RichText = text.toDelta().flatMap((part: { insert: unknown; attributes?: Marks }): RichText => {
    const marks = attrs(part.attributes);
    const marked = Object.keys(marks).length ? { marks } : {};
    if (typeof part.insert === "string") return part.insert ? [{ text: part.insert, ...marked }] : [];
    if (part.insert && typeof part.insert === "object" && !Array.isArray(part.insert)) return [{ embed: structuredClone(part.insert as Record<string, unknown>), ...marked }];
    throw new Error("Unsupported shared text embed");
  });
  return runsOf(atomsOf(runs));
}
export function basisText(basis: TextBasis): RichText { return runsOf(dataOf(basis).atoms.map((item) => item.atom)); }
export function captureText(text: Y.Text): TextBasis {
  integrated(text);
  let index = 0;
  const atoms = atomsOf(readText(text)).map((atom) => { const observed = observe(text, atom, index); index += size(atom); return observed; });
  return makeBasis({ text, atoms, empty: Y.createRelativePositionFromTypeIndex(text, 0, 0) });
}
function basisOf(text: Y.Text, atoms: Observed[]): TextBasis {
  return makeBasis({ text, atoms, empty: Y.createRelativePositionFromTypeIndex(text, 0, 0) });
}
/** A basis naming only the shared atoms a DOM actually showed: the text's
 *  atoms matched against `seen` in order. Atoms the DOM never drew — remote
 *  words delivered after the last draw — stay outside the basis, so a commit
 *  built on it cannot delete text the editor has not seen. Unmatched `seen`
 *  atoms (words the DOM holds that are not shared yet) simply fall out of the
 *  basis and become additions in the diff. */
export function visibleBasis(text: Y.Text, seen: RichText): TextBasis {
  const full = atomsOf(readText(text));
  const offsets: number[] = [];
  let index = 0;
  for (const atom of full) { offsets.push(index); index += size(atom); }
  /* For each atom the DOM showed, take the earliest shared atom after the
     previous match; a word the shared text lacks just falls out, and every
     shared atom it never drew stays out of the basis entirely. */
  const wanted = atomsOf(seen);
  const matched: Observed[] = [];
  let pos = 0;
  for (const want of wanted) {
    let found = -1;
    for (let at = pos; at < full.length; at += 1) if (sameValue(full[at], want)) { found = at; break; }
    if (found < 0) continue;
    matched.push(observe(text, full[found], offsets[found]));
    pos = found + 1;
  }
  return basisOf(text, matched);
}

/** Apply only the intent visible between this DOM basis and its next runs.
 * The caller groups operations with doc.transact and supplies the origin. */
export function editText(text: Y.Text, basis: TextBasis, next: RichText): TextBasis {
  const before = dataOf(basis);
  if (before.text !== text) throw new Error("Text basis belongs to another field or generation");
  integrated(text);
  const desired = atomsOf(next);
  const changes = diffArrays(before.atoms.map((item) => item.atom), desired, { comparator: sameValue });
  const removed: Observed[] = [];
  const additions: Array<{ at: number; first: number; count: number }> = [];
  const kept: Array<{ observed: Observed; desired: Atom; at: number }> = [];
  const result: Observed[] = new Array(desired.length);
  let oldIndex = 0; let nextIndex = 0;
  for (const change of changes) {
    const count = change.value.length;
    if (change.removed) { removed.push(...before.atoms.slice(oldIndex, oldIndex + count)); oldIndex += count; }
    else if (change.added) { additions.push({ at: oldIndex, first: nextIndex, count }); nextIndex += count; }
    else {
      for (let offset = 0; offset < count; offset++) kept.push({ observed: before.atoms[oldIndex + offset], desired: desired[nextIndex + offset], at: nextIndex + offset });
      oldIndex += count; nextIndex += count;
    }
  }
  for (const range of rangesOf(text, removed).toReversed()) text.delete(range.index, range.length);
  for (const { observed, desired: atom, at } of kept) {
    const delta: Marks = {};
    for (const name of new Set([...Object.keys(observed.atom.marks), ...Object.keys(atom.marks)])) {
      if (!equal(observed.atom.marks[name], atom.marks[name])) delta[name] = atom.marks[name] === undefined ? null : structuredClone(atom.marks[name]);
    }
    if (Object.keys(delta).length) for (const range of rangesOf(text, [observed])) text.format(range.index, range.length, delta);
    result[at] = { atom, units: observed.units };
  }
  for (const addition of additions) {
    const offset = before.atoms.slice(0, addition.at).reduce((total, item) => total + item.units.length, 0);
    let index = absolute(text, boundary(before, offset, "right"));
    if (index === null) throw new Error("The observed text boundary is no longer available");
    for (let count = 0; count < addition.count;) {
      const first = desired[addition.first + count];
      let take = 1;
      if ("text" in first) {
        while (count + take < addition.count) {
          const other = desired[addition.first + count + take];
          if (!("text" in other) || !equal(first.marks, other.marks)) break;
          take++;
        }
        const value = desired.slice(addition.first + count, addition.first + count + take).map((atom) => "text" in atom ? atom.text : "").join("");
        text.insert(index, value, first.marks);
      } else text.insertEmbed(index, structuredClone(first.embed), first.marks);
      for (let item = 0; item < take; item++) {
        const atom = desired[addition.first + count + item];
        result[addition.first + count + item] = observe(text, atom, index); index += size(atom);
      }
      count += take;
    }
  }
  // Keep the DOM's desired atoms. Unseen remote atoms remain outside its basis.
  return makeBasis({ text, atoms: result, empty: boundary(before, 0, "right") });
}
export function captureSelection(basis: TextBasis, start: number, end: number): TextSelection {
  const data = dataOf(basis);
  const selection = Object.freeze({}) as TextSelection;
  selections.set(selection, {
    start: boundary(data, start, start < end ? "right" : "left"),
    end: boundary(data, end, end < start ? "right" : "left"),
  });
  return selection;
}
export function resolveSelection(text: Y.Text, selection: TextSelection): { start: number; end: number } | null {
  const anchors = selections.get(selection);
  if (!anchors || !text.doc) return null;
  const start = absolute(text, anchors.start); const end = absolute(text, anchors.end);
  return start === null || end === null ? null : { start, end };
}
export function readFields(doc: Y.Doc): Record<string, RichText> {
  const fields: Record<string, RichText> = {};
  for (const [key, value] of doc.getMap<Y.Text>("fields")) {
    if (!validKey(key) || !(value instanceof Y.Text)) throw new Error("Invalid collaborative text field");
    fields[key] = readText(value);
  }
  return fields;
}
export function seedFields(doc: Y.Doc, fields: Record<string, RichText>): void {
  if (doc.getMap("fields").size) throw new Error("Shared fields can only be seeded into a new document");
  if (Object.keys(fields).some((key) => !validKey(key))) throw new Error("Invalid collaborative text field");
  doc.transact(() => {
    for (const [key, runs] of Object.entries(fields)) { const text = fieldOf(doc, key); editText(text, captureText(text), runs); }
  }, seedOrigin);
}
export function updateFields(doc: Y.Doc, fields: Record<string, RichText>, origin: unknown): void {
  if (Object.keys(fields).some((key) => !validKey(key))) throw new Error("Invalid collaborative text field");
  doc.transact(() => {
    for (const [key, runs] of Object.entries(fields)) { const text = fieldOf(doc, key); editText(text, captureText(text), runs); }
  }, origin);
}
