import { BookOpen, ChevronDown, LockKeyhole, Plus } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useWorkspace } from "../../app/workspace-context";
import { MenuDivider, MenuItem, MenuList } from "../../components/Menu";
import { Popover } from "../../components/Popover";
import { personName, ProfileAvatar } from "../../components/ProfileAvatar";
import type { SpaceRole } from "../../core/types";
import { rectOf, type AnchorRect } from "../../hooks/useAnchoredPosition";
import { KnowledgeBaseDialog } from "./KnowledgeBaseDialog";
import "./knowledge-base.css";

const ROLE_LABELS: Record<SpaceRole, string> = { owner: "所有者", admin: "管理员", editor: "可编辑", viewer: "只读" };

export function SpaceSwitcher({ compact = false, onSwitch }: { compact?: boolean; onSwitch?(): void }) {
  const { platform, spaces, activeSpaceId, activeSpace, switchSpace } = useWorkspace();
  const user = platform?.bootstrap.user;
  const trigger = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const [creating, setCreating] = useState(false);
  const id = useId();
  const group = `knowledge-spaces-${id}`;
  const teams = Object.values(spaces).filter((space) => space.knowledgeBase);
  const currentName = activeSpace?.name ?? "个人空间";

  if (!user) return null;
  const focusTrigger = () => {
    if (trigger.current?.getClientRects().length && !trigger.current.closest("[inert]")) trigger.current.focus({ preventScroll: true });
  };
  const choose = (spaceId: string) => {
    setAnchor(null);
    focusTrigger();
    switchSpace(spaceId);
    onSwitch?.();
  };

  return <>
    <button ref={trigger} type="button" className={`space-switcher${compact ? " space-switcher--compact" : ""}${anchor ? " is-active" : ""}`}
      aria-label="切换空间" aria-haspopup="menu" aria-expanded={Boolean(anchor)} aria-controls={anchor ? `${id}-menu` : undefined}
      title={`${personName(user)} · ${currentName}`} data-pop-group={group}
      onClick={(event) => { const rect = rectOf(event.currentTarget); setAnchor((current) => current ? null : rect); }}>
      <ProfileAvatar src={user.avatarUrl} name={personName(user)} size={22} />
      <span className="space-switcher__copy"><span className="space-switcher__user">{personName(user)}</span><span className="space-switcher__current">{currentName}</span></span>
      <ChevronDown className="space-switcher__chevron" size={12} aria-hidden="true" />
    </button>
    <Popover open={Boolean(anchor)} anchor={anchor} placement="top-start" role="presentation" label="切换空间"
      className="space-switcher-popover" group={group} onDismiss={(reason) => { setAnchor(null); if (reason === "escape") focusTrigger(); }}>
      <div id={`${id}-menu`}>
        <MenuList label="切换空间" autoFocus>
          <div className="menu__section-title">个人空间</div>
          <MenuItem icon={<LockKeyhole size={16} />} label="个人空间" description="仅自己" selected={activeSpaceId === "personal"} onSelect={() => choose("personal")} />
          <MenuDivider />
          <div className="menu__section-title">团队空间</div>
          {teams.map((space) => <MenuItem key={space.spaceId} icon={<BookOpen size={16} />} label={space.name}
            description={`${ROLE_LABELS[space.role]}${space.knowledgeBase?.archived ? " · 已归档" : ""}`}
            selected={activeSpaceId === space.spaceId} onSelect={() => choose(space.spaceId)} />)}
          <MenuDivider />
          <MenuItem icon={<Plus size={16} />} label="新建团队知识库" onSelect={() => { setAnchor(null); focusTrigger(); setCreating(true); }} />
        </MenuList>
      </div>
    </Popover>
    {creating ? <KnowledgeBaseDialog onClose={() => { setCreating(false); focusTrigger(); }} /> : null}
  </>;
}
