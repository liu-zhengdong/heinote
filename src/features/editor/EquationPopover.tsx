import { Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "../../components/Popover";
import { imeComposing } from "../../core/keyboard";
import type { AnchorRect } from "../../hooks/useAnchoredPosition";
import { MathView, mathReady, renderMathHtml, whenMathReady } from "./math-render";

/** Notion-style floating editor for inline `$...$` tokens and block `$$...$$`
 *  equations: monospace LaTeX source on top with live KaTeX preview below. */
export function EquationPopover({
  anchor,
  mode,
  initialExpression,
  onCommit,
  onRemove,
  onCancel,
}: {
  anchor: AnchorRect;
  mode: "inline" | "block";
  initialExpression: string;
  onCommit(expression: string): void;
  onRemove?(): void;
  onCancel(): void;
}) {
  const [value, setValue] = useState(initialExpression);
  const [ready, setReady] = useState(mathReady);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const settledRef = useRef(false);

  useEffect(() => {
    setValue(initialExpression);
    settledRef.current = false;
  }, [initialExpression, anchor]);

  useEffect(() => {
    if (ready) return;
    return whenMathReady(() => setReady(true));
  }, [ready]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(el.value.length, el.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, [anchor]);

  const syntaxError = useMemo(() => {
    if (!ready || !value.trim()) return undefined;
    return renderMathHtml(value, mode === "block").error;
  }, [mode, ready, value]);

  const commit = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    onCommit(value);
  };

  const cancel = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    onCancel();
  };

  const remove = () => {
    if (!onRemove || settledRef.current) return;
    settledRef.current = true;
    onRemove();
  };

  return (
    <Popover
      open
      anchor={anchor}
      placement="bottom-start"
      gap={6}
      className="equation-popover"
      role="dialog"
      label={mode === "inline" ? "编辑行内公式" : "编辑公式块"}
      group="equation"
      closeOnScroll={false}
      mobileSheet={{ title: mode === "inline" ? "行内公式" : "块级公式" }}
      onDismiss={(reason) => {
        if (reason === "escape") cancel();
        else commit();
      }}
    >
      <div className="equation-popover__body">
        <textarea
          ref={textareaRef}
          className="equation-popover__input"
          aria-label="LaTeX 公式"
          rows={mode === "block" ? 3 : 2}
          value={value}
          placeholder={mode === "inline" ? "E = mc^2" : "\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}"}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (imeComposing(event)) return;
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              cancel();
              return;
            }
            const submitInline = mode === "inline" && event.key === "Enter" && !event.shiftKey;
            const submitBlock = mode === "block" && event.key === "Enter" && (event.metaKey || event.ctrlKey);
            if (submitInline || submitBlock) {
              event.preventDefault();
              event.stopPropagation();
              commit();
            }
          }}
        />
        <div className={`equation-popover__preview ${mode === "block" ? "is-block" : ""}`}>
          <MathView
            expression={value}
            display={mode === "block"}
            placeholder="输入 LaTeX 实时预览"
          />
        </div>
        {syntaxError ? <p className="equation-popover__error" role="status">{syntaxError}</p> : null}
        <div className="equation-popover__foot">
          <span className="equation-popover__hint">
            {mode === "inline" ? "Enter 保存 · Esc 取消" : "⌘Enter 保存 · Esc 取消"}
          </span>
          <div className="equation-popover__actions">
            {onRemove ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm equation-popover__remove"
                aria-label="移除公式"
                onMouseDown={(event) => event.preventDefault()}
                onClick={remove}
              >
                <Trash2 size={13} aria-hidden="true" />
                <span>移除</span>
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onMouseDown={(event) => event.preventDefault()}
              onClick={commit}
            >
              完成
            </button>
          </div>
        </div>
      </div>
    </Popover>
  );
}
