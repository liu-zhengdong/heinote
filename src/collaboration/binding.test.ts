import { afterEach, describe, expect, it } from "vitest";
import { installTextLookup, refreshTextBinding, renderedText, setObservedShown, withTextBasis, type RegisteredField } from "./binding";

function field(epoch: string, content: string): RegisteredField {
  return {
    pageId: "page",
    key: "field",
    epoch,
    generation: epoch,
    canEdit: true,
    runs: content ? [{ text: content }] : [],
  };
}

afterEach(() => { installTextLookup(() => null); });

describe("binding after an epoch changes", () => {
  it("adopts the new field identity only when its words still match the drawn basis", () => {
    let current = field("e1", "local words");
    installTextLookup(() => current);
    const drawn = renderedText("page", "field")!;
    current = field("e2", "local words");
    expect(refreshTextBinding(drawn)?.field.epoch).toBe("e2");
    current = field("e3", "remote replacement");
    expect(refreshTextBinding(drawn)).toBeNull();
  });

  it("keeps the old observed basis for unseen edits in the same epoch", () => {
    const current = field("e1", "base");
    installTextLookup(() => current);
    const drawn = renderedText("page", "field")!;
    current.runs = [{ text: "REMOTEbase" }];
    expect(refreshTextBinding(drawn)).toBe(drawn);
    expect(drawn.shown).toEqual([{ text: "base" }]);
    installTextLookup(() => null);
    expect(refreshTextBinding(drawn)).toBeNull();
  });

  it("updates active observed basis inside withTextBasis", () => {
    const current = field("e1", "hello");
    installTextLookup(() => current);
    const drawn = renderedText("page", "field")!;
    const updated = withTextBasis(drawn, () => {
      setObservedShown(current, [{ text: "hello world" }]);
    });
    expect(updated?.shown).toEqual([{ text: "hello world" }]);
  });
});
