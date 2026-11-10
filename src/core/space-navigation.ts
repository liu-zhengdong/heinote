import { inTrash, spaceOfPage } from "./page-tree";
import type { NotePage, SpaceSummary, WorkspaceState } from "./types";

/** Ordinary shared pages stay in the existing personal navigation. */
export function navigationSpaceOf(pages: Record<string, NotePage>, spaces: Record<string, SpaceSummary>, pageId: string): string {
  const scope = spaceOfPage(pages, pageId);
  return scope && spaces[scope]?.knowledgeBase ? scope : "personal";
}

export function pagesInSpace(pages: Record<string, NotePage>, spaces: Record<string, SpaceSummary>, spaceId: string): Record<string, NotePage> {
  return Object.fromEntries(Object.entries(pages).filter(([id]) => navigationSpaceOf(pages, spaces, id) === spaceId));
}

export function firstPageInSpace(state: WorkspaceState, spaces: Record<string, SpaceSummary>, spaceId: string, rememberedId?: string): string {
  const available = (id: string) => Boolean(state.pages[id] && !inTrash(state.pages, id) && navigationSpaceOf(state.pages, spaces, id) === spaceId);
  if (rememberedId && available(rememberedId)) return rememberedId;
  if (spaceId !== "personal") {
    const home = spaces[spaceId]?.knowledgeBase?.homePageId;
    return home && available(home) ? home : "";
  }
  return state.roots.find(available) ?? Object.keys(state.pages).find(available) ?? "";
}
