import type { AppBootstrap, CollaboratorPresence, Person, PresenceState, SidebarSort, SpaceMember, SpaceRoster, SpaceSummary } from "../core/types";
import type { FileUrl } from "./schema";
import { uuid } from "../core/ids";
import { ApiError, poll, request } from "./http";
import {
  configureCollaboration,
  isCollaborationConnected,
  onCollaborationConnection,
  sendSpacePresence,
  subscribeSpacePresence,
} from "../collaboration/client";

export const SHARED_FILES_BUCKET = "page_files";
export interface KnowledgeBaseClient {
  create(input: { requestId: string; name: string; description?: string }): Promise<SpaceSummary>;
  update(spaceId: string, input: { requestId: string; revision: number; name?: string; description?: string; sort?: SidebarSort }): Promise<SpaceSummary>;
  archive(spaceId: string, input: { requestId: string; revision: number; archived: boolean }): Promise<SpaceSummary>;
  transfer(spaceId: string, input: { requestId: string; revision: number; userId: string }): Promise<SpaceSummary>;
  operation(requestId: string): Promise<SpaceSummary | undefined>;
}
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
    watchInstallations(listener: (spaces: SpaceSummary[]) => void, options?: { initial?: SpaceSummary[] }): Promise<() => void>;
    members(spaceId: string): Promise<SpaceMember[]>;
    watchRoster(spaceId: string, listener: (roster: SpaceRoster) => void): Promise<() => void>;
    invite(spaceId: string, handle: string, role: "admin" | "editor" | "viewer"): Promise<{ created: boolean }>;
    updateRole(spaceId: string, userId: string, role: "admin" | "editor" | "viewer"): Promise<void>;
    removeMember(spaceId: string, userId: string): Promise<void>;
    revokeInvitation(spaceId: string, invitationId: string): Promise<void>;
    leave(spaceId: string): Promise<void>;
  };
  knowledgeBases: KnowledgeBaseClient;
  close(): Promise<void>;
}

export async function createPlatformClient(knownUser?: Person | null): Promise<PlatformClient> {
  const user = knownUser ?? (await request<{ user: Person | null }>("/api/session")).user;
  if (!user) throw new Error("请先登录小黑笔记。");
  configureCollaboration(user.id);
  const stops = new Set<() => void>();
  const watch = <T,>(read: () => Promise<T>, listener: (value: T) => void, options: { initial?: T } = {}) => {
    const stop = poll(read, listener, undefined, options);
    stops.add(stop);
    return () => { stop(); stops.delete(stop); };
  };
  const json = (method: string, body?: unknown): RequestInit => ({
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const filePath = (path: string, spaceId?: string) => `/api/files/${encodeURIComponent(spaceId ?? "personal")}?path=${encodeURIComponent(path)}`;
  const readFile = async (path: string, spaceId?: string): Promise<Blob> => {
    const response = await fetch(filePath(path, spaceId), { credentials: "same-origin" });
    if (!response.ok) throw Object.assign(new Error("无法读取附件。"), { status: response.status, code: response.status === 404 ? "not_found" : "forbidden" });
    return response.blob();
  };

  const presenceId = uuid();
  const presenceStates = new Map<string, PresenceState>();

  // Re-publish active presence immediately whenever WebSocket reconnects.
  const stopConn = onCollaborationConnection((connected) => {
    if (!connected) return;
    for (const [spaceId, state] of presenceStates) {
      sendSpacePresence(spaceId, presenceId, state);
    }
  });
  stops.add(stopConn);

  // Heartbeat refreshes presence TTL over WS (or HTTP fallback only if WS is disconnected).
  const heartbeat = setInterval(() => {
    for (const [spaceId, state] of presenceStates) {
      if (!sendSpacePresence(spaceId, presenceId, state)) {
        void request(`/api/spaces/${encodeURIComponent(spaceId)}/presence`, json("POST", { state, clientId: presenceId })).catch(() => undefined);
      }
    }
  }, 15_000);

  return {
    bootstrap: { appId: "notes", installationId: "standalone", appName: "HeiNote", user },
    presence: {
      async set(state, spaceId) {
        if (!spaceId) return;
        if (state) presenceStates.set(spaceId, state);
        else presenceStates.delete(spaceId);
        if (sendSpacePresence(spaceId, presenceId, state)) return;
        await request(`/api/spaces/${encodeURIComponent(spaceId)}/presence`, json("POST", { state, clientId: presenceId }));
      },
      async watch(listener, spaceId) {
        if (!spaceId) { listener([]); return () => {}; }
        // Real-time WebSocket presence push replaces 1.5s HTTP polling.
        const stopWs = subscribeSpacePresence(spaceId, listener);
        // One initial HTTP seed only if WebSocket isn't connected yet.
        if (!isCollaborationConnected()) {
          void request<CollaboratorPresence[]>(`/api/spaces/${encodeURIComponent(spaceId)}/presence`)
            .then((list) => listener(list))
            .catch(() => undefined);
        }
        stops.add(stopWs);
        return () => { stopWs(); stops.delete(stopWs); };
      },
      async release(spaceId) {
        presenceStates.delete(spaceId);
        if (sendSpacePresence(spaceId, presenceId, null)) return;
        await request(`/api/spaces/${encodeURIComponent(spaceId)}/presence`, json("POST", { state: null, clientId: presenceId })).catch(() => undefined);
      },
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
          url = URL.createObjectURL(blob);
          if (released) URL.revokeObjectURL(url);
          return url;
        });
        ready.catch(() => undefined);
        return { get url() { return url; }, ready, release() { released = true; if (url) URL.revokeObjectURL(url); } };
      },
    },
    knowledgeBases: {
      create: (input) => request("/api/knowledge-bases", json("POST", input)),
      update: (spaceId, input) => request(`/api/knowledge-bases/${encodeURIComponent(spaceId)}`, json("PATCH", input)),
      archive: (spaceId, input) => request(`/api/knowledge-bases/${encodeURIComponent(spaceId)}/archive`, json("POST", input)),
      transfer: (spaceId, input) => request(`/api/knowledge-bases/${encodeURIComponent(spaceId)}/transfer`, json("POST", input)),
      async operation(requestId) {
        try { return (await request<{ status: "committed"; result: SpaceSummary }>(`/api/knowledge-bases/operations/${encodeURIComponent(requestId)}`)).result; }
        catch (error) { if (error instanceof ApiError && error.status === 404) return undefined; throw error; }
      },
    },
    spaces: {
      create: (name) => request("/api/spaces", json("POST", { name })),
      installations: () => request("/api/spaces"),
      async watchInstallations(listener, options) { return watch(() => request<SpaceSummary[]>("/api/spaces"), listener, options); },
      async members(spaceId) { return (await request<SpaceRoster>(`/api/spaces/${spaceId}/roster`)).members; },
      async watchRoster(spaceId, listener) { return watch(() => request<SpaceRoster>(`/api/spaces/${spaceId}/roster`), listener); },
      invite: (id, handle, role) => request(`/api/spaces/${id}/invitations`, json("POST", { handle, role })),
      updateRole: (id, userId, role) => request(`/api/spaces/${id}/members/${userId}`, json("PATCH", { role })),
      removeMember: (id, userId) => request(`/api/spaces/${id}/members/${userId}`, json("DELETE")),
      revokeInvitation: (id, invitationId) => request(`/api/spaces/${encodeURIComponent(id)}/invitations/${encodeURIComponent(invitationId)}`, json("DELETE")),
      leave: (id) => request(`/api/spaces/${id}/leave`, json("POST")),
    },
    async close() {
      clearInterval(heartbeat);
      presenceStates.clear();
      stops.forEach((stop) => stop());
      stops.clear();
    },
  };
}
