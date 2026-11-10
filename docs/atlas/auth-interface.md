# 登录与注册界面

verified: 2026-11-04

登录与注册共用单列表单。页面使用浅暖灰背景、白色卡片和蓝色主操作。品牌使用 [Notes 图标](brand.md)。用户可以直接登录，或切换到创建账号。

## 表单行为

- 密码默认隐藏。显示或隐藏密码时，保留已填写内容。
- 注册规则仅在注册模式显示。创建账号与返回登录的入口位于卡片下方。
- 请求期间显示进度，并禁用重复提交。请求失败后保留字段，用户可修改后重试。
- 支持键盘提交。窄屏中，字段、规则、提交和返回入口均可到达。

页面沿用账号注册开关、密码策略和会话规则。当前未提供找回密码或第三方登录入口。

## 界面约定

品牌、标题、字段和次级入口通过间距、字重及颜色区分。表单采用单列结构，不增加宣传区域。卡片宽度为 400px。正文为 14px，标题为 24px。输入框和主操作在桌面为 42px，在手机为 44px。

卡片入场、模式切换和密码显示使用短过渡。减少动态设置禁用相关过渡。实现入口见 [AuthGate](../../src/features/account/AuthGate.tsx)与[账号样式](../../src/features/account/account.css)。

## 验证与追溯

本页关联 UC-02。已有浏览器验收覆盖真实注册与登录、错误后保留字段、密码显示和键盘提交。桌面与手机的登录、注册状态均已取证。Windows 字体和手机软键盘未实机验证。

查看 [桌面登录](../evidence/auth-interface/login-desktop.png)、[手机登录](../evidence/auth-interface/login-mobile.png)和[手机注册](../evidence/auth-interface/register-mobile.png)。这些截图记录界面优化时的状态；品牌图标随后更新，当前图标见 [登录页图标证据](../evidence/notes-icon/login@2x.png)。

设计取舍与完整验收记录见 [归档执行稿](../dev/archive/auth-interface.md)和[交付记录](../dev/archive/auth-interface-delivery.md)。
