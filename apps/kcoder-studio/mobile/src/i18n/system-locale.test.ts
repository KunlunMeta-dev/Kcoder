import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  platform: "web",
  locales: [{ languageTag: "zh-CN", languageCode: "zh" }],
}));

vi.mock("react-native", () => ({
  Platform: { get OS() { return runtime.platform; } },
}));

vi.mock("expo-localization", () => ({
  getLocales: () => runtime.locales,
}));

import { getSystemLocaleTag } from "./system-locale";

afterEach(() => {
  vi.unstubAllGlobals();
  runtime.platform = "web";
  runtime.locales = [{ languageTag: "zh-CN", languageCode: "zh" }];
});

describe("system locale adapter", () => {
  it("uses browser language negotiation on web", () => {
    vi.stubGlobal("navigator", {
      languages: ["zh-Hans-SG", "en-US"],
      language: "en-US",
    });
    expect(getSystemLocaleTag()).toBe("zh-Hans-SG");
  });

  it("reads current device locale through Expo on native", () => {
    runtime.platform = "android";
    runtime.locales = [{ languageTag: "zh-Hant-TW", languageCode: "zh" }];
    expect(getSystemLocaleTag()).toBe("zh-Hant-TW");
  });
});
