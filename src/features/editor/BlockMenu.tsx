import { ChevronRight, Columns3, Copy, CornerDownRight, CornerUpLeft, Database, Download, Group, Link, Link2, Palette, Replace, Rows3, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { MenuDivider, MenuItem, MenuList } from "../../components/Menu";
import { Popover } from "../../components/Popover";
import { rectOf, type AnchorRect } from "../../hooks/useAnchoredPosition";
import { normalizeSimpleTable } from "../../core/simple-table";
import type { Block, BlockKind, ContentColor } from "../../core/types";
import { blockDefinition } from "./block-registry";
import { ColorMenu } from "./ColorMenu";

const TURN_INTO: BlockKind[] = [
  "text", "heading1", "heading2", "heading3", "todo", "bullet", "numbered",
  "quote", "callout", "code", "divider",
];

/** The menu for selected paragraphs (⌘/): what Notion offers for blocks,
 *  minus comments, which Notes has no model for — and, since a paragraph is
 *  not a block here, a way to make them one. It acts on all of them. */
export function BlockMenu({
  anchor,
  blocks,
  onClose,
  onDelete,
  onDuplicate,
  onTurnInto,
  onColor,
  onMoveTo,
  onMakeBlock,
  onCopyBlockLink,
  onReplace,
  onDownload,
  onTurnIntoDatabase,
  onTableHeader,
  onTurnIntoLink,
}: {
  anchor: AnchorRect;
  blocks: Block[];
  onClose(): void;
  onDelete(): void;
  onDuplicate(): void;
  onTurnInto(kind: BlockKind): void;
  onColor(color: ContentColor | undefined): void;
  onMoveTo(): void;
  /** Groups the paragraphs into a block. */
  onMakeBlock(): void;
  /** Groups them into a block (unless they are one already) and copies its link. */
  onCopyBlockLink(): void;
  onReplace(): void;
  onDownload(): void;
  /** A list's lines, or a table, turned into a database — offered only when
   *  they can be. */
  onTurnIntoDatabase?(): void;
  /** A table's header row or column switched, as Notion's table menu does. */
  onTableHeader?(block: Block, which: "header_row" | "header_column"): void;
  /** A card back to the line it came from: its address, linked. */
  onTurnIntoLink?(): void;
}) {
  const turnRef = useRef<HTMLButtonElement | null>(null);
  const colorRef = useRef<HTMLButtonElement | null>(null);
  const [turnOpen, setTurnOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const colors = new Set(blocks.map((block) => block.color));
  const color = colors.size === 1 ? blocks[0]?.color : undefined;
  // A folded block is a whole block, not a line in a colour or a costume.
  const colorable = blocks.some((block) => block.kind !== "divider" && block.kind !== "page" && block.kind !== "embed");
  const several = blocks.length > 1;
  const kinds = new Set(blocks.map((block) => block.kind));
  const kind = kinds.size === 1 ? blocks[0]?.kind : undefined;
  // A child page or a database is not text in a different costume: turning
  // its block into a heading would leave the page it points at orphaned. An
  // image or a file is its bytes, not words, either.
  const convertible = blocks.some((block) => block.kind !== "page" && block.kind !== "table" && block.kind !== "embed" && block.kind !== "file");
  // A card is its link, shown: it goes back to being the link.
  const card = !several && blocks[0]?.kind === "embed" ? blocks[0] : undefined;
  const media = !several && blocks[0] && blocks[0].kind === "file" ? blocks[0] : undefined;
  const table = !several && blocks[0]?.kind === "table" ? blocks[0] : undefined;
  const headers = table ? normalizeSimpleTable(table.table) : undefined;

  return (
    <>
      <Popover open anchor={anchor} placement="bottom-start" label="Paragraph actions" group="block-menu" onDismiss={onClose}>
        <MenuList label="Paragraph actions" autoFocus>
          {several ? <div className="menu__section-title">{blocks.length} paragraphs</div> : null}
          {/* A table's own switches first, as at the top of Notion's. */}
          {table && headers && onTableHeader ? (
            <>
              <MenuItem icon={<Rows3 size={16} />} label="Header row" selected={headers.header_row} onSelect={() => { onClose(); onTableHeader(table, "header_row"); }} />
              <MenuItem icon={<Columns3 size={16} />} label="Header column" selected={headers.header_column} onSelect={() => { onClose(); onTableHeader(table, "header_column"); }} />
              <MenuDivider />
            </>
          ) : null}
          <MenuItem icon={<Trash2 size={16} />} label="Delete" hint="Del" tone="danger" onSelect={() => { onClose(); onDelete(); }} />
          <MenuItem icon={<Copy size={16} />} label="Duplicate" hint="⌘D" onSelect={() => { onClose(); onDuplicate(); }} />
          <MenuItem icon={<CornerDownRight size={16} />} label="Move to" hint="⌘⇧P" onSelect={() => { onClose(); onMoveTo(); }} />
          <MenuItem icon={<Group size={16} />} label="Group" onSelect={() => { onClose(); onMakeBlock(); }} />
          <MenuItem icon={<Link size={16} />} label="Copy link to block" onSelect={() => { onClose(); onCopyBlockLink(); }} />
          {media ? <MenuItem icon={<Replace size={16} />} label="Replace" onSelect={() => { onClose(); onReplace(); }} /> : null}
          {media?.file ? <MenuItem icon={<Download size={16} />} label="Download" onSelect={() => { onClose(); onDownload(); }} /> : null}
          {card && onTurnIntoLink ? <MenuItem icon={<Link2 size={16} />} label="Turn into link" onSelect={() => { onClose(); onTurnIntoLink(); }} /> : null}
          {convertible || colorable || onTurnIntoDatabase ? <MenuDivider /> : null}
          {convertible ? <button
            type="button"
            ref={turnRef}
            data-menu-item
            role="menuitem"
            className={`menu__item ${turnOpen ? "is-active" : ""}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => { setColorOpen(false); setTurnOpen((open) => !open); }}
          >
            <span className="menu__icon"><CornerUpLeft size={16} /></span>
            <span className="menu__copy"><span className="menu__label">Turn into</span></span>
            <span className="menu__hint"><ChevronRight size={14} /></span>
          </button> : null}
          {/* Lines of a list, or a table: into a database, beside the kinds
              they can turn into (features/database/convert.ts). */}
          {onTurnIntoDatabase ? (
            <MenuItem icon={<Database size={16} />} label="Turn into database" onSelect={() => { onClose(); onTurnIntoDatabase(); }} />
          ) : null}
          {colorable ? <button
            type="button"
            ref={colorRef}
            data-menu-item
            role="menuitem"
            className={`menu__item ${colorOpen ? "is-active" : ""}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => { setTurnOpen(false); setColorOpen((open) => !open); }}
          >
            <span className="menu__icon"><Palette size={16} /></span>
            <span className="menu__copy"><span className="menu__label">Color</span></span>
            <span className="menu__hint"><ChevronRight size={14} /></span>
          </button> : null}
        </MenuList>
      </Popover>

      <Popover
        open={colorOpen}
        anchor={colorRef.current ? rectOf(colorRef.current) : null}
        placement="right-start"
        label="Color"
        group="block-menu"
        onDismiss={() => setColorOpen(false)}
      >
        <ColorMenu current={color} onPick={(next) => { setColorOpen(false); onClose(); onColor(next); }} />
      </Popover>

      <Popover
        open={turnOpen}
        anchor={turnRef.current ? rectOf(turnRef.current) : null}
        placement="right-start"
        label="Turn into"
        group="block-menu"
        onDismiss={() => setTurnOpen(false)}
      >
        <MenuList label="Turn into" autoFocus>
          {TURN_INTO.map((option) => {
            const definition = blockDefinition(option);
            const Icon = definition.icon;
            return (
              <MenuItem
                key={option}
                icon={<Icon size={16} />}
                label={definition.label}
                selected={option === kind}
                onSelect={() => { setTurnOpen(false); onClose(); onTurnInto(option); }}
              />
            );
          })}
        </MenuList>
      </Popover>
    </>
  );
}
