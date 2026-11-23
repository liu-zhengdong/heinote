/** A database table's sideways edges, where CSS cannot see the scroll.
 *  index.css draws the telltales that say a table goes on past its right
 *  edge — a fading mask on that edge while columns are still hidden behind
 *  it, and a hairline on the pinned name column once columns have gone
 *  under it — from `animation-timeline: scroll()`. Browsers without
 *  scroll-driven animations get the same values from here instead: this is
 *  the ref a `.db__table-wrap` keeps, and it rewrites the same two custom
 *  properties on its scroll position and on the widths of the wrap and the
 *  table inside it. In a browser that supports scroll(), it does nothing
 *  and the keyframes do all the work. */
export function tableEdges(wrap: HTMLElement | null): (() => void) | undefined {
  if (!wrap) return undefined;
  if (typeof CSS !== "undefined" && CSS.supports("animation-timeline", "scroll()")) return undefined;
  let lastFade = "";
  let lastEdge = "";
  const update = () => {
    /* The two ranges the keyframes map over: the fade closes across the
       last 48px before the end, the name edge opens across the first 16px.
       scrollLeft can overshoot below zero while the scroll settles. */
    const left = Math.max(0, wrap.scrollLeft);
    const remaining = Math.max(0, wrap.scrollWidth - left - wrap.clientWidth);
    const fade = `${Math.min(48, remaining)}px`;
    const edge = `color-mix(in srgb, var(--hairline-strong) ${Math.min(100, Math.round(left / 16 * 100))}%, transparent)`;
    if (fade !== lastFade) wrap.style.setProperty("--table-fade", (lastFade = fade));
    if (edge !== lastEdge) wrap.style.setProperty("--name-edge", (lastEdge = edge));
  };
  const observer = new ResizeObserver(update);
  observer.observe(wrap);
  const table = wrap.firstElementChild;
  if (table) observer.observe(table);
  wrap.addEventListener("scroll", update);
  update();
  return () => {
    observer.disconnect();
    wrap.removeEventListener("scroll", update);
  };
}
