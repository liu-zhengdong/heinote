import { AlignCenter, AlignLeft, AlignRight, Download, Maximize2 } from "lucide-react";
import type { Block } from "../../core/types";

const ALIGNMENTS = [
  { value: undefined, label: "Align left", Icon: AlignLeft },
  { value: "center", label: "Align center", Icon: AlignCenter },
  { value: "right", label: "Align right", Icon: AlignRight },
] as const;

/** A picture's tools, at its top right corner while the pointer is on it:
 *  where its line stands across the page — the picture with its words — and
 *  its bytes, saved or looked at whole. */
export function PictureTools({
  rect,
  align,
  readOnly,
  onAlign,
  onDownload,
  onView,
  onEnter,
  onLeave,
}: {
  rect: DOMRect;
  align: Block["align"];
  readOnly: boolean;
  onAlign(align: Block["align"]): void;
  onDownload(): void;
  onView(): void;
  onEnter(): void;
  onLeave(): void;
}) {
  return (
    <div
      className="picture-tools"
      style={{ top: rect.top + 6, right: window.innerWidth - rect.right + 6 }}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      // The caret stays where it was.
      onMouseDown={(event) => event.preventDefault()}
    >
      {readOnly ? null : (
        <span className="picture-tools__group" role="group" aria-label="Align">
          {ALIGNMENTS.map(({ value, label, Icon }) => (
            <button
              key={label}
              type="button"
              className={`block__image-tool ${align === value ? "is-active" : ""}`}
              aria-label={label}
              aria-pressed={align === value}
              onClick={() => onAlign(value)}
            >
              <Icon size={14} />
            </button>
          ))}
        </span>
      )}
      <button type="button" className="block__image-tool" aria-label="Download" onClick={onDownload}>
        <Download size={14} />
      </button>
      <button type="button" className="block__image-tool" aria-label="View full size" onClick={onView}>
        <Maximize2 size={14} />
      </button>
    </div>
  );
}
