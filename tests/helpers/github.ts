import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

// Test-only helpers for the GitHub OAuth HTTP acceptance tests. The Browser
// class mirrors tests/server.test.ts so cookie handling stays identical. The
// stub provider enforces the real wire contract: client_secret on the token
// exchange, PKCE S256 verification and one-time authorization codes.

export type Json = any;

export interface Reply {
  status: number;
  body: Json;
  headers: Headers;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  token?: string;
  raw?: BodyInit;
  contentType?: string;
  rawResponse?: boolean;
  // Header overrides; a null value removes the default header entirely.
  headers?: Record<string, string | null>;
}

export class Browser {
  cookie = "";

  constructor(private readonly serverUrl: () => string) {}

  async request(path: string, options: RequestOptions = {}): Promise<Reply> {
    const headers: Record<string, string> = { Origin: this.serverUrl() };
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      if (value === null) delete headers[key];
      else headers[key] = value;
    }
    if (this.cookie && !options.token) headers.Cookie = this.cookie;
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    } else if (options.raw !== undefined) {
      headers["Content-Type"] = options.contentType ?? "application/octet-stream";
      body = options.raw;
    }
    const response = await fetch(`${this.serverUrl()}${path}`, {
      method: options.method ?? "GET",
      headers,
      body,
      redirect: "manual",
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) {
      const known = new Map(this.cookie.split("; ").filter(Boolean).map((part) => {
        const at = part.indexOf("=");
        return [part.slice(0, at), part.slice(at + 1)];
      }));
      for (const cookie of cookies) {
        const first = cookie.split(";", 1)[0];
        const at = first.indexOf("=");
        const key = first.slice(0, at);
        const value = first.slice(at + 1);
        if (!value || /(?:^|;)\s*max-age=0(?:;|$)/i.test(cookie)) known.delete(key);
        else known.set(key, value);
      }
      this.cookie = [...known].map(([key, value]) => `${key}=${value}`).join("; ");
    }
    const text = await response.text();
    let parsed: Json = null;
    // Redirects carry an HTML body from Express; it is not a JSON API reply.
    if (text && !(response.status >= 300 && response.status < 400)) {
      const isJson = /application\/json/.test(response.headers.get("content-type") ?? "");
      if (options.rawResponse && !isJson) parsed = text;
      else {
        if (!isJson) throw new Error(`${path} returned a non-JSON API response: ${text.slice(0, 200)}`);
        parsed = JSON.parse(text);
      }
    }
    return { status: response.status, body: parsed, headers: response.headers };
  }

  // Same structure-basis helper as tests/server.test.ts: expectedPages keeps
  // page writes consistent with the collaboration projection.
  async structure(path: string, options: RequestOptions): Promise<Reply> {
    const input = options.body as Json;
    const single = /^\/api\/records\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
    const writes: Json[] = single ? [{ ...input, scope: decodeURIComponent(single[1]), collection: decodeURIComponent(single[2]), id: decodeURIComponent(single[3]) }] : input.writes;
    const expectedPages: Json[] = [];
    const seen = new Set<string>();
    for (const write of writes) {
      const pageId = write.collection === "pages" ? write.id : write.collection === "blocks" ? write.value?.page ?? write.base?.page : undefined;
      if (!pageId) continue;
      const key = JSON.stringify([write.scope, pageId]); if (seen.has(key)) continue; seen.add(key);
      const reply = await this.request(`/api/collaboration/${encodeURIComponent(write.scope)}/${encodeURIComponent(pageId)}`);
      if (![200, 404].includes(reply.status)) throw new Error(`Cannot establish the fixture's structure basis: ${JSON.stringify(reply.body)}`);
      if (reply.status === 200) expectedPages.push({ scope: write.scope, pageId, generation: reply.body.generation, revision: reply.body.revision });
    }
    const reply = await this.request("/api/records/batch", { ...options, body: { ...(!single ? input : {}), writes, expectedPages } });
    return single && reply.status === 200 ? { ...reply, body: reply.body[0] } : reply;
  }
}

// The stable contract for startServer({ github }). Defined locally until the
// server exports its own type; the shapes must match the UC-11 contract.
export interface GithubEndpoints {
  authorize: string;
  token: string;
  user: string;
}

export interface GithubConfig {
  clientId: string;
  clientSecret: string;
  publicUrl?: string;
  endpoints?: GithubEndpoints;
  now?: () => number;
}

export interface StubIdentity {
  id: number; // GitHub numeric user id, the only identity key that matters
  login: string;
  name?: string;
  deny?: boolean; // authorize redirects back with error=access_denied
  tokenFails?: boolean; // token exchange for the issued code fails
  userFails?: boolean; // /user fails for the issued access token
}

export interface TokenGate {
  arrived: Promise<void>; // resolves once a token request reaches the gate
  release(): void; // lets the queued request continue
}

export interface GithubStub {
  url: string;
  clientId: string;
  clientSecret: string;
  endpoints: GithubEndpoints;
  queue: StubIdentity[];
  down: boolean; // when true every provider endpoint reports an outage
  tokenRequests: Record<string, string>[];
  userRequests: string[];
  // Hold the next token response until release() is called.
  gateToken(): TokenGate;
  close(): Promise<void>;
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

export async function startGithubStub(options: { clientId?: string; clientSecret?: string } = {}): Promise<GithubStub> {
  const clientId = options.clientId ?? "notes-test-client";
  const clientSecret = options.clientSecret ?? "notes-test-secret";
  const queue: StubIdentity[] = [];
  const codes = new Map<string, { identity: StubIdentity; challenge: string; redirectUri: string; used: boolean }>();
  const accessTokens = new Map<string, StubIdentity>();
  const stub: GithubStub = {
    url: "",
    clientId,
    clientSecret,
    endpoints: { authorize: "", token: "", user: "" },
    queue,
    down: false,
    tokenRequests: [],
    userRequests: [],
    gateToken() {
      let release!: () => void;
      let markArrived!: () => void;
      const arrived = new Promise<void>((resolve) => (markArrived = resolve));
      const wait = new Promise<void>((resolve) => (release = resolve));
      tokenGates.push({ wait, markArrived });
      return { arrived, release };
    },
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
  let fallbackId = 9000;
  const tokenGates: { wait: Promise<void>; markArrived: () => void }[] = [];

  const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://github-stub.local");
    try {
      if (req.method === "GET" && url.pathname === "/authorize") {
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const state = url.searchParams.get("state") ?? "";
        const valid =
          url.searchParams.get("client_id") === clientId &&
          redirectUri.length > 0 &&
          state.length > 0 &&
          url.searchParams.get("code_challenge_method") === "S256" &&
          (url.searchParams.get("code_challenge") ?? "").length > 0;
        if (!valid) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("invalid authorize request");
          return;
        }
        const back = (params: Record<string, string>) => {
          const target = new URL(redirectUri);
          for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
          res.writeHead(302, { Location: target.toString() });
          res.end();
        };
        if (stub.down) return back({ error: "temporarily_unavailable", error_description: "stub outage", state });
        const identity = queue.shift() ?? { id: fallbackId++, login: `stub-user-${fallbackId}` };
        if (identity.deny) return back({ error: "access_denied", error_description: "The user denied access", state });
        const code = `stub-code-${randomBytes(16).toString("hex")}`;
        codes.set(code, { identity, challenge: url.searchParams.get("code_challenge")!, redirectUri, used: false });
        back({ code, state });
        return;
      }
      if (req.method === "POST" && url.pathname === "/token") {
        const gate = tokenGates.shift();
        if (gate) {
          gate.markArrived();
          await gate.wait;
        }
        const raw = await readBody(req);
        const params: Record<string, string> = (req.headers["content-type"] ?? "").includes("application/json")
          ? Object.fromEntries(Object.entries(JSON.parse(raw || "{}")).map(([key, value]) => [key, String(value)]))
          : Object.fromEntries(new URLSearchParams(raw));
        stub.tokenRequests.push(params);
        if (stub.down) return json(res, 503, { error: "service_unavailable" });
        if (params.client_id !== clientId || params.client_secret !== clientSecret) {
          return json(res, 401, { error: "unauthorized_client" });
        }
        const issued = codes.get(params.code ?? "");
        if (!issued || issued.used) return json(res, 400, { error: "bad_verification_code" });
        issued.used = true;
        if (issued.identity.tokenFails) return json(res, 503, { error: "service_unavailable" });
        const expected = createHash("sha256").update(params.code_verifier ?? "").digest("base64url");
        if (expected !== issued.challenge) {
          return json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
        }
        if (params.redirect_uri && params.redirect_uri !== issued.redirectUri) {
          return json(res, 400, { error: "redirect_uri_mismatch" });
        }
        const accessToken = `stub-token-${randomBytes(16).toString("hex")}`;
        accessTokens.set(accessToken, issued.identity);
        return json(res, 200, { access_token: accessToken, token_type: "bearer", scope: "" });
      }
      if (req.method === "GET" && url.pathname === "/user") {
        if (stub.down) return json(res, 503, { error: "service_unavailable" });
        const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? "";
        stub.userRequests.push(token);
        const identity = accessTokens.get(token);
        if (!identity) return json(res, 401, { error: "bad_credentials" });
        if (identity.userFails) return json(res, 500, { error: "server_error" });
        return json(res, 200, {
          id: identity.id,
          login: identity.login,
          name: identity.name ?? identity.login,
          avatar_url: "",
          email: null,
        });
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("github stub: not found");
    } catch (error) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(String(error));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  stub.url = `http://127.0.0.1:${port}`;
  stub.endpoints = { authorize: `${stub.url}/authorize`, token: `${stub.url}/token`, user: `${stub.url}/user` };
  return stub;
}

// GithubConfig for internal tests: injected local endpoints, no publicUrl.
export function githubConfig(stub: GithubStub, now: () => number = () => Date.now()): GithubConfig {
  return { clientId: stub.clientId, clientSecret: stub.clientSecret, endpoints: stub.endpoints, now };
}
