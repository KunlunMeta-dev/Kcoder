import {
  deferMessageFollowAnchor,
  LATEST_MESSAGE_DISTANCE_THRESHOLD,
  shouldAnchorLatest,
  stopFollowingLatest,
} from "@/components/message-follow-state";
import { Platform, type LayoutChangeEvent } from "react-native";

import type { useTaskSending } from "./useTaskSending";
import type { useTaskAgentState } from "./useTaskAgentState";

type HistoryContext = Pick<ReturnType<typeof useTaskAgentState>,
  "task" | "messageListRef" | "messageListLayoutHeight" | "messageFollowState" |
  "setShowJumpToLatest" | "webPrependAnchor" | "mountedRef" | "mountGeneration">;
type HistoryActions = {
  compensateWebPrepend(): boolean;
  loadOlder(): Promise<void>;
  handleMessageListLayout(event: LayoutChangeEvent): void;
};

export type TranscriptLayoutContext = Pick<HistoryContext,
  "messageListRef" | "messageListLayoutHeight" | "messageFollowState" |
  "setShowJumpToLatest" | "mountedRef" | "mountGeneration"> & {
    ownerRef?: { current: object | undefined };
  };

/** Shared viewport-only follow handling for live and cached transcript frames. */
export function handleTranscriptLayoutChange(context: TranscriptLayoutContext, event: LayoutChangeEvent) {
  const nextHeight = event.nativeEvent.layout.height;
  if (Math.abs(nextHeight - context.messageListLayoutHeight.current) < 1) return;
  context.messageListLayoutHeight.current = nextHeight;
  const followIntent = context.messageFollowState.current;
  const generation = context.mountGeneration.current;
  const owner = context.ownerRef?.current;
  requestAnimationFrame(() => {
    if (!context.mountedRef.current || context.mountGeneration.current !== generation ||
        (context.ownerRef && context.ownerRef.current !== owner)) return;
    if (deferMessageFollowAnchor(context.messageFollowState.current, followIntent)) return;
    if (context.messageFollowState.current !== followIntent) return;
    if (shouldAnchorLatest(context.messageFollowState.current)) {
      context.setShowJumpToLatest(false);
      context.messageListRef.current?.scrollToEnd({ animated: false });
      return;
    }
    const scroller = Platform.OS === "web"
      ? (context.messageListRef.current?.getNativeScrollRef() as unknown as HTMLElement | undefined)
      : undefined;
    if (scroller) {
      const distance = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
      context.setShowJumpToLatest(distance >= LATEST_MESSAGE_DISTANCE_THRESHOLD);
    } else {
      context.setShowJumpToLatest(true);
    }
  });
}

export function useTaskHistory<Context extends HistoryContext>(context: Context): Context & HistoryActions;
export function useTaskHistory(context: ReturnType<typeof useTaskSending>): ReturnType<typeof useTaskSending> & HistoryActions;
export function useTaskHistory(context: HistoryContext) {
  const {
    task,
    messageListRef,
    messageListLayoutHeight,
    messageFollowState,
    webPrependAnchor,
    mountedRef,
    mountGeneration,
  } = context;
  const compensateWebPrepend = () => {
    const anchor = webPrependAnchor.current;
    if (!anchor?.applying || !anchor.scroller.isConnected) return false;
    const nextHeight = anchor.scroller.scrollHeight;
    const delta = nextHeight - anchor.height;
    if (delta === 0) return false;
    anchor.adjusting = true;
    anchor.top += delta;
    anchor.height = nextHeight;
    anchor.scroller.scrollTop = anchor.top;
    requestAnimationFrame(() => {
      if (webPrependAnchor.current === anchor) anchor.adjusting = false;
    });
    return true;
  };

  const loadOlder = async () => {
    messageFollowState.current = stopFollowingLatest();
    const generation = mountGeneration.current;
    const webScroller =
      Platform.OS === "web"
        ? (messageListRef.current?.getNativeScrollRef() as unknown as
            HTMLElement | undefined)
        : undefined;
    if (webScroller)
      webPrependAnchor.current = {
        scroller: webScroller,
        height: webScroller.scrollHeight,
        top: webScroller.scrollTop,
        applying: false,
        adjusting: false,
      };
    const anchor = webPrependAnchor.current;
    await task.loadOlderMessages();
    if (!mountedRef.current || mountGeneration.current !== generation ||
        !anchor || webPrependAnchor.current !== anchor ||
        anchor.scroller !== webScroller || !webScroller?.isConnected)
      return;
    anchor.applying = true;
    let stableFrames = 0;
    const settle = () => {
      if (!mountedRef.current || mountGeneration.current !== generation ||
          webPrependAnchor.current !== anchor) return;
      stableFrames = compensateWebPrepend() ? 0 : stableFrames + 1;
      if (stableFrames >= 4) {
        webPrependAnchor.current = null;
        return;
      }
      requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  };

  const handleMessageListLayout = (event: LayoutChangeEvent) =>
    handleTranscriptLayoutChange(context, event);
  return {
    ...context,
    compensateWebPrepend,
    loadOlder,
    handleMessageListLayout,
  };
}
