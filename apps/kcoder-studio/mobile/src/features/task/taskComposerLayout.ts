export const COMPOSER_INPUT_LINE_HEIGHT = 21;
export const COMPOSER_MIN_INPUT_LINES = 2;
export const COMPOSER_MAX_INPUT_LINES = 5;

export type ComposerLayoutState = {
  focused: boolean;
  contentHeight: number;
};

export type ComposerLayoutEvent =
  | { type: "focus" }
  | { type: "blur" }
  | { type: "keyboard-hidden" }
  | { type: "content-size-changed"; height: number };

export type ComposerLayoutContext = {
  draft: string;
  attachmentCount: number;
  preserveExpanded?: boolean;
  compactDraftWhenUnfocused?: boolean;
};

export function reduceComposerLayoutState(
  state: ComposerLayoutState,
  event: ComposerLayoutEvent,
): ComposerLayoutState {
  switch (event.type) {
    case "focus":
      return state.focused ? state : { ...state, focused: true };
    case "blur":
    case "keyboard-hidden":
      return state.focused ? { ...state, focused: false } : state;
    case "content-size-changed":
      return Number.isFinite(event.height) && event.height > 0
        ? { ...state, contentHeight: event.height }
        : state;
  }
}

export function resolveComposerLayout(
  state: ComposerLayoutState,
  context: ComposerLayoutContext,
) {
  const input = getComposerInputMetrics(state.contentHeight);
  const compactDraft = context.compactDraftWhenUnfocused === true &&
    !state.focused && !context.preserveExpanded && context.draft.length > 0;
  return {
    expanded:
      state.focused ||
      context.attachmentCount > 0 ||
      context.draft.length > 0 ||
      context.preserveExpanded === true,
    inputHeight: compactDraft ? COMPOSER_INPUT_LINE_HEIGHT * COMPOSER_MIN_INPUT_LINES : input.height,
    scrollEnabled: !compactDraft && input.scrollEnabled,
  };
}

export function getComposerInputMetrics(
  measuredContentHeight: number,
  lineHeight = COMPOSER_INPUT_LINE_HEIGHT,
) {
  const minHeight = lineHeight * COMPOSER_MIN_INPUT_LINES;
  const maxHeight = lineHeight * COMPOSER_MAX_INPUT_LINES;
  const contentHeight = Number.isFinite(measuredContentHeight)
    ? Math.max(lineHeight, measuredContentHeight)
    : lineHeight;

  return {
    height: Math.min(maxHeight, Math.max(minHeight, contentHeight)),
    scrollEnabled: contentHeight > maxHeight,
  };
}
