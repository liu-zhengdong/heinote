/** Per-account client-side IndexedDB mirror for warm delta hydration (UC-56).
 *  Caches `pages`, `workspace_settings`, and up to 20 recently opened `blocks`
 *  pages under [userId, scope, collection]. History collections stay network-only
 *  and all IDB failures degrade silently to pure network. */

export const MIRRORED_COLLECTIONS = new Set(["pages", "workspace_settings", "blocks"]);
export const MAX_CACHED_BLOCK_PAGES = 20;

const DB_NAME = "heinote-mirror";
const STORE_NAME = "collections";
const WRITE_DEBOUNCE_MS = 250;

export interface FullMirrorEntry {
  kind: "full";
  userId: string;
  scope: string;
  collection: string;
  epoch: string;
  latest: number;
  rows: Array<[string, unknown]>;
  updatedAt: number;
}

export interface BlocksMirrorEntry {
  kind: "blocks";
  userId: string;
  scope: string;
  collection: "blocks";
  epoch: string;
  pageWatermarks: Array<[string, number]>;
  pages: Record<string, Array<[string, unknown]>>;
  lru: string[];
  updatedAt: number;
}

export type MirrorEntry = FullMirrorEntry | BlocksMirrorEntry;
export type MirrorPayload =
  | Omit<FullMirrorEntry, "userId" | "scope" | "collection" | "updatedAt">
  | Omit<BlocksMirrorEntry, "userId" | "scope" | "collection" | "updatedAt">;

let activeUserId: string | null = null;
let dbPromise: Promise<IDBDatabase | null> | null = null;
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingEntries = new Map<string, MirrorEntry>();

const mirrorKey = (userId: string, scope: string, collection: string) => `${userId}\0${scope}\0${collection}`;

function openMirrorDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: ["userId", "scope", "collection"] });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => { dbPromise = null; resolve(null); };
      req.onblocked = () => { resolve(null); };
    } catch {
      dbPromise = null;
      resolve(null);
    }
  });
  return dbPromise;
}

/** Bind the active signed-in user id for all subsequent mirror reads and writes. */
export function setMirrorUser(userId: string | null): void {
  activeUserId = userId;
}

/** Read a previously persisted collection mirror for the current user, if any. */
export async function readMirror(scope: string, collection: string): Promise<MirrorEntry | null> {
  const userId = activeUserId;
  if (!userId || !MIRRORED_COLLECTIONS.has(collection)) return null;
  const db = await openMirrorDb();
  if (!db) return null;
  return new Promise<MirrorEntry | null>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get([userId, scope, collection]);
      req.onsuccess = () => {
        const value = req.result as MirrorEntry | undefined;
        resolve(value && value.userId === userId ? value : null);
      };
      req.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function writeMirrorNow(entry: MirrorEntry): Promise<void> {
  const db = await openMirrorDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Trailing-throttled persistence of a collection snapshot or LRU block set for the active account. */
export function scheduleWriteMirror(scope: string, collection: string, payload: MirrorPayload): void {
  const userId = activeUserId;
  if (!userId || !MIRRORED_COLLECTIONS.has(collection) || typeof indexedDB === "undefined") return;
  const key = mirrorKey(userId, scope, collection);
  const entry = {
    ...payload,
    userId,
    scope,
    collection,
    updatedAt: Date.now(),
  } as MirrorEntry;
  pendingEntries.set(key, entry);
  if (pendingTimers.has(key)) return;
  const timer = setTimeout(() => {
    pendingTimers.delete(key);
    const latest = pendingEntries.get(key);
    pendingEntries.delete(key);
    if (!latest || activeUserId !== userId) return;
    void writeMirrorNow(latest);
  }, WRITE_DEBOUNCE_MS);
  pendingTimers.set(key, timer);
}

/** Cancel pending writes and purge all mirrored collections for a removed scope. */
export async function deleteScopeMirror(scope: string): Promise<void> {
  const userId = activeUserId;
  if (!userId) return;
  for (const collection of MIRRORED_COLLECTIONS) {
    const key = mirrorKey(userId, scope, collection);
    const timer = pendingTimers.get(key);
    if (timer) { clearTimeout(timer); pendingTimers.delete(key); }
    pendingEntries.delete(key);
  }
  const db = await openMirrorDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      for (const collection of MIRRORED_COLLECTIONS) store.delete([userId, scope, collection]);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Wipe all mirrored collections belonging to the signed-out (or active) user. */
export async function clearUserMirror(userId?: string): Promise<void> {
  const target = userId ?? activeUserId;
  if (!target) return;
  const prefix = `${target}\0`;
  for (const [key, timer] of pendingTimers) {
    if (key.startsWith(prefix)) { clearTimeout(timer); pendingTimers.delete(key); }
  }
  for (const key of pendingEntries.keys()) {
    if (key.startsWith(prefix)) pendingEntries.delete(key);
  }
  if (activeUserId === target) activeUserId = null;
  const db = await openMirrorDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(IDBKeyRange.bound([target, "", ""], [target, "\uffff", "\uffff"]));
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
