import { useCallback } from "react";
import { useUi } from "../app/ui-context";

/** A page's own address: this app's, landing on the page — a block, which is
 *  a page, lands on it in the page it is shown in. */
export function pageUrl(pageId: string): string {
  return `${window.location.origin}${window.location.pathname}#${pageId}`;
}

/** Copies a page's link and says whether it could — one way wherever a page's
 *  link is copied: its bar, its menus, the page list, Share. */
export function useCopyPageLink(): (pageId: string) => void {
  const { toast } = useUi();
  return useCallback((pageId: string) => {
    void navigator.clipboard.writeText(pageUrl(pageId))
      .then(() => toast("Link copied to clipboard", "success"))
      .catch(() => toast("Could not copy that link", "error"));
  }, [toast]);
}
