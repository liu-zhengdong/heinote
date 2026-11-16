import { describe, expect, it } from "vitest";
import { delimiterMark, markForKey, mentionOpener, wordsCanQueryMention } from "./marks";

describe("markForKey", () => {
  it("maps the usual keys, shift only where the mark asks for it", () => {
    expect(markForKey({ key: "b", shiftKey: false })).toBe("bold");
    expect(markForKey({ key: "e", shiftKey: false })).toBe("code");
    expect(markForKey({ key: "s", shiftKey: true })).toBe("strike");
    expect(markForKey({ key: "s", shiftKey: false })).toBeNull();
    expect(markForKey({ key: "x", shiftKey: false })).toBeNull();
  });
});

describe("delimiterMark", () => {
  it("maps backticks, stars, underscores and tildes — half- and full-width", () => {
    expect(delimiterMark("`")).toBe("code");
    expect(delimiterMark("·")).toBe("code");
    expect(delimiterMark("｀")).toBe("code");
    expect(delimiterMark("*")).toBe("italic");
    expect(delimiterMark("＊")).toBe("italic");
    expect(delimiterMark("_")).toBe("italic");
    expect(delimiterMark("＿")).toBe("italic");
    expect(delimiterMark("~")).toBe("strike");
    expect(delimiterMark("～")).toBe("strike");
    expect(delimiterMark("[")).toBeNull();
    expect(delimiterMark("a")).toBeNull();
    expect(delimiterMark(" ")).toBeNull();
  });
});

describe("mentionOpener", () => {
  it("takes the half- and full-width opening bracket only", () => {
    expect(mentionOpener("[")).toBe(true);
    expect(mentionOpener("【")).toBe(true);
    expect(mentionOpener("]")).toBe(false);
    expect(mentionOpener("`")).toBe(false);
  });
});

describe("wordsCanQueryMention", () => {
  it("keeps to what a [[ query may hold", () => {
    expect(wordsCanQueryMention("会议纪要")).toBe(true);
    expect(wordsCanQueryMention("release notes")).toBe(true);
    expect(wordsCanQueryMention("")).toBe(false);
    expect(wordsCanQueryMention(" ")).toBe(false);
    expect(wordsCanQueryMention(" leading")).toBe(false);
    expect(wordsCanQueryMention("double  space")).toBe(false);
    expect(wordsCanQueryMention("line\nbreak")).toBe(false);
    expect(wordsCanQueryMention("has]bracket")).toBe(false);
    expect(wordsCanQueryMention("x".repeat(61))).toBe(false);
    expect(wordsCanQueryMention("trailing ")).toBe(true);
  });
});
