import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { installTextLookup, refreshTextBinding, renderedText, type RegisteredField } from "./binding";
import { captureText, editText } from "./text";

const docs: Y.Doc[] = [];
function field(generation: string, content: string): RegisteredField {
  const doc = new Y.Doc(); docs.push(doc); const text = doc.getText("field");
  editText(text, captureText(text), [{ text: content }]);
  return { pageId: "page", key: "field", generation, canEdit: true, text };
}
afterEach(() => { installTextLookup(() => null); docs.splice(0).forEach((doc) => doc.destroy()); });

describe("binding after a generation changes", () => {
  it("adopts the new field identity only when its words still match the drawn basis", () => {
    let current = field("g1", "local words"); installTextLookup(() => current);
    const drawn = renderedText("page", "field")!;
    current = field("g2", "local words");
    expect(refreshTextBinding(drawn)?.field.text).toBe(current.text);
    current = field("g3", "remote replacement");
    expect(refreshTextBinding(drawn)).toBeNull();
  });

  it("keeps the old observed basis for unseen edits in the same field", () => {
    const current = field("g1", "base"); installTextLookup(() => current);
    const drawn = renderedText("page", "field")!;
    current.text.insert(0, "REMOTE");
    expect(refreshTextBinding(drawn)).toBe(drawn);
    installTextLookup(() => null); expect(refreshTextBinding(drawn)).toBeNull();
  });
});
