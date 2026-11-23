import { describe, expect, it } from "vitest";
import type { Block, NotePage, StoredFile } from "../../core/types";
import { databaseCsv, pageMarkdown, buildExport } from "./export";
import type { ExportSource } from "./export-model";
import { exportPages } from "./export-model";

/* UC-54: the export builders, checked off the DOM — CSV text, Markdown
   layout, the zip's entries, missing-attachment flow. */

let ids = 0;
const id = () => `block_${++ids}`;

function textBlock(text: string, parent: string | null = null, order = 1024): Block {
  return { id: id(), kind: "text", parent_id: parent, order, content: [{ text }] } as Block;
}

function page(partial: Partial<NotePage> & { id: string }): NotePage {
  return {
    kind: "document",
    title: "",
    parent_id: null,
    archived: false,
    sort_order: 0,
    created_time: "2026-11-20T00:00:00Z",
    edited_time: "2026-11-20T00:00:00Z",
    ...partial,
  } as NotePage;
}

const blockTree = (...blocks: Block[]) => ({ by_id: Object.fromEntries(blocks.map((block) => [block.id, block])) });

/* A zip written by ZipStream parses as local headers + data descriptors;
   read names and bytes straight off the local records. */
function zipEntries(buffer: ArrayBuffer): Map<string, string> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const out = new Map<string, string>();
  let at = 0;
  while (at + 30 < bytes.length && view.getUint32(at, true) === 0x04034b50) {
    const nameLength = view.getUint16(at + 26, true);
    const extra = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength));
    const dataStart = at + 30 + nameLength + extra;
    // Stored entries: next local header, or the end-of-directory, bounds the bytes.
    let end = dataStart;
    while (end + 4 < bytes.length && view.getUint32(end, true) !== 0x04034b50 && view.getUint32(end, true) !== 0x08074b50 && view.getUint32(end, true) !== 0x02014b50) end += 1;
    out.set(name, new TextDecoder().decode(bytes.subarray(dataStart, end)).replace(/\x00+$/, ""));
    at = end;
    // Skip the 16-byte data descriptor that follows the content.
    if (view.getUint32(at, true) === 0x08074b50) at += 16;
    else at += 16;
  }
  return out;
}

describe("databaseCsv", () => {
  const db = page({ id: "db1", kind: "database", title: "清单", database: {
    title_name: "名称",
    properties: [
      { id: "status", name: "状态", type: "status", status_options: [{ id: "s1", name: "进行中", group: "progress", color: "default" }] },
      { id: "tags", name: "标签", type: "multi_select", options: ["红", "绿"] },
      { id: "when", name: "日期", type: "date" },
      { id: "hidden", name: "内部备注", type: "text" },
    ],
    views: [{ id: "v1", name: "默认", kind: "table", hidden: ["hidden"] }],
  } } as NotePage);
  const rowA = page({ id: "r1", parent_id: "db1", title: "甲,项", properties: { status: "进行中", tags: '["红","绿"]', when: "2026-11-20", hidden: "不导出" } });
  const rowB = page({ id: "r2", parent_id: "db1", title: '乙"项', properties: { status: "进行中", when: "" } });
  const pages = new Map([[db.id, db], [rowA.id, rowA], [rowB.id, rowB]]);

  it("writes the title column and visible properties, rows in view order", () => {
    const csv = databaseCsv(db, pages)!;
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("\uFEFF名称,状态,标签,日期");
    expect(lines[1]).toBe('"甲,项",进行中,红; 绿,2026-11-20');
    expect(lines[2]).toBe('"乙""项",进行中,,');
  });
});

describe("pageMarkdown", () => {
  it("writes title plus body, files linking into attachments/", () => {
    const file = { path: "files/p1/f1/a.png", owner: "u", name: "a.png", size: 3, type: "image/png" } as StoredFile;
    const b = { ...textBlock("看附件"), file } as Block;
    b.kind = "file";
    const p = page({ id: "p1", title: "导出页", block_tree: blockTree(b) });
    const md = pageMarkdown(p, "", new Map([[p.id, p]]));
    expect(md.startsWith("# 导出页")).toBe(true);
    expect(md).toContain("attachments/files/p1/f1/a.png");
  });
});

describe("exportPages + buildExport", () => {
  const child = page({ id: "c1", parent_id: "p1", title: "子页", block_tree: blockTree(textBlock("子页内容")) });
  const root = page({ id: "p1", title: "父页", block_tree: blockTree(textBlock("父页内容")) });
  const pages = { p1: root, c1: child };
  const source: ExportSource = {
    pages,
    files: { read: async () => { throw new Error("no files"); } } as unknown as ExportSource["files"],
    loadPages: async () => {},
  };

  it("a single page downloads as one .md, a subtree as a zip", async () => {
    const single = await buildExport(source, await exportPages(source, "c1"), "markdown");
    expect(single.name).toBe("子页.md");
    const zipped = await buildExport(source, await exportPages(source, "p1"), "markdown");
    expect(zipped.name).toBe("父页.zip");
    const entries = zipEntries(await zipped.body.arrayBuffer());
    expect(entries.get("父页.md")).toContain("父页内容");
    expect(entries.get("父页/子页.md")).toContain("子页内容");
  });

  it("an html export carries no react server-render error", async () => {
    // A store read through useSyncExternalStore without getServerSnapshot
    // makes react-dom/server embed "Missing getServerSnapshot" in the file.
    const db = page({ id: "db1", kind: "database", title: "清单", database: {
      title_name: "名称",
      properties: [{ id: "status", name: "状态", type: "status" }],
      views: [{ id: "v1", name: "全部", kind: "table", hidden: [] }],
    } });
    const row = page({ id: "d1", parent_id: "db1", title: "甲项",
      block_tree: blockTree(textBlock("正文")), properties: { status: "In progress" } });
    const dbSource: ExportSource = { ...source, pages: { db1: db, d1: row } };
    const zipped = await buildExport(dbSource, await exportPages(dbSource, "db1"), "html", { viewId: "v1" });
    const entries = zipEntries(await zipped.body.arrayBuffer());
    for (const [name, html] of entries) {
      expect(html, name).not.toMatch(/Missing getServerSnapshot|revert to client rendering|data-msg=/);
    }
    expect(entries.get("清单.html")).toContain("甲项");
    expect(entries.get("清单/甲项.html")).toContain("正文");
    // The table already links to every row: no children nav under it.
    expect(entries.get("清单.html")).not.toContain('<nav class="public-reader__children"');
  });

  it("a missing attachment is listed, not fatal", async () => {
    const file = { path: "files/p1/f1/a.png", owner: "u", name: "a.png", size: 3, type: "image/png" } as StoredFile;
    const withImage = page({ id: "p2", title: "带图", block_tree: blockTree({ ...textBlock("x"), id: "b_img", kind: "file", file } as Block) });
    const loaded = await exportPages({ ...source, pages: { ...pages, p2: withImage } }, "p2");
    const result = await buildExport({ ...source, pages: { ...pages, p2: withImage } }, loaded, "markdown");
    expect(result.missing).toEqual(["attachments/files/p1/f1/a.png"]);
    const entries = zipEntries(await result.body.arrayBuffer());
    expect(entries.get("missing.txt")).toContain("a.png");
  });
});
