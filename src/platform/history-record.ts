import { normalizeVersion } from "../core/workspace-state";
import type { HistoryPart, PageVersion } from "../core/types";
import { historyId } from "./record-ids";

/* A checkpoint of a page is kept in parts: its JSON cut into records small
   enough for any host, each naming the page, the version, how many parts
   there are and which generation of the checkpoint it belongs to — a
   checkpoint written again (coalesced) is a new generation, so parts of two
   are never read as one. How large a checkpoint may be at all is
   versionWrites' to say (core/versions.ts). */

const CHUNK_CHARACTERS = 12 * 1024;

/** A short digest of a checkpoint's JSON: the same words, the same
 *  generation, wherever it is cut. */
function generationOf(payload: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < payload.length; index += 1) {
    const code = payload.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x5bd1e995);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}${payload.length.toString(36)}`;
}

const parted = new WeakMap<PageVersion, Array<{ id: string; value: HistoryPart }>>();

/** A checkpoint as the records that keep it. */
export function historyParts(version: PageVersion): Array<{ id: string; value: HistoryPart }> {
  const known = parted.get(version);
  if (known) return known;
  const payload = JSON.stringify(version);
  const pieces: string[] = [];
  for (let start = 0; start < payload.length;) {
    let end = Math.min(start + CHUNK_CHARACTERS, payload.length);
    // JSON.stringify leaves valid emoji as UTF-16 pairs. A record cannot
    // contain a lone surrogate, even when a later part would complete it.
    const last = payload.charCodeAt(end - 1);
    if (end < payload.length && last >= 0xd800 && last <= 0xdbff) end--;
    pieces.push(payload.slice(start, end)); start = end;
  }
  const generation = generationOf(payload);
  const parts = pieces.map((piece, part) => ({
    id: historyId(version.page_id, version.id, part),
    value: { page: version.page_id, version: version.id, generation, created_at: version.created_at, part, parts: pieces.length, payload: piece },
  }));
  parted.set(version, parts);
  return parts;
}

/** The checkpoint its parts make, when every part of one generation is
 *  there: never a partial or mixed-generation one. Each part's shape is held
 *  to schema.ts by every host. */
export function versionOfParts(parts: ReadonlyArray<readonly [string, unknown]>): PageVersion | null {
  const all = parts.map(([, value]) => value as HistoryPart);
  const header = all.find((part) => part.part === 0);
  if (!header) return null;
  const matching = all.filter((part) => part.generation === header.generation).toSorted((a, b) => a.part - b.part);
  if (matching.length !== header.parts || matching.some((part, index) => part.part !== index)) return null;
  try {
    const version = normalizeVersion(JSON.parse(matching.map((part) => part.payload).join("")));
    return version && version.id === header.version && version.page_id === header.page && version.snapshot.id === header.page ? version : null;
  } catch {
    // A payload that does not read as a checkpoint cannot affect the page.
    return null;
  }
}
