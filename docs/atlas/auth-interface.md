# 登录与注册界面

verified: 2026-11-10

登录与注册共用单列表单。页面使用浅暖灰背景、白色卡片和蓝色主操作。品牌使用 [Notes 图标](brand.md)。用户可以直接登录，或切换到创建账号。

## 表单行为

- 密码默认隐藏。显示或隐藏密码时，保留已填写内容。
- 注册规则仅在注册模式显示。创建账号与返回登录的入口位于卡片下方。
- 请求期间显示进度，并禁用重复提交。请求失败后保留字段，用户可修改后重试。
- 支持键盘提交。窄屏中，字段、规则、提交和返回入口均可到达。

页面沿用账号注册开关、密码策略和会话规则。GitHub 配置完整时，表单下方显示中性 GitHub 登录入口。当前未提供找回密码。

GitHub 同名账号选择页提供新注册与原账号密码登录入口，不自动合并身份。账号设置的“账号 → 登录方式”支持绑定与解除绑定。纯 GitHub 账号保留唯一登录方式。配置方法见 [GitHub 登录](../../README.md#github-登录)。

## 账号设置

侧栏底部的账号入口打开设置。桌面使用左侧分类与右侧详情。手机先显示分类，详情提供“返回设置”。分类包含账号、偏好、邀请和 Agent 令牌；账号管理仅对站点管理员显示。

账号页支持保存显示名，用户名保持只读。保存后，当前界面和后续作者信息使用新名称。历史作者快照保持原值。偏好页和侧栏主题快捷入口使用同一份个人偏好。搜索只查找设置名称，不搜索笔记或令牌原文。

切换分类保留本次表单输入。关闭或退出前，未保存的资料需要明确放弃。新令牌原文离开前提示隐藏后果，隐藏后不能再次读取。提交期间阻止切换和重复操作。退出登录先等待笔记保存；保存失败时保留会话。

设置使用现有 Modal、Select、头像与主题 Token。浅色辅助文字在设置页内加强对比度。查看 [浅色账号设置](../evidence/account-settings/desktop-account-light-1440x900@2x.png)、[深色账号设置](../evidence/account-settings/desktop-account-dark-1440x900@2x.png)和[手机分类](../evidence/account-settings/mobile-navigation-light@2x.png)。

## 界面约定

品牌、标题、字段和次级入口通过间距、字重及颜色区分。表单采用单列结构，不增加宣传区域。卡片宽度为 400px。正文为 14px，标题为 24px。输入框和主操作在桌面为 42px，在手机为 44px。

卡片入场、模式切换和密码显示使用短过渡。减少动态设置禁用相关过渡。实现入口见 [AuthGate](../../src/features/account/AuthGate.tsx)与[账号样式](../../src/features/account/account.css)。

## 验证与追溯

本页关联 UC-02、UC-11 与 UC-12。已有浏览器验收覆盖真实注册与登录、错误后保留字段、密码显示和键盘提交。桌面与手机的登录、注册状态均已取证。Windows 字体和手机软键盘未实机验证。

查看 [桌面登录](../evidence/auth-interface/login-desktop.png)、[手机登录](../evidence/auth-interface/login-mobile.png)和[手机注册](../evidence/auth-interface/register-mobile.png)。这些截图记录界面优化时的状态；品牌图标随后更新，当前图标见 [登录页图标证据](../evidence/notes-icon/login@2x.png)。

GitHub 流程新增 17 项 HTTP 验收与 4 项浏览器验收。浏览器实际执行授权跳转、同名选择、绑定、解除绑定和失败恢复。GitHub 由本地 HTTP 替身提供，真实 OAuth App 回调尚未实测。查看 [GitHub 登录页](../evidence/github-auth/login-desktop@2x.png)、[手机登录页](../evidence/github-auth/login-mobile@2x.png)、[绑定状态](../evidence/github-auth/linked-desktop@2x.png)和[同名选择](../evidence/github-auth/same-name-desktop@2x.png)。

设计取舍与完整验收记录见 [归档执行稿](../dev/archive/auth-interface.md)和[交付记录](../dev/archive/auth-interface-delivery.md)。
