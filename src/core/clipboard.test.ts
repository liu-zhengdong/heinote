import { describe, expect, it } from "vitest";
import { clipboardFiles, copyImageBlob, IMAGE_CLIPBOARD_UNSUPPORTED, isFilePaste } from "./clipboard";
import { MENTION_CHAR, soleImage } from "./inline-content";
import type { StoredFile } from "./types";

const SAMPLE_FILE: StoredFile = {
  path: "files/page_1/file_1/photo.png",
  owner: "user_1",
  name: "photo.png",
  size: 1024,
  type: "image/png",
  width: 200,
  height: 120,
};

function fakeFile(name: string, type = "image/png"): File {
  return new File([new Uint8Array([137, 80, 78, 71])], name, { type });
}

describe("clipboard helpers", () => {
  it("extracts direct files and falls back to DataTransfer items", () => {
    const png = fakeFile("shot.png");
    const withFiles = { files: [png], items: [] } as unknown as DataTransfer;
    expect(clipboardFiles(withFiles)).toEqual([png]);

    const fromItems = {
      files: [],
      items: [
        { kind: "string", getAsFile: () => null },
        { kind: "file", getAsFile: () => png },
      ],
    } as unknown as DataTransfer;
    expect(clipboardFiles(fromItems)).toEqual([png]);
    expect(clipboardFiles(null)).toEqual([]);
  });

  it("distinguishes image/file pastes from spreadsheet cell pastes", () => {
    const shot = fakeFile("screenshot.png");
    const doc = fakeFile("report.pdf", "application/pdf");

    expect(isFilePaste([shot], "", "")).toBe(true);
    expect(isFilePaste([shot], "https://example.com/a.png", '<img src="https://example.com/a.png">')).toBe(true);
    expect(isFilePaste([shot], "screenshot.png", "")).toBe(true);
    expect(isFilePaste([shot, doc], "screenshot.png\nreport.pdf\n", "")).toBe(true);
    expect(isFilePaste([shot], "A1\tB1\n1\t2", "<table><tr><td>A1</td><td>B1</td></tr></table>")).toBe(false);
    expect(isFilePaste([shot], "Hello world", '<p>Hello <img src="x"> world</p>')).toBe(false);
    expect(isFilePaste([], "", "")).toBe(false);
  });

  it("reports a clear error when Async Clipboard image write is unavailable", async () => {
    await expect(copyImageBlob(async () => new Blob([new Uint8Array([1])], { type: "image/png" }))).rejects.toThrow(
      IMAGE_CLIPBOARD_UNSUPPORTED,
    );
  });
});

describe("soleImage", () => {
  it("recognizes a paragraph containing only a single image (with optional whitespace)", () => {
    const imageMention = { kind: "image" as const, file: SAMPLE_FILE, width: 160 };
    expect(soleImage([{ text: MENTION_CHAR, mention: imageMention }])).toEqual({ mention: imageMention, offset: 0 });
    expect(soleImage([{ text: " " }, { text: MENTION_CHAR, mention: imageMention }, { text: " " }])).toEqual({
      mention: imageMention,
      offset: 1,
    });
    expect(soleImage([{ text: "caption " }, { text: MENTION_CHAR, mention: imageMention }])).toBeNull();
    expect(soleImage([
      { text: MENTION_CHAR, mention: imageMention },
      { text: MENTION_CHAR, mention: imageMention },
    ])).toBeNull();
  });
});
