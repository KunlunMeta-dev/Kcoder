import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Animated,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleHelp,
  Clock3,
  FolderPlus,
  Home,
  MoreHorizontal,
  Plus,
  Server,
  Settings,
  X,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type {
  GatewayProfile,
  KCoderServer,
  ThreadSummary,
} from "@/gateway/types";
import { radius, spacing, useTheme, useThemedStyles, type ThemeColors } from "@/theme";
import { useModalFocusTrap } from "./use-modal-focus-trap";
import { groupThreadsByWorkspace, hiddenThreadCount, projectVisibleThreads, threadStatusTone, threadActivityLabel } from "./thread-list-presentation";
import { ThreadActionsSheet, type ThreadActionTarget } from "./thread-actions-sheet";
import { clampDrawerTranslation, shouldActivateDrawerDismiss, shouldDismissDrawer } from "./mobile-drawer-gesture";
import { DrawerDismissal } from "./mobile-drawer-dismissal";
import type { TaskRuntime, WorkspaceOption } from "@/runtime/task-runtime";
import { useCollapsedServerSections } from "@/storage/use-collapsed-server-sections";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export function MobileDrawer({
  visible,
  onClose,
  onDismissStart,
  profileId,
  profile,
  servers,
  threads = {},
  workspaceOptions = {},
  workspaceErrors = {},
  threadErrors = {},
  loading = {}, hasMore = {}, onLoadServer, onLoadProjects,
  demo = false,
  onThreadRenamed,
  onThreadRemoved,
  liveTask,
  liveTaskServerId,
}: {
  visible: boolean;
  onClose(): void;
  onDismissStart?(): void;
  profileId: string;
  profile: GatewayProfile;
  servers: KCoderServer[];
  threads?: Record<string, ThreadSummary[]>;
  workspaceOptions?: Record<string, WorkspaceOption[]>;
  workspaceErrors?: Record<string, string>;
  threadErrors?: Record<string, string>;
  loading?: Record<string, boolean>;
  hasMore?: Record<string, boolean>;
  onLoadServer?(serverId: string, more?: boolean): Promise<void>;
  onLoadProjects?(serverId: string): Promise<void>;
  demo?: boolean;
  onThreadRenamed(serverId: string, thread: ThreadSummary): void;
  onThreadRemoved(
    serverId: string,
    threadId: string,
    kind: "archived" | "restored" | "deleted",
  ): void;
  liveTask?: TaskRuntime;
  liveTaskServerId?: string;
}) {
  useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const routeParams = useLocalSearchParams<{
    serverId?: string;
    threadId?: string;
  }>();
  const drawerWidthRef = useRef(390);
  const [drawerWidth, setDrawerWidth] = useState(390);
  const translateX = useRef(new Animated.Value(0)).current;
  const [expandedServerIds, setExpandedServerIds] = useState<Set<string>>(new Set());
  const [actionTarget, setActionTarget] = useState<ThreadActionTarget | null>(null);
  const dismissal = useRef(new DrawerDismissal(visible)).current;
  const [closing, setClosing] = useState(false);
  const { serverIds: collapsedServerIds, hydrated: collapseHydrated, toggle: toggleServerCollapsed } = useCollapsedServerSections(profileId);
  const drawerVisible = visible && !actionTarget;
  const restoreDrawer = useCallback(() => {
    if (dismissal.closing) return;
    Animated.spring(translateX, { toValue: 0, useNativeDriver: true, speed: 24, bounciness: 0 }).start();
  }, [dismissal, translateX]);
  const beginDismissal = useCallback(() => {
    const generation = dismissal.begin();
    if (generation === undefined) return;
    setClosing(true);
    onDismissStart?.();
    return generation;
  }, [dismissal, onDismissStart]);
  const dismissDrawer = useCallback(() => {
    const generation = beginDismissal();
    if (generation === undefined) return;
    Animated.timing(translateX, { toValue: -drawerWidthRef.current, duration: 180, useNativeDriver: true }).start(() => {
      // Dismiss intent remains authoritative even if this animation was interrupted.
      if (!dismissal.finish(generation)) return;
      onClose();
    });
  }, [beginDismissal, dismissal, onClose, translateX]);
  const drawerRef = useModalFocusTrap(drawerVisible, dismissDrawer);
  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponderCapture: (_event, gesture) => !dismissal.closing && shouldActivateDrawerDismiss(gesture.dx, gesture.dy),
    onPanResponderMove: (_event, gesture) => { if (!dismissal.closing) translateX.setValue(clampDrawerTranslation(gesture.dx, drawerWidthRef.current)); },
    onPanResponderRelease: (_event, gesture) => {
      if (dismissal.closing) return;
      if (shouldDismissDrawer(gesture.dx, gesture.vx, drawerWidthRef.current)) dismissDrawer();
      else restoreDrawer();
    },
    onPanResponderTerminate: restoreDrawer,
  }), [dismissDrawer, dismissal, restoreDrawer, translateX]);
  const scrimOpacity = translateX.interpolate({ inputRange: [-drawerWidth, 0], outputRange: [0, 1], extrapolate: "clamp" });

  useLayoutEffect(() => {
    dismissal.updateVisible(visible);
    setClosing(false);
    return () => dismissal.updateVisible(false);
  }, [dismissal, visible]);

  useLayoutEffect(() => {
    if (drawerVisible) translateX.setValue(0);
  }, [drawerVisible, translateX]);

  const navigate = (href: Parameters<typeof router.push>[0]) => {
    const generation = beginDismissal();
    if (generation === undefined || !dismissal.finish(generation)) return;
    onClose();
    router.push(href);
  };
  const replaceTask = (href: Parameters<typeof router.replace>[0]) => {
    const generation = beginDismissal();
    if (generation === undefined || !dismissal.finish(generation)) return;
    onClose();
    router.replace(href);
  };
  const toggleServerThreadsExpanded = (serverId: string) => {
    setExpandedServerIds((current) => {
      const next = new Set(current);
      if (next.has(serverId)) next.delete(serverId);
      else next.add(serverId);
      return next;
    });
  };
  return (
    <>
      <Modal
        visible={drawerVisible}
        transparent
        animationType="fade"
        accessibilityLabel={t("task.task_navigation")}
        onRequestClose={dismissDrawer}
      >
        <View style={styles.overlay}>
          <AnimatedPressable
            accessibilityLabel={t("task.close_navigation")}
            onPress={dismissDrawer}
            style={[styles.scrim, { opacity: scrimOpacity }]}
          />
          <Animated.View
            ref={drawerRef}
            testID="mobile-drawer"
            onLayout={(event) => {
              const width = event.nativeEvent.layout.width;
              drawerWidthRef.current = width;
              setDrawerWidth(width);
            }}
            style={[styles.drawer, { transform: [{ translateX }] }]}
            {...panResponder.panHandlers}
          >
            <View
              style={[
                styles.topActions,
                { paddingTop: insets.top + spacing.sm },
              ]}
            >
              <DrawerAction
                styles={styles}
                icon={<Plus size={18} color={colors.textMuted} />}
                label={t("task.new_task")}
                onPress={() =>
                  navigate({ pathname: "/new", params: { profileId } })
                }
              />
              <DrawerAction
                styles={styles}
                icon={<Clock3 size={18} color={colors.textMuted} />}
                label={t("task.history")}
                onPress={() =>
                  navigate({ pathname: "/sessions", params: { profileId } })
                }
              />
              <DrawerAction
                styles={styles}
                icon={<Clock3 size={18} color={colors.textDim} />}
                label={t("task.schedules_coming_soon")}
                disabled
                onPress={() => {}}
              />
              <Pressable
                accessibilityLabel={t("task.close_navigation")}
                onPress={dismissDrawer}
                style={[styles.close, { top: insets.top + spacing.xs }]}
              >
                <X size={20} color={colors.textMuted} />
              </Pressable>
            </View>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionLabel}>{t("task.workspace")}</Text>
            </View>
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
            >
              {servers.map((server) => {
                const serverThreads = threads[server.id] ?? [];
                const workspaceGroups = groupThreadsByWorkspace(
                  serverThreads,
                  workspaceOptions[server.id] ?? [],
                  server.workspacePath,
                );
                return (
                  <View key={server.id} style={styles.serverGroup}>
                    <View style={styles.serverRow}>
                      <View style={styles.serverBadge}>
                        <Text style={styles.serverBadgeText}>
                          {server.label.slice(0, 1).toUpperCase()}
                        </Text>
                      </View>
                      <Text style={styles.serverLabel}>{server.label}</Text>
                      <Pressable
                        accessibilityLabel={t("task.new_task_on", {
                          p0: server.label,
                        })}
                        hitSlop={6}
                        onPress={() =>
                          navigate({
                            pathname: "/new",
                            params: { profileId, serverId: server.id },
                          })
                        }
                        style={styles.serverAdd}
                      >
                        <Plus size={17} color={colors.textMuted} />
                      </Pressable>
                    </View>
                    {threadErrors[server.id] ? (
                      <Text
                        accessibilityRole="alert"
                        style={styles.workspaceError}
                      >
                        {threadErrors[server.id]}
                      </Text>
                    ) : null}
                    {workspaceErrors[server.id] ? (
                      <Text
                        accessibilityRole="alert"
                        style={styles.workspaceError}
                      >
                        {t(
                          "task.project_loading_failed_tasks_are_grouped_by_directory",
                        )}
                      </Text>
                    ) : null}
                    {onLoadServer ? <Pressable testID={`drawer-load-server-${server.id}`} disabled={closing || loading[server.id]} onPress={() => { if (!dismissal.closing) void onLoadServer(server.id, Boolean(hasMore[server.id])); }} style={styles.moreThreads}><Text style={styles.moreThreadsText}>{loading[server.id] ? t("mobile.drawer.loading_sessions") : hasMore[server.id] ? t("mobile.drawer.load_older_sessions") : t("mobile.drawer.load_recent_sessions")}</Text></Pressable> : null}
                    {onLoadProjects ? <Pressable testID={`drawer-load-projects-${server.id}`} disabled={closing} onPress={() => { if (!dismissal.closing) void onLoadProjects(server.id); }} style={styles.moreThreads}><Text style={styles.moreThreadsText}>{t("mobile.drawer.browse_projects")}</Text></Pressable> : null}
                    {workspaceGroups.map((group, groupIndex) => {
                      const sectionKey = `${server.id}\0${group.path}`;
                      const expanded = expandedServerIds.has(sectionKey);
                      const hiddenThreads = hiddenThreadCount(
                        group.threads,
                        expanded,
                      );
                      const collapsed = collapsedServerIds.has(sectionKey);
                      return (
                        <View key={sectionKey}>
                          <Pressable
                            testID={
                              groupIndex === 0
                                ? `drawer-toggle-server-${server.id}`
                                : `drawer-toggle-workspace-${server.id}-${groupIndex}`
                            }
                            accessibilityRole="button"
                            accessibilityLabel={t("task.sessions_in", {
                              p0: collapsed
                                ? t("task.expand")
                                : t("task.collapse"),
                              p1: group.label,
                            })}
                            aria-expanded={!collapsed}
                            accessibilityState={{
                              expanded: !collapsed,
                              disabled: !collapseHydrated,
                            }}
                            disabled={!collapseHydrated}
                            onPress={() => toggleServerCollapsed(sectionKey)}
                            style={styles.workspaceRow}
                          >
                            <Text
                              numberOfLines={1}
                              style={styles.workspaceLabel}
                            >
                              {group.label}
                            </Text>
                            <Text
                              numberOfLines={1}
                              style={styles.workspaceKind}
                            >
                              {group.kind === "worktree"
                                ? "WORKTREE"
                                : "PROJECT"}
                            </Text>
                            {collapsed ? (
                              <ChevronRight size={15} color={colors.textDim} />
                            ) : (
                              <ChevronDown size={15} color={colors.textDim} />
                            )}
                          </Pressable>
                          {!collapsed &&
                            projectVisibleThreads(group.threads, expanded).map(
                              (thread) => {
                                const tone = threadStatusTone(thread.status);
                                return (
                                  <Pressable
                                    testID={`drawer-thread-${thread.id}`}
                                    key={thread.id}
                                    accessibilityState={{
                                      selected:
                                        routeParams.serverId === server.id &&
                                        routeParams.threadId === thread.id,
                                    }}
                                    onPress={() =>
                                      replaceTask({
                                        pathname:
                                          "/h/[profileId]/task/[serverId]/[threadId]",
                                        params: {
                                          profileId,
                                          serverId: server.id,
                                          threadId: thread.id,
                                          cwd: thread.cwd?.trim() || group.path,
                                          title:
                                            thread.title ||
                                            t("task.untitled_task"),
                                        },
                                      })
                                    }
                                    style={[
                                      styles.threadRow,
                                      routeParams.serverId === server.id &&
                                        routeParams.threadId === thread.id &&
                                        styles.threadSelected,
                                    ]}
                                  >
                                    <View
                                      style={[
                                        styles.threadState,
                                        tone === "running"
                                          ? styles.threadRunning
                                          : tone === "waiting"
                                            ? styles.threadWaiting
                                            : tone === "failed"
                                              ? styles.threadFailed
                                              : styles.threadIdle,
                                      ]}
                                    />
                                    <Text
                                      numberOfLines={1}
                                      style={[
                                        styles.threadText,
                                        routeParams.serverId === server.id &&
                                          routeParams.threadId === thread.id &&
                                          styles.threadSelectedText,
                                      ]}
                                    >
                                      {thread.title || t("task.untitled_task")}
                                    </Text>
                                    {threadActivityLabel(thread) ? (
                                      <Text
                                        testID={`drawer-thread-state-${thread.id}`}
                                        style={{
                                          color: colors.textMuted,
                                          fontSize: 11,
                                        }}
                                      >
                                        {threadActivityLabel(thread)}
                                      </Text>
                                    ) : null}
                                    <Pressable
                                      testID={`drawer-thread-actions-${thread.id}`}
                                      accessibilityLabel={t(
                                        "task.task_actions_for",
                                        {
                                          p0:
                                            thread.title ||
                                            t("task.untitled_task"),
                                        },
                                      )}
                                      onPress={(event) => {
                                        event.stopPropagation();
                                        setActionTarget({ server, thread });
                                      }}
                                      style={styles.threadAction}
                                    >
                                      <MoreHorizontal
                                        size={18}
                                        color={colors.textMuted}
                                      />
                                    </Pressable>
                                  </Pressable>
                                );
                              },
                            )}
                          {!collapsed && group.threads.length > 8 ? (
                            <Pressable
                              testID={`drawer-toggle-more-${server.id}-${groupIndex}`}
                              accessibilityRole="button"
                              accessibilityLabel={
                                expanded
                                  ? t("task.collapse_sessions")
                                  : t("task.show_more_sessions", {
                                      p0: hiddenThreads,
                                    })
                              }
                              aria-expanded={expanded}
                              accessibilityState={{ expanded }}
                              onPress={() =>
                                toggleServerThreadsExpanded(sectionKey)
                              }
                              style={styles.moreThreads}
                            >
                              {expanded ? (
                                <ChevronUp size={14} color={colors.textDim} />
                              ) : (
                                <ChevronDown size={14} color={colors.textDim} />
                              )}
                              <Text style={styles.moreThreadsText}>
                                {expanded
                                  ? t("task.collapse")
                                  : t("task.show_more", { p0: hiddenThreads })}
                              </Text>
                            </Pressable>
                          ) : null}
                          {!collapsed && group.threads.length === 0 ? (
                            <Text style={styles.emptyThreads}>
                              {t("task.no_tasks")}
                            </Text>
                          ) : null}
                          {!collapsed ? (
                            <Pressable
                              onPress={() =>
                                navigate({
                                  pathname: "/new",
                                  params: {
                                    profileId,
                                    serverId: server.id,
                                    cwd: group.path,
                                  },
                                })
                              }
                              style={styles.newThread}
                            >
                              <Plus size={15} color={colors.textMuted} />
                              <Text style={styles.newThreadText}>
                                {t("task.new_task_in_this_project")}
                              </Text>
                            </Pressable>
                          ) : null}
                        </View>
                      );
                    })}
                  </View>
                );
              })}
            </ScrollView>
            <View
              style={[
                styles.bottom,
                { paddingBottom: Math.max(insets.bottom, spacing.md) },
              ]}
            >
              <DrawerAction
                styles={styles}
                icon={<FolderPlus size={18} color={colors.textMuted} />}
                label={t("task.add_project")}
                onPress={() =>
                  navigate({ pathname: "/open-project", params: { profileId } })
                }
              />
              <View style={styles.bottomNav}>
                <Pressable
                  accessibilityLabel={t("task.servers")}
                  onPress={() => navigate("/server-editor")}
                  style={styles.bottomButton}
                >
                  <Server size={19} color={colors.textMuted} />
                </Pressable>
                <Pressable
                  accessibilityLabel={t("task.home")}
                  onPress={() =>
                    replaceTask({
                      pathname: "/h/[profileId]",
                      params: { profileId },
                    })
                  }
                  style={styles.bottomButton}
                >
                  <Home size={19} color={colors.textMuted} />
                </Pressable>
                <Pressable
                  accessibilityLabel={t("task.help")}
                  onPress={() =>
                    Alert.alert(
                      "KCoder Studio",
                      t(
                        "task.mobile_securely_controls_local_or_ssh_kcoder_appservers",
                      ),
                    )
                  }
                  style={styles.bottomButton}
                >
                  <CircleHelp size={19} color={colors.textMuted} />
                </Pressable>
                <Pressable
                  accessibilityLabel={t("task.settings")}
                  onPress={() => navigate("/settings")}
                  style={styles.bottomButton}
                >
                  <Settings size={19} color={colors.textMuted} />
                </Pressable>
              </View>
            </View>
          </Animated.View>
        </View>
      </Modal>
      <ThreadActionsSheet
        visible={Boolean(actionTarget)}
        profile={profile}
        target={actionTarget}
        demo={demo}
        liveTask={liveTask}
        liveTaskServerId={liveTaskServerId}
        onClose={() => setActionTarget(null)}
        onRenamed={(thread) => {
          if (!actionTarget) return;
          onThreadRenamed(actionTarget.server.id, thread);
          setActionTarget({ ...actionTarget, thread });
        }}
        onRemoved={(kind, thread) => {
          if (!actionTarget) return;
          onThreadRemoved(actionTarget.server.id, thread.id, kind);
          setActionTarget(null);
        }}
      />
    </>
  );
}

function DrawerAction({
  styles,
  icon,
  label,
  onPress,
  disabled = false,
}: {
  styles: ReturnType<typeof makeStyles>;
  icon: React.ReactNode;
  label: string;
  onPress(): void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      disabled={disabled}
      accessibilityState={{ disabled }}
      onPress={onPress}
      style={[styles.action, disabled && styles.actionDisabled]}
    >
      {icon}
      <Text style={[styles.actionText, disabled && styles.actionDisabledText]}>
        {label}
      </Text>
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  overlay: { flex: 1 },
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.overlay,
  },
  drawer: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: "88%",
    maxWidth: 390,
    backgroundColor: colors.surface,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.border,
  },
  topActions: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  close: {
    position: "absolute",
    right: spacing.md,
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  action: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.xs,
  },
  actionText: { color: colors.textMuted, fontSize: 14 },
  actionDisabled: { opacity: 0.6 },
  actionDisabledText: { color: colors.textDim },
  sectionHeader: {
    height: 44,
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
  },
  sectionLabel: { color: colors.textMuted, fontSize: 12 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  serverGroup: { marginBottom: spacing.md },
  serverRow: {
    height: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  serverBadge: {
    width: 18,
    height: 18,
    borderRadius: 4,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  serverBadgeText: {
    color: colors.accentText,
    fontSize: 10,
    fontWeight: "800",
  },
  serverLabel: { flex: 1, color: colors.text, fontSize: 14, fontWeight: "600" },
  workspaceRow: {
    minHeight: 40,
    marginLeft: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderRadius: radius.sm,
  },
  workspaceLabel: {
    flex: 1,
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: "600",
  },
  workspaceKind: { color: colors.textDim, fontSize: 9, fontWeight: "700" },
  workspaceError: {
    color: colors.red,
    fontSize: 11,
    marginLeft: 24,
    marginBottom: spacing.xs,
  },
  serverAdd: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    marginRight: -12,
  },
  threadRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingLeft: 26,
    paddingRight: 0,
    borderRadius: radius.sm,
  },
  threadSelected: { backgroundColor: colors.surfaceHover },
  threadState: { width: 6, height: 6, borderRadius: 6 },
  threadIdle: { backgroundColor: colors.textDim },
  threadRunning: { backgroundColor: colors.green },
  threadWaiting: { backgroundColor: colors.yellow },
  threadFailed: { backgroundColor: colors.red },
  threadText: { flex: 1, color: colors.textMuted, fontSize: 13 },
  threadSelectedText: { color: colors.text, fontWeight: "600" },
  threadAction: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyThreads: {
    color: colors.textDim,
    fontSize: 11,
    paddingLeft: 26,
    paddingVertical: spacing.sm,
  },
  newThread: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingLeft: 24,
  },
  newThreadText: { color: colors.textMuted, fontSize: 13 },
  moreThreads: {
    minHeight: 36,
    marginLeft: 18,
    paddingHorizontal: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderRadius: radius.sm,
  },
  moreThreadsText: { color: colors.textMuted, fontSize: 12 },
  bottom: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    padding: spacing.md,
  },
  bottomNav: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: spacing.sm,
  },
  bottomButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
