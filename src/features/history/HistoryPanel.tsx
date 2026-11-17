import { LocateFixed, RotateCcw, X } from "lucide-react";
import { imeComposing } from "../../core/keyboard";
import { useEffect, useMemo, useState } from "react";
import { useMountTransition } from "../../hooks/useMountTransition";
import type { NotePage, PageEvent, PageVersion } from "../../core/types";
import { useWorkspace } from "../../app/workspace-context";
import { useUi } from "../../app/ui-context";
import { useWorkspaceState } from "../../app/workspace-store";
import { isCurrent, versionList } from "../../core/versions";
import { personName } from "../../components/ProfileAvatar";
import { AuthorAvatar } from "../../components/AgentMark";

const PANEL_EXIT_MS = 320;

/** What a checkpoint says of itself, when it says more than that the page
 *  was edited — which every one of them was. */
const PLAIN_SUMMARY = "Edited page";

/** How long the flash over the place an event touched stays. */
const FLASH_MS = 1600;

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

/** The timeline's two kinds of entries: a checkpoint you can preview and
 *  restore, and a committed edit you can locate on the page. */
type Entry =
  | { kind: "version"; at: string; version: PageVersion }
  | { kind: "event"; at: string; event: PageEvent };

/** Where an event's target is drawn: a block's caret host, a static row
 *  name, or — for the page itself — its title field. */
function targetElement(pageId: string, target: string): HTMLElement | null {
  const selector = target === pageId
    ? `[data-block-id="${CSS.escape(target)}"]`
    : `[data-block-id="${CSS.escape(target)}"], [data-block-name="${CSS.escape(target)}"]`;
  return document.querySelector<HTMLElement>(selector);
}

/** A page's history, as one list: the page as it is now on top, then its
 *  committed edits and checkpoints interleaved by time, each saying who
 *  made it. Picking a checkpoint shows it in the page; picking an edit
 *  flashes where it landed. A checkpoint that is the page now is the
 *  current version, not a row of its own. */
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
  const events = useWorkspaceState((state) => (pageId ? state.pageEvents[pageId] : undefined));
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

  /** The flash over where an edit landed. An event picked over a preview
   *  drops the preview first — the place it names is on the live page. */
  const locate = (event: PageEvent) => {
    if (!pageId) return;
    setSelectedId("");
    window.setTimeout(() => {
      for (const target of event.targets) {
        const element = targetElement(pageId, target);
        if (!element) continue;
        element.scrollIntoView({ block: "center", behavior: "smooth" });
        element.classList.add("history-flash");
        window.setTimeout(() => element.classList.remove("history-flash"), FLASH_MS);
        return;
      }
      toast("那次编辑的位置已不在页面上。", "info");
    }, 80);
  };

  const groups = useMemo(() => {
    const entries: Entry[] = [
      ...versions.map((version) => ({ kind: "version" as const, at: version.created_at, version })),
      ...Object.values(events ?? {}).map((event) => ({ kind: "event" as const, at: event.created_at, event })),
    ].sort((a, b) => b.at.localeCompare(a.at));
    const result = new Map<string, Entry[]>();
    for (const entry of entries) {
      const key = dayGroup(entry.at);
      result.set(key, [...(result.get(key) ?? []), entry]);
    }
    return [...result.entries()];
  }, [versions, events]);

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

  const authorOf = (authorId: string, name: string, avatarUrl: string | null | undefined) => {
    const author = member(authorId);
    return {
      name: name || (author ? personName(author) : "未知"),
      avatar: avatarUrl || author?.avatarUrl,
    };
  };

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
              {items.map((entry) => entry.kind === "version" ? (
                <VersionItem
                  key={`v-${entry.version.id}`}
                  version={entry.version}
                  selected={selected?.id === entry.version.id}
                  author={authorOf(entry.version.author_id, entry.version.author_name, entry.version.author_avatar_url)}
                  onPick={() => setSelectedId(entry.version.id)}
                />
              ) : (
                <EventItem
                  key={`e-${entry.event.id}`}
                  event={entry.event}
                  author={authorOf(entry.event.author_id, entry.event.author_name, entry.event.author_avatar_url)}
                  onPick={() => locate(entry.event)}
                />
              ))}
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

function VersionItem({ version, selected, author, onPick }: {
  version: PageVersion;
  selected: boolean;
  author: { name: string; avatar?: string | null };
  onPick(): void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={`history-item ${selected ? "is-selected" : ""}`}
      onClick={onPick}
    >
      <span className="history-item__line">
        <span className="history-item__time">{time(version.created_at)}</span>
        <span className="history-item__author">
          <AuthorAvatar src={author.avatar} name={author.name} size={16} />
          <span>{author.name}</span>
        </span>
      </span>
      {version.summary && version.summary !== PLAIN_SUMMARY ? (
        <small className="history-item__summary">{version.summary}</small>
      ) : null}
    </button>
  );
}

/** One committed edit: not an option — it previews nothing, it locates. */
function EventItem({ event, author, onPick }: {
  event: PageEvent;
  author: { name: string; avatar?: string | null };
  onPick(): void;
}) {
  return (
    <button type="button" className="history-item history-item--event" onClick={onPick}>
      <span className="history-item__line">
        <span className="history-item__time">{time(event.created_at)}</span>
        <span className="history-item__author">
          <AuthorAvatar src={author.avatar} name={author.name} size={16} />
          <span>{author.name}</span>
        </span>
      </span>
      <small className="history-item__summary history-item__label">
        <LocateFixed size={11} />
        {event.label}
        {event.merged > 1 ? ` · 合并了 ${event.merged} 次编辑` : null}
      </small>
    </button>
  );
}
