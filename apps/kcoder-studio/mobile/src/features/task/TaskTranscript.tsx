import {
  observeMessageListDistance,
  shouldAnchorLatest,
  stopFollowingLatest,
} from "@/components/message-follow-state";
import { EmptyState } from "@/components/ui";
import { colors } from "@/theme";
import { Bot } from "lucide-react-native";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import { MessageBubble } from "./MessageBubble";
import { RuntimeErrorBanner } from "./RuntimeErrorBanner";
import { styles } from "./taskStyles";
import type { useTaskModelPreferences } from "./useTaskModelPreferences";

export function TaskTranscript({
  model,
}: {
  model: ReturnType<typeof useTaskModelPreferences>;
}) {
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
  } = model;
  return (
    <>
      <FlatList
        ref={messageListRef}
        testID="message-list"
        data={snapshot.messages}
        renderItem={({ item }) => (
          <MessageBubble
            message={item}
            task={task}
            continuationBusy={
              snapshot.running || Boolean(snapshot.continuationPending)
            }
            connected={snapshot.connected}
            onOpenFile={onOpenFile}
            onOpenChanges={onOpenChanges}
          />
        )}
        keyExtractor={(message) => message.id}
        style={styles.messages}
        contentContainerStyle={styles.messageContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        initialNumToRender={12}
        maxToRenderPerBatch={10}
        windowSize={7}
        removeClippedSubviews={Platform.OS !== "web"}
        maintainVisibleContentPosition={
          Platform.OS === "web" ? undefined : { minIndexForVisible: 0 }
        }
        onScroll={({ nativeEvent }) => {
          const distance =
            nativeEvent.contentSize.height -
            nativeEvent.layoutMeasurement.height -
            nativeEvent.contentOffset.y;
          messageFollowState.current = observeMessageListDistance(
            messageFollowState.current,
            distance,
          );
          const shouldShow = !messageFollowState.current.followsLatest;
          setShowJumpToLatest((current) =>
            current === shouldShow ? current : shouldShow,
          );
          const anchor = webPrependAnchor.current;
          if (anchor && !anchor.adjusting) {
            anchor.top = nativeEvent.contentOffset.y;
            anchor.height = anchor.scroller.scrollHeight;
          }
        }}
        onScrollBeginDrag={() => {
          // User gestures take precedence over smooth return-to-latest scrolling. Otherwise
          // the programmatic lock could treat a gesture away from the bottom as an unfinished animation and pull back again.
          messageFollowState.current = stopFollowingLatest();
        }}
        scrollEventThrottle={100}
        onContentSizeChange={() => {
          compensateWebPrepend();
          if (shouldAnchorLatest(messageFollowState.current))
            messageListRef.current?.scrollToEnd({ animated: false });
        }}
        ListHeaderComponent={
          snapshot.hasMoreBefore ? (
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
                <Text style={styles.historyButtonText}>载入更早消息</Text>
              )}
            </Pressable>
          ) : null
        }
        ListEmptyComponent={
          <EmptyState
            icon={<Bot size={44} color={colors.textDim} />}
            title="开始对话"
            body="告诉 KCoder 你想在当前工作区完成什么。"
          />
        }
        ListFooterComponent={
          <>
            {snapshot.running &&
            !snapshot.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.turnId === snapshot.activeTurnId,
            ) ? (
              <View style={styles.thinkingRow}>
                <ActivityIndicator size="small" color={colors.textMuted} />
                <Text style={styles.thinkingLabel}>KCoder 正在思考…</Text>
              </View>
            ) : null}
            {snapshot.error || snapshot.sendAcceptanceUnknown ? (
              <RuntimeErrorBanner
                key={snapshot.error}
                error={
                  snapshot.error ?? "发送是否已接受仍未知，请核对执行状态。"
                }
                onReconnect={
                  !snapshot.connected ? () => task.reconnectNow() : undefined
                }
                onReconcile={
                  snapshot.sendAcceptanceUnknown
                    ? () => task.reconcileSendAcceptance()
                    : undefined
                }
              />
            ) : null}
          </>
        }
      />
    </>
  );
}
