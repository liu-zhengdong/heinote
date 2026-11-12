import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Calendar, FileText, Moon, Sun } from "lucide-react";
import { Select, type SelectOption } from "../components/Select";
import { Modal } from "../components/Modal";
import { Popover } from "../components/Popover";
import { rectOf, type AnchorRect } from "../hooks/useAnchoredPosition";
import { SortPanel } from "../features/database/SortPanel";
import { CODE_LANGUAGES } from "../features/editor/code-highlight";
import type { ViewSort } from "../core/types";
import "../styles/index.css";
import "../styles/standalone.css";
import "./SelectPreview.css";

const ACCESS = [{ value: "read", label: "只读" }, { value: "write", label: "读写" }] as const;
const ROLES = [{ value: "user", label: "用户" }, { value: "admin", label: "管理员" }, { value: "guest", label: "访客（不可用）", disabled: true }] as const;
const STATUSES: SelectOption[] = [
  { value: "todo", label: "未开始", group: "待办", content: <span className="select-preview__tag" style={{ background: "var(--tag-gray-bg)", color: "var(--tag-gray-ink)" }}>未开始</span> },
  { value: "doing", label: "进行中", group: "进行中", content: <span className="select-preview__tag">进行中</span> },
  { value: "done", label: "已完成", group: "已完成", content: <span className="select-preview__tag" style={{ background: "var(--tag-green-bg)", color: "var(--tag-green-ink)" }}>已完成</span> },
];
const LANGUAGES = CODE_LANGUAGES.map(({ id, label }) => ({ value: id, label }));
const COLUMNS = [{ id: "title", label: "Name", icon: <FileText size={14} /> }, { id: "created", label: "Created time", icon: <Calendar size={14} /> }];

function SelectPreview() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [access, setAccess] = useState<"read" | "write">("read");
  const [role, setRole] = useState<"user" | "admin" | "guest">("user");
  const [status, setStatus] = useState("doing");
  const [language, setLanguage] = useState("plain text");
  const [result, setResult] = useState("");
  const [dialog, setDialog] = useState(false);
  const [sortAnchor, setSortAnchor] = useState<AnchorRect | null>(null);
  const [sorts, setSorts] = useState<ViewSort[]>([{ property_id: "title", direction: "asc" }]);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  return <main className="select-preview">
    <nav className="select-preview__nav" aria-label="组件预览">
      <span className="select-preview__brand"><img src="/brand/heinote-icon.png" alt="" width="24" height="24" />小黑笔记 <span style={{ color: "var(--ink-3)", fontWeight: 400 }}> / 组件预览</span></span>
      <span className="select-preview__themes" aria-label="主题">
        <button type="button" aria-pressed={theme === "light"} onClick={() => setTheme("light")}><Sun size={14} />浅色</button>
        <button type="button" aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}><Moon size={14} />深色</button>
      </span>
    </nav>
    <h1>下拉选择</h1>
    <p className="select-preview__intro">选择清楚，操作安静。用于权限、属性和排序。</p>
    <section className="select-preview__surface" aria-label="Select 组件">
      <h2>Agent 令牌</h2>
      <p className="select-preview__hint">选择 Agent 的访问权限。此处仅演示，不创建实际令牌。</p>
      <form className="select-preview__form" onSubmit={(event) => {
        event.preventDefault();
        const next = new FormData(event.currentTarget).get("access");
        setResult(`已选择：${next === "write" ? "读写" : "只读"}`);
      }}>
        <label className="select-preview__field" htmlFor="preview-name">名称<input id="preview-name" name="agentName" defaultValue="我的 Agent" required /></label>
        <div className="select-preview__field"><label htmlFor="preview-access">权限</label><Select id="preview-access" aria-label="权限" name="access" value={access} onValueChange={setAccess} options={ACCESS} size="field" /></div>
        <button className="btn btn--primary" type="submit">创建预览</button>
      </form>
      <p className="select-preview__result" role="status">{result}</p>
      <div className="select-preview__grid">
        <div className="select-preview__example"><label className="select-preview__label" htmlFor="preview-role">默认 · 含禁用选项</label><Select id="preview-role" aria-label="站点角色" value={role} options={ROLES} onValueChange={setRole} /></div>
        <div className="select-preview__example"><label className="select-preview__label" htmlFor="preview-disabled">禁用</label><Select id="preview-disabled" aria-label="禁用权限" value="read" options={ACCESS} onValueChange={() => {}} disabled /></div>
        <div className="select-preview__example"><label className="select-preview__label" htmlFor="preview-status">分组选项</label><Select id="preview-status" aria-label="状态" value={status} options={STATUSES} onValueChange={setStatus} /></div>
        <div className="select-preview__example"><label className="select-preview__label" htmlFor="preview-language">长列表 · 支持键盘查找</label><Select id="preview-language" aria-label="代码语言" value={language} options={LANGUAGES} onValueChange={setLanguage} variant="ghost" size="compact" /></div>
      </div>
      <div className="select-preview__footer">
        <button type="button" className="btn" onClick={() => setDialog(true)}>在对话框中查看</button>
        <button type="button" className="btn" onClick={(event) => setSortAnchor(rectOf(event.currentTarget))}>在排序面板中查看</button>
      </div>
    </section>
    <Modal open={dialog} label="Select 对话框" className="select-preview__dialog" onClose={() => setDialog(false)}>
      <h2>访问权限</h2>
      <div className="select-preview__field"><label htmlFor="dialog-access">权限</label><Select id="dialog-access" aria-label="对话框权限" value={access} options={ACCESS} onValueChange={setAccess} size="field" /></div>
      <p className="select-preview__hint">Escape 先关闭选项，再关闭对话框。</p>
      <button type="button" className="btn" onClick={() => setDialog(false)}>关闭</button>
    </Modal>
    <Popover open={Boolean(sortAnchor)} anchor={sortAnchor} label="排序预览" role="dialog" className="select-preview__panel" onDismiss={() => setSortAnchor(null)}>
      <SortPanel sorts={sorts} columns={COLUMNS} onChange={setSorts} />
    </Popover>
  </main>;
}

createRoot(document.getElementById("root")!).render(<SelectPreview />);
