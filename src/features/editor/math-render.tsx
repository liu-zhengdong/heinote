import { memo, useEffect, useMemo, useState } from "react";

type KatexApi = typeof import("katex").default;

let katexMod: KatexApi | null = null;
let katexLoading: Promise<void> | null = null;
let sharedSheet: CSSStyleSheet | null = null;
const waiters = new Set<() => void>();

export function mathReady(): boolean {
  return katexMod !== null;
}

export function mathStyleSheet(): CSSStyleSheet | null {
  return sharedSheet;
}

/** Lazy-loads KaTeX and its CSS/fonts on first math formula encountered. */
export function whenMathReady(ready: () => void): () => void {
  if (katexMod) return () => undefined;
  waiters.add(ready);
  katexLoading ??= Promise.all([
    import("katex"),
    import("katex/dist/katex.min.css"),
    import("katex/dist/katex.min.css?inline"),
  ])
    .then(([mod, , inlineCss]) => {
      katexMod = mod.default ?? (mod as unknown as KatexApi);
      if (typeof CSSStyleSheet !== "undefined" && typeof inlineCss.default === "string") {
        const sheet = new CSSStyleSheet();
        // Strip @font-face (loaded in document head via katex.min.css); Shadow DOM inherits fonts from document.
        sheet.replaceSync(inlineCss.default.replace(/@font-face\s*\{[^}]*\}/g, ""));
        sharedSheet = sheet;
      }
      const list = [...waiters];
      waiters.clear();
      for (const notify of list) notify();
    })
    .catch(() => {
      katexLoading = null;
    });
  return () => {
    waiters.delete(ready);
  };
}

export interface MathRenderResult {
  html: string;
  error?: string;
}

export function renderMathHtml(expression: string, displayMode: boolean): MathRenderResult {
  if (!katexMod || !expression.trim()) return { html: "" };
  const baseOptions = {
    displayMode,
    strict: "ignore" as const,
    trust: false,
    output: "htmlAndMathml" as const,
    maxSize: 500,
    maxExpand: 1000,
  };
  try {
    return { html: katexMod.renderToString(expression, { ...baseOptions, throwOnError: true }) };
  } catch (err) {
    const message = err instanceof Error ? err.message.replace(/^KaTeX parse error:\s*/i, "") : "Invalid LaTeX";
    try {
      const fallback = katexMod.renderToString(expression, { ...baseOptions, throwOnError: false });
      return { html: fallback, error: message };
    } catch {
      return { html: "", error: message };
    }
  }
}

export const MathView = memo(function MathView({
  expression,
  display = false,
  placeholder,
  className = "",
}: {
  expression: string;
  display?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [ready, setReady] = useState(mathReady);

  useEffect(() => {
    if (ready) return;
    if (mathReady()) {
      setReady(true);
      return;
    }
    return whenMathReady(() => setReady(true));
  }, [ready]);

  const rendered = useMemo(
    () => (ready ? renderMathHtml(expression, display) : { html: "" }),
    [display, expression, ready],
  );

  if (!expression.trim()) {
    return (
      <span className={`math-empty ${className}`.trim()}>
        {placeholder ?? (display ? "点击输入数学公式…" : "New equation")}
      </span>
    );
  }

  if (!ready || !rendered.html) {
    return (
      <code className={`math-fallback ${className}`.trim()}>
        {expression}
      </code>
    );
  }

  return (
    <span
      className={`math-view ${rendered.error ? "is-error" : ""} ${className}`.trim()}
      title={rendered.error}
      dangerouslySetInnerHTML={{ __html: rendered.html }}
    />
  );
});
