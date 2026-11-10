/* Where a click asked to land: a page, and a block or paragraph on it. The
   editor of that page takes it as soon as it is open — the one on screen, or
   the one opening — so anything can send the reader to a block: a link, a
   backlink, the page list. */

let pending: { pageId: string; blockId: string } | null = null;

/** Dispatched on the window when a landing is asked for on the page already
 *  open, so its editor takes it at once. */
export const LAND_EVENT = "notes:land-on-block";

export function requestLanding(pageId: string, blockId: string): void {
  pending = { pageId, blockId };
}

/** The block to land on in `pageId`, if a landing there was asked for — once,
 *  by an editor that `shows` it. */
export function takeLanding(pageId: string, shows: (blockId: string) => boolean = () => true): string | null {
  if (!pending || pending.pageId !== pageId || !shows(pending.blockId)) return null;
  const { blockId } = pending;
  pending = null;
  return blockId;
}
