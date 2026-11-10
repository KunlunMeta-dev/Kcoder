import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  platformOS: "ios" as string,
  setClipboard: vi.fn(),
  share: vi.fn(),
}));

vi.mock("expo-clipboard", () => ({ setStringAsync: mocks.setClipboard }));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return mocks.platformOS;
    },
  },
  Share: { share: mocks.share, dismissedAction: "dismissed" },
}));

import {
  copyAssistantText,
  shareAssistantText,
  supportsAssistantSharing,
  visibleAssistantText,
} from "./transcript-actions";
import type { ChatMessage } from "@/runtime/task-runtime";

beforeEach(() => {
  mocks.platformOS = "ios";
  mocks.setClipboard.mockReset().mockResolvedValue(true);
  mocks.share.mockReset().mockResolvedValue({ action: "shared" });
  vi.unstubAllGlobals();
});

describe("assistant transcript actions", () => {
  it("extracts only the ordered text blocks shown in the assistant body", () => {
    const message = {
      content: "COMPATIBILITY_AGGREGATE",
      orderedBlocks: [
        { kind: "thinking", id: "thought", content: "PRIVATE_THOUGHT" },
        {
          kind: "tool",
          id: "tool",
          name: "PRIVATE_TOOL",
          status: "completed",
          output: "PRIVATE_OUTPUT",
        },
        {
          kind: "text",
          id: "text-a",
          producerId: "assistant-item-1",
          content: "Visible ",
        },
        {
          kind: "text",
          id: "text-b",
          producerId: "assistant-item-1",
          content: "reply.",
        },
      ],
    } satisfies Pick<ChatMessage, "content" | "orderedBlocks">;

    expect(visibleAssistantText(message)).toBe("Visible reply.");
    expect(
      visibleAssistantText({
        content: "COMPATIBILITY_AGGREGATE",
        orderedBlocks: [
          {
            kind: "text",
            id: "paragraph-a",
            producerId: "assistant-item-a",
            content: "First paragraph.",
          },
          {
            kind: "text",
            id: "paragraph-b",
            producerId: "assistant-item-b",
            content: "Second paragraph.",
          },
        ],
      }),
    ).toBe("First paragraph.\n\nSecond paragraph.");
    expect(
      visibleAssistantText({ content: "Legacy visible", orderedBlocks: undefined }),
    ).toBe("Legacy visible");
    expect(
      visibleAssistantText({
        content: "",
        orderedBlocks: [{ kind: "thinking", id: "thought", content: "PRIVATE_THOUGHT" }],
      }),
    ).toBeNull();
  });

  it("copies visible response text and reports clipboard failures", async () => {
    await expect(copyAssistantText("Visible reply.")).resolves.toBe("success");
    expect(mocks.setClipboard).toHaveBeenCalledWith("Visible reply.");

    mocks.setClipboard.mockResolvedValueOnce(false);
    await expect(copyAssistantText("Visible reply.")).resolves.toBe("failed");
    mocks.setClipboard.mockRejectedValueOnce(new Error("clipboard unavailable"));
    await expect(copyAssistantText("Visible reply.")).resolves.toBe("failed");
  });

  it("uses the native system share sheet and distinguishes dismissal from failure", async () => {
    expect(supportsAssistantSharing()).toBe(true);
    await expect(shareAssistantText("Visible reply.", "Share response")).resolves.toBe(
      "success",
    );
    expect(mocks.share).toHaveBeenCalledWith({
      message: "Visible reply.",
      title: "Share response",
    });

    mocks.share.mockResolvedValueOnce({ action: "dismissed" });
    await expect(shareAssistantText("Visible reply.", "Share response")).resolves.toBe(
      "dismissed",
    );
    mocks.share.mockRejectedValueOnce(new Error("share unavailable"));
    await expect(shareAssistantText("Visible reply.", "Share response")).resolves.toBe(
      "failed",
    );
  });

  it("uses Web Share only when the browser exposes it and treats cancellation as dismissal", async () => {
    mocks.platformOS = "web";
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { share });

    expect(supportsAssistantSharing()).toBe(true);
    await expect(shareAssistantText("Visible reply.", "Share response")).resolves.toBe(
      "success",
    );
    expect(share).toHaveBeenCalledWith({
      title: "Share response",
      text: "Visible reply.",
    });

    share.mockRejectedValueOnce(Object.assign(new Error("dismissed"), { name: "AbortError" }));
    await expect(shareAssistantText("Visible reply.", "Share response")).resolves.toBe(
      "dismissed",
    );

    vi.stubGlobal("navigator", {});
    expect(supportsAssistantSharing()).toBe(false);
    await expect(shareAssistantText("Visible reply.", "Share response")).resolves.toBe(
      "unavailable",
    );
  });
});
