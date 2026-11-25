import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Check,
  ChevronRight,
  Copy,
  Download,
  Maximize2,
  MoreHorizontal,
  Replace,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MenuDivider, MenuItem, MenuList } from "../../components/Menu";
import { Popover } from "../../components/Popover";
import type { Block } from "../../core/types";
import { rectOf, type AnchorRect } from "../../hooks/useAnchoredPosition";
import { useFold } from "../../hooks/useFold";

const ALIGNMENTS = [
  { value: undefined, label: "Align left", Icon: AlignLeft },
  { value: "center", label: "Align center", Icon: AlignCenter },
  { value: "right", label: "Align right", Icon: AlignRight },
] as const;

/** A picture's hover toolbar, at its top right corner while the pointer is on
 *  it: alignment (when editable), copy image, download, view full size, and a
 *  visible overflow trigger for secondary actions (replace, reset size, delete). */
export function PictureTools({
  rect,
  align,
  readOnly,
  menuOpen = false,
  onAlign,
  onCopy,
  onDownload,
  onView,
  onMore,
  onEnter,
  onLeave,
}: {
  rect: DOMRect;
  align: Block["align"];
  readOnly: boolean;
  menuOpen?: boolean;
  onAlign(align: Block["align"]): void;
  onCopy(): Promise<boolean> | void;
  onDownload(): void;
  onView(): void;
  onMore?(anchor: AnchorRect): void;
  onEnter(): void;
  onLeave(): void;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const handleCopy = () => {
    void Promise.resolve(onCopy()).then((ok) => {
      if (ok === false) return;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      setCopied(true);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setCopied(false);
      }, 1600);
    });
  };

  const top = Math.max(8, Math.min(rect.top + 6, window.innerHeight - 44));
  const right = Math.max(8, Math.min(window.innerWidth - rect.right + 6, window.innerWidth - 44));

  return (
    <div
      className="picture-tools"
      role="toolbar"
      aria-label="Image actions"
      style={{ top, right }}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      // The caret stays where it was.
      onMouseDown={(event) => event.preventDefault()}
    >
      {readOnly ? null : (
        <>
          <span className="picture-tools__group" role="group" aria-label="Align">
            {ALIGNMENTS.map(({ value, label, Icon }) => (
              <button
                key={label}
                type="button"
                className={`block__image-tool ${align === value ? "is-active" : ""}`}
                aria-label={label}
                aria-pressed={align === value}
                title={label}
                onClick={() => onAlign(value)}
              >
                <Icon size={14} aria-hidden="true" />
              </button>
            ))}
          </span>
          <span className="picture-tools__sep" role="separator" aria-orientation="vertical" />
        </>
      )}
      <span className="picture-tools__group" role="group" aria-label="File actions">
        <button
          type="button"
          className={`block__image-tool ${copied ? "is-copied" : ""}`}
          aria-label="Copy image"
          title={copied ? "Image copied" : "Copy image"}
          onClick={handleCopy}
        >
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        </button>
        <button type="button" className="block__image-tool" aria-label="Download" title="Download" onClick={onDownload}>
          <Download size={14} aria-hidden="true" />
        </button>
        <button type="button" className="block__image-tool" aria-label="View full size" title="View full size" onClick={onView}>
          <Maximize2 size={14} aria-hidden="true" />
        </button>
        {!readOnly && onMore ? (
          <button
            type="button"
            className={`block__image-tool ${menuOpen ? "is-active" : ""}`}
            aria-label="More image actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="More image actions"
            onClick={(event) => onMore(rectOf(event.currentTarget))}
          >
            <MoreHorizontal size={14} aria-hidden="true" />
          </button>
        ) : null}
      </span>
    </div>
  );
}

/** Shared context / overflow menu for an inline picture: used for right-click
 *  on the picture, the toolbar's More trigger, and editing actions inside the
 *  full-size viewer (including mobile where hover/right-click do not exist). */
export function PictureMenu({
  anchor,
  align,
  resized,
  readOnly,
  onClose,
  onCopy,
  onView,
  onDownload,
  onAlign,
  onReplace,
  onResetSize,
  onDelete,
}: {
  anchor: AnchorRect;
  align?: Block["align"];
  resized: boolean;
  readOnly: boolean;
  onClose(): void;
  onCopy?(): void;
  onView?(): void;
  onDownload?(): void;
  onAlign?(align: Block["align"]): void;
  onReplace?(): void;
  onResetSize?(): void;
  onDelete?(): void;
}) {
  const mobile = useFold();
  const alignRef = useRef<HTMLButtonElement | null>(null);
  const [alignOpen, setAlignOpen] = useState(false);

  const hasReadActions = Boolean(onCopy || onView || onDownload);
  const hasEditActions = !readOnly && Boolean(onAlign || onReplace || (resized && onResetSize) || onDelete);

  return (
    <>
      <Popover
        open
        anchor={anchor}
        placement="bottom-start"
        role="presentation"
        label="Image actions"
        group="picture-menu"
        mobileSheet={{ title: "Image actions" }}
        onDismiss={onClose}
      >
        <MenuList label="Image actions" autoFocus>
          {onCopy ? (
            <MenuItem icon={<Copy size={16} />} label="Copy image" onSelect={() => { onClose(); onCopy(); }} />
          ) : null}
          {onView ? (
            <MenuItem icon={<Maximize2 size={16} />} label="View full size" onSelect={() => { onClose(); onView(); }} />
          ) : null}
          {onDownload ? (
            <MenuItem icon={<Download size={16} />} label="Download" onSelect={() => { onClose(); onDownload(); }} />
          ) : null}
          {hasReadActions && hasEditActions ? <MenuDivider /> : null}
          {!readOnly && onReplace ? (
            <MenuItem icon={<Replace size={16} />} label="Replace image" onSelect={() => { onClose(); onReplace(); }} />
          ) : null}
          {!readOnly && resized && onResetSize ? (
            <MenuItem icon={<RotateCcw size={16} />} label="Reset original size" onSelect={() => { onClose(); onResetSize(); }} />
          ) : null}
          {!readOnly && onAlign ? (
            mobile ? (
              <>
                {ALIGNMENTS.map(({ value, label, Icon }) => (
                  <MenuItem
                    key={label}
                    icon={<Icon size={16} />}
                    label={label}
                    selected={align === value}
                    onSelect={() => { onClose(); onAlign(value); }}
                  />
                ))}
              </>
            ) : (
              <button
                type="button"
                ref={alignRef}
                data-menu-item
                role="menuitem"
                className={`menu__item ${alignOpen ? "is-active" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setAlignOpen((open) => !open)}
              >
                <span className="menu__icon"><AlignLeft size={16} /></span>
                <span className="menu__copy"><span className="menu__label">Align</span></span>
                <span className="menu__hint"><ChevronRight size={14} /></span>
              </button>
            )
          ) : null}
          {!readOnly && onDelete ? (
            <>
              {(onReplace || (resized && onResetSize) || onAlign) ? <MenuDivider /> : null}
              <MenuItem icon={<Trash2 size={16} />} label="Delete image" tone="danger" onSelect={() => { onClose(); onDelete(); }} />
            </>
          ) : null}
        </MenuList>
      </Popover>

      {!mobile && !readOnly && onAlign ? (
        <Popover
          open={alignOpen}
          anchor={alignRef.current ? rectOf(alignRef.current) : null}
          placement="right-start"
          role="presentation"
          label="Align"
          group="picture-menu"
          onDismiss={() => setAlignOpen(false)}
        >
          <MenuList label="Align" autoFocus>
            {ALIGNMENTS.map(({ value, label, Icon }) => (
              <MenuItem
                key={label}
                icon={<Icon size={16} />}
                label={label}
                selected={align === value}
                onSelect={() => { setAlignOpen(false); onClose(); onAlign(value); }}
              />
            ))}
          </MenuList>
        </Popover>
      ) : null}
    </>
  );
}
