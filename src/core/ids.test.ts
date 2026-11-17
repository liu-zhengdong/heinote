import { afterEach, describe, expect, it, vi } from "vitest";
import { createId, uuid } from "./ids";

const version4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => { vi.unstubAllGlobals(); });

describe("uuid", () => {
  it("returns a version 4 identifier", () => {
    expect(uuid()).toMatch(version4);
  });

  it("still works where the browser offers no crypto.randomUUID", () => {
    // A page on a plain-HTTP LAN address is not a secure context, so it has
    // getRandomValues but no randomUUID.
    const real = globalThis.crypto.getRandomValues.bind(globalThis.crypto) as (bytes: Uint8Array) => Uint8Array;
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => real(bytes) });
    const values = new Set(Array.from({ length: 20 }, () => uuid()));
    expect(values.size).toBe(20);
    for (const value of values) expect(value).toMatch(version4);
  });

  it("keeps identifiers distinct with no Web Crypto at all", () => {
    vi.stubGlobal("crypto", undefined);
    expect(uuid()).toMatch(version4);
    expect(new Set(Array.from({ length: 20 }, () => uuid())).size).toBe(20);
  });
});

describe("createId", () => {
  it("keeps the prefixed identifier shape", () => {
    expect(createId("blk")).toMatch(/^blk_[0-9a-z]{16}$/);
  });
});
