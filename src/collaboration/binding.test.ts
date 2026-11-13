import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { RichText } from "../platform/schema";
import { blockField } from "./protocol";
import { editObservedField, installTextLookup, withTextBasis, type RegisteredField } from "./binding";
import { fieldOf, readText, seedFields } from "./text";

const runs = (text: string): RichText => text ? [{ text }] : [];
const key = blockField("4_page_block");
function fixture(text: string): { doc: Y.Doc; field: RegisteredField } {
  const doc = new Y.Doc();
  seedFields(doc, { [key]: runs(text) });
  const target = fieldOf(doc, key);
  return { doc, field: { pageId: "page", key, generation: "g1", text: target, canEdit: true } };
}

describe("a commit before its binding exists", () => {
  it("keeps shared words the DOM never drew: the fresh basis only covers what was seen", () => {
    const { doc, field } = fixture("乙的文字组合基线");
    installTextLookup(() => field);
    // The element mounted before the session arrived, so `bound` is null —
    // but the DOM showed "组合基线" before the peer's insert ever reached it.
    withTextBasis(null, () => {
      doc.transact(() => editObservedField(field, runs("组合基线中文输入")));
    }, { key, content: runs("组合基线") });
    expect(readText(field.text).map((run) => run.text ?? "").join("")).toBe("乙的文字组合基线中文输入");
    doc.destroy();
  });

  it("without a shown basis the whole-field diff keeps record semantics", () => {
    const { doc, field } = fixture("乙的文字组合基线");
    installTextLookup(() => field);
    withTextBasis(null, () => {
      doc.transact(() => editObservedField(field, runs("组合基线中文输入")));
    });
    // Record writes mean whole-field intent: no `seen` claims otherwise.
    expect(readText(field.text).map((run) => run.text ?? "").join("")).toBe("组合基线中文输入");
    doc.destroy();
  });
});
