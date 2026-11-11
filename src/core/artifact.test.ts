import { describe, expect, it } from "vitest";
import { appDocument } from "./artifact";

/* The injected shim document must keep the source's tags intact: an
 *  attribute added to <html> moves the tag's end, so injection points
 *  must be re-located on the themed source. */
describe("appDocument", () => {
  it("injects head tags after a themed <html> without a <head>", () => {
    const doc = appDocument("<!doctype html><html><body><h1>8</h1></body></html>", "light");
    expect(doc).toContain('<html data-theme="light"><head>');
    expect(doc).not.toContain('<html <head>');
    expect(doc.indexOf("<body>")).toBeGreaterThan(doc.indexOf("</head>"));
  });

  it("keeps an existing <head> and merges meta into it", () => {
    const doc = appDocument("<html><head><title>t</title></head><body>x</body></html>", "dark");
    expect(doc).toContain('<html data-theme="dark">');
    expect(doc.indexOf("<meta")).toBeLessThan(doc.indexOf("<title>t</title>"));
    expect(doc.indexOf("<body>")).toBeGreaterThan(doc.indexOf("<script>"));
  });

  it("does not split an <html> that already carries data-theme", () => {
    const doc = appDocument('<html data-theme="dark"><body>x</body></html>', "light");
    expect(doc).toContain('<html data-theme="dark"><head>');
    expect(doc).not.toContain('<html <head>');
  });

  it("leads a tagless source with the shim directly", () => {
    const doc = appDocument("<h1>plain</h1>", "light");
    expect(doc.startsWith("<meta")).toBe(true);
    expect(doc).toContain("<h1>plain</h1>");
  });
});
