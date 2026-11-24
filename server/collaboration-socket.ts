import type { IncomingMessage, Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { documentKey, type DocumentSnapshot } from "../src/collaboration/protocol.ts";
import type { PermissionChangeFilter } from "./collaboration.ts";
import type { Actor, Store } from "./store.ts";

export interface SocketCredentials {
  sessionHash?: string;
  embedHash?: string;
  userId: string;
  tokenId?: string;
}

export interface PresenceRecord {
  userId: string;
  clientId: string;
  state: Record<string, unknown>;
  time: number;
  socketId?: string;
}

/** Shared presence store bridging WebSocket real-time presence and HTTP compatibility routes. */
export class PresenceHub {
  private readonly entries = new Map<string, PresenceRecord>();
  private readonly listeners = new Set<(spaceId: string) => void>();

  onSpaceChange(listener: (spaceId: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(spaceId: string): void {
    for (const listener of this.listeners) {
      try { listener(spaceId); }
      catch (error) { console.error("Presence broadcast failed", error); }
    }
  }

  set(spaceId: string, userId: string, clientId: string, state: Record<string, unknown> | null, socketId?: string): void {
    const key = `${spaceId}:${userId}:${clientId}`;
    if (!state) {
      if (this.entries.delete(key)) this.emit(spaceId);
      return;
    }
    this.entries.set(key, { userId, clientId, state, time: Date.now(), socketId });
    this.emit(spaceId);
  }

  removeBySocket(socketId: string): void {
    const touched = new Set<string>();
    for (const [key, entry] of this.entries) {
      if (entry.socketId === socketId) {
        this.entries.delete(key);
        touched.add(key.slice(0, key.indexOf(":")));
      }
    }
    for (const spaceId of touched) this.emit(spaceId);
  }

  removeUserFromSpace(spaceId: string, userId: string): void {
    const prefix = `${spaceId}:${userId}:`;
    let removed = false;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        removed = true;
      }
    }
    if (removed) this.emit(spaceId);
  }

  list(store: Store, spaceId: string): Array<{ userId: string; state: Record<string, unknown>; online: true }> {
    const cutoff = Date.now() - 45_000;
    for (const [key, item] of this.entries) {
      if (item.time < cutoff) this.entries.delete(key);
    }
    const prefix = `${spaceId}:`;
    const byUser = new Map<string, { userId: string; state: Record<string, unknown>; online: true; time: number }>();
    for (const [key, item] of this.entries) {
      if (!key.startsWith(prefix)) continue;
      if (!store.one("SELECT role FROM members WHERE space_id=? AND user_id=?", spaceId, item.userId)) {
        this.entries.delete(key);
        continue;
      }
      const existing = byUser.get(item.userId);
      if (!existing || item.time >= existing.time) {
        byUser.set(item.userId, { userId: item.userId, state: item.state, online: true, time: item.time });
      }
    }
    return [...byUser.values()].map(({ userId, state, online }) => ({ userId, state, online }));
  }
}

interface Subscription {
  scope: string;
  pageId: string;
  canEdit: boolean;
}

interface Client {
  id: string;
  socket: WebSocket;
  creds: SocketCredentials;
  alive: boolean;
  subscriptions: Map<string, Subscription>;
  spaces: Set<string>;
  authRequestsUser?: string;
}

const messageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), scope: z.string().min(1).max(256), pageId: z.string().min(1).max(256) }).strict(),
  z.object({ type: z.literal("unsubscribe"), scope: z.string().min(1).max(256), pageId: z.string().min(1).max(256) }).strict(),
  z.object({ type: z.literal("subscribe_space"), scope: z.string().min(1).max(256) }).strict(),
  z.object({ type: z.literal("unsubscribe_space"), scope: z.string().min(1).max(256) }).strict(),
  z.object({
    type: z.literal("presence"),
    spaceId: z.string().min(1).max(256),
    clientId: z.string().min(1).max(100).optional(),
    state: z.record(z.string(), z.unknown()).nullable(),
  }).strict(),
  z.object({ type: z.literal("subscribe_auth_requests") }).strict(),
]);

const HEARTBEAT_MS = 30_000;
const SAFETY_RECHECK_MS = 30_000;

export function attachCollaborationSocket(
  server: Server,
  store: Store,
  extractCredentials: (request: IncomingMessage) => SocketCredentials,
  resolveActor: (creds: SocketCredentials) => Actor,
  presenceHub: PresenceHub,
) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 32_768 });
  const clients = new Set<Client>();

  const send = (client: Client, value: unknown) => {
    if (client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify(value));
  };

  const resolveScope = (who: Actor, scopeName: string): string | null => {
    try { return store.scope(who, scopeName); }
    catch { return null; }
  };

  const matchesFilter = (client: Client, filter: PermissionChangeFilter): boolean => {
    if (filter.sessionHash && client.creds.sessionHash !== filter.sessionHash && client.creds.embedHash !== filter.sessionHash) return false;
    if (filter.tokenId && client.creds.tokenId !== filter.tokenId) return false;
    if (filter.userId && client.creds.userId !== filter.userId) return false;
    if (filter.scope) {
      const target = filter.scope;
      const inPage = [...client.subscriptions.values()].some((sub) =>
        sub.scope === target || (target.startsWith("user:") && sub.scope === "personal" && target === `user:${client.creds.userId}`),
      );
      const inSpace = client.spaces.has(target) || (target.startsWith("user:") && client.spaces.has("personal") && target === `user:${client.creds.userId}`);
      if (!inPage && !inSpace) return false;
    }
    return true;
  };

  const refreshClient = (client: Client): Actor | null => {
    let who: Actor;
    try {
      who = resolveActor(client.creds);
    } catch {
      presenceHub.removeBySocket(client.id);
      client.socket.close(1008, "Session expired");
      return null;
    }

    for (const [key, subscription] of client.subscriptions) {
      try {
        const current = store.collaboration.permission(who, subscription.scope, subscription.pageId);
        if (!current) throw new Error("page gone");
        if (current.canEdit !== subscription.canEdit) {
          subscription.canEdit = current.canEdit;
          const snap: DocumentSnapshot = store.collaboration.snapshot(who, subscription.scope, subscription.pageId);
          send(client, { type: "document", snapshot: snap });
        }
      } catch {
        client.subscriptions.delete(key);
        send(client, { type: "revoked", scope: subscription.scope, pageId: subscription.pageId });
      }
    }

    for (const spaceName of [...client.spaces]) {
      if (resolveScope(who, spaceName) === null) {
        client.spaces.delete(spaceName);
        if (spaceName !== "personal") presenceHub.removeUserFromSpace(spaceName, who.user.id);
      }
    }
    return who;
  };

  const revalidate = (filter: PermissionChangeFilter = {}) => {
    if (filter.scope && filter.userId && !filter.scope.startsWith("user:")) {
      presenceHub.removeUserFromSpace(filter.scope, filter.userId);
    }
    for (const client of [...clients]) {
      if (Object.keys(filter).length && !matchesFilter(client, filter)) continue;
      refreshClient(client);
    }
  };

  const stopPerm = store.collaboration.onPermissionChange((filter) => revalidate(filter));

  const stopPresence = presenceHub.onSpaceChange((spaceId) => {
    const list = presenceHub.list(store, spaceId);
    for (const client of clients) {
      if (!client.spaces.has(spaceId)) continue;
      let who: Actor;
      try { who = resolveActor(client.creds); }
      catch { continue; }
      if (resolveScope(who, spaceId) === null) {
        client.spaces.delete(spaceId);
        continue;
      }
      send(client, { type: "presence", spaceId, list });
    }
  });

  const stopCommit = store.collaboration.onCommit(({ events, scopes, requestId }) => {
    const scopeSet = new Set(scopes);
    for (const client of [...clients]) {
      // Only check clients whose subscriptions or watched spaces overlap this commit.
      const affected = [...client.subscriptions.values()].some((sub) => {
        const canonical = sub.scope === "personal" ? `user:${client.creds.userId}` : sub.scope;
        return scopeSet.has(canonical);
      }) || [...client.spaces].some((s) => {
        const canonical = s === "personal" ? `user:${client.creds.userId}` : s;
        return scopeSet.has(canonical);
      });
      if (!affected) continue;

      const who = refreshClient(client);
      if (!who) continue;

      const documents: Array<{
        type: "op" | "reset";
        scope: string;
        pageId: string;
        epoch?: string;
        generation?: string;
        seq?: number;
        revision?: string;
        ops?: unknown[];
      }> = [];

      for (const [subKey, subscription] of [...client.subscriptions]) {
        const canonical = resolveScope(who, subscription.scope);
        if (!canonical) continue;
        const event = events.find((item) => item.scope === canonical && item.pageId === subscription.pageId);
        if (!event) continue;
        if (event.type === "removed") {
          client.subscriptions.delete(subKey);
          send(client, { type: "revoked", scope: subscription.scope, pageId: event.pageId });
          continue;
        }
        documents.push({
          type: event.type,
          scope: subscription.scope,
          pageId: event.pageId,
          epoch: event.epoch,
          generation: event.generation ?? event.epoch,
          seq: event.seq,
          revision: event.revision,
          ...(event.type === "op" && event.ops ? { ops: event.ops } : {}),
        });
      }

      const notifiedSpaces: string[] = [];
      for (const spaceName of client.spaces) {
        const canonical = resolveScope(who, spaceName);
        if (canonical && scopeSet.has(canonical)) notifiedSpaces.push(spaceName);
      }

      if (documents.length) {
        send(client, { type: "commit", requestId, documents, ...(notifiedSpaces.length ? { scopes: notifiedSpaces } : {}) });
      } else if (notifiedSpaces.length) {
        send(client, { type: "space_delta", scopes: notifiedSpaces });
      }
    }
  });

  // 30s WebSocket ping/pong liveness + low-frequency session expiry safety net.
  const heartbeat = setInterval(() => {
    for (const client of [...clients]) {
      if (!client.alive) {
        presenceHub.removeBySocket(client.id);
        client.socket.terminate();
        clients.delete(client);
        continue;
      }
      client.alive = false;
      try { client.socket.ping(); } catch { /* closed */ }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const safetyTimer = setInterval(() => {
    for (const client of [...clients]) refreshClient(client);
  }, SAFETY_RECHECK_MS);
  safetyTimer.unref();

  server.on("upgrade", (request, socket, head) => {
    if (request.url?.split("?", 1)[0] !== "/api/collaboration") return;
    let creds: SocketCredentials;
    try {
      const expected = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).origin : `http://${request.headers.host}`;
      if (request.headers.origin && request.headers.origin !== expected) throw new Error("Origin rejected");
      creds = extractCredentials(request);
      resolveActor(creds);
    } catch {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (websocket) => sockets.emit("connection", websocket, creds));
  });

  sockets.on("connection", (socket: WebSocket, creds: SocketCredentials) => {
    const client: Client = {
      id: randomUUID(),
      socket,
      creds,
      alive: true,
      subscriptions: new Map(),
      spaces: new Set(),
    };
    clients.add(client);

    socket.on("pong", () => { client.alive = true; });

    socket.on("message", (raw) => {
      client.alive = true;
      try {
        const input = messageSchema.parse(JSON.parse(raw.toString()));
        const who = resolveActor(client.creds);

        if (input.type === "subscribe_auth_requests") {
          // UC-41: opt in to auth-request pushes bound to this logged-in user.
          client.authRequestsUser = who.user.id;
          send(client, { type: "auth_requests_subscribed" });
          return;
        }

        if (input.type === "subscribe") {
          const current = store.collaboration.snapshot(who, input.scope, input.pageId);
          client.subscriptions.set(documentKey(input), { scope: input.scope, pageId: input.pageId, canEdit: current.canEdit });
          send(client, { type: "document", snapshot: current });
          return;
        }

        if (input.type === "unsubscribe") {
          client.subscriptions.delete(documentKey(input));
          return;
        }

        if (input.type === "subscribe_space") {
          store.scope(who, input.scope, false);
          client.spaces.add(input.scope);
          if (input.scope !== "personal") {
            send(client, { type: "presence", spaceId: input.scope, list: presenceHub.list(store, input.scope) });
          }
          return;
        }

        if (input.type === "unsubscribe_space") {
          client.spaces.delete(input.scope);
          return;
        }

        if (input.type === "presence") {
          store.role(who, input.spaceId);
          const clientId = input.clientId ?? client.id;
          presenceHub.set(input.spaceId, who.user.id, clientId, input.state, client.id);
          return;
        }
      } catch (error) {
        send(client, { type: "error", error: error instanceof Error ? error.message : "Subscription rejected" });
      }
    });

    const cleanup = () => {
      clients.delete(client);
      presenceHub.removeBySocket(client.id);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });

  return {
    revalidate,
    notifyAuthRequests(userId: string, pending: unknown[]) {
      for (const client of clients) {
        if (client.authRequestsUser === userId) send(client, { type: "auth_requests", pending });
      }
    },
    close() {
      clearInterval(heartbeat);
      clearInterval(safetyTimer);
      stopPerm();
      stopPresence();
      stopCommit();
      for (const client of clients) {
        presenceHub.removeBySocket(client.id);
        client.socket.terminate();
      }
      sockets.close();
      clients.clear();
    },
  };
}
