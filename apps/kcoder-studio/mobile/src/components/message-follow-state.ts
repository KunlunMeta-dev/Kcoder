export const LATEST_MESSAGE_DISTANCE_THRESHOLD = 96;

export type MessageFollowState = {
  followsLatest: boolean;
  programmaticFollow: boolean;
};

export function initialMessageFollowState(): MessageFollowState {
  return { followsLatest: true, programmaticFollow: false };
}

export function beginProgrammaticFollow(): MessageFollowState {
  return { followsLatest: true, programmaticFollow: true };
}

export function stopFollowingLatest(): MessageFollowState {
  return { followsLatest: false, programmaticFollow: false };
}

export function observeMessageListDistance(
  state: MessageFollowState,
  distance: number,
): MessageFollowState {
  const reachedLatest = distance < LATEST_MESSAGE_DISTANCE_THRESHOLD;
  if (state.programmaticFollow) {
    return {
      followsLatest: true,
      programmaticFollow: !reachedLatest,
    };
  }
  return { followsLatest: reachedLatest, programmaticFollow: false };
}

export function shouldAnchorLatest(state: MessageFollowState): boolean {
  return state.followsLatest || state.programmaticFollow;
}
