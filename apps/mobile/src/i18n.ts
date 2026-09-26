import type { InterfaceLanguage } from "@t3tools/contracts/settings";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo } from "react";
import { mobilePreferencesAtom } from "./state/preferences";

const zhCN: Readonly<Record<string, string>> = {
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
