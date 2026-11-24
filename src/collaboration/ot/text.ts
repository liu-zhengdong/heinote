import type { RichText } from "../../platform/schema";
import type { JsonRecord, MarkPatch, Marks, TextStep } from "./types";

/**
 * Zero-dependency rich-text OT core.
 *
 * Coordinate system:
 * - Every offset and step length is measured in UTF-16 code units, matching
 *   JavaScript `string.length`, DOM selection offsets, and Agent API indices.
 * - Every embed run (mention / image) has length 1.
 * - Diff and boundary checks never split a UTF-16 surrogate pair.
 * - Mention embeds never carry `code` or `link` marks (`src/core/inline-content.ts`).
 */

type Atom =
  | { kind: "text"; text: string; marks: Marks }
  | { kind: "embed"; embed: JsonRecord; marks: Marks };

const MENTION_FORBIDDEN_MARKS = new Set(["code", "link"]);

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function deepEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function cleanMarks(value?: Marks | MarkPatch, isEmbed = false): Marks {
  if (!value) return {};
  const result: Marks = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null || item === false) continue;
    if (isEmbed && MENTION_FORBIDDEN_MARKS.has(key)) continue;
    result[key] = structuredClone(item);
  }
  return result;
}

export function cleanMarkPatch(value?: MarkPatch): MarkPatch | undefined {
  if (!value) return undefined;
  const result: MarkPatch = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    result[key] = item === null || item === false ? null : structuredClone(item);
  }
  return Object.keys(result).length ? result : undefined;
}

function applyMarkPatch(base: Marks, patch?: MarkPatch, isEmbed = false): Marks {
  if (!patch) return cleanMarks(base, isEmbed);
  const next: Marks = { ...base };
  for (const [key, item] of Object.entries(patch)) {
    if (item === null || item === false || item === undefined) delete next[key];
    else next[key] = structuredClone(item);
  }
  return cleanMarks(next, isEmbed);
}

function composeMarkPatches(first?: MarkPatch, second?: MarkPatch): MarkPatch | undefined {
  if (!first && !second) return undefined;
  const merged: MarkPatch = { ...(first ? structuredClone(first) : {}) };
  if (second) {
    for (const [key, item] of Object.entries(second)) {
      if (item !== undefined) merged[key] = item === null || item === false ? null : structuredClone(item);
    }
  }
  return Object.keys(merged).length ? merged : undefined;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Length of a RichText array in UTF-16 code units (embeds = 1). */
export function richTextLength(runs: RichText): number {
  let total = 0;
  for (const run of runs) {
    if (run.embed !== undefined) total += 1;
    else if (typeof run.text === "string") total += run.text.length;
  }
  return total;
}

/** Plain text representation matching `inlinePlainText` (embeds become U+2063). */
export function richTextPlain(runs: RichText): string {
  let out = "";
  for (const run of runs) {
    if (run.embed !== undefined) out += "\u2063";
    else if (typeof run.text === "string") out += run.text;
  }
  return out;
}

/** Validate that `offset` is within `[0, length]` and does not split a surrogate pair. */
export function isValidTextBoundary(runs: RichText, offset: number): boolean {
  if (!Number.isInteger(offset) || offset < 0) return false;
  let pos = 0;
  for (const run of runs) {
    if (run.embed !== undefined) {
      if (offset === pos) return true;
      pos += 1;
      continue;
    }
    const text = typeof run.text === "string" ? run.text : "";
    if (offset >= pos && offset <= pos + text.length) {
      const local = offset - pos;
      if (local > 0 && local < text.length) {
        if (isHighSurrogate(text.charCodeAt(local - 1)) && isLowSurrogate(text.charCodeAt(local))) {
          return false;
        }
      }
      return true;
    }
    pos += text.length;
  }
  return offset === pos;
}

/** Clamp an offset to `[0, length]` and nudge left if it would split a surrogate pair. */
export function clampTextBoundary(runs: RichText, offset: number): number {
  const plain = richTextPlain(runs);
  let clamped = Math.max(0, Math.min(plain.length, Math.trunc(offset)));
  if (clamped > 0 && clamped < plain.length
    && isHighSurrogate(plain.charCodeAt(clamped - 1))
    && isLowSurrogate(plain.charCodeAt(clamped))) {
    clamped -= 1;
  }
  return clamped;
}

/** Split a RichText array into Unicode code-point / embed atoms (never splits surrogate pairs). */
function toAtoms(runs: RichText): Atom[] {
  const atoms: Atom[] = [];
  for (const run of runs) {
    if (run.embed !== undefined && run.embed && typeof run.embed === "object") {
      atoms.push({ kind: "embed", embed: structuredClone(run.embed), marks: cleanMarks(run.marks, true) });
    } else if (typeof run.text === "string" && run.text.length > 0) {
      const marks = cleanMarks(run.marks, false);
      for (const ch of run.text) {
        atoms.push({ kind: "text", text: ch, marks });
      }
    }
  }
  return atoms;
}

function atomLength(atom: Atom): number {
  return atom.kind === "text" ? atom.text.length : 1;
}

function sameAtomValue(left: Atom, right: Atom): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "text" && right.kind === "text") return left.text === right.text;
  if (left.kind === "embed" && right.kind === "embed") return deepEqual(left.embed, right.embed);
  return false;
}

function marksDelta(before: Marks, after: Marks): MarkPatch | undefined {
  const delta: MarkPatch = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (!deepEqual(before[key], after[key])) {
      delta[key] = after[key] === undefined ? null : structuredClone(after[key]);
    }
  }
  return Object.keys(delta).length ? delta : undefined;
}

/** Normalize RichText: coalesce adjacent text runs with identical marks, drop empty runs, clean mention marks. */
export function normalizeRichText(runs: RichText): RichText {
  const out: RichText = [];
  for (const run of runs) {
    if (run.embed !== undefined && run.embed && typeof run.embed === "object") {
      const marks = cleanMarks(run.marks, true);
      out.push(Object.keys(marks).length ? { embed: structuredClone(run.embed), marks } : { embed: structuredClone(run.embed) });
      continue;
    }
    if (typeof run.text !== "string" || !run.text.length) continue;
    const marks = cleanMarks(run.marks, false);
    const prev = out.at(-1);
    if (prev && prev.embed === undefined && typeof prev.text === "string" && deepEqual(cleanMarks(prev.marks, false), marks)) {
      prev.text += run.text;
    } else {
      out.push(Object.keys(marks).length ? { text: run.text, marks } : { text: run.text });
    }
  }
  return out;
}

/** Slice a RichText array by UTF-16 range `[start, end)`. */
export function sliceRichText(runs: RichText, start: number, end = richTextLength(runs)): RichText {
  const from = Math.max(0, start);
  const to = Math.max(from, end);
  if (from === to) return [];
  const out: RichText = [];
  let pos = 0;
  for (const run of runs) {
    if (run.embed !== undefined) {
      if (pos >= from && pos < to) {
        const marks = cleanMarks(run.marks, true);
        out.push(Object.keys(marks).length ? { embed: structuredClone(run.embed), marks } : { embed: structuredClone(run.embed) });
      }
      pos += 1;
      continue;
    }
    const text = typeof run.text === "string" ? run.text : "";
    const runEnd = pos + text.length;
    if (runEnd > from && pos < to) {
      const piece = text.slice(Math.max(0, from - pos), Math.min(text.length, to - pos));
      if (piece) {
        const marks = cleanMarks(run.marks, false);
        out.push(Object.keys(marks).length ? { text: piece, marks } : { text: piece });
      }
    }
    pos = runEnd;
  }
  return normalizeRichText(out);
}

export function splitRichText(runs: RichText, offset: number): [RichText, RichText] {
  const total = richTextLength(runs);
  const at = clampTextBoundary(runs, offset);
  return [sliceRichText(runs, 0, at), sliceRichText(runs, at, total)];
}

export function concatRichText(left: RichText, right: RichText): RichText {
  return normalizeRichText([...left, ...right]);
}

export function stepLength(step: TextStep): number {
  if ("retain" in step) return step.retain;
  if ("delete" in step) return step.delete;
  return typeof step.insert === "string" ? step.insert.length : 1;
}

/** Normalize and compact a list of TextSteps: merge adjacent compatible ops and trim trailing plain retains. */
export function compactTextOps(ops: readonly TextStep[]): TextStep[] {
  const out: TextStep[] = [];
  for (const raw of ops) {
    if ("retain" in raw) {
      if (raw.retain <= 0) continue;
      const marks = cleanMarkPatch(raw.marks);
      const prev = out.at(-1);
      if (prev && "retain" in prev && deepEqual(prev.marks ?? null, marks ?? null)) {
        prev.retain += raw.retain;
      } else {
        out.push(marks ? { retain: raw.retain, marks } : { retain: raw.retain });
      }
    } else if ("delete" in raw) {
      if (raw.delete <= 0) continue;
      const prev = out.at(-1);
      if (prev && "delete" in prev) prev.delete += raw.delete;
      else out.push({ delete: raw.delete });
    } else if ("insert" in raw) {
      if (typeof raw.insert === "string") {
        if (!raw.insert.length) continue;
        const marks = cleanMarks(raw.marks, false);
        const prev = out.at(-1);
        if (prev && "insert" in prev && typeof prev.insert === "string" && deepEqual(cleanMarks(prev.marks, false), marks)) {
          prev.insert += raw.insert;
        } else {
          out.push(Object.keys(marks).length ? { insert: raw.insert, marks } : { insert: raw.insert });
        }
      } else {
        const marks = cleanMarks(raw.marks, true);
        const embed = structuredClone(raw.insert.embed);
        out.push(Object.keys(marks).length ? { insert: { embed }, marks } : { insert: { embed } });
      }
    }
  }
  while (out.length) {
    const last = out[out.length - 1];
    if ("retain" in last && !last.marks) out.pop();
    else break;
  }
  return out;
}

export function isNoopTextOps(ops: readonly TextStep[]): boolean {
  return compactTextOps(ops).length === 0;
}

/** Apply TextSteps onto a RichText document. Throws if steps overrun document length. */
export function applyTextOps(runs: RichText, ops: readonly TextStep[]): RichText {
  const normalized = normalizeRichText(runs);
  const total = richTextLength(normalized);
  const out: RichText = [];
  let cursor = 0;

  const pushSlice = (from: number, len: number, markPatch?: MarkPatch) => {
    if (len <= 0) return;
    const sliced = sliceRichText(normalized, from, from + len);
    for (const run of sliced) {
      if (run.embed !== undefined) {
        const nextMarks = applyMarkPatch(cleanMarks(run.marks, true), markPatch, true);
        out.push(Object.keys(nextMarks).length ? { embed: structuredClone(run.embed), marks: nextMarks } : { embed: structuredClone(run.embed) });
      } else if (typeof run.text === "string" && run.text.length) {
        const nextMarks = applyMarkPatch(cleanMarks(run.marks, false), markPatch, false);
        out.push(Object.keys(nextMarks).length ? { text: run.text, marks: nextMarks } : { text: run.text });
      }
    }
  };

  for (const step of ops) {
    if ("retain" in step) {
      if (step.retain < 0 || cursor + step.retain > total) {
        throw new Error(`Text op retain(${step.retain}) exceeds document length ${total} at ${cursor}`);
      }
      pushSlice(cursor, step.retain, step.marks);
      cursor += step.retain;
    } else if ("delete" in step) {
      if (step.delete < 0 || cursor + step.delete > total) {
        throw new Error(`Text op delete(${step.delete}) exceeds document length ${total} at ${cursor}`);
      }
      cursor += step.delete;
    } else if ("insert" in step) {
      if (typeof step.insert === "string") {
        if (!step.insert.length) continue;
        const marks = cleanMarks(step.marks, false);
        out.push(Object.keys(marks).length ? { text: step.insert, marks } : { text: step.insert });
      } else {
        const marks = cleanMarks(step.marks, true);
        out.push(Object.keys(marks).length ? { embed: structuredClone(step.insert.embed), marks } : { embed: structuredClone(step.insert.embed) });
      }
    }
  }

  if (cursor < total) pushSlice(cursor, total - cursor);
  return normalizeRichText(out);
}

/** Validate that a sequence of TextSteps stays within `runs` and never splits a UTF-16 surrogate pair. */
export function validateTextOps(runs: RichText, ops: readonly TextStep[]): string | null {
  const total = richTextLength(runs);
  let cursor = 0;
  for (const step of ops) {
    if ("retain" in step) {
      if (!Number.isInteger(step.retain) || step.retain < 0) return "retain 必须是非负整数。";
      if (cursor + step.retain > total) return "文字范围超出段落。";
      if (!isValidTextBoundary(runs, cursor) || !isValidTextBoundary(runs, cursor + step.retain)) {
        return "文字范围不能切开 emoji 字符。";
      }
      cursor += step.retain;
    } else if ("delete" in step) {
      if (!Number.isInteger(step.delete) || step.delete < 0) return "delete 必须是非负整数。";
      if (cursor + step.delete > total) return "文字范围超出段落。";
      if (!isValidTextBoundary(runs, cursor) || !isValidTextBoundary(runs, cursor + step.delete)) {
        return "文字范围不能切开 emoji 字符。";
      }
      cursor += step.delete;
    } else if ("insert" in step) {
      if (!isValidTextBoundary(runs, cursor)) return "文字插入位置不能切开 emoji 字符。";
    }
  }
  return null;
}

/** Step iterator allowing partial consumption of retain/delete/string-insert steps. */
class StepCursor {
  private index = 0;
  private offset = 0;
  constructor(private readonly ops: readonly TextStep[]) {}

  hasNext(): boolean {
    return this.index < this.ops.length;
  }

  peek(): TextStep | undefined {
    return this.ops[this.index];
  }

  peekLength(): number {
    const step = this.ops[this.index];
    if (!step) return Infinity;
    return stepLength(step) - this.offset;
  }

  peekType(): "retain" | "insert" | "delete" | "eof" {
    const step = this.ops[this.index];
    if (!step) return "eof";
    if ("retain" in step) return "retain";
    if ("insert" in step) return "insert";
    return "delete";
  }

  take(max = Infinity): TextStep {
    const step = this.ops[this.index];
    if (!step) return { retain: max };
    const total = stepLength(step);
    const remaining = total - this.offset;
    const size = Math.min(remaining, max);
    const start = this.offset;
    if (size === remaining) {
      this.index += 1;
      this.offset = 0;
    } else {
      this.offset += size;
    }
    if ("retain" in step) return step.marks ? { retain: size, marks: structuredClone(step.marks) } : { retain: size };
    if ("delete" in step) return { delete: size };
    if (typeof step.insert === "string") {
      const piece = step.insert.slice(start, start + size);
      return step.marks ? { insert: piece, marks: structuredClone(step.marks) } : { insert: piece };
    }
    return step.marks ? { insert: { embed: structuredClone(step.insert.embed) }, marks: structuredClone(step.marks) } : { insert: { embed: structuredClone(step.insert.embed) } };
  }
}

/**
 * Compose two sequential TextStep lists:
 * `applyTextOps(applyTextOps(doc, a), b) === applyTextOps(doc, composeTextOps(a, b))`.
 */
export function composeTextOps(a: readonly TextStep[], b: readonly TextStep[]): TextStep[] {
  const iterA = new StepCursor(compactTextOps(a));
  const iterB = new StepCursor(compactTextOps(b));
  const out: TextStep[] = [];

  while (iterA.hasNext() || iterB.hasNext()) {
    if (iterB.peekType() === "insert") {
      out.push(iterB.take());
    } else if (iterA.peekType() === "delete") {
      out.push(iterA.take());
    } else {
      const len = Math.min(iterA.peekLength(), iterB.peekLength());
      const stepA = iterA.take(len);
      const stepB = iterB.take(len);
      if ("retain" in stepB) {
        if ("retain" in stepA) {
          const marks = composeMarkPatches(stepA.marks, stepB.marks);
          out.push(marks ? { retain: len, marks } : { retain: len });
        } else if ("insert" in stepA) {
          const isEmbed = typeof stepA.insert !== "string";
          const marks = applyMarkPatch(cleanMarks(stepA.marks, isEmbed), stepB.marks, isEmbed);
          out.push(Object.keys(marks).length ? { insert: stepA.insert, marks } : { insert: stepA.insert });
        }
      } else if ("delete" in stepB) {
        if ("retain" in stepA) out.push({ delete: len });
        // If stepA was insert and stepB deletes it, they cancel out.
      }
    }
  }
  return compactTextOps(out);
}

/**
 * Symmetric TP1 text transformation:
 * `left` is the earlier (server-committed) op; `right` is the later concurrent op.
 * Returns `[leftPrime, rightPrime]` such that:
 * `apply(apply(S, left), rightPrime) === apply(apply(S, right), leftPrime)`.
 *
 * Tie-break rules:
 * - Same-position inserts: `left` comes before `right`.
 * - Same-key concurrent marks on overlapping retains: `right` (later commit) wins;
 *   disjoint mark keys both survive.
 */
export function transformTextPair(
  left: readonly TextStep[],
  right: readonly TextStep[],
): [TextStep[], TextStep[]] {
  const iterL = new StepCursor(compactTextOps(left));
  const iterR = new StepCursor(compactTextOps(right));
  const leftPrime: TextStep[] = [];
  const rightPrime: TextStep[] = [];

  while (iterL.hasNext() || iterR.hasNext()) {
    if (iterL.peekType() === "insert") {
      const stepL = iterL.take();
      leftPrime.push(stepL);
      rightPrime.push({ retain: stepLength(stepL) });
      continue;
    }
    if (iterR.peekType() === "insert") {
      const stepR = iterR.take();
      rightPrime.push(stepR);
      leftPrime.push({ retain: stepLength(stepR) });
      continue;
    }

    const len = Math.min(iterL.peekLength(), iterR.peekLength());
    const stepL = iterL.take(len);
    const stepR = iterR.take(len);

    if ("delete" in stepL && "delete" in stepR) {
      // Both deleted the exact same range.
      continue;
    }
    if ("delete" in stepL) {
      leftPrime.push({ delete: len });
      continue;
    }
    if ("delete" in stepR) {
      rightPrime.push({ delete: len });
      continue;
    }
    if ("retain" in stepL && "retain" in stepR) {
      // Right wins on overlapping mark keys so both sides converge identically.
      const lMarks: MarkPatch = {};
      if (stepL.marks) {
        for (const [key, value] of Object.entries(stepL.marks)) {
          if (!stepR.marks || !(key in stepR.marks)) lMarks[key] = structuredClone(value);
        }
      }
      leftPrime.push(Object.keys(lMarks).length ? { retain: len, marks: lMarks } : { retain: len });
      rightPrime.push(stepR.marks ? { retain: len, marks: structuredClone(stepR.marks) } : { retain: len });
    }
  }

  return [compactTextOps(leftPrime), compactTextOps(rightPrime)];
}

/**
 * Transform a text op against a concurrent split at `splitOffset`.
 *
 * Returns:
 * - `leftOps`: operations targeting the left block (`0..splitOffset`)
 * - `rightOps`: operations targeting the newly split right block (re-indexed from 0)
 * - `nextSplitOffset`: transformed split offset if `ops` ran BEFORE the split (TP1 dual)
 *
 * Tie-break rule: insertions at exactly `splitOffset` stay at the end of the left block,
 * and `nextSplitOffset` shifts right past them so both execution orders converge identically.
 */
export function splitTextOpsAt(
  ops: readonly TextStep[],
  splitOffset: number,
): { leftOps: TextStep[]; rightOps: TextStep[]; nextSplitOffset: number } {
  const leftOps: TextStep[] = [];
  const rightOps: TextStep[] = [];
  let oldPos = 0;
  let nextSplitOffset = splitOffset;

  for (const step of compactTextOps(ops)) {
    if ("insert" in step) {
      const len = stepLength(step);
      if (oldPos <= splitOffset) {
        leftOps.push(structuredClone(step));
        nextSplitOffset += len;
      } else {
        rightOps.push(structuredClone(step));
      }
      continue;
    }

    const len = stepLength(step);
    const stepEnd = oldPos + len;

    if (stepEnd <= splitOffset) {
      leftOps.push(structuredClone(step));
      if ("delete" in step) nextSplitOffset -= len;
    } else if (oldPos >= splitOffset) {
      rightOps.push(structuredClone(step));
    } else {
      // Crosses splitOffset: partition cleanly into left and right portions.
      const leftLen = splitOffset - oldPos;
      const rightLen = len - leftLen;
      if ("retain" in step) {
        leftOps.push(step.marks ? { retain: leftLen, marks: structuredClone(step.marks) } : { retain: leftLen });
        rightOps.push(step.marks ? { retain: rightLen, marks: structuredClone(step.marks) } : { retain: rightLen });
      } else if ("delete" in step) {
        leftOps.push({ delete: leftLen });
        rightOps.push({ delete: rightLen });
        nextSplitOffset -= leftLen;
      }
    }
    oldPos = stepEnd;
  }

  return {
    leftOps: compactTextOps(leftOps),
    rightOps: compactTextOps(rightOps),
    nextSplitOffset: Math.max(0, nextSplitOffset),
  };
}

/** Shift a TextStep list right by `offset` (used when re-homing text ops after a merge). */
export function shiftTextOps(ops: readonly TextStep[], offset: number): TextStep[] {
  const compact = compactTextOps(ops);
  if (!compact.length || offset <= 0) return compact;
  return compactTextOps([{ retain: offset }, ...compact]);
}

/**
 * Invert `ops` applied to `before` so `applyTextOps(applyTextOps(before, ops), inv) === before`.
 */
export function invertTextOps(before: RichText, ops: readonly TextStep[]): TextStep[] {
  const normalized = normalizeRichText(before);
  const inv: TextStep[] = [];
  let cursor = 0;

  for (const step of compactTextOps(ops)) {
    if ("insert" in step) {
      inv.push({ delete: stepLength(step) });
    } else if ("delete" in step) {
      const removed = sliceRichText(normalized, cursor, cursor + step.delete);
      for (const run of removed) {
        if (run.embed !== undefined) {
          const marks = cleanMarks(run.marks, true);
          inv.push(Object.keys(marks).length ? { insert: { embed: structuredClone(run.embed) }, marks } : { insert: { embed: structuredClone(run.embed) } });
        } else if (typeof run.text === "string" && run.text.length) {
          const marks = cleanMarks(run.marks, false);
          inv.push(Object.keys(marks).length ? { insert: run.text, marks } : { insert: run.text });
        }
      }
      cursor += step.delete;
    } else if ("retain" in step) {
      if (!step.marks) {
        inv.push({ retain: step.retain });
      } else {
        const sliced = sliceRichText(normalized, cursor, cursor + step.retain);
        for (const run of sliced) {
          const isEmbed = run.embed !== undefined;
          const runLen = isEmbed ? 1 : (typeof run.text === "string" ? run.text.length : 0);
          const prevMarks = cleanMarks(run.marks, isEmbed);
          const nextMarks = applyMarkPatch(prevMarks, step.marks, isEmbed);
          const revert = marksDelta(nextMarks, prevMarks);
          inv.push(revert ? { retain: runLen, marks: revert } : { retain: runLen });
        }
      }
      cursor += step.retain;
    }
  }

  return compactTextOps(inv);
}

/** Transform a UTF-16 caret/anchor offset across `ops`. */
export function transformTextOffset(offset: number, ops: readonly TextStep[], bias: "left" | "right" = "right"): number {
  let oldPos = 0;
  let newPos = 0;
  for (const step of compactTextOps(ops)) {
    if ("insert" in step) {
      const len = stepLength(step);
      if (oldPos < offset || (oldPos === offset && bias === "right")) {
        newPos += len;
      } else {
        return newPos;
      }
      continue;
    }
    const len = stepLength(step);
    if ("retain" in step) {
      if (oldPos + len > offset || (oldPos + len === offset && bias === "left")) {
        return newPos + (offset - oldPos);
      }
      oldPos += len;
      newPos += len;
    } else if ("delete" in step) {
      if (oldPos + len > offset) {
        return newPos;
      }
      oldPos += len;
      if (oldPos === offset && bias === "left") {
        return newPos;
      }
    }
  }
  return newPos + Math.max(0, offset - oldPos);
}

/** Extract only inserted runs from a list of TextSteps (for orphan text preservation). */
export function extractInsertedRuns(ops: readonly TextStep[]): RichText {
  const out: RichText = [];
  for (const step of ops) {
    if (!("insert" in step)) continue;
    if (typeof step.insert === "string") {
      if (!step.insert.length) continue;
      const marks = cleanMarks(step.marks, false);
      out.push(Object.keys(marks).length ? { text: step.insert, marks } : { text: step.insert });
    } else {
      const marks = cleanMarks(step.marks, true);
      out.push(Object.keys(marks).length ? { embed: structuredClone(step.insert.embed), marks } : { embed: structuredClone(step.insert.embed) });
    }
  }
  return normalizeRichText(out);
}

type DiffChunk<T> = { kind: "equal"; aStart: number; bStart: number; count: number }
  | { kind: "delete"; aStart: number; count: number }
  | { kind: "insert"; bStart: number; count: number };

const MAX_MYERS_D = 512;

/**
 * Zero-dependency Myers O(ND) diff over arbitrary arrays with a bounded edit-distance
 * fallback so pathological huge pastes stay sub-millisecond.
 */
function myersDiff<T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean): DiffChunk<T>[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return [{ kind: "insert", bStart: 0, count: m }];
  if (m === 0) return [{ kind: "delete", aStart: 0, count: n }];

  // Fast O(N) common prefix & suffix trim.
  let prefix = 0;
  while (prefix < n && prefix < m && eq(a[prefix], b[prefix])) prefix += 1;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && eq(a[n - 1 - suffix], b[m - 1 - suffix])) suffix += 1;

  const chunks: DiffChunk<T>[] = [];
  if (prefix > 0) chunks.push({ kind: "equal", aStart: 0, bStart: 0, count: prefix });

  const midAStart = prefix;
  const midBStart = prefix;
  const midN = n - prefix - suffix;
  const midM = m - prefix - suffix;

  if (midN === 0 && midM > 0) {
    chunks.push({ kind: "insert", bStart: midBStart, count: midM });
  } else if (midM === 0 && midN > 0) {
    chunks.push({ kind: "delete", aStart: midAStart, count: midN });
  } else if (midN > 0 && midM > 0) {
    const maxD = Math.min(midN + midM, MAX_MYERS_D);
    const offset = maxD;
    const v = new Int32Array(2 * maxD + 1);
    const trace: Int32Array[] = [];
    let foundD = -1;

    for (let d = 0; d <= maxD; d += 1) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x: number;
        if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
          x = v[offset + k + 1];
        } else {
          x = v[offset + k - 1] + 1;
        }
        let y = x - k;
        while (x < midN && y < midM && eq(a[midAStart + x], b[midBStart + y])) {
          x += 1;
          y += 1;
        }
        v[offset + k] = x;
        if (x >= midN && y >= midM) {
          foundD = d;
          break;
        }
      }
      if (foundD >= 0) break;
    }

    if (foundD < 0) {
      // Edit distance exceeded bound: clean replace of the middle region.
      chunks.push({ kind: "delete", aStart: midAStart, count: midN });
      chunks.push({ kind: "insert", bStart: midBStart, count: midM });
    } else {
      const midChunks: DiffChunk<T>[] = [];
      let x = midN;
      let y = midM;
      for (let d = foundD; d > 0; d -= 1) {
        const prevV = trace[d];
        const k = x - y;
        let prevK: number;
        if (k === -d || (k !== d && prevV[offset + k - 1] < prevV[offset + k + 1])) {
          prevK = k + 1;
        } else {
          prevK = k - 1;
        }
        const prevX = prevV[offset + prevK];
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) {
          x -= 1;
          y -= 1;
          pushMergedChunk(midChunks, { kind: "equal", aStart: midAStart + x, bStart: midBStart + y, count: 1 });
        }
        if (x === prevX) {
          y -= 1;
          pushMergedChunk(midChunks, { kind: "insert", bStart: midBStart + y, count: 1 });
        } else {
          x -= 1;
          pushMergedChunk(midChunks, { kind: "delete", aStart: midAStart + x, count: 1 });
        }
      }
      while (x > 0 && y > 0) {
        x -= 1;
        y -= 1;
        pushMergedChunk(midChunks, { kind: "equal", aStart: midAStart + x, bStart: midBStart + y, count: 1 });
      }
      midChunks.reverse();
      for (const chunk of midChunks) chunks.push(chunk);
    }
  }

  if (suffix > 0) {
    chunks.push({ kind: "equal", aStart: n - suffix, bStart: m - suffix, count: suffix });
  }
  return chunks;
}

function pushMergedChunk<T>(list: DiffChunk<T>[], item: DiffChunk<T>): void {
  const prev = list.at(-1);
  if (!prev || prev.kind !== item.kind) {
    list.push(item);
    return;
  }
  if (prev.kind === "equal" && item.kind === "equal" && item.aStart + item.count === prev.aStart && item.bStart + item.count === prev.bStart) {
    prev.aStart = item.aStart;
    prev.bStart = item.bStart;
    prev.count += item.count;
    return;
  }
  if (prev.kind === "delete" && item.kind === "delete" && item.aStart + item.count === prev.aStart) {
    prev.aStart = item.aStart;
    prev.count += item.count;
    return;
  }
  if (prev.kind === "insert" && item.kind === "insert" && item.bStart + item.count === prev.bStart) {
    prev.bStart = item.bStart;
    prev.count += item.count;
    return;
  }
  list.push(item);
}

/**
 * Compute minimal TextSteps turning `before` into `after`:
 * - O(N) prefix/suffix fast path for ordinary typing/deletion/format toggles
 * - Myers O(ND) diff for disjoint edits (spellcheck, linkify, paste)
 * - Unicode code-point atoms guarantee UTF-16 surrogate pairs are never split.
 */
export function diffRichText(before: RichText, after: RichText): TextStep[] {
  const a = toAtoms(before);
  const b = toAtoms(after);
  const chunks = myersDiff(a, b, sameAtomValue);
  const ops: TextStep[] = [];

  for (const chunk of chunks) {
    if (chunk.kind === "equal") {
      for (let i = 0; i < chunk.count; i += 1) {
        const left = a[chunk.aStart + i];
        const right = b[chunk.bStart + i];
        const delta = marksDelta(left.marks, right.marks);
        ops.push(delta ? { retain: atomLength(left), marks: delta } : { retain: atomLength(left) });
      }
    } else if (chunk.kind === "delete") {
      let delLen = 0;
      for (let i = 0; i < chunk.count; i += 1) delLen += atomLength(a[chunk.aStart + i]);
      ops.push({ delete: delLen });
    } else if (chunk.kind === "insert") {
      for (let i = 0; i < chunk.count; i += 1) {
        const atom = b[chunk.bStart + i];
        if (atom.kind === "text") {
          ops.push(Object.keys(atom.marks).length ? { insert: atom.text, marks: atom.marks } : { insert: atom.text });
        } else {
          ops.push(Object.keys(atom.marks).length ? { insert: { embed: atom.embed }, marks: atom.marks } : { insert: { embed: atom.embed } });
        }
      }
    }
  }

  return compactTextOps(ops);
}

/**
 * Character-level plain string diff (Unicode code-point safe) for UI proposal previews.
 * Replaces `diffChars` from the `diff` npm package.
 */
export function diffPlainChars(before: string, after: string): Array<{ value: string; added?: boolean; removed?: boolean }> {
  if (before === after) return before ? [{ value: before }] : [];
  const a = Array.from(before);
  const b = Array.from(after);
  const chunks = myersDiff(a, b, (x, y) => x === y);
  const result: Array<{ value: string; added?: boolean; removed?: boolean }> = [];
  for (const chunk of chunks) {
    if (chunk.kind === "equal") {
      result.push({ value: a.slice(chunk.aStart, chunk.aStart + chunk.count).join("") });
    } else if (chunk.kind === "delete") {
      result.push({ value: a.slice(chunk.aStart, chunk.aStart + chunk.count).join(""), removed: true });
    } else {
      result.push({ value: b.slice(chunk.bStart, chunk.bStart + chunk.count).join(""), added: true });
    }
  }
  return result;
}
