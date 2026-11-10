import { useState, type CSSProperties } from "react";
import type { Person } from "../core/types";
import { Avatar } from "./Avatar";

/** A member's own profile picture, from Terminus — `src` is the person's
 *  `avatarUrl`, which changes when their picture does — or, when they have
 *  none (or it cannot be loaded), their initials in a colour of their own. */
export function ProfileAvatar({
  src,
  name,
  size = 20,
  online,
}: {
  src?: string | null;
  name: string;
  size?: number;
  /** Draws the green dot of someone here now. */
  online?: boolean;
}) {
  /* The address that could not be loaded: a new picture (a new address)
     is tried again. */
  const [failed, setFailed] = useState<string | null>(null);
  if (!src || failed === src) return <Avatar name={name} size={size} online={online} />;
  if (online) {
    return (
      <span className="avatar avatar--framed" style={{ "--avatar-size": `${size}px` } as CSSProperties} title={name}>
        <ProfileAvatar src={src} name={name} size={size} />
        <span className="avatar__presence" aria-label="Online" />
      </span>
    );
  }
  return (
    <img
      className="avatar avatar--photo"
      src={src}
      width={size}
      height={size}
      alt={name}
      title={name}
      draggable={false}
      style={{ "--avatar-size": `${size}px` } as CSSProperties}
      onError={() => setFailed(src)}
    />
  );
}

/** How a member is named when all Terminus gives is their handle. */
export function memberName(handle: string): string {
  return handle
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ") || handle;
}

/** What to call someone: the name they go by — or, when Terminus has none
 *  for them, their handle dressed as one. */
export function personName(person: Pick<Person, "handle" | "displayName">): string {
  return person.displayName.trim() || memberName(person.handle);
}
