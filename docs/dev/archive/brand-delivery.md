# Notes 品牌图标

归档说明：本文保留当轮交付与验收事实。2026-11-04 从 Atlas 迁出。当前系统说明见 [Atlas](../../atlas/README.md)。

verified: 2026-11-04

状态：已设计、导出并接入登录页和浏览器图标。

## 设计

图标用折叠纸带构成 N。蓝色沿用主操作的 `#216EAF`，白色构成主体。灰色后折面与浅蓝末端表达纸张层次。生产版使用平面矢量，无生成纹理。

16px、24px 简化为纯色 N。32px 起保留折面。所有版本保持相同外轮廓与重心。

## 素材与使用

- [完整 SVG](../../../public/brand/notes-icon.svg)：常规图标。
- [小尺寸 SVG](../../../public/brand/notes-icon-small.svg)：浏览器标签。
- [单色 SVG](../../../public/brand/notes-mark.svg)：背景透明，可用 currentColor 上色。
- [512px PNG](../../../public/brand/notes-512.png)及[多尺寸预览](../../../public/brand/notes-icon-preview.png)。
- [完整素材包](../../evidence/notes-icon/notes-icon-assets.zip)：包含可编辑 SVG、16–1024px PNG、ICO、Apple touch 与使用说明。

深色背景使用完整蓝底白 N。透明蓝单色版用于浅色背景；内联用于深色时，将 currentColor 设为浅色。

PNG 保留透明圆角。Apple touch 使用不透明蓝色正方形，由平台应用遮罩。此轮不增加离线应用或原生应用打包。

## 实际验证

- 前端、服务端类型检查及生产构建通过。
- 已检查 16px、24px、32px 和大图。独立图形评审通过，无必须修改项。
- 原生小图的 N 可辨，32px 起折面清楚。完整图标在浅底与深底均适用。
- 已验证 PNG 尺寸与透明度、SVG 结构、ICO 多尺寸、Apple touch 和 ZIP 完整性。
- 当前预览的图标资源 URL 可读取。
- [匿名登录页证据](../../evidence/notes-icon/login@2x.png)：390×844、2x。新 N 已替代旧通用图标，无裁切、拉伸、图片失败、控制台错误或横向溢出。

图像生成用于探索草图。交付版本已重新绘制成精确 SVG。SVG 是可编辑母版，位于正式品牌素材目录。
