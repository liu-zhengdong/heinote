import { normalizeBlockTree, normalizePage } from "./block-tree";
import { DEFAULT_GRAPH_SETTINGS } from "./graph-settings";
import type { PageVersion, SettingsRecord, WorkspaceMutation, WorkspacePreferences, WorkspaceState } from "./types";

/* The list's width is the member's to choose, inside bounds that protect the
   OTHER pane: a window opens at 640 wide, so a list that may be dragged to
   480 is a list that may be dragged over the page it exists to open. The
   drag handler clamps against the live window on top of this. */
export const SIDEBAR_MIN_WIDTH = 168;
export const SIDEBAR_MAX_WIDTH = 360;
export const SIDEBAR_DEFAULT_WIDTH = 216;
/** The folded list's rail — `--sidebar-rail` in the stylesheet. */
export const SIDEBAR_RAIL_WIDTH = 46;

export const DEFAULT_PREFERENCES: WorkspacePreferences = {
  theme: "system",
  sidebar_width: SIDEBAR_DEFAULT_WIDTH,
  sidebar_collapsed: false,
  database_views: {},
  favorites: [],
  sidebar_view: "files",
  sidebar_sort: "name",
  graph: DEFAULT_GRAPH_SETTINGS,
};

/** The member's preferences as their settings record holds them — each
 *  field's shape held by schema.ts — with the default for any not set yet. */
export function readPreferences(value: SettingsRecord | undefined): WorkspacePreferences {
  const { roots: _roots, ...set } = value ?? {};
  return { ...DEFAULT_PREFERENCES, ...set } as WorkspacePreferences;
}

export function emptyWorkspace(): WorkspaceState {
  return { pages: {}, roots: [], versions: {}, preferences: { ...DEFAULT_PREFERENCES } };
}

/** One version of a page, if it is one: its snapshot a page. */
export function normalizeVersion(item: unknown): PageVersion | null {
  if (!item || typeof item !== "object") return null;
  const version = item as PageVersion;
  if (typeof version.id !== "string" || !version.id) return null;
  const snapshot = normalizePage(version.snapshot);
  return snapshot ? { ...version, snapshot } : null;
}

const ROOTS = new Set(["pages", "versions", "roots", "preferences"]);
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Whether a write addresses something Notes keeps: a page or what is in
 *  it, a page's history or one version, the page list, the preferences —
 *  and never through a key that would reach an object's prototype. */
export function isWorkspaceMutation(value: unknown): value is WorkspaceMutation {
  if (!value || typeof value !== "object") return false;
  const mutation = value as Partial<WorkspaceMutation>;
  if (mutation.type !== "set" && mutation.type !== "delete") return false;
  if (!Array.isArray(mutation.path) || mutation.path.some((key) => typeof key !== "string" || !key || UNSAFE_KEYS.has(key))) return false;
  const [root] = mutation.path;
  if (!ROOTS.has(root)) return false;
  if (root === "roots") return mutation.path.length === 1;
  if (root === "preferences") return mutation.path.length <= 2;
  if (root === "versions") return mutation.path.length === 2 || mutation.path.length === 3;
  return mutation.path.length >= 2 && mutation.path.length <= 8;
}

/* A block is written whole; one that arrives malformed is made canonical at
   the door, so nothing downstream meets it raw. */
function writtenValue(path: readonly string[], value: unknown): unknown {
  // The addressed page owns its id.
  if (path.length === 2 && path[0] === "pages" && value && typeof value === "object") return { ...value, id: path[1] };
  if (path.length === 5 && path[0] === "pages" && path[2] === "block_tree" && path[3] === "by_id") {
    const blockId = path[4];
    const candidate = value && typeof value === "object" ? { ...(value as object), id: blockId } : value;
    return normalizeBlockTree({ by_id: { [blockId]: candidate } }).by_id[blockId];
  }
  return value;
}

/* A write to a page, a version list, the roots or the preferences as a whole
   normalises that entry — not the whole workspace, which would rebuild every
   page and block for the sake of one. */
function normalizeTouched(state: WorkspaceState, path: readonly string[]): WorkspaceState {
  if (path.length > 2) return state;
  const [root, key] = path;
  if (root === "pages" && key) {
    const pages = { ...state.pages };
    const page = normalizePage(pages[key]);
    delete pages[key];
    if (page) pages[page.id] = page;
    return { ...state, pages };
  }
  return state;
}

/** The workspace with one write made. Only the objects on its path are
 *  copied; everything else is shared with the state before it, so a block
 *  the write did not touch keeps its identity from one keystroke to the
 *  next — which is what lets the editor skip every block that did not
 *  change. A write inside a page that is not here, or to a field of a
 *  paragraph that is not here, makes nothing. */
export function applyMutation(current: WorkspaceState, mutation: WorkspaceMutation): WorkspaceState {
  if (!isWorkspaceMutation(mutation)) return current;
  const { path } = mutation;
  if (path[0] === "pages" && path.length > 2 && !current.pages[path[1]]) return current;
  if (path[0] === "pages" && path[2] === "block_tree" && path[3] === "by_id" && path.length > 5
    && !current.pages[path[1]]?.block_tree?.by_id?.[path[4]]) return current;
  const leaf = path[path.length - 1];
  const root: Record<string, unknown> = { ...current };
  let node = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    const existing = node[key];
    const copy = Array.isArray(existing)
      ? [...existing]
      : existing && typeof existing === "object" ? { ...(existing as Record<string, unknown>) } : {};
    node[key] = copy;
    node = copy as Record<string, unknown>;
  }
  const value = mutation.type === "delete" ? undefined : writtenValue(path, structuredClone(mutation.value));
  if (value === undefined) delete node[leaf];
  else node[leaf] = value;
  return normalizeTouched(root as unknown as WorkspaceState, path);
}
