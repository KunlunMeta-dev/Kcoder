import { describe, expect, it } from "vitest";

import {
  beginProgrammaticFollow,
  initialMessageFollowState,
  observeMessageListDistance,
  shouldAnchorLatest,
  stopFollowingLatest,
} from "./message-follow-state";

describe("message follow state", () => {
  it("程序化滚动途中不会因远离底部的 scroll 事件丢失跟随状态", () => {
    const started = beginProgrammaticFollow();
    const inFlight = observeMessageListDistance(started, 320);

    expect(inFlight).toEqual({ followsLatest: true, programmaticFollow: true });
    expect(shouldAnchorLatest(inFlight)).toBe(true);
  });

  it("程序化滚动实际到达底部后释放锁并继续普通跟随", () => {
    const reachedLatest = observeMessageListDistance(beginProgrammaticFollow(), 24);

    expect(reachedLatest).toEqual({ followsLatest: true, programmaticFollow: false });
    expect(observeMessageListDistance(reachedLatest, 180)).toEqual({
      followsLatest: false,
      programmaticFollow: false,
    });
  });

  it("加载旧消息时会显式取消程序化跟随", () => {
    expect(stopFollowingLatest()).toEqual({ followsLatest: false, programmaticFollow: false });
    expect(initialMessageFollowState()).toEqual({ followsLatest: true, programmaticFollow: false });
  });

  it("用户开始拖动时会立即取消尚未完成的程序化跟随", () => {
    const dragging = stopFollowingLatest();

    expect(dragging).toEqual({ followsLatest: false, programmaticFollow: false });
    expect(observeMessageListDistance(dragging, 240)).toEqual({
      followsLatest: false,
      programmaticFollow: false,
    });
  });
});
