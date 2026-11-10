import { useEffect, useRef, type RefObject } from "react";
import { MENTION_CHAR, mentionFromAttributes } from "../../core/inline-content";
import type { Mention, StoredFile } from "../../core/types";
import type { ShownFile } from "./file-store";
import { landingAt, type Spot } from "./drop-spot";
import { carry } from "./carry";
import type { UploadState } from "./MediaBlocks";

/* Pictures among the words (a Mention of kind "image"). The text holds one
   invisible character for each, drawn as a token as wide as the picture is
   set; its bytes are painted in behind it here, outside React, since a
   block's words are its editable's own HTML. Each token holds its bytes on
   screen while it is drawn, and lets go once it is gone. */

type Picture = Extract<Mention, { kind: "image" }>;

const TOKEN = '.mention[data-mention="image"]';
/** What a press carries: a picture, or a link to a page — a sub-page's own
 *  line is nothing but one, and its mark at the start of the line carries
 *  it too. */
const CARRIED = '.mention:is([data-mention="image"], [data-mention="page"])';
const LINE_MARK = ".is-link-line .block__page-toggle";
/** How near its left or right edge a press on a picture sizes it: the room
 *  its side bar stands in. */
const EDGE = 12;
const LEAST = 32;

function pictureOf(token: HTMLElement): Picture | null {
  const mention = mentionFromAttributes((name) => token.getAttribute(`data-${name}`) ?? undefined);
  return mention?.kind === "image" ? mention : null;
}

/** The side of a picture a point is on — where its bars stand, the handles
 *  that size it, as Notion's and a card's do — or null. A picture too narrow
 *  to keep a middle to carry it by between its two has none. */
function edgeAt(token: HTMLElement, x: number): "left" | "right" | null {
  const box = token.getBoundingClientRect();
  if (box.width < EDGE * 4) return null;
  if (x < box.left + EDGE) return "left";
  if (x > box.right - EDGE) return "right";
  return null;
}

export function usePictures({ root, readOnly, uploads, show, resize, move, hover }: {
  root: RefObject<HTMLElement | null>;
  readOnly: boolean;
  /** Pictures on their way up, by their file's path. */
  uploads: Readonly<Record<string, UploadState>>;
  show(file: StoredFile): ShownFile;
  /** A picture let go at a new width: the editor writes it. */
  resize(token: HTMLElement, picture: Picture, width: number): void;
  /** A picture, or a link, carried to where it lands: the editor moves it. */
  move(token: HTMLElement, mention: Mention, to: Spot): void;
  /** The picture the pointer is on, or null once it has left it: the
   *  editor shows its tools. */
  hover(token: HTMLElement | null): void;
}) {
  const context = useRef({ show, resize, move, hover, readOnly, uploads });
  const repaint = useRef<() => void>(() => {});
  useEffect(() => {
    context.current = { show, resize, move, hover, readOnly, uploads };
  });
  // An upload's state is drawn on its picture: faded on its way, marked
  // when it failed (a click tries it again).
  useEffect(() => repaint.current(), [uploads]);

  /* Paints every picture drawn under `root` — whenever the words are drawn
     again, which replaces the tokens — and lets go of the ones gone. */
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const shown = new Map<HTMLElement, { path: string; view: ShownFile }>();
    const paint = () => {
      for (const [token, held] of shown) {
        if (token.isConnected && token.closest(TOKEN) === token && pictureOf(token)?.file.path === held.path) continue;
        held.view.release();
        shown.delete(token);
      }
      for (const token of element.querySelectorAll<HTMLElement>(TOKEN)) {
        // A page shown in place has an editor of its own, which paints it.
        if (token.closest(".blocks") !== element) continue;
        // Alone on its line, it stands where the line's words would start.
        const words = token.closest(".block__editable")?.textContent?.replace(MENTION_CHAR, "").trim();
        if (words) delete token.dataset.alone;
        else token.dataset.alone = "";
        const upload = context.current.uploads[pictureOf(token)?.file.path ?? ""];
        if (upload) token.dataset.upload = upload;
        else if (token.dataset.upload) delete token.dataset.upload;
        if (shown.has(token)) continue;
        const picture = pictureOf(token);
        if (!picture) continue;
        const view = context.current.show(picture.file);
        shown.set(token, { path: picture.file.path, view });
        view.ready
          .then((url) => { token.style.backgroundImage = `url("${url}")`; })
          .catch(() => { token.dataset.state = "missing"; });
      }
    };
    paint();
    repaint.current = paint;
    const observer = new MutationObserver(paint);
    observer.observe(element, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      for (const held of shown.values()) held.view.release();
    };
  }, [root]);

  /* Its sides size it, from the bar under the pointer inside each edge, as
     Notion's picture and a card here are (Winston: the corner "is not
     intuitive"): drawn as the pointer moves, its shape kept, written once
     when it is let go. Centred on its line, it grows about its middle, as a
     card does; anywhere else, from the side held. */
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const over = (event: PointerEvent) => {
      const token = (event.target as Element | null)?.closest<HTMLElement>(TOKEN);
      if (token && token.closest(".blocks") === element) context.current.hover(token);
    };
    const out = (event: PointerEvent) => {
      const from = (event.target as Element | null)?.closest<HTMLElement>(TOKEN);
      const to = (event.relatedTarget as Element | null)?.closest?.(TOKEN);
      if (from && !to) {
        context.current.hover(null);
        if (!from.classList.contains("is-resizing")) sizing(from, null);
      }
    };
    /* The bar under the pointer answers it — and says which: the picture
       wears `is-sizing` (the arrow) and `is-sizing-left` or `-right` (that
       bar, lit). */
    const sizing = (token: HTMLElement, side: "left" | "right" | null) => {
      token.classList.toggle("is-sizing", side !== null);
      token.classList.toggle("is-sizing-left", side === "left");
      token.classList.toggle("is-sizing-right", side === "right");
    };
    const hover = (event: PointerEvent) => {
      const token = (event.target as Element | null)?.closest<HTMLElement>(TOKEN);
      if (!token || token.classList.contains("is-resizing")) return;
      sizing(token, context.current.readOnly ? null : edgeAt(token, event.clientX));
    };
    const pressed = (event: MouseEvent): HTMLElement | null => {
      const target = event.target as Element | null;
      const mark = target?.closest(LINE_MARK);
      const token = mark
        ? mark.closest(".block")?.querySelector<HTMLElement>(`:scope > .block__content ${CARRIED}`)
        : target?.closest<HTMLElement>(CARRIED);
      return token && token.closest(".blocks") === element && event.button === 0 && !context.current.readOnly ? token : null;
    };
    // A press on a picture or a link neither takes the caret nor starts a
    // selection.
    const hold = (event: MouseEvent) => { if (pressed(event)) event.preventDefault(); };
    const press = (event: PointerEvent) => {
      const token = pressed(event);
      if (!token) return;
      const side = token.matches(TOKEN) ? edgeAt(token, event.clientX) : null;
      if (!side) {
        carryFrom(token, event);
        return;
      }
      const picture = pictureOf(token);
      const column = token.closest<HTMLElement>(".block__editable");
      if (!picture || !column) return;
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = token.getBoundingClientRect().width;
      const widest = column.getBoundingClientRect().width;
      // Each side moves by what is dragged: both, about the middle, when the
      // line centres it.
      const pull = (getComputedStyle(column).textAlign === "center" ? 2 : 1) * (side === "right" ? 1 : -1);
      let next = startWidth;
      token.classList.add("is-resizing");
      sizing(token, side);
      const move = (moving: PointerEvent) => {
        next = Math.round(Math.min(widest, Math.max(LEAST, startWidth + pull * (moving.clientX - startX))));
        token.style.width = `${next}px`;
      };
      const finish = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        token.classList.remove("is-resizing");
        sizing(token, null);
        if (Math.abs(next - startWidth) >= 1) context.current.resize(token, picture, next);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    };
    /* Anywhere else, a press that moves carries the picture — or the link to
       a page — (carry.ts): it waits faded where it is, a small copy of it is
       held where it was picked up, and a cursor marks where it would land. A
       press that does not move is a click, which opens it. */
    const carryFrom = (token: HTMLElement, start: PointerEvent) => {
      const mention = mentionFromAttributes((name) => token.getAttribute(`data-${name}`) ?? undefined);
      if (!mention) return;
      // Neither the editor's selection nor its block moves start from it.
      start.stopPropagation();
      const moving = (event: PointerEvent) => {
        if (Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < 4) return;
        stop();
        context.current.hover(null);
        const box = token.getBoundingClientRect();
        carry({
          root: element,
          grab: { x: start.clientX, y: start.clientY },
          // A sub-page's line waits faded whole: its mark with its name.
          carried: [token, ...(token.closest(".is-link-line")?.querySelectorAll<HTMLElement>(".block__page-mark") ?? [])],
          width: Math.min(mention.kind === "image" ? 160 : 280, box.width),
          draw: (copy) => {
            if (mention.kind === "image") {
              copy.classList.add("carry-copy--picture");
              copy.style.backgroundImage = token.style.backgroundImage;
              copy.style.aspectRatio = `${box.width} / ${box.height}`;
              return;
            }
            // A link is carried as it reads: its mark and its name.
            copy.classList.add("carry-copy--link");
            copy.append(token.cloneNode(true));
          },
          spotAt: (x, y) => landingAt(element, x, y, true),
          land: (spot) => context.current.move(token, mention, spot),
        }, event);
      };
      const stop = () => {
        window.removeEventListener("pointermove", moving);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
      };
      window.addEventListener("pointermove", moving);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    };
    element.addEventListener("pointermove", hover);
    element.addEventListener("pointerover", over);
    element.addEventListener("pointerout", out);
    // Before the editor's own presses: a side bar is never the start of a
    // selection.
    element.addEventListener("pointerdown", press, true);
    element.addEventListener("mousedown", hold, true);
    return () => {
      element.removeEventListener("pointermove", hover);
      element.removeEventListener("pointerover", over);
      element.removeEventListener("pointerout", out);
      element.removeEventListener("pointerdown", press, true);
      element.removeEventListener("mousedown", hold, true);
    };
  }, [root]);
}
