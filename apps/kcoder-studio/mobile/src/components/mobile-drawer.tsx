import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
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
  Folder,
  MoreHorizontal,
  Settings,
  Plus,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type {
  GatewayProfile,
  KCoderServer,
  ServerStatus,
  ThreadSummary,
} from "@/gateway/types";
import { StatusDot } from "@/components/ui";
import { connectionStatusLabel } from "./connection-status-presentation";
import { WorkspaceFolderBadge } from "./workspace-folder-badge";
import { statusDotColor } from "./status-dot-presentation";
import { radius, spacing, useTheme, useThemedStyles, type ThemeColors } from "@/theme";
import { useModalFocusTrap } from "./use-modal-focus-trap";
import { groupThreadsByProject, hiddenThreadCount, projectVisibleThreads, threadActivityPresentation, workspaceSectionCollapseKey, workspaceTargetPresentations, type ProjectWorkspaceThreadGroup } from "./thread-list-presentation";
import { ThreadActionsSheet, type ThreadActionTarget } from "./thread-actions-sheet";
import { clampDrawerTranslation, shouldActivateDrawerDismiss, shouldDismissDrawer } from "./mobile-drawer-gesture";
import { DrawerDismissal } from "./mobile-drawer-dismissal";
import type { TaskRuntime, WorkspaceOption } from "@/runtime/task-runtime";
import { useCollapsedServerSections } from "@/storage/use-collapsed-server-sections";
import { WorkspaceHistoryActionsSheet } from "./workspace-history-actions-sheet";
import { HistoryRefreshModal, type HistoryRefreshTarget } from "./history-refresh-modal";

interface WorkspaceActionTarget {
  profile: GatewayProfile;
  server: KCoderServer;
  workspace: string;
  workspaceIdentity: string;
  owner: string;
  workspaceLabel: string;
  workspaceAccessibleName: string;
  targetLabel: string;
  workspaceIndex: number;
}
type DrawerHistoryRefreshTarget = Extract<HistoryRefreshTarget, { kind: "workspace" }> & { workspaceIdentity: string };

function drawerServerIdentity(server: KCoderServer): string {
  return JSON.stringify([
    server.id, server.label, server.labelKey, server.transport,
    server.workspacePath, server.host, server.user, server.port,
    server.observationTargetIdentity,
  ]);
}

function drawerProfileIdentity(profile: GatewayProfile): string {
  return JSON.stringify([
    profile.id, profile.baseUrl, profile.authMode, profile.authorizationGeneration, profile.deviceId,
  ]);
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
type ConnectionStatus = ServerStatus["status"] | "unknown";

export function MobileDrawer({
  visible,
  onClose,
  onDismissStart,
  profileId,
  profile,
  servers,
  serverStatuses = {},
  threads = {},
  workspaceOptions = {},
  workspaceErrors = {},
  threadErrors = {},
  workspaceHistoryOwner,
  canRefreshWorkspaceHistory,
  onWorkspaceHistoryReady,
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
  gatewayStatus?: ConnectionStatus;
  servers: KCoderServer[];
  serverStatuses?: Record<string, ConnectionStatus>;
  threads?: Record<string, ThreadSummary[]>;
  workspaceOptions?: Record<string, WorkspaceOption[]>;
  workspaceErrors?: Record<string, string>;
  threadErrors?: Record<string, string>;
  loading?: Record<string, boolean>;
  hasMore?: Record<string, boolean>;
  onLoadServer?(serverId: string, more?: boolean): Promise<void>;
  onLoadProjects?(serverId: string): Promise<void>;
  /** Parent-owned navigation/read owner; changes invalidate pending workspace actions. */
  workspaceHistoryOwner?: string;
  /** Verifies the current profile, screen, target and read-owner before history work. */
  canRefreshWorkspaceHistory?(server: KCoderServer): boolean;
  /** Optional read-only UI refresh after the exact workspace index operation completes. */
  onWorkspaceHistoryReady?(serverId: string): void;
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
  const [actionTarget, setActionTarget] = useState<(ThreadActionTarget & { owner: object; interaction: object }) | null>(null);
  const [workspaceActionTarget, setWorkspaceActionTarget] = useState<WorkspaceActionTarget | null>(null);
  const [historyRefreshTarget, setHistoryRefreshTarget] = useState<DrawerHistoryRefreshTarget | null>(null);
  const dismissal = useRef(new DrawerDismissal(visible)).current;
  const [closing, setClosing] = useState(false);
  const { serverIds: collapsedServerIds, hydrated: collapseHydrated, toggle: toggleServerCollapsed } = useCollapsedServerSections(profileId);
  const historyOwnerRef = useRef(workspaceHistoryOwner);
  historyOwnerRef.current = workspaceHistoryOwner;
  const historyGateRef = useRef(canRefreshWorkspaceHistory);
  historyGateRef.current = canRefreshWorkspaceHistory;
  const historyReadyRef = useRef(onWorkspaceHistoryReady);
  historyReadyRef.current = onWorkspaceHistoryReady;
  const workspaceSourceRef = useRef({ profile, profileId, servers, threads, workspaceOptions, visible, owner: workspaceHistoryOwner });
  workspaceSourceRef.current = { profile, profileId, servers, threads, workspaceOptions, visible, owner: workspaceHistoryOwner };
  const taskActionOwner = useMemo(() => ({}), [visible, profileId, drawerProfileIdentity(profile),
    JSON.stringify(servers.map(drawerServerIdentity)), workspaceHistoryOwner]);
  const taskActionOwnerRef = useRef(taskActionOwner);
  taskActionOwnerRef.current = taskActionOwner;
  const visibleActionTarget = visible && !dismissal.closing && actionTarget?.owner === taskActionOwner ? actionTarget : null;
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
  const isWorkspaceActionCurrent = useCallback((target: WorkspaceActionTarget | DrawerHistoryRefreshTarget) => {
    const source = workspaceSourceRef.current;
    if (!source.visible || dismissal.closing || source.profile.id !== source.profileId ||
      drawerProfileIdentity(target.profile) !== drawerProfileIdentity(source.profile) ||
      !source.owner || source.owner !== target.owner || historyOwnerRef.current !== target.owner) return false;
    const currentServer = source.servers.find((candidate) => candidate.id === target.server.id);
    if (!currentServer || drawerServerIdentity(currentServer) !== drawerServerIdentity(target.server)) return false;
    if (!historyGateRef.current?.(currentServer)) return false;
    const currentGroups = groupThreadsByProject(
      source.profile,
      currentServer,
      source.threads[currentServer.id] ?? [],
      source.workspaceOptions[currentServer.id] ?? [],
    ).flatMap((project) => project.workspaces);
    return currentGroups.some((group) => group.path === target.workspace &&
      group.identity === target.workspaceIdentity);
  }, [dismissal]);
  const visibleWorkspaceActionTarget = workspaceActionTarget && isWorkspaceActionCurrent(workspaceActionTarget)
    ? workspaceActionTarget
    : null;
  const visibleHistoryRefreshTarget = historyRefreshTarget && isWorkspaceActionCurrent(historyRefreshTarget)
    ? historyRefreshTarget
    : null;
  const targetPresentations = workspaceTargetPresentations(servers);
  const visibleWorkspaceActionServer = visibleWorkspaceActionTarget
    ? servers.find((candidate) => candidate.id === visibleWorkspaceActionTarget.server.id)
    : undefined;
  const visibleWorkspaceActionGroup: ProjectWorkspaceThreadGroup | undefined = visibleWorkspaceActionServer && visibleWorkspaceActionTarget
    ? groupThreadsByProject(visibleWorkspaceActionTarget.profile, visibleWorkspaceActionServer,
      threads[visibleWorkspaceActionServer.id] ?? [], workspaceOptions[visibleWorkspaceActionServer.id] ?? [])
      .flatMap((project) => project.workspaces)
      .find((group) => group.identity === visibleWorkspaceActionTarget.workspaceIdentity)
    : undefined;
  const drawerVisible = visible && !visibleActionTarget && !visibleWorkspaceActionTarget && !visibleHistoryRefreshTarget;

  useEffect(() => {
    if (!visible) {
      setActionTarget(null);
      setWorkspaceActionTarget(null);
      setHistoryRefreshTarget(null);
    } else {
      if (workspaceActionTarget && !isWorkspaceActionCurrent(workspaceActionTarget)) setWorkspaceActionTarget(null);
      if (historyRefreshTarget && !isWorkspaceActionCurrent(historyRefreshTarget)) setHistoryRefreshTarget(null);
    }
  }, [
    visible,
    workspaceActionTarget,
    historyRefreshTarget,
    isWorkspaceActionCurrent,
    workspaceHistoryOwner,
    canRefreshWorkspaceHistory,
    profile,
    profileId,
    servers,
    threads,
    workspaceOptions,
  ]);
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
            style={[styles.drawer, { paddingTop: insets.top, transform: [{ translateX }] }]}
            {...panResponder.panHandlers}
          >
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionLabel}>{t("new.projects")}</Text>
              <Pressable testID="drawer-settings" accessibilityRole="button" accessibilityLabel={t("common.settings")}
                onPress={() => navigate("/settings")} style={styles.settingsButton}>
                <Settings size={19} color={colors.textMuted} />
              </Pressable>
            </View>
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={[styles.scrollContent, { paddingBottom: Math.max(insets.bottom, spacing.xl) }]}
            >
              {servers.map((server) => {
                const serverThreads = threads[server.id] ?? [];
                const projects = groupThreadsByProject(
                  profile,
                  server,
                  serverThreads,
                  workspaceOptions[server.id] ?? [],
                );
                const target = targetPresentations.get(server.id)!;
                const status = serverStatuses[server.id] ?? "unknown";
                const workspaceActionEnabled = visible && !closing && profile.id === profileId &&
                  Boolean(workspaceHistoryOwner && canRefreshWorkspaceHistory?.(server));
                let workspaceIndex = 0;
                const renderedProjects = projects.map((project) => ({
                  project,
                  rows: project.workspaces.map((group) => ({ group, groupIndex: workspaceIndex++ })),
                }));
                return (
                  <View key={server.id} style={styles.serverGroup}>
                    {!renderedProjects.length ? (
                      <View style={styles.targetStatusFallback} testID={`drawer-target-status-${server.id}`}>
                        <StatusDot status={status} decorative />
                        <Text numberOfLines={1} style={styles.workspaceTarget}>{target.display} · {connectionStatusLabel(status)}</Text>
                      </View>
                    ) : null}
                    {renderedProjects.map(({ project, rows }, projectIndex) => (
                      <View key={project.key} style={styles.listGroup}>
                        {rows.length > 1 ? (
                          <View testID={`drawer-project-${server.id}-${projectIndex}`} style={styles.projectTitleRow}>
                            <Folder size={15} color={colors.textDim} />
                            <Text accessibilityRole="header" numberOfLines={1} style={styles.projectTitle}>{project.name}</Text>
                          </View>
                        ) : null}
                        {rows.map(({ group, groupIndex }) => {
                          const displayName = rows.length === 1 ? project.name : group.label;
                          const sectionKey = workspaceSectionCollapseKey(server.id, group.path);
                          const collapsed = collapsedServerIds.has(sectionKey);
                          const expanded = expandedServerIds.has(sectionKey);
                          const hiddenThreads = hiddenThreadCount(group.threads, expanded);
                          const accessibleName = `${displayName} · ${group.path ?? t("home.choose_directory_for_new")} · ${target.accessible} · ${connectionStatusLabel(status)}`;
                          const canCreate = Boolean(group.path && workspaceActionEnabled);
                          const menuExpanded = Boolean(visibleWorkspaceActionTarget?.server.id === server.id &&
                            visibleWorkspaceActionTarget.workspaceIdentity === group.identity);
                          return (
                            <View key={group.identity} testID={`drawer-workspace-row-${server.id}-${groupIndex}`} style={styles.listGroup}>
                              <View style={styles.workspaceRow}>
                                <Pressable
                                  testID={groupIndex === 0 ? `drawer-toggle-server-${server.id}` : `drawer-toggle-workspace-${server.id}-${groupIndex}`}
                                  accessibilityRole="button"
                                  accessibilityLabel={`${t(collapsed ? "task.expand" : "task.collapse")} ${accessibleName}`}
                                  aria-expanded={!collapsed}
                                  accessibilityState={{ expanded: !collapsed, disabled: !collapseHydrated }}
                                  disabled={!collapseHydrated}
                                  onPress={() => toggleServerCollapsed(sectionKey)}
                                  style={styles.workspaceToggle}
                                >
                                  <WorkspaceFolderBadge profile={profile} server={server} testID={`drawer-target-badge-${server.id}-${groupIndex}`} />
                                  <View style={styles.workspaceTitle}>
                                    <Text testID={`drawer-workspace-name-${server.id}-${groupIndex}`} numberOfLines={1} ellipsizeMode="tail" style={styles.workspaceLabel}>{displayName}</Text>
                                    <View testID={`drawer-workspace-chevron-${server.id}-${groupIndex}`}  accessible={false} style={[styles.rowChevron, { pointerEvents: "none" }]}>
                                      {collapsed ? <ChevronRight size={13} color={statusDotColor(status, colors)} /> : <ChevronDown size={13} color={statusDotColor(status, colors)} />}
                                    </View>
                                  </View>
                                </Pressable>
                                <View style={styles.workspaceRowActions}>
                                  <Pressable
                                    testID={`drawer-workspace-actions-${server.id}-${groupIndex}`}
                                    accessibilityRole="button"
                                    accessibilityLabel={t("home.workspace_actions_for", { p0: accessibleName })}
                                    disabled={!canCreate || demo}
                                    accessibilityState={{ expanded: menuExpanded, disabled: !canCreate || demo }}
                                    aria-expanded={menuExpanded}
                                    onPress={() => {
                                      if (!canCreate || !group.path || demo || !workspaceHistoryOwner || !isWorkspaceActionCurrent({
                                        profile, server, workspace: group.path, workspaceIdentity: group.identity,
                                        owner: workspaceHistoryOwner, workspaceLabel: displayName,
                                        workspaceAccessibleName: accessibleName, targetLabel: target.display,
                                        workspaceIndex: groupIndex,
                                      })) return;
                                      setWorkspaceActionTarget({
                                        profile, server, workspace: group.path, workspaceIdentity: group.identity,
                                        owner: workspaceHistoryOwner, workspaceLabel: displayName,
                                        workspaceAccessibleName: accessibleName, targetLabel: target.display,
                                        workspaceIndex: groupIndex,
                                      });
                                    }}
                                    style={[styles.sectionAction, (!canCreate || demo) && styles.sectionActionDisabled]}
                                  ><MoreHorizontal size={19} color={colors.textMuted} /></Pressable>
                                  <Pressable
                                    testID={`drawer-new-workspace-${server.id}-${groupIndex}`}
                                    accessibilityRole="button"
                                    accessibilityLabel={`${t("home.create_workspace_for", { p0: displayName, p1: group.path ?? t("home.choose_directory_for_new"), p2: server.id })} · ${connectionStatusLabel(status)}`}
                                    disabled={!canCreate}
                                    accessibilityState={{ disabled: !canCreate }}
                                    onPress={() => {
                                      if (!group.path || !canCreate || !workspaceHistoryOwner) return;
                                      const actionTarget: WorkspaceActionTarget = {
                                        profile, server, workspace: group.path, workspaceIdentity: group.identity,
                                        owner: workspaceHistoryOwner, workspaceLabel: displayName,
                                        workspaceAccessibleName: accessibleName, targetLabel: target.display,
                                        workspaceIndex: groupIndex,
                                      };
                                      if (!isWorkspaceActionCurrent(actionTarget)) return;
                                      const currentServer = servers.find((candidate) => candidate.id === server.id && drawerServerIdentity(candidate) === drawerServerIdentity(server));
                                      if (!currentServer || profile.id !== profileId) return;
                                      navigate({ pathname: "/new", params: { profileId, serverId: currentServer.id, cwd: group.path } });
                                    }}
                                    style={[styles.sectionAction, !canCreate && styles.sectionActionDisabled]}
                                  ><Plus size={17} color={colors.textMuted} /></Pressable>
                                </View>
                              </View>
                              {!collapsed && projectVisibleThreads(group.threads, expanded).map((thread) => {
                                const activity = threadActivityPresentation(thread);
                                const tone = activity.tone;
                                const openTaskActions = () => {
                                  if (taskActionOwnerRef.current !== taskActionOwner || !visible || dismissal.closing || profile.id !== profileId) return;
                                  const cwd = thread.cwd?.trim() || group.path;
                                  setActionTarget({ owner: taskActionOwner, interaction: {}, server: { ...server, workspacePath: cwd }, thread: { ...thread, cwd } });
                                };
                                return (
                                  <Pressable
                                    testID={`drawer-thread-${thread.id}`}
                                    key={thread.id}
                                    accessibilityRole="button"
                                    accessibilityLabel={thread.title || t("task.untitled_task")}
                                    accessibilityActions={[{ name: "longpress", label: t("task.task_actions") }]}
                                    accessibilityState={{ selected: routeParams.serverId === server.id && routeParams.threadId === thread.id }}
                                    delayLongPress={500}
                                    onLongPress={openTaskActions}
                                    onAccessibilityAction={(event) => {
                                      if (event.nativeEvent.actionName === "longpress") openTaskActions();
                                    }}
                                    onPress={() => replaceTask({
                                      pathname: "/h/[profileId]/task/[serverId]/[threadId]",
                                      params: {
                                        profileId, serverId: server.id, threadId: thread.id,
                                        ...(thread.cwd?.trim() || group.path ? { cwd: thread.cwd?.trim() || group.path } : {}),
                                        title: thread.title || t("task.untitled_task"),
                                      },
                                    })}
                                    style={[styles.threadRow, routeParams.serverId === server.id && routeParams.threadId === thread.id && styles.threadSelected]}
                                  >
                                    <View style={styles.threadCopy}>
                                      <View style={styles.threadPrimaryRow}>
                                        <Text numberOfLines={1} ellipsizeMode="tail" style={[styles.threadText, routeParams.serverId === server.id && routeParams.threadId === thread.id && styles.threadSelectedText]}>{thread.title || t("task.untitled_task")}</Text>
                                        {activity.label ? <Text testID={`drawer-thread-state-${thread.id}`} style={{ color: tone === "running" ? colors.green : tone === "waiting" ? colors.yellow : tone === "failed" ? colors.red : tone === "unknown" ? colors.blue : colors.textMuted, fontSize: 11 }}>{activity.label}</Text> : null}
                                      </View>
                                      {activity.recentErrorLabel ? <Text testID={`drawer-thread-recent-error-${thread.id}`} style={styles.threadRecentError}>{activity.recentErrorLabel}</Text> : null}
                                    </View>
                                  </Pressable>
                                );
                              })}
                              {!collapsed && group.threads.length > 8 ? (
                                <Pressable testID={`drawer-toggle-more-${server.id}-${groupIndex}`} accessibilityRole="button" accessibilityLabel={expanded ? t("task.collapse_sessions") : t("task.show_more_sessions", { p0: hiddenThreads })} aria-expanded={expanded} accessibilityState={{ expanded }} onPress={() => toggleServerThreadsExpanded(sectionKey)} style={styles.moreThreads}>
                                  {expanded ? <ChevronUp size={14} color={colors.textDim} /> : <ChevronDown size={14} color={colors.textDim} />}
                                  <Text style={styles.moreThreadsText}>{expanded ? t("task.collapse") : t("task.show_more", { p0: hiddenThreads })}</Text>
                                </Pressable>
                              ) : null}
                            </View>
                          );
                        })}
                      </View>
                    ))}
                  </View>
                );
              })}
            </ScrollView>
          </Animated.View>
        </View>
      </Modal>
      {visibleWorkspaceActionTarget && visibleWorkspaceActionServer && visibleWorkspaceActionGroup?.path ? (
        <WorkspaceHistoryActionsSheet
          server={visibleWorkspaceActionServer}
          workspace={visibleWorkspaceActionGroup}
          workspaceLabel={visibleWorkspaceActionTarget.workspaceLabel}
          workspaceAccessibleName={visibleWorkspaceActionTarget.workspaceAccessibleName}
          targetLabel={visibleWorkspaceActionTarget.targetLabel}
          workspaceIndex={visibleWorkspaceActionTarget.workspaceIndex}
          onClose={() => setWorkspaceActionTarget(null)}
          onSelect={(workspace) => {
            if (!isWorkspaceActionCurrent(visibleWorkspaceActionTarget) ||
              workspace !== visibleWorkspaceActionTarget.workspace ||
              visibleWorkspaceActionGroup.path !== workspace ||
              visibleWorkspaceActionGroup.identity !== visibleWorkspaceActionTarget.workspaceIdentity) return;
            setWorkspaceActionTarget(null);
            setHistoryRefreshTarget({
              kind: "workspace",
              profile: visibleWorkspaceActionTarget.profile,
              server: visibleWorkspaceActionServer,
              workspace,
              workspaceIdentity: visibleWorkspaceActionTarget.workspaceIdentity,
              owner: visibleWorkspaceActionTarget.owner,
            });
          }}
        />
      ) : null}
      {visibleHistoryRefreshTarget ? (
        <HistoryRefreshModal
          target={visibleHistoryRefreshTarget}
          isTargetCurrent={() => Boolean(visibleHistoryRefreshTarget && isWorkspaceActionCurrent(visibleHistoryRefreshTarget))}
          onClose={() => setHistoryRefreshTarget((current) => current === visibleHistoryRefreshTarget ? null : current)}
          onReady={() => {
            if (visibleHistoryRefreshTarget && isWorkspaceActionCurrent(visibleHistoryRefreshTarget))
              historyReadyRef.current?.(visibleHistoryRefreshTarget.server.id);
          }}
        />
      ) : null}
      <ThreadActionsSheet
        visible={Boolean(visibleActionTarget)}
        profile={profile}
        target={visibleActionTarget}
        demo={demo}
        liveTask={liveTask}
        liveTaskServerId={liveTaskServerId}
        onClose={() => setActionTarget((current) => current?.interaction === visibleActionTarget?.interaction ? null : current)}
        onRenamed={(thread) => {
          if (!visibleActionTarget || taskActionOwnerRef.current !== visibleActionTarget.owner) return;
          onThreadRenamed(visibleActionTarget.server.id, thread);
          setActionTarget((current) => current?.interaction === visibleActionTarget.interaction ? { ...current, thread } : current);
        }}
        onRemoved={(kind, thread) => {
          if (!visibleActionTarget || taskActionOwnerRef.current !== visibleActionTarget.owner) return;
          onThreadRemoved(visibleActionTarget.server.id, thread.id, kind);
          setActionTarget((current) => current?.interaction === visibleActionTarget.interaction ? null : current);
        }}
      />
    </>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  overlay: { flex: 1 },
  scrim: {
    ...StyleSheet.absoluteFill,
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
  sectionHeader: {
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
  },
  settingsButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.md },
  sectionLabel: { color: colors.textMuted, fontSize: 12 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: spacing.lg, gap: spacing.sm },
  serverGroup: { gap: spacing.sm },
  listGroup: { gap: spacing.sm },
  targetStatusFallback: { minHeight: 30, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.xs },
  projectTitleRow: { minHeight: 34, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.xs },
  projectTitle: { flex: 1, color: colors.textMuted, fontSize: 12, fontWeight: "600" },
  workspaceRow: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderRadius: radius.sm,
  },
  workspaceToggle: { minHeight: 48, flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.xs },
  workspaceLabel: {
    flexShrink: 1,
    minWidth: 0,
    color: colors.text,
    fontSize: 13,
    fontWeight: "600",
  },
  workspaceTitle: { flexShrink: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: spacing.xs },
  rowChevron: { flexShrink: 0 },
  workspaceTarget: { flex: 1, minWidth: 0, color: colors.textDim, fontSize: 10 },
  workspaceRowActions: { flexDirection: "row", alignItems: "center" },
  sectionAction: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.md },
  sectionActionDisabled: { opacity: 0.45 },
  workspaceError: {
    color: colors.red,
    fontSize: 11,
    marginLeft: spacing.xs,
    marginBottom: spacing.xs,
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
  threadCopy: { flex: 1, minWidth: 0, gap: 2 },
  threadPrimaryRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  threadText: { flex: 1, minWidth: 0, color: colors.textMuted, fontSize: 13 },
  threadRecentError: { color: colors.textDim, fontSize: 10 },
  threadSelectedText: { color: colors.text, fontWeight: "600" },
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
});
