export interface RecoveryDraft {
  id?: string;
  message: string;
  writes?: unknown[];
  documents?: unknown[];
  batches?: unknown[];
  createdAt?: string;
}
export interface RecoveryEntry extends RecoveryDraft { id: string; createdAt: string; persisted: boolean }
const memory = new Map<string, RecoveryEntry[]>();
const key = (userId: string) => `notes:recovery:${userId}`;
/** True once the document starts navigating away (reload, close). Requests
 *  still in flight abort with "Failed to fetch" on the way out; none of that
 *  is a save failure worth a modal draft. Real batch payloads stay in the
 *  journal and replay after the reload. A bfcache restore clears the flag. */
let closing = false;
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => { closing = true; });
  window.addEventListener("unload", () => { closing = true; });
  window.addEventListener("pageshow", (event) => { if (event.persisted) closing = false; });
}
export function navigationClosing(): boolean { return closing; }
export function getRecovery(userId: string): RecoveryEntry[] {
  if (!userId) return [];
  let saved: RecoveryEntry[] = [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key(userId)) ?? "[]");
    if (Array.isArray(parsed)) saved = parsed.filter((entry): entry is RecoveryEntry => Boolean(entry && typeof entry === "object" && typeof entry.id === "string" && typeof entry.message === "string"));
  } catch { /* Keep in-memory drafts when storage is unavailable. */ }
  const entries = new Map(saved.map((entry) => [entry.id, entry]));
  for (const entry of memory.get(userId) ?? []) entries.set(entry.id, entry);
  return [...entries.values()];
}
export function addRecovery(userId: string, draft: RecoveryDraft): RecoveryEntry {
  const entry: RecoveryEntry = { ...draft, id: draft.id ?? crypto.randomUUID(), createdAt: draft.createdAt ?? new Date().toISOString(), persisted: false };
  if (!userId || closing) return entry;
  const entries = new Map(getRecovery(userId).map((entry) => [entry.id, entry])); entries.set(entry.id, entry);
  try {
    localStorage.setItem(key(userId), JSON.stringify([...entries.values()].map((entry) => ({ ...entry, persisted: true }))));
    for (const saved of entries.values()) saved.persisted = true;
  } catch { /* The recovery UI offers an immediate download. */ }
  memory.set(userId, [...entries.values()]);
  window.dispatchEvent(new CustomEvent("notes:recovery-changed", { detail: { userId } }));
  return entry;
}
export function clearRecovery(userId: string): void {
  memory.delete(userId);
  try { localStorage.removeItem(key(userId)); } catch { /* Memory remains cleared. */ }
  window.dispatchEvent(new CustomEvent("notes:recovery-changed", { detail: { userId } }));
}
export function publishRecovery(userId: string, draft: RecoveryDraft): void {
  const entry = addRecovery(userId, draft);
  window.dispatchEvent(new CustomEvent("notes:save-refused", { detail: { ...entry, userId } }));
}
