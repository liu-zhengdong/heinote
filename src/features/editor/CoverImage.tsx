import { useEffect } from "react";
import { useWorkspace } from "../../app/workspace-context";
import { normalizeStoredFile } from "../../core/files";
import type { NotePage, StoredFile } from "../../core/types";
import { homeFile, notShown, showFile } from "./file-store";
import { useFileUrl } from "./MediaBlocks";
import { pageCover } from "./page-decoration";

/* A cover from the member's computer: a picture stored with its page the way
   an image block's bytes are, drawn wherever the page's cover is — its head,
   a gallery card — and moved with the page when it is shared. */

type Workspace = Pick<ReturnType<typeof useWorkspace>, "document" | "commitWrites">;

/** The picture, filling its box: drawn from this session's bytes when it has
 *  them, else once they are read. Until then the box shows its own fill. */
export function CoverImage({ file, className }: { file: StoredFile; className: string }) {
  const { platform } = useWorkspace();
  const { url } = useFileUrl(file, "page", {
    showFile: (shown, which) => (platform ? showFile(platform.files, shown, which) : notShown()),
  });
  return url ? <img className={className} src={url} alt="" draggable={false} /> : null;
}

/** Puts a page's cover back as stored — its smaller copy made, or its bytes
 *  moved to where the page's readers can reach them — unless the cover has
 *  changed meanwhile. Bookkeeping, so it is not a step of undo. */
export function settleCover(workspace: Workspace, pageId: string, path: string, stored: StoredFile): void {
  const current = workspace.document?.state.pages[pageId];
  if (!current || normalizeStoredFile(current.cover_image)?.path !== path) return;
  workspace.commitWrites([{ type: "set", path: ["pages", pageId, "cover_image"], value: stored }], false);
}

/** A cover its page's readers cannot reach — uploaded before the page was
 *  shared, or carried into another space — is copied to where they can,
 *  once, by whoever can read it: an image block's rule. `space` is where the
 *  pages live now, read from the store. */
export function useHomedCovers(pages: readonly NotePage[], space: string | undefined): void {
  const workspace = useWorkspace();
  const signature = pages
    .map((page) => {
      const cover = pageCover(page);
      return cover?.kind === "image" ? `${page.id}:${cover.file.path}:${cover.file.owner}:${cover.file.space ?? ""}` : "";
    })
    .filter(Boolean)
    .join(",");
  useEffect(() => {
    const { platform, canEdit } = workspace;
    if (!platform || !signature) return;
    for (const page of pages) {
      const cover = pageCover(page);
      if (cover?.kind !== "image" || !canEdit(page.id)) continue;
      const file = cover.file;
      homeFile(platform.files, platform.bootstrap.user.id, file, space, `cover ${page.id}`, (copy) => settleCover(workspace, page.id, file.path, copy));
    }
    // `signature` and `space` name everything about the covers that decides
    // what is copied.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, space]);
}
