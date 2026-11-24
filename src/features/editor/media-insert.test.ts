import { describe, expect, it } from "vitest";
import { createBlock } from "../../core/block-tree";
import { slashCommands } from "./SlashMenu";
import { mediaLanding } from "./useMedia";

describe("slashCommands media entries", () => {
  it("lists Image and File in the Media section with English and Chinese aliases", () => {
    const all = slashCommands("");
    const image = all.find((cmd) => cmd.id === "image");
    const file = all.find((cmd) => cmd.id === "file");
    expect(image?.group).toBe("Media");
    expect(image?.action).toBe("image");
    expect(file?.group).toBe("Media");
    expect(file?.action).toBe("file");

    expect(slashCommands("/image")[0]?.id).toBe("image");
    expect(slashCommands("/img")[0]?.id).toBe("image");
    expect(slashCommands("/图片")[0]?.id).toBe("image");
    expect(slashCommands("/file")[0]?.id).toBe("file");
    expect(slashCommands("/attachment")[0]?.id).toBe("file");
    expect(slashCommands("/文件")[0]?.id).toBe("file");
  });
});

describe("mediaLanding", () => {
  it("fills empty editable blocks in place for both images and files", () => {
    const emptyText = createBlock("b1", "text");
    const emptyTodo = createBlock("b2", "todo", { checked: false });
    const emptyFile = createBlock("b3", "file");

    expect(mediaLanding(emptyText, "image")).toEqual({ kind: "line", blockId: "b1", edge: "fill" });
    expect(mediaLanding(emptyText, "file")).toEqual({ kind: "line", blockId: "b1", edge: "fill" });
    expect(mediaLanding(emptyTodo, "image")).toEqual({ kind: "line", blockId: "b2", edge: "fill" });
    expect(mediaLanding(emptyFile, "file")).toEqual({ kind: "line", blockId: "b3", edge: "fill" });
  });

  it("places images inline inside non-empty text blocks and files on a line after", () => {
    const line = createBlock("b1", "text", { content: [{ text: "hello world" }] });

    expect(mediaLanding(line, "image", line.content, { start: 6, end: 6 })).toEqual({
      kind: "words", blockId: "b1", start: 6, end: 6,
    });
    expect(mediaLanding(line, "image", line.content)).toEqual({
      kind: "words", blockId: "b1", start: 11, end: 11,
    });
    expect(mediaLanding(line, "file", line.content, { start: 6, end: 6 })).toEqual({
      kind: "line", blockId: "b1", edge: "after",
    });
  });

  it("places media on a new line after code, populated file, and non-editable blocks", () => {
    const emptyCode = createBlock("c1", "code");
    const filledFile = createBlock("f1", "file", {
      file: { path: "files/p/1/a.txt", owner: "u1", name: "a.txt", size: 4, type: "text/plain" },
    });
    const divider = createBlock("d1", "divider");

    expect(mediaLanding(emptyCode, "image")).toEqual({ kind: "line", blockId: "c1", edge: "after" });
    expect(mediaLanding(emptyCode, "file")).toEqual({ kind: "line", blockId: "c1", edge: "after" });
    expect(mediaLanding(filledFile, "image")).toEqual({ kind: "line", blockId: "f1", edge: "after" });
    expect(mediaLanding(filledFile, "file")).toEqual({ kind: "line", blockId: "f1", edge: "after" });
    expect(mediaLanding(divider, "image")).toEqual({ kind: "line", blockId: "d1", edge: "after" });
  });
});
