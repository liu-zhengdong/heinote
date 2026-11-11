import { useEffect, useState } from "react";
import { api } from "../account/api";

/** One public read-only link (`GET /api/shares`). */
export interface PublicLinkItem {
  id: string;
  url: string;
  pageId: string;
  createdAt: string;
}

/** Sidebar listens for this to re-read the list after create/revoke. */
export const PUBLIC_LINKS_CHANGED = "notes:public-links-changed";

export function notifyPublicLinksChanged(): void {
  window.dispatchEvent(new Event(PUBLIC_LINKS_CHANGED));
}

/** Every public link of the signed-in member, refreshed on the event above
 *  (and once on mount). Public links live outside the workspace records, so
 *  they ride their own fetch instead of the document store. */
export function usePublicLinks(): PublicLinkItem[] {
  const [items, setItems] = useState<PublicLinkItem[]>([]);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const bump = () => setRevision((current) => current + 1);
    window.addEventListener(PUBLIC_LINKS_CHANGED, bump);
    return () => window.removeEventListener(PUBLIC_LINKS_CHANGED, bump);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void api<PublicLinkItem[]>("/api/shares", { signal: controller.signal })
      .then((links) => { if (!controller.signal.aborted) setItems(links); })
      .catch(() => { /* Links are a sidebar nicety — stay empty on failure. */ });
    return () => controller.abort();
  }, [revision]);
  return items;
}
