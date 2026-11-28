export type PaneId = "left" | "right";

export interface TabItem {
  pageId: string;
  pinned: boolean;
}

export interface PaneState {
  tabs: TabItem[];
  activePageId: string;
}

export interface SpaceTabLayout {
  split: boolean;
  splitRatio: number;
  activePane: PaneId;
  left: PaneState;
  right: PaneState;
}

export interface StoredTabLayouts {
  v: 1;
  spaces: Record<string, SpaceTabLayout>;
}

export type OpenPageMode = "default" | "new-tab" | "split-right" | "replace";

export const SPLIT_PANE_MIN = 360;
export const SPLIT_RATIO_MIN = 0.25;
export const SPLIT_RATIO_MAX = 0.75;
export const DEFAULT_SPLIT_RATIO = 0.5;

const storageKey = (userId: string) => `notes:tabs:${userId}`;

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_SPLIT_RATIO;
  return Number(Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio)).toFixed(4));
}

export function emptyPaneState(seedPageId = ""): PaneState {
  return seedPageId
    ? { tabs: [{ pageId: seedPageId, pinned: false }], activePageId: seedPageId }
    : { tabs: [], activePageId: "" };
}

export function emptySpaceTabLayout(seedPageId = ""): SpaceTabLayout {
  return {
    split: false,
    splitRatio: DEFAULT_SPLIT_RATIO,
    activePane: "left",
    left: emptyPaneState(seedPageId),
    right: emptyPaneState(),
  };
}

function normalizePane(raw: Partial<PaneState> | undefined, isValidPage?: (pageId: string) => boolean): PaneState {
  const tabsRaw = Array.isArray(raw?.tabs) ? raw.tabs : [];
  const seen = new Map<string, TabItem>();
  for (const entry of tabsRaw) {
    if (!entry || typeof entry !== "object") continue;
    const pageId = typeof entry.pageId === "string" ? entry.pageId : "";
    if (!pageId || (isValidPage && !isValidPage(pageId))) continue;
    const pinned = Boolean(entry.pinned);
    const prev = seen.get(pageId);
    if (!prev) {
      seen.set(pageId, { pageId, pinned });
    } else if (pinned && !prev.pinned) {
      prev.pinned = true;
    }
  }
  const all = [...seen.values()];
  const pinned = all.filter((tab) => tab.pinned);
  const normal = all.filter((tab) => !tab.pinned);
  const tabs = [...pinned, ...normal];
  const candidateActive = typeof raw?.activePageId === "string" ? raw.activePageId : "";
  const activePageId = tabs.some((tab) => tab.pageId === candidateActive)
    ? candidateActive
    : (tabs[0]?.pageId ?? "");
  return { tabs, activePageId };
}

/** Ensures a space tab layout satisfies all invariants:
 *  - unique pageIds per pane, pinned grouped left of unpinned
 *  - valid activePageId inside each pane
 *  - split=true requires non-empty left & right panes; empty right collapses to single pane */
export function normalizeSpaceTabLayout(
  raw: Partial<SpaceTabLayout> | undefined,
  isValidPage?: (pageId: string) => boolean,
): SpaceTabLayout {
  let left = normalizePane(raw?.left, isValidPage);
  let right = normalizePane(raw?.right, isValidPage);
  let split = Boolean(raw?.split);
  let activePane: PaneId = raw?.activePane === "right" ? "right" : "left";

  if (split && right.tabs.length === 0) {
    split = false;
    activePane = "left";
  } else if (split && left.tabs.length === 0) {
    left = right;
    right = emptyPaneState();
    split = false;
    activePane = "left";
  }

  if (!split) {
    right = emptyPaneState();
    activePane = "left";
  }

  return {
    split,
    splitRatio: clampSplitRatio(typeof raw?.splitRatio === "number" ? raw.splitRatio : DEFAULT_SPLIT_RATIO),
    activePane,
    left,
    right,
  };
}

export function readTabLayouts(userId: string): StoredTabLayouts {
  if (typeof window === "undefined" || !userId) return { v: 1, spaces: {} };
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (!raw) return { v: 1, spaces: {} };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { v: 1, spaces: {} };
    const record = parsed as Partial<StoredTabLayouts>;
    if (record.v !== 1 || !record.spaces || typeof record.spaces !== "object") return { v: 1, spaces: {} };
    const spaces: Record<string, SpaceTabLayout> = {};
    for (const [spaceId, value] of Object.entries(record.spaces)) {
      if (!spaceId || !value || typeof value !== "object") continue;
      spaces[spaceId] = normalizeSpaceTabLayout(value as Partial<SpaceTabLayout>);
    }
    return { v: 1, spaces };
  } catch {
    return { v: 1, spaces: {} };
  }
}

export function writeTabLayouts(userId: string, layouts: StoredTabLayouts): void {
  if (typeof window === "undefined" || !userId) return;
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(layouts));
  } catch {
    // Storage quota/privacy errors never block note editing.
  }
}

export function activePageOfLayout(layout: SpaceTabLayout): string {
  const pane = layout.split && layout.activePane === "right" ? layout.right : layout.left;
  return pane.activePageId || layout.left.activePageId || "";
}

export function pinnedPageIdsInLayout(layout: SpaceTabLayout): string[] {
  const ids = new Set<string>();
  for (const tab of layout.left.tabs) {
    if (tab.pinned) ids.add(tab.pageId);
  }
  if (layout.split) {
    for (const tab of layout.right.tabs) {
      if (tab.pinned) ids.add(tab.pageId);
    }
  }
  return [...ids];
}

export function openPageInLayout(
  current: SpaceTabLayout,
  pageId: string,
  options: { pane?: PaneId; mode?: OpenPageMode } = {},
): { layout: SpaceTabLayout; pinProtected?: boolean } {
  const mode = options.mode ?? "default";
  const base = normalizeSpaceTabLayout(current);
  if (!pageId) return { layout: base };

  if (mode === "split-right") {
    const rightPane = base.split ? base.right : emptyPaneState();
    const existing = rightPane.tabs.some((tab) => tab.pageId === pageId);
    const nextRight: PaneState = existing
      ? { ...rightPane, activePageId: pageId }
      : { tabs: [...rightPane.tabs, { pageId, pinned: false }], activePageId: pageId };
    return {
      layout: normalizeSpaceTabLayout({
        ...base,
        split: true,
        activePane: "right",
        right: nextRight,
      }),
    };
  }

  const targetPane: PaneId = options.pane && (options.pane === "left" || base.split)
    ? options.pane
    : base.activePane;
  const paneState = base[targetPane];
  const existing = paneState.tabs.some((tab) => tab.pageId === pageId);

  if (existing) {
    return {
      layout: normalizeSpaceTabLayout({
        ...base,
        activePane: targetPane,
        [targetPane]: { ...paneState, activePageId: pageId },
      }),
    };
  }

  if (mode === "new-tab" || paneState.tabs.length === 0) {
    return {
      layout: normalizeSpaceTabLayout({
        ...base,
        activePane: targetPane,
        [targetPane]: {
          tabs: [...paneState.tabs, { pageId, pinned: false }],
          activePageId: pageId,
        },
      }),
    };
  }

  if (mode === "replace") {
    const activeIndex = paneState.tabs.findIndex((tab) => tab.pageId === paneState.activePageId);
    const idx = activeIndex >= 0 ? activeIndex : 0;
    const nextTabs = paneState.tabs.map((tab, index) => (index === idx ? { pageId, pinned: false } : tab));
    return {
      layout: normalizeSpaceTabLayout({
        ...base,
        activePane: targetPane,
        [targetPane]: { tabs: nextTabs, activePageId: pageId },
      }),
    };
  }

  // Default click: replace active unpinned tab, or preserve pinned tab and open a new one.
  const activeTab = paneState.tabs.find((tab) => tab.pageId === paneState.activePageId);
  if (activeTab && !activeTab.pinned) {
    const nextTabs = paneState.tabs.map((tab) => (tab.pageId === activeTab.pageId ? { pageId, pinned: false } : tab));
    return {
      layout: normalizeSpaceTabLayout({
        ...base,
        activePane: targetPane,
        [targetPane]: { tabs: nextTabs, activePageId: pageId },
      }),
    };
  }

  return {
    pinProtected: Boolean(activeTab?.pinned),
    layout: normalizeSpaceTabLayout({
      ...base,
      activePane: targetPane,
      [targetPane]: {
        tabs: [...paneState.tabs, { pageId, pinned: false }],
        activePageId: pageId,
      },
    }),
  };
}

export function activateTabInLayout(current: SpaceTabLayout, pane: PaneId, pageId: string): SpaceTabLayout {
  const base = normalizeSpaceTabLayout(current);
  const targetPane = pane === "right" && !base.split ? "left" : pane;
  if (!base[targetPane].tabs.some((tab) => tab.pageId === pageId)) return base;
  return {
    ...base,
    activePane: targetPane,
    [targetPane]: { ...base[targetPane], activePageId: pageId },
  };
}

export function togglePinTabInLayout(
  current: SpaceTabLayout,
  pane: PaneId,
  pageId: string,
): { layout: SpaceTabLayout; pinned: boolean | null } {
  const base = normalizeSpaceTabLayout(current);
  const targetPane = pane === "right" && !base.split ? "left" : pane;
  const paneState = base[targetPane];
  const existing = paneState.tabs.find((tab) => tab.pageId === pageId);
  if (!existing) return { layout: base, pinned: null };
  const nextPinned = !existing.pinned;
  const nextTabs = paneState.tabs.map((tab) => (tab.pageId === pageId ? { ...tab, pinned: nextPinned } : tab));
  return {
    pinned: nextPinned,
    layout: normalizeSpaceTabLayout({
      ...base,
      [targetPane]: { ...paneState, tabs: nextTabs },
    }),
  };
}

export function closeTabInLayout(
  current: SpaceTabLayout,
  pane: PaneId,
  pageId: string,
  options: { viaShortcut?: boolean; allowEmpty?: boolean } = {},
): { layout: SpaceTabLayout; blockedByPin?: boolean; collapsedSplit?: boolean } {
  const base = normalizeSpaceTabLayout(current);
  const targetPane = pane === "right" && !base.split ? "left" : pane;
  const paneState = base[targetPane];
  const idx = paneState.tabs.findIndex((tab) => tab.pageId === pageId);
  if (idx < 0) return { layout: base };

  const target = paneState.tabs[idx];
  if (target.pinned) {
    return { layout: base, blockedByPin: true };
  }

  if (!base.split && paneState.tabs.length <= 1 && !options.allowEmpty) {
    return { layout: base };
  }

  const remaining = paneState.tabs.filter((tab) => tab.pageId !== pageId);
  const nextActive = paneState.activePageId === pageId
    ? (remaining[idx]?.pageId ?? remaining[idx - 1]?.pageId ?? "")
    : paneState.activePageId;

  const next = normalizeSpaceTabLayout({
    ...base,
    [targetPane]: { tabs: remaining, activePageId: nextActive },
  });

  return {
    layout: next,
    collapsedSplit: base.split && !next.split,
  };
}

export function closeOtherTabsInLayout(current: SpaceTabLayout, pane: PaneId, keepPageId: string): SpaceTabLayout {
  const base = normalizeSpaceTabLayout(current);
  const targetPane = pane === "right" && !base.split ? "left" : pane;
  const paneState = base[targetPane];
  const nextTabs = paneState.tabs.filter((tab) => tab.pinned || tab.pageId === keepPageId);
  return normalizeSpaceTabLayout({
    ...base,
    activePane: targetPane,
    [targetPane]: {
      tabs: nextTabs,
      activePageId: nextTabs.some((tab) => tab.pageId === keepPageId) ? keepPageId : (nextTabs[0]?.pageId ?? ""),
    },
  });
}

export function closeRightTabsInLayout(current: SpaceTabLayout, pane: PaneId, fromPageId: string): SpaceTabLayout {
  const base = normalizeSpaceTabLayout(current);
  const targetPane = pane === "right" && !base.split ? "left" : pane;
  const paneState = base[targetPane];
  const idx = paneState.tabs.findIndex((tab) => tab.pageId === fromPageId);
  if (idx < 0) return base;
  const nextTabs = paneState.tabs.filter((tab, index) => index <= idx || tab.pinned);
  const activeStillHere = nextTabs.some((tab) => tab.pageId === paneState.activePageId);
  return normalizeSpaceTabLayout({
    ...base,
    activePane: targetPane,
    [targetPane]: {
      tabs: nextTabs,
      activePageId: activeStillHere ? paneState.activePageId : fromPageId,
    },
  });
}

export function moveTabInLayout(
  current: SpaceTabLayout,
  fromPane: PaneId,
  pageId: string,
  toPane: PaneId,
  insertIndex?: number,
): SpaceTabLayout {
  const base = normalizeSpaceTabLayout(current);
  const sourcePane = fromPane === "right" && !base.split ? "left" : fromPane;
  const source = base[sourcePane];
  const movingIndex = source.tabs.findIndex((tab) => tab.pageId === pageId);
  if (movingIndex < 0) return base;

  const moving = source.tabs[movingIndex];
  if (sourcePane === toPane) {
    const without = source.tabs.filter((tab) => tab.pageId !== pageId);
    const pinCount = without.filter((tab) => tab.pinned).length;
    let targetIndex = insertIndex === undefined ? without.length : insertIndex;
    targetIndex = moving.pinned
      ? Math.max(0, Math.min(pinCount, targetIndex))
      : Math.max(pinCount, Math.min(without.length, targetIndex));
    const reordered = [...without];
    reordered.splice(targetIndex, 0, moving);
    return normalizeSpaceTabLayout({
      ...base,
      activePane: sourcePane,
      [sourcePane]: { tabs: reordered, activePageId: moving.pageId },
    });
  }

  // Cross-pane move (auto-opens split when dragging into right pane from single pane)
  const remainingSource = source.tabs.filter((tab) => tab.pageId !== pageId);
  const nextSourceActive = source.activePageId === pageId
    ? (remainingSource[movingIndex]?.pageId ?? remainingSource[movingIndex - 1]?.pageId ?? "")
    : source.activePageId;

  const destBase = toPane === "right" && !base.split ? emptyPaneState() : base[toPane];
  const existingDest = destBase.tabs.find((tab) => tab.pageId === pageId);
  const mergedTab: TabItem = { pageId, pinned: moving.pinned || Boolean(existingDest?.pinned) };
  const destWithout = destBase.tabs.filter((tab) => tab.pageId !== pageId);
  const pinCount = destWithout.filter((tab) => tab.pinned).length;
  let targetIndex = insertIndex === undefined ? destWithout.length : insertIndex;
  targetIndex = mergedTab.pinned
    ? Math.max(0, Math.min(pinCount, targetIndex))
    : Math.max(pinCount, Math.min(destWithout.length, targetIndex));
  const nextDestTabs = [...destWithout];
  nextDestTabs.splice(targetIndex, 0, mergedTab);

  return normalizeSpaceTabLayout({
    ...base,
    split: toPane === "right" ? true : base.split,
    activePane: toPane,
    [sourcePane]: { tabs: remainingSource, activePageId: nextSourceActive },
    [toPane]: { tabs: nextDestTabs, activePageId: pageId },
  });
}

export function toggleSplitInLayout(
  current: SpaceTabLayout,
  candidatePageId?: string,
): { layout: SpaceTabLayout; merged?: boolean } {
  const base = normalizeSpaceTabLayout(current);
  if (!base.split) {
    const seed = candidatePageId || base.left.activePageId;
    if (!seed) return { layout: base };
    return {
      layout: normalizeSpaceTabLayout({
        ...base,
        split: true,
        activePane: "right",
        right: { tabs: [{ pageId: seed, pinned: false }], activePageId: seed },
      }),
    };
  }

  // Lossless merge of right pane tabs into left pane (preserving pinned tabs from both sides).
  const byId = new Map<string, TabItem>();
  for (const tab of base.left.tabs) byId.set(tab.pageId, { ...tab });
  for (const tab of base.right.tabs) {
    const prev = byId.get(tab.pageId);
    if (!prev) byId.set(tab.pageId, { ...tab });
    else if (tab.pinned) prev.pinned = true;
  }
  const mergedAll = [...byId.values()];
  const leftActive = base.activePane === "right" && base.right.activePageId
    ? base.right.activePageId
    : base.left.activePageId;

  return {
    merged: true,
    layout: normalizeSpaceTabLayout({
      split: false,
      splitRatio: base.splitRatio,
      activePane: "left",
      left: { tabs: mergedAll, activePageId: leftActive },
      right: emptyPaneState(),
    }),
  };
}

export function focusPaneInLayout(current: SpaceTabLayout, pane: PaneId): SpaceTabLayout {
  const base = normalizeSpaceTabLayout(current);
  if (!base.split || base.activePane === pane) return base;
  return { ...base, activePane: pane };
}

export function setSplitRatioInLayout(current: SpaceTabLayout, ratio: number): SpaceTabLayout {
  const base = normalizeSpaceTabLayout(current);
  const clamped = clampSplitRatio(ratio);
  if (base.splitRatio === clamped) return base;
  return { ...base, splitRatio: clamped };
}

/** Removes deleted/inaccessible pages, plus inactive trashed pages, keeping the
 *  current active pane viewing a trashed page if the user deliberately opened it. */
export function pruneSpaceTabLayout(
  current: SpaceTabLayout,
  isValidPage: (pageId: string) => boolean,
  isTrashed?: (pageId: string) => boolean,
): SpaceTabLayout {
  const filterPane = (pane: PaneState, isFocusedPane: boolean): PaneState => {
    const tabs = pane.tabs.filter((tab) => {
      if (!isValidPage(tab.pageId)) return false;
      if (isTrashed?.(tab.pageId)) {
        return isFocusedPane && tab.pageId === pane.activePageId;
      }
      return true;
    });
    return { tabs, activePageId: pane.activePageId };
  };
  return normalizeSpaceTabLayout({
    ...current,
    left: filterPane(current.left, !current.split || current.activePane === "left"),
    right: filterPane(current.right, current.split && current.activePane === "right"),
  });
}
