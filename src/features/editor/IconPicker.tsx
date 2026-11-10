import { Shuffle, Trash2, Upload } from "lucide-react";
import { useMemo, useRef, useState, type DragEvent } from "react";
import { Popover } from "../../components/Popover";
import type { AnchorRect } from "../../hooks/useAnchoredPosition";
import { COVERS, EMOJI_GROUPS, randomEmoji } from "./page-decoration";

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
  /** A picture from the computer, for a cover: Notion's Upload tab beside
   *  the gallery, offered when given. */
  onUpload?(file: File): void;
  onRemove(): void;
  onClose(): void;
}) {
  return (
    <Popover open anchor={anchor} placement="bottom-start" role="dialog" label={label ?? (tab === "emoji" ? "Page icon" : "Page cover")} onDismiss={onClose}>
      <div className="picker">
        {tab === "emoji"
          ? <EmojiPicker current={current} onPick={onPick} onRemove={onRemove} />
          : <CoverPicker current={current} onPick={onPick} onUpload={onUpload} onRemove={onRemove} />}
      </div>
    </Popover>
  );
}

function EmojiPicker({ current, onPick, onRemove }: { current?: string; onPick(value: string): void; onRemove(): void }) {
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return EMOJI_GROUPS.map((group) => ({ ...group, emoji: [...group.emoji] }));
    return EMOJI_GROUPS
      .map((group) => ({
        ...group,
        emoji: group.name.toLowerCase().includes(normalized) ? [...group.emoji] : [],
      }))
      .filter((group) => group.emoji.length);
  }, [query]);

  return (
    <>
      <div className="picker__head">
        <input
          autoFocus
          value={query}
          placeholder="Filter…"
          aria-label="Filter icons"
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="button" className="icon-btn" aria-label="Random icon" onClick={() => onPick(randomEmoji())}>
          <Shuffle size={15} />
        </button>
        {current ? (
          <button type="button" className="icon-btn" aria-label="Remove" onClick={onRemove}>
            <Trash2 size={15} />
          </button>
        ) : null}
      </div>

      <div className="picker__body">
        {groups.map((group) => (
          <div key={group.name}>
            <div className="picker__group-title">{group.name}</div>
            <div className="picker__grid">
              {group.emoji.map((emoji) => (
                <button
                  type="button"
                  key={emoji}
                  className="picker__cell"
                  aria-label={emoji}
                  onClick={() => onPick(emoji)}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        ))}
        {groups.length ? null : <div className="slash__empty">No icons match “{query}”</div>}
      </div>
    </>
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
  const [dropping, setDropping] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const take = (file: File | undefined) => {
    if (file) onUpload?.(file);
  };
  const drop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDropping(false);
    take(event.dataTransfer.files[0]);
  };
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
        <div
          className={`picker__upload ${dropping ? "is-dropping" : ""}`}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            setDropping(true);
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={drop}
        >
          <button type="button" className="btn btn--outline picker__upload-button" autoFocus onClick={() => fileInput.current?.click()}>
            <Upload size={14} />Upload file
          </button>
          <p className="picker__hint">Or drop a picture here. Wider than 1500 pixels works best; up to 7.5 MB.</p>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            hidden
            aria-label="Cover picture"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              take(file);
            }}
          />
        </div>
      )}
    </>
  );
}
