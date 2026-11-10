import { spacing } from "@/theme";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { useInterfaceVersion } from "@/storage/interface-version";
import {
  beginProgrammaticFollow,
  deferMessageFollowAnchor,
  observeMessageListDistance,
  shouldAnchorLatest,
  suspendMessageFollowInput,
} from "@/components/message-follow-state";
import { EmptyState } from "@/components/ui";
import { ArrowDown, Bot } from "lucide-react-native";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  Text,
  View,
  type FlatListInstance,
  type NativeScrollEvent,
  type ViewInstance,
} from "react-native";
import { TranscriptSearchBar } from "./TranscriptSearchBar";
import { searchLoadedTranscript } from "./transcript-search";
import { MessageBubble } from "./MessageBubble";
import { useTextAnimationAllowed } from "./useTextAnimationAllowed";
import { TaskRuntimeError } from "./TaskRuntimeError";
import { useTaskAppearance } from "./taskStyles";
import { InvertedTranscriptGeometry, TranscriptAnchorBoundary } from "./transcript-list-geometry";
import type { ConfirmedTranscript } from "@/storage/session-transcript-projection";
import type { TaskRuntime, TaskSnapshot } from "@/runtime/task-runtime";
import type { useTaskModelPreferences } from "./useTaskModelPreferences";

export type TranscriptReadAnchor = NonNullable<ConfirmedTranscript["anchor"]>;
export type TranscriptDisplayModel = Pick<ReturnType<typeof useTaskModelPreferences>,
  "onOpenFile" | "onOpenChanges" | "messageListRef" | "messageFollowState" |
  "setShowJumpToLatest" | "webPrependAnchor" | "compensateWebPrepend" | "loadOlder" |
  "mountedRef" | "mountGeneration"> & {
  task?: TaskRuntime;
  cwd?: string;
  displayOwner?: object;
  snapshot: Pick<TaskSnapshot, "messages" | "hasMoreBefore" | "loadingOlder" | "running" |
    "activeTurnId" | "error" | "sendAcceptanceUnknown" | "connected" | "continuationPending">;
};

type JumpToLatestModel = Pick<TranscriptDisplayModel,
  "messageListRef" | "messageFollowState" | "setShowJumpToLatest" | "webPrependAnchor"> & {
    snapshot: Pick<TranscriptDisplayModel["snapshot"], "messages">;
  };

export function JumpToLatestButton({ model, onReadAnchor, inComposer = false }: {
  model: JumpToLatestModel;
  inComposer?: boolean;
  onReadAnchor?(anchor: TranscriptReadAnchor, userDecision?: boolean): void;
}) {
  useLocale();
  const v3 = useInterfaceVersion() === "v3";
  const { styles, colors } = useTaskAppearance();
  return (
    <Pressable testID="jump-to-latest" accessibilityRole="button"
      hitSlop={v3 ? 4 : undefined}
      accessibilityLabel={t("task.jump_to_latest_message")}
      onPress={() => {
        model.webPrependAnchor.current = null;
        model.messageFollowState.current = beginProgrammaticFollow();
        const last = model.snapshot.messages.at(-1);
        if (last) onReadAnchor?.({ messageId: last.id, offset: 0, followsLatest: true }, true);
        model.setShowJumpToLatest(false);
        model.messageListRef.current?.scrollToEnd({ animated: true });
      }} style={[styles.jumpToLatest, styles.jumpToLatestPosition, inComposer && styles.jumpToLatestInComposer]}>
      <ArrowDown size={v3 ? 20 : 16} color={colors.text} />
      {!v3 ? <Text style={styles.jumpToLatestText}>{t("task.latest")}</Text> : null}
    </Pressable>
  );
}
export function TaskTranscript({ model, readOnly = false, initialAnchor, onReadAnchor, searchOpen = false, onSearchClose, actions, connectionNoticeOwned = false }: {
  connectionNoticeOwned?: boolean;
  actions?: { editableId?: string; forkIds: Set<string>; onEdit(id: string): void; onFork(id: string): void };
  readOnly?: boolean;
  searchOpen?: boolean;
  onSearchClose?(): void;
  model: TranscriptDisplayModel;
  initialAnchor?: TranscriptReadAnchor;
  onReadAnchor?(anchor: TranscriptReadAnchor, userDecision?: boolean): void;
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
  const textAnimationAllowed = useTextAnimationAllowed();
  const currentModel = useRef(model);
  currentModel.current = model;
  const geometryRef = useRef<InvertedTranscriptGeometry | null>(null);
  if (!geometryRef.current) geometryRef.current = new InvertedTranscriptGeometry(() => ({
    intent: currentModel.current.messageFollowState.current,
    mounted: currentModel.current.mountedRef.current,
    generation: currentModel.current.mountGeneration.current,
    owner: currentModel.current.displayOwner ?? currentModel.current.task!,
  }));
  const geometry = geometryRef.current;
  const restore = useRef<TranscriptReadAnchor | undefined>(undefined);
  const initialIntent = useRef(messageFollowState.current);
  const userInput = useRef(false);
  const anchorReceived = useRef(false);
  const restoreAttempts = useRef(0);
  if (initialAnchor && !anchorReceived.current) {
    if (!userInput.current && messageFollowState.current === initialIntent.current) {
      const located = snapshot.messages.filter(message => message.id === initialAnchor.messageId).length === 1;
      if (initialAnchor.followsLatest || located) {
        anchorReceived.current = true;
        restore.current = initialAnchor;
        restoreAttempts.current = 0;
      }
      // An unresolved source preserves reading intent without consuming the later exact marker.
      if (!initialAnchor.followsLatest && messageFollowState.current.followsLatest) {
        messageFollowState.current = { followsLatest: false, programmaticFollow: false, awaitingDistanceAway: true };
        initialIntent.current = messageFollowState.current;
      }
    }
  }
  const nativeRows = useRef(new Map<string, ViewInstance>());
  const firstVisible = useRef<string | null>(null);
  const anchorCallback = useRef(onReadAnchor);
  anchorCallback.current = onReadAnchor;
  const publishAnchor = () => {
    if (!mountedRef.current) return;
    if (messageFollowState.current.followsLatest) {
      const last = snapshot.messages.at(-1);
      if (last) anchorCallback.current?.({ messageId: last.id, offset: 0, followsLatest: true }, userInput.current || messageFollowState.current.programmaticFollow);
      return;
    }
    if (isWeb) {
      const marker = geometry.readingAnchor();
      if (marker) anchorCallback.current?.(marker, userInput.current);
      return;
    }
    const id = firstVisible.current;
    const row = id ? nativeRows.current.get(id) : null;
    const host = messageListRef.current?.getNativeScrollRef();
    const generation = mountGeneration.current;
    const owner = currentModel.current.displayOwner ?? currentModel.current.task;
    const intent = messageFollowState.current;
    if (!id || !row?.measureInWindow || !host?.measureInWindow) return;
    host.measureInWindow((_x, top) => row.measureInWindow((_rx, rowTop) => {
      if (mountedRef.current && generation === mountGeneration.current &&
          owner === (currentModel.current.displayOwner ?? currentModel.current.task) &&
          intent === messageFollowState.current && !intent.followsLatest)
        anchorCallback.current?.({ messageId: id, offset: rowTop - top, followsLatest: false }, userInput.current);
    }));
  };
  const restoreReading = () => {
    const marker = restore.current;
    if (!marker || marker.followsLatest || !mountedRef.current) return;
    if (isWeb && geometry.adoptReadingAnchor(marker)) {
      restore.current = undefined; geometry.contentChanged(); return;
    }
    const index = messages.findIndex(message => message.id === marker.messageId);
    if (index < 0) { restore.current = undefined; return; } // Cropped/deleted row: retain reading intent.
    if (messageListRef.current && restoreAttempts.current < 2) {
      restoreAttempts.current++;
      messageListRef.current.scrollToIndex({ index, viewOffset: marker.offset, animated: false });
      if (!isWeb && nativeRows.current.has(marker.messageId)) restore.current = undefined;
    }
  };

  useLayoutEffect(() => { restoreReading(); }, [initialAnchor]);
  const anchorPublisher = useRef(publishAnchor);
  anchorPublisher.current = publishAnchor;
  useLayoutEffect(() => () => anchorPublisher.current(), []);
  const bindWebList = useCallback((list: FlatListInstance | null) => {
    messageListRef.current = geometry.bind(list);
  }, [geometry, messageListRef]);
  const messages = useMemo(() => isWeb ? [...snapshot.messages].reverse() : snapshot.messages,
    [isWeb, snapshot.messages]);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedMatch, setSelectedMatch] = useState("");
  const searchResult = useMemo(() => searchLoadedTranscript(snapshot.messages, searchQuery), [snapshot.messages, searchQuery]);
  const searchMatches = searchResult.matches;
  const searchIndex = Math.max(0, searchMatches.findIndex(match => match.key === selectedMatch));
  const activeSearchMatch = searchOpen ? searchMatches[searchIndex] : undefined;
  const jumpToMatch = (match = activeSearchMatch) => {
    if (!match || !mountedRef.current) return;
    userInput.current = true;
    messageFollowState.current = { followsLatest: false, programmaticFollow: false, awaitingDistanceAway: true };
    webPrependAnchor.current = null;
    setShowJumpToLatest(true);
    restore.current = { messageId: match.messageId, offset: 0, followsLatest: false };
    restoreAttempts.current = 0;
    anchorCallback.current?.(restore.current, true);
    restoreReading();
  };
  useEffect(() => { if (searchOpen) jumpToMatch(); }, [searchOpen, activeSearchMatch?.key, searchQuery]);
  type Candidate = {
    intent: typeof messageFollowState.current;
    generation: number;
    top: number;
    direction?: "toward-old" | "toward-latest";
    frame: number | null;
    owner?: object;
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
        (isWeb && (candidate.owner !== (currentModel.current.displayOwner ?? currentModel.current.task!) ||
          candidate.host !== geometry.rawHost() || candidate.outerInput !== true)) ||
        messageFollowState.current !== candidate.intent) return false;
    const previousIntent = messageFollowState.current;
    const delta = top - candidate.top;
    if ((candidate.direction === "toward-old" && delta < 0) ||
        (candidate.direction === "toward-latest" && delta > 0)) {
      userInput.current = true;
      restore.current = undefined;
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
        (isWeb && (candidate.owner !== (currentModel.current.displayOwner ?? currentModel.current.task!) || candidate.host !== geometry.rawHost())) ||
        candidate.generation !== mountGeneration.current ||
        candidate.intent !== messageFollowState.current) return;
    messageFollowState.current = suspendMessageFollowInput(messageFollowState.current);
    candidate.intent = messageFollowState.current;
  };
  const releaseInput = (candidate: Candidate) => {
    if (!mountedRef.current || candidate.generation !== mountGeneration.current ||
        (isWeb && (candidate.owner !== (currentModel.current.displayOwner ?? currentModel.current.task!) || candidate.host !== geometry.rawHost())) ||
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
          owner: model.displayOwner ?? task!, host: element, target, outerInput: false };
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
    userInput.current = true;
    restore.current = undefined;
    clearWheel();
    finishTouch();
    const candidate: Candidate = { intent: messageFollowState.current,
      generation: mountGeneration.current, top: geometry.movement()!.top,
      direction: event.deltaY < 0 ? "toward-old" : "toward-latest", frame: null,
      owner: model.displayOwner ?? task!, host: element, outerInput: true };
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
      <TaskRuntimeError snapshot={snapshot} task={task} readOnly={readOnly} connectionNoticeOwned={connectionNoticeOwned} />
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
          turnRunning={!readOnly && snapshot.running && Boolean(snapshot.activeTurnId) && item.turnId === snapshot.activeTurnId}
          animateText={textAnimationAllowed && !readOnly && snapshot.connected && snapshot.running &&
            Boolean(snapshot.activeTurnId) && item.turnId === snapshot.activeTurnId}
          message={item}
          onEdit={actions && actions.editableId === item.id ? () => actions.onEdit(item.id) : undefined}
          onFork={actions?.forkIds.has(item.id) ? () => actions.onFork(item.id) : undefined}
          readOnly={readOnly}
          task={task}
          cwd={model.cwd}
          continuationBusy={snapshot.running || Boolean(snapshot.continuationPending)}
          connected={snapshot.connected}
          onOpenFile={onOpenFile}
          onOpenChanges={onOpenChanges}
        />;
        return (
          <View nativeID={`message-${encodeURIComponent(item.id)}`} ref={(node) => {
            if (isWeb) geometry.setRow(item.id, node);
            else if (node) nativeRows.current.set(item.id, node);
            else nativeRows.current.delete(item.id);
          }} collapsable={false}
            onLayout={() => { restoreReading(); if (isWeb) geometry.contentChanged(); }}
            style={activeSearchMatch?.messageId === item.id ? { borderLeftWidth: 2, borderLeftColor: colors.accent } : undefined}>
            {bubble}
          </View>
        );
      }}
      onViewableItemsChanged={useRef(({ viewableItems }: { viewableItems: { item: { id: string } }[] }) => {
        firstVisible.current = viewableItems[0]?.item.id ?? null;
      }).current}
      onScrollToIndexFailed={({ averageItemLength, index }) => {
        if (mountedRef.current && restore.current && !restore.current.followsLatest)
          messageListRef.current?.scrollToOffset({ offset: Math.max(0, averageItemLength * index - restore.current.offset), animated: false });
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
        publishAnchor();
        const anchor = webPrependAnchor.current;
        if (anchor && !anchor.adjusting) {
          anchor.top = scroller()?.scrollTop ?? anchor.top;
          anchor.height = anchor.scroller.scrollHeight;
        }
      }}
      onScrollBeginDrag={({ nativeEvent }) => {
        if (Platform.OS !== "web") {
          userInput.current = true;
          restore.current = undefined;
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
        restoreReading();
        if (isWeb) geometry.contentChanged();
        compensateWebPrepend();
        if (deferMessageFollowAnchor(messageFollowState.current)) return;
        if (shouldAnchorLatest(messageFollowState.current))
          messageListRef.current?.scrollToEnd({ animated: false });
      }}
      ListHeaderComponent={(isWeb ? runtimeFooter : historyControl) ?? undefined}
      ListEmptyComponent={(isWeb ? <View>{emptyState}</View> : emptyState) ?? undefined}
      ListFooterComponent={(isWeb ? historyControl : runtimeFooter) ?? undefined}
    />
  );
  return <>
    {searchOpen ? <TranscriptSearchBar query={searchQuery} onQuery={(value) => { setSearchQuery(value); setSelectedMatch(""); }}
      matches={searchMatches} total={searchResult.total} index={searchIndex} onClose={() => onSearchClose?.()}
      onStep={(delta) => {
        if (!searchMatches.length) return;
        const match = searchMatches[(searchIndex + delta + searchMatches.length) % searchMatches.length];
        setSelectedMatch(match.key); jumpToMatch(match);
      }} /> : null}
    {isWeb ? <TranscriptAnchorBoundary geometry={geometry}>{transcriptList}</TranscriptAnchorBoundary> : transcriptList}
  </>;
}
