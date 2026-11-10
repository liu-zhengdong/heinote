export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

/** Account and public requests use the browser's same-origin session. */
export async function api<T = void>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiError(response.ok ? "服务器返回了无效数据" : `请求失败（${response.status}）`, response.status);
  }
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/api/auth/") && path !== "/api/session") {
      window.dispatchEvent(new Event("notes:session-expired"));
    }
    const data = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const detail = data.error;
    const message = typeof detail === "string" ? detail
      : detail && typeof detail === "object" && "message" in detail && typeof detail.message === "string" ? detail.message
      : typeof data.message === "string" ? data.message : `请求失败（${response.status}）`;
    throw new ApiError(message, response.status);
  }
  return payload as T;
}

export function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "请求失败，请重试";
}
