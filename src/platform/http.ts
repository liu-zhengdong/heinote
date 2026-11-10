export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin", ...init,
    headers: { ...(init.body && typeof init.body === "string" ? { "Content-Type": "application/json" } : {}), ...init.headers },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    if (response.status === 401) window.dispatchEvent(new Event("notes:session-expired"));
    throw new ApiError(error.error ?? `Request failed (${response.status})`, response.status, error.code ?? "request_failed");
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export function poll<T>(read: () => Promise<T>, listener: (value: T) => void, interval = 1500): () => void {
  let closed = false;
  let last = "";
  let timer: ReturnType<typeof setTimeout>;
  const tick = async () => {
    try {
      const value = await read();
      const serialized = JSON.stringify(value);
      if (!closed && serialized !== last) { last = serialized; listener(value); }
    } catch { /* Keep the last successful snapshot during a connection gap. */ }
    if (!closed) timer = setTimeout(tick, interval);
  };
  void tick();
  return () => { closed = true; clearTimeout(timer); };
}
