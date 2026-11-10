import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from "react";
import { rectOf, useAnchoredPosition, type AnchorRect } from "../hooks/useAnchoredPosition";
import { imeComposing } from "../core/keyboard";
import styles from "./Select.module.css";

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  content?: ReactNode;
  group?: string;
  disabled?: boolean;
}

export type SelectProps<T extends string> = Omit<ComponentProps<"button">, "children" | "value" | "defaultValue" | "onChange" | "name" | "type" | "ref"> & {
  value: T;
  options: readonly SelectOption<T>[];
  onValueChange: (value: NoInfer<T>) => void;
  name?: string;
  placeholder?: string;
  size?: "standard" | "field" | "compact";
  variant?: "default" | "ghost" | "cell";
};

function revealOption(list: HTMLElement | null, id: string) {
  const item = document.getElementById(id);
  if (!list?.matches(":popover-open") || !item) return;
  const top = item.offsetTop;
  const bottom = top + item.offsetHeight;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}

/** One controlled choice. The native top layer keeps nested lists visible. */
export function Select<const T extends string>({
  value, options, onValueChange, name, placeholder = "选择…", size = "standard", variant = "default",
  id, className = "", disabled = false, onClick, onKeyDown, ...props
}: SelectProps<T>) {
  const generated = useId();
  const triggerId = id ?? `select-${generated}`;
  const listId = `${triggerId}-list`;
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const [active, setActive] = useState(0);
  const search = useRef({ text: "", at: 0 });
  const enabled = options.flatMap((option, index) => option.disabled ? [] : [index]);
  const inactive = disabled || !enabled.length;
  const selected = options.find((option) => option.value === value);
  const open = Boolean(anchor);
  const { style, placement } = useAnchoredPosition(popup, anchor, "bottom-start", 5);
  const groups: Array<{ label?: string; items: Array<{ option: SelectOption<T>; index: number }> }> = [];
  options.forEach((option, index) => {
    const last = groups.at(-1);
    if (last && last.label === option.group) last.items.push({ option, index });
    else groups.push({ label: option.group, items: [{ option, index }] });
  });

  const close = (restoreFocus = false) => {
    popup.current?.hidePopover();
    setAnchor(null);
    search.current.text = "";
    if (restoreFocus && !inactive) trigger.current?.focus({ preventScroll: true });
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled || inactive) return;
    // Keep history ownership on the field before the caller saves its value.
    close(true);
    if (option.value !== value) onValueChange(option.value);
  };

  useLayoutEffect(() => {
    if (open) revealOption(popup.current, `${listId}-${active}`);
  }, [active, listId, open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      if (event.type === "scroll" && event.target instanceof Node && popup.current?.contains(event.target)) return;
      popup.current?.hidePopover();
      setAnchor(null);
    };
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open]);

  useEffect(() => {
    if (inactive) {
      popup.current?.hidePopover();
      setAnchor(null);
    }
  }, [inactive]);

  const keys = (event: KeyboardEvent<HTMLButtonElement>) => {
    onKeyDown?.(event);
    const expanded = popup.current?.matches(":popover-open") ?? false;
    if (event.defaultPrevented || imeComposing(event) || inactive) return;
    if (event.key === "Tab" && expanded) {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Escape" && expanded) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      if (!expanded) {
        trigger.current?.click();
        if (event.key === "Home") setActive(enabled[0]);
        if (event.key === "End") setActive(enabled.at(-1)!);
      } else if (event.key === "Home") setActive(enabled[0]);
      else if (event.key === "End") setActive(enabled.at(-1)!);
      else {
        const position = enabled.indexOf(active);
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive(enabled[(position + step + enabled.length) % enabled.length]);
      }
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && expanded) {
      event.preventDefault();
      event.stopPropagation();
      choose(active);
      return;
    }
    if (event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      const now = performance.now();
      const letter = event.key.toLocaleLowerCase();
      const previous = now - search.current.at < 700 ? search.current.text : "";
      const text = previous === letter ? letter : previous + letter;
      search.current = { text, at: now };
      const current = expanded ? active : options.findIndex((option) => option.value === value);
      const start = enabled.indexOf(current) + (text.length === 1 ? 1 : 0);
      const ordered = [...enabled.slice(start), ...enabled.slice(0, start)];
      const match = ordered.find((index) => options[index].label.toLocaleLowerCase().startsWith(text));
      if (match !== undefined) {
        if (expanded) setActive(match);
        else if (options[match].value !== value) onValueChange(options[match].value);
      }
    }
  };

  return <span className={`${styles.root} ${className}`}>
    <button
      {...props}
      ref={trigger}
      id={triggerId}
      type="button"
      role="combobox"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={listId}
      aria-activedescendant={open ? `${listId}-${active}` : undefined}
      disabled={inactive}
      popoverTarget={listId}
      className={`${styles.trigger} ${styles[size]} ${styles[variant]}`}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || popup.current?.matches(":popover-open")) return;
        const index = options.findIndex((option) => option.value === value && !option.disabled);
        setActive(index >= 0 ? index : enabled[0]);
        search.current.text = "";
        // Native activation opens the list. Its toggle event sets the anchor.
      }}
      onKeyDown={keys}
    >
      <span className={`${styles.value} ${selected ? "" : styles.placeholder}`}>{selected?.content ?? selected?.label ?? placeholder}</span>
      <ChevronDown className={styles.chevron} size={14} aria-hidden="true" />
    </button>
    {name ? <input type="hidden" name={name} value={value} disabled={inactive} /> : null}
    <span
      ref={popup}
      id={listId}
      popover="auto"
      role="listbox"
      aria-label={props["aria-label"] ?? "选项"}
      aria-labelledby={props["aria-labelledby"]}
      className={styles.popup}
      data-placement={placement}
      style={{ ...style, visibility: open ? "visible" : "hidden", minWidth: Math.min(Math.max(anchor?.width ?? 0, 176), window.innerWidth - 16) }}
      onToggle={(event) => {
        if (!event.currentTarget.matches(":popover-open")) setAnchor(null);
        else if (trigger.current) {
          setAnchor(rectOf(trigger.current));
          revealOption(event.currentTarget, `${listId}-${active}`);
        }
      }}
    >
      {groups.map((group, groupIndex) => <span key={groupIndex} className={styles.group} role={group.label ? "group" : "presentation"} aria-label={group.label}>
        {group.label ? <span className={styles.groupLabel} aria-hidden="true">{group.label}</span> : null}
        {group.items.map(({ option, index }) => <span
          key={option.value}
          id={`${listId}-${index}`}
          role="option"
          aria-label={option.label}
          aria-selected={option.value === value}
          aria-disabled={option.disabled || undefined}
          className={`${styles.option} ${index === active ? styles.active : ""}`}
          onPointerDown={(event) => event.preventDefault()}
          onPointerMove={() => { if (!option.disabled) setActive(index); }}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); choose(index); }}
        >
          <span className={styles.optionLabel}>{option.content ?? option.label}</span>
          {option.value === value ? <Check size={14} aria-hidden="true" /> : null}
        </span>)}
      </span>)}
    </span>
  </span>;
}
