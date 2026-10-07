import type { InterfaceLanguage } from "@t3tools/contracts/settings";
import { useMemo } from "react";
import { useClientSettings } from "./hooks/useSettings";
import { zhCN } from "./locales/zh-CN";

const translations: Readonly<Record<InterfaceLanguage, Readonly<Record<string, string>>>> = {
  en: {},
  "zh-CN": zhCN,
};

/** Translate only explicitly listed interface copy. Unknown text stays in English. */
export function translate(language: InterfaceLanguage, source: string): string {
  const translated = translations[language][source];
  return typeof translated === "string" ? translated : source;
}

export function useT(): (source: string) => string {
  const language = useClientSettings((settings) => settings.language);
  return useMemo(() => (source: string) => translate(language, source), [language]);
}

export function useInterfaceLanguage(): InterfaceLanguage {
  return useClientSettings((settings) => settings.language);
}
