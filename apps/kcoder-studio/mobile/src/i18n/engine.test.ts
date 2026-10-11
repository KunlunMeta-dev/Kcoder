import { beforeEach, describe, expect, test, vi } from "vitest";
import { en } from "./locales/en";
import { zhCN } from "./locales/zh-CN";
import { getLocale, initLocale, setLocalePreference, subscribeLocale } from "./locale-state";
import { i18n } from "./instance";
import { t } from "./index";

const dictionaries = { en, "zh-CN": zhCN } as const;

function legacyTranslation(
  locale: keyof typeof dictionaries,
  key: string,
  params?: Record<string, string | number>,
): string {
  const raw = dictionaries[locale][key] ?? en[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (match, name: string) =>
    params[name] !== undefined ? String(params[name]) : match,
  );
}

function parametersFor(message: string): Record<string, string | number> {
  const names = new Set([...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]));
  return Object.fromEntries([...names].map((name) => [name, `${name}-value`]));
}

describe("mobile i18next engine", () => {
  beforeEach(() => {
    initLocale("en");
  });

  test("matches the previous flat-dictionary lookup for every bundled key and locale", () => {
    for (const locale of ["en", "zh-CN"] as const) {
      setLocalePreference(locale);
      for (const [key, message] of Object.entries(dictionaries[locale])) {
        const params = parametersFor(message);
        expect(t(key)).toBe(legacyTranslation(locale, key));
        expect(t(key, params)).toBe(legacyTranslation(locale, key, params));
      }
    }
  });

  test("keeps option-like parameter names as interpolation data", () => {
    const key = "__i18n_reserved_parameter_test__";
    const message = "{count}|{lng}|{defaultValue}|{t}";
    const resources = i18n.store.data.en.translation as Record<string, string>;
    resources[key] = message;
    try {
      setLocalePreference("en");
      expect(t(key, {
        count: "count-value",
        lng: "lng-value",
        defaultValue: "default-value",
        t: "t-value",
      })).toBe("count-value|lng-value|default-value|t-value");
    } finally {
      delete resources[key];
    }
  });

  test("uses English for a missing Chinese translation and preserves missing placeholders", () => {
    const key = "common.back";
    const zhResources = i18n.store.data["zh-CN"].translation as Record<string, string>;
    const previous = zhResources[key];
    delete zhResources[key];
    try {
      setLocalePreference("zh-CN");
      expect(t(key)).toBe("Back");
      expect(t("output.tools")).toBe("工具调用 · {count}");
      expect(t("missing:section")).toBe("missing:section");
    } finally {
      zhResources[key] = previous;
    }
  });

  test("does not HTML-escape or re-interpolate caller values", () => {
    const raw = "<tag>&/$/{count}";
    setLocalePreference("en");
    expect(t("sessions.scoped_notice", { p0: raw, p1: raw, p2: raw }))
      .toBe(`${raw} · ${raw}: ${raw}`);
  });

  test("uses i18next language events as the resolved locale source", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLocale(listener);
    try {
      setLocalePreference("zh-CN");
      expect(i18n.resolvedLanguage).toBe("zh-CN");
      expect(getLocale()).toBe("zh-CN");
      expect(listener).toHaveBeenCalledTimes(1);

      setLocalePreference("zh-CN");
      expect(listener).toHaveBeenCalledTimes(1);

      void i18n.changeLanguage("en");
      expect(getLocale()).toBe("en");
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      initLocale("en");
    }
  });
});
