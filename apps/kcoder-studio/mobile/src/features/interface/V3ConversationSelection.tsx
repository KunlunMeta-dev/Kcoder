import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { ChevronDown, ChevronRight, FileText, Hourglass, MessageSquareText, Pin, Plus, Search, Settings } from "lucide-react-native";
import type { KCoderServer, ThreadSummary } from "@/gateway/types";
import { type ProjectThreadGroup, type ProjectWorkspaceThreadGroup, projectVisibleThreads, hiddenThreadCount, threadActivityPresentation } from "@/components/thread-list-presentation";
import { connectionStatusLabel, type ConnectionStatus } from "@/components/connection-status-presentation";
import { rowActions } from "@/components/row-actions";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { useTheme, useThemedStyles } from "@/theme";
import { v3HistoryTime } from "./v3-history-presentation";
import { timestampMs } from "@/protocol/normalizers";
import { partitionPinnedProjects } from "../../../../shared/projectPinning";
import { v3ConversationSelectionStyles } from "./v3-conversation-selection-styles";

export interface V3ConversationTarget {
  server: KCoderServer;
  projects: ProjectThreadGroup[];
  enabled: boolean;
  status: ConnectionStatus;
  hasMore: boolean;
}

function ProjectPinControl({ name, pinned, enabled, buttonId, onToggle }: {
  name: string; pinned: boolean; enabled: boolean; buttonId: string; onToggle(): Promise<void>;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(v3ConversationSelectionStyles);
  const busy = useRef(false);
  const mounted = useRef(true);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return <View style={[styles.pinControl, { pointerEvents: "box-none" }]}>
    {/* The wrapper catches disabled-button edge clicks instead of the row underneath. */}
    <View style={[styles.pinHitTarget, { pointerEvents: "auto" }]}>
    <Pressable testID={buttonId} accessibilityRole="button" accessibilityLabel={t(pinned ? "home.unpin_project_for" : "home.pin_project_for", { p0: name })} aria-pressed={pinned}
      accessibilityState={{ disabled: pending || !enabled, busy: pending, selected: pinned }} disabled={pending || !enabled}
      hitSlop={6} style={[styles.pinButton, (pending || !enabled) && styles.disabled]}
      onPress={async () => {
        if (busy.current || !enabled) return;
        busy.current = true; setPending(true); setFailed(false);
        try { await onToggle(); }
        catch { if (mounted.current) setFailed(true); }
        finally { busy.current = false; if (mounted.current) setPending(false); }
      }}>
      {pending ? <ActivityIndicator size="small" color={colors.textDim} /> : <Pin size={12} color={colors.textDim} fill={pinned ? colors.textDim : "none"} />}
    </Pressable>
    </View>
    {failed ? <Text accessibilityRole="alert" style={styles.pinError}>{t("home.project_pin_failed")}</Text> : null}
  </View>;
}

export function V3ConversationSelectionHeader({ pendingCount, onSearch, onInbox, onSettings }: {
  pendingCount: number; onSearch(): void; onInbox(): void; onSettings(): void;
}) {
  const styles = useThemedStyles(v3ConversationSelectionStyles);
  return <View testID="v3-conversation-selection-header" style={styles.header}>
    <View testID="sessions"><Pressable testID="home-search" accessibilityRole="button" accessibilityLabel={t("home.search_history")} onPress={onSearch} style={styles.iconButton}>
      <Search size={24} strokeWidth={1.5} color={styles.icon.color} />
    </Pressable></View>
    <View style={{ flex: 1 }} />
    <Pressable testID="interaction-inbox" accessibilityRole="button" accessibilityLabel={`${t("inbox.title")}${pendingCount ? ` · ${pendingCount}` : ""}`} onPress={onInbox} style={styles.iconButton}>
      <View accessible={false} style={styles.pendingIcon}><FileText size={23} strokeWidth={1.5} color={styles.icon.color} />
        <View style={styles.hourglass}><Hourglass size={12} strokeWidth={1.5} color={styles.icon.color} /></View>
      </View>
      {pendingCount > 0 ? <View style={styles.badge}><Text style={styles.badgeText}>{pendingCount}</Text></View> : null}
    </Pressable>
    <Pressable testID="home-settings" accessibilityRole="button" accessibilityLabel={t("common.settings")} onPress={onSettings} style={styles.iconButton}>
      <Settings size={24} strokeWidth={1.5} color={styles.icon.color} />
    </Pressable>
  </View>;
}

/** V3 presentation and local filtering; callers retain target and mutation authority. */
export function V3ConversationSelection({ targets, collapsed, collapseReady, onToggle, onNew, onAddProject, onThread, onThreadActions, onProjectActions, onProjectPinToggle, onViewAll }: {
  targets: V3ConversationTarget[]; collapsed: ReadonlySet<string>; collapseReady: boolean;
  onToggle(projectKey: string): void; onNew(server: KCoderServer, cwd?: string): void; onAddProject(): void;
  onThread(server: KCoderServer, workspace: ProjectWorkspaceThreadGroup, thread: ThreadSummary): void;
  onThreadActions(server: KCoderServer, workspace: ProjectWorkspaceThreadGroup, thread: ThreadSummary): void;
  onProjectActions(server: KCoderServer, workspace: ProjectWorkspaceThreadGroup, name: string): void;
  onProjectPinToggle?(server: KCoderServer, project: ProjectThreadGroup): Promise<void>;
  onViewAll(server: KCoderServer): void;
}) {
  const locale = useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(v3ConversationSelectionStyles);
  const [selection, setSelection] = useState<string | null>(null);
  const [foldersCollapsed, setFoldersCollapsed] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const folders = targets.flatMap(target => target.projects.map((project, projectIndex) => ({ target, project, projectIndex })))
    .map((item, position) => ({ ...item, position }));
  const { pinned, regular } = partitionPinnedProjects(folders, item => item.project);
  type Folder = (typeof folders)[number];
  const selected = regular.find(item => item.project.key === selection);
  const primaryWorkspace = (project: ProjectThreadGroup) => project.workspaces.find(workspace => workspace.kind === "workspace") ?? project.workspaces[0];
  const rootPinSupported = (project: ProjectThreadGroup) => !project.rootProject || project.pinSupported === true;
  const pin = ({ target, project, position }: Folder) => onProjectPinToggle ? <ProjectPinControl name={project.name} pinned={project.pinned === true}
    buttonId={`v3-project-pin-${target.server.id}-${position}`} enabled={target.enabled && target.status === "online" && project.pinSupported !== false && rootPinSupported(project)}
    onToggle={() => onProjectPinToggle(target.server, project)} /> : project.pinned ? <Pin size={12} color={colors.textDim} accessibilityLabel={t("home.pinned")} /> : null;
  const unavailable = ({ target, project, position }: Folder) => {
    if (!onProjectPinToggle) return null;
    const unavailableText = target.status !== "online"
      ? "home.project_pin_requires_connection"
      : project.pinSupported === false || !rootPinSupported(project) ? "home.project_pin_requires_upgrade" : undefined;
    return unavailableText ? <Text testID={`v3-project-pin-unavailable-${target.server.id}-${position}`} style={styles.caption}>{t(unavailableText)}</Text> : null;
  };
  const create = ({ target, project, projectIndex }: Folder) => {
    const workspace = primaryWorkspace(project), enabled = target.enabled && Boolean(workspace?.path);
    return <Pressable testID={`new-workspace-${target.server.id}-${projectIndex}`} accessibilityRole="button"
      accessibilityLabel={`${t("task.new_task")} · ${project.name} · ${target.server.label} · ${connectionStatusLabel(target.status)}`}
      disabled={!enabled} accessibilityState={{ disabled: !enabled }} onPress={() => onNew(target.server, workspace?.path)} style={[styles.iconButton, !enabled && styles.disabled]}>
      <Plus size={22} strokeWidth={1.5} color={styles.icon.color} />
    </Pressable>;
  };
  const conversations = ({ target, project, projectIndex }: Folder) => {
    const rows = project.workspaces.flatMap(workspace => workspace.threads.map(thread => ({ workspace, thread })))
      .sort((a, b) => (timestampMs(b.thread.updatedAt) || 0) - (timestampMs(a.thread.updatedAt) || 0));
    const visible = projectVisibleThreads(rows.map(row => row.thread), expanded.has(project.key));
    return <>
      {visible.map(thread => {
        const workspace = rows.find(row => row.thread === thread)!.workspace;
        const activity = threadActivityPresentation(thread);
        return <Pressable key={JSON.stringify([workspace.identity, thread.id])} testID={`thread-${thread.id}`} accessibilityRole="button"
          disabled={!target.enabled} accessibilityLabel={`${thread.title || t("task.untitled_task")} · ${project.name} · ${target.server.label} · ${connectionStatusLabel(target.status)}`}
          {...rowActions(t("task.task_actions"), () => onThreadActions(target.server, workspace, thread))}
          onPress={() => onThread(target.server, workspace, thread)} hitSlop={{ top: 2, bottom: 2 }} style={({ pressed }) => [styles.thread, pressed && styles.pressed]}>
          <View style={styles.threadCopy}><Text numberOfLines={1} ellipsizeMode="tail" style={styles.threadTitle}>{thread.title || t("task.untitled_task")}</Text>
          </View>
          {activity.label ? <Text style={[styles.activity, { color: activity.tone === "failed" ? colors.red : activity.tone === "running" ? colors.green : colors.textMuted }]}>{activity.label}</Text> : null}
          <Text style={styles.time}>{v3HistoryTime(thread.updatedAt, locale)}</Text>
        </Pressable>;
      })}
      {rows.length > 8 ? <Pressable testID={`v3-more-conversations-${target.server.id}-${projectIndex}`} accessibilityRole="button" onPress={() => setExpanded(previous => {
        const next = new Set(previous); if (next.has(project.key)) next.delete(project.key); else next.add(project.key); return next;
      })} style={styles.more}><Text style={styles.caption}>{t(expanded.has(project.key) ? "task.collapse" : "task.show_more", { p0: hiddenThreadCount(rows.map(row => row.thread), false) })}</Text></Pressable> : null}
      {target.hasMore ? <Pressable testID={`view-all-home-threads-${target.server.id}-${projectIndex}`} accessibilityRole="button" onPress={() => onViewAll(target.server)} style={styles.more}>
        <Text style={styles.caption}>{t("home.view_all_sessions")}</Text>
      </Pressable> : null}
    </>;
  };
  return <View testID="v3-conversation-selection" accessibilityLabel={t("v3.conversations")} style={styles.content}>
    {pinned.length > 0 ? <View testID="v3-pinned-conversations" style={styles.servers}>
      <Text accessibilityRole="header" testID="v3-pinned-projects-heading" style={styles.projectGroupTitle}>{t("home.pinned")}</Text>
      {pinned.map(item => {
        const { target, project, projectIndex } = item, folded = collapsed.has(project.key);
        return <View key={project.key} testID={`v3-pinned-conversation-${target.server.id}-${projectIndex}`}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionCopy}>
              <View style={styles.sectionName}>
                <Pressable testID={projectIndex === 0 ? `toggle-server-${target.server.id}` : `toggle-workspace-${target.server.id}-${projectIndex}`} accessibilityRole="button"
                  accessibilityLabel={`${t(folded ? "task.expand" : "task.collapse")} ${project.name} · ${target.server.label} · ${connectionStatusLabel(target.status)}`}
                  accessibilityState={{ expanded: !folded, disabled: !collapseReady }} aria-expanded={!folded} disabled={!collapseReady} onPress={() => onToggle(project.key)}
                  {...rowActions(t("task.task_actions"), () => { const workspace = primaryWorkspace(project); if (workspace) onProjectActions(target.server, workspace, project.name); })} style={styles.sectionLabel}>
                  <Text testID={`home-workspace-name-${target.server.id}-${projectIndex}`} numberOfLines={1} style={styles.sectionTitle}>{project.name}</Text>
                </Pressable>
                {pin(item)}
              </View>
              <Pressable testID={`v3-pinned-project-toggle-${target.server.id}-${projectIndex}`} accessibilityRole="button"
                accessibilityLabel={`${t(folded ? "task.expand" : "task.collapse")} ${project.name} · ${target.server.label}`}
                accessibilityState={{ expanded: !folded, disabled: !collapseReady }} aria-expanded={!folded} disabled={!collapseReady}
                onPress={() => onToggle(project.key)} style={styles.iconButton}>
                {folded ? <ChevronRight size={15} color={styles.icon.color} /> : <ChevronDown size={15} color={styles.icon.color} />}
              </Pressable>
            </View>
            {create(item)}
          </View>
          {unavailable(item)}
          {!folded ? conversations(item) : null}
        </View>;
      })}
    </View> : null}
    <View testID="v3-project-folders" style={styles.folders}>
      <View style={styles.sectionHeader}>
        <Pressable testID="v3-project-folders-toggle" accessibilityRole="button" accessibilityLabel={t("v3.project_folders")}
          accessibilityState={{ expanded: !foldersCollapsed }} aria-expanded={!foldersCollapsed} onPress={() => setFoldersCollapsed(value => !value)} style={styles.sectionToggle}>
          <Text style={[styles.sectionTitle, { flex: 1 }]}>{t("v3.project_folders")} <Text style={styles.count}>({regular.length})</Text></Text>
          {foldersCollapsed ? <ChevronRight size={15} color={styles.icon.color} /> : <ChevronDown size={15} color={styles.icon.color} />}
        </Pressable>
        <Pressable testID="v3-add-project" accessibilityRole="button" accessibilityLabel={t("task.add_project")} onPress={onAddProject} style={styles.iconButton}><Plus size={22} strokeWidth={1.5} color={styles.icon.color} /></Pressable>
      </View>
      {!foldersCollapsed ? <>
        <Pressable testID="v3-project-all" accessibilityRole="button" accessibilityState={{ selected: !selected }} onPress={() => setSelection(null)} style={({ pressed }) => [styles.all, pressed && styles.pressed]}>
          <Text style={styles.projectTitle}>{t("v3.select_all")}</Text>
        </Pressable>
        {regular.map(item => {
          const { target, project, position, projectIndex } = item, active = selected?.project.key === project.key;
          const toggle = () => setSelection(current => current === project.key ? null : project.key);
          const accessibleName = `${project.name} · ${target.server.label} · ${connectionStatusLabel(target.status)}`;
          const actions = () => { const workspace = primaryWorkspace(project); if (workspace) onProjectActions(target.server, workspace, project.name); };
          return <View key={project.key} testID={`v3-project-row-${target.server.id}-${position}`} style={styles.projectRow}>
            <View style={active && styles.selected}>
              <View style={styles.regularProject}>
                <View style={styles.regularCopy}>
                  <View style={styles.projectName}>
                    <Pressable testID={`v3-project-folder-${target.server.id}-${position}`} accessibilityRole="button" accessibilityLabel={accessibleName}
                      accessibilityState={{ selected: active, expanded: active }} aria-expanded={active} onPress={toggle}
                      {...rowActions(t("task.task_actions"), actions)} style={styles.projectLabel}>
                      <Text numberOfLines={1} style={[styles.projectTitle, active && { color: colors.blue }]}>{project.name}</Text>
                    </Pressable>
                    {pin(item)}
                  </View>
                  <View style={styles.projectDetail}><Text numberOfLines={1} style={styles.caption}>{t("v2.loaded_conversations", { count: project.workspaces.reduce((sum, workspace) => sum + workspace.threads.length, 0) })}</Text><MessageSquareText size={11} color={colors.blue} /><Text numberOfLines={1} style={[styles.caption, styles.serverCaption]}> · {target.server.label}</Text></View>
                  {unavailable(item)}
                </View>
                <Pressable testID={`v3-project-toggle-${target.server.id}-${projectIndex}`} accessibilityRole="button"
                  accessibilityLabel={`${t(active ? "task.collapse" : "task.expand")} ${accessibleName}`}
                  accessibilityState={{ expanded: active }} aria-expanded={active} onPress={toggle} style={styles.iconButton}>
                  {active ? <ChevronDown size={15} color={styles.icon.color} /> : <ChevronRight size={15} color={styles.icon.color} />}
                </Pressable>
                {create(item)}
              </View>
            </View>
            {active ? <View testID={`v3-regular-conversations-${target.server.id}-${projectIndex}`}>{conversations(item)}</View> : null}
          </View>;
        })}
      </> : null}
    </View>
    <View style={styles.filler} /><View style={styles.bottomLine} />
  </View>;
}
