import { Baseline, ChevronDown, Database, Group, Link, Link2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Popover } from "../../components/Popover";
import { imeComposing } from "../../core/keyboard";
import { MenuItem, MenuList } from "../../components/Menu";
import { rectOf, type AnchorRect } from "../../hooks/useAnchoredPosition";
import { findAddresses } from "../../core/autolink";
import type { ToggleableMark } from "../../core/inline-content";
import type { BlockKind, ContentColor } from "../../core/types";
import { blockDefinition } from "./block-registry";
import { ColorMenu } from "./ColorMenu";
import { MARKS } from "./marks";
import { isWebLink } from "../../core/inline-content";

export interface FormatState {
  anchor: AnchorRect;
  blockId: string;
  kind: BlockKind;
  ranges: Array<{ blockId: string; start: number; end: number }>;
  marks: Record<ToggleableMark, boolean>;
  link?: string;
  /** The colour the whole selection shares, if it shares one. */
  color?: ContentColor;
  /** The selected words, when they are in one paragraph. */
  text?: string;
  /** ⌘K: the toolbar comes with its Link box open. */
  linkRequested?: boolean;
}

/** The selected words when they are one web address — a link pasted as
 *  words, selected to be made a link: the box opens holding it, so Link (or
 *  Enter) is all that is left to do. */
export function selectedAddress(text: string | undefined): string | undefined {
  const words = text?.trim();
  if (!words) return undefined;
  const found = findAddresses(words);
  return found.length === 1 && found[0].start === 0 && found[0].end === words.length ? found[0].href : undefined;
}

/** What the Link box's words make: nothing (the link taken off), or an
 *  address — `https://` put in front of one typed without it. */
export function linkHref(value: string): string | undefined {
  const words = value.trim();
  return words ? (isWebLink(words) ? words : `https://${words}`) : undefined;
}

/** The Link box: the address typed or pasted, Link (Update when the words
 *  have one), and Remove. The same box for words in a page and a page's
 *  name. */
export function LinkForm({
  value,
  linked,
  onValue,
  onSubmit,
  onRemove,
}: {
  value: string;
  /** The words have a link already. */
  linked: boolean;
  onValue(next: string): void;
  onSubmit(): void;
  onRemove(): void;
}) {
  return (
    <div className="link-editor">
      <input
        autoFocus
        value={value}
        placeholder="Paste a link…"
        onChange={(event) => onValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !imeComposing(event)) { event.preventDefault(); onSubmit(); }
        }}
      />
      <button type="button" className="btn btn--primary" onMouseDown={(event) => event.preventDefault()} onClick={onSubmit}>
        {linked ? "Update" : "Link"}
      </button>
      {linked ? (
        <button type="button" className="btn btn--danger" onMouseDown={(event) => event.preventDefault()} onClick={onRemove}>
          Remove
        </button>
      ) : null}
    </div>
  );
}

const TURN_INTO: BlockKind[] = [
  "text", "heading1", "heading2", "heading3", "todo", "bullet", "numbered",
  "quote", "callout", "code",
];

/** The bar that meets a text selection. It never touches the DOM directly:
 *  every button hands a mark back to the editor, which rewrites the
 *  paragraph's inline runs and puts the same selection back. The last two
 *  make the paragraphs the selection touches a block — the second copying
 *  its link too, for pointing at it from another page. */
export function FormatToolbar({
  state,
  onToggleMark,
  onTurnInto,
  onTurnIntoAll,
  onTurnIntoDatabase,
  onSetLink,
  onColor,
  onMakeBlock,
  onCopyBlockLink,
  onClose,
  onReturn,
}: {
  state: FormatState;
  onToggleMark(mark: ToggleableMark): void;
  onTurnInto(kind: BlockKind): void;
  /** Turn into, for every paragraph the selection touches. */
  onTurnIntoAll(kind: BlockKind): void;
  /** A list's lines turned into a database — offered only when they can be. */
  onTurnIntoDatabase?(): void;
  onSetLink(href: string | undefined): void;
  onColor(color: ContentColor | undefined): void;
  onMakeBlock(): void;
  onCopyBlockLink(): void;
  onClose(): void;
  /** Puts the caret back on the words the toolbar was opened for — after
   *  the link box, which took it, is left with Escape. */
  onReturn(): void;
}) {
  const turnRef = useRef<HTMLButtonElement | null>(null);
  const linkRef = useRef<HTMLButtonElement | null>(null);
  const colorRef = useRef<HTMLButtonElement | null>(null);
  const [turnOpen, setTurnOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const [href, setHref] = useState(state.link ?? "");

  /* ⌘K opens the Link box as pressing Link would. A frame later: a toolbar
     just shown for it is placed by then, and the box stands under its
     button rather than where the button was before. */
  const { link, text, linkRequested } = state;
  useEffect(() => {
    if (!linkRequested) return;
    const frame = requestAnimationFrame(() => {
      setHref(link ?? selectedAddress(text) ?? "");
      setLinkOpen(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [link, linkRequested, text]);

  const submitLink = () => {
    onSetLink(linkHref(href));
    setLinkOpen(false);
  };

  return (
    <>
      <Popover
        open
        anchor={state.anchor}
        placement="top-start"
        gap={8}
        role="toolbar"
        label="Text formatting"
        group="format"
        onDismiss={onClose}
      >
        <div className="format-bar">
          <div className="format-bar__group">
            {state.ranges.length === 1 ? (
              <button
                type="button"
                ref={turnRef}
                className="format-bar__turn"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setTurnOpen((open) => !open)}
              >
                {blockDefinition(state.kind).label}
                <ChevronDown size={13} />
              </button>
            ) : (
              <button
                type="button"
                ref={turnRef}
                className="format-bar__turn format-bar__selection"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setTurnOpen((open) => !open)}
              >
                {state.ranges.length} paragraphs
                <ChevronDown size={13} />
              </button>
            )}
          </div>
          <div className="format-bar__group">
            {MARKS.map(({ mark, label, icon: Icon }) => (
              <button
                type="button"
                key={mark}
                className={`icon-btn ${state.marks[mark] ? "is-on" : ""}`}
                aria-label={label}
                aria-pressed={state.marks[mark]}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onToggleMark(mark)}
              >
                <Icon size={15} />
              </button>
            ))}
            <button
              type="button"
              ref={linkRef}
              className={`icon-btn ${state.link ? "is-on" : ""}`}
              aria-label="Link"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => { setHref(state.link ?? selectedAddress(state.text) ?? ""); setLinkOpen((open) => !open); }}
            >
              <Link2 size={15} />
            </button>
            <button
              type="button"
              ref={colorRef}
              className={`icon-btn format-bar__color ${state.color ? "is-on" : ""}`}
              aria-label="Text color"
              data-color={state.color}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setColorOpen((open) => !open)}
            >
              <Baseline size={15} />
            </button>
          </div>
          <div className="format-bar__group">
            <button
              type="button"
              className="icon-btn"
              aria-label="Group"
              title="Group"
              onMouseDown={(event) => event.preventDefault()}
              onClick={onMakeBlock}
            >
              <Group size={15} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Copy link to block"
              title="Copy link to block"
              onMouseDown={(event) => event.preventDefault()}
              onClick={onCopyBlockLink}
            >
              <Link size={15} />
            </button>
          </div>
        </div>
      </Popover>

      <Popover
        open={colorOpen}
        anchor={colorRef.current ? rectOf(colorRef.current) : null}
        placement="bottom-start"
        label="Text color"
        group="format"
        onDismiss={() => setColorOpen(false)}
        closeOnScroll={false}
      >
        <div onMouseDown={(event) => event.preventDefault()}>
          <ColorMenu current={state.color} autoFocus={false} onPick={(color) => { setColorOpen(false); onColor(color); }} />
        </div>
      </Popover>

      <Popover
        open={turnOpen}
        anchor={turnRef.current ? rectOf(turnRef.current) : null}
        placement="bottom-start"
        label="Turn into"
        group="format"
        onDismiss={() => setTurnOpen(false)}
        closeOnScroll={false}
      >
        <MenuList label="Turn into">
          {TURN_INTO.map((kind) => {
            const definition = blockDefinition(kind);
            const Icon = definition.icon;
            return (
              <MenuItem
                key={kind}
                icon={<Icon size={16} />}
                label={definition.label}
                selected={state.ranges.length === 1 && kind === state.kind}
                onSelect={() => {
                  setTurnOpen(false);
                  if (state.ranges.length === 1) onTurnInto(kind);
                  else onTurnIntoAll(kind);
                }}
              />
            );
          })}
          {onTurnIntoDatabase ? (
            <MenuItem
              icon={<Database size={16} />}
              label="Database"
              onSelect={() => { setTurnOpen(false); onTurnIntoDatabase(); }}
            />
          ) : null}
        </MenuList>
      </Popover>

      <Popover
        open={linkOpen}
        anchor={linkRef.current ? rectOf(linkRef.current) : null}
        placement="bottom-start"
        role="dialog"
        label="Link"
        group="format"
        onDismiss={(reason) => {
          setLinkOpen(false);
          // Escape goes back to the words, still selected, as Notion's does;
          // a press elsewhere goes where it was pressed.
          if (reason === "escape") onReturn();
        }}
        closeOnScroll={false}
      >
        <LinkForm
          value={href}
          linked={Boolean(state.link)}
          onValue={setHref}
          onSubmit={submitLink}
          onRemove={() => { onSetLink(undefined); setLinkOpen(false); }}
        />
      </Popover>
    </>
  );
}
