import { Image as ImageIcon, Shuffle, Trash2, Upload } from "lucide-react";
import { useMemo, useRef, useState, type DragEvent } from "react";
import { Popover } from "../../components/Popover";
import { useWorkspace } from "../../app/workspace-context";
import type { AnchorRect } from "../../hooks/useAnchoredPosition";
import { EMOJI_GROUPS, EMOJI_INDEX } from "./emoji-data";
import { COVERS, randomEmoji } from "./page-decoration";
import { IconImage, recentIcons, rememberIcon, type RecentIcon } from "./PageIcon";

type Tab = "emoji" | "cover";

export function IconPicker({
  anchor,
  tab,
  current,
  onPick,
  onUpload,
  onRemove,
  onClose,
  label,
}: {
  anchor: AnchorRect;
  tab: Tab;
  label?: string;
  /** What is chosen: an emoji, a cover's id, or "upload" for a picture from
   *  the computer. */
  current?: string;
  onPick(value: string): void;
  /** A picture from the computer — an icon's or a cover's. Given for an
   *  emoji tab, the picker offers Notion's Emoji | Upload tabs; for a cover,
   *  Gallery | Upload. */
  onUpload?(file: File): void;
  onRemove(): void;
  onClose(): void;
}) {
  return (
    <Popover open anchor={anchor} placement="bottom-start" role="dialog" label={label ?? (tab === "emoji" ? "Page icon" : "Page cover")} onDismiss={onClose}>
      <div className="picker">
        {tab === "emoji"
          ? <EmojiPicker current={current} onPick={onPick} onUpload={onUpload} onRemove={onRemove} />
          : <CoverPicker current={current} onPick={onPick} onUpload={onUpload} onRemove={onRemove} />}
      </div>
    </Popover>
  );
}

/** Which groups a name matches: a query looks in an emoji's own keywords
 *  (Chinese and English labels and tags), its group's name, and the emoji
 *  itself. */
function matches(query: string): (entry: { e: string; k: string }) => boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return () => true;
  return (entry) => entry.e === needle || entry.k.includes(needle);
}

function EmojiPicker({ current, onPick, onUpload, onRemove }: {
  current?: string;
  onPick(value: string): void;
  onUpload?(file: File): void;
  onRemove(): void;
}) {
  const { platform } = useWorkspace();
  const account = platform?.bootstrap.user.id;
  const [source, setSource] = useState<"emoji" | "upload">("emoji");
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState<RecentIcon[]>(() => recentIcons(account));

  const pick = (emoji: string) => {
    setRecents(rememberIcon(account, emoji));
    onPick(emoji);
  };

  /* The groups as drawn: every emoji but the skin variants, which the list
   *  holds for search only — Notion lists a base face once too. A query
   *  shows what it matches, variants among them, under the groups they
   *  belong to. */
  const groups = useMemo(() => {
    const hit = matches(query);
    return EMOJI_GROUPS
      .map((group) => ({ ...group, emoji: group.emoji.filter((entry) => !entry.t && hit(entry)) }))
      .filter((group) => group.emoji.length);
  }, [query]);
  const searched = useMemo(() => {
    if (!query.trim()) return null;
    const hit = matches(query);
    return EMOJI_INDEX.filter(hit);
  }, [query]);
  const shown = searched ?? groups.flatMap((group) => group.emoji);

  const tabs = onUpload ? (["emoji", "upload"] as const) : (["emoji"] as const);

  return (
    <>
      <div className="picker__tabs">
        <span className="picker__tab-group" role="tablist" aria-label="Icon from">
          {tabs.map((item) => (
            <button
              type="button"
              key={item}
              role="tab"
              aria-selected={source === item}
              className={`picker__tab ${source === item ? "is-active" : ""}`}
              onClick={() => setSource(item)}
            >
              {item === "emoji" ? "Emoji" : "Upload"}
            </button>
          ))}
        </span>
        <span className="picker__headactions">
          <button type="button" className="icon-btn" aria-label="Random icon" title="Random icon" onClick={() => pick(randomEmoji())}>
            <Shuffle size={15} />
          </button>
          {current ? (
            <button type="button" className="icon-btn" aria-label="Remove" title="Remove" onClick={onRemove}>
              <Trash2 size={15} />
            </button>
          ) : null}
        </span>
      </div>
      {source === "upload" ? (
        <UploadPane onUpload={onUpload} hint="Or drop a picture here. It becomes the page's icon; up to 7.5 MB." inputLabel="Icon picture" />
      ) : (
        <>
          <div className="picker__head">
            <input
              autoFocus
              value={query}
              placeholder="Filter…"
              aria-label="Filter icons"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="picker__body">
            {searched ? null : (
              <div className="picker__cats">
                {groups.map((group, index) => (
                  <button
                    type="button"
                    key={group.name}
                    className="picker__cat"
                    onClick={() => document.getElementById(`picker-group-${index}`)?.scrollIntoView({ block: "start" })}
                  >
                    {group.emoji[0]?.e} {group.name}
                  </button>
                ))}
              </div>
            )}
            {searched ? null : recents.length ? (
              <>
                <div className="picker__group-title">Recently used</div>
                <div className="picker__grid">
                  {recents.map((item) => item.k === "e" ? (
                    <button type="button" key={`e${item.v}`} className="picker__cell" aria-label={item.v} onClick={() => pick(item.v)}>
                      {item.v}
                    </button>
                  ) : (
                    <button type="button" key={`f${item.f.path}`} className="picker__cell picker__cell--img" aria-label={item.f.name}
                      onClick={() => onPick(`file:${item.f.path}`)}>
                      <IconImage file={item.f} size={20} fallback={<ImageIcon size={16} />} />
                    </button>
                  ))}
                </div>
              </>
            ) : null}
            {searched ? (
              <div className="picker__grid">
                {shown.slice(0, 400).map((entry) => (
                  <button type="button" key={entry.e} className="picker__cell" aria-label={entry.e} onClick={() => pick(entry.e)}>
                    {entry.e}
                  </button>
                ))}
              </div>
            ) : (
              groups.map((group, index) => (
                <div key={group.name} id={`picker-group-${index}`} className="picker__group">
                  <div className="picker__group-title">{group.en}</div>
                  <div className="picker__grid">
                    {group.emoji.map((entry) => (
                      <button type="button" key={entry.e} className="picker__cell" aria-label={entry.e} onClick={() => pick(entry.e)}>
                        {entry.e}
                      </button>
                    ))}
                  </div>
                </div>
              ))
            )}
            {shown.length ? null : <div className="slash__empty">No icons match “{query}”</div>}
          </div>
        </>
      )}
    </>
  );
}

/** A picture from the computer, picked or dropped — the same pane an icon
 *  and a cover take. */
function UploadPane({ onUpload, hint, inputLabel }: { onUpload?(file: File): void; hint: string; inputLabel: string }) {
  const [dropping, setDropping] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const take = (file: File | undefined) => {
    if (file) onUpload?.(file);
  };
  return (
    <div
      className={`picker__upload ${dropping ? "is-dropping" : ""}`}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        event.stopPropagation();
        setDropping(false);
        take(event.dataTransfer.files[0]);
      }}
    >
      <button type="button" className="btn btn--outline picker__upload-button" autoFocus onClick={() => fileInput.current?.click()}>
        <Upload size={14} />Upload file
      </button>
      <p className="picker__hint">{hint}</p>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        aria-label={inputLabel}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          take(file);
        }}
      />
    </div>
  );
}

/** Notion's cover picker: Gallery (the gradients) and Upload (a picture from
 *  the computer, picked or dropped), Remove beside them. */
function CoverPicker({
  current,
  onPick,
  onUpload,
  onRemove,
}: {
  current?: string;
  onPick(value: string): void;
  onUpload?(file: File): void;
  onRemove(): void;
}) {
  const [source, setSource] = useState<"gallery" | "upload">("gallery");
  const sources = onUpload ? (["gallery", "upload"] as const) : (["gallery"] as const);

  return (
    <>
      <div className="picker__tabs">
        <span className="picker__tab-group" role="tablist" aria-label="Cover from">
          {sources.map((item) => (
            <button
              type="button"
              key={item}
              role="tab"
              aria-selected={source === item}
              className={`picker__tab ${source === item ? "is-active" : ""}`}
              onClick={() => setSource(item)}
            >
              {item === "gallery" ? "Gallery" : "Upload"}
            </button>
          ))}
        </span>
        {current ? <button type="button" className="picker__remove" onClick={onRemove}>Remove</button> : null}
      </div>
      {source === "gallery" ? (
        <div className="picker__covers">
          {COVERS.map((cover) => (
            <button
              type="button"
              key={cover.id}
              className={`picker__cover ${current === cover.id ? "is-selected" : ""}`}
              style={{ background: cover.background }}
              aria-label={cover.name}
              onClick={() => onPick(cover.id)}
            />
          ))}
        </div>
      ) : (
        <UploadPane onUpload={onUpload} hint="Or drop a picture here. Wider than 1500 pixels works best; up to 7.5 MB." inputLabel="Cover picture" />
      )}
    </>
  );
}
