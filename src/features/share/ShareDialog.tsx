import {
  ChevronDown,
  Copy,
  CornerLeftUp,
  Edit3,
  Eye,
  Lock,
  LogOut,
  Search,
  Trash2,
  UserCog,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { MenuDivider, MenuItem, MenuList } from "../../components/Menu";
import { Modal } from "../../components/Modal";
import { Popover } from "../../components/Popover";
import { personName, ProfileAvatar } from "../../components/ProfileAvatar";
import { rectOf, type AnchorRect } from "../../hooks/useAnchoredPosition";
import { imeComposing } from "../../core/keyboard";
import { pageName } from "../../core/block-tree";
import type { NotePage, Person, SpaceInvitation, SpaceMember } from "../../core/types";
import { useWorkspace } from "../../app/workspace-context";
import { pageAncestry } from "../../core/page-tree";
import { useUi } from "../../app/ui-context";
import { useCopyPageLink } from "../../hooks/useCopyPageLink";
import { useWorkspaceState } from "../../app/workspace-store";
import { PublicLinks } from "./PublicLinks";
import { usePublicLinks } from "./usePublicLinks";

type InviteRole = "admin" | "editor" | "viewer";

interface RoleOption {
  value: InviteRole;
  label: string;
  icon: ComponentType<{ size?: number }>;
}

const ROLES: RoleOption[] = [
  { value: "admin", label: "Full access", icon: UserCog },
  { value: "editor", label: "Can edit", icon: Edit3 },
  { value: "viewer", label: "Can view", icon: Eye },
];

function roleLabel(role: string): string {
  return role === "owner" ? "Owner" : ROLES.find((option) => option.value === role)?.label ?? "Can view";
}

function daysLeft(expiresAt: string): string {
  const days = Math.ceil((Date.parse(expiresAt) - Date.now()) / 86_400_000);
  if (!Number.isFinite(days) || days <= 0) return "expiring";
  return days === 1 ? "expires tomorrow" : `expires in ${days} days`;
}

/** The page a shared page is shared through: the root of its shared tree. */
function shareRoot(pages: Record<string, NotePage>, pageId: string, spaceId: string): NotePage | undefined {
  return pageAncestry(pages, pageId).findLast((page) => page.share_space_id === spaceId);
}

/** Who can open a page, and what they may do with it.
 *
 * A page is shared through a Terminus space: inviting someone asks them to
 * join it (they accept from their Terminus notifications), and everything in
 * the page — every page inside it too — is theirs to read, and to change
 * unless they may only view. The owner and anyone with Full access invite,
 * move people between Full access, Can edit and Can view, and remove them.
 * Pending invitations stay in the live roster until accepted or revoked. */
export function ShareDialog({ page, onClose }: { page: NotePage; onClose(): void }) {
  const {
    platform,
    spaces,
    rosters,
    ensureShareSpace,
    spaceOf,
    stopSharing,
    leaveShare,
    selectPage,
  } = useWorkspace();
  const { toast, requestShare } = useUi();
  const copyPageLink = useCopyPageLink();
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<InviteRole>("editor");
  const [suggestions, setSuggestions] = useState<Person[]>([]);
  const [memberMenu, setMemberMenu] = useState<{ member: SpaceMember; anchor: AnchorRect } | null>(null);
  const [roleAnchor, setRoleAnchor] = useState<AnchorRect | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"leave" | "stop" | null>(null);
  const fieldRef = useRef<HTMLDivElement | null>(null);

  const me = platform?.bootstrap.user;
  const spaceId = spaceOf(page.id);
  const root = useWorkspaceState((state) => (spaceId ? shareRoot(state.pages, page.id, spaceId) : undefined));
  const space = spaceId ? spaces[spaceId] : undefined;
  const library = space?.knowledgeBase;
  const inherited = Boolean(!library && root && root.id !== page.id);
  /* Who is in the space and who has been asked in, from its live roster:
     current as the space says it changed, so nothing here reads it again. */
  const roster = spaceId ? rosters[spaceId] : undefined;
  const members = useMemo<SpaceMember[]>(() => {
    if (spaceId) return roster?.members ?? [];
    return me ? [{ ...me, role: "owner" }] : [];
  }, [me, roster, spaceId]);
  const invitations = useMemo(
    () => (roster?.invitations ?? []).filter((invitation) => invitation.status === "pending"),
    [roster],
  );
  const myRole = spaceId ? space?.role ?? members.find((member) => member.id === me?.id)?.role : "owner";
  /* The status line names what sharing state this page is in, so "Share"
     stops being one button that hides two different ideas — membership
     (collaborators) and public links (read-only publishing). */
  const linkCount = usePublicLinks().filter((link) => link.pageId === page.id).length;
  const statusText = library
    ? "仅知识库成员可见"
    : [spaceId ? `已共享 · ${members.length} 位成员` : "", linkCount ? "公开链接已开启" : ""].filter(Boolean).join(" · ") || "私有";
  const manager = myRole === "owner" || myRole === "admin";
  const canInvite = !library?.archived && (!spaceId || (space?.canInvite ?? manager));
  const canManageRoles = Boolean(spaceId) && (space?.canManageRoles ?? manager);
  const canRemove = Boolean(spaceId) && (space?.canRemoveMembers ?? manager);
  const canLeave = Boolean(spaceId) && myRole !== "owner" && (space?.canLeave ?? true);
  const canStop = !library && Boolean(spaceId) && !inherited && myRole === "owner";
  const canRevoke = (invitation: SpaceInvitation) => manager && (myRole === "owner" || invitation.role !== "admin");

  useEffect(() => {
    if (myRole !== "owner") setRole((value) => value === "admin" ? "editor" : value);
  }, [myRole]);

  const unavailableUserIds = useMemo(
    () => new Set([
      ...members.map((member) => member.id),
      ...invitations.map((invitation) => invitation.invitee.id),
    ]),
    [invitations, members],
  );

  /* The query the last search answered: lets an empty result say so instead
     of looking like nothing happened. */
  const [searchedQuery, setSearchedQuery] = useState("");
  /* The suggestion ↑/↓ highlights and Enter invites; the first match is the
     default so a short type + Enter invites the obvious person. */
  const [activeIndex, setActiveIndex] = useState(0);
  /* Suggestions float under the invite field instead of pushing the roster
     down. The anchor is the field's rect, re-measured while the list is
     visible; an outside press, Escape or scroll hides the list but keeps the
     results, so Enter and Invite still take the highlighted person. */
  const [suggestAnchor, setSuggestAnchor] = useState<AnchorRect | null>(null);
  const [suggestDismissed, setSuggestDismissed] = useState(false);
  const searched = searchedQuery !== "" && query.trim() === searchedQuery;
  const resultsOpen = Boolean((suggestions.length || searched) && !suggestDismissed);

  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field || !resultsOpen) return;
    const measure = () => setSuggestAnchor(rectOf(field));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [resultsOpen]);

  useEffect(() => {
    if (!platform || query.trim().length < 2) {
      setSuggestions([]);
      setSearchedQuery("");
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void platform.users.search(query).then((results) => {
        if (active) {
          setSuggestions(results.filter((user) => !unavailableUserIds.has(user.id)));
          setSearchedQuery(query.trim());
          setActiveIndex(0);
        }
      }).catch(() => {
        if (active) setSuggestions([]);
      });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [platform, query, unavailableUserIds]);

  const chosen = suggestions[activeIndex];

  const run = async (work: () => Promise<void>, failure: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : failure);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const invite = (handleOverride?: string) => run(async () => {
    if (!platform || !canInvite) return;
    const handle = (handleOverride ?? chosen?.handle ?? query).trim().replace(/^@/, "");
    if (!handle) return;
    const target = await ensureShareSpace(page.id);
    const receipt = await platform.spaces.invite(target, handle, role);
    setQuery("");
    setSuggestions([]);
    setSuggestDismissed(false);
    // A new invitation shows itself under Invited as the roster hears of
    // it; only a repeat, which changes nothing on screen, needs saying.
    if (!receipt.created) toast(`@${handle} already has an invitation waiting`, "info");
  }, "Could not invite that person");

  const changeRole = (member: SpaceMember, next: InviteRole) => run(async () => {
    if (!platform || !spaceId || member.role === next) return;
    setMemberMenu(null);
    await platform.spaces.updateRole(spaceId, member.id, next);
  }, "Could not change that person's access");

  const removeMember = (member: SpaceMember) => run(async () => {
    if (!platform || !spaceId) return;
    setMemberMenu(null);
    await platform.spaces.removeMember(spaceId, member.id);
  }, "Could not remove that person");

  const revokeInvitation = (invitation: SpaceInvitation) => run(async () => {
    if (!platform || !spaceId || !canRevoke(invitation)) return;
    await platform.spaces.revokeInvitation(spaceId, invitation.id);
  }, "无法撤销邀请，请重试。");

  const leave = () => run(async () => {
    if (!canLeave) return;
    await leaveShare(page.id);
    onClose();
  }, "Could not leave this page");

  const stop = () => run(async () => {
    await stopSharing(page.id);
    onClose();
  }, "Could not stop sharing this page");

  /* A member's row has a menu only for someone who can do something to them:
     never for the owner, never for yourself (Leave is below), and an admin
     cannot manage another admin. */
  const manageable = (member: SpaceMember) => (
    (canManageRoles || canRemove)
    && member.role !== "owner"
    && member.id !== me?.id
    && !(member.role === "admin" && myRole !== "owner")
  );

  const managedMember = memberMenu ? members.find((member) => member.id === memberMenu.member.id) : undefined;

  return (
    <Modal open label={library ? `成员 ${space.name}` : `Share ${pageName(page)}`} className={`share${library ? " share--knowledge-base" : ""}`} onClose={() => { if (!busyRef.current) onClose(); }}>
      <header className="share__head">
        <h1 className="share__title">{library ? space.name : "Share"}</h1>
        <button type="button" className="icon-btn" aria-label="Close sharing" disabled={busy} onClick={onClose}><X size={17} /></button>
      </header>

      <div className="share__body" aria-busy={busy}>
        <p className="share__status">{statusText}</p>
        {library ? <p className="share__note">成员权限适用于整个知识库。知识库页面不能公开分享；如需对外发布，请先将页面拷贝到个人空间。</p> : null}
        {inherited && root ? (
          <div className="share__inherited">
            <CornerLeftUp size={15} />
            <span>Shared through <strong>{pageName(root)}</strong> — everyone there can open this page.</span>
            <button type="button" className="btn" onClick={() => { selectPage(root.id); requestShare(root.id); }}>Open</button>
          </div>
        ) : null}

        {canInvite ? (
          <div className="share__invite">
            <div className="share__field" ref={fieldRef}>
              <Search size={15} />
              <input
                value={query}
                disabled={busy}
                autoFocus
                aria-label="Add people by handle"
                placeholder="Add people by handle…"
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSuggestDismissed(false);
                }}
                onKeyDown={(event) => {
                  if (imeComposing(event)) return;
                  if (event.key === "ArrowDown" && suggestions.length) {
                    event.preventDefault();
                    setSuggestDismissed(false);
                    setActiveIndex((index) => (index + 1) % suggestions.length);
                  } else if (event.key === "ArrowUp" && suggestions.length) {
                    event.preventDefault();
                    setSuggestDismissed(false);
                    setActiveIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
                  } else if (event.key === "Enter" && query.trim()) {
                    event.preventDefault();
                    void invite();
                  }
                }}
              />
            </div>
            <button type="button" className="btn btn--outline" disabled={busy} onClick={(event) => setRoleAnchor(rectOf(event.currentTarget))}>
              {roleLabel(role)}<ChevronDown size={13} />
            </button>
            <button type="button" className="btn btn--primary" onClick={() => void invite()} disabled={busy || !query.trim()}>
              {busy ? "Inviting…" : "Invite"}
            </button>
          </div>
        ) : (
          <p className="share__note">{library?.archived ? "知识库已归档，暂不能邀请新成员。" : "Only the owner and people with Full access can invite others."}</p>
        )}

        {error ? <div className="share__error" role="alert">{error}</div> : null}

        <section className="share__section">
          <h2>{library ? "成员" : "成员共享"}</h2>
          {!library ? <p className="share__note">受邀者接受后成为协作者。</p> : null}
          {members.map((member) => {
            const name = personName(member);
            const you = member.id === me?.id;
            return (
              <div className="share__member" key={member.id}>
                <ProfileAvatar src={member.avatarUrl} name={name} size={32} />
                <span className="share__member-identity">
                  <strong>{name}{you ? <span className="share__you"> (you)</span> : null}</strong>
                  <small>@{member.handle}</small>
                </span>
                {manageable(member) ? (
                  <button type="button" className="btn" disabled={busy} onClick={(event) => setMemberMenu({ member, anchor: rectOf(event.currentTarget) })}>
                    {roleLabel(member.role)}<ChevronDown size={13} />
                  </button>
                ) : (
                  <span className="share__role">{roleLabel(member.role)}</span>
                )}
              </div>
            );
          })}
        </section>

        {invitations.length ? (
          <section className="share__section">
            <h2>Invited</h2>
            {invitations.map((invitation) => (
              <div className="share__member" key={invitation.id}>
                <ProfileAvatar src={invitation.invitee.avatarUrl} name={personName(invitation.invitee)} size={32} />
                <span className="share__member-identity">
                  <strong>{personName(invitation.invitee)}</strong>
                  <small>@{invitation.invitee.handle} · {roleLabel(invitation.role).toLowerCase()} · {daysLeft(invitation.expiresAt)}</small>
                </span>
                <span className="share__invitation-actions">
                  <span className="share__pending">Waiting to accept</span>
                  {canRevoke(invitation) ? <button type="button" className="btn" disabled={busy}
                    aria-label={`撤销对 @${invitation.invitee.handle} 的邀请`} onClick={() => void revokeInvitation(invitation)}>撤销邀请</button> : null}
                </span>
              </div>
            ))}
          </section>
        ) : null}

        {myRole === "owner" && !library ? <PublicLinks key={page.id} pageId={page.id} /> : null}
        {myRole === "owner" && library ? <p className="share__note">如需退出，请先在知识库设置中移交所有权。</p> : null}
      </div>

      <footer className="share__access">
        <button
          type="button"
          className="btn btn--outline"
          onClick={() => copyPageLink(page.id)}
        >
          <Copy size={14} />Copy link
        </button>
      </footer>

      {canLeave || canStop ? (
        <div className="share__exit">
          {confirming ? (
            <>
              <span className="share__exit-copy">
                {confirming === "stop"
                  ? "Everyone else loses access, and the page comes back to your private pages."
                  : library ? `退出后，你将失去「${space.name}」的全部访问权限。` : "You will lose access to this page and every page inside it."}
              </span>
              <button type="button" className="btn" onClick={() => setConfirming(null)} disabled={busy}>Cancel</button>
              <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void (confirming === "stop" ? stop() : leave())}>
                {confirming === "stop" ? "Stop sharing" : library ? "确认退出" : "Leave"}
              </button>
            </>
          ) : canStop ? (
            <button type="button" className="btn share__exit-button" onClick={() => setConfirming("stop")}>
              <Lock size={14} />Stop sharing
            </button>
          ) : (
            <button type="button" className="btn share__exit-button" onClick={() => setConfirming("leave")}>
              <LogOut size={14} />{library ? "退出知识库" : "Leave this page"}
            </button>
          )}
        </div>
      ) : null}

      <Popover
        open={resultsOpen}
        anchor={suggestAnchor}
        placement="bottom-start"
        gap={4}
        role="presentation"
        label="People"
        onDismiss={() => setSuggestDismissed(true)}
      >
        {suggestions.length ? (
          <div
            className="share__suggestions"
            role="listbox"
            aria-label="People"
            style={{ width: suggestAnchor?.width }}
          >
            {suggestions.slice(0, 5).map((suggestion, index) => (
              <button
                type="button"
                key={suggestion.id}
                role="option"
                aria-selected={index === activeIndex}
                className={`share__suggestion${index === activeIndex ? " share__suggestion--active" : ""}`}
                disabled={busy}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => void invite(suggestion.handle)}
              >
                <ProfileAvatar src={suggestion.avatarUrl} name={personName(suggestion)} size={24} />
                <span className="share__member-identity">
                  <strong>{personName(suggestion)}</strong>
                  <small>@{suggestion.handle}</small>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="share__note share__suggestions-empty" style={{ width: suggestAnchor?.width }}>
            没有匹配的用户，请核对用户名后重试。
          </p>
        )}
      </Popover>

      <Popover
        open={Boolean(roleAnchor) && canInvite}
        anchor={roleAnchor}
        placement="bottom-end"
        label="Invite as"
        onDismiss={() => setRoleAnchor(null)}
      >
        <MenuList label="Invite as" autoFocus>
          {ROLES.filter((option) => option.value !== "admin" || myRole === "owner").map((option) => (
            <MenuItem
              key={option.value}
              label={option.label}
              selected={role === option.value}
              disabled={busy || !canInvite}
              onSelect={() => { setRole(option.value); setRoleAnchor(null); }}
            />
          ))}
        </MenuList>
      </Popover>

      <Popover
        open={Boolean(memberMenu && managedMember && manageable(managedMember))}
        anchor={memberMenu?.anchor ?? null}
        placement="bottom-end"
        label="Change access"
        onDismiss={() => setMemberMenu(null)}
      >
        {managedMember && manageable(managedMember) ? (
          <MenuList label="Change access" autoFocus>
            {canManageRoles ? ROLES.map((option) => {
              const Icon = option.icon;
              const current = managedMember.role === option.value;
              return (
                <MenuItem
                  key={option.value}
                  icon={<Icon size={16} />}
                  label={option.label}
                  selected={current}
                  disabled={busy || (option.value === "admin" && myRole !== "owner")}
                  onSelect={() => void changeRole(managedMember, option.value)}
                />
              );
            }) : null}
            {canManageRoles && canRemove ? <MenuDivider /> : null}
            {canRemove ? (
              <MenuItem
                icon={<Trash2 size={16} />}
                label="Remove"
                tone="danger"
                disabled={busy}
                onSelect={() => void removeMember(managedMember)}
              />
            ) : null}
          </MenuList>
        ) : null}
      </Popover>
    </Modal>
  );
}
