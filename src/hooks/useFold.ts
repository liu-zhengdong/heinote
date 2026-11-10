import { useSyncExternalStore } from "react";

/** The width at or below which the page list folds to a rail.
 *
 *  This number also lives in `src/styles/index.css` as `--fold`, and the two
 *  have to agree. It is duplicated rather than read out of the computed style
 *  because below it the rail draws *different controls*, not smaller ones —
 *  React has to know, and a layout that asks the document for its own
 *  breakpoint on every render is a reflow per keystroke.
 *
 *  216px of list + 344px of page is the last split where the page is still a
 *  page. Below that the list becomes 46px of marks and gets out of the way. */
export const FOLD = 560;

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(`(max-width: ${FOLD - 0.02}px)`);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function isFolded(): boolean {
  return window.matchMedia(`(max-width: ${FOLD - 0.02}px)`).matches;
}

/** True while the window is too narrow to hold the list and the page at once.
 *
 *  An app is handed its window's content box as its viewport, so this is the
 *  WINDOW's width, not the screen's: on a desk where every window opens at
 *  640×460 and can be pulled to 400×300, folded is an ordinary state and not
 *  a phone. */
export function useFold(): boolean {
  return useSyncExternalStore(subscribe, isFolded, () => false);
}
