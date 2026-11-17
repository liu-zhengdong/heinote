import { describe, expect, it } from "vitest";
import { normalizeStoredFile, validStoredFilePath } from "./files";

describe("validStoredFilePath", () => {
  it("accepts ASCII, Chinese and emoji under files/", () => {
    for (const path of ["files/agent/ab1/file.png", "files/附件/内网部署 ✅.png", "files/a.b/c.d/e.png"]) {
      expect(validStoredFilePath(path), path).toBe(true);
    }
  });

  it("refuses traversal, escapes of it, and Windows-unstable names", () => {
    for (const path of [
      "../x.png", "files/../x.png", "files/a/../../x.png",
      "files/a/%2e%2e/out.png",
      "files//x.png", "files/a\\b.png", "files/a:b.png", "files/a*?.png", 'files/a"b.png', "files/a<b>.png",
      "files/one.txt\n", "files/a/b.txt ",
      "files/con.png", "files/nul", "files/COM1.txt", "files/conin$", "files/conout$.tmp",
      "files/.", "files/a/./b.png", "files/a/../b.png",
    ]) expect(validStoredFilePath(path), path).toBe(false);
  });

  it("bounds the whole path and each segment", () => {
    expect(validStoredFilePath(`files/${"a".repeat(101)}`)).toBe(false);
    expect(validStoredFilePath(`files/${"a".repeat(100)}`)).toBe(true);
    expect(validStoredFilePath(`files/${"a".repeat(320)}`)).toBe(false);
  });
});

describe("normalizeStoredFile", () => {
  it("keeps a stored file whose path carries the file's own language", () => {
    const file = normalizeStoredFile({
      path: "files/附件/内网部署 ✅.png", owner: "u1", space: "s1",
      name: "内网部署 ✅.png", size: 68, type: "image/png",
    });
    expect(file?.path).toBe("files/附件/内网部署 ✅.png");
    expect(file?.name).toBe("内网部署 ✅.png");
  });

  it("drops a reference whose path was never storable", () => {
    expect(normalizeStoredFile({ path: "files/../escape.png", owner: "u1", name: "x", size: 1, type: "image/png" })).toBeUndefined();
    expect(normalizeStoredFile({ path: "files/a%2f..%2fb.png", owner: "u1", name: "x", size: 1, type: "image/png" })).toBeUndefined();
  });
});
