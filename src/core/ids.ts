export function createId(prefix: string): string {
  return `${prefix}_${uuid().replaceAll("-", "").slice(0, 16)}`;
}

/** A random UUID. The browser only offers `crypto.randomUUID` in a secure
 *  context, so a page served over plain HTTP on a LAN address — the usual way
 *  this app is reached outside localhost — falls back to `getRandomValues`,
 *  which every origin has, and assembles the version 4 bits itself. */
export function uuid(): string {
  const native = globalThis.crypto?.randomUUID;
  if (typeof native === "function") return native.call(globalThis.crypto);
  const bytes = randomBytes(16) ?? fallbackBytes();
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function randomBytes(size: number): Uint8Array | undefined {
  const source = globalThis.crypto?.getRandomValues;
  if (typeof source !== "function") return undefined;
  return source.call(globalThis.crypto, new Uint8Array(size)) as Uint8Array;
}

/** Last resort for an environment with no Web Crypto at all: not
 *  cryptographic randomness, only enough to keep identifiers distinct. */
function fallbackBytes(): Uint8Array {
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return bytes;
}
