import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const source = readFileSync(
  new URL("../vitest.config.ts", import.meta.url).pathname,
  "utf8"
);

describe("mobile vitest config", () => {
  test("runs both .ts and .tsx test files", () => {
    expect(source).toContain("src/**/*.test.ts");
    expect(source).toContain("src/**/*.test.tsx");
  });
});
