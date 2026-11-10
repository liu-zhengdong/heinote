import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { useWorkspace } from "../../app/workspace-context";
import { Button } from "../../components/Button";
import { Modal } from "../../components/Modal";
import { ApiError } from "../../platform/http";
import "./knowledge-base.css";

/** Keep modal focus in visible controls and restore its visible trigger. */
export function useKnowledgeBaseModal(scope: RefObject<HTMLDivElement | null>) {
  const trapFocus = (event: ReactKeyboardEvent<HTMLDivElement> | globalThis.KeyboardEvent) => {
    if (event.key !== "Tab" || event.defaultPrevented) return;
    const controls = [...(scope.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') ?? [])]
      .filter((element) => element.tabIndex >= 0 && element.getClientRects().length && !element.closest("[inert]"));
    const first = controls[0] ?? scope.current;
    const last = controls.at(-1) ?? scope.current;
    if (event.shiftKey && (document.activeElement === first || !scope.current?.contains(document.activeElement))) {
      event.preventDefault(); last?.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !scope.current?.contains(document.activeElement))) {
      event.preventDefault(); first?.focus();
    }
  };

  useEffect(() => {
    const previous = document.activeElement;
    const shell = document.querySelector<HTMLElement>(".app-shell");
    const wasInert = shell?.inert ?? false;
    if (shell) shell.inert = true;
    const frame = requestAnimationFrame(() => {
      const initial = scope.current?.querySelector<HTMLElement>('input:not(:disabled)')
        ?? scope.current?.querySelector<HTMLElement>('button:not(:disabled)');
      initial?.focus({ preventScroll: true });
    });
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!scope.current?.contains(event.target as Node)) trapFocus(event);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown, true);
      if (shell) shell.inert = wasInert;
      if (previous instanceof HTMLElement && previous.isConnected && previous.getClientRects().length && !previous.closest("[inert]")) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [scope]);
  return trapFocus;
}

export function KnowledgeBaseDialog({ onClose }: { onClose(): void }) {
  const { knowledgeBases, refreshSpaces, switchSpace } = useWorkspace();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const scope = useRef<HTMLDivElement>(null);
  const id = useId();
  const trapFocus = useKnowledgeBaseModal(scope);
  const close = () => { if (!busy.current && !unknown) onClose(); };

  const submit = async (queryOnly = false) => {
    if (busy.current || !name.trim()) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      if (queryOnly) {
        const result = await knowledgeBases.operation(requestId);
        if (!result) {
          setError("尚未查到结果。请稍后查询，或重试本次创建。");
          return;
        }
        await refreshSpaces();
        switchSpace(result.spaceId);
      } else {
        await knowledgeBases.create({ requestId, name: name.trim(), description: description.trim() });
      }
      setRequestId(crypto.randomUUID());
      setUnknown(false);
      onClose();
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === "result_unknown") {
        setUnknown(true);
        setError("尚未确认创建结果。输入已保留，请查询结果或重试本次创建。");
      } else {
        setError(reason instanceof Error ? reason.message : "无法创建知识库，请重试。");
      }
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  return <Modal open label="新建团队知识库" className="knowledge-base-modal" onClose={close}>
    <div ref={scope} tabIndex={-1} onKeyDown={trapFocus}>
      <header className="knowledge-base-modal__header">
        <h1>新建团队知识库</h1>
        <button type="button" className="icon-btn" aria-label="关闭新建知识库" disabled={pending || unknown} onClick={close}><X size={17} aria-hidden="true" /></button>
      </header>
      <form className="knowledge-base-form" aria-busy={pending} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label className="knowledge-base-field" htmlFor={`${id}-name`}>
          <span>知识库名称</span>
          <input id={`${id}-name`} value={name} required maxLength={200} disabled={pending} readOnly={unknown}
            aria-describedby={error ? `${id}-error` : undefined} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="knowledge-base-field" htmlFor={`${id}-description`}>
          <span>简介</span>
          <textarea id={`${id}-description`} value={description} rows={3} maxLength={2000} disabled={pending} readOnly={unknown}
            onChange={(event) => setDescription(event.target.value)} />
        </label>
        {error ? <p id={`${id}-error`} className="knowledge-base-error" role="alert">{error}</p> : null}
        <footer className="knowledge-base-actions">
          {unknown ? <Button disabled={pending} onClick={() => void submit(true)}>查询结果</Button> : <Button disabled={pending} onClick={close}>取消</Button>}
          <Button type="submit" className="knowledge-base-primary" disabled={pending || !name.trim()}>
            {pending ? (unknown ? "正在确认…" : "正在创建…") : unknown ? "重试本次创建" : "创建团队知识库"}
          </Button>
        </footer>
      </form>
    </div>
  </Modal>;
}
