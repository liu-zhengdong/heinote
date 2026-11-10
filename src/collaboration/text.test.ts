import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { RichText } from "../platform/schema";
import { blockField, cellField, titleField } from "./protocol";
import { captureSelection, captureText, editText, fieldOf, readFields, readText, resolveSelection, seedFields, updateFields } from "./text";

const key = blockField("8_page-id_block-id");
const runs = (text: string): RichText => text ? [{ text }] : [];
const words = (text: Y.Text) => readText(text).map((run) => run.text ?? "\u2063").join("");
function create(content: RichText = []) {
  const doc = new Y.Doc();
  seedFields(doc, { [key]: content });
  return { doc, text: fieldOf(doc, key) };
}
function fork(doc: Y.Doc) {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return { doc: copy, text: fieldOf(copy, key) };
}

// The expectation is the visible intent and convergence, not Yjs item layout.
describe("shared text fields", () => {
  it("round-trips marks, atomic embeds and empty title/cell fields", () => {
    const mention = { mention: { kind: "page", page_id: "other" } };
    const content: RichText = [{ text: "你好😀", marks: { bold: true } }, { embed: mention }, { text: "尾", marks: { link: "#other" } }];
    const { doc, text } = create(content);
    expect(readText(text)).toEqual(content);
    const cell = cellField("record/with/slash", "row-1", "column-2");
    updateFields(doc, { [titleField("page/one")]: [], [cell]: [] }, "initial-fields");
    expect(readFields(doc)).toEqual({ [key]: content, [titleField("page/one")]: [], [cell]: [] });
    expect(() => fieldOf(doc, "pages/page/updated_by")).toThrow();
    expect(() => fieldOf(doc, "blocks/block/table/rows/row/cells/__proto__")).toThrow();
    expect(() => seedFields(doc, { [key]: runs("overwrite") })).toThrow();
    expect(words(text)).toBe("你好😀\u2063尾");
  });

  it("preserves every concurrent insertion when fork updates arrive out of order or twice", () => {
    const { doc, text } = create(runs("甲乙"));
    const b = fork(doc); const c = fork(doc);
    doc.transact(() => editText(text, captureText(text), runs("甲A乙")), "a");
    b.doc.transact(() => editText(b.text, captureText(b.text), runs("甲乙B")), "b");
    c.doc.transact(() => editText(c.text, captureText(c.text), runs("C甲乙")), "c");
    const updates = [doc, b.doc, c.doc].map((item) => Y.encodeStateAsUpdate(item));
    for (const target of [doc, b.doc, c.doc]) for (const update of updates.toReversed()) { Y.applyUpdate(target, update); Y.applyUpdate(target, update); }
    expect(words(text)).toBe("C甲A乙B");
    expect(words(b.text)).toBe(words(text)); expect(words(c.text)).toBe(words(text));
    const reloaded = fork(doc); expect(readText(reloaded.text)).toEqual(readText(text));
  });

  it("keeps both inserts at the same observed position without prescribing client-ID order", () => {
    const a = create(runs("ab")); const b = fork(a.doc);
    a.doc.transact(() => editText(a.text, captureText(a.text), runs("aAb")), "a");
    b.doc.transact(() => editText(b.text, captureText(b.text), runs("aBb")), "b");
    const au = Y.encodeStateAsUpdate(a.doc); const bu = Y.encodeStateAsUpdate(b.doc);
    Y.applyUpdate(a.doc, bu); Y.applyUpdate(b.doc, au);
    expect(["aABb", "aBAb"]).toContain(words(a.text)); expect(words(b.text)).toBe(words(a.text));
  });

  it("deletes only observed identities and keeps an unseen remote insertion", () => {
    const a = create(runs("abcd")); const basis = captureText(a.text); const b = fork(a.doc);
    b.text.insert(2, "REMOTE"); Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
    a.doc.transact(() => editText(a.text, basis, runs("ad")), "a");
    expect(words(a.text)).toBe("aREMOTEd");
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc)); expect(words(b.text)).toBe("aREMOTEd");
  });

  it("does not adopt unseen remote characters into the returned DOM basis", () => {
    const a = create(runs("ab")); let basis = captureText(a.text); const b = fork(a.doc);
    b.text.insert(1, "X"); Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
    a.doc.transact(() => { basis = editText(a.text, basis, runs("aLb")); }, "local");
    expect(words(a.text)).toContain("X"); expect(words(a.text)).toContain("L");
    a.doc.transact(() => { basis = editText(a.text, basis, runs("ab")); }, "local");
    expect(words(a.text)).toBe("aXb");
    a.doc.transact(() => { basis = editText(a.text, basis, []); }, "local");
    expect(words(a.text)).toBe("X");
    a.doc.transact(() => { basis = editText(a.text, basis, runs("Q")); }, "local");
    expect(words(a.text).split("").sort().join("")).toBe("QX");
  });

  it("does not resurrect a remote-deleted observed character", () => {
    const a = create(runs("ab")); const basis = captureText(a.text); const b = fork(a.doc);
    b.text.delete(0, 1); Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
    const returned = editText(a.text, basis, [{ text: "a", marks: { bold: true } }, { text: "b!" }]);
    expect(words(a.text)).toBe("b!");
    editText(a.text, returned, runs("ab!?")); expect(words(a.text)).toBe("b!?");
  });

  it("formats only observed characters without replacing them or touching an unseen insert", () => {
    const a = create(runs("ab")); const basis = captureText(a.text); const b = fork(a.doc);
    const caret = captureSelection(basis, 1, 1);
    b.text.insert(1, "X", { italic: true }); Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
    editText(a.text, basis, [{ text: "ab", marks: { bold: true } }]);
    expect(readText(a.text)).toEqual([{ text: "a", marks: { bold: true } }, { text: "X", marks: { italic: true } }, { text: "b", marks: { bold: true } }]);
    expect(resolveSelection(a.text, caret)).not.toBeNull();
  });

  it("changes only mark keys changed by the local DOM", () => {
    const a = create([{ text: "ab", marks: { bold: true } }]); const basis = captureText(a.text); const b = fork(a.doc);
    b.text.format(0, 2, { italic: true }); Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
    editText(a.text, basis, runs("ab"));
    expect(readText(a.text)).toEqual([{ text: "ab", marks: { italic: true } }]);
    const after = captureText(a.text); editText(a.text, after, [{ text: "ab", marks: { italic: true, underline: true } }]);
    expect(readText(a.text)).toEqual([{ text: "ab", marks: { italic: true, underline: true } }]);
  });

  it("preserves mention identity during concurrent text and format edits", () => {
    const mention = { mention: { kind: "page", page_id: "target" } };
    const a = create([{ text: "a" }, { embed: mention }, { text: "b" }]); const basis = captureText(a.text); const b = fork(a.doc);
    b.text.insert(1, "X"); Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
    editText(a.text, basis, [{ text: "a" }, { embed: mention, marks: { bold: true } }, { text: "b!" }]);
    expect(readText(a.text)).toEqual([{ text: "aX" }, { embed: mention, marks: { bold: true } }, { text: "b!" }]);
    expect(a.text.length).toBe(5);
    editText(a.text, captureText(a.text), runs("aXb!")); expect(readText(a.text)).toEqual(runs("aXb!"));
  });

  it("keeps emoji pairs intact while replacing emoji with a shared high surrogate", () => {
    const a = create(runs("x😀y👩‍👩‍👦z"));
    editText(a.text, captureText(a.text), runs("x😃y👩‍👩‍👦z!"));
    expect(words(a.text)).toBe("x😃y👩‍👩‍👦z!");
    expect(a.text.length).toBe("x😃y👩‍👩‍👦z!".length);
    editText(a.text, captureText(a.text), runs("xy!")); expect(words(a.text)).toBe("xy!");
  });

  it("resolves selection anchors across remote prefix edits using UTF-16 offsets", () => {
    const a = create(runs("a😀bc")); const basis = captureText(a.text); const selection = captureSelection(basis, 3, 4); const b = fork(a.doc);
    b.text.insert(0, "远"); Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
    expect(resolveSelection(a.text, selection)).toEqual({ start: 4, end: 5 });
    expect(resolveSelection(b.text, selection)).toEqual({ start: 4, end: 5 });
    expect(resolveSelection(fieldOf(a.doc, titleField("other")), selection)).toBeNull();
    expect(resolveSelection(create(runs("a😀bc")).text, selection)).toBeNull();
  });

  it("keeps a caret attached to inserted DOM text without capturing a hidden remote suffix", () => {
    const a = create(runs("ab")); const basis = captureText(a.text); const b = fork(a.doc);
    b.text.insert(1, "X"); Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
    const returned = editText(a.text, basis, runs("aLb")); const caret = captureSelection(returned, 2, 2);
    const resolved = resolveSelection(a.text, caret)!;
    expect(words(a.text)[resolved.start - 1]).toBe("L"); expect(resolved.start).toBe(resolved.end);
  });

  it("keeps an expanded selection outside concurrent inserts at its two edges", () => {
    const a = create(runs("abcd")); const selection = captureSelection(captureText(a.text), 1, 3);
    const b = fork(a.doc); b.text.insert(1, "L"); b.text.insert(4, "R"); Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
    const resolved = resolveSelection(a.text, selection)!;
    expect(words(a.text).slice(resolved.start, resolved.end)).toBe("bc");
  });

  it("rejects a basis from another field or generation", () => {
    const a = create(runs("a")); const b = fork(a.doc);
    expect(() => editText(b.text, captureText(a.text), runs("b"))).toThrow();
    expect(() => editText(fieldOf(a.doc, titleField("other")), captureText(a.text), runs("b"))).toThrow();
  });

  it("lets an outer session origin undo only local edits, including one composition group", () => {
    const a = create(runs("base")); const b = fork(a.doc); const local = {}; const remote = {};
    const undo = new Y.UndoManager(a.text, { trackedOrigins: new Set([local]) });
    a.doc.transact(() => {
      let basis = editText(a.text, captureText(a.text), runs("base你"));
      basis = editText(a.text, basis, runs("base你好"));
    }, local);
    b.doc.transact(() => editText(b.text, captureText(b.text), runs("baseREMOTE")), remote);
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), "provider");
    expect(words(a.text)).toContain("你好"); expect(words(a.text)).toContain("REMOTE");
    undo.undo(); expect(words(a.text)).toBe("baseREMOTE");
    undo.redo(); expect(words(a.text)).toContain("你好"); expect(words(a.text)).toContain("REMOTE");
    undo.destroy();
  });

  it("buffers a dependent incremental update delivered before its prerequisite", () => {
    const a = create(runs("ab")); const b = fork(a.doc); const updates: Uint8Array[] = [];
    a.doc.on("update", (update: Uint8Array) => updates.push(update));
    a.doc.transact(() => editText(a.text, captureText(a.text), runs("a😀b")), "local");
    a.doc.transact(() => editText(a.text, captureText(a.text), [{ text: "a😀b!", marks: { bold: true } }]), "local");
    expect(updates).toHaveLength(2);
    Y.applyUpdate(b.doc, updates[1]); Y.applyUpdate(b.doc, updates[0]); Y.applyUpdate(b.doc, updates[1]);
    expect(readText(b.text)).toEqual(readText(a.text)); expect(words(b.text)).toBe("a😀b!");
  });

  it("removes one observed mention without removing an identical unseen mention", () => {
    const embed = { mention: { kind: "page", page_id: "target" } };
    const a = create([{ embed }]); const basis = captureText(a.text); const b = fork(a.doc);
    b.text.insertEmbed(0, embed); Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
    editText(a.text, basis, []);
    expect(readText(a.text)).toEqual([{ embed }]); expect(a.text.length).toBe(1);
  });

  it("undoes a composition from a stale DOM basis without undoing the hidden remote insert", () => {
    const a = create(runs("ab")); const basis = captureText(a.text); const b = fork(a.doc); const local = {};
    const undo = new Y.UndoManager(a.text, { trackedOrigins: new Set([local]) });
    b.text.insert(1, "X"); Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), "provider");
    a.doc.transact(() => editText(a.text, basis, runs("a你好b")), local);
    expect(words(a.text)).toContain("你好"); expect(words(a.text)).toContain("X");
    undo.undo(); expect(words(a.text)).toBe("aXb");
    undo.redo(); expect(words(a.text)).toContain("你好"); expect(words(a.text)).toContain("X");
    undo.destroy();
  });

  it("updates existing fields locally under the caller origin and preserves binary reload identity", () => {
    const a = create(runs("before")); const origin = {}; const undo = new Y.UndoManager(a.text, { trackedOrigins: new Set([origin]) });
    const selection = captureSelection(captureText(a.text), 3, 3);
    updateFields(a.doc, { [key]: runs("before after") }, origin);
    expect(words(a.text)).toBe("before after");
    const b = fork(a.doc); expect(resolveSelection(b.text, selection)).toEqual({ start: 3, end: 3 });
    undo.undo(); expect(words(a.text)).toBe("before");
    undo.destroy();
  });
});
