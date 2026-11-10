import { ArrowUpRight, ChevronsDownUp, ChevronsUpDown, CircleMinus, Copy, CornerDownRight, ExternalLink, Link, Lock, PencilLine, Smile, Trash2, Ungroup, UserPlus } from "lucide-react";
import { useState } from "react";
import { MenuDivider, MenuItem, MenuList } from "../../components/Menu";
import { Popover } from "../../components/Popover";
import { imeComposing } from "../../core/keyboard";
import type { AnchorRect } from "../../hooks/useAnchoredPosition";

/** The one menu for a page wherever it stands in another: a block drawn in
 *  place, a page or database shown here, a page's row, a line that is only
 *  a link. A block is a page, so every one of them is a page's menu — open
 *  it, share it, name it and give it an icon, its link and backlinks, how it
 *  is shown here (read only, shown, folded), moving and copying it, undoing
 *  it into loose paragraphs, taking it off this page, the trash.
 *
 *  It shows exactly what it is handed: whoever opens it passes the actions
 *  this reader may take on this page, here, and nothing else. */
export function PageMenu({
  anchor,
  name,
  references = 0,
  locked = false,
  onClose,
  onOpen,
  onShare,
  onRename,
  onIcon,
  onCopyLink,
  onBacklinks,
  onLock,
  onMoveTo,
  onDuplicate,
  onShow,
  onFold,
  onUngroup,
  onRemoveHere,
  onDelete,
}: {
  anchor: AnchorRect;
  name: string;
  /** Links to it from outside where it lives. */
  references?: number;
  /** Read only here, when `onLock` toggles it. */
  locked?: boolean;
  onClose(): void;
  onOpen?(): void;
  onShare?(): void;
  onRename?(): void;
  onIcon?(): void;
  onCopyLink?(): void;
  onBacklinks?(): void;
  onLock?(): void;
  onMoveTo?(): void;
  onDuplicate?(): void;
  /** Folded here (its row, a link) — shown here, for everyone. */
  onShow?(): void;
  /** Shown here — folded back into its row or link, for everyone. */
  onFold?(): void;
  /** A block drawn in place, come apart into loose paragraphs. */
  onUngroup?(): void;
  onRemoveHere?(): void;
  onDelete?(): void;
}) {
  const act = (action: () => void) => () => { onClose(); action(); };
  const shown = [onShow, onFold, onUngroup, onRemoveHere, onDelete].some(Boolean);
  return (
    <Popover open anchor={anchor} placement="bottom-start" label="Page" group="page-menu" onDismiss={onClose}>
      <MenuList label="Page" autoFocus>
        <div className="menu__section-title page-menu__name">{name}</div>
        {onOpen ? <MenuItem icon={<ExternalLink size={16} />} label="Open" onSelect={act(onOpen)} /> : null}
        {onShare ? <MenuItem icon={<UserPlus size={16} />} label="Share…" onSelect={act(onShare)} /> : null}
        {onRename ? <MenuItem icon={<PencilLine size={16} />} label="Name…" onSelect={act(onRename)} /> : null}
        {onIcon ? <MenuItem icon={<Smile size={16} />} label="Icon…" onSelect={act(onIcon)} /> : null}
        {onCopyLink ? <MenuItem icon={<Link size={16} />} label="Copy link" onSelect={act(onCopyLink)} /> : null}
        {references && onBacklinks ? (
          <MenuItem icon={<ArrowUpRight size={16} />} label="Backlinks" hint={String(references)} onSelect={act(onBacklinks)} />
        ) : null}
        {onLock ? <MenuItem icon={<Lock size={16} />} label="Read only here" selected={locked} onSelect={act(onLock)} /> : null}
        {onMoveTo ? <MenuItem icon={<CornerDownRight size={16} />} label="Move to…" onSelect={act(onMoveTo)} /> : null}
        {onDuplicate ? <MenuItem icon={<Copy size={16} />} label="Duplicate" onSelect={act(onDuplicate)} /> : null}
        {shown ? <MenuDivider /> : null}
        {onShow ? <MenuItem icon={<ChevronsUpDown size={16} />} label="Show here" onSelect={act(onShow)} /> : null}
        {onFold ? <MenuItem icon={<ChevronsDownUp size={16} />} label="Fold" onSelect={act(onFold)} /> : null}
        {onUngroup ? <MenuItem icon={<Ungroup size={16} />} label="Ungroup" onSelect={act(onUngroup)} /> : null}
        {onRemoveHere ? <MenuItem icon={<CircleMinus size={16} />} label="Remove from this page" onSelect={act(onRemoveHere)} /> : null}
        {onDelete ? <MenuItem icon={<Trash2 size={16} />} label="Move to trash" tone="danger" onSelect={act(onDelete)} /> : null}
      </MenuList>
    </Popover>
  );
}

/** Names a page — a block is one. Left empty, it goes by its first line. */
export function PageNameEditor({
  anchor,
  name,
  firstLine,
  onSave,
  onClose,
}: {
  anchor: AnchorRect;
  /** The name it has now, if it has one. */
  name?: string;
  /** What it goes by without one. */
  firstLine: string;
  onSave(name: string | undefined): void;
  onClose(): void;
}) {
  const [value, setValue] = useState(name ?? "");
  const save = () => {
    onSave(value.trim() || undefined);
    onClose();
  };
  return (
    <Popover open anchor={anchor} placement="bottom-start" role="dialog" label="Name this block" group="page-menu" onDismiss={onClose}>
      <form
        className="link-editor"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <input
          autoFocus
          value={value}
          placeholder={firstLine}
          aria-label="Block name"
          maxLength={120}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            // The Enter that picks a candidate is the input method's.
            if (event.key === "Enter" && imeComposing(event)) event.preventDefault();
          }}
        />
        <button type="submit" className="btn btn--primary">Save</button>
      </form>
    </Popover>
  );
}
