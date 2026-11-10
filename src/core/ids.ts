export function createId(prefix: string): string {
  const cryptoId = globalThis.crypto?.randomUUID?.().replaceAll("-", "");
  if (cryptoId) return `${prefix}_${cryptoId.slice(0, 16)}`;
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
}
