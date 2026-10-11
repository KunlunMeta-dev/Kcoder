import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";

const source = readFileSync(
  new URL("../welcome.tsx", import.meta.url).pathname,
  "utf8"
);

function extractTKeys(source: string): string[] {
  return [...source.matchAll(/\bt\(\s*["']([^"']+)["']/g)].map((match) => match[1]);
}

describe("welcome route i18n", () => {
  test("uses t() for user-facing strings", () => {
    expect(extractTKeys(source).length).toBeGreaterThan(0);
  });

  test("every t() key exists in the en locale", () => {
    for (const key of extractTKeys(source)) {
      expect(en[key], `key ${key}`).toBeDefined();
    }
  });

  test("keys with zh-CN translations resolve in both locales", () => {
    for (const key of extractTKeys(source)) {
      if (key in zhCN) {
        expect(zhCN[key].trim().length, `key ${key}`).toBeGreaterThan(0);
      }
    }
  });
});
