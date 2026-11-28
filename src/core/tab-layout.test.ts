import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  activePageOfLayout,
  activateTabInLayout,
  closeOtherTabsInLayout,
  closeRightTabsInLayout,
  closeTabInLayout,
  emptySpaceTabLayout,
  focusPaneInLayout,
  moveTabInLayout,
  normalizeSpaceTabLayout,
  openPageInLayout,
  pinnedPageIdsInLayout,
  pruneSpaceTabLayout,
  readTabLayouts,
  setSplitRatioInLayout,
  togglePinTabInLayout,
  toggleSplitInLayout,
  writeTabLayouts,
} from "./tab-layout";

function createMemoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
    clear: () => { map.clear(); },
  };
}

describe("tab-layout", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { localStorage: createMemoryStorage() });
  });

  it("reuses active unpinned tab on default open and deduplicates existing tabs", () => {
    let layout = emptySpaceTabLayout("p1");
    layout = openPageInLayout(layout, "p2").layout;
    expect(layout.left.tabs).toEqual([{ pageId: "p2", pinned: false }]);
    expect(activePageOfLayout(layout)).toBe("p2");

    layout = openPageInLayout(layout, "p3", { mode: "new-tab" }).layout;
    expect(layout.left.tabs.map((t) => t.pageId)).toEqual(["p2", "p3"]);

    // Focusing an already-open tab switches to it without duplicating.
    layout = openPageInLayout(layout, "p2", { mode: "new-tab" }).layout;
    expect(layout.left.tabs.map((t) => t.pageId)).toEqual(["p2", "p3"]);
    expect(activePageOfLayout(layout)).toBe("p2");
  });

  it("protects pinned tabs from overwrite and accidental close, and groups pinned left", () => {
    let layout = emptySpaceTabLayout("p1");
    layout = openPageInLayout(layout, "p2", { mode: "new-tab" }).layout;
    layout = togglePinTabInLayout(layout, "left", "p2").layout;

    // Pinned tab moved to index 0 ahead of unpinned p1.
    expect(layout.left.tabs).toEqual([
      { pageId: "p2", pinned: true },
      { pageId: "p1", pinned: false },
    ]);

    // Clicking p3 while pinned p2 is active opens a new tab instead of overwriting p2.
    const opened = openPageInLayout(layout, "p3");
    expect(opened.pinProtected).toBe(true);
    layout = opened.layout;
    expect(layout.left.tabs).toEqual([
      { pageId: "p2", pinned: true },
      { pageId: "p1", pinned: false },
      { pageId: "p3", pinned: false },
    ]);
    expect(activePageOfLayout(layout)).toBe("p3");

    // Closing pinned p2 is blocked; closing unpinned p3 succeeds.
    const blocked = closeTabInLayout(layout, "left", "p2", { viaShortcut: true });
    expect(blocked.blockedByPin).toBe(true);
    expect(blocked.layout.left.tabs.some((t) => t.pageId === "p2")).toBe(true);

    const closed = closeTabInLayout(layout, "left", "p3");
    expect(closed.blockedByPin).toBeFalsy();
    expect(closed.layout.left.tabs.map((t) => t.pageId)).toEqual(["p2", "p1"]);
  });

  it("closes other/right tabs while always preserving pinned tabs", () => {
    let layout = emptySpaceTabLayout("p1");
    layout = openPageInLayout(layout, "p2", { mode: "new-tab" }).layout;
    layout = openPageInLayout(layout, "p3", { mode: "new-tab" }).layout;
    layout = openPageInLayout(layout, "p4", { mode: "new-tab" }).layout;
    layout = togglePinTabInLayout(layout, "left", "p1").layout;
    layout = togglePinTabInLayout(layout, "left", "p4").layout;
    // Order: [p1(pin), p4(pin), p2, p3]
    expect(layout.left.tabs.map((t) => t.pageId)).toEqual(["p1", "p4", "p2", "p3"]);

    const rightClosed = closeRightTabsInLayout(layout, "left", "p2");
    expect(rightClosed.left.tabs.map((t) => t.pageId)).toEqual(["p1", "p4", "p2"]);

    const otherClosed = closeOtherTabsInLayout(layout, "left", "p2");
    expect(otherClosed.left.tabs.map((t) => t.pageId)).toEqual(["p1", "p4", "p2"]);
  });

  it("supports split panes, lossless merge, and auto-collapse when closing last right tab", () => {
    let layout = emptySpaceTabLayout("p1");
    layout = openPageInLayout(layout, "p2", { mode: "split-right" }).layout;
    expect(layout.split).toBe(true);
    expect(layout.activePane).toBe("right");
    expect(activePageOfLayout(layout)).toBe("p2");

    layout = togglePinTabInLayout(layout, "right", "p2").layout;
    expect(pinnedPageIdsInLayout(layout)).toEqual(["p2"]);

    // Merge split keeps pinned p2 in left pane.
    const merged = toggleSplitInLayout(layout);
    expect(merged.merged).toBe(true);
    expect(merged.layout.split).toBe(false);
    expect(merged.layout.left.tabs).toEqual([
      { pageId: "p2", pinned: true },
      { pageId: "p1", pinned: false },
    ]);
    expect(activePageOfLayout(merged.layout)).toBe("p2");

    // Re-split and close last unpinned right tab collapses back to single pane.
    layout = openPageInLayout(merged.layout, "p3", { mode: "split-right" }).layout;
    const collapsed = closeTabInLayout(layout, "right", "p3");
    expect(collapsed.collapsedSplit).toBe(true);
    expect(collapsed.layout.split).toBe(false);
    expect(collapsed.layout.activePane).toBe("left");
  });

  it("enforces pinned/unpinned boundary on reorder and supports cross-pane drag", () => {
    let layout = emptySpaceTabLayout("p1");
    layout = openPageInLayout(layout, "p2", { mode: "new-tab" }).layout;
    layout = openPageInLayout(layout, "p3", { mode: "new-tab" }).layout;
    layout = togglePinTabInLayout(layout, "left", "p1").layout;
    // [p1(pin), p2, p3] -> try moving p3 to index 0 (ahead of pinned p1), clamped to index 1.
    layout = moveTabInLayout(layout, "left", "p3", "left", 0);
    expect(layout.left.tabs.map((t) => t.pageId)).toEqual(["p1", "p3", "p2"]);

    // Drag p2 to right pane from single-pane opens split.
    layout = moveTabInLayout(layout, "left", "p2", "right", 0);
    expect(layout.split).toBe(true);
    expect(layout.left.tabs.map((t) => t.pageId)).toEqual(["p1", "p3"]);
    expect(layout.right.tabs.map((t) => t.pageId)).toEqual(["p2"]);
  });

  it("prunes deleted and inactive trashed pages, and handles focus/ratio clamping", () => {
    let layout = emptySpaceTabLayout("p1");
    layout = openPageInLayout(layout, "p2", { mode: "new-tab" }).layout;
    layout = openPageInLayout(layout, "p3", { mode: "split-right" }).layout;
    layout = activateTabInLayout(layout, "left", "p1");
    layout = focusPaneInLayout(layout, "left");
    layout = setSplitRatioInLayout(layout, 0.9);
    expect(layout.splitRatio).toBe(0.75);

    const pruned = pruneSpaceTabLayout(
      layout,
      (id) => id !== "p3",
      (id) => id === "p2",
    );
    expect(pruned.split).toBe(false);
    expect(pruned.left.tabs.map((t) => t.pageId)).toEqual(["p1"]);
  });

  it("reads and writes per-user per-space layouts safely and ignores corrupt storage", () => {
    const layout = openPageInLayout(emptySpaceTabLayout("p1"), "p2", { mode: "split-right" }).layout;
    writeTabLayouts("user-1", { v: 1, spaces: { personal: layout } });
    const readBack = readTabLayouts("user-1");
    expect(readBack.spaces.personal).toEqual(normalizeSpaceTabLayout(layout));

    window.localStorage.setItem("notes:tabs:user-1", "{bad-json");
    expect(readTabLayouts("user-1")).toEqual({ v: 1, spaces: {} });

    window.localStorage.setItem("notes:tabs:user-1", JSON.stringify({ v: 99, spaces: { personal: layout } }));
    expect(readTabLayouts("user-1")).toEqual({ v: 1, spaces: {} });
  });
});
