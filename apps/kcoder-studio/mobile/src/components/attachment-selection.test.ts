import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENTS_PER_TURN, remainingAttachmentSlots } from "./attachment-selection";

describe("附件批量选择", () => {
  it("最多保留每回合 32 个附件的剩余名额", () => {
    expect(MAX_ATTACHMENTS_PER_TURN).toBe(32);
    expect(remainingAttachmentSlots(0)).toBe(32);
    expect(remainingAttachmentSlots(30)).toBe(2);
    expect(remainingAttachmentSlots(32)).toBe(0);
    expect(remainingAttachmentSlots(40)).toBe(0);
  });
});
