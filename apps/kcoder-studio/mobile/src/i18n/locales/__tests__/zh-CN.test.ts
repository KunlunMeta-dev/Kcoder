import { describe, expect, test } from "vitest";
import { en } from "../en";
import { zhCN } from "../zh-CN";

describe("zh-CN locale", () => {
  test("only contains non-empty string values", () => {
    for (const [key, value] of Object.entries(zhCN)) {
      expect(typeof value, `key ${key}`).toBe("string");
      expect(value.trim().length > 0, `key ${key}`).toBe(true);
    }
  });

  test("has exactly the same keys as the en locale", () => {
    const enKeys = new Set(Object.keys(en));
    const zhKeys = new Set(Object.keys(zhCN));
    for (const key of Object.keys(zhCN)) {
      expect(enKeys.has(key), `key ${key} missing from en`).toBe(true);
    }
    for (const key of Object.keys(en)) {
      expect(zhKeys.has(key), `key ${key} missing from zh-CN`).toBe(true);
    }
  });

  test("preserves the English interpolation parameters", () => {
    const parameters = (value: string) => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)]
      .map((match) => match[1])
      .sort();
    for (const [key, value] of Object.entries(en)) {
      expect(parameters(zhCN[key] ?? ""), `interpolation parameters differ for ${key}`).toEqual(parameters(value));
    }
  });

  test("translates every mobile settings and main-flow key in Simplified Chinese", () => {
    const translatedNamespaces = ["settings.", "home.", "task.", "workspace_bookkeeping."];
    for (const key of Object.keys(en).filter((value) => translatedNamespaces.some((prefix) => value.startsWith(prefix)))) {
      expect(zhCN[key]?.trim(), `missing Simplified Chinese translation: ${key}`).toBeTruthy();
    }
  });
});
