import type { InterfaceLanguage } from "@t3tools/contracts/settings";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo } from "react";
import { mobilePreferencesAtom } from "./state/preferences";

const zhCN: Readonly<Record<string, string>> = {
  "Claude account": "Claude 账号",
  "Grok account": "Grok 账号",
  "Sign in with Claude": "使用 Claude 登录",
  "Sign in with Grok": "使用 Grok 登录",
  "Sign out of Claude?": "退出此 Claude 账号？",
  "Sign out of Grok?": "退出此 Grok 账号？",
  "Enable this instance to sign in.": "启用此实例后即可登录。",
  "Browser sign-in is unavailable for this instance's authentication settings.":
    "此实例的认证配置不支持浏览器登录，请检查实例配置或环境版本。",
  "Waiting for sign-in.": "正在等待登录。",
  "Signed in.": "已登录。",
  "Sign in with your account.": "使用你的账号登录。",
  "Could not update sign-in. Try again.": "无法更新登录状态，请重试。",
  "Open the authorization page, then paste the code it gives you below.":
    "打开授权页面，完成授权后将页面给出的授权码粘贴到下方。",
  "Authorization code": "授权码",
  "Submit authorization code": "提交授权码",
  "Could not run the instance's login command. Check its CLI, execution environment, and network.":
    "无法运行此实例的登录命令，请检查其 CLI、执行环境和网络。",
  "The login command returned too much output. Check the CLI version and try again.":
    "登录命令输出异常，请检查 CLI 版本后重试。",
  "Enter the authorization code from the browser as a single line.":
    "请填写浏览器给出的授权码，内容必须为单行。",
  "Could not send the authorization code. Start sign-in again.": "无法提交授权码，请重新发起登录。",
  "Sign-in did not complete. Update the CLI if needed and try again.":
    "登录未完成，请检查或更新 CLI 后重试。",
  "The CLI did not provide a supported sign-in link. Update it and try again.":
    "CLI 未提供支持的登录链接，请更新后重试。",
  "Could not verify the new account. Refresh provider status before retrying.":
    "无法核验新账号，请刷新提供方状态后再重试。",
  "The CLI did not confirm an account login. Check this instance's authentication settings.":
    "CLI 未确认账号登录，请检查此实例的认证设置。",
  "Could not sign out. Try again.": "无法退出登录，请重试。",
  "Codex account": "Codex 账号",
  "Authorize this instance in your browser without SSH.": "在浏览器中为此实例授权，无需 SSH。",
  "Enable this Codex instance to sign in.": "启用此 Codex 实例后即可登录。",
  "Update this environment to sign in to Codex.": "更新此环境后即可在这里登录 Codex。",
  "Reading sign-in status.": "正在读取登录状态。",
  "Waiting for Codex sign-in.": "正在等待 Codex 登录。",
  "Signed in to Codex.": "已登录 Codex。",
  "Sign in with your ChatGPT account.": "使用你的 ChatGPT 账号登录。",
  "Sign in with ChatGPT": "使用 ChatGPT 登录",
  "Retry sign-in": "重试登录",
  "Cancel sign-in": "取消登录",
  "Sign out": "退出登录",
  "Sign out of Codex?": "退出此 Codex 账号？",
  "This stops running threads using this sign-in. Thread history is kept.":
    "这会停止使用此账号的运行中会话，会话历史将保留。",
  "Open the authorization page and enter this one-time code.": "打开授权页面并输入此一次性验证码。",
  "Open authorization page": "打开授权页面",
  "Copy code": "复制验证码",
  "Code copied": "验证码已复制",
  "Expires at": "到期时间",
  "Provider setup is read-only.": "当前连接只有查看权限。",
  "Retry setup status": "重新读取登录状态",
  "Starting sign-in.": "正在启动登录。",
  "Complete sign-in to continue.": "完成授权后将自动继续。",
  "Checking provider sign-in.": "正在核验登录结果。",
  "Sign-in complete.": "登录完成。",
  "Sign-in cancelled.": "已取消登录。",
  "Sign-in expired. Start again.": "登录已过期，请重新发起。",
  "Signed out.": "已退出登录。",
  "Sign-in is in progress in another client.": "另一个客户端正在登录，请在该客户端完成或取消。",
  "Could not update Codex sign-in. Try again.": "无法更新 Codex 登录状态，请重试。",
  "Could not open the sign-in page. Open the displayed link in your browser.":
    "无法打开授权页面，请在浏览器中打开显示的链接。",
  "Could not copy the code. Enter the displayed code manually.":
    "无法复制验证码，请手动输入显示的验证码。",
  "Could not start Codex sign-in. Check the instance's CLI and network.":
    "无法启动 Codex 登录，请检查此实例的 CLI 和网络。",
  "Could not start device-code login. Update Codex, enable device-code login in ChatGPT, and check the instance's network.":
    "无法启动设备码登录，请更新 Codex、在 ChatGPT 中启用设备码登录，并检查此实例的网络。",
  "This Codex version did not return a device-code login. Update Codex and try again.":
    "此 Codex 版本未返回设备码登录信息，请更新后重试。",
  "Codex returned an invalid device-code login.": "Codex 返回的设备码登录信息无效。",
  "Codex sign-in failed or expired. Start again.": "Codex 登录失败或已过期，请重试。",
  "Could not verify the Codex account. Refresh provider status before retrying.":
    "无法核验 Codex 账号，请刷新提供方状态后再重试。",
  "Codex did not report a ChatGPT account. Check the instance's authentication settings.":
    "Codex 未返回 ChatGPT 账号，请检查此实例的认证设置。",
  "Codex exited before sign-in could be verified. Start again.":
    "Codex 在完成登录核验前退出，请重试。",
  "The Codex login process could not be monitored. Start again.":
    "无法监测 Codex 登录进程，请重试。",
  "Could not sign out of Codex. Try again.": "无法退出 Codex 登录，请重试。",
  "Credential use": "凭证用途",
  "Shell and tool bindings": "Shell 和工具绑定",
  "Tool bindings only": "仅用于工具绑定",
  "Native gh tool bindings": "原生 gh 工具授权",
  "Add gh binding": "添加 gh 授权",
  "Use T3 GitHub login": "继承 T3 GitHub 授权",
  Enable: "启用",
  "Verify binding": "验证授权",
  "gh binding configuration": "gh 授权配置",
  "Invalid gh binding configuration.": "gh 授权配置格式不正确。",
  "Managed instances automatically use T3's current GitHub CLI login. You can revoke an instance or override its authorization. GitHub App bindings can limit repository access.":
    "托管实例自动使用 T3 当前的 GitHub CLI 登录。可按实例撤销或覆盖授权，也可通过 GitHub App 限制仓库范围。",
  "For host-login, enter the account already logged in on T3 and leave repositories empty. GitHub App bindings use a vault private-key reference with Tool bindings only.":
    "使用 host-login 时，填写 T3 上已经登录的账号，并将 repositories 留空。GitHub App 授权通过凭证名引用私钥，其用途设为“仅用于工具绑定”。",
  "Application publishing": "应用发布",
  "Publish business projects with Docker Compose. Applications survive chat and T3 restarts. The controlling T3 framework is protected.":
    "通过 Docker Compose 发布业务项目。应用独立运行，聊天结束或 T3 重启不会停止它。管理框架本身受到保护。",
  "Provider instance": "提供方实例",
  "Refresh applications": "刷新应用",
  Manage: "管理",
  "No public route": "未开放公网入口",
  "Status / wait for operation": "状态 / 等待操作",
  "Inspect release": "查看版本配置",
  "Runtime logs": "运行日志",
  "Operation logs": "操作日志",
  "Release history": "发布历史",
  "Withdraw application": "撤回应用",
  "New application": "新建应用",
  Operation: "操作",
  Recovery: "恢复情况",
  "Restore release": "恢复此版本",
  "Log output was truncated.": "日志输出已截断。",
  "Next log page": "下一页日志",
  "Project directory": "项目目录",
  "Compose file": "Compose 文件",
  "Application name": "应用名称",
  "Public hostname (optional)": "公网域名（可选）",
  "Publish new release": "发布新版本",
  "Publish application": "发布应用",
  "Declare healthchecks and container-only ports in Compose. Updates replace the running version; rollback preserves persistent data. An empty hostname publishes privately.":
    "Compose 必须声明健康检查和容器端口。更新会替换运行版本；回滚保留持久数据。新应用不填写域名时仅私有托管。",
  "Could not manage applications.": "无法管理应用。",
  "Enter a project directory and a valid application name.": "请填写项目目录和有效的应用名称。",
  unpublished: "未发布",
  failed: "失败",
  ready: "就绪",
  disabled: "已禁用",
  not_checked: "尚未验证",
  not_allowed: "未获授权",
  not_configured: "尚未配置",
  credential_expired: "凭证不可用",
  validating: "正在验证",
  queued: "已排队",
  building: "正在构建",
  starting: "正在启动",
  "checking-health": "正在检查健康",
  "switching-route": "正在切换入口",
  stopping: "正在停止",
  succeeded: "成功",
  // Resource management
  "Credential vault": "凭证库",
  "Hosted MCP services": "托管 MCP 服务",
  "Variable name": "变量名",
  Description: "说明",
  "Value type": "值类型",
  "Private value": "私密值",
  Token: "令牌",
  "Allowed provider instances": "允许使用的实例",
  "Add credential": "添加凭证",
  "Add MCP service": "添加 MCP 服务",
  "No instances allowed": "未授权任何实例",
  Revoke: "撤销",
  "Private input requested": "需要填写私密变量",
  "Dismiss request": "拒绝此次请求",
  "MCP configuration": "MCP 配置",
  "Invalid MCP configuration.": "MCP 配置格式不正确。",
  "Loading resources…": "正在加载资源…",
  "Administrator access is required to manage resources.": "需要管理员权限才能管理资源。",
  "Could not load resources. Administrator access is required.":
    "无法加载资源，请检查管理员权限和连接。",
  "Could not save resources. Check your connection and administrator access.":
    "保存失败，请检查连接和管理员权限。",
  "Enter a valid variable name and a private value.": "请输入有效的变量名和私密值。",
  "Leave blank to keep the existing value.": "留空保留现有值。",
  "This value is saved directly to the vault and is not sent as a chat message.":
    "此值直接保存到凭证库，不会作为聊天消息发送。",
  "Manage application credentials here. Agents can list metadata and request use without viewing values.":
    "在此管理应用凭证。智能体可以查询元数据并申请使用，无需查看凭证值。",
  "T3 runs local MCP services and connects remote services. Bind credentials by name; reconnect the agent after adding a service.":
    "T3 负责运行本地 MCP 服务并连接远程服务。通过变量名绑定凭证；添加服务后请重新连接智能体。",
  "Use credential references in environment or headers. Never paste secret values into this configuration.":
    "在 environment 或 headers 中引用凭证名称，不要将凭证值粘贴到此配置。",
  stopped: "已停止",
  running: "运行中",
  error: "错误",
  Restart: "重启",
  Start: "启动",
  Stop: "停止",

  Settings: "设置",
  Connections: "连接",
  "T3 Account": "T3 账户",
  Environments: "环境",
  Notifications: "通知",
  Interface: "界面",
  Appearance: "外观",
  Keyboard: "键盘",
  Language: "语言",
  "Choose the language used on this device.": "选择此设备使用的界面语言。",
  English: "English",
  "Simplified Chinese": "简体中文",
  Cancel: "取消",
  "Projects & threads": "项目与会话",
  Overview: "概览",
  Organization: "组织方式",
  "Thread behavior": "会话行为",
  "Archived Threads": "已归档会话",
  "Server settings": "服务器设置",
  "New threads": "新会话",
  "Source control": "版本控制",
  "Agent behavior": "智能体行为",
  Maintenance: "维护",
  App: "应用",
  Usage: "用量",
  "About T3 Code": "关于 T3 Code",
  Checking: "正在检查",
  "Sign in": "登录",
  "Signed in": "已登录",
  Text: "文字",
  "Text size": "文字大小",
  Theme: "主题",
  Terminal: "终端",
  Code: "代码",
  "Go back": "返回",
  "Across environments": "跨环境",
  Actions: "操作",
  "Agent activity": "智能体活动",
  "Auto-settle": "自动结束",
  Checkouts: "检出",
  "Client Storage": "客户端存储",
  "Code & Diffs": "代码与差异",
  Connection: "连接",
  "Default branch": "默认分支",
  "Default permissions": "默认权限",
  "Default workspace": "默认工作区",
  Diagnostics: "诊断",
  "Environment caches": "环境缓存",
  "Environment options": "环境选项",
  Legacy: "旧版功能",
  Legal: "法律信息",
  "License notice": "许可声明",
  "Live Update Settings": "实时更新设置",
  "Manage environments": "管理环境",
  "Open source licenses": "开源许可证",
  "Preview browser": "预览浏览器",
  Project: "项目",
  "Project grouping": "项目分组",
  "Project overview": "项目概览",
  Providers: "服务提供方",
  "Response streaming": "回复流式显示",
  "Return key": "回车键",
  "T3 Code": "T3 Code",
  "Turn off Live Activity preference": "关闭实时活动偏好",
  Updates: "更新",
  "Worktree submodules": "工作树子模块",
  Worktrees: "工作树",
  "Execution environment": "执行环境",
  "Linux sandbox": "Linux 沙箱",
  "Sandbox profile": "沙箱配置",
  "The host profile controls shared folders, tools and network routing. Provider environment values remain readable inside the sandbox.":
    "共享目录、工具和网络出口由服务器配置控制。提供方环境变量的值在沙箱内仍可读取。",
  "Invalid sandbox profile": "沙箱配置名称无效",
  "Use a letter followed by letters, numbers, underscores or hyphens (up to 64 characters).":
    "名称以字母开头，可使用字母、数字、下划线和连字符，最长 64 个字符。",
  "Could not save sandbox settings.": "无法保存沙箱设置。",
};

const translations: Readonly<Record<InterfaceLanguage, Readonly<Record<string, string>>>> = {
  en: {},
  "zh-CN": zhCN,
};

export function translate(language: InterfaceLanguage, source: string): string {
  return translations[language][source] ?? source;
}

export function useMobileLanguage(): InterfaceLanguage {
  const result = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(result) ? (result.value.language ?? "en") : "en";
}

export function useMobileT(): (source: string) => string {
  const language = useMobileLanguage();
  return useMemo(() => (source: string) => translate(language, source), [language]);
}
