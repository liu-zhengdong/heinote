import { describe, expect, it } from "vitest";
import { canDeletePage, canMovePage, canTrashPage, descendantCount, inTrash, isHomed, isPurging, pageHolders, subtreeDescendantCounts, withoutUnhomed } from "./page-tree";
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

  it("allows cross-space moves only between spaces the member owns, while permitting intra-space moves", () => {
    const withSpaces = {
      ...pages,
      shared2: page("shared2", { share_space_id: "space_b" }),
      kbHome: page("kbHome", { share_space_id: "space_kb" }),
      kbChild: page("kbChild", { parent_id: "kbHome" }),
    };
    const owner = {
      space_a: { role: "owner" },
      space_b: { role: "owner" },
      space_kb: { role: "owner", knowledgeBase: { homePageId: "kbHome", archived: false } },
    };
    const adminMap = { space_a: { role: "admin" }, space_b: { role: "owner" } };
    const editorMap = { space_a: { role: "editor" }, space_b: { role: "owner" } };

    // Non-owners (both editor and admin) cannot move personal pages into someone else's shared space
    // or carry child pages out of someone else's shared space.
    for (const spaces of [editorMap, adminMap]) {
      expect(canMovePage(withSpaces, spaces, "mine", "shared")).toBe(false);
      expect(canMovePage(withSpaces, spaces, "note", "child")).toBe(false);
      expect(canMovePage(withSpaces, spaces, "child", null)).toBe(false);
      expect(canMovePage(withSpaces, spaces, "child", "mine")).toBe(false);
      expect(canMovePage(withSpaces, spaces, "child", "shared2")).toBe(false);
      // Reorganizing within the same shared space remains allowed.
      expect(canMovePage(withSpaces, spaces, "child", "sibling")).toBe(true);
    }

    // Owners can move freely between their personal space and shared spaces they own.
    expect(canMovePage(withSpaces, owner, "mine", "shared")).toBe(true);
    expect(canMovePage(withSpaces, owner, "note", "child")).toBe(true);
    expect(canMovePage(withSpaces, owner, "child", null)).toBe(true);
    expect(canMovePage(withSpaces, owner, "child", "mine")).toBe(true);
    expect(canMovePage(withSpaces, owner, "child", "shared2")).toBe(true);
    expect(canMovePage(withSpaces, owner, "child", "sibling")).toBe(true);

    // Knowledge base boundary still blocks moves even for its owner.
    expect(canMovePage(withSpaces, owner, "mine", "kbHome")).toBe(false);
    expect(canMovePage(withSpaces, owner, "kbChild", null)).toBe(false);
    expect(canMovePage(withSpaces, owner, "kbChild", "shared")).toBe(false);
  });
});

describe("UC-57: multi-level trash, purging state, and descendant counts", () => {
  it("recognizes multi-level archived and purging descendants and protects against cycles", () => {
    const pages = workspace(
      page("liveRoot"),
      page("liveChild", { parent_id: "liveRoot" }),
      page("trashedRoot", { archived: true }),
      page("trashedChild", { parent_id: "trashedRoot" }),
      page("trashedGrand", { parent_id: "trashedChild" }),
      page("trashedGreat", { parent_id: "trashedGrand" }),
      page("purgingRoot", { archived: true, purging: true }),
      page("purgingChild", { parent_id: "purgingRoot" }),
      page("purgingGrand", { parent_id: "purgingChild" }),
      page("cycleA", { parent_id: "cycleB" }),
      page("cycleB", { parent_id: "cycleA" }),
      page("db", { kind: "database" }),
      page("dbRowArchived", { parent_id: "db", archived: true }),
      page("dbRowPurging", { parent_id: "db", archived: true, purging: true }),
      page("dbRowLive", { parent_id: "db" }),
    ).pages;

    expect(inTrash(pages, "liveRoot")).toBe(false);
    expect(inTrash(pages, "liveChild")).toBe(false);
    for (const id of ["trashedRoot", "trashedChild", "trashedGrand", "trashedGreat", "purgingRoot", "purgingChild", "purgingGrand"]) {
      expect(inTrash(pages, id)).toBe(true);
    }
    expect(isPurging(pages, "trashedGreat")).toBe(false);
    for (const id of ["purgingRoot", "purgingChild", "purgingGrand"]) {
      expect(isPurging(pages, id)).toBe(true);
    }
    expect(inTrash(pages, "cycleA")).toBe(false);
    expect(isPurging(pages, "cycleB")).toBe(false);

    const counts = subtreeDescendantCounts(pages);
    expect(counts.get("liveRoot")).toBe(1);
    expect(counts.get("trashedRoot")).toBe(3);
    expect(counts.get("trashedChild")).toBe(2);
    expect(counts.get("trashedGreat")).toBe(0);
    expect(descendantCount(pages, "purgingRoot")).toBe(0);
    expect(descendantCount(pages, "db")).toBe(2); // dbRowLive + dbRowArchived (excludes purging)
    expect(pageHolders(pages).has("trashedRoot")).toBe(false);
    expect(pageHolders(pages).has("liveRoot")).toBe(true);

    expect(canMovePage(pages, {}, "trashedGreat", "liveRoot")).toBe(false);
    expect(canTrashPage(pages, {}, "trashedGreat")).toBe(false);
    expect(canDeletePage(pages, {}, "trashedRoot")).toBe(true);
    expect(canDeletePage(pages, {}, "purgingRoot")).toBe(false);
    expect(canDeletePage(pages, {}, "purgingGrand")).toBe(false);
  });

  it("restricts permanent deletion of ordinary shared root pages to owners", () => {
    const pages = workspace(
      page("sharedRoot", { share_space_id: "space_s", archived: true }),
      page("sharedChild", { parent_id: "sharedRoot", archived: true }),
    ).pages;
    expect(canDeletePage(pages, { space_s: { role: "owner" } }, "sharedRoot")).toBe(true);
    expect(canDeletePage(pages, { space_s: { role: "editor" } }, "sharedRoot")).toBe(false);
    expect(canDeletePage(pages, { space_s: { role: "editor" } }, "sharedChild")).toBe(true);
  });
});
