import { CalendarDays, Plus } from "lucide-react";
import { useEffect, useRef } from "react";
import { dateLabel } from "../../core/inline-content";
import { pageGlyph } from "./block-registry";
import type { MentionItem } from "./mentions";

/** The menu `@` and `[[` open: pages to mention (and, for `[[`, blocks), dates,
 *  and a new page by the name typed. The keyboard stays in the text — the editor moves the active
 *  row — so typing on keeps narrowing it, as in Notion. */
export function MentionMenu({
  trigger,
  items,
  activeIndex,
  onSelect,
}: {
  trigger: "@" | "[[";
  items: MentionItem[];
  activeIndex: number;
  onSelect(item: MentionItem): void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listRef.current?.querySelector(`[data-mention-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!items.length) {
    return <div className="menu slash mention-menu"><div className="slash__empty">No pages found</div></div>;
  }
  const sections = [
    { title: "Pages", items: items.filter((item) => item.kind === "page") },
    { title: "Date", items: items.filter((item) => item.kind === "date") },
    { title: "", items: items.filter((item) => item.kind === "new") },
  ].filter((section) => section.items.length);

  return (
    <div ref={listRef} className="menu slash mention-menu" role="listbox" aria-label={trigger === "[[" ? "Link to a page" : "Mention"}>
      {sections.map((section) => (
        <div className="menu__section" key={section.title || "new"}>
          {section.title ? <div className="menu__section-title">{section.title}</div> : null}
          {section.items.map((item) => {
            const index = items.indexOf(item);
            return (
              <button
                type="button"
                key={item.key}
                role="option"
                aria-selected={index === activeIndex}
                data-mention-index={index}
                className={`menu__item ${index === activeIndex ? "is-active" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelect(item)}
              >
                {item.kind === "page" ? (
                  <>
                    <span className="menu__icon">{pageGlyph(item.page, 17)}</span>
                    <span className="menu__copy">
                      <span className="menu__label">{item.name}</span>
                      {item.context ? <span className="menu__description">in {item.context}</span> : null}
                    </span>
                  </>
                ) : item.kind === "date" ? (
                  <>
                    <span className="menu__icon"><CalendarDays size={17} /></span>
                    <span className="menu__copy">
                      <span className="menu__label">{item.label}</span>
                      <span className="menu__description">{dateLabel(item.date)}</span>
                    </span>
                  </>
                ) : (
                  <>
                    <span className="menu__icon"><Plus size={17} /></span>
                    <span className="menu__copy">
                      <span className="menu__label">New page “{item.title}”</span>
                      <span className="menu__description">Inside this page</span>
                    </span>
                  </>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
