import { describe, expect, it } from "vitest";
import { mentionQueryAt } from "./inline-markdown";

describe("mentionQueryAt", () => {
  it("reads a [[ query up to the caret", () => {
    expect(mentionQueryAt("see [[tar", 9)).toEqual({ from: 4, query: "tar", trigger: "[[" });
    expect(mentionQueryAt("see [[", 6)).toEqual({ from: 4, query: "", trigger: "[[" });
  });

  it("reads a 【【 query — the auto-closed 【【】 a Chinese keyboard types", () => {
    expect(mentionQueryAt("see 【【tar】", 9)).toEqual({ from: 4, query: "tar", trigger: "[[" });
    expect(mentionQueryAt("【【】", 2)).toEqual({ from: 0, query: "", trigger: "[[" });
  });

  it("rejects a query holding a closer", () => {
    expect(mentionQueryAt("see [[ta]r", 10)).toBeNull();
    expect(mentionQueryAt("see 【【ta】r", 11)).toBeNull();
    expect(mentionQueryAt("see [[a]a", 9)).toBeNull();
  });

  it("keeps single-bracket text literal", () => {
    expect(mentionQueryAt("see 【note】", 11)).toBeNull();
    expect(mentionQueryAt("see [link]", 10)).toBeNull();
  });
});
