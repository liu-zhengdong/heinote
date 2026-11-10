# UC-12 账号设置验收证据

日期：2026-11-10。数据均来自独立临时 Notes 服务与测试账号。

- `desktop-account-*-1440x900@2x.png`：桌面账号页，浅色与深色。
- `desktop-account-*-1280x720@2x.png`：较小桌面视口。
- `mobile-navigation-light@2x.png`：390×844 分类页。
- `mobile-account-long-name-light@2x.png`：手机长显示名编辑。
- `mobile-token-*.png`：手机权限选择和令牌结果。令牌原文已遮罩。
- `short-window-token-select-dark@2x.png`：1280×400 的权限列表。
- `reflow-200-percent-equivalent-dark@2x.png`：720×450 的布局重排检查。
- `chromium-page-zoom-200-percent.png`：独立 Chromium 浏览器的真实 200% 页面缩放。
- `chromium-page-zoom.json`：实际浏览器窗口、布局宽度、像素比和视觉缩放参数。
- `settings-interaction.webm`：真实设置打开、主题选择、显示名保存及减少动态流程。
- `motion-open.png`、`motion-change.png`、`motion-feedback.png`：录屏 0.65、1.10、1.65 秒的帧，依次显示主题列表、保存中和已保存。
- `contrast.json`：修正后浅色辅助文字的原始 PNG 像素取样。详情 5.109:1，导航 4.763:1；浏览器另检查实际前景与背景至少 4.5:1。

普通截图以 2 倍像素比保存。录屏为 1280×720。真实缩放截图直接捕获浏览器可见表面，不裁取 CSS 视口。

真实缩放使用临时浏览器资料目录中的原生默认页面缩放。配置依据为 [Chromium 的缩放偏好实现](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/zoom/chrome_zoom_level_prefs.cc)。浏览器窗口保持 1440×900。布局宽度从 1440 变为 720，像素比从 1 变为 2，`visualViewport.scale` 保持 1。测试执行主题切换、显示名保存、关闭返回与刷新复读。

自动验收位于 `tests/account-profile.test.ts`、`tests/account-settings-browser.test.ts`、`tests/account-settings-recovery-browser.test.ts` 和 `tests/account-settings-zoom-browser.test.ts`。核心与 HTTP 共 94 项通过。完整浏览器回归 58 项通过，随后新增真实缩放测试定向通过；共 59 个浏览器用例。GitHub 解除绑定响应丢失补充分支也已定向通过。

独立视觉评审发现浅色辅助文字对比度不足。修正限定在设置页，并已通过浏览器检查及截图复验。用户原 Notion 截图保存在 Obsidian UC 卡中。真实 GitHub OAuth App 回调、Windows 字体和手机软键盘不属于本轮已验证环境。
