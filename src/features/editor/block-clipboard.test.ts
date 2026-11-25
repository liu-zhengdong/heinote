import { describe, expect, it } from "vitest";
import { createBlock } from "../../core/block-tree";
import { MENTION_CHAR } from "../../core/inline-content";
import type { StoredFile } from "../../core/types";
import { singleCopiedImage } from "./block-clipboard";

const SAMPLE_FILE: StoredFile = {
  path: "files/page_1/file_1/photo.png",
  owner: "user_1",
  name: "photo.png",
  size: 1024,
  type: "image/png",
  width: 200,
  height: 120,
};

describe("singleCopiedImage", () => {
  it("identifies a copied fragment containing a single standalone image block", () => {
    const imageMention = { kind: "image" as const, file: SAMPLE_FILE };
    const imageBlock = createBlock("b1", "text", { content: [{ text: MENTION_CHAR, mention: imageMention }] });
    expect(singleCopiedImage({ by_id: { b1: imageBlock } })).toEqual(imageMention);

    const textBlock = createBlock("b2", "text", { content: [{ text: "hello" }] });
    expect(singleCopiedImage({ by_id: { b1: imageBlock, b2: textBlock } })).toBeNull();
    expect(singleCopiedImage({ by_id: { b2: textBlock } })).toBeNull();
  });
});
