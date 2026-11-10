import { Copy, Globe } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Popover } from "../../components/Popover";
import { Tooltip } from "../../components/Tooltip";
import { embedFromUrl, embedVerb } from "../../core/embeds";
import type { Embed } from "../../core/types";
import type { AnchorRect } from "../../hooks/useAnchoredPosition";
import { isWebLink } from "../../core/inline-content";

/* Notion's link card: a web link in a page rested on shows where it goes —
   and lets it be copied, edited, or, for a YouTube video or a post on X,
   shown as its card. It comes after a moment on the link, stays while the
   pointer is on it or on the card, and goes a moment after both are left.
   A press being held (words being selected), a finger, or another popover
   open — the format bar over selected words, a menu: no card. */

export interface HoveredLink {
  href: string;
  /** The paragraph the link is in. */
  blockId: string;
  element: HTMLAnchorElement;
  anchor: AnchorRect;
}

const SHOW_AFTER_MS = 450;
const HIDE_AFTER_MS = 250;

/** The web link, in one editor's own paragraphs, rested on — and the
 *  pointer events that find it, for that editor's `.blocks`. */
export function useLinkHover() {
  const [hovered, setHovered] = useState<HoveredLink | null>(null);
  const showTimer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);
  const pending = useRef<HTMLAnchorElement | null>(null);
  const shown = useRef<HTMLAnchorElement | null>(null);
  shown.current = hovered?.element ?? null;

  const stopShowing = () => {
    window.clearTimeout(showTimer.current);
    pending.current = null;
  };
  const keep = useCallback(() => window.clearTimeout(hideTimer.current), []);
  const release = useCallback(() => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setHovered(null), HIDE_AFTER_MS);
  }, []);
  const close = useCallback(() => {
    stopShowing();
    window.clearTimeout(hideTimer.current);
    setHovered(null);
  }, []);
  useEffect(() => () => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
  }, []);

  const onPointerOver = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType !== "mouse" || event.buttons) return;
    const element = (event.target as Element | null)?.closest?.<HTMLAnchorElement>(".block__editable a[href]");
    // A page shown in this one has an editor of its own, and its own card.
    if (!element || element.closest(".blocks") !== event.currentTarget) return;
    const href = element.getAttribute("href") ?? "";
    if (!isWebLink(href)) return;
    window.clearTimeout(hideTimer.current);
    if (shown.current === element || pending.current === element) return;
    stopShowing();
    pending.current = element;
    const pointerY = event.clientY;
    showTimer.current = window.setTimeout(() => {
      pending.current = null;
      if (!element.isConnected || document.querySelector(".pop.is-shown")) return;
      const blockId = element.closest<HTMLElement>("[data-block-id]")?.dataset.blockId;
      if (!blockId) return;
      // Under the line of the link the pointer is on — a link can wrap.
      const lines = [...element.getClientRects()];
      const line = lines.find((rect) => pointerY >= rect.top && pointerY <= rect.bottom) ?? element.getBoundingClientRect();
      const { top, left, bottom, right, width, height } = line;
      setHovered({ href, blockId, element, anchor: { top, left, bottom, right, width, height } });
    }, SHOW_AFTER_MS);
  }, []);

  const onPointerOut = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const element = (event.target as Element | null)?.closest?.("a[href]");
    if (!element) return;
    // Still on the link: from one of its words to another.
    if (event.relatedTarget instanceof Node && element.contains(event.relatedTarget)) return;
    if (pending.current === element) stopShowing();
    if (shown.current === element) release();
  }, [release]);

  return { hovered, onPointerOver, onPointerOut, keep, release, close };
}

/** The card itself: where the link goes (pressed, it opens there), Copy,
 *  and — for someone who may change the page — Edit and, for a link that
 *  makes one, Embed. */
export function LinkHoverCard({
  link,
  readOnly,
  onKeep,
  onRelease,
  onClose,
  onCopy,
  onEdit,
  onEmbed,
}: {
  link: HoveredLink;
  readOnly: boolean;
  onKeep(): void;
  onRelease(): void;
  onClose(): void;
  onCopy(link: HoveredLink): void;
  onEdit(link: HoveredLink): void;
  onEmbed(link: HoveredLink, embed: Embed): void;
}) {
  const embed = embedFromUrl(link.href);
  return (
    <Popover open anchor={link.anchor} placement="bottom-start" gap={4} role="dialog" label="Link" onDismiss={onClose}>
      <div className="link-card" onPointerEnter={onKeep} onPointerLeave={onRelease}>
        <a className="link-card__address" href={link.href} target="_blank" rel="noopener noreferrer" title={link.href} onClick={onClose}>
          <Globe size={14} aria-hidden="true" />
          <span className="link-card__url">{link.href}</span>
        </a>
        <Tooltip label="Copy link">
          <button type="button" className="link-card__icon" aria-label="Copy link" onClick={() => onCopy(link)}>
            <Copy size={14} />
          </button>
        </Tooltip>
        {readOnly ? null : <button type="button" className="link-card__action" onClick={() => onEdit(link)}>Edit</button>}
        {readOnly || !embed ? null : (
          <button type="button" className="link-card__action" title={embedVerb(embed)} onClick={() => onEmbed(link, embed)}>Embed</button>
        )}
      </div>
    </Popover>
  );
}

/** A YouTube or X link just pasted onto a line of its own: Notion's paste
 *  menu, offering its card. The caret stays in the line; the editor answers
 *  the keys (↑ ↓ choose, Enter takes, Escape or anything typed keeps the
 *  link). */
export interface CardOfferState {
  blockId: string;
  href: string;
  embed: Embed;
  anchor: AnchorRect;
  /** The item the keys are on: 0 the card, 1 the link. */
  index: number;
}

export function CardOffer({
  offer,
  onTake,
  onKeepLink,
  onPoint,
}: {
  offer: CardOfferState;
  onTake(): void;
  onKeepLink(): void;
  onPoint(index: number): void;
}) {
  const items = [
    { label: embedVerb(offer.embed), run: onTake },
    { label: "Keep as link", run: onKeepLink },
  ];
  return (
    <Popover open anchor={offer.anchor} placement="bottom-start" label="Paste as" onDismiss={onKeepLink}>
      <div className="menu card-offer" role="menu" aria-label="Paste as">
        <div className="menu__section-title">Paste as</div>
        {items.map((item, index) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={`menu__item ${offer.index === index ? "is-active" : ""}`}
            onMouseDown={(event) => event.preventDefault()}
            onPointerMove={() => onPoint(index)}
            onClick={item.run}
          >
            <span className="menu__copy"><span className="menu__label">{item.label}</span></span>
          </button>
        ))}
      </div>
    </Popover>
  );
}
