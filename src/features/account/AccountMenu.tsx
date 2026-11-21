import { Settings } from "lucide-react";
import { useRef } from "react";
import { Tooltip } from "../../components/Tooltip";
import { useUi } from "../../app/ui-context";
import { useSession } from "./AuthGate";

export function AccountSettingsButton({ onOpen }: { onOpen?(): void } = {}) {
  const { user } = useSession();
  const { accountSettingsOpen, openAccountSettings } = useUi();
  const trigger = useRef<HTMLButtonElement>(null);

  if (!user) return null;
  return (
    <Tooltip label="设置" placement="top-start">
      <button
        ref={trigger}
        type="button"
        className="icon-btn"
        aria-label="设置"
        aria-haspopup="dialog"
        aria-expanded={accountSettingsOpen}
        onClick={(event) => {
          event.currentTarget.focus();
          onOpen?.();
          openAccountSettings(null);
        }}
      >
        <Settings size={16} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}
