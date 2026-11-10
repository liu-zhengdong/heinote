import type { CSSProperties } from "react";

const COLORS = ["#dd7359", "#4c8b7b", "#5578be", "#a567a9", "#b58a46"];

function hash(value: string): number {
  let total = 0;
  for (const character of value) total = (total * 31 + character.charCodeAt(0)) >>> 0;
  return total;
}

/** The colour a person is drawn in: their avatar's, their caret's. */
export const colorOf = (name: string) => COLORS[hash(name) % COLORS.length];

export function initials(name: string): string {
  return name
    .split(/[.\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "?";
}

export function Avatar({
  name,
  size = 26,
  online,
}: {
  name: string;
  size?: number;
  online?: boolean;
}) {
  const style = {
    "--avatar-size": `${size}px`,
    "--avatar-color": colorOf(name),
  } as CSSProperties;
  return (
    <span className="avatar" style={style} title={name} aria-label={name}>
      {initials(name)}
      {online === true ? <span className="avatar__presence" aria-label="Online" /> : null}
    </span>
  );
}
