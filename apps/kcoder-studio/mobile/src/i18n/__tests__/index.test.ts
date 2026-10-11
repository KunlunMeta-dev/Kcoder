import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

describe("mobile i18n", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  test("uses the device language unless explicitly overridden", async () => {
    vi.stubGlobal("navigator", { language: "zh-Hans-SG" });
    const { initLocale, getLocale, setLocalePreference } = await import("../index");
    initLocale();
    expect(getLocale()).toBe("zh-CN");
    initLocale("en");
    expect(getLocale()).toBe("en");
    setLocalePreference("system");
    expect(getLocale()).toBe("zh-CN");
  });

  test("uses English for non-Chinese system locales and refreshes on return to foreground", async () => {
    vi.stubGlobal("navigator", { language: "ja-JP" });
    const { initLocale, getLocale, refreshSystemLocale, setLocalePreference } = await import("../index");
    initLocale("system");
    expect(getLocale()).toBe("en");

    vi.stubGlobal("navigator", { language: "zh-TW" });
    refreshSystemLocale();
    expect(getLocale()).toBe("zh-CN");

    setLocalePreference("en");
    vi.stubGlobal("navigator", { language: "zh-CN" });
    refreshSystemLocale();
    expect(getLocale()).toBe("en");
  });

  test("uses an injected system locale reader and refreshes it when requested", async () => {
    let systemLocale = "zh-Hant-TW";
    const { initLocale, getLocale, refreshSystemLocale, setSystemLocaleReader } = await import("../index");
    setSystemLocaleReader(() => systemLocale);
    initLocale();
    expect(getLocale()).toBe("zh-CN");

    systemLocale = "fr-FR";
    refreshSystemLocale();
    expect(getLocale()).toBe("en");
  });

  test("defaults to the en locale", { timeout: 20000 }, async () => {
    const { getLocale, initLocale } = await import("../index");
    initLocale();
    expect(getLocale()).toBe("en");
  });

  test("resolves keys from the active locale", { timeout: 20000 }, async () => {
    const { initLocale, t } = await import("../index");
    initLocale();
    expect(t("common.back")).toBe("Back");
  });

  test("resolves keys from zh-CN after switching locales", { timeout: 20000 }, async () => {
    const { initLocale, setLocale, t } = await import("../index");
    initLocale();
    setLocale("zh-CN");
    expect(t("common.back")).toBe("返回");
  });

  test("resolves the version label in Simplified Chinese", { timeout: 20000 }, async () => {
    const { initLocale, setLocale, t } = await import("../index");
    initLocale();
    setLocale("zh-CN");
    expect(t("welcome.version_line")).toBe("KCoder Studio Mobile v0.1.0");
  });

  test("returns the key itself when it is missing from every locale", { timeout: 20000 }, async () => {
    const { initLocale, t } = await import("../index");
    initLocale();
    expect(t("missing.key")).toBe("missing.key");
  });

  test("interpolates {param} placeholders", { timeout: 20000 }, async () => {
    const { initLocale, setLocale, t } = await import("../index");
    initLocale();
    setLocale("zh-CN");
    expect(t("settings.remove_gateway_message", {
      label: "构建机",
      url: "http://127.0.0.1:4173",
    })).toBe("将移除 构建机\nhttp://127.0.0.1:4173\n\n现有任务连接会立即关闭。");
  });

  test("notifies subscribers when the locale changes", { timeout: 20000 }, async () => {
    const { initLocale, setLocale, subscribeLocale } = await import("../index");
    initLocale();
    const listener = vi.fn();
    const unsubscribe = subscribeLocale(listener);
    setLocale("zh-CN");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setLocale("en");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("initLocale honors a stored preference", { timeout: 20000 }, async () => {
    const { initLocale, getLocale, getLocalePreference } = await import("../index");
    initLocale("zh-CN");
    expect(getLocale()).toBe("zh-CN");
    expect(getLocalePreference()).toBe("zh-CN");
  });
});
