/** Shared account responses and fixed OAuth feedback. */
export interface GithubStatus {
  enabled: boolean;
  identity: { id: string; login: string } | null;
  hasPassword: boolean;
  canUnlink: boolean;
}

export interface GithubSignup { login: string; displayName: string }

export const githubMessages = {
  cancelled: "已取消 GitHub 授权。你可以重新登录。",
  invalid_request: "GitHub 授权已失效，请重新发起。",
  unavailable: "暂时无法连接 GitHub，请重新登录。",
  registration_closed: "注册已关闭。已有账号请先用密码登录，再绑定 GitHub。",
  identity_in_use: "此 GitHub 身份已绑定其他 Notes 账号。",
  already_linked: "当前账号已绑定其他 GitHub 身份，请先解除原关联。",
  session_changed: "登录状态已变化，请重新进入目标账号后发起授权。",
  disabled: "GitHub 登录尚未启用。",
  linked: "GitHub 已绑定。",
} as const;

export type GithubResult = keyof typeof githubMessages;
