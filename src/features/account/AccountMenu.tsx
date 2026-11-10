import { Settings } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Tooltip } from "../../components/Tooltip";
import type { GithubResult } from "../../core/github-auth";
import { useSession } from "./AuthGate";
import { AccountSettings } from "./AccountSettings";

export function AccountSettingsButton({ onOpen }: { onOpen?(): void } = {}) {
  const { user, githubOutcome, clearGithubOutcome } = useSession();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<GithubResult | null>(null);

  // Show the completed OAuth result in the account's login-methods section.
  useEffect(() => {
    if (!user || !githubOutcome) return;
    setNotice(githubOutcome);
    onOpen?.();
    setOpen(true);
    clearGithubOutcome();
  }, [user, githubOutcome, clearGithubOutcome, onOpen]);

  if (!user) return null;
  return <>
    <Tooltip label="设置" placement="top-start">
      <button ref={trigger} type="button" className="icon-btn" aria-label="设置"
        aria-haspopup="dialog" aria-expanded={open} onClick={(event) => { event.currentTarget.focus(); onOpen?.(); setOpen(true); }}>
        <Settings size={16} aria-hidden="true" />
      </button>
    </Tooltip>
    {open ? <AccountSettings key={`${user.id}:${notice || "default"}`} notice={notice}
      onClose={() => {
        setOpen(false);
        setNotice(null);
        if (trigger.current?.getClientRects().length && !trigger.current.closest("[inert]")) trigger.current.focus({ preventScroll: true });
      }} /> : null}
  </>;
}
