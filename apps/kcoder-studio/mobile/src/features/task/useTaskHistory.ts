import {
  deferMessageFollowAnchor,
  shouldAnchorLatest,
  stopFollowingLatest,
} from "@/components/message-follow-state";
import { Platform, type LayoutChangeEvent } from "react-native";

import type { useTaskSending } from "./useTaskSending";

export function useTaskHistory(context: ReturnType<typeof useTaskSending>) {
  const {
    task,
    messageListRef,
    messageListLayoutHeight,
    messageFollowState,
    setShowJumpToLatest,
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

  const handleMessageListLayout = (event: LayoutChangeEvent) => {
    const nextHeight = event.nativeEvent.layout.height;
    if (Math.abs(nextHeight - messageListLayoutHeight.current) < 1) return;
    messageListLayoutHeight.current = nextHeight;
    const followIntent = messageFollowState.current;
    const generation = mountGeneration.current;
    requestAnimationFrame(() => {
      if (!mountedRef.current || mountGeneration.current !== generation) return;
      if (deferMessageFollowAnchor(messageFollowState.current, followIntent)) return;
      if (messageFollowState.current !== followIntent) return;
      if (shouldAnchorLatest(messageFollowState.current)) {
        setShowJumpToLatest(false);
        messageListRef.current?.scrollToEnd({ animated: false });
        return;
      }
      const scroller =
        Platform.OS === "web"
          ? (messageListRef.current?.getNativeScrollRef() as unknown as
              HTMLElement | undefined)
          : undefined;
      if (scroller) {
        const distance =
          scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
        setShowJumpToLatest(distance >= 96);
      } else {
        setShowJumpToLatest(true);
      }
    });
  };
  return {
    ...context,
    compensateWebPrepend,
    loadOlder,
    handleMessageListLayout,
  };
}
