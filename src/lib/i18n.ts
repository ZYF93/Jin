import { useCallback, useSyncExternalStore } from "react";
import {
  translate,
  type Language,
  type MessageKey,
  type TranslationParams,
} from "../../shared/i18n";

let activeLanguage: Language = "en";
const listeners = new Set<() => void>();

export function getLanguage(): Language {
  return activeLanguage;
}

/** Set the interface language and notify every subscribed component. */
export function setLanguage(language: Language): void {
  if (activeLanguage === language) return;
  activeLanguage = language;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function localeTag(language: Language = activeLanguage): string {
  return language === "zh" ? "zh-CN" : "en-US";
}

/** Translate outside React, using the current interface language. */
export function t(key: MessageKey, params?: TranslationParams): string {
  return translate(activeLanguage, key, params);
}

export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, getLanguage, getLanguage);
}

/** A memoized translator that re-renders when the language changes. */
export function useT(): (key: MessageKey, params?: TranslationParams) => string {
  const language = useLanguage();
  return useCallback(
    (key: MessageKey, params?: TranslationParams) => translate(language, key, params),
    [language],
  );
}
