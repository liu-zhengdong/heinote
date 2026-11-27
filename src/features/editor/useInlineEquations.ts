import { useEffect, useState, type RefObject } from "react";
import { MENTION_CHAR } from "../../core/inline-content";
import { mathReady, mathStyleSheet, renderMathHtml, whenMathReady } from "./math-render";

const TOKEN_SELECTOR = '.mention[data-mention="equation"]';

const HOST_STYLES = `
:host {
  display: inline-flex;
  align-items: baseline;
  vertical-align: baseline;
  line-height: 1.2;
}
.math-inline-host {
  display: inline-flex;
  align-items: baseline;
  max-width: 100%;
  overflow-x: auto;
  vertical-align: baseline;
}
.math-inline-empty {
  color: var(--muted, #9b9a97);
  font-size: 0.9em;
  font-style: italic;
}
.math-inline-fallback {
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 0.88em;
}
.math-inline-host.is-error .katex-error {
  border-bottom: 1px dashed #eb5757;
}
`;

let inlineHostSheet: CSSStyleSheet | null = null;

function hostSheet(): CSSStyleSheet | null {
  if (typeof CSSStyleSheet === "undefined") return null;
  if (!inlineHostSheet) {
    inlineHostSheet = new CSSStyleSheet();
    inlineHostSheet.replaceSync(HOST_STYLES);
  }
  return inlineHostSheet;
}

/** Paints KaTeX Shadow DOM inside every `.mention[data-mention="equation"]`
 *  owned by `root`, leaving Light DOM as single U+2063 so `textContent.length`
 *  and all caret/selection calculations in `selection.ts` stay untouched. */
export function useInlineEquations(root: RefObject<HTMLElement | null>): void {
  const [ready, setReady] = useState(mathReady);

  useEffect(() => {
    const element = root.current;
    if (!element) return;

    const paint = () => {
      const tokens = element.querySelectorAll<HTMLElement>(TOKEN_SELECTOR);
      if (tokens.length && !mathReady()) {
        whenMathReady(() => setReady(true));
      }
      const katexSheet = mathStyleSheet();
      const baseSheet = hostSheet();
      const sheets = [baseSheet, katexSheet].filter((s): s is CSSStyleSheet => s !== null);

      for (const token of tokens) {
        if (token.closest(".blocks") !== element) continue;
        // Keep Light DOM purely MENTION_CHAR so selection offsets remain exact.
        if (token.textContent !== MENTION_CHAR) token.textContent = MENTION_CHAR;

        const expr = token.dataset.expression ?? "";
        const shadow = token.shadowRoot ?? token.attachShadow({ mode: "open" });
        if (sheets.length && shadow.adoptedStyleSheets.length !== sheets.length) {
          shadow.adoptedStyleSheets = sheets;
        }

        let host = shadow.firstElementChild as HTMLSpanElement | null;
        if (!host) {
          host = document.createElement("span");
          host.className = "math-inline-host";
          shadow.append(host);
        }

        const key = `${ready ? "1" : "0"}:${expr}`;
        if (host.dataset.renderedKey === key) continue;
        host.dataset.renderedKey = key;

        if (!expr.trim()) {
          host.classList.remove("is-error");
          host.innerHTML = '<span class="math-inline-empty">New equation</span>';
          continue;
        }

        if (!ready) {
          host.classList.remove("is-error");
          host.innerHTML = "";
          const fallback = document.createElement("span");
          fallback.className = "math-inline-fallback";
          fallback.textContent = `$${expr}$`;
          host.append(fallback);
          continue;
        }

        const rendered = renderMathHtml(expr, false);
        host.classList.toggle("is-error", Boolean(rendered.error));
        if (rendered.error) host.title = rendered.error;
        else host.removeAttribute("title");

        if (rendered.html) {
          host.innerHTML = rendered.html;
        } else {
          host.innerHTML = "";
          const fallback = document.createElement("span");
          fallback.className = "math-inline-fallback";
          fallback.textContent = `$${expr}$`;
          host.append(fallback);
        }
      }
    };

    paint();
    const observer = new MutationObserver(() => paint());
    observer.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-expression"],
    });
    return () => observer.disconnect();
  }, [ready, root]);
}
