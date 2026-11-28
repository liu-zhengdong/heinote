import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { pageName } from "../core/block-tree";
import { uuid } from "../core/ids";
import { spaceOfPage } from "../core/page-tree";
import { firstPageInSpace } from "../core/space-navigation";
import type { SpaceRoster, SpaceSummary, WorkspacePreferences } from "../core/types";
import { collaborationAccount } from "../collaboration/client";
import type { KnowledgeBaseClient, PlatformClient } from "../platform/client";
import { ApiError } from "../platform/http";
import { SpaceRosters } from "../platform/rosters";
import type { WorkspaceDocument } from "../platform/workspace-document";
import { readSpaceNavigation } from "./space-navigation-state";

export interface WorkspaceSpacesDeps {
  document: WorkspaceDocument | null;
  platform: PlatformClient | null;
  spaces: Record<string, SpaceSummary>;
  spacesRef: MutableRefObject<Record<string, SpaceSummary>>;
  initialSpacesRef: MutableRefObject<SpaceSummary[] | undefined>;
  activeSpaceId: string;
  presenceSpaceId: string | undefined;
  selectedRef: MutableRefObject<string>;
  setSpaceCatalog(list: readonly SpaceSummary[]): void;
  setEmptySpaceId: Dispatch<SetStateAction<string>>;
  selectPage(pageId: string): void;
  restoreSpaceLayout(spaceId: string, fallbackPageId: string): string;
  setPreference<K extends keyof WorkspacePreferences>(key: K, value: WorkspacePreferences[K]): void;
}

export function useWorkspaceSpaces({
  document,
  platform,
  spaces,
  spacesRef,
  initialSpacesRef,
  activeSpaceId,
  presenceSpaceId,
  selectedRef,
  setSpaceCatalog,
  setEmptySpaceId,
  selectPage,
  restoreSpaceLayout,
  setPreference,
}: WorkspaceSpacesDeps) {
  const [rosters, setRosters] = useState<Record<string, SpaceRoster>>({});
  const rosterBookRef = useRef<SpaceRosters | null>(null);

  /* The spaces this member belongs to, kept current by the server's live
     membership feed — a page shared with them appears, a space they were
     removed from (or left) goes — and each space's roster by a feed of its
     own, read again only when that space says someone joined, left, was
     moved or was invited. The SDK catches up after a gap in the stream, so
     nothing is read again for a window coming back into focus. */
  const followedRosterIds = useMemo(() => {
    const ids = new Set<string>();
    for (const space of Object.values(spaces)) {
      if ((activeSpaceId === "personal" && !space.knowledgeBase)
          || space.spaceId === activeSpaceId
          || space.spaceId === presenceSpaceId) {
        ids.add(space.spaceId);
      }
    }
    return [...ids].sort();
  }, [spaces, activeSpaceId, presenceSpaceId]);

  useEffect(() => {
    if (!platform || !document) return;
    let active = true;
    let stop: (() => void) | null = null;
    const book = new SpaceRosters(platform.spaces.watchRoster, (next) => {
      if (active) setRosters(next);
    });
    rosterBookRef.current = book;
    const apply = (list: SpaceSummary[]) => {
      if (!active) return;
      setSpaceCatalog(list);
      // The spaces read, and — moved to Can view — the ones written to no more.
      void document.refreshSpaces(list);
    };
    void platform.spaces.watchInstallations(
      apply,
      initialSpacesRef.current ? { initial: initialSpacesRef.current } : undefined,
    )
      .then((unsubscribe) => {
        if (active) stop = unsubscribe;
        else unsubscribe();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      rosterBookRef.current = null;
      stop?.();
      book.close();
    };
  }, [document, platform, setSpaceCatalog, initialSpacesRef]);

  useEffect(() => {
    rosterBookRef.current?.follow(followedRosterIds);
  }, [followedRosterIds, platform, document]);

  const ensureShareSpace = useCallback(async (pageId: string) => {
    if (!document || !platform) throw new Error("HeiNote is still opening");
    const page = document.state.pages[pageId];
    if (!page) throw new Error("Page no longer exists");
    // Inside a shared tree, a page is shared through its root's space: one
    // page lives in one space.
    const inherited = spaceOfPage(document.state.pages, pageId);
    if (inherited) return inherited;
    const created = await platform.spaces.create(`小黑笔记 · ${pageName(page)}`);
    await document.sharePageTree(pageId, created.spaceId);
    // Nothing is read again: the platform tells a space's maker it opened,
    // in every window, so the live list — and the space's roster — follow.
    return created.spaceId;
  }, [document, platform]);

  const stopSharing = useCallback(async (pageId: string) => {
    if (!document || !platform) return;
    const spaceId = document.state.pages[pageId]?.share_space_id;
    if (!spaceId) return;
    if (spacesRef.current[spaceId]?.knowledgeBase) throw new Error("团队知识库不能转换为个人页面。");
    // The server moves the tree and revokes members, invitations and public
    // links in the same transaction. The owner retains access to old files.
    await document.stopSharing(pageId);
  }, [document, platform, spacesRef]);

  const leaveShare = useCallback(async (pageId: string) => {
    if (!document || !platform) return;
    const spaceId = spaceOfPage(document.state.pages, pageId);
    if (!spaceId) return;
    await platform.spaces.leave(spaceId);
    // Its pages go with it; the open one gives way to the member's first page.
    document.removeSpace(spaceId);
  }, [document, platform]);

  const refreshSpaces = useCallback(async () => {
    if (!platform || !document) return;
    const list = await platform.spaces.installations();
    setSpaceCatalog(list);
    await document.refreshSpaces(list);
  }, [document, platform, setSpaceCatalog]);

  const switchSpace = useCallback((spaceId: string) => {
    if (!document || !platform) return;
    const catalog = spacesRef.current;
    if (spaceId !== "personal" && !catalog[spaceId]?.knowledgeBase) return;
    const remembered = readSpaceNavigation(platform.bootstrap.user.id);
    setEmptySpaceId(spaceId);
    const fallbackPageId = firstPageInSpace(document.state, catalog, spaceId, remembered.pages[spaceId]);
    const restoredPageId = restoreSpaceLayout(spaceId, fallbackPageId);
    const seedPageId = restoredPageId || fallbackPageId || remembered.pages[spaceId] || catalog[spaceId]?.knowledgeBase?.homePageId;
    void document.activateSpace(spaceId, { seedPageId }).then(() => {
      if (selectedRef.current) return;
      const landed = firstPageInSpace(document.state, spacesRef.current, spaceId, remembered.pages[spaceId]);
      if (landed) selectPage(landed);
    }).catch(() => undefined);
    setPreference("sidebar_view", "files");
  }, [document, platform, restoreSpaceLayout, selectPage, setPreference, setEmptySpaceId, selectedRef, spacesRef]);

  const unknownRequests = useRef(new Set<string>());
  const knowledgeBases = useMemo<KnowledgeBaseClient>(() => {
    const perform = async (requestId: string, action: () => Promise<SpaceSummary>, waitForWrites = true): Promise<SpaceSummary> => {
      if (!platform || !document) throw new Error("小黑笔记尚未打开。");
      const work = async () => {
        if (collaborationAccount() !== platform.bootstrap.user.id) throw new Error("账号已改变，请重新打开操作。");
        let result = unknownRequests.current.has(requestId) ? await platform.knowledgeBases.operation(requestId) : undefined;
        if (!result) {
          try { result = await action(); }
          catch (reason) {
            if (reason instanceof ApiError && reason.status < 500) throw reason;
            unknownRequests.current.add(requestId);
            try { result = await platform.knowledgeBases.operation(requestId); } catch { /* Keep the operation id for the next query. */ }
            if (!result) throw new ApiError("操作结果未确认。请保留输入并重试查询。", 503, "result_unknown");
          }
        }
        try { await refreshSpaces(); }
        catch {
          unknownRequests.current.add(requestId);
          throw new ApiError("操作已提交，但空间列表未同步。请重试读取结果。", 503, "result_unknown");
        }
        unknownRequests.current.delete(requestId);
        return result;
      };
      return waitForWrites ? document.afterWrites(work) : work();
    };
    return {
      async create(input) {
        if (!platform) throw new Error("小黑笔记尚未打开。");
        const result = await perform(input.requestId, () => platform.knowledgeBases.create(input), false);
        switchSpace(result.spaceId);
        return result;
      },
      update: (spaceId, input) => perform(input.requestId, () => {
        if (!platform) throw new Error("小黑笔记尚未打开。");
        return platform.knowledgeBases.update(spaceId, input);
      }),
      archive: (spaceId, input) => perform(input.requestId, () => {
        if (!platform) throw new Error("小黑笔记尚未打开。");
        return platform.knowledgeBases.archive(spaceId, input);
      }),
      transfer: (spaceId, input) => perform(input.requestId, () => {
        if (!platform) throw new Error("小黑笔记尚未打开。");
        return platform.knowledgeBases.transfer(spaceId, input);
      }),
      async operation(requestId) {
        if (!platform) throw new Error("小黑笔记尚未打开。");
        return platform.knowledgeBases.operation(requestId);
      },
    };
  }, [document, platform, refreshSpaces, switchSpace]);

  const unknownSort = useRef(new Map<string, { requestId: string; revision: number; sort: WorkspacePreferences["sidebar_sort"] }>());
  const setSidebarSort = useCallback(async (sort: WorkspacePreferences["sidebar_sort"]) => {
    const spaceId = activeSpaceId;
    let space = spacesRef.current[spaceId];
    if (!space?.knowledgeBase) { setPreference("sidebar_sort", sort); return; }
    const pending = unknownSort.current.get(spaceId);
    if (pending) {
      try { await knowledgeBases.update(spaceId, pending); }
      catch (reason) {
        if (!(reason instanceof ApiError && reason.code === "result_unknown")) unknownSort.current.delete(spaceId);
        throw reason;
      }
      if (unknownSort.current.get(spaceId) === pending) unknownSort.current.delete(spaceId);
      space = spacesRef.current[spaceId];
    }
    if (!space?.knowledgeBase || space.knowledgeBase.sort === sort) return;
    const input = { requestId: uuid(), revision: space.knowledgeBase.revision, sort };
    try { await knowledgeBases.update(spaceId, input); }
    catch (reason) {
      if (reason instanceof ApiError && reason.code === "result_unknown") unknownSort.current.set(spaceId, input);
      throw reason;
    }
  }, [activeSpaceId, knowledgeBases, setPreference, spacesRef]);

  return {
    rosters,
    ensureShareSpace,
    stopSharing,
    leaveShare,
    refreshSpaces,
    switchSpace,
    knowledgeBases,
    setSidebarSort,
  };
}
