import { createInstance } from "i18next";
import { en } from "./locales/en";
import { zhCN } from "./locales/zh-CN";

export type TranslationParams = Record<string, string | number>;

/**
 * Mobile owns an isolated i18next instance so it never changes another
 * react-i18next consumer's active language.
 */
export const i18n = createInstance();

void i18n.init({
  lng: "en",
  resources: {
    en: { translation: en },
    "zh-CN": { translation: zhCN },
  },
  supportedLngs: ["en", "zh-CN"],
  load: "currentOnly",
  fallbackLng: "en",
  ns: ["translation"],
  defaultNS: "translation",
  keySeparator: false,
  nsSeparator: false,
  returnNull: false,
  returnEmptyString: true,
  returnObjects: false,
  initAsync: false,
  interpolation: {
    prefix: "{",
    suffix: "}",
    escapeValue: false,
    skipOnVariables: true,
  },
  react: {
    useSuspense: false,
    bindI18n: "languageChanged",
  },
});

/** Translate without giving interpolation names special option semantics. */
export function translate(
  key: string,
  params?: TranslationParams,
): string {
  const options = params === undefined ? undefined : { replace: params };
  return String(i18n.t(key, options));
}
