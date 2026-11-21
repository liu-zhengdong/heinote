import { useEffect, useState } from "react";

const KEYBOARD_THRESHOLD_PX = 100;

function readKeyboardInset(): number {
  const vv = window.visualViewport;
  if (!vv) return 0;
  return Math.max(0, Math.round(window.innerHeight - (vv.height + vv.offsetTop)));
}

/** Tracks soft-keyboard inset via `window.visualViewport` and keeps `--vv-keyboard`
 *  updated on the root element so fixed mobile editing bars clear the keyboard. */
export function useVisualViewport(enabled: boolean): { keyboardInset: number; keyboardOpen: boolean } {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const root = document.documentElement;
    if (!enabled) {
      setInset(0);
      root.style.removeProperty("--vv-keyboard");
      return;
    }
    const update = () => {
      const next = readKeyboardInset();
      setInset(next);
      root.style.setProperty("--vv-keyboard", `${next}px`);
    };
    update();
    const vv = window.visualViewport;
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      root.style.removeProperty("--vv-keyboard");
    };
  }, [enabled]);

  return {
    keyboardInset: inset,
    keyboardOpen: inset > KEYBOARD_THRESHOLD_PX,
  };
}
