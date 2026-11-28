import { Expand, Minimize2, Shrink } from "lucide-react";
import { useEffect, useState } from "react";

/** Subtle floating corner control shown during fullscreen view so viewers can
 *  exit with one click (or inspect the Esc hint) without covering app UI. */
export function FullscreenExitPill({
  onExit,
  allowBrowserFullscreen = true,
}: {
  onExit(): void;
  allowBrowserFullscreen?: boolean;
}) {
  const canNative = allowBrowserFullscreen
    && typeof document !== "undefined"
    && Boolean(document.fullscreenEnabled);
  const [nativeActive, setNativeActive] = useState(
    () => typeof document !== "undefined" && Boolean(document.fullscreenElement),
  );

  useEffect(() => {
    if (!canNative) return;
    const sync = () => setNativeActive(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, [canNative]);

  const toggleNative = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      void document.documentElement.requestFullscreen?.().catch(() => undefined);
    }
  };

  return (
    <div className="fullscreen-exit-pill" role="toolbar" aria-label="全屏控制">
      {canNative ? (
        <button
          type="button"
          className="fullscreen-exit-pill__icon"
          onClick={toggleNative}
          aria-label={nativeActive ? "退出浏览器全屏" : "浏览器全屏"}
          title={nativeActive ? "退出浏览器全屏" : "浏览器全屏"}
        >
          {nativeActive ? <Shrink size={13} aria-hidden="true" /> : <Expand size={13} aria-hidden="true" />}
        </button>
      ) : null}
      <button type="button" className="fullscreen-exit-pill__btn" onClick={onExit} aria-label="退出全屏">
        <Minimize2 size={14} aria-hidden="true" />
        <span>退出全屏</span>
        <kbd>Esc</kbd>
      </button>
    </div>
  );
}
