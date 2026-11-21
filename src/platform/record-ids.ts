/* The ids of a page's records: `<length>_<page id>_<rest>`, length-prefixed
   so a page id and what follows it never run into each other.

   - a paragraph: `<n>_<page id>_<block id>`;
   - a part of a checkpoint: `<n>_<page id>_<version id>[.part.<k>]`. */

const pageScopedId = (pageId: string, rest: string) => `${pageId.length}_${pageId}_${rest}`;

function parsePageScopedId(id: string): { pageId: string; rest: string } | null {
  const length = /^(\d+)_/.exec(id);
  if (!length) return null;
  const start = length[0].length;
  const pageId = id.slice(start, start + Number(length[1]));
  const rest = id.slice(start + pageId.length + 1);
  return pageId.length === Number(length[1]) && id[start + pageId.length] === "_" && rest ? { pageId, rest } : null;
}

export const blockRecordId = (pageId: string, blockId: string) => pageScopedId(pageId, blockId);

/** The owning page id of any page-scoped record id (block, version, or event). */
export const pageOfRecordId = (id: string): string | null => parsePageScopedId(id)?.pageId ?? null;

export function parseBlockRecordId(id: string): { pageId: string; blockId: string } | null {
  const parsed = parsePageScopedId(id);
  return parsed && { pageId: parsed.pageId, blockId: parsed.rest };
}

export const historyId = (pageId: string, versionId: string, part: number) =>
  pageScopedId(pageId, `${versionId}${part ? `.part.${part}` : ""}`);

/** The page, version and part a history record's id names. */
export function parseHistoryId(id: string): { pageId: string; versionId: string; part: number } | null {
  const parsed = parsePageScopedId(id);
  if (!parsed) return null;
  const parted = /^(.*)\.part\.(\d+)$/.exec(parsed.rest);
  const versionId = parted ? parted[1] : parsed.rest;
  return versionId ? { pageId: parsed.pageId, versionId, part: parted ? Number(parted[2]) : 0 } : null;
}

/* An edit event's id: `event.<event id>` under its page, so the page's
   records — blocks, checkpoints, events — all leave with it. */
export const eventId = (pageId: string, id: string) => pageScopedId(pageId, `event.${id}`);

/** The page and event an event record's id names. */
export function parseEventId(id: string): { pageId: string; eventId: string } | null {
  const parsed = parsePageScopedId(id);
  if (!parsed || !parsed.rest.startsWith("event.")) return null;
  return { pageId: parsed.pageId, eventId: parsed.rest.slice(6) };
}
