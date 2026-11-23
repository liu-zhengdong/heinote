import { describe, expect, it } from "vitest";
import { decodeHtmlEntities } from "./html-entities";

describe("decodeHtmlEntities", () => {
  it("reads the space family — what &emsp; paragraphs are indented with", () => {
    expect(decodeHtmlEntities("&emsp;&emsp;首行")).toBe("  首行");
    expect(decodeHtmlEntities("&ensp;")).toBe(" ");
    expect(decodeHtmlEntities("&nbsp;")).toBe(" ");
    expect(decodeHtmlEntities("&thinsp;")).toBe(" ");
  });

  it("reads named punctuation and markup characters", () => {
    expect(decodeHtmlEntities("Fish &amp; Chips")).toBe("Fish & Chips");
    expect(decodeHtmlEntities("&lt;div&gt;")).toBe("<div>");
    expect(decodeHtmlEntities("&mdash;&hellip;&eacute;")).toBe("—…é");
    expect(decodeHtmlEntities("&AMP;&LT;&GT;&QUOT;")).toBe("&<>\"");
  });

  it("reads decimal and hex references, remapping Windows-1252 points", () => {
    expect(decodeHtmlEntities("&#8212;&#x2014;")).toBe("——");
    expect(decodeHtmlEntities("&#128512;")).toBe("😀");
    expect(decodeHtmlEntities("&#x85;&#150;")).toBe("…–");
  });

  it("keeps what is not a reference: bare &, unknown names, missing ;", () => {
    expect(decodeHtmlEntities("a & b")).toBe("a & b");
    expect(decodeHtmlEntities("&nosuch;")).toBe("&nosuch;");
    expect(decodeHtmlEntities("&amp")).toBe("&amp");
    expect(decodeHtmlEntities("&#xZZ;")).toBe("&#xZZ;");
  });

  it("renders nothing invisible for control points", () => {
    expect(decodeHtmlEntities("&#1;&#127;")).toBe("&#1;&#127;");
    expect(decodeHtmlEntities("&#0;")).toBe("�");
    expect(decodeHtmlEntities("&#9;&#10;")).toBe("  ");
  });
});
