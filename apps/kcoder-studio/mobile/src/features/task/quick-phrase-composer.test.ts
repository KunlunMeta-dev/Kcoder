import { describe, expect, it } from "vitest";
import { appendQuickPhraseToDraft } from "./quick-phrase-composer";

describe("quick phrase composer insertion", () => {
  it("fills an empty draft with the phrase text", () => {
    expect(appendQuickPhraseToDraft("", "Review this change")).toBe("Review this change");
  });

  it("appends phrase text to the existing draft without adding a duplicate newline", () => {
    expect(appendQuickPhraseToDraft("Keep this context", "Review this change")).toBe(
      "Keep this context\nReview this change",
    );
    expect(appendQuickPhraseToDraft("Keep this context\n", "Review this change")).toBe(
      "Keep this context\nReview this change",
    );
  });

  it("preserves phrase whitespace so indented user text is not rewritten", () => {
    expect(appendQuickPhraseToDraft("", "\n  preserve indentation\n")).toBe(
      "\n  preserve indentation\n",
    );
  });
});
