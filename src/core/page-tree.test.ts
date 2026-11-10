import { describe, expect, it } from "vitest";
import { canMovePage, isHomed, withoutUnhomed } from "./page-tree";
import type { NotePage, WorkspaceState } from "./types";
import { emptyWorkspace } from "./workspace-state";

function page(id: string, options: Partial<NotePage> = {}): NotePage {
  return {
    id, title: id, icon: "", kind: "document", parent_id: null, block_tree: { by_id: {} },
    created_at: "2026-09-21T00:00:00Z", updated_at: "2026-09-21T00:00:00Z", created_by: "a", updated_by: "a",
    ...options,
  };
}

function workspace(...pages: NotePage[]): WorkspaceState {
  return { ...emptyWorkspace(), pages: Object.fromEntries(pages.map((item) => [item.id, item])), roots: ["mine"] };
}

const state = workspace(
  page("mine"),
  page("shared", { share_space_id: "space_a" }),
  page("child", { parent_id: "shared" }),
  page("grandchild", { parent_id: "child" }),
  page("other", { share_space_id: "space_b" }),
);

describe("which space a page lives in", () => {
  it("is somewhere this member can read — or nowhere, for a page that led into a space they left", () => {
    const pages = workspace(
      page("mine"),
      page("mine_child", { parent_id: "mine" }),
      // Shared from under someone else's private page: its parent is theirs.
      page("shared", { share_space_id: "space_a", parent_id: "their_private" }),
      page("shared_child", { parent_id: "shared" }),
      // Moved into a shared page that has gone with its space.
      page("moved", { parent_id: "gone" }),
      page("moved_child", { parent_id: "moved" }),
      page("loop_a", { parent_id: "loop_b" }),
      page("loop_b", { parent_id: "loop_a" }),
    );
    // Fields written to a page that is not here: no page at all.
    pages.pages.partial = { block_tree: { by_id: {} } } as unknown as NotePage;
    for (const id of ["mine", "mine_child", "shared", "shared_child"]) expect(isHomed(pages.pages, id)).toBe(true);
    for (const id of ["moved", "moved_child", "loop_a", "partial", "missing"]) expect(isHomed(pages.pages, id)).toBe(false);
    expect(Object.keys(withoutUnhomed(pages).pages).sort()).toEqual(["mine", "mine_child", "shared", "shared_child"]);
    // Nothing to leave out: the very same workspace.
    expect(withoutUnhomed(state)).toBe(state);
  });
});

describe("where a page may be moved", () => {
  const pages = workspace(
    page("mine"),
    page("note", { parent_id: "mine" }),
    page("deep", { parent_id: "note" }),
    page("table", { kind: "database" }),
    page("binned", { archived: true }),
    page("underBin", { parent_id: "binned" }),
    page("shared", { share_space_id: "space_a" }),
    page("child", { parent_id: "shared" }),
    page("sibling", { parent_id: "shared" }),
    page("readOnly", { share_space_id: "space_v" }),
    page("readOnlyChild", { parent_id: "readOnly" }),
  ).pages;
  const editor = { space_a: { role: "editor" }, space_v: { role: "viewer" } };
  const admin = { space_a: { role: "admin" }, space_v: { role: "viewer" } };

  it("never into itself, its own branch, its current parent, a database or the trash", () => {
    expect(canMovePage(pages, editor, "note", "note")).toBe(false);
    expect(canMovePage(pages, editor, "mine", "deep")).toBe(false);
    expect(canMovePage(pages, editor, "note", "mine")).toBe(false);
    expect(canMovePage(pages, editor, "mine", null)).toBe(false);
    expect(canMovePage(pages, editor, "note", "table")).toBe(false);
    expect(canMovePage(pages, editor, "note", "binned")).toBe(false);
    expect(canMovePage(pages, editor, "note", "underBin")).toBe(false);
    expect(canMovePage(pages, editor, "note", "missing")).toBe(false);
  });

  it("moves nothing a viewer can only read, and nothing into it", () => {
    expect(canMovePage(pages, admin, "readOnlyChild", null)).toBe(false);
    expect(canMovePage(pages, admin, "note", "readOnly")).toBe(false);
  });
});
