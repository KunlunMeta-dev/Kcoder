import { describe, expect, it } from "vitest";

import {
  beginProgrammaticFollow,
  initialMessageFollowState,
  observeMessageListDistance,
  shouldAnchorLatest,
  stopFollowingLatest,
} from "./message-follow-state";

describe("message follow intent", () => {
  it("keeps a jump through the estimated end and later virtualized height growth", () => {
    const jump = beginProgrammaticFollow();
    const estimatedEnd = observeMessageListDistance(jump, 0);
    const measuredEnd = observeMessageListDistance(estimatedEnd, 3695);
    expect(estimatedEnd).toBe(jump);
    expect(measuredEnd).toBe(jump);
    expect(shouldAnchorLatest(measuredEnd)).toBe(true);
  });

  it("does not interpret ordinary layout growth as a user scroll away", () => {
    const following = initialMessageFollowState();
    expect(observeMessageListDistance(following, 11145)).toBe(following);
    expect(shouldAnchorLatest(following)).toBe(true);
  });

  it("cancels a jump on actual user movement even before leaving the near-tail area", () => {
    const jump = beginProgrammaticFollow();
    const stopped = observeMessageListDistance(jump, 24, "toward-old");
    expect(stopped).not.toBe(jump);
    expect(stopped.followsLatest).toBe(false);
    expect(stopped.programmaticFollow).toBe(false);
    expect(stopped.awaitingDistanceAway).toBe(true);
    expect(observeMessageListDistance(stopped, 0)).toBe(stopped);
    const returned = observeMessageListDistance(stopped, 12, "toward-latest");
    expect(returned.followsLatest).toBe(true);
    expect(returned.awaitingDistanceAway).toBe(false);
  });

  it("allows a user return to the tail after actual movement away", () => {
    const stopped = stopFollowingLatest();
    const away = observeMessageListDistance(stopped, 240, "toward-old");
    expect(away.followsLatest).toBe(false);
    expect(away.awaitingDistanceAway).toBe(false);
    const returned = observeMessageListDistance(away, 24, "toward-latest");
    expect(returned.followsLatest).toBe(true);
    expect(returned.programmaticFollow).toBe(false);
  });

  it("does not revive a paused prepend through layout shrink or non-user geometry", () => {
    const paused = stopFollowingLatest();
    expect(observeMessageListDistance(paused, 320)).toBe(paused);
    const away = observeMessageListDistance(paused, 320, "toward-latest");
    expect(away.awaitingDistanceAway).toBe(false);
    expect(observeMessageListDistance(away, 0)).toBe(away);
    expect(shouldAnchorLatest(away)).toBe(false);
  });

  it("gives explicit stop and a later jump different generations despite equal final flags", () => {
    const first = beginProgrammaticFollow();
    const stopped = stopFollowingLatest();
    const second = beginProgrammaticFollow();
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(stopped).not.toBe(first);
  });
});
