import { spacing } from "@/theme";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import {
  deferMessageFollowAnchor,
  observeMessageListDistance,
  shouldAnchorLatest,
  suspendMessageFollowInput,
} from "@/components/message-follow-state";
import { EmptyState } from "@/components/ui";
import { Bot } from "lucide-react-native";
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  Text,
  View,
  type NativeScrollEvent,
} from "react-native";
import { MessageBubble } from "./MessageBubble";
import { RuntimeErrorBanner } from "./RuntimeErrorBanner";
import { useTaskAppearance } from "./taskStyles";
import { InvertedTranscriptGeometry, TranscriptAnchorBoundary } from "./transcript-list-geometry";
import type { useTaskModelPreferences } from "./useTaskModelPreferences";

export function TaskTranscript({
  model,
}: {
  model: ReturnType<typeof useTaskModelPreferences>;
}) {
  useLocale();
  const { styles, colors } = useTaskAppearance();
  const {
    task,
    onOpenFile,
    onOpenChanges,
    snapshot,
    messageListRef,
    messageFollowState,
    setShowJumpToLatest,
    webPrependAnchor,
    compensateWebPrepend,
    loadOlder,
    mountedRef,
    mountGeneration,
  } = model;
  const isWeb = Platform.OS === "web";
  const currentModel = useRef(model);
  currentModel.current = model;
  const geometryRef = useRef<InvertedTranscriptGeometry | null>(null);
  if (!geometryRef.current) geometryRef.current = new InvertedTranscriptGeometry(() => ({
    intent: currentModel.current.messageFollowState.current,
    mounted: currentModel.current.mountedRef.current,
    generation: currentModel.current.mountGeneration.current,
    owner: currentModel.current.task,
  }));
  const geometry = geometryRef.current;
  const bindWebList = useCallback((list: FlatList<(typeof snapshot.messages)[number]> | null) => {
    messageListRef.current = geometry.bind(list);
  }, [geometry, messageListRef]);
  const messages = useMemo(() => isWeb ? [...snapshot.messages].reverse() : snapshot.messages,
    [isWeb, snapshot.messages]);
  type Candidate = {
    intent: typeof messageFollowState.current;
    generation: number;
    top: number;
    direction?: "toward-old" | "toward-latest";
    frame: number | null;
    owner?: typeof task;
    host?: HTMLElement;
    outerInput?: boolean;
  };
  const touch = useRef<(Candidate & { x: number; y: number; target: EventTarget | null }) | null>(null);
  const wheel = useRef<Candidate | null>(null);
  const nativeDragging = useRef<Candidate | null>(null);
  const nativeMomentum = useRef<Candidate | null>(null);
  const scroller = () => messageListRef.current?.getNativeScrollRef() as unknown as HTMLElement | undefined;
  const inputTarget = (target: unknown, host: HTMLElement) => {
    if (typeof target !== "object" || target === null) return null;
    const node = target as Node;
    const element = node?.nodeType === 1 ? node as HTMLElement : node?.parentElement;
    return element && host.contains(element) ? element : null;
  };
  const nestedRoom = (element: HTMLElement, towardOld: boolean) =>
    towardOld ? Math.max(0, element.scrollTop)
      : Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop);
  const touchStaysNested = (target: HTMLElement, host: HTMLElement, towardOld: boolean) => {
    for (let node: HTMLElement | null = target; node && node !== host; node = node.parentElement) {
      // Touch can scroll an ancestor of the Text target. Do not interrupt the
      // outer jump while any nested vertical scroll host can consume this move.
      const overflow = host.ownerDocument.defaultView?.getComputedStyle(node).overflowY;
      if ((overflow === "auto" || overflow === "scroll") &&
          node.scrollHeight > node.clientHeight && nestedRoom(node, towardOld) > 0) return true;
    }
    return false;
  };
  const showFollowState = () => {
    const shouldShow = !messageFollowState.current.followsLatest;
    setShowJumpToLatest((current) => current === shouldShow ? current : shouldShow);
  };
  const consumeMovement = (candidate: Candidate, top: number, distance: number) => {
    if (!mountedRef.current || mountGeneration.current !== candidate.generation ||
        (isWeb && (candidate.owner !== currentModel.current.task ||
          candidate.host !== geometry.rawHost() || candidate.outerInput !== true)) ||
        messageFollowState.current !== candidate.intent) return false;
    const previousIntent = messageFollowState.current;
    const delta = top - candidate.top;
    if ((candidate.direction === "toward-old" && delta < 0) ||
        (candidate.direction === "toward-latest" && delta > 0)) {
      messageFollowState.current = observeMessageListDistance(
        messageFollowState.current, distance, candidate.direction,
      );
      // Continued motion from this gesture may observe our own stop; it must
      // not observe a later, independently requested jump as the same intent.
      candidate.intent = messageFollowState.current;
      if (Platform.OS === "web") geometry.userMoved();
    }
    candidate.top = top;
    return messageFollowState.current !== previousIntent;
  };
  const readMovement = (candidate: Candidate) => {
    const movement = geometry.movement();
    if (movement && consumeMovement(candidate, movement.top, movement.distance))
      showFollowState();
  };
  const suspendInput = (candidate: Candidate) => {
    if (candidate.direction !== "toward-old" || !mountedRef.current ||
        (isWeb && (candidate.owner !== currentModel.current.task || candidate.host !== geometry.rawHost())) ||
        candidate.generation !== mountGeneration.current ||
        candidate.intent !== messageFollowState.current) return;
    messageFollowState.current = suspendMessageFollowInput(messageFollowState.current);
    candidate.intent = messageFollowState.current;
  };
  const releaseInput = (candidate: Candidate) => {
    if (!mountedRef.current || candidate.generation !== mountGeneration.current ||
        (isWeb && (candidate.owner !== currentModel.current.task || candidate.host !== geometry.rawHost())) ||
        candidate.intent !== messageFollowState.current) return;
    const pending = candidate.intent.pendingInput;
    if (!pending) return;
    messageFollowState.current = pending.follow;
    candidate.intent = pending.follow;
    if (pending.needsAnchor && shouldAnchorLatest(pending.follow))
      messageListRef.current?.scrollToEnd({ animated: false });
  };
  const consumeNativeMovement = (event: NativeScrollEvent) => {
    const candidate = nativeDragging.current;
    if (!candidate) return false;
    const top = event.contentOffset.y;
    candidate.direction = top === candidate.top ? undefined
      : top < candidate.top ? "toward-old" : "toward-latest";
    return consumeMovement(candidate, top,
      event.contentSize.height - event.layoutMeasurement.height - top);
  };
  const finishTouch = () => {
    const candidate = touch.current;
    if (!candidate) return;
    if (candidate.frame !== null) cancelAnimationFrame(candidate.frame);
    readMovement(candidate);
    releaseInput(candidate);
    geometry.inputFinished(candidate);
    touch.current = null;
  };
  const clearWheel = () => {
    const candidate = wheel.current;
    if (candidate?.frame !== null && candidate?.frame !== undefined)
      cancelAnimationFrame(candidate.frame);
    if (candidate) {
      readMovement(candidate);
      releaseInput(candidate);
      geometry.inputFinished(candidate);
    }
    wheel.current = null;
  };
  const webInputProps = Platform.OS === "web" ? {
    onTouchStart: (event: { nativeEvent: { touches: readonly { pageX: number; pageY: number }[]; target?: unknown } }) => {
      clearWheel();
      finishTouch();
      const point = event.nativeEvent.touches[0];
      const element = geometry.rawHost();
      const target = element && inputTarget(event.nativeEvent.target, element);
      if (point && element && target)
        touch.current = { intent: messageFollowState.current, generation: mountGeneration.current,
          top: geometry.movement()!.top, x: point.pageX, y: point.pageY, frame: null,
          owner: task, host: element, target, outerInput: false };
    },
    onTouchMove: (event: { nativeEvent: { touches: readonly { pageX: number; pageY: number }[]; target?: unknown } }) => {
      const candidate = touch.current;
      const point = event.nativeEvent.touches[0];
      if (!candidate || !point) return;
      const dx = point.pageX - candidate.x;
      const dy = point.pageY - candidate.y;
      candidate.x = point.pageX;
      candidate.y = point.pageY;
      candidate.direction = Math.abs(dy) > Math.abs(dx)
        ? dy > 0 ? "toward-old" : "toward-latest" : undefined;
      const host = geometry.rawHost();
      const target = host && inputTarget(candidate.target, host);
      const outerInput = Boolean(candidate.direction && host === candidate.host && target &&
        !touchStaysNested(target, host!, candidate.direction === "toward-old"));
      if (!outerInput) {
        if (candidate.frame !== null) cancelAnimationFrame(candidate.frame);
        candidate.frame = null;
        releaseInput(candidate);
        geometry.inputFinished(candidate);
        candidate.direction = undefined;
        candidate.outerInput = false;
        candidate.top = geometry.movement()?.top ?? candidate.top;
        return;
      }
      if (!candidate.outerInput) candidate.top = geometry.movement()!.top;
      candidate.outerInput = true;
      suspendInput(candidate);
      geometry.inputStarted(candidate);
      readMovement(candidate);
      if (candidate.frame !== null) cancelAnimationFrame(candidate.frame);
      // Observe the browser's default scroll, not the touch coordinates alone.
      candidate.frame = requestAnimationFrame(() => {
        candidate.frame = null;
        if (touch.current === candidate) {
          readMovement(candidate);
          releaseInput(candidate);
        }
      });
    },
    onTouchEnd: finishTouch,
    onTouchCancel: finishTouch,
  } : {};
  // RNW's inverted-list native wheel listener scrolls synchronously. Capture
  // samples the starting offset before that listener, including nested views.
  const handleWebWheel = (event: globalThis.WheelEvent) => {
    const element = geometry.rawHost();
    if (!element || !event.deltaY || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    const target = inputTarget(event.target, element);
    if (!target) return;
    // RNW's inverted wheel route consumes the actual event target's room first.
    // A wholly inner wheel must not settle an outer candidate or stop its jump.
    if (target !== element && target.scrollHeight > target.clientHeight &&
        nestedRoom(target, event.deltaY < 0) >= Math.abs(event.deltaY)) return;
    clearWheel();
    finishTouch();
    const candidate: Candidate = { intent: messageFollowState.current,
      generation: mountGeneration.current, top: geometry.movement()!.top,
      direction: event.deltaY < 0 ? "toward-old" : "toward-latest", frame: null,
      owner: task, host: element, outerInput: true };
    wheel.current = candidate;
    suspendInput(candidate);
    geometry.inputStarted(candidate);
    candidate.frame = requestAnimationFrame(() => {
      candidate.frame = null;
      if (wheel.current !== candidate) return;
      readMovement(candidate);
      releaseInput(candidate);
      geometry.inputFinished(candidate);
      wheel.current = null;
    });
  };
  const wheelHandler = useRef(handleWebWheel);
  wheelHandler.current = handleWebWheel;
  useLayoutEffect(() => {
    if (!isWeb) return;
    const host = geometry.rawHost();
    if (!host) return;
    const listener = (event: globalThis.WheelEvent) => wheelHandler.current(event);
    // View filters onWheelCapture, so bind the owned DOM host's real capture
    // listener. It only observes; RNW keeps its nested-scroll/default handling.
    host.addEventListener("wheel", listener, { capture: true, passive: true });
    return () => {
      host.removeEventListener("wheel", listener, true);
      if (wheel.current?.frame != null) cancelAnimationFrame(wheel.current.frame);
      wheel.current = null;
      if (touch.current?.frame != null) cancelAnimationFrame(touch.current.frame);
      touch.current = null;
    };
  }, [isWeb, geometry]);
  const historyControl = snapshot.hasMoreBefore ? (
    <Pressable
      testID="load-older-messages"
      accessibilityRole="button"
      disabled={snapshot.loadingOlder}
      onPress={() => void loadOlder()}
      style={styles.historyButton}
    >
      {snapshot.loadingOlder ? (
        <ActivityIndicator size="small" color={colors.textMuted} />
      ) : (
        <Text style={styles.historyButtonText}>{t("task.load_earlier_messages")}</Text>
      )}
    </Pressable>
  ) : null;
  const runtimeFooter = (
    <>
      {snapshot.running && !snapshot.messages.some(
        (message) => message.role === "assistant" && message.turnId === snapshot.activeTurnId,
      ) ? (
        <View style={styles.thinkingRow}>
          <ActivityIndicator size="small" color={colors.textMuted} />
          <Text style={styles.thinkingLabel}>{t("task.kcoder_is_thinking")}</Text>
        </View>
      ) : null}
      {snapshot.error || snapshot.sendAcceptanceUnknown ? (
        <RuntimeErrorBanner
          key={snapshot.error}
          error={snapshot.error ?? t("task.send_acceptance_is_still_unknown_check_execution_status")}
          onReconnect={!snapshot.connected ? () => task.reconnectNow() : undefined}
          onReconcile={snapshot.sendAcceptanceUnknown ? () => task.reconcileSendAcceptance() : undefined}
        />
      ) : null}
    </>
  );
  const emptyState = <EmptyState
    icon={<Bot size={44} color={colors.textDim} />}
    title={t("task.start_a_conversation")}
    body={t("task.tell_kcoder_what_you_want_to_do_in")}
  />;
  const transcriptList = (
    <FlatList
      ref={isWeb ? bindWebList : messageListRef}
      testID="message-list"
      data={messages}
      inverted={isWeb}
      renderItem={({ item }) => {
        const bubble = <MessageBubble
          message={item}
          task={task}
          continuationBusy={snapshot.running || Boolean(snapshot.continuationPending)}
          connected={snapshot.connected}
          onOpenFile={onOpenFile}
          onOpenChanges={onOpenChanges}
        />;
        return isWeb ? (
          <View ref={(node) => geometry.setRow(item.id, node)} collapsable={false}
            onLayout={() => geometry.contentChanged()}>
            {bubble}
          </View>
        ) : bubble;
      }}
      keyExtractor={(message) => message.id}
      style={styles.messages}
      contentContainerStyle={isWeb
        ? [styles.messageContent, { paddingTop: spacing.xxl, paddingBottom: spacing.lg }]
        : styles.messageContent}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
      initialNumToRender={12}
      maxToRenderPerBatch={10}
      windowSize={7}
      removeClippedSubviews={Platform.OS !== "web"}
      maintainVisibleContentPosition={
        Platform.OS === "web" ? undefined : { minIndexForVisible: 0 }
      }
      {...webInputProps}
      onScroll={({ nativeEvent }) => {
        const movement = isWeb ? geometry.movement() : null;
        const distance = isWeb ? movement?.distance ?? 0 :
          nativeEvent.contentSize.height -
          nativeEvent.layoutMeasurement.height -
          nativeEvent.contentOffset.y;
        const top = isWeb ? movement?.top ?? 0 : nativeEvent.contentOffset.y;
        if (Platform.OS === "web") {
          if (touch.current) consumeMovement(touch.current, top, distance);
          if (wheel.current) consumeMovement(wheel.current, top, distance);
        } else {
          consumeNativeMovement(nativeEvent);
        }
        showFollowState();
        const anchor = webPrependAnchor.current;
        if (anchor && !anchor.adjusting) {
          anchor.top = scroller()?.scrollTop ?? anchor.top;
          anchor.height = anchor.scroller.scrollHeight;
        }
      }}
      onScrollBeginDrag={({ nativeEvent }) => {
        if (Platform.OS !== "web") {
          nativeMomentum.current = null;
          nativeDragging.current = { intent: messageFollowState.current,
            generation: mountGeneration.current, top: nativeEvent.contentOffset.y, frame: null };
          // Native begin-drag is an actual drag boundary. Unlike a Web
          // touch-start, it can suspend follow before its first offset event.
          messageFollowState.current = suspendMessageFollowInput(messageFollowState.current);
          nativeDragging.current.intent = messageFollowState.current;
        }
      }}
      onScrollEndDrag={({ nativeEvent }) => {
        if (Platform.OS === "web") return;
        // The final offset also covers a short drag whose throttled scroll
        // callback has not yet run. Momentum retains this exact intent only.
        if (consumeNativeMovement(nativeEvent)) showFollowState();
        if (nativeDragging.current) releaseInput(nativeDragging.current);
        nativeMomentum.current = nativeDragging.current;
        nativeDragging.current = null;
      }}
      onMomentumScrollBegin={({ nativeEvent }) => {
        if (Platform.OS === "web") return;
        const candidate = nativeMomentum.current;
        nativeMomentum.current = null;
        nativeDragging.current = candidate && mountedRef.current &&
          mountGeneration.current === candidate.generation &&
          messageFollowState.current === candidate.intent ? candidate : null;
        if (nativeDragging.current) {
          messageFollowState.current = suspendMessageFollowInput(messageFollowState.current);
          nativeDragging.current.intent = messageFollowState.current;
        }
        if (consumeNativeMovement(nativeEvent)) showFollowState();
      }}
      onMomentumScrollEnd={({ nativeEvent }) => {
        if (Platform.OS === "web") return;
        if (consumeNativeMovement(nativeEvent)) showFollowState();
        if (nativeDragging.current) releaseInput(nativeDragging.current);
        nativeDragging.current = null;
        nativeMomentum.current = null;
      }}
      scrollEventThrottle={100}
      onContentSizeChange={() => {
        if (isWeb) geometry.contentChanged();
        compensateWebPrepend();
        if (deferMessageFollowAnchor(messageFollowState.current)) return;
        if (shouldAnchorLatest(messageFollowState.current))
          messageListRef.current?.scrollToEnd({ animated: false });
      }}
      ListHeaderComponent={isWeb ? runtimeFooter : historyControl}
      ListEmptyComponent={isWeb ? <View>{emptyState}</View> : emptyState}
      ListFooterComponent={isWeb ? historyControl : runtimeFooter}
    />
  );
  return isWeb
    ? <TranscriptAnchorBoundary geometry={geometry}>{transcriptList}</TranscriptAnchorBoundary>
    : transcriptList;
}
