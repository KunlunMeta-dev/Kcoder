import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

describe("mobile i18n", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
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

  test("falls back to en when a key is missing from the active locale", { timeout: 20000 }, async () => {
    const { initLocale, setLocale, t } = await import("../index");
    initLocale();
    setLocale("zh-CN");
    // "welcome.version_line" is intentionally only defined in en.
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
    const { initLocale, getLocale } = await import("../index");
    initLocale("zh-CN");
    expect(getLocale()).toBe("zh-CN");
  });
});
