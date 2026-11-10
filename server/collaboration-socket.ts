import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { documentKey, type DocumentSnapshot } from "../src/collaboration/protocol.ts";
import type { Actor, Store } from "./store.ts";

interface Subscription { scope: string; pageId: string; canEdit: boolean }
interface Client { socket: WebSocket; request: IncomingMessage; subscriptions: Map<string, Subscription> }
const subscribeSchema = z.object({ type: z.literal("subscribe"), scope: z.string().min(1).max(256), pageId: z.string().min(1).max(256) });

export function attachCollaborationSocket(server: Server, store: Store, authorize: (request: IncomingMessage) => Actor) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16384 });
  const clients = new Set<Client>();
  const send = (client: Client, value: unknown) => { if (client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify(value)); };
  const snapshot = (client: Client, subscription: Subscription): DocumentSnapshot => store.collaboration.snapshot(authorize(client.request), subscription.scope, subscription.pageId);
  const refreshPermissions = (client: Client): boolean => {
    try { authorize(client.request); } catch { client.socket.close(1008, "Session expired"); return false; }
    for (const [key, subscription] of client.subscriptions) {
      try {
        const current = snapshot(client, subscription);
        if (current.canEdit !== subscription.canEdit) {
          subscription.canEdit = current.canEdit; send(client, { type: "document", snapshot: current });
        }
      } catch {
        client.subscriptions.delete(key);
        send(client, { type: "revoked", scope: subscription.scope, pageId: subscription.pageId });
      }
    }
    return true;
  };
  const revalidate = () => { for (const client of clients) refreshPermissions(client); };
  const stop = store.collaboration.onCommit((events) => {
    for (const client of clients) {
      if (!refreshPermissions(client)) continue;
      const who = authorize(client.request);
      const documents: Array<{ type: "document" | "reset"; snapshot: DocumentSnapshot }> = [];
      for (const subscription of client.subscriptions.values()) {
        const scope = store.scope(who, subscription.scope);
        const event = events.find((event) => event.scope === scope && event.pageId === subscription.pageId);
        if (!event || event.type === "removed") continue;
        const current = snapshot(client, subscription);
        documents.push({ type: event.type, snapshot: current });
      }
      if (documents.length) send(client, { type: "commit", requestId: events.find((event) => event.requestId)?.requestId, documents });
    }
  });
  const timer = setInterval(revalidate, 1000); timer.unref();
  server.on("upgrade", (request, socket, head) => {
    if (request.url?.split("?", 1)[0] !== "/api/collaboration") return;
    try {
      const expected = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).origin : `http://${request.headers.host}`;
      if (request.headers.origin && request.headers.origin !== expected) throw new Error("Origin rejected");
      authorize(request);
    } catch {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    sockets.handleUpgrade(request, socket, head, (websocket) => sockets.emit("connection", websocket, request));
  });
  sockets.on("connection", (socket, request) => {
    const client: Client = { socket, request, subscriptions: new Map() }; clients.add(client);
    socket.on("message", (raw) => {
      try {
        const input = subscribeSchema.parse(JSON.parse(raw.toString()));
        const current = store.collaboration.snapshot(authorize(request), input.scope, input.pageId);
        client.subscriptions.set(documentKey(input), { scope: input.scope, pageId: input.pageId, canEdit: current.canEdit });
        send(client, { type: "document", snapshot: current });
      } catch (error) {
        send(client, { type: "error", error: error instanceof Error ? error.message : "Subscription rejected" });
      }
    });
    socket.on("close", () => clients.delete(client));
    socket.on("error", () => clients.delete(client));
  });
  return {
    revalidate,
    close() { clearInterval(timer); stop(); for (const client of clients) client.socket.terminate(); sockets.close(); clients.clear(); },
  };
}
