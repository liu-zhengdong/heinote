import { UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { personName, ProfileAvatar } from "../../components/ProfileAvatar";
import type { GithubResult } from "../../core/github-auth";
import { useSession } from "./AuthGate";
import { AccountSettings } from "./AccountSettings";

export function AccountMenu({ compact = false }: { compact?: boolean }) {
  const { user, githubOutcome, clearGithubOutcome } = useSession();
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<GithubResult | null>(null);

  // Show the completed OAuth result in the account's login-methods section.
  useEffect(() => {
    if (!user || !githubOutcome) return;
    setNotice(githubOutcome);
    setOpen(true);
    clearGithubOutcome();
  }, [user, githubOutcome, clearGithubOutcome]);

  if (!user) return null;
  return <div className={`account-entry${compact ? " account-entry--compact" : ""}`}>
    <button type="button" className="account-entry__button" aria-label={`账号：${personName(user)}`} title={`账号：${personName(user)}`}
      aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      {user.avatarUrl ? <ProfileAvatar src={user.avatarUrl} name={personName(user)} size={18} /> : <UserRound size={18} aria-hidden="true" />}
      <span className="account-entry__name">{personName(user)}</span>
    </button>
    {open ? <AccountSettings key={`${user.id}:${notice || "default"}`} notice={notice}
      onClose={() => { setOpen(false); setNotice(null); }} /> : null}
  </div>;
}
