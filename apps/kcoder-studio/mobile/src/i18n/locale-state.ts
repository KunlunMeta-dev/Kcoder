import { i18n } from "./instance";

export type Locale = "en" | "zh-CN";
export type LocalePreference = "system" | Locale;

let currentPreference: LocalePreference = "system";
let initialized = false;
let systemLocaleReader: (() => string | undefined) | null = null;
const listeners = new Set<() => void>();

function resolvedLocale(): Locale {
  const language = i18n.resolvedLanguage || i18n.language || "en";
  return /^zh(?:-|$)/i.test(language) ? "zh-CN" : "en";
}

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

i18n.on("languageChanged", () => {
  initialized = true;
  notifyListeners();
});

function getDeviceLocale(): Locale {
  let deviceLocale = "en";
  try {
    deviceLocale = systemLocaleReader?.() || "";
    if (!deviceLocale && typeof navigator !== "undefined")
      deviceLocale = navigator.languages?.[0] || navigator.language || "";
    if (!deviceLocale)
      deviceLocale = Intl.DateTimeFormat().resolvedOptions().locale;
  } catch { /* Environments without locale support use English. */ }
  return /^zh(?:-|$)/i.test(deviceLocale) ? "zh-CN" : "en";
}

function resolveLocale(preference: LocalePreference): Locale {
  return preference === "system" ? getDeviceLocale() : preference;
}

function publishLocale(next: Locale): void {
  const wasInitialized = initialized;
  initialized = true;
  if (next === resolvedLocale()) {
    if (!wasInitialized) notifyListeners();
    return;
  }
  // With bundled resources, i18next applies this synchronously and emits its
  // languageChanged event before returning.
  void i18n.changeLanguage(next);
}

export function initLocale(preferred: LocalePreference = "system"): void {
  currentPreference =
    preferred === "en" || preferred === "zh-CN" || preferred === "system"
    ? preferred
    : "system";
  publishLocale(resolveLocale(currentPreference));
}

export function getLocale(): Locale {
  if (!initialized) initLocale();
  return resolvedLocale();
}

export function setLocale(locale: Locale): void {
  setLocalePreference(locale);
}

export function setLocalePreference(preference: LocalePreference): void {
  if (preference !== "system" && preference !== "en" && preference !== "zh-CN")
    return;
  currentPreference = preference;
  publishLocale(resolveLocale(currentPreference));
}

export function getLocalePreference(): LocalePreference {
  return currentPreference;
}

/** Install the platform locale reader at the app composition boundary. */
export function setSystemLocaleReader(
  reader: (() => string | undefined) | null,
): void {
  systemLocaleReader = reader;
}

export function refreshSystemLocale(): void {
  if (currentPreference === "system") publishLocale(getDeviceLocale());
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
