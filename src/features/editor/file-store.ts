import { isRetryable, type FileUrl } from "../../platform/schema";
import { isImageType } from "../../core/files";
import { createId } from "../../core/ids";
import type { StoredFile } from "../../core/types";
import type { PlatformClient } from "../../platform/client";
import { thumbnail } from "../../shared/thumbnail";

/* Image and file blocks' bytes.

   The platform stores bytes and nothing else: every read is fresh (nothing is
   cached on the way), and there is no resizing. So what is stored is shown
   through the SDK (`files.url`, a bucket's `url`): a picture is read once a
   session however often its page is opened, never let go of under a view
   that shows it, and let go of oldest first once nothing shows it and the
   session holds more than 96 MiB — and the uploader's browser, which holds a
   photo anyway, makes the smaller copy the page draws (shared/thumbnail.ts).
   What is being uploaded exists only in this window until it is written: it
   is drawn from the bytes in hand. A file never changes once written (its
   path carries an id of its own), so what is shown is never stale. */

type Files = PlatformClient["files"];

/** The same ceiling Chats uses, well inside what one request may carry. */
export const MAX_FILE_BYTES = 7.5 * 1024 * 1024;
export const MAX_FILES_AT_ONCE = 10;

/** Why these files cannot be uploaded, or null when they can. */
export function refuseFiles(files: File[]): string | null {
  if (files.length > MAX_FILES_AT_ONCE) return `Add up to ${MAX_FILES_AT_ONCE} files at a time.`;
  const oversized = files.find((file) => file.size > MAX_FILE_BYTES);
  return oversized ? `${oversized.name || "That file"} is larger than 7.5 MB.` : null;
}

export { isImageType };

/** A name the store accepts as a path segment: letters, digits, dots and
 *  dashes, the extension kept. The file keeps its real name for display. */
export function safeFileName(name: string): string {
  const cleaned = name.normalize("NFKD").replace(/[^\w.-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return (cleaned || "file").slice(-80);
}

/** The space a page's files belong in: the space the page lives in. */

/* ── What this window holds ──────────────────────────────────────────────── */

/** Where a file's bytes are, as the SDK keys them: the space's bucket, or
 *  the member's own store. */
const keyOf = (file: Pick<StoredFile, "space">, path: string) => `${file.space ?? ""}\n${path}`;

const pause = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

/* Bytes this window has before the platform does: a file on its way up is
   drawn from the uploader's own bytes at once. An entry stays while its
   upload is on its way or a view shows it — written, the SDK holds what it
   wrote for the next view. A URL a view shows is never revoked under it. */
interface InHand {
  blob: Blob;
  url: string;
  views: number;
  pending: boolean;
}
const inHand = new Map<string, InHand>();

/** Lets go of bytes in hand once nothing needs them. */
function letGo(key: string): void {
  const entry = inHand.get(key);
  if (!entry || entry.pending || entry.views) return;
  inHand.delete(key);
  URL.revokeObjectURL(entry.url);
}

/** Keep bytes in hand for a file on its way up; answers the URL views draw. */
function holdInHand(key: string, blob: Blob): string {
  const known = inHand.get(key);
  if (known) {
    known.pending = true;
    return known.url;
  }
  const entry: InHand = { blob, url: URL.createObjectURL(blob), views: 0, pending: true };
  inHand.set(key, entry);
  return entry.url;
}

/** The platform has them now (or never will): kept for views alone. */
function settleInHand(key: string): void {
  const entry = inHand.get(key);
  if (entry) entry.pending = false;
  letGo(key);
}

/* What views hold of what the SDK shows, by key: a URL a view holds is never
   revoked under it, so another view of the same file draws it on its first
   frame. */
const viewed = new Map<string, { url: string; views: number }>();

function viewing(key: string, url: string): () => void {
  const known = viewed.get(key);
  if (known) known.views += 1;
  else viewed.set(key, { url, views: 1 });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const entry = viewed.get(key);
    if (!entry) return;
    entry.views -= 1;
    if (entry.views <= 0) viewed.delete(key);
  };
}

/* A block can arrive before its bytes do — the uploader's page saves the
   block at once and the bytes behind it, and a large photo on a slow line
   takes a while — so a read that finds nothing yet is tried again for half a
   minute before it counts. One that can never succeed (no access, the
   session ended) counts at once. */
const READ_RETRIES_MS = [0, 800, 2000, 4000, 8000, 15000];

const worthWaiting = (error: unknown) => isRetryable(error) || (error as { code?: unknown } | null)?.code === "not_found";

/** The picture to draw on the page: its smaller copy when there is one. */
function drawnPath(file: StoredFile, which: "page" | "original"): string {
  return which === "page" && file.preview ? file.preview : file.path;
}

/** A file on screen: its address at once when this session has its bytes,
 *  else once they are read; held for the view until `release`. */
export interface ShownFile {
  url: string | null;
  ready: Promise<string>;
  release(): void;
}

/** A URL for the bytes when this window already has them on screen or in
 *  hand — so a picture can be drawn on its first frame rather than a later
 *  one. Holds nothing. */
export function peekFileUrl(file: StoredFile, which: "page" | "original" = "page"): string | null {
  const peek = (path: string) => inHand.get(keyOf(file, path))?.url ?? viewed.get(keyOf(file, path))?.url ?? null;
  return peek(drawnPath(file, which)) ?? peek(file.path);
}

/** One stored file's bytes on screen through the SDK, read again while the
 *  bytes may still be on their way (READ_RETRIES_MS). */
function shownStored(files: Files, file: StoredFile, path: string): ShownFile {
  const key = keyOf(file, path);
  const held = inHand.get(key);
  if (held) {
    held.views += 1;
    let released = false;
    return {
      url: held.url,
      ready: Promise.resolve(held.url),
      release() {
        if (released) return;
        released = true;
        held.views -= 1;
        letGo(key);
      },
    };
  }
  let current: FileUrl = files.url(path, { spaceId: file.space });
  let released = false;
  let unview: (() => void) | null = null;
  const ready = (async () => {
    let failure: unknown;
    for (const [attempt, delay] of READ_RETRIES_MS.entries()) {
      if (attempt) {
        await pause(delay);
        if (released) break;
        current.release();
        current = files.url(path, { spaceId: file.space });
      }
      try {
        const url = current.url ?? await current.ready;
        if (!released) unview = viewing(key, url);
        return url;
      } catch (error) {
        failure = error;
        if (!worthWaiting(error)) break;
      }
    }
    throw failure ?? new Error("The file was let go of before it was read");
  })();
  ready.catch(() => undefined);
  return {
    url: current.url,
    ready,
    release() {
      if (released) return;
      released = true;
      unview?.();
      current.release();
    },
  };
}

/** A file's bytes to draw, read once however many views show it and held
 *  until the view lets go. */
export function showFile(files: Files, file: StoredFile, which: "page" | "original" = "page"): ShownFile {
  const path = drawnPath(file, which);
  const view = shownStored(files, file, path);
  if (path === file.path) return view;
  // A smaller copy that cannot be read is no reason not to show the picture.
  let released = false;
  let original: ShownFile | null = null;
  const ready = view.ready.catch((error: unknown) => {
    if (released) throw error;
    original = shownStored(files, file, file.path);
    return original.ready;
  });
  ready.catch(() => undefined);
  return {
    url: view.url,
    ready,
    release() {
      released = true;
      view.release();
      original?.release();
    },
  };
}

/** What a view shows before Notes has opened: nothing, for now. */
export function notShown(): ShownFile {
  const ready = Promise.reject(new Error("Notes is still opening"));
  ready.catch(() => undefined);
  return { url: null, ready, release() {} };
}

/** A file's bytes themselves (to save or copy on): in hand, or from this
 *  session's copy, read once. */
async function bytesOf(files: Files, file: StoredFile, path: string): Promise<Blob> {
  const held = inHand.get(keyOf(file, path));
  if (held) return held.blob;
  const shown = shownStored(files, file, path);
  try {
    const url = shown.url ?? await shown.ready;
    return await (await fetch(url)).blob();
  } finally {
    shown.release();
  }
}

/** Saves the original to the reader's computer. Handed over as plain bytes,
 *  so a file that is really a web page or an SVG is saved, never opened as
 *  a page of this app. */
export async function downloadFile(files: Files, file: StoredFile): Promise<void> {
  const blob = await bytesOf(files, file, file.path);
  const url = URL.createObjectURL(new Blob([blob], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name || "file";
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/* ── Uploading ───────────────────────────────────────────────────────────── */

/** Header-only: an <img> knows its size once loaded, long before anything
 *  forces a full decode. */
function naturalSize(url: string): Promise<{ width?: number; height?: number }> {
  if (typeof Image === "undefined") return Promise.resolve({});
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image.naturalWidth && image.naturalHeight ? { width: image.naturalWidth, height: image.naturalHeight } : {});
    image.onerror = () => resolve({});
    image.src = url;
  });
}

/** Twice the widest a page draws a picture, so the copy is sharp on a 2×
 *  screen; a picture no bigger and no heavier than this is its own copy. */
const PREVIEW_EDGE = 1600;
const SMALL_ENOUGH_BYTES = 600 * 1024;

async function makePreview(bytes: Blob, file: StoredFile): Promise<Blob | null> {
  const { type, width, height } = file;
  // A GIF's copy would stop it moving; an SVG is drawn sharp at any size.
  if (!/^image\/(?:png|jpe?g|webp|avif|bmp)$/.test(type) || !width || !height) return null;
  if (Math.max(width, height) <= PREVIEW_EDGE && bytes.size <= SMALL_ENOUGH_BYTES) return null;
  try {
    // WebP; a browser that cannot encode it gives a photograph back as JPEG,
    // and a picture that may be transparent as PNG.
    const { blob } = await thumbnail(bytes, { maxEdge: PREVIEW_EDGE, type: "image/webp", quality: 0.86 });
    return blob.size < bytes.size ? blob : null;
  } catch {
    return null;
  }
}

export interface StagedFile {
  /** The block's file, final from the start — drawn at once from the bytes
   *  in hand, while `transfer` writes them. */
  file: StoredFile;
  /** Writes the bytes; answers with the file as stored, its page copy added. */
  transfer(): Promise<StoredFile>;
}

export async function stageFile(
  files: Files,
  source: File,
  place: { pageId: string; owner: string; space?: string },
): Promise<StagedFile> {
  const path = `files/${place.pageId.replace(/[^\w-]/g, "")}/${createId("file")}/${safeFileName(source.name)}`;
  const type = (source.type || "application/octet-stream").toLowerCase();
  const base: StoredFile = {
    path,
    owner: place.owner,
    ...(place.space ? { space: place.space } : {}),
    name: source.name || "file",
    size: source.size,
    type,
  };
  const url = holdInHand(keyOf(base, path), source);
  const file = isImageType(type) ? { ...base, ...(await naturalSize(url)) } : base;
  return {
    file,
    async transfer() {
      // Written, the SDK holds what it wrote where the next view looks; until
      // then (and for views already drawing it) the bytes stay in hand.
      try {
        const [preview] = await Promise.all([
          makePreview(source, file),
          files.write(path, source, { spaceId: file.space, mediaType: type }),
        ]);
        if (!preview) return file;
        const previewPath = `${path}.page`;
        try {
          await files.write(previewPath, preview, { spaceId: file.space, mediaType: preview.type });
        } catch {
          return file;
        }
        return { ...file, preview: previewPath };
      } finally {
        settleInHand(keyOf(file, path));
      }
    },
  };
}

/** A copy of a file in another member's or space's store — for a block now
 *  in a page whose readers cannot reach where its bytes were written: a page
 *  shared after its pictures went in, or a block pasted across. */
/* Files being copied to where their page's readers can reach them, by what
   holds them, the file and the place: once a session, however many views
   show them. */
const homing = new Set<string>();

/** A file its page's readers cannot reach — written to a member's own store
 *  before the page was shared, or to another space — copied to where they
 *  can (`space`; none: the member's own store), once, by whoever can read
 *  it; `settle` records the copy where the file was. A private file is only
 *  its owner's to read. `holder` names what holds the file. */
export function homeFile(files: Files, me: string, file: StoredFile, space: string | undefined, holder: string, settle: (copy: StoredFile) => void): void {
  if ((file.space ?? "") === (space ?? "")) return;
  if (!file.space && file.owner !== me) return;
  const key = `${holder}\n${file.path}\n${space ?? ""}`;
  if (homing.has(key)) return;
  homing.add(key);
  void copyFile(files, file, { owner: me, space }).then(settle).catch(() => {
    // Not readable from here: a member who can read it will move it.
  });
}

export async function copyFile(files: Files, file: StoredFile, to: { owner: string; space?: string }): Promise<StoredFile> {
  const { space: _from, preview: _preview, ...rest } = file;
  const copy: StoredFile = { ...rest, owner: to.owner, ...(to.space ? { space: to.space } : {}) };
  const original = await bytesOf(files, file, file.path);
  await files.write(copy.path, original, { spaceId: copy.space, mediaType: file.type });
  if (file.preview) {
    try {
      const smaller = await bytesOf(files, file, file.preview);
      await files.write(file.preview, smaller, { spaceId: copy.space, mediaType: smaller.type || "image/webp" });
      return { ...copy, preview: file.preview };
    } catch {
      return copy;
    }
  }
  return copy;
}
