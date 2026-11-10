import { RotateCcw, X } from "lucide-react";
import { imeComposing } from "../../core/keyboard";
import { useEffect, useMemo, useState } from "react";
import { useMountTransition } from "../../hooks/useMountTransition";
import type { NotePage, PageVersion } from "../../core/types";
import { useWorkspace } from "../../app/workspace-context";
import { useUi } from "../../app/ui-context";
import { useWorkspaceState } from "../../app/workspace-store";
import { isCurrent, versionList } from "../../core/versions";
import { personName, ProfileAvatar } from "../../components/ProfileAvatar";

const PANEL_EXIT_MS = 320;

/** What a checkpoint says of itself, when it says more than that the page
 *  was edited — which every one of them was. */
const PLAIN_SUMMARY = "Edited page";

function time(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function dayGroup(value: string): string {
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric" }).format(date);
}

/** A page's history, as one list: the page as it is now on top, then each
 *  checkpoint before it, newest first, by its time and who wrote it. Picking
 *  one shows it in the page; Restore brings it back. A checkpoint that is the
 *  page now is the current version, not a row of its own. */
export function HistoryPanel({
  pageId,
  open,
  onClose,
  onPreview,
}: {
  /** The page whose history it is: the page open, if there is one. */
  pageId: string | null;
  open: boolean;
  onClose(): void;
  onPreview(page: NotePage | null): void;
}) {
  const { restoreVersion, rosters } = useWorkspace();
  const { toast } = useUi();
  const { mounted, shown } = useMountTransition(open && Boolean(pageId), PANEL_EXIT_MS);
  const page = useWorkspaceState((state) => (pageId ? state.pages[pageId] : undefined));
  const stored = useWorkspaceState((state) => (pageId ? state.versions[pageId] : undefined));
  const versions = useMemo(() => {
    const all = versionList(stored);
    const latest = all.at(-1);
    return latest && page && isCurrent(latest, page) ? all.slice(0, -1) : all;
  }, [page, stored]);
  /* The checkpoint picked, or "" for the page as it is. */
  const [selectedId, setSelectedId] = useState("");
  const selected = versions.find((version) => version.id === selectedId);

  // It opens on the page as it is.
  useEffect(() => {
    if (open) setSelectedId("");
  }, [open, pageId]);

  useEffect(() => {
    onPreview(open ? selected?.snapshot ?? null : null);
  }, [onPreview, open, selected]);

  const groups = useMemo(() => {
    const result = new Map<string, PageVersion[]>();
    for (const version of versions.toReversed()) {
      const key = dayGroup(version.created_at);
      result.set(key, [...(result.get(key) ?? []), version]);
    }
    return [...result.entries()];
  }, [versions]);

  const member = (userId: string) => Object.values(rosters).flatMap((space) => space.members).find((item) => item.id === userId);

  /* Escape closes it, like every other layer in the app. Without this the only
     way out of the panel is the mouse, which is a strange thing to say about a
     surface you reach from a keyboard-driven menu. */
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || imeComposing(event)) return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!mounted || !pageId) return null;

  return (
    <>
      <button className={`panel__scrim ${shown ? "is-shown" : ""}`} aria-label="Close page history" onClick={onClose} />
      <aside className={`panel ${shown ? "is-shown" : ""}`} aria-label="Page history">
        <header className="panel__head">
          <h2>Page history</h2>
          <button type="button" className="icon-btn" aria-label="Close page history" onClick={onClose}>
            <X size={17} />
          </button>
        </header>

        <div className="panel__body scroller" role="listbox" aria-label="Versions">
          <button
            type="button"
            role="option"
            aria-selected={!selected}
            className={`history-item history-item--current ${selected ? "" : "is-selected"}`}
            onClick={() => setSelectedId("")}
          >
            <span className="history-item__time">Current version</span>
          </button>
          {groups.map(([group, items]) => (
            <section className="history-group" key={group}>
              <h3>{group}</h3>
              {items.map((version) => {
                const author = member(version.author_id);
                const name = author ? personName(author) : version.author_name;
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected?.id === version.id}
                    key={version.id}
                    className={`history-item ${selected?.id === version.id ? "is-selected" : ""}`}
                    onClick={() => setSelectedId(version.id)}
                  >
                    <span className="history-item__line">
                      <span className="history-item__time">{time(version.created_at)}</span>
                      <span className="history-item__author">
                        <ProfileAvatar src={author?.avatarUrl} name={name} size={16} />
                        <span>{name}</span>
                      </span>
                    </span>
                    {version.summary && version.summary !== PLAIN_SUMMARY ? (
                      <small className="history-item__summary">{version.summary}</small>
                    ) : null}
                  </button>
                );
              })}
            </section>
          ))}
        </div>

        <footer className="panel__foot">
          <button
            type="button"
            className="btn btn--primary"
            disabled={!selected}
            onClick={() => {
              if (!selected) return;
              restoreVersion(pageId, selected);
              toast("Version restored", "success");
              onClose();
            }}
          >
            <RotateCcw size={15} />Restore
          </button>
        </footer>
      </aside>
    </>
  );
}
