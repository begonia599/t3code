import type { InterfaceLanguage } from "@t3tools/contracts/settings";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo } from "react";
import { mobilePreferencesAtom } from "./state/preferences";

const zhCN: Readonly<Record<string, string>> = {
  "This path contains too many symbolic links.": "此路径包含过多符号链接。",
  "Duplicate JSON keys require the raw editor. Your draft was kept unchanged.":
    "JSON 存在重复键，请在原文中编辑，草稿未被修改。",
  "Editor range": "控件可输入范围",
  "Show more": "显示更多",
  "Refresh agent skills": "刷新智能体技能",
  "Skills discovery refreshed. Loading in the running session is not confirmed.":
    "已刷新技能发现结果；尚未确认运行中的会话是否已加载。",
  "This field has an incompatible parent value. Use the raw editor to repair it.":
    "此字段的上级值类型不兼容，请在原文中修复。",
  "The file changed while being read. Reload it to continue.": "读取期间文件发生变化，请重新读取。",
  "The file changed immediately after saving. Reload it to inspect the latest contents.":
    "保存后文件立即被其他程序修改，请重新读取以检查最新内容。",
  "Native configuration editing is available for Codex and Claude Code instances.":
    "目前仅支持编辑 Codex 和 Claude Code 实例的原生配置。",
  "Provider settings are unavailable.": "提供方设置暂不可用。",
  "This Codex instance has invalid runtime settings.": "此 Codex 实例的运行配置无效。",
  "This Claude instance has invalid runtime settings.": "此 Claude 实例的运行配置无效。",
  "Could not create a configuration operation identifier.": "无法创建配置操作标识。",
  "Native configuration": "原生配置",
  "Configuration scope": "配置范围",
  "User files": "用户文件",
  "Native files": "原生文件",
  "Search native files": "搜索原生文件",
  "Refresh list": "刷新列表",
  "Instance home": "实例配置目录",
  "Runtime overrides are present": "存在运行时覆盖项",
  "Values are not displayed here. T3 session options and launch arguments may override file settings.":
    "此处不展示变量值。T3 会话选项和启动参数可能覆盖文件设置。",
  "These are native files, not an effective-settings report. Project trust, parent instructions, policies, environment variables and T3 session options can change what the agent loads.":
    "这里展示原生文件，并不代表最终生效配置。项目是否受信任、上级目录指令、策略、环境变量和 T3 会话选项均可能影响加载结果。",
  "Some sources could not be listed or the discovery limit was reached.":
    "部分来源无法列出，或已达到目录扫描上限。",
  Editable: "可编辑",
  "Read-only": "只读",
  "Not created": "尚未创建",
  user: "用户级",
  project: "项目级",
  local: "项目本地",
  managed: "受管理策略",
  memory: "记忆",
  settings: "设置",
  instructions: "指令",
  rules: "规则",
  skill: "技能",
  "Graphical settings": "图形设置",
  "Raw editor": "原文编辑",
  "Reload saved file": "重新读取已保存文件",
  "Native file contents": "原生文件内容",
  "Working…": "处理中…",
  Save: "保存",
  "Preview changes": "预览差异",
  "Discard draft": "丢弃草稿",
  "Undo save": "撤销保存",
  Changes: "修改差异",
  "Saved file contents": "已保存的文件内容",
  "Empty file": "空文件",
  "Loading native files…": "正在读取原生文件…",
  "Select a native file to view or edit.": "选择原生文件以查看或编辑。",
  "Saved to the native file. Loading in the running session is not confirmed.":
    "已保存到原生文件；尚未确认运行中的会话是否已加载。",
  "The previous file contents were restored.": "已恢复保存前的文件状态。",
  "Reloaded the saved file and kept your draft. Review the differences before saving.":
    "已重新读取文件并保留草稿。请比较最新差异后再保存。",
  "The configuration operation failed.": "配置操作失败。",
  "Discard unsaved changes and close?": "丢弃未保存的修改并关闭？",
  "Keep editing": "继续编辑",
  "Discard and close": "丢弃并关闭",
  Close: "关闭",
  "Verified fields: Codex 0.160.1 / Claude Code 2.1.291. Other fields remain available in the raw editor. Unset means inherit; no defaults are written automatically.":
    "本批字段依据 Codex 0.160.1 / Claude Code 2.1.291 核验。其他字段可在原文中编辑。未设置表示继承，不会自动写入默认值。",
  "The draft has invalid syntax. Use the raw editor to repair it.":
    "草稿语法有误，请切换原文编辑进行修复。",
  "Search settings or native field names": "搜索设置或原生字段名",
  "Inherit / native default": "继承／原生默认",
  "Set in draft": "写入草稿",
  "Remove override": "移除覆盖值",
  "Response verbosity": "回复详细程度",
  "Response detail for models that support verbosity.":
    "控制回复详细程度，仅对支持此选项的模型生效。",
  "Reasoning summary": "推理摘要",
  "Summary detail for models that support reasoning summaries.":
    "控制推理摘要的详细程度，仅对支持此选项的模型生效。",
  "Tool output budget": "工具输出预算",
  "Maximum tokens retained from an individual tool result.":
    "单次工具结果在上下文中保留的最大 token 数。",
  "Automatic compaction threshold": "自动压缩阈值",
  "Token threshold for automatic context compaction. This does not select local or cloud compaction.":
    "触发上下文自动压缩的 token 阈值，此字段不选择本地或云端压缩。",
  "Default command timeout": "命令默认超时",
  "Default Bash command timeout in milliseconds (native default: 120000).":
    "Bash 命令默认超时，单位毫秒，原生默认值为 120000。",
  "Maximum command timeout": "命令最大超时",
  "Requested Bash timeout ceiling in milliseconds (native default: 600000). The effective ceiling is at least the default timeout.":
    "Bash 命令允许请求的超时上限，单位毫秒，原生默认值为 600000。实际有效上限至少等于默认超时。",
  "Command output limit": "命令输出上限",
  "Bash output character limit (native default: 30000; maximum: 150000). bashOutputMaxChars takes precedence.":
    "Bash 输出字符上限，原生默认值 30000，最高 150000；bashOutputMaxChars 字段的优先级更高。",
  "Enter a whole number within the displayed range.": "请输入所示范围内的整数。",
  "Choose a supported value.": "请选择支持的值。",
  "This TOML layout requires the raw editor. Your draft was kept unchanged.":
    "此 TOML 写法需在原文中编辑，草稿未被修改。",
  "The file changed outside this editor. Reload it before saving; your draft has been kept.":
    "文件已被外部修改。请先重新读取再保存，草稿已保留。",
  "The file changed after your save. Undo was stopped to preserve those changes.":
    "保存后文件又被修改，已停止撤销以保留这些改动。",
  "Undo is no longer available. Reload the file to continue.":
    "此次保存已无法撤销，请重新读取文件后继续。",
  "Invalid TOML. The file was not changed.": "TOML 格式无效，文件未被修改。",
  "Invalid JSON object. The file was not changed.": "JSON 对象格式无效，文件未被修改。",
  "This native configuration source is read-only.": "此原生配置来源为只读。",
  "This file is not UTF-8 text.": "此文件不是 UTF-8 文本。",
  "This file exceeds the 256 KiB editor limit.": "此文件超过编辑器的 256 KiB 上限。",
  "Only text files up to 256 KiB can be edited.": "仅支持编辑不超过 256 KiB 的文本文件。",
  "Only text files up to 256 KiB can be saved.": "仅支持保存不超过 256 KiB 的文本文件。",
  "This path is not a regular file.": "此路径不是普通文件。",
  "This file cannot be accessed.": "无法访问此文件。",
  "The native configuration file could not be accessed. Check its path and permissions.":
    "无法访问原生配置文件，请检查路径和权限。",
  "This file is no longer in the instance's native configuration sources. Refresh the file list.":
    "此文件已不在实例的原生配置来源中，请刷新文件列表。",
  "This change is too large for a diff preview. Compare the saved file with the raw draft.":
    "此次改动过大，无法生成差异预览，请比较已保存内容与原文草稿。",
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
};

const translations: Readonly<Record<InterfaceLanguage, Readonly<Record<string, string>>>> = {
  en: {},
  "zh-CN": zhCN,
};

export function translate(language: InterfaceLanguage, source: string): string {
  const translated = translations[language][source];
  return typeof translated === "string" ? translated : source;
}

export function useMobileLanguage(): InterfaceLanguage {
  const result = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(result) ? (result.value.language ?? "en") : "en";
}

export function useMobileT(): (source: string) => string {
  const language = useMobileLanguage();
  return useMemo(() => (source: string) => translate(language, source), [language]);
}
