import { en } from "./locales/en";
import { zhCN } from "./locales/zh-CN";

export type Locale = "en" | "zh-CN";
export type LocaleMessages = Record<string, string>;

const LOCALES: Record<Locale, LocaleMessages> = {
  en,
  "zh-CN": zhCN,
};

let currentLocale: Locale = "en";
let initialized = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function initLocale(preferred?: Locale): void {
  currentLocale = preferred && preferred in LOCALES ? preferred : "en";
  initialized = true;
  notify();
}

export function getLocale(): Locale {
  if (!initialized) initLocale();
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  if (!(locale in LOCALES)) return;
  if (initialized && locale === currentLocale) return;
  currentLocale = locale;
  initialized = true;
  notify();
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function t(
  key: string,
  params?: Record<string, string | number>
): string {
  const raw = LOCALES[getLocale()][key] ?? en[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (match, name: string) =>
    params[name] !== undefined ? String(params[name]) : match
  );
}
