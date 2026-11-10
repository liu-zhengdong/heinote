import { hideMarker, markerRect, sameSpot, showMarker, type Spot } from "./drop-spot";

/* Carrying something across a page, as Google Docs carries a picture: what
   is carried stays where it is, faded, a small copy of it is held where it
   was picked up, and where it would land is marked by a cursor among the
   words or a line between lines, gliding from place to place
   (drop-spot.ts). Nothing on the page moves until it is let go: then the
   copy settles into the mark and it is there. Escape puts it back. One way
   to carry anything: a picture, a page's row, selected lines. */

export interface CarryOptions {
  /** The editor's own lines, which it lands among. */
  root: HTMLElement;
  /** Where it was picked up, to hold the copy by the same point. */
  grab: { x: number; y: number };
  /** What is carried, faded where it stands: a picture, or whole lines. */
  carried: HTMLElement[];
  /** Draws the copy, `width` wide, of what `carried[0]` shows. */
  draw(copy: HTMLElement): void;
  width: number;
  /** Where the pointer would put it, or nowhere. */
  spotAt(x: number, y: number): Spot | null;
  /** Puts it there. */
  land(spot: Spot): void;
}

/** How near the pane's top or bottom the page scrolls under the pointer. */
const EDGE = 48;
const SETTLE_MS = 140;

/** Starts carrying, the pointer already moving from `event`: it ends when
 *  the pointer is let go, or with Escape. */
export function carry(options: CarryOptions, event: PointerEvent | MouseEvent): void {
  const { root, grab } = options;
  const document = root.ownerDocument;
  const source = options.carried[0].getBoundingClientRect();
  // The copy is held by the point it was picked up at, in proportion.
  // Picked up beside it — by a line's mark — it is held by its nearest edge.
  const within = (at: number) => Math.min(1, Math.max(0, at));
  const ratio = { x: within((grab.x - source.left) / Math.max(1, source.width)), y: within((grab.y - source.top) / Math.max(1, source.height)) };
  const height = options.width * (source.height / Math.max(1, source.width));
  const copy = document.createElement("div");
  copy.className = "carry-copy";
  options.draw(copy);
  // It starts where the thing is, as big as it is, and shrinks into the hand.
  Object.assign(copy.style, { width: `${source.width}px`, transform: `translate(${source.left}px, ${source.top}px)` });
  document.body.append(copy);
  // An attribute, not a class: a line's class is React's to write.
  for (const element of options.carried) element.dataset.carried = "";
  window.getSelection()?.removeAllRanges();
  (document.activeElement as HTMLElement | null)?.blur?.();
  root.classList.add("is-carrying");

  let pointer = { x: event.clientX, y: event.clientY };
  let spot: Spot | null = null;
  let frame = 0;
  let ended = false;

  const place = () => {
    copy.style.transform = `translate(${pointer.x - ratio.x * options.width}px, ${pointer.y - ratio.y * height}px)`;
  };
  const aim = () => {
    const next = options.spotAt(pointer.x, pointer.y);
    if (sameSpot(next, spot)) return;
    spot = next;
    showMarker(root, spot);
  };
  const scroll = () => {
    const pane = root.closest<HTMLElement>(".scroller");
    if (pane && !ended) {
      const box = pane.getBoundingClientRect();
      const step = pointer.y < box.top + EDGE ? -14 : pointer.y > box.bottom - EDGE ? 14 : 0;
      if (step) {
        pane.scrollTop += step;
        // The page moved under the mark: it is drawn again where it now is.
        spot = null;
        aim();
      }
    }
    frame = requestAnimationFrame(scroll);
  };

  const move = (moving: PointerEvent) => {
    pointer = { x: moving.clientX, y: moving.clientY };
    place();
    aim();
  };
  // Words under the pointer are never selected on the way.
  const still = (moving: MouseEvent) => moving.preventDefault();
  const finish = (put: boolean) => {
    if (ended) return;
    ended = true;
    cancelAnimationFrame(frame);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("mousemove", still, true);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key, true);
    // Carried, it is not also clicked.
    const swallow = (click: MouseEvent) => {
      click.stopPropagation();
      click.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);

    // Put down, the copy settles into the mark; put back, it returns whole.
    const mark = put && spot ? markerRect(root) : null;
    copy.style.transition = `transform ${SETTLE_MS}ms ease-out, width ${SETTLE_MS}ms ease-out, opacity ${SETTLE_MS}ms ease-out`;
    if (mark) {
      copy.style.width = `${Math.min(options.width, 48)}px`;
      copy.style.transform = `translate(${mark.left}px, ${mark.top}px)`;
      copy.style.opacity = "0";
    } else {
      copy.style.width = `${source.width}px`;
      copy.style.transform = `translate(${source.left}px, ${source.top}px)`;
    }
    hideMarker(root);
    window.setTimeout(() => {
      root.classList.remove("is-carrying");
      const landing = mark ? spot : null;
      if (landing) options.land(landing);
      // What moved is drawn in its new place by the next frames; it stops
      // being faded with them.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        copy.remove();
        for (const element of options.carried) delete element.dataset.carried;
      }));
    }, SETTLE_MS);
  };
  const up = () => finish(true);
  const cancel = () => finish(false);
  const key = (pressed: KeyboardEvent) => {
    if (pressed.key !== "Escape") return;
    pressed.preventDefault();
    pressed.stopPropagation();
    finish(false);
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("mousemove", still, true);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key, true);
  requestAnimationFrame(() => {
    copy.style.transition = `width ${SETTLE_MS}ms ease-out`;
    copy.style.width = `${options.width}px`;
    place();
    if (!ended) aim();
  });
  frame = requestAnimationFrame(scroll);
}
