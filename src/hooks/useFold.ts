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

/** True while the viewport is narrower than 560px: uses the mobile shell
 *  (borderless top bar, floating bottom MobileDock, and BottomSheet overlays)
 *  instead of the desktop sidebar or 46px desktop rail. */
export function useFold(): boolean {
  return useSyncExternalStore(subscribe, isFolded, () => false);
}
