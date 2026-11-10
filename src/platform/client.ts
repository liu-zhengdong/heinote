import type { AppBootstrap, CollaboratorPresence, Person, PresenceState, SpaceMember, SpaceRoster, SpaceSummary } from "../core/types";
import type { FileUrl } from "./schema";
import { poll, request } from "./http";
import { configureCollaboration } from "../collaboration/client";

export const SHARED_FILES_BUCKET = "page_files";
export interface PlatformClient {
  readonly bootstrap: AppBootstrap;
  presence: {
    set(state: PresenceState | null, spaceId?: string): Promise<void>;
    watch(listener: (presence: CollaboratorPresence[]) => void, spaceId?: string): Promise<() => void>;
    release(spaceId: string): Promise<void>;
  };
  users: { search(query: string): Promise<Person[]> };
  files: {
    write(path: string, bytes: Blob, options: { spaceId?: string; mediaType: string }): Promise<void>;
    read(path: string, options: { spaceId?: string }): Promise<Blob>;
    url(path: string, options: { spaceId?: string }): FileUrl;
  };
  spaces: {
    create(name: string): Promise<{ spaceId: string; name: string }>;
    installations(): Promise<SpaceSummary[]>;
    watchInstallations(listener: (spaces: SpaceSummary[]) => void): Promise<() => void>;
    members(spaceId: string): Promise<SpaceMember[]>;
    watchRoster(spaceId: string, listener: (roster: SpaceRoster) => void): Promise<() => void>;
    invite(spaceId: string, handle: string, role: "admin" | "editor" | "viewer"): Promise<{ created: boolean }>;
    updateRole(spaceId: string, userId: string, role: "admin" | "editor" | "viewer"): Promise<void>;
    removeMember(spaceId: string, userId: string): Promise<void>;
    leave(spaceId: string): Promise<void>;
  };
  close(): Promise<void>;
}

export async function createPlatformClient(): Promise<PlatformClient> {
  const { user } = await request<{ user: Person | null }>("/api/session");
  if (!user) throw new Error("请先登录 Notes。");
  configureCollaboration(user.id);
  const stops = new Set<() => void>();
  const watch = <T,>(read: () => Promise<T>, listener: (value: T) => void) => {
    const stop = poll(read, listener); stops.add(stop);
    return () => { stop(); stops.delete(stop); };
  };
  const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const filePath = (path: string, spaceId?: string) => `/api/files/${encodeURIComponent(spaceId ?? "personal")}?path=${encodeURIComponent(path)}`;
  const readFile = async (path: string, spaceId?: string): Promise<Blob> => {
    const response = await fetch(filePath(path, spaceId), { credentials: "same-origin" });
    if (!response.ok) throw Object.assign(new Error("无法读取附件。"), { status: response.status, code: response.status === 404 ? "not_found" : "forbidden" });
    return response.blob();
  };
  const presenceId = crypto.randomUUID();
  const presenceStates = new Map<string, PresenceState>();
  const heartbeat = setInterval(() => {
    for (const [spaceId, state] of presenceStates) void request(`/api/spaces/${spaceId}/presence`, json("POST", { state, clientId: presenceId })).catch(() => undefined);
  }, 15000);
  return {
    bootstrap: { appId: "notes", installationId: "standalone", appName: "Notes", user },
    presence: {
      async set(state, spaceId) {
        if (!spaceId) return;
        if (state) presenceStates.set(spaceId, state); else presenceStates.delete(spaceId);
        await request(`/api/spaces/${spaceId}/presence`, json("POST", { state, clientId: presenceId }));
      },
      async watch(listener, spaceId) {
        if (!spaceId) { listener([]); return () => {}; }
        return watch(() => request<CollaboratorPresence[]>(`/api/spaces/${spaceId}/presence`), listener);
      },
      async release(spaceId) { presenceStates.delete(spaceId); await request(`/api/spaces/${spaceId}/presence`, json("POST", { state: null, clientId: presenceId })).catch(() => undefined); },
    },
    users: { search: (query) => request(`/api/users?query=${encodeURIComponent(query)}`) },
    files: {
      async write(path, bytes, { spaceId, mediaType }) {
        const response = await fetch(filePath(path, spaceId), { method: "PUT", credentials: "same-origin", body: bytes, headers: { "Content-Type": mediaType } });
        if (!response.ok) throw new Error("附件上传失败。");
      },
      read: (path, { spaceId }) => readFile(path, spaceId),
      url(path, { spaceId }) {
        let url: string | null = null;
        let released = false;
        const ready = readFile(path, spaceId).then((blob) => {
          url = URL.createObjectURL(blob); if (released) URL.revokeObjectURL(url); return url;
        });
        ready.catch(() => undefined);
        return { get url() { return url; }, ready, release() { released = true; if (url) URL.revokeObjectURL(url); } };
      },
    },
    spaces: {
      create: (name) => request("/api/spaces", json("POST", { name })),
      installations: () => request("/api/spaces"),
      async watchInstallations(listener) { return watch(() => request<SpaceSummary[]>("/api/spaces"), listener); },
      async members(spaceId) { return (await request<SpaceRoster>(`/api/spaces/${spaceId}/roster`)).members; },
      async watchRoster(spaceId, listener) { return watch(() => request<SpaceRoster>(`/api/spaces/${spaceId}/roster`), listener); },
      invite: (id, handle, role) => request(`/api/spaces/${id}/invitations`, json("POST", { handle, role })),
      updateRole: (id, userId, role) => request(`/api/spaces/${id}/members/${userId}`, json("PATCH", { role })),
      removeMember: (id, userId) => request(`/api/spaces/${id}/members/${userId}`, json("DELETE")),
      leave: (id) => request(`/api/spaces/${id}/leave`, json("POST")),
    },
    async close() { clearInterval(heartbeat); presenceStates.clear(); stops.forEach((stop) => stop()); stops.clear(); },
  };
}
