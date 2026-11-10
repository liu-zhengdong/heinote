import { Check } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

/** A menu list with roving focus. Notion's menus are fully keyboard-driven:
 *  the first item is pre-highlighted, Up/Down wraps, Enter runs the item and
 *  the mouse takes over the highlight the moment it moves. */
export function MenuList({
  children,
  className = "",
  label,
  autoFocus = false,
}: {
  children: ReactNode;
  className?: string;
  label?: string;
  /** Menus opened from a control take focus so the keyboard drives them
   *  immediately; menus that hang off a live caret must not. */
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(0);

  const items = useCallback(
    () => [...(ref.current?.querySelectorAll<HTMLButtonElement>("[data-menu-item]:not([disabled])") ?? [])],
    [],
  );

  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  useEffect(() => {
    const list = items();
    list.forEach((item, index) => item.classList.toggle("is-active", index === active));
    list[active]?.scrollIntoView({ block: "nearest" });
  }, [active, children, items]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    if (!list.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => (index + delta + list.length) % list.length);
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      list[Math.min(active, list.length - 1)]?.click();
    }
  };

  return (
    <div
      ref={ref}
      className={`menu ${className}`}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerMove={(event) => {
        const item = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-menu-item]");
        if (!item) return;
        const index = items().indexOf(item);
        if (index >= 0) setActive(index);
      }}
    >
      {children}
    </div>
  );
}

export function MenuItem({
  icon,
  label,
  hint,
  description,
  tone,
  selected,
  disabled,
  onSelect,
}: {
  icon?: ReactNode;
  label: ReactNode;
  hint?: ReactNode;
  description?: string;
  tone?: "danger";
  selected?: boolean;
  disabled?: boolean;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      data-menu-item
      role="menuitem"
      className={`menu__item ${tone === "danger" ? "is-danger" : ""} ${selected ? "is-selected" : ""}`}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
    >
      {icon ? <span className="menu__icon">{icon}</span> : null}
      <span className="menu__copy">
        <span className="menu__label">{label}</span>
        {description ? <span className="menu__description">{description}</span> : null}
      </span>
      {hint ? <span className="menu__hint">{hint}</span> : null}
      {!hint && selected ? <span className="menu__hint"><Check size={14} /></span> : null}
    </button>
  );
}

export function MenuDivider() {
  return <div className="menu__divider" role="separator" />;
}
