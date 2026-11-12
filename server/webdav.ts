import { Readable } from "node:stream";

/* WebDAV target for UC-31 site backups. Native fetch only — MKCOL, PUT,
   PROPFIND Depth:1 and DELETE with Basic auth. Two constraints the
   endpoints we target enforce:
   - PUT must carry an explicit Content-Length; undici's `duplex: 'half'`
     without it degrades to chunked transfer, which some providers
     (jianguoyun) do not accept.
   - `redirect: 'manual'` — a cross-origin redirect would strip the
     Authorization header and an already-consumed stream cannot replay. */

export type DavEntry = { name: string; size: number; isCollection: boolean; modifiedAt: string | null };
export type DavFailureKind = "auth" | "network";

export class WebdavError extends Error {
  constructor(
    message: string,
    readonly kind: DavFailureKind,
    readonly status = 0,
  ) {
    super(message);
    this.name = "WebdavError";
  }
}

export interface WebdavTarget {
  /** Verify the collection is reachable and writable; creates it if needed. */
  ensureCollection(): Promise<void>;
  /** List direct children of the collection (files only metadata). */
  list(): Promise<DavEntry[]>;
  /** Upload a stream of exactly `size` bytes as `name`. */
  put(name: string, body: Readable, size: number): Promise<void>;
  /** Upload a small buffer (manifest, probes). */
  putBuffer(name: string, body: Uint8Array): Promise<void>;
  /** Delete a file or collection path relative to the collection. */
  remove(name: string): Promise<void>;
}

export interface WebdavOptions {
  url: string;
  user: string;
  password: string;
  /** Plain requests (PROPFIND/DELETE/MKCOL). Default 30s. */
  timeoutMs?: number;
  /** PUT timeout — large parts on slow links. Default 30 min. */
  putTimeoutMs?: number;
}

export function createWebdavTarget(options: WebdavOptions): WebdavTarget {
  return new Webdav(options);
}

class Webdav implements WebdavTarget {
  private readonly base: string;
  private readonly auth: string;
  private readonly timeoutMs: number;
  private readonly putTimeoutMs: number;

  constructor(options: WebdavOptions) {
    const url = new URL(options.url.trim());
    const segments = url.pathname.split("/").filter(Boolean).map((part) => encodeURIComponent(decodeURIComponent(part)));
    url.pathname = `/${segments.join("/")}`;
    url.search = "";
    url.hash = "";
    this.base = url.toString().replace(/\/+$/, "");
    this.auth = `Basic ${Buffer.from(`${options.user}:${options.password}`).toString("base64")}`;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.putTimeoutMs = options.putTimeoutMs ?? 30 * 60_000;
  }

  private childUrl(name: string): string {
    const parts = name.split("/").filter(Boolean).map(encodeURIComponent);
    return `${this.base}/${parts.join("/")}`;
  }

  private async call(method: string, url: string, init: RequestInit = {}, put = false): Promise<Response> {
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set("Authorization", this.auth);
      response = await fetch(url, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(put ? this.putTimeoutMs : this.timeoutMs),
        ...init,
        headers,
      });
    } catch (error) {
      throw new WebdavError(`WebDAV ${method} 连接失败: ${(error as Error).message}`, "network");
    }
    if (response.status === 401 || response.status === 403) {
      await response.arrayBuffer().catch(() => undefined);
      throw new WebdavError(`WebDAV ${method} 认证失败 (${response.status})。`, "auth", response.status);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.arrayBuffer().catch(() => undefined);
      throw new WebdavError(`WebDAV ${method} 被重定向 (${response.status})，请检查目标地址。`, "network", response.status);
    }
    return response;
  }

  private async expect(response: Response, method: string, accepted: number[]): Promise<void> {
    if (accepted.includes(response.status)) {
      await response.arrayBuffer().catch(() => undefined);
      return;
    }
    await response.arrayBuffer().catch(() => undefined);
    throw new WebdavError(`WebDAV ${method} 返回 ${response.status}。`, "network", response.status);
  }

  /** MKCOL each path segment; 405 means the collection already exists. */
  async ensureCollection(): Promise<void> {
    const { pathname } = new URL(this.base);
    const segments = pathname.split("/").filter(Boolean);
    const origin = new URL(this.base).origin;
    let prefix = origin;
    for (const segment of segments) {
      prefix += `/${segment}`;
      const response = await this.call("MKCOL", prefix);
      await this.expect(response, "MKCOL", [200, 201, 204, 405]);
    }
  }

  async list(): Promise<DavEntry[]> {
    const response = await this.call("PROPFIND", `${this.base}/`, { headers: { Depth: "1" } });
    if (response.status === 404) {
      await response.arrayBuffer().catch(() => undefined);
      return [];
    }
    if (!response.ok) {
      await response.arrayBuffer().catch(() => undefined);
      throw new WebdavError(`WebDAV PROPFIND 返回 ${response.status}。`, "network", response.status);
    }
    const xml = await response.text();
    return parseMultistatus(xml, decodeURIComponent(new URL(this.base).pathname));
  }

  async put(name: string, body: Readable, size: number): Promise<void> {
    const response = await this.call("PUT", this.childUrl(name), {
      // undici requires duplex for a stream body; explicit length keeps it off chunked.
      duplex: "half",
      body: body as unknown as BodyInit,
      headers: { "Content-Length": String(size), "Content-Type": "application/octet-stream" },
    } as RequestInit, true);
    await this.expect(response, "PUT", [200, 201, 204]);
  }

  async putBuffer(name: string, body: Uint8Array): Promise<void> {
    const response = await this.call("PUT", this.childUrl(name), {
      body: body.slice() as unknown as BodyInit,
      headers: { "Content-Length": String(body.length), "Content-Type": "application/json" },
    });
    await this.expect(response, "PUT", [200, 201, 204]);
  }

  async remove(name: string): Promise<void> {
    const response = await this.call("DELETE", this.childUrl(name));
    await this.expect(response, "DELETE", [200, 202, 204, 404]);
  }
}

/* PROPFIND multistatus parsing. Providers differ in namespace prefixes, so
   tags match by local name. The collection's own <response> row is skipped
   by comparing percent-decoded href paths. */
function parseMultistatus(xml: string, collectionPath: string): DavEntry[] {
  const entries: DavEntry[] = [];
  const basePath = collectionPath.replace(/\/+$/, "");
  const blocks = xml.match(/<(?:\w+:)?response\b[\s\S]*?<\/(?:\w+:)?response>/g) ?? [];
  for (const block of blocks) {
    const hrefRaw = tag(block, "href");
    if (hrefRaw == null) continue;
    let path: string;
    try { path = decodeURIComponent(hrefRaw.trim()); }
    catch { path = hrefRaw.trim(); }
    path = path.replace(/\/+$/, "");
    if (!path || path === basePath) continue;
    const relative = path.startsWith(`${basePath}/`) ? path.slice(basePath.length + 1) : path.split("/").pop() ?? "";
    if (!relative || relative.includes("/")) continue; // Depth:1 children only
    const sizeText = tag(block, "getcontentlength");
    const modified = tag(block, "getlastmodified");
    entries.push({
      name: relative,
      size: sizeText != null ? Number(sizeText.trim()) : Number.NaN,
      isCollection: /<(?:\w+:)?collection\b/.test(block),
      modifiedAt: modified ? new Date(modified.trim()).toISOString() : null,
    });
  }
  return entries;
}

function tag(block: string, name: string): string | null {
  const match = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, "i").exec(block);
  return match ? match[1] : null;
}
