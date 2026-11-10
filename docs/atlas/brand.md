# Notes 品牌图标

verified: 2026-11-04

Notes 使用折叠纸带构成的 N 图标。图标已用于登录页和浏览器标签。主色沿用操作蓝 `#216EAF`，白色构成主体。灰色后折面与浅蓝末端表达纸张层次。

## 尺寸与背景

16px 和 24px 使用纯色 N。32px 起保留折面。各尺寸保持相同外轮廓与重心。正式素材采用平面矢量。

深色背景使用蓝底白 N。透明蓝单色版用于浅色背景。单色 SVG 内联用于深色背景时，将 `currentColor` 设为浅色。

PNG 保留透明圆角。Apple touch 使用不透明蓝色正方形，由平台应用遮罩。当前未提供离线应用或原生应用打包。

## 正式素材

| 素材 | 用途 |
| --- | --- |
| [完整 SVG](../../public/brand/notes-icon.svg) | 常规图标，也是可编辑母版。 |
| [小尺寸 SVG](../../public/brand/notes-icon-small.svg) | 浏览器标签和小尺寸显示。 |
| [单色 SVG](../../public/brand/notes-mark.svg) | 透明背景，支持 `currentColor`。 |
| [512px PNG](../../public/brand/notes-512.png) | 位图使用。 |
| [多尺寸预览](../../public/brand/notes-icon-preview.png) | 对照各尺寸效果。 |
| [完整素材包](../evidence/notes-icon/notes-icon-assets.zip) | 包含 SVG、16–1024px PNG、ICO、Apple touch 与使用说明。 |

## 验证与追溯

已有检查覆盖小尺寸辨认、浅深背景、位图尺寸与透明度、SVG、ICO 和素材包完整性。[登录页证据](../evidence/notes-icon/login@2x.png)记录手机尺寸下的实际使用。

设计过程和验收细节见 [图标交付记录](../dev/archive/brand-delivery.md)。
