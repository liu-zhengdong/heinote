import { beforeEach, describe, expect, it, vi } from "vitest";
import { addRecovery, clearRecovery, getRecovery } from "./recovery";

const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal("window", { dispatchEvent: () => true, addEventListener: () => {} });
  clearRecovery("user");
});

describe("recovery draft dedupe", () => {
  it("merges same-key refusals into one entry that keeps all payloads", () => {
    const first = addRecovery("user", { message: "此范围已不可写入。", dedupe: "denied:A", writes: [{ id: "one" }] });
    const second = addRecovery("user", { message: "此范围已不可写入。", dedupe: "denied:A", writes: [{ id: "two" }] });
    expect(second.id).toBe(first.id);
    const entries = getRecovery("user");
    expect(entries).toHaveLength(1);
    expect(entries[0].writes).toHaveLength(2);
  });
  it("keeps distinct dedupe keys and keyless drafts as separate entries", () => {
    addRecovery("user", { message: "a", dedupe: "denied:A" });
    addRecovery("user", { message: "b", dedupe: "denied:B" });
    addRecovery("user", { message: "c" });
    expect(getRecovery("user")).toHaveLength(3);
  });
});
