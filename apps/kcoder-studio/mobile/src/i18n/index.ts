import { getLocale } from "./locale-state";
import { translate } from "./instance";

export {
  getLocale,
  getLocalePreference,
  initLocale,
  refreshSystemLocale,
  setLocale,
  setLocalePreference,
  setSystemLocaleReader,
  subscribeLocale,
} from "./locale-state";
export type { Locale, LocalePreference } from "./locale-state";
export type { TranslationParams } from "./instance";
export type LocaleMessages = Record<string, string>;

export function t(
  key: string,
  params?: Record<string, string | number>,
): string {
  // Preserve the existing lazy system-locale initialization on first use.
  getLocale();
  return translate(key, params);
}
