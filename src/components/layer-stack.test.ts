import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearLayersForTest, isTopLayer, pushLayer } from "./layer-stack";

class FakeEventTarget {
  private captureListeners = new Set<(event: KeyboardEvent) => void>();
  private bubbleListeners = new Set<(event: KeyboardEvent) => void>();

  addEventListener(_type: string, listener: (event: KeyboardEvent) => void, capture?: boolean): void {
    (capture ? this.captureListeners : this.bubbleListeners).add(listener);
  }

  removeEventListener(_type: string, listener: (event: KeyboardEvent) => void, capture?: boolean): void {
    (capture ? this.captureListeners : this.bubbleListeners).delete(listener);
  }

  dispatchKeyDown(init: { key: string; defaultPrevented?: boolean }): void {
    const state = {
      key: init.key,
      defaultPrevented: Boolean(init.defaultPrevented),
      isComposing: false,
      preventDefault() {
        state.defaultPrevented = true;
      },
      stopPropagation() {},
    };
    const event = state as unknown as KeyboardEvent;

    for (const listener of [...this.captureListeners]) listener(event);
    for (const listener of [...this.bubbleListeners]) listener(event);
  }
}

describe("layer-stack", () => {
  let fakeWindow: FakeEventTarget;

  beforeEach(() => {
    fakeWindow = new FakeEventTarget();
    vi.stubGlobal("window", fakeWindow);
  });

  afterEach(() => {
    clearLayersForTest();
    vi.unstubAllGlobals();
  });

  it("dismisses only the top-most Escape layer in LIFO order", () => {
    const parent = vi.fn();
    const child = vi.fn();
    const removeParent = pushLayer({ id: "parent", phase: "capture", escape: true, dismiss: parent });
    const removeChild = pushLayer({ id: "child", phase: "capture", escape: true, dismiss: child });

    expect(isTopLayer("child")).toBe(true);
    expect(isTopLayer("parent")).toBe(false);

    fakeWindow.dispatchKeyDown({ key: "Escape" });
    expect(child).toHaveBeenCalledTimes(1);
    expect(parent).not.toHaveBeenCalled();

    removeChild();
    expect(isTopLayer("parent")).toBe(true);

    fakeWindow.dispatchKeyDown({ key: "Escape" });
    expect(parent).toHaveBeenCalledTimes(1);
    removeParent();
  });

  it("respects bubble phase layers and ignores already prevented events", () => {
    const peek = vi.fn();
    const remove = pushLayer({ id: "peek", phase: "bubble", escape: true, dismiss: peek });

    fakeWindow.dispatchKeyDown({ key: "Escape", defaultPrevented: true });
    expect(peek).not.toHaveBeenCalled();

    fakeWindow.dispatchKeyDown({ key: "Escape" });
    expect(peek).toHaveBeenCalledTimes(1);
    remove();
  });
});
