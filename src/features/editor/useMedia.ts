import { useCallback, useEffect, useRef, useState } from "react";
import { BLOCK_ORDER_STEP, createBlock, orderedBlocks } from "../../core/block-tree";
import { normalizeStoredFile } from "../../core/files";
import { inlinePlainText, insertToken, MENTION_CHAR } from "../../core/inline-content";
import { updateBlockContent } from "./editor-commands";
import { createId } from "../../core/ids";
import type { Block, BlockKind, BlockMutation, StoredFile } from "../../core/types";
import { composeTree } from "./composite";
import { homeFile, isImageType, refuseFiles, stageFile, type StagedFile } from "./file-store";
import type { UploadState } from "./MediaBlocks";
import { spaceOfPage } from "../../core/page-tree";
import type { Editor } from "./editor-state";

/** Where files land: among a line's words, in place of `start` to `end`; or
 *  lines of their own, before or after a line, or in place of an empty one
 *  ("fill"). */
export type Landing =
  | { kind: "words"; blockId: string; start: number; end: number }
  | { kind: "line"; blockId: string; edge: "before" | "after" | "fill"; inside?: boolean };

/** Images and files in a page: dropped, pasted or picked in, drawn at once
 *  from the bytes in hand and saved behind them — each upload's state, a
 *  retry for one that failed, the picture being looked at — and files the
 *  page's readers cannot reach moved to where they can. */
export function useMedia(editor: Editor) {
  const {
    page, pages, pagesRef, tree, readOnly, platform, workspace, showInPlace, ownerOf, write, execute, selectBlocks,
    toast,
  } = editor;
  const [uploads, setUploads] = useState<Record<string, UploadState>>({});
  /** Pictures on their way up, by their file's path. */
  const [pictureUploads, setPictureUploads] = useState<Record<string, UploadState>>({});
  const retries = useRef(new Map<string, () => void>());
  const [viewing, setViewing] = useState<StoredFile | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const pickTarget = useRef<string | null>(null);

  /* ── Images and files ───────────────────────────────────────────────── */

  /** The body as it is this moment: after an await, the `tree` of the render
   *  that started it may be behind. */
  const latestTree = useCallback(() => {
    const live = workspace?.state.pages;
    return live ? composeTree(live, live[page.id] ?? page, showInPlace).tree : tree;
  }, [page, showInPlace, tree, workspace]);

  /** Swaps in a block's file as stored — its page copy made, or its bytes
   *  moved to a shared space — unless the block has moved on: deleted,
   *  undone, given another file. Bookkeeping, so it is not a step of undo. */
  const settleFile = useCallback((blockId: string, path: string, stored: StoredFile) => {
    const block = latestTree().by_id[blockId];
    if (!block || normalizeStoredFile(block.file)?.path !== path) return;
    write({ mutations: [{ action: "put", block: { ...block, file: stored } }] }, { record: false });
  }, [latestTree, write]);

  const upload = useCallback((blockId: string, staged: StagedFile) => {
    const run = () => {
      setUploads((current) => ({ ...current, [blockId]: "uploading" }));
      staged.transfer()
        .then((stored) => {
          retries.current.delete(blockId);
          setUploads(({ [blockId]: _done, ...rest }) => rest);
          if (stored.preview) settleFile(blockId, staged.file.path, stored);
        })
        .catch(() => {
          retries.current.set(blockId, run);
          setUploads((current) => ({ ...current, [blockId]: "failed" }));
        });
    };
    run();
  }, [settleFile]);

  /** A picture's file as stored — its page copy made, or its bytes moved to
   *  a shared space — in every line that holds it. Bookkeeping, so it is not
   *  a step of undo. */
  const settlePicture = useCallback((path: string, stored: StoredFile) => {
    const current = latestTree();
    for (const block of Object.values(current.by_id)) {
      if (!block.content.some((run) => run.mention?.kind === "image" && run.mention.file.path === path)) continue;
      const settled = block.content.map((run) => (
        run.mention?.kind === "image" && run.mention.file.path === path ? { ...run, mention: { ...run.mention, file: stored } } : run
      ));
      const change = updateBlockContent(current, block.id, settled);
      if (change) write(change, { record: false });
    }
  }, [latestTree, write]);

  /** A picture's bytes written behind it; one that fails waits, drawn from
   *  the bytes in hand, to be tried again (a click on it). */
  const sendPicture = useCallback((staged: StagedFile) => {
    const { path } = staged.file;
    const run = () => {
      setPictureUploads((current) => ({ ...current, [path]: "uploading" }));
      staged.transfer()
        .then((stored) => {
          retries.current.delete(path);
          setPictureUploads(({ [path]: _done, ...rest }) => rest);
          if (stored.preview) settlePicture(path, stored);
        })
        .catch(() => {
          retries.current.set(path, run);
          setPictureUploads((current) => ({ ...current, [path]: "failed" }));
        });
    };
    run();
  }, [settlePicture]);

  /** Files into the page, where they were put: pictures among a line's words
   *  stand in them; anywhere else — beside a line, in place of an empty one —
   *  each is a line of its own, a picture's a line holding nothing but it.
   *  Every one is drawn at once from the bytes in hand and saved behind it. */
  const placeFiles = useCallback(async (files: File[], landing: Landing) => {
    if (!platform || readOnly || !files.length) return;
    const refusal = refuseFiles(files);
    if (refusal) {
      toast(refusal, "error");
      return;
    }
    // Stored with the page holding the line — a block may be shared apart.
    const holder = ownerOf(landing.blockId);
    const place = { pageId: holder, owner: platform.bootstrap.user.id, space: spaceOfPage(pagesRef.current, holder) };
    let staged: StagedFile[];
    try {
      staged = await Promise.all(files.map((file) => stageFile(platform.files, file, place)));
    } catch {
      toast("Could not read that file", "error");
      return;
    }
    const current = latestTree();
    const anchor = current.by_id[landing.blockId];
    if (!anchor) return;
    const picture = (item: StagedFile) => isImageType(item.file.type);

    if (landing.kind === "words" && staged.every(picture)) {
      const length = inlinePlainText(anchor.content).length;
      let content = anchor.content;
      let caret = Math.min(landing.start, length);
      let to = Math.min(Math.max(landing.end, caret), length);
      for (const item of staged) {
        const placed = insertToken(content, caret, to, { kind: "image", file: item.file });
        content = placed.content;
        caret = placed.caret;
        to = caret;
      }
      execute(updateBlockContent(current, anchor.id, content), { id: anchor.id, start: caret, force: true });
      for (const item of staged) sendPicture(item);
      return;
    }

    // A file among words stands on a line of its own after them — or in
    // place of a line with none.
    const edge = landing.kind === "line" ? landing.edge : inlinePlainText(anchor.content) ? "after" : "fill";
    const lineOf = (item: StagedFile): Partial<Block> & { kind: BlockKind } => (picture(item)
      ? { kind: "text", content: [{ text: MENTION_CHAR, mention: { kind: "image", file: item.file } }] }
      : { kind: "file", file: item.file, content: [] });
    const mutations: BlockMutation[] = [];
    const placed: Array<{ id: string; staged: StagedFile }> = [];
    let rest = staged;
    if (edge === "fill") {
      const [first, ...others] = staged;
      const made = lineOf(first);
      mutations.push({
        action: "put",
        block: {
          ...anchor,
          ...made,
          // An empty list item keeps its kind and holds the picture.
          kind: made.kind === "text" && anchor.kind !== "file" ? anchor.kind : made.kind,
          ...(made.kind === "file" ? {} : { file: undefined }),
          checked: anchor.kind === "todo" ? anchor.checked : undefined,
          language: undefined,
          width: undefined,
        },
      });
      placed.push({ id: anchor.id, staged: first });
      rest = others;
    }
    if (rest.length) {
      // Under a list item, they are its first lines.
      const inside = landing.kind === "line" && landing.inside;
      const parent = inside ? anchor.id : anchor.parent_id;
      const siblings = orderedBlocks(current, parent);
      const index = siblings.findIndex((item) => item.id === anchor.id);
      const before = inside ? undefined : edge === "before" ? siblings[index - 1] : anchor;
      const after = inside ? siblings[0] : edge === "before" ? anchor : siblings[index + 1];
      const span = BLOCK_ORDER_STEP * (rest.length + 1);
      const low = before?.order ?? (after ? after.order - span : 0);
      const step = ((after?.order ?? low + span) - low) / (rest.length + 1);
      rest.forEach((item, offset) => {
        const id = createId("block");
        const { kind, ...fields } = lineOf(item);
        mutations.push({ action: "put", block: createBlock(id, kind, { ...fields, parent_id: parent, order: low + step * (offset + 1) }) });
        placed.push({ id, staged: item });
      });
    }
    execute({ mutations });
    const first = placed[0]?.id;
    const last = placed.at(-1)?.id;
    if (first && last) selectBlocks(first, last);
    for (const item of placed) {
      if (picture(item.staged)) sendPicture(item.staged);
      else upload(item.id, item.staged);
    }
  }, [execute, latestTree, ownerOf, pagesRef, platform, readOnly, selectBlocks, sendPicture, toast, upload]);

  /** Opens the file picker for a file block: to fill it, or to replace what
   *  it holds. */
  const pickFile = useCallback((block: Block) => {
    const input = fileInput.current;
    if (!input || readOnly) return;
    pickTarget.current = block.id;
    input.accept = "";
    input.multiple = !block.file;
    input.click();
  }, [readOnly]);

  /* A page shared after its pictures went in — or a block pasted in from
     another page — can hold files its readers cannot reach: written to the
     writer's own store, or another space's. Whoever can read them copies them
     to where this page's readers can, once. */
  useEffect(() => {
    if (readOnly || !platform) return;
    for (const block of Object.values(tree.by_id)) {
      const space = spaceOfPage(pages, ownerOf(block.id));
      for (const run of block.content) {
        if (run.mention?.kind !== "image" || pictureUploads[run.mention.file.path]) continue;
        const { path } = run.mention.file;
        homeFile(platform.files, platform.bootstrap.user.id, run.mention.file, space, `picture ${block.id} ${path}`, (copy) => settlePicture(path, copy));
      }
      const file = normalizeStoredFile(block.file);
      if (block.kind !== "file" || uploads[block.id] || !file) continue;
      homeFile(platform.files, platform.bootstrap.user.id, file, space, `block ${block.id}`, (copy) => settleFile(block.id, file.path, copy));
    }
  }, [ownerOf, pages, pictureUploads, platform, readOnly, settleFile, settlePicture, tree, uploads]);

  /* Files dragged in from the desktop must never be opened by the browser in
     place of the app when they miss a block. */
  useEffect(() => {
    const keep = (event: globalThis.DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    window.addEventListener("dragover", keep);
    window.addEventListener("drop", keep);
    return () => {
      window.removeEventListener("dragover", keep);
      window.removeEventListener("drop", keep);
    };
  }, []);

  return { uploads, pictureUploads, retries, viewing, setViewing, fileInput, pickTarget, placeFiles, pickFile };
}
