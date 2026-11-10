# Notes 基础组件

## Select

单选统一使用 `Select.tsx`。调用方管理业务值。组件管理选项展开、活动项、键盘和焦点。

```tsx
import { Select } from "./Select";

<Select
  aria-label="权限"
  value={access}
  onValueChange={setAccess}
  options={[{ value: "read", label: "只读" }, { value: "write", label: "读写" }]}
  size="field"
/>
```

- `label` 为选项的纯文本名称。组件用它提供无障碍名称和首字母查找。
- `content` 可替换选项的可见内容，例如数据库标签。它同时用于当前值和列表。
- `group` 将相邻选项归组。`disabled` 禁用单个选项。
- `size` 为 `standard`（32px）、`field`（36px）或 `compact`（26px）。
- `variant` 为 `default`、`ghost` 或 `cell`。
- `className` 管理外层布局。ARIA、`id`、`data-history-field` 等属性传给实际触发器。
- `name` 提供原生 FormData 字段。禁用控件不提交该字段。

使用 `aria-label` 或 `aria-labelledby` 命名控件。可见 label 用 `htmlFor` 指向控件 `id`。不要让 label 包裹整个组件，展开的选项也在组件 DOM 中。

上下键、Home、End 移动活动项。Enter 和空格确认。Escape 取消。Tab 关闭列表并自然移焦。直接键入标签前缀可查找选项。IME 组合输入不执行查找。

浮层使用原生 `popover="auto"` 和项目定位 Hook。支持 Chrome 114+、Firefox 125+、Safari 17+。父 Modal 和 Popover 会先让打开的原生选择列表处理 Escape。它不重写已有弹层之间的全部 Escape 行为。

运行 Notes 后，打开 `/components/select.html` 查看真实组件、深浅主题和嵌套场景。预览不访问账号数据。浏览器回归位于 `tests/select-browser.test.ts`。
