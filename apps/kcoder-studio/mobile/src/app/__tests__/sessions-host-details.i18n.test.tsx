import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";

const routes = [
  ["sessions", readFileSync(new URL("../sessions.tsx", import.meta.url).pathname, "utf8")],
  ["host details", readFileSync(new URL("../host-details.tsx", import.meta.url).pathname, "utf8")],
] as const;

function extractTKeys(source: string): string[] {
  return [...source.matchAll(/\bt\(\s*["']([^"']+)["']/g)].map((match) => match[1]);
}

describe("sessions and host details i18n", () => {
  test.each(routes)("%s resolves every visible translation key in both locales", (_name, source) => {
    const keys = extractTKeys(source);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(en[key], `missing English key ${key}`).toBeDefined();
      expect(zhCN[key]?.trim(), `missing Simplified Chinese translation ${key}`).toBeTruthy();
    }
  });

  test.each(routes)("%s subscribes to locale changes while rendering", (_name, source) => {
    expect(source).toMatch(/useLocale\(\)/);
  });
});
