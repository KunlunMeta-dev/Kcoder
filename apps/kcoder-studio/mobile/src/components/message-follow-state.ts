export const LATEST_MESSAGE_DISTANCE_THRESHOLD = 96;

export type MessageFollowState = {
  followsLatest: boolean;
  programmaticFollow: boolean;
  awaitingDistanceAway: boolean;
  pendingInput?: { follow: MessageFollowState; needsAnchor: boolean };
};

export function initialMessageFollowState(): MessageFollowState {
  return { followsLatest: true, programmaticFollow: false, awaitingDistanceAway: false };
}

export function beginProgrammaticFollow(): MessageFollowState {
  return { followsLatest: true, programmaticFollow: true, awaitingDistanceAway: false };
}

export function stopFollowingLatest(): MessageFollowState {
  return { followsLatest: false, programmaticFollow: false, awaitingDistanceAway: true };
}

// A directional input may arrive before the browser applies its default
// scroll. Suspend automatic scrolling until its actual offset is observed.
export function suspendMessageFollowInput(state: MessageFollowState): MessageFollowState {
  return shouldAnchorLatest(state)
    ? { ...state, pendingInput: { follow: state, needsAnchor: false } }
    : state;
}

export function deferMessageFollowAnchor(
  state: MessageFollowState,
  capturedIntent: MessageFollowState = state,
): boolean {
  const pending = state.pendingInput;
  if (!pending || (capturedIntent !== state && capturedIntent !== pending.follow)) return false;
  pending.needsAnchor = true;
  return true;
}

export function observeMessageListDistance(
  state: MessageFollowState,
  distance: number,
  userMovement?: "toward-old" | "toward-latest",
): MessageFollowState {
  const reachedLatest = distance < LATEST_MESSAGE_DISTANCE_THRESHOLD;
  // Geometry changes alone are not a user decision. This also protects normal
  // following from virtualized row measurement and paused prepend anchors.
  if (!userMovement) return state;
  state = state.pendingInput?.follow ?? state;
  if (userMovement === "toward-old" && shouldAnchorLatest(state))
    state = stopFollowingLatest();
  if (state.awaitingDistanceAway) {
    // Only confirmed motion toward the tail can rejoin near it. Layout shrink
    // and the remaining programmatic scroll do not carry this user direction.
    if (reachedLatest && userMovement === "toward-latest")
      return { ...state, followsLatest: true, awaitingDistanceAway: false };
    return reachedLatest ? state : { ...state, awaitingDistanceAway: false };
  }
  if (state.programmaticFollow) return state;
  // Preserve object identity while the intent is unchanged: deferred follow
  // work uses this object as its generation, including stop -> jump races.
  const followsLatest = userMovement === "toward-latest" && reachedLatest;
  return state.followsLatest === followsLatest
    ? state
    : { ...state, followsLatest };
}

export function shouldAnchorLatest(state: MessageFollowState): boolean {
  return !state.pendingInput && (state.followsLatest || state.programmaticFollow);
}
