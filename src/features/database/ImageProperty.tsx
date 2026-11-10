import { GripVertical, ImageIcon, ImageOff, Plus, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Popover } from "../../components/Popover";
import { useUi } from "../../app/ui-context";
import { useWorkspace } from "../../app/workspace-context";
import { formatFileSize } from "../../core/files";
import type { DatabaseProperty, NotePage, StoredFile } from "../../core/types";
import { rectOf, type AnchorRect } from "../../hooks/useAnchoredPosition";
import type { WorkspaceMutation } from "../../platform/workspace-document";
import {
  downloadFile,
  homeFile,
  isImageType,
  MAX_FILE_BYTES,
  notShown,
  showFile,
  stageFile,
  type StagedFile,
} from "../editor/file-store";
import { ImageViewer, useFileUrl } from "../editor/MediaBlocks";
import { MAX_ROW_IMAGES, propertyName, rowImages } from "./database-model";

/* An Image property's pictures — Notion's Files & media, for pictures. Their
   bytes are stored the way an image block's are (`stageFile`: with the row,
   in the member's own store or the space the row lives in, a smaller copy
   made for large photos) and drawn through the SDK's media; the references
   live on the row, in `property_files`, one list per property, in the order
   the cell shows them — the first is a gallery card's picture.

   A cell takes pictures every way Notion's does: picked, several at once;
   dropped; or pasted — ⌘V while its list is open, or while the cell itself
   has the keyboard. It holds up to MAX_ROW_IMAGES; they are drawn at once
   from the bytes in hand and go up a few at a time behind. A picture pressed
   in the cell opens full size, as Notion's does; the rest of the cell opens
   its list, which puts them in order by dragging (or Alt+↑/↓), adds and
   takes out. The full-size view steps through them with ← and →. */

type Workspace = Pick<ReturnType<typeof useWorkspace>, "document" | "platform" | "commitWrites">;

/** A cell's pictures as the row holds them this moment. */
function currentFiles(workspace: Workspace, pageId: string, propertyId: string): StoredFile[] {
  return rowImages(workspace.document?.state.pages[pageId], propertyId);
}

/* A row's record — its words, its properties and every cell's pictures — must
   stay inside the platform's per-record limit (128 KiB) with room left for its
   name's runs. Pictures that would take it past this are refused here,
   where the reader can be told, rather than left to fail at saving. */
const ROW_RECORD_BUDGET = 96 * 1024;

function fitsRow(row: NotePage | undefined, propertyId: string, next: StoredFile[]): boolean {
  if (!row) return false;
  const { block_tree: _body, ...fields } = row;
  const record = { ...fields, property_files: { ...fields.property_files, [propertyId]: next } };
  return new TextEncoder().encode(JSON.stringify(record)).byteLength <= ROW_RECORD_BUDGET;
}

/** Writes a cell's pictures: `property_files/<property>` of the row alone, so
 *  two people adding pictures to two columns of one row at once both keep
 *  theirs. Never a row that is not there. `record: false` keeps bookkeeping
 *  — a page copy made, bytes moved — out of undo. */
function writeFiles(workspace: Workspace, pageId: string, propertyId: string, next: StoredFile[], record = true): void {
  const { document, platform, commitWrites } = workspace;
  if (!platform || !document?.state.pages[pageId]) return;
  if (!next.length && !currentFiles(workspace, pageId, propertyId).length) return;
  const path = ["pages", pageId, "property_files", propertyId];
  const mutations: WorkspaceMutation[] = [next.length ? { type: "set", path, value: next } : { type: "delete", path }];
  if (record) {
    mutations.push(
      { type: "set", path: ["pages", pageId, "updated_at"], value: new Date().toISOString() },
      { type: "set", path: ["pages", pageId, "updated_by"], value: platform.bootstrap.user.displayName },
    );
  }
  commitWrites(mutations, record);
}

/** Puts a file back as stored — its page copy made, or its bytes moved to
 *  where the row's readers can reach them — unless it has gone meanwhile. */
function settleFile(workspace: Workspace, pageId: string, propertyId: string, path: string, stored: StoredFile): void {
  const files = currentFiles(workspace, pageId, propertyId);
  if (!files.some((file) => file.path === path)) return;
  writeFiles(workspace, pageId, propertyId, files.map((file) => (file.path === path ? stored : file)), false);
}

/* Pictures go up a few at a time: fifty dropped at once would otherwise all
   start together, each with its smaller copy being made. */
const UPLOADS_AT_ONCE = 3;
let uploading = 0;
const waiting: Array<() => void> = [];

function queueUpload<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      uploading += 1;
      task().then(resolve, reject).finally(() => {
        uploading -= 1;
        waiting.shift()?.();
      });
    };
    if (uploading < UPLOADS_AT_ONCE) start();
    else waiting.push(start);
  });
}

/** The files a paste carries: a screenshot, an image copied from a web page,
 *  files copied from the computer's own file manager. */
function pastedFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = [...data.files];
  if (files.length) return files;
  const fromItems: File[] = [];
  for (const item of data.items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) fromItems.push(file);
  }
  return fromItems;
}

/* A picture a row's readers cannot reach — written to a member's own store
   before the database was shared, or to another space — is copied to where
   they can, once, by whoever can read it (an image block's rule). It is the
   database's to do for every row, whatever its view draws, and the side
   peek's for the row it shows: `space` is where they live now, read from
   the store, so sharing a page anywhere above them is noticed. */
export function useHomedImages(rows: readonly NotePage[], properties: readonly DatabaseProperty[], space: string | undefined): void {
  const workspace = useWorkspace();
  const images = properties.filter((property) => property.type === "image");
  const signature = images.length
    ? rows.map((row) => images.map((property) => rowImages(row, property.id)
      .map((file) => `${row.id}:${property.id}:${file.path}:${file.owner}:${file.space ?? ""}`).join(",")).join(",")).join(",")
    : "";
  useEffect(() => {
    const { platform, canEdit } = workspace;
    if (!platform || !signature) return;
    for (const row of rows) {
      if (!canEdit(row.id)) continue;
      for (const property of images) {
        for (const file of rowImages(row, property.id)) {
          homeFile(platform.files, platform.bootstrap.user.id, file, space, `image ${row.id} ${property.id}`, (copy) => settleFile(workspace, row.id, property.id, file.path, copy));
        }
      }
    }
    // `signature` and `space` name everything about the files that decides
    // what is copied.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, space]);
}

/** A picture, small, at its own shape: drawn from this session's bytes when
 *  it has them, else once they are read. `picture`, in a cell, is its place
 *  there — what a press on it opens full size. */
function Thumb({ file, className, picture }: { file: StoredFile; className: string; picture?: number }) {
  const { platform } = useWorkspace();
  const { url, failed } = useFileUrl(file, "page", {
    showFile: (shown, which) => (platform ? showFile(platform.files, shown, which) : notShown()),
  });
  return (
    <span
      className={`${className} ${failed ? "is-failed" : ""}`}
      data-picture={picture}
      title={failed ? `${file.name} could not be loaded` : undefined}
      style={file.width && file.height ? { aspectRatio: `${file.width} / ${file.height}` } : undefined}
    >
      {/* A picture whose bytes never came says so, rather than waiting as an
          empty box for ever. */}
      {url ? <img src={url} alt={file.name} draggable={false} /> : failed ? <ImageOff size={12} aria-hidden="true" /> : null}
    </span>
  );
}

function Thumbs({ files, limit }: { files: StoredFile[]; limit: number }) {
  return (
    <>
      {files.slice(0, limit).map((file) => <Thumb key={file.path} file={file} className="img-thumb" />)}
      {files.length > limit ? <span className="img-thumbs__more">+{files.length - limit}</span> : null}
    </>
  );
}

/** Room kept at a cut line's end for "+N" and the gap before it. */
const MORE_ROOM = 30;

/** A cell's pictures in a line — as many as its width shows whole, then how
 *  many more there are — as Notion's cell fills with thumbnails as its column
 *  widens. Each keeps its own shape, known before its bytes arrive, so the
 *  line is measured as it is laid out, against the cell's own width, and
 *  again whenever the cell is sized; the line then ends at its last whole
 *  picture, with the count straight after it. Where the line wraps (a row's
 *  page), every one shows. */
function FittedThumbs({ files }: { files: StoredFile[] }) {
  const strip = useRef<HTMLSpanElement | null>(null);
  const [hidden, setHidden] = useState(0);
  // The pictures and their shapes: all the line's measure depends on.
  const shapes = files.map((file) => `${file.path}:${file.width ?? ""}:${file.height ?? ""}`).join("|");
  useLayoutEffect(() => {
    const element = strip.current;
    const cell = element?.parentElement;
    if (!element || !cell) return;
    const measure = () => {
      element.style.maxWidth = "";
      const style = getComputedStyle(cell);
      const room = cell.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const left = element.getBoundingClientRect().left;
      const ends = [...element.children].map((child) => child.getBoundingClientRect().right - left);
      const all = ends.every((end) => end <= room + 0.5);
      const shown = all ? ends.length : ends.filter((end) => end <= room - MORE_ROOM + 0.5).length;
      [...element.children].forEach((child, index) => child.toggleAttribute("data-cut", index >= shown));
      if (!all) element.style.maxWidth = `${shown ? Math.ceil(ends[shown - 1]) : 0}px`;
      setHidden(ends.length - shown);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(cell);
    return () => observer.disconnect();
  }, [shapes]);
  // Each picture says its place, and "+N" the place of the first it counts.
  return (
    <>
      <span className="img-thumbs img-thumbs--fit" ref={strip}>
        {files.map((file, index) => <Thumb key={file.path} file={file} className="img-thumb" picture={index} />)}
      </span>
      {hidden ? <span className="img-thumbs__more" data-picture={files.length - hidden}>+{hidden}</span> : null}
    </>
  );
}

/** A row's pictures in a property, small — for a card or a list line. */
export function ImageStrip({ row, property, limit = 3 }: { row: NotePage; property: DatabaseProperty; limit?: number }) {
  const files = rowImages(row, property.id);
  if (!files.length) return null;
  return <span className="img-thumbs" aria-label={propertyName(property)}><Thumbs files={files} limit={limit} /></span>;
}

/** A gallery card's picture: the first of the row's pictures in the chosen
 *  property, filling the top of the card. */
export function CardImage({ row, property }: { row: NotePage; property: DatabaseProperty }) {
  const first = rowImages(row, property.id)[0];
  if (!first) {
    return (
      <span className="db-card__preview is-blank" aria-hidden="true">
        <span className="db-card__glyph"><ImageIcon size={22} strokeWidth={1.5} /></span>
      </span>
    );
  }
  return <Thumb file={first} className="db-card__image" />;
}

/** An Image property's cell — in a table row, and in a row's page: its
 *  pictures, small. A picture pressed opens full size (Notion's); a press
 *  anywhere else in the cell — or Enter on it — opens the list of them, to
 *  look at full size, put in order, add to or take from. Pictures dropped
 *  or pasted on it are added. Someone who may only read the row can look,
 *  not change. */
export function ImageProperty({
  row,
  property,
  readOnly,
}: {
  row: NotePage;
  property: DatabaseProperty;
  readOnly: boolean;
}) {
  const workspace = useWorkspace();
  const { platform, spaceOf } = workspace;
  const { toast } = useUi();
  const current = () => currentFiles(workspace, row.id, property.id);
  const write = (next: StoredFile[], record = true) => writeFiles(workspace, row.id, property.id, next, record);
  const files = rowImages(row, property.id);
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  // The picture open full size, by its place in the cell.
  const [viewing, setViewing] = useState<number | null>(null);
  const [dropping, setDropping] = useState(false);
  // A picture being dragged into another place in the list, and where it
  // would land: before the picture with this path, or last (null).
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [spot, setSpot] = useState<{ before: string | null } | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const name = propertyName(property);

  /* Drawn at once from the bytes in hand and saved behind them, a few at a
     time; a picture whose bytes cannot be saved is taken back out, and the
     reader told. As many as there is room for go in; the reader is told
     about the rest. */
  const add = async (picked: File[]) => {
    if (!platform || readOnly || !picked.length) return;
    const images = picked.filter((file) => isImageType(file.type));
    if (images.length < picked.length) toast(`${name} holds images only.`, "error");
    if (!images.length) return;
    const oversized = images.find((file) => file.size > MAX_FILE_BYTES);
    if (oversized) {
      toast(`${oversized.name || "That image"} is larger than 7.5 MB.`, "error");
      return;
    }
    const room = MAX_ROW_IMAGES - current().length;
    if (room <= 0) {
      toast(`A cell holds up to ${MAX_ROW_IMAGES} images.`, "error");
      return;
    }
    const pictures = images.slice(0, room);
    const place = { pageId: row.id, owner: platform.bootstrap.user.id, space: spaceOf(row.id) };
    let staged: StagedFile[];
    try {
      staged = await Promise.all(pictures.map((file) => stageFile(platform.files, file, place)));
    } catch {
      toast("Could not read that image", "error");
      return;
    }
    const next = [...current(), ...staged.map((item) => item.file)];
    if (!fitsRow(workspace.document?.state.pages[row.id], property.id, next)) {
      toast("This row cannot hold that many more pictures.", "error");
      return;
    }
    write(next);
    if (pictures.length < images.length) {
      toast(`Added ${pictures.length} of ${images.length} — a cell holds up to ${MAX_ROW_IMAGES} images.`, "info");
    }
    for (const item of staged) {
      queueUpload(() => item.transfer())
        .then((stored) => {
          if (stored.preview) settleFile(workspace, row.id, property.id, item.file.path, stored);
        })
        .catch(() => {
          toast(`${item.file.name} could not be uploaded`, "error");
          write(current().filter((file) => file.path !== item.file.path), false);
        });
    }
  };
  const addRef = useRef(add);
  useLayoutEffect(() => {
    addRef.current = add;
  });

  /* While the list is open, what is pasted is the cell's — Notion's "⌘V to
     paste an image". Words are not a picture, and the reader is told so. */
  const open = Boolean(anchor);
  useEffect(() => {
    if (!open || readOnly) return;
    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const pasted = pastedFiles(event.clipboardData);
      if (pasted.length) void addRef.current(pasted);
      else toast("Nothing to add — copy an image first.", "info");
    };
    document.addEventListener("paste", onPaste, true);
    return () => document.removeEventListener("paste", onPaste, true);
  }, [open, readOnly, toast]);

  /** Puts the picture with `path` before the one with `before` (null: last). */
  const moveTo = (path: string, before: string | null) => {
    const list = current();
    const moving = list.find((file) => file.path === path);
    if (!moving || path === before) return;
    const rest = list.filter((file) => file.path !== path);
    const at = before === null ? rest.length : rest.findIndex((file) => file.path === before);
    if (at < 0) return;
    const next = [...rest.slice(0, at), moving, ...rest.slice(at)];
    if (next.some((file, index) => file.path !== list[index].path)) write(next);
  };

  /** Alt+↑ / Alt+↓ on a picture in the list moves it a place, as its drag does. */
  const moveByKey = (event: ReactKeyboardEvent<HTMLElement>, path: string) => {
    if (readOnly || !event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    const list = current();
    const index = list.findIndex((file) => file.path === path);
    if (index < 0) return;
    if (event.key === "ArrowUp" && index > 0) moveTo(path, list[index - 1].path);
    if (event.key === "ArrowDown" && index < list.length - 1) moveTo(path, list[index + 2]?.path ?? null);
  };

  const endDrag = () => {
    setDragPath(null);
    setSpot(null);
  };

  const drop = readOnly ? {} : {
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDropping(true);
    },
    onDragLeave: () => setDropping(false),
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.files.length) return;
      event.preventDefault();
      event.stopPropagation();
      setDropping(false);
      void add([...event.dataTransfer.files]);
    },
  };

  const shown = viewing === null ? undefined : files[Math.min(viewing, files.length - 1)];

  return (
    <>
      <button
        type="button"
        className={`db__images ${files.length ? "" : "is-empty"} ${dropping ? "is-drop" : ""} ${anchor ? "is-open" : ""}`}
        aria-label={name}
        aria-haspopup="dialog"
        onClick={(event) => {
          // Winston, round 64, with Notion's cell: "when I press the image,
          // it will pop up a new window showing the images; only when I
          // press the empty part in this field, it will show the window so I
          // can add more images". A key's press lands on the cell itself.
          const picture = (event.target as Element).closest<HTMLElement>("[data-picture]");
          if (!picture || !event.currentTarget.contains(picture)) {
            setAnchor(rectOf(event.currentTarget));
            return;
          }
          // The cell lets go of the keyboard the press gave it: Space, Enter
          // or ⌘V would otherwise reach it behind the picture.
          event.currentTarget.blur();
          setViewing(Number(picture.dataset.picture));
        }}
        onPaste={(event) => {
          // The cell holding the keyboard takes a pasted picture, as its list does.
          const pasted = readOnly ? [] : pastedFiles(event.clipboardData);
          if (!pasted.length) return;
          event.preventDefault();
          void add(pasted);
        }}
        {...drop}
      >
        {files.length ? <FittedThumbs files={files} /> : null}
      </button>
      {readOnly ? null : (
        <input
          ref={input}
          type="file"
          accept="image/*"
          multiple
          hidden
          aria-label={`Add images to ${name}`}
          onChange={(event) => {
            const picked = [...(event.currentTarget.files ?? [])];
            event.currentTarget.value = "";
            void add(picked);
          }}
        />
      )}
      <Popover open={open} anchor={anchor} placement="bottom-start" role="dialog" label={name} onDismiss={() => setAnchor(null)}>
        <div className={`img-prop ${dropping ? "is-drop" : ""}`} {...drop}>
          {files.length ? (
            <ul
              className="img-prop__list"
              aria-label={`${files.length} image${files.length === 1 ? "" : "s"}`}
              onDragOver={(event) => { if (dragPath) event.preventDefault(); }}
              onDrop={(event) => {
                if (!dragPath) return;
                event.preventDefault();
                if (spot) moveTo(dragPath, spot.before);
                endDrag();
              }}
            >
              {files.map((file, index) => {
                const next = files[index + 1]?.path ?? null;
                const before = spot?.before === file.path;
                const after = spot !== null && spot.before === null && index === files.length - 1;
                return (
                  <li
                    key={file.path}
                    className={`img-prop__item ${dragPath === file.path ? "is-dragging" : ""} ${before ? "is-drop-before" : ""} ${after ? "is-drop-after" : ""}`}
                    draggable={!readOnly && files.length > 1}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/x-notes-picture", file.path);
                      setDragPath(file.path);
                    }}
                    onDragEnd={endDrag}
                    onDragOver={(event) => {
                      if (!dragPath) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      const box = event.currentTarget.getBoundingClientRect();
                      const target = event.clientY < box.top + box.height / 2 ? file.path : next;
                      // Just before or after itself, the picture would not move at all.
                      const from = files.findIndex((item) => item.path === dragPath);
                      const stays = target === dragPath || target === (files[from + 1]?.path ?? null);
                      setSpot((was) => (stays ? null : was?.before === target ? was : { before: target }));
                    }}
                  >
                    {readOnly || files.length < 2 ? null : (
                      <span className="img-prop__grip" aria-hidden="true"><GripVertical size={14} /></span>
                    )}
                    <button
                      type="button"
                      className="img-prop__open"
                      title="View full size"
                      aria-keyshortcuts={readOnly ? undefined : "Alt+ArrowUp Alt+ArrowDown"}
                      onKeyDown={(event) => moveByKey(event, file.path)}
                      onClick={() => {
                        setAnchor(null);
                        setViewing(index);
                      }}
                    >
                      <Thumb file={file} className="img-prop__thumb" />
                      <span className="img-prop__copy">
                        <span className="img-prop__name">{file.name}</span>
                        <span className="img-prop__size">{formatFileSize(file.size)}</span>
                      </span>
                    </button>
                    {readOnly ? null : (
                      <button
                        type="button"
                        className="icon-btn icon-btn--sm"
                        aria-label={`Remove ${file.name}`}
                        onClick={() => write(current().filter((item) => item.path !== file.path))}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : readOnly ? (
            <p className="img-prop__empty">No images</p>
          ) : null}
          {readOnly ? null : (
            <div className={`img-prop__upload ${files.length ? "" : "is-first"}`}>
              {files.length ? (
                <button type="button" className="img-prop__add" onClick={() => input.current?.click()}>
                  <Plus size={15} />Add images
                </button>
              ) : (
                <button type="button" className="btn btn--primary img-prop__upload-button" onClick={() => input.current?.click()}>
                  Upload images
                </button>
              )}
            </div>
          )}
        </div>
      </Popover>
      {shown && viewing !== null ? (
        <ImageViewer
          file={shown}
          actions={{ showFile: (file, which) => (platform ? showFile(platform.files, file, which) : notShown()) }}
          browse={{
            index: Math.min(viewing, files.length - 1),
            count: files.length,
            onStep: (delta) => setViewing((at) => (at === null ? at : Math.max(0, Math.min(files.length - 1, at + delta)))),
          }}
          onDownload={() => {
            if (platform) void downloadFile(platform.files, shown).catch(() => toast("Could not download that file", "error"));
          }}
          onClose={() => setViewing(null)}
        />
      ) : null}
    </>
  );
}
