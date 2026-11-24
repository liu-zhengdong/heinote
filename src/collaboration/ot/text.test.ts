import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RichText } from "../../platform/schema";
import { sha256Hex } from "./sha256";
import {
  applyTextOps,
  composeTextOps,
  diffPlainChars,
  diffRichText,
  extractInsertedRuns,
  invertTextOps,
  isValidTextBoundary,
  normalizeRichText,
  richTextLength,
  richTextPlain,
  splitRichText,
  splitTextOpsAt,
  transformTextOffset,
  transformTextPair,
  validateTextOps,
} from "./text";
import type { TextStep } from "./types";

describe("sha256", () => {
  it("matches node:crypto sha256 across empty, short, multi-block, and UTF-8 inputs", () => {
    const samples = [
      "",
      "abc",
      "a".repeat(55),
      "a".repeat(56),
      "a".repeat(64),
      "a".repeat(128),
      "你好小黑笔记🚀🎉" + "x".repeat(1000),
    ];
    for (const sample of samples) {
      const bytes = new TextEncoder().encode(sample);
      const expected = createHash("sha256").update(bytes).digest("hex");
      expect(sha256Hex(bytes)).toBe(expected);
    }
  });
});

describe("rich-text OT core", () => {
  it("enforces mention forbidden marks (code, link) while keeping allowed marks", () => {
    const runs: RichText = [
      { embed: { mention: { kind: "page", page_id: "p1" } }, marks: { bold: true, code: true, link: "https://a.test", color: "red" } },
    ];
    const normalized = normalizeRichText(runs);
    expect(normalized).toEqual([
      { embed: { mention: { kind: "page", page_id: "p1" } }, marks: { bold: true, color: "red" } },
    ]);
  });

  it("protects UTF-16 emoji surrogate pairs in boundaries and diffRichText", () => {
    const before: RichText = [{ text: "Hi 🎉 world" }];
    // "Hi " = 3, "🎉" = 2 (UTF-16 indices 3..5)
    expect(isValidTextBoundary(before, 3)).toBe(true);
    expect(isValidTextBoundary(before, 4)).toBe(false);
    expect(isValidTextBoundary(before, 5)).toBe(true);
    expect(validateTextOps(before, [{ retain: 4 }, { insert: "x" }])).not.toBeNull();

    const after: RichText = [{ text: "Hi 🚀🎉 world!" }];
    const ops = diffRichText(before, after);
    expect(validateTextOps(before, ops)).toBeNull();
    expect(applyTextOps(before, ops)).toEqual(after);
  });

  it("produces minimal Myers diff for disjoint multi-site edits and pure format toggles", () => {
    const before: RichText = [{ text: "The quick brown fox jumps over the lazy dog" }];
    const after: RichText = [
      { text: "The " },
      { text: "fast", marks: { bold: true } },
      { text: " brown fox jumps over the " },
      { text: "sleepy" },
      { text: " dog" },
    ];
    const ops = diffRichText(before, after);
    expect(applyTextOps(before, ops)).toEqual(normalizeRichText(after));
    // Must retain the unchanged middle segment instead of replacing the whole paragraph.
    expect(ops.some((step) => "retain" in step && step.retain >= 20)).toBe(true);

    const formatted: RichText = [
      { text: "The " },
      { text: "quick", marks: { bold: true, italic: true } },
      { text: " brown fox jumps over the lazy dog" },
    ];
    const fmtOps = diffRichText(before, formatted);
    expect(fmtOps.every((step) => "retain" in step)).toBe(true);
    expect(applyTextOps(before, fmtOps)).toEqual(formatted);
  });

  it("satisfies compose associativity and invertibility", () => {
    const doc: RichText = [
      { text: "Hello " },
      { embed: { mention: { kind: "page", page_id: "p1" } } },
      { text: " 🎉 world", marks: { italic: true } },
    ];
    const a: TextStep[] = [{ retain: 6 }, { insert: "dear ", marks: { bold: true } }, { retain: 1 }, { delete: 3 }];
    const b: TextStep[] = [{ retain: 2 }, { retain: 9, marks: { color: "blue", italic: null } }, { insert: "!" }];
    const afterA = applyTextOps(doc, a);
    const afterAB = applyTextOps(afterA, b);
    const composed = composeTextOps(a, b);
    expect(applyTextOps(doc, composed)).toEqual(afterAB);

    const invA = invertTextOps(doc, a);
    expect(applyTextOps(afterA, invA)).toEqual(normalizeRichText(doc));
    const invAB = invertTextOps(doc, composed);
    expect(applyTextOps(afterAB, invAB)).toEqual(normalizeRichText(doc));
  });

  it("satisfies TP1 for concurrent inserts, deletes, overlapping marks, and mentions", () => {
    const base: RichText = [{ text: "abcdef" }];
    const pairs: Array<[TextStep[], TextStep[]]> = [
      // Same-offset insert: left wins order
      [[{ retain: 3 }, { insert: "L" }], [{ retain: 3 }, { insert: "R" }]],
      // Overlapping deletes
      [[{ retain: 1 }, { delete: 3 }], [{ retain: 2 }, { delete: 3 }]],
      // Concurrent disjoint & overlapping marks (right wins on same key)
      [
        [{ retain: 1 }, { retain: 4, marks: { bold: true, color: "red" } }],
        [{ retain: 2 }, { retain: 3, marks: { italic: true, color: "blue" } }],
      ],
      // Concurrent mention insert + format range
      [
        [{ retain: 2 }, { insert: { embed: { mention: { kind: "page", page_id: "p2" } } } }],
        [{ retain: 1 }, { retain: 4, marks: { code: true, bold: true } }],
      ],
    ];
    for (const [left, right] of pairs) {
      const [leftPrime, rightPrime] = transformTextPair(left, right);
      const pathLR = applyTextOps(applyTextOps(base, left), rightPrime);
      const pathRL = applyTextOps(applyTextOps(base, right), leftPrime);
      expect(pathLR).toEqual(pathRL);
    }
  });

  it("satisfies TP1 dual for splitTextOpsAt across boundary insertions and straddling edits", () => {
    const base: RichText = [{ text: "HelloWorld" }];
    const cases: Array<{ offset: number; ops: TextStep[] }> = [
      { offset: 5, ops: [{ retain: 5 }, { insert: "!!!" }] }, // exact boundary insert stays left
      { offset: 5, ops: [{ retain: 3 }, { delete: 4 }, { insert: "X" }] }, // straddling delete + replace
      { offset: 5, ops: [{ retain: 2 }, { retain: 6, marks: { bold: true } }] }, // straddling format
      { offset: 5, ops: [{ retain: 7 }, { insert: "🌍" }] }, // strictly right
      { offset: 5, ops: [{ delete: 2 }, { insert: "A" }] }, // strictly left
    ];
    for (const { offset, ops } of cases) {
      // Path 1: split first, then apply leftOps/rightOps
      const [left0, right0] = splitRichText(base, offset);
      const { leftOps, rightOps, nextSplitOffset } = splitTextOpsAt(ops, offset);
      const p1Left = applyTextOps(left0, leftOps);
      const p1Right = applyTextOps(right0, rightOps);

      // Path 2: apply ops first, then split at nextSplitOffset
      const edited = applyTextOps(base, ops);
      const [p2Left, p2Right] = splitRichText(edited, nextSplitOffset);

      expect(p1Left).toEqual(p2Left);
      expect(p1Right).toEqual(p2Right);
      expect(transformTextOffset(offset, ops, "right")).toBe(nextSplitOffset);
    }
  });

  it("extractInsertedRuns captures inserted content for orphan preservation and diffPlainChars works", () => {
    const inserted = extractInsertedRuns([{ retain: 2 }, { delete: 3 }, { insert: "保存我", marks: { bold: true } }]);
    expect(richTextPlain(inserted)).toBe("保存我");
    expect(richTextLength(inserted)).toBe(3);

    const diff = diffPlainChars("你好世界🎉", "你好小黑世界🎉!");
    expect(diff.filter((p) => !p.removed).map((p) => p.value).join("")).toBe("你好小黑世界🎉!");
    expect(diff.filter((p) => !p.added).map((p) => p.value).join("")).toBe("你好世界🎉");
  });
});
