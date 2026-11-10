import { ConversationV3Background, type ConversationV3Navigation } from "@/features/interface/ConversationV3";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, Text, View, type FlatListInstance, type LayoutChangeEvent } from "react-native";
import { initialMessageFollowState } from "@/components/message-follow-state";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { KeyboardSafeView } from "@/components/keyboard-safe-view";
import { TaskDisplayHeader } from "./TaskHeader";
import { TaskExpertMenuItem, TaskMenuSheet, TaskNavigationItems, TaskPermissionMenuItem } from "./TaskMenu";
import { useInterfaceVersion } from "@/storage/interface-version";
import { JumpToLatestButton, TaskTranscript, type TranscriptDisplayModel, type TranscriptReadAnchor } from "./TaskTranscript";
import { CachedTaskComposer } from "./TaskComposer";
import type { CachedSession } from "./session-cache-coordinator";
import { handleTranscriptLayoutChange } from "./useTaskHistory";
import { useTaskAppearance } from "./taskStyles";
import { ComposerFloatingLayer } from "./ComposerFloatingLayer";

/** Display only: no runtime, reconnect context, registry entry or mutation hooks. */
export function CachedSessionView({ cached, owner, onBack, onReadAnchor, initialAnchor, topInset, bottomInset,
  offline, failure, composerDraft, showDisabledTaskActions = true, onRetry, draftRecoveryError, onRetryDraftRecovery, navigation }: {
  offline: boolean; failure?: string | null; composerDraft: string; showDisabledTaskActions?: boolean; onRetry(): void;
  draftRecoveryError?: string | null; onRetryDraftRecovery?(): void;
  cached: CachedSession; owner: object; onBack(): void; topInset: number; bottomInset: number;
  onReadAnchor?(anchor: TranscriptReadAnchor, userDecision?: boolean): void; initialAnchor?: TranscriptReadAnchor;
  navigation?: ConversationV3Navigation;
}) {
  const locale = useLocale();
  const v3 = useInterfaceVersion() === "v3";
  const { styles, colors } = useTaskAppearance();
  const messageListRef = useRef<FlatListInstance>(null);
  const messageListLayoutHeight = useRef(0);
  const messageFollowState = useRef(initialMessageFollowState());
  const ownerRef = useRef<object | undefined>(owner);
  ownerRef.current = owner;
  const mountedRef = useRef(true);
  const mountGeneration = useRef(0);
  const webPrependAnchor = useRef<TranscriptDisplayModel["webPrependAnchor"]["current"]>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [failureExpanded, setFailureExpanded] = useState(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; mountGeneration.current++; };
  }, []);
  const model: TranscriptDisplayModel = { displayOwner: owner, cwd: cached.record.scope.cwd,
    snapshot: { messages: cached.view.messages, hasMoreBefore: false, loadingOlder: false,
      running: false, activeTurnId: null, error: null, connected: false },
    messageListRef, messageFollowState, mountedRef, mountGeneration, webPrependAnchor, setShowJumpToLatest,
    compensateWebPrepend: () => false, loadOlder: async () => {}, onOpenFile: () => false, onOpenChanges: () => {} };
  const handleMessageListLayout = (event: LayoutChangeEvent) => handleTranscriptLayoutChange({
    messageListRef, messageListLayoutHeight, messageFollowState, setShowJumpToLatest,
    mountedRef, mountGeneration, ownerRef,
  }, event);
  return <KeyboardSafeView testID="session-cache-view" style={[styles.root, { paddingTop: topInset }]}>
    <ConversationV3Background />
    <TaskDisplayHeader title={cached.record.title} status={cached.record.scope.cwd} connected={false} onBack={onBack}
      navigation={navigation}
      onMore={() => setMenuOpen(true)}
      disabledActions={showDisabledTaskActions ? { menu: true, new: true } : undefined} />
    <TaskMenuSheet visible={menuOpen} onClose={() => setMenuOpen(false)}>
      <TaskExpertMenuItem disabled detail={t("expert.cached_unavailable")} />
      {v3 ? <TaskPermissionMenuItem disabled /> : null}
      <TaskNavigationItems onSearch={() => { setMenuOpen(false); setSearchOpen(true); }} />
    </TaskMenuSheet>
    <ComposerFloatingLayer style={styles.panel}>
      <View onLayout={handleMessageListLayout} style={styles.messageListStage}>
        <TaskTranscript searchOpen={searchOpen} onSearchClose={() => setSearchOpen(false)} model={model} readOnly initialAnchor={initialAnchor ?? cached.record.anchor} onReadAnchor={onReadAnchor} />
        {!v3 && showJumpToLatest ? <JumpToLatestButton model={model} onReadAnchor={onReadAnchor} /> : null}
      </View>
      <View testID="session-cache-status" accessibilityLiveRegion="polite" role="status" style={styles.connectionBanner}>
        {!offline ? <ActivityIndicator size="small" color={colors.yellow} /> : null}
        <View style={styles.cacheStatusCopy}>
          <Text testID="session-cache-phase" numberOfLines={1} style={styles.connectionBannerText}
            accessibilityLabel={t(offline ? "task.cache_partial_offline" : "task.cache_partial_syncing_accessibility")}>
            {t(offline ? "task.cache_partial_offline" : "task.cache_partial_syncing")}
          </Text>
          <Text numberOfLines={1} style={styles.cacheStatusDetail}>
            {t("task.cache_confirmed_at", { time: new Date(cached.record.updatedAt).toLocaleString(locale) })}
          </Text>
          {failure ? <View testID="session-cache-error-details">
            <Text testID="session-cache-error" accessibilityRole="alert" numberOfLines={failureExpanded ? undefined : 2}
              style={styles.cacheStatusFailure}>{failure}</Text>
            <Pressable testID="session-cache-error-toggle" accessibilityRole="button"
              accessibilityState={{ expanded: failureExpanded }}
              accessibilityLabel={t(failureExpanded ? "task.cache_hide_error_details" : "task.cache_show_error_details")}
              onPress={() => setFailureExpanded((expanded) => !expanded)}>
              <Text style={styles.errorDetailsText}>
                {t(failureExpanded ? "task.cache_hide_error_details" : "task.cache_show_error_details")}
              </Text>
            </Pressable>
          </View> : null}
          {draftRecoveryError ? <Text testID="session-cache-draft-recovery-error" accessibilityRole="alert"
            style={styles.cacheStatusFailure}>{draftRecoveryError}</Text> : null}
        </View>
        {offline ? <Pressable testID="session-cache-retry" accessibilityRole="button" onPress={onRetry}
          style={styles.cacheRetryButton}>
          <Text style={styles.cacheRetryText}>{t("task.cache_retry")}</Text>
        </Pressable> : null}
        {draftRecoveryError && onRetryDraftRecovery ? <Pressable testID="session-cache-draft-retry"
          accessibilityRole="button" onPress={onRetryDraftRecovery} style={styles.cacheRetryButton}>
          <Text style={styles.cacheRetryText}>{t("task.retry_workspace_recovery")}</Text>
        </Pressable> : null}
      </View>
      <CachedTaskComposer draft={composerDraft} bottomInset={bottomInset} offline={offline}
        aboveComposer={v3 && showJumpToLatest ? <JumpToLatestButton model={model} onReadAnchor={onReadAnchor} inComposer /> : undefined} />
    </ComposerFloatingLayer>
  </KeyboardSafeView>;
}
