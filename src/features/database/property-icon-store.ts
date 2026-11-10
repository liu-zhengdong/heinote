import { useEffect, useSyncExternalStore } from "react";
import type { LucideIcon } from "lucide-react";

/* The marks a column can wear are a few hundred drawings, so they stay out
   of the bundle every window loads (as the code grammars do): the database's
   own chunk brings them and hands them over here as it loads (`provideIcons`,
   before its first table is drawn), and anything else that draws a column's
   mark first — a row's page in the side peek — asks for them here, drawing
   the type's own mark for the moment it takes. */

interface Registry {
  propertyIcon(key: unknown): LucideIcon | undefined;
}

let registry: Registry | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function provideIcons(loaded: Registry): void {
  if (registry) return;
  registry = loaded;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The mark a column was given, once the marks are here; undefined until
 *  then, and for a key this build does not know. */
export function useColumnIcon(key: string | undefined): LucideIcon | undefined {
  const loaded = useSyncExternalStore(subscribe, () => registry);
  const wanted = Boolean(key) && !loaded;
  useEffect(() => {
    if (wanted) loading ??= import("./property-icons").then(provideIcons);
  }, [wanted]);
  return loaded?.propertyIcon(key);
}
