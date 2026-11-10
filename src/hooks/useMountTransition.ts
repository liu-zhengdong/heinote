import { useEffect, useState } from "react";

/** Keeps an overlay mounted for the length of its exit transition.
 *
 * `mounted` controls presence in the tree; `shown` controls the class that
 * drives the transition. `shown` is only raised after the element has been
 * painted once in its closed state, otherwise the browser has nothing to
 * transition from and the panel simply appears. */
export function useMountTransition(open: boolean, exitMs: number): {
  mounted: boolean;
  shown: boolean;
} {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    setShown(false);
    const timer = window.setTimeout(() => setMounted(false), exitMs);
    return () => window.clearTimeout(timer);
  }, [exitMs, open]);

  return { mounted, shown };
}
