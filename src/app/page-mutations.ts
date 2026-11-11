import type { NotePage } from "../core/types";
import type { WorkspaceMutation } from "../platform/workspace-document";
import type { PagePatch } from "./workspace-context";

/** The mutations updatePage makes for a patch on one page — the changed
 *  fields, plus the touched stamps — handed back instead of committed, so a
 *  change that owes several pages (a relation's two sides) lands in one
 *  commit or not at all. */
export function pagePatchMutations(
  pages: Record<string, NotePage>,
  author: string,
  pageId: string,
  patch: PagePatch,
): WorkspaceMutation[] {
  const page = pages[pageId];
  if (!page) return [];
  const mutations: WorkspaceMutation[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (JSON.stringify(page[key as keyof NotePage]) === JSON.stringify(value)) continue;
    mutations.push(value === undefined
      ? { type: "delete", path: ["pages", pageId, key] }
      : { type: "set", path: ["pages", pageId, key], value });
  }
  if (mutations.length) {
    mutations.push({ type: "set", path: ["pages", pageId, "updated_at"], value: new Date().toISOString() });
    mutations.push({ type: "set", path: ["pages", pageId, "updated_by"], value: author });
  }
  return mutations;
}
