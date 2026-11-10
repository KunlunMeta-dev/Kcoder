import { useEffect, useMemo, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useIsFocused } from "expo-router";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ChevronLeft, Inbox } from "lucide-react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { useApp } from "@/state/AppContext";
import { profileAuthorizationScopeKey } from "@/state/profile-coordinator";
import { interactionServerIdentity } from "@/runtime/task-runtime/threadDirectory";
import { taskRuntimeRegistry } from "@/runtime/task-runtime";
import type { TaskRuntime } from "@/runtime/task-runtime";
import type { InteractionInboxRow, PendingInteraction } from "@/runtime/task-runtime/types";
import { spacing, useThemedStyles, type ThemeColors } from "@/theme";
import {
  interactionMatchesInboxRow,
  interactionTaskHref,
} from "./locator";

interface InboxItem {
  row: InteractionInboxRow;
  actionable: boolean;
}

function currentInteraction(
  row: InteractionInboxRow,
  entries: Array<{ profileId: string; serverId: string; threadId: string; runtime: TaskRuntime }>,
): { runtime: TaskRuntime; interaction: PendingInteraction } | null {
  const entry = entries.find((candidate) => candidate.profileId === row.profileId &&
    candidate.serverId === row.serverId && candidate.threadId === row.threadId);
  if (!entry) return null;
  const interaction = entry.runtime.pendingInteractions.find((candidate) =>
    interactionMatchesInboxRow(candidate, row),
  );
  return interaction ? { runtime: entry.runtime, interaction } : null;
}

export function InteractionInboxScreen() {
  useLocale();
  const { colors, styles } = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const focused = useIsFocused();
  const { profileId } = useLocalSearchParams<{ profileId: string }>();
  const {
    hydrated,
    activeProfile,
    runtime: appRuntime,
    demo,
    runtimeActivationEpoch,
    isCurrentInteractionOwner,
  } = useApp();
  const authorizedView = Boolean(hydrated && !demo && activeProfile &&
    activeProfile.id === profileId && appRuntime.serversReady &&
    !appRuntime.reauthorizationRequired);
  const authorizationScope = authorizedView && activeProfile
    ? profileAuthorizationScopeKey(activeProfile)
    : null;
  const [revision, setRevision] = useState(0);
  const [staleNotice, setStaleNotice] = useState(false);

  useEffect(() => {
    let mounted = true;
    const refresh = () => { if (mounted) setRevision((value) => value + 1); };
    const unsubscribe = taskRuntimeRegistry.subscribe(refresh);
    refresh();
    return () => { mounted = false; unsubscribe(); };
  }, [authorizationScope, focused, runtimeActivationEpoch]);

  const projection = useMemo(() => {
    if (!authorizationScope || !activeProfile || !authorizedView) {
      return { items: [] as InboxItem[], overflow: { omittedRows: 0, mayContainUntrackedRows: false } };
    }
    const entries = taskRuntimeRegistry.entries();
    const servers = appRuntime.servers;
    const rows = taskRuntimeRegistry.interactionInboxRows(authorizationScope);
    const items = rows.flatMap((row): InboxItem[] => {
      if (row.profileId !== activeProfile.id) return [];
      const server = servers.find((candidate) => candidate.id === row.serverId);
      if (!server || interactionServerIdentity(server) !== row.serverConfigIdentity) return [];
      const current = currentInteraction(row, entries);
      const runtime = current?.runtime;
      const interaction = current?.interaction;
      const actionable = Boolean(row.liveActionable && runtime && interaction &&
        !runtime.disposed && !runtime.reconnecting && runtime.getSnapshot().connected &&
        runtime.client?.isTransportOpen() &&
        runtime.runtimeInstanceNonce === row.runtimeInstanceNonce &&
        runtime.clientGeneration === row.originClientGeneration &&
        row.profileActivationEpoch === runtimeActivationEpoch &&
        runtime.reconnectContext?.profile.id === activeProfile.id &&
        profileAuthorizationScopeKey(runtime.reconnectContext.profile) === authorizationScope &&
        interactionServerIdentity(runtime.reconnectContext.server) === row.serverConfigIdentity &&
        isCurrentInteractionOwner(interaction.owner) && runtime.isInteractionActionable(interaction));
      return [{ row, actionable }];
    });
    return {
      items,
      overflow: taskRuntimeRegistry.interactionInboxOverflow(authorizationScope),
    };
  }, [authorizationScope, activeProfile, appRuntime.servers, authorizedView,
    revision, runtimeActivationEpoch, isCurrentInteractionOwner]);

  const openOriginal = (shown: InteractionInboxRow) => {
    if (!focused || !authorizedView || !activeProfile || !authorizationScope ||
        activeProfile.id !== profileId || appRuntime.reauthorizationRequired || demo) {
      setStaleNotice(true);
      return;
    }
    const currentServer = appRuntime.servers.find((candidate) => candidate.id === shown.serverId);
    const latest = taskRuntimeRegistry.interactionInboxRows(authorizationScope).find((row) =>
      row.profileId === shown.profileId && row.serverId === shown.serverId &&
      row.appServerId === shown.appServerId &&
      row.threadId === shown.threadId && row.kind === shown.kind &&
      row.requestId === shown.requestId && row.interactionId === shown.interactionId &&
      row.turnId === shown.turnId && row.appServerEpoch === shown.appServerEpoch);
    if (!currentServer || interactionServerIdentity(currentServer) !== shown.serverConfigIdentity ||
        !latest || latest.serverConfigIdentity !== interactionServerIdentity(currentServer)) {
      setStaleNotice(true);
      setRevision((value) => value + 1);
      return;
    }
    const probe = {
      profileId: activeProfile.id,
      profileAuthorizationScopeKey: authorizationScope,
      serverId: currentServer.id,
      serverConfigIdentity: interactionServerIdentity(currentServer),
      threadId: latest.threadId,
      turnId: null,
      appServerEpoch: null,
      runtimeInstanceNonce: 0,
      profileActivationEpoch: runtimeActivationEpoch,
      originClientGeneration: 0,
      status: "unknown" as const,
    };
    if (!isCurrentInteractionOwner(probe)) {
      setStaleNotice(true);
      return;
    }
    setStaleNotice(false);
    router.push(interactionTaskHref(latest) as never);
  };

  const isBlocked = hydrated && (!activeProfile || activeProfile.id !== profileId || demo ||
    appRuntime.reauthorizationRequired || !appRuntime.serversReady);
  const hasOverflow = projection.overflow.omittedRows > 0 ||
    projection.overflow.mayContainUntrackedRows;

  return (
    <SafeAreaView style={styles.root} edges={["top", "left", "right"]}>
      <View style={styles.header}>
        <Pressable testID="interaction-inbox-back" accessibilityRole="button"
          accessibilityLabel={t("common.back")} onPress={() => router.back()} style={styles.iconButton}>
          <ChevronLeft size={20} color={colors.textMuted} />
        </Pressable>
        <Text numberOfLines={1} style={styles.title}>{t("inbox.title")}</Text>
        <Inbox size={19} color={colors.blue} />
      </View>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.lg }]}>
        <Text style={styles.scope}>{t("inbox.scope")}</Text>
        {staleNotice ? <Text accessibilityRole="alert" testID="inbox-stale-notice" style={styles.readonly}>
          {t("inbox.stale")}
        </Text> : null}
        {isBlocked ? <Text accessibilityRole="alert" testID="inbox-out-of-scope" style={styles.readonly}>
          {t("inbox.out_of_scope")}
        </Text> : !hydrated ? <ActivityIndicator testID="inbox-loading" color={colors.text} /> : null}
        {!isBlocked && hydrated && hasOverflow ? (
          <Text accessibilityRole="alert" testID="inbox-overflow" style={styles.readonly}>
            {t("inbox.overflow")}
          </Text>
        ) : null}
        {!isBlocked && hydrated && projection.items.length === 0 && !hasOverflow ? (
          <View style={styles.empty}>
            <Inbox size={38} color={colors.textDim} />
            <Text style={styles.emptyTitle}>{t("inbox.empty")}</Text>
          </View>
        ) : null}
        {projection.items.map(({ row, actionable }) => (
          <View key={JSON.stringify([row.serverConfigIdentity, row.threadId, row.turnId,
            row.appServerEpoch, row.kind, row.requestId, row.interactionId])}
            style={styles.row} testID={`inbox-row-${row.kind}-${row.requestId}`}>
            <View style={styles.rowHeading}>
              <Text style={styles.rowTitle}>{row.kind === "approval"
                ? t("inbox.pending_approval") : t("inbox.pending_question")}</Text>
              <Text style={[styles.status, actionable ? styles.actionable : styles.readonly]}>
                {actionable ? t("inbox.status_actionable") : row.status === "unsupported"
                  ? t("inbox.status_unsupported") : row.status === "unknown"
                    ? t("inbox.status_unknown") : t("inbox.status_readonly")}
              </Text>
            </View>
            <Text numberOfLines={2} style={styles.threadTitle}>{row.title || t("task.untitled_task")}</Text>
            {row.sourceAgent ? <Text style={styles.meta}>
              {t("inbox.from_subagent", { p0: row.sourceAgent.agentId })}
            </Text> : null}
            {row.sourceAgent ? <Text style={styles.meta}>
              {t("inbox.subagent_parent", { p0: row.sourceAgent.parentSessionId })}
            </Text> : null}
            <Text numberOfLines={2} style={styles.meta}>
              {t("inbox.target_workspace", { p0: appRuntime.servers.find((server) => server.id === row.serverId)?.label ?? row.serverId,
                p1: row.cwd || "—" })}
            </Text>
            {!actionable ? <Text style={styles.readonly}>{t("inbox.original_connection_only")}</Text> : null}
            <Pressable testID={`inbox-open-${row.kind}-${row.requestId}`} accessibilityRole="button"
              accessibilityLabel={t("inbox.open_thread", { p0: row.title || row.threadId })}
              onPress={() => openOriginal(row)} style={styles.openButton}>
              <Text style={styles.openText}>{t("inbox.open_thread_button")}</Text>
            </Pressable>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(colors: ThemeColors) {
  return {
    colors,
    styles: StyleSheet.create({
      root: { flex: 1, backgroundColor: colors.background },
      header: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: spacing.sm,
        paddingHorizontal: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors.border },
      iconButton: { width: 36, height: 40, alignItems: "center", justifyContent: "center" },
      title: { flex: 1, minWidth: 0, color: colors.text, fontSize: 17, fontWeight: "600" },
      content: { padding: spacing.md, gap: spacing.md },
      scope: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
      empty: { alignItems: "center", gap: spacing.sm, paddingVertical: spacing.xxl },
      emptyTitle: { color: colors.textMuted, textAlign: "center", fontSize: 15 },
      row: { borderWidth: 1, borderColor: colors.border, borderRadius: 14,
        backgroundColor: colors.surface, padding: spacing.md, gap: spacing.xs },
      rowHeading: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: spacing.sm },
      rowTitle: { flex: 1, minWidth: 0, color: colors.text, fontSize: 15, fontWeight: "600" },
      status: { maxWidth: "48%", textAlign: "right", fontSize: 11, lineHeight: 15 },
      actionable: { color: colors.green },
      readonly: { color: colors.yellow, fontSize: 12, lineHeight: 17 },
      threadTitle: { color: colors.text, fontSize: 14 },
      meta: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
      openButton: { marginTop: spacing.xs, minHeight: 40, alignItems: "center", justifyContent: "center",
        borderRadius: 10, backgroundColor: colors.surfaceSidebar },
      openText: { color: colors.blue, fontSize: 14, fontWeight: "600" },
    }),
  };
}
