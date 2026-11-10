import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { colorOf } from "../../components/Avatar";
import { personName } from "../../components/ProfileAvatar";
import { useActivity, useWorkspace } from "../../app/workspace-context";
import { pointRect, rangeRects } from "./selection";

interface Drawn {
  userId: string;
  name: string;
  caret: { left: number; top: number; height: number };
  /** What they select, in the blocks' own coordinates. */
  highlights: { left: number; top: number; width: number; height: number }[];
}

/**
 * Where the others on this page have their caret, and what they select, drawn
 * over the editor's own blocks (`root`) in each one's colour, with their name
 * at the caret. A place is read from their presence (workspace-context says
 * this window's); a block that is not drawn here (folded away, or shown in
 * place in another page's editor) draws nothing. It is drawn again as the
 * blocks change under it, as they are laid out again and as presence moves.
 */
export function RemoteCarets({ root }: { root: RefObject<HTMLDivElement | null> }) {
  const { platform, rosters } = useWorkspace();
  const { presence } = useActivity();
  const [drawn, setDrawn] = useState<Drawn[]>([]);
  const layer = useRef<HTMLDivElement | null>(null);
  const me = platform?.bootstrap.user.id;

  useLayoutEffect(() => {
    const blocks = root.current;
    if (!blocks) return;
    const nameOf = (userId: string) => {
      const member = Object.values(rosters).flatMap((space) => space.members).find((one) => one.id === userId);
      return member ? personName(member) : "Someone";
    };
    const draw = () => {
      const origin = blocks.getBoundingClientRect();
      const at = (rect: DOMRect) => ({ left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width, height: rect.height });
      const next: Drawn[] = [];
      for (const item of presence) {
        const selection = item.state?.selection;
        if (!item.online || item.userId === me || !selection) continue;
        const caret = pointRect(blocks, selection.focus);
        if (!caret) continue;
        next.push({
          userId: item.userId,
          name: nameOf(item.userId),
          caret: { left: caret.left - origin.left, top: caret.top - origin.top, height: caret.height || 18 },
          highlights: rangeRects(blocks, selection.anchor, selection.focus).filter((rect) => rect.width > 0).map(at),
        });
      }
      setDrawn((last) => (JSON.stringify(last) === JSON.stringify(next) ? last : next));
    };
    draw();
    // Typing here or there moves the text under a caret: drawn again once a
    // frame, for what changed in the blocks and not in this layer.
    let frame = 0;
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        draw();
      });
    };
    const changes = new MutationObserver((records) => {
      if (records.some((record) => !layer.current?.contains(record.target))) soon();
    });
    changes.observe(blocks, { subtree: true, childList: true, characterData: true });
    const sizes = new ResizeObserver(soon);
    sizes.observe(blocks);
    return () => {
      changes.disconnect();
      sizes.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [root, presence, rosters, me]);

  if (!drawn.length) return null;
  return (
    <div ref={layer} className="remote-carets" aria-hidden="true">
      {drawn.map((one) => {
        const style = { "--caret-color": colorOf(one.name) } as CSSProperties;
        return (
          <div key={one.userId} style={style}>
            {one.highlights.map((rect, index) => (
              <div key={index} className="remote-selection" style={rect} />
            ))}
            <div className="remote-caret" style={one.caret}>
              <span className="remote-caret__name">{one.name}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
