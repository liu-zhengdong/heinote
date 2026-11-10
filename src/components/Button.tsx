import type { LucideIcon } from "lucide-react";
import type { ComponentProps } from "react";
import styles from "./Button.module.css";

export type ButtonProps = ComponentProps<"button"> & {
  icon?: LucideIcon;
  active?: boolean;
};

/** A quiet action button with shared typography and Lucide icon sizing. */
export function Button({
  icon: Icon,
  active = false,
  type = "button",
  className = "",
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={[styles.button, active ? styles.active : "", className].filter(Boolean).join(" ")}
    >
      {Icon ? <Icon size={14} strokeWidth={1.75} aria-hidden="true" /> : null}
      <span className={styles.label}>{children}</span>
    </button>
  );
}
