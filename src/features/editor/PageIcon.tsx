import { useEffect, type ReactNode } from "react";
import { AppWindow, FileText, Table2 } from "lucide-react";
import { useWorkspace } from "../../app/workspace-context";
import { normalizeStoredFile } from "../../core/files";
import type { NotePage, StoredFile } from "../../core/types";
import { homeFile, notShown, showFile } from "./file-store";
import { useFileUrl } from "./MediaBlocks";
import { pageIcon } from "./page-decoration";

/* A page's picture icon: stored with its page the way an image block's
   bytes are, drawn wherever the page is marked — its head, the page list, a
   link to it among the words — and moved with the page when it is shared. */

type Workspace = Pick<ReturnType<typeof useWorkspace>, "document" | "commitWrites">;

/* ---- the icons a member reached for last, remembered on this machine ---- */

export type RecentIcon = { k: "e"; v: string } | { k: "f"; f: StoredFile };

const RECENT_LIMIT = 12;

function recentsKey(account: string | undefined): string {
  return `notes.recentPageIcons.${account ?? "local"}`;
}

/** What was picked for page icons on this account, newest first. */
export function recentIcons(account: string | undefined): RecentIcon[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(recentsKey(account)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is RecentIcon =>
      !!item && typeof item === "object" && ((item as RecentIcon).k === "e" || (item as RecentIcon).k === "f")) : [];
  } catch {
    return [];
  }
}

function writeRecents(account: string | undefined, picked: RecentIcon): RecentIcon[] {
  const same = (item: RecentIcon) =>
    picked.k === "e" ? item.k === "e" && item.v === picked.v : item.k === "f" && item.f.path === picked.f.path;
  const next = [picked, ...recentIcons(account).filter((item) => !same(item))].slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(recentsKey(account), JSON.stringify(next));
  } catch { /* a full or unavailable store loses nothing else */ }
  return next;
}

/** One more emoji remembered. */
export function rememberIcon(account: string | undefined, emoji: string): RecentIcon[] {
  return writeRecents(account, { k: "e", v: emoji });
}

/** One more picture remembered: its file — the stored record, once it is
 *  one — so the recents grid can draw it again. */
export function rememberIconFile(account: string | undefined, file: StoredFile): RecentIcon[] {
  return writeRecents(account, { k: "f", f: file });
}

/** The remembered picture `path` names, or none — it may have been dropped
 *  from the list since the picker's grid was drawn. */
export function recentsFile(path: string, account: string | undefined): StoredFile | undefined {
  const found = recentIcons(account).find((item) => item.k === "f" && item.f.path === path);
  return found?.k === "f" ? found.f : undefined;
}

/** The picture, at icon size: drawn from this session's bytes when it has
 *  them, else once they are read; `fallback` while they are not on screen —
 *  which is also what a file gone or out of reach leaves. */
export function IconImage({ file, size = 16, className = "page-icon-image", fallback = null }: {
  file: StoredFile;
  size?: number;
  className?: string;
  fallback?: ReactNode;
}) {
  const { platform } = useWorkspace();
  const { url } = useFileUrl(file, "page", {
    showFile: (shown, which) => (platform ? showFile(platform.files, shown, which) : notShown()),
  });
  return url
    ? <img className={className} src={url} alt="" width={size} height={size} draggable={false} />
    : <>{fallback}</>;
}

/** How a page is marked wherever it is named — the picture or emoji it was
 *  given, or its glyph, a database's being its table. */
export function PageIconMark({ page, size = 16 }: { page: Pick<NotePage, "icon" | "icon_image" | "kind"> | undefined; size?: number }) {
  const icon = page ? pageIcon(page) : null;
  if (icon?.kind === "image") {
    return <IconImage file={icon.file} size={size}
      fallback={page?.kind === "database" ? <Table2 size={size} /> : page?.kind === "app" ? <AppWindow size={size} /> : <FileText size={size} />} />;
  }
  if (icon?.kind === "emoji") return <>{icon.emoji}</>;
  return page?.kind === "database" ? <Table2 size={size} /> : page?.kind === "app" ? <AppWindow size={size} /> : <FileText size={size} />;
}

/** An icon's picture back as stored — its smaller copy made, or its bytes
 *  moved to where the page's readers can reach them — unless the icon has
 *  changed meanwhile. Bookkeeping, so it is not a step of undo. */
export function settleIcon(workspace: Workspace, pageId: string, path: string, stored: StoredFile): void {
  const current = workspace.document?.state.pages[pageId];
  if (!current || normalizeStoredFile(current.icon_image)?.path !== path) return;
  workspace.commitWrites([{ type: "set", path: ["pages", pageId, "icon_image"], value: stored }], false);
}

/** An icon picture its page's readers cannot reach — uploaded before the
 *  page was shared, or carried into another space — is copied to where they
 *  can, once, by whoever can read it: a cover's rule. */
export function useHomedIcons(pages: readonly NotePage[], space: string | undefined): void {
  const workspace = useWorkspace();
  const signature = pages
    .map((page) => {
      const icon = pageIcon(page);
      return icon?.kind === "image" ? `${page.id}:${icon.file.path}:${icon.file.owner}:${icon.file.space ?? ""}` : "";
    })
    .filter(Boolean)
    .join(",");
  useEffect(() => {
    const { platform, canEdit } = workspace;
    if (!platform || !signature) return;
    for (const page of pages) {
      const icon = pageIcon(page);
      if (icon?.kind !== "image" || !canEdit(page.id)) continue;
      const file = icon.file;
      homeFile(platform.files, platform.bootstrap.user.id, file, space, `icon ${page.id}`, (copy) => settleIcon(workspace, page.id, file.path, copy));
    }
    // `signature` and `space` name everything about the icons that decides
    // what is copied.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, space]);
}
