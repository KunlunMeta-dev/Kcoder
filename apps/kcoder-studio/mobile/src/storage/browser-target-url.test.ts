import { describe, expect, it } from "vitest";
import { normalizeTargetBrowserUrl } from "@/storage/browser-target-url";

describe("normalizeTargetBrowserUrl", () => {
  it("accepts and normalizes explicit HTTP and HTTPS URLs", () => {
    expect(normalizeTargetBrowserUrl("  https://example.test/path  ")).toEqual({
      ok: true,
      url: "https://example.test/path",
    });
    expect(normalizeTargetBrowserUrl("http://localhost:8080")).toEqual({
      ok: true,
      url: "http://localhost:8080/",
    });
  });

  it("rejects blank, malformed, non-HTTP, and credential-bearing addresses", () => {
    expect(normalizeTargetBrowserUrl("  ")).toEqual({ ok: false, reason: "empty" });
    expect(normalizeTargetBrowserUrl("not a URL")).toEqual({ ok: false, reason: "invalid" });
    expect(normalizeTargetBrowserUrl("file:///etc/passwd")).toEqual({
      ok: false,
      reason: "unsupported-scheme",
    });
    expect(normalizeTargetBrowserUrl("https://user:secret@example.test/")).toEqual({
      ok: false,
      reason: "credentials",
    });
  });
});
