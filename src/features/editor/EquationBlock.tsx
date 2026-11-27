import { Sigma } from "lucide-react";
import { memo } from "react";
import { inlinePlainText } from "../../core/inline-content";
import type { Block } from "../../core/types";
import { rectOf, type AnchorRect } from "../../hooks/useAnchoredPosition";
import { MathView } from "./math-render";

/** Centered block-level equation (`block.kind === "equation"`). Clicking
 *  opens the shared Notion-style LaTeX popover anchored to this block. */
export const EquationBlock = memo(function EquationBlock({
  block,
  readOnly,
  onEdit,
}: {
  block: Block;
  readOnly: boolean;
  onEdit(anchor: AnchorRect): void;
}) {
  const expression = inlinePlainText(block.content);
  const empty = !expression.trim();

  if (readOnly) {
    return (
      <div className={`block__equation is-readonly ${empty ? "is-empty" : ""}`}>
        {empty ? null : <MathView expression={expression} display />}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`block__equation ${empty ? "is-empty" : ""}`}
      contentEditable={false}
      aria-label={empty ? "添加公式块" : `编辑公式块: ${expression}`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation();
        onEdit(rectOf(event.currentTarget));
      }}
    >
      {empty ? (
        <span className="block__equation-empty">
          <Sigma size={15} aria-hidden="true" />
          <span>点击输入 LaTeX 公式</span>
        </span>
      ) : (
        <MathView expression={expression} display />
      )}
    </button>
  );
});
