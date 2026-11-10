import { describe, expect, test } from "vitest";
import { initLocale, t } from "@/i18n";
import {
  isToolProfile,
  parseToolProfileSettings,
  parseUsageStats,
  rpcDelivery,
  summarizeUsage,
  type UsageCounters,
} from "./settings-tools-usage-model";
import { settingsToolsUsageEn } from "@/i18n/locales/settings-tools-usage.en";
import { settingsToolsUsageZhCN } from "@/i18n/locales/settings-tools-usage.zh-CN";

const counters = (patch: Partial<UsageCounters> = {}): UsageCounters => ({
  requests: 0,
  unreportedRequests: 0,
  estimatedTotalRequests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalTokens: 0,
  ...patch,
});

describe("tool profile wire values", () => {
  test.each(["full", "core", "nano", "none"] as const)("accepts protocol profile %s", (profile) => {
    expect(isToolProfile(profile)).toBe(true);
    expect(parseToolProfileSettings({ profile, effectiveProfile: profile, cliOverride: null }))
      .toEqual({ profile, effectiveProfile: profile, cliOverride: null });
  });

  test("preserves the target's CLI override and rejects display labels as wire values", () => {
    expect(parseToolProfileSettings({ profile: "core", effectiveProfile: "none", cliOverride: "none" }))
      .toEqual({ profile: "core", effectiveProfile: "none", cliOverride: "none" });
    expect(isToolProfile("complete")).toBe(false);
    expect(isToolProfile("minimal")).toBe(false);
    expect(() => parseToolProfileSettings({ profile: "complete", effectiveProfile: "full", cliOverride: null }))
      .toThrow("Invalid tool profile response");
  });
});

describe("usage history projection", () => {
  const stats = parseUsageStats({
    windowDays: 30,
    timeZone: "UTC",
    generatedAtMs: Date.parse("2026-10-09T12:00:00Z"),
    history: {
      version: 1,
      trackedSinceMs: Date.parse("2026-09-10T00:00:00Z"),
      lastRecordedAtMs: Date.parse("2026-10-09T11:00:00Z"),
      days: {
        "2026-09-10": { "old-model": counters({ requests: 5, totalTokens: 500 }) },
        "2026-10-02": { "older-model": counters({ requests: 3, totalTokens: 30 }) },
        "2026-10-03": {
          model: counters({
            requests: 2,
            unreportedRequests: 1,
            estimatedTotalRequests: 1,
            inputTokens: 18,
            outputTokens: 4,
            cacheReadTokens: 7,
            totalTokens: 22,
          }),
        },
        "2026-10-09": { model: counters({ requests: 1, inputTokens: 6, outputTokens: 3, totalTokens: 9 }) },
      },
    },
  });

  test("aggregates only recorded target counters within the chosen UTC window", () => {
    const week = summarizeUsage(stats, 7);
    expect(week?.total).toEqual(counters({
      requests: 3,
      unreportedRequests: 1,
      estimatedTotalRequests: 1,
      inputTokens: 24,
      outputTokens: 7,
      cacheReadTokens: 7,
      totalTokens: 31,
    }));
    expect(week?.models).toEqual([{ label: "model", ...week!.total }]);

    const month = summarizeUsage(stats, 30);
    expect(month?.total.requests).toBe(11);
    expect(month?.total.totalTokens).toBe(561);
    expect(month?.models.map(({ label }) => label)).toEqual(["old-model", "model", "older-model"]);
  });

  test("retains unavailable history as unavailable instead of inventing zero totals", () => {
    const empty = parseUsageStats({
      windowDays: 30,
      timeZone: "UTC",
      generatedAtMs: Date.parse("2026-10-09T00:00:00Z"),
      history: null,
    });
    expect(empty.history).toBeNull();
    expect(summarizeUsage(empty, 30)).toBeNull();
  });

  test("rejects malformed counters instead of presenting them as zero", () => {
    expect(() => parseUsageStats({
      windowDays: 30,
      timeZone: "UTC",
      generatedAtMs: 1,
      history: {
        version: 1,
        trackedSinceMs: 1,
        lastRecordedAtMs: 1,
        days: { "2026-10-09": { model: { ...counters(), totalTokens: -1 } } },
      },
    })).toThrow("Invalid usage counters");
  });
});

test("English and Chinese settings resources keep the same flat keys and report cost limits", () => {
  expect(Object.keys(settingsToolsUsageZhCN).sort()).toEqual(Object.keys(settingsToolsUsageEn).sort());
  expect(settingsToolsUsageZhCN["settings_tools_usage.profile_full"]).toBe("完整");
  expect(settingsToolsUsageZhCN["settings_tools_usage.profile_core"]).toBe("核心");
  expect(settingsToolsUsageZhCN["settings_tools_usage.profile_nano"]).toBe("精简");
  expect(settingsToolsUsageZhCN["settings_tools_usage.profile_none"]).toBe("关闭");
  expect(settingsToolsUsageEn["settings_tools_usage.usage_cost_unavailable"]).toContain("not estimated");
  expect(settingsToolsUsageZhCN["settings_tools_usage.usage_cost_unavailable"]).toContain("不会根据 Token 数估算");
});

test("the shared mobile translator resolves the registered domain resources", () => {
  initLocale("en");
  expect(t("settings_tools_usage.profile_full")).toBe("Complete");
  expect(t("settings_tools_usage.usage_cost_unavailable")).toContain("Cost is not estimated");
  initLocale("zh-CN");
  expect(t("settings_tools_usage.profile_full")).toBe("完整");
  expect(t("settings_tools_usage.usage_profile_required")).toContain("显式指定 KCoder 用户配置目录");
});

test("delivery uncertainty is recognized only from Error outcomes", () => {
  expect(rpcDelivery(Object.assign(new Error("stale"), { delivery: "unknown" }))).toBe("unknown");
  expect(rpcDelivery(Object.assign(new Error("not dispatched"), { delivery: "not-sent" }))).toBe("not-sent");
  expect(rpcDelivery(new Error("ordinary rejection"))).toBeNull();
  expect(rpcDelivery({ delivery: "unknown" })).toBeNull();
});
