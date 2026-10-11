import { describe, expect, test } from "vitest";
import { en } from "../en";

describe("en locale", () => {
  test("only contains non-empty string values", () => {
    for (const [key, value] of Object.entries(en)) {
      expect(typeof value, `key ${key}`).toBe("string");
      expect(value.trim().length > 0, `key ${key}`).toBe(true);
    }
  });

  test("uses dot-separated lowercase keys", () => {
    for (const key of Object.keys(en)) {
      expect(key).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*(\.[a-z0-9]+(_[a-z0-9]+)*)+$/);
    }
  });
});
