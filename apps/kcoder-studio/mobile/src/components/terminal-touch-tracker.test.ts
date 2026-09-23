import { describe, expect, it } from "vitest";
import { TerminalTouchTracker } from "./terminal-touch-tracker";

describe("TerminalTouchTracker", () => {
  it("只把 8px 内的手势识别为点击", () => {
    const tracker = new TerminalTouchTracker();
    tracker.begin(1, 10, 10);
    tracker.move(1, 14, 16);
    expect(tracker.end(1)).toBe(true);
    tracker.begin(2, 10, 10);
    tracker.move(2, 10, 30);
    expect(tracker.end(2)).toBe(false);
  });

  it("returns vertical pixel deltas for scrollback without turning horizontal swipes into scroll", () => {
    const tracker = new TerminalTouchTracker();
    tracker.begin(1, 20, 100);
    expect(tracker.move(1, 22, 88)).toBe(-12);
    expect(tracker.move(1, 22, 72)).toBe(-16);
    tracker.begin(2, 20, 100);
    expect(tracker.move(2, 44, 102)).toBe(0);
    expect(tracker.end(2)).toBe(false);
  });
});
