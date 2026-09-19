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

  test("defines a subset of the en keys", () => {
    const enKeys = new Set(Object.keys(en));
    for (const key of Object.keys(zhCN)) {
      expect(enKeys.has(key), `key ${key} missing from en`).toBe(true);
    }
  });
});
