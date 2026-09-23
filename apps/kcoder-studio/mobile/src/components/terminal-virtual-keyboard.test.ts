import { describe, expect, it } from "vitest";
import { TerminalModifierLatch } from "./terminal-virtual-keyboard";

describe("TerminalModifierLatch", () => {
  it("applies a sticky ctrl modifier once", () => {
    const latch = new TerminalModifierLatch();
    latch.toggle("ctrl");
    expect(latch.consume("c")).toBe("\u0003");
    expect(latch.consume("c")).toBe("c");
  });

  it("combines shift and alt for the next printable character", () => {
    const latch = new TerminalModifierLatch();
    latch.toggle("shift");
    latch.toggle("alt");
    expect(latch.consume("a")).toBe("\u001bA");
    expect(latch.has("shift")).toBe(false);
    expect(latch.has("alt")).toBe(false);
  });

  it("encodes modified arrow keys using xterm CSI modifiers", () => {
    const latch = new TerminalModifierLatch();
    latch.toggle("ctrl");
    latch.toggle("shift");
    expect(latch.consumeKey("up")).toBe("\u001b[1;6A");
    expect(latch.consumeKey("up")).toBe("\u001b[A");
  });

  it("allows a selected modifier to be toggled off", () => {
    const latch = new TerminalModifierLatch();
    latch.toggle("alt");
    latch.toggle("alt");
    expect(latch.consume("x")).toBe("x");
  });

  it("notifies the UI when xterm input consumes a modifier", () => {
    const latch = new TerminalModifierLatch();
    let notifications = 0;
    const unsubscribe = latch.subscribe(() => { notifications += 1; });
    latch.toggle("ctrl");
    expect(latch.consume("c")).toBe("\u0003");
    expect(latch.getSnapshot()).toBe(2);
    expect(notifications).toBe(2);
    unsubscribe();
  });

  it("matches terminal encodings for reverse tab and ctrl-space", () => {
    const latch = new TerminalModifierLatch();
    latch.toggle("shift");
    expect(latch.consumeKey("tab")).toBe("\u001b[Z");
    latch.toggle("ctrl");
    expect(latch.consumeKey("space")).toBe("\u0000");
  });

  it.each([
    ["2", "\u0000"],
    ["3", "\u001b"],
    ["/", "\u001f"],
    ["8", "\u007f"],
    ["?", "\u007f"],
  ])("encodes ctrl-%s using conventional terminal control bytes", (character, expected) => {
    const latch = new TerminalModifierLatch();
    latch.toggle("ctrl");
    expect(latch.consume(character)).toBe(expected);
  });

  it("prefixes alt-backspace but keeps enter portable", () => {
    const latch = new TerminalModifierLatch();
    latch.toggle("alt");
    expect(latch.consumeKey("backspace")).toBe("\u001b\u007f");
    latch.toggle("alt");
    expect(latch.consumeKey("enter")).toBe("\r");
    expect(latch.has("alt")).toBe(false);
  });
});
