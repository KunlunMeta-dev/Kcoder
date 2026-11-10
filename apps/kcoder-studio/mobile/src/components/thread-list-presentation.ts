import { t } from "@/i18n";
import {
  parseThreadRunSummary,
  threadRunActivity,
  type ThreadRunActivity,
} from "../../../shared/threadRunSummary";
import type { GatewayProfile, KCoderServer, ThreadSummary } from "@/gateway/types";
import type { WorkspaceOption } from "@/runtime/task-runtime";
import { workspaceEntryIdentity, workspaceProjectIdentity, workspaceThreadScopeIdentity } from "@/runtime/task-runtime/workspaces";

export const INITIAL_VISIBLE_THREADS = 8;

const WORKSPACE_TARGET_COLORS = ["#5B7CFA", "#3FA67A", "#C9892B", "#8F6DD8", "#C65D5D", "#339DA0", "#B35EA4", "#6F9B4B"] as const;

/** Target identity colors do not change with workspace selection or renewed credentials. */
export function workspaceTargetColor(profile: Pick<GatewayProfile, "baseUrl" | "connectionRoutes">, server: Pick<KCoderServer, "id">): string {
  const key = JSON.stringify([profile.connectionRoutes?.gatewayId || profile.baseUrl || "", server.id]);
  let hash = 0;
  for (let index = 0; index < key.length; index++) hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  return WORKSPACE_TARGET_COLORS[hash % WORKSPACE_TARGET_COLORS.length];
}

export interface WorkspaceTargetPresentation {
  display: string;
  accessible: string;
}

function workspaceTargetDescription(server: KCoderServer): string {
  if (server.transport !== "ssh")
    return t("home.workspace_target_local", { p0: server.label });
  const location = server.host
    ? `${server.user ? `${server.user}@` : ""}${server.host}:${server.port ?? 22}`
    : server.id;
  return t("home.workspace_target_ssh", { p0: server.label, p1: location });
}

/** Same target wording and duplicate disambiguation used by Home and Drawer. */
export function workspaceTargetPresentations(
  servers: readonly KCoderServer[],
): Map<string, WorkspaceTargetPresentation> {
  const descriptions = servers.map((server) => ({
    server,
    description: workspaceTargetDescription(server),
  }));
  const counts = new Map<string, number>();
  for (const { description } of descriptions)
    counts.set(description, (counts.get(description) ?? 0) + 1);
  return new Map(descriptions.map(({ server, description }) => [server.id, {
    display: (counts.get(description) ?? 0) > 1
      ? `${server.id} · ${description}`
      : description,
    accessible: `${description} (${server.id})`,
  }]));
}

/** Preserve the Home/Drawer fold-key format already stored by Mobile clients. */
export function workspaceSectionCollapseKey(
  serverId: string,
  path: string | undefined,
): string {
  const legacyPath = path?.trim() || "/";
  return `${serverId}\0${legacyPath === "/" ? "/" : legacyPath.replace(/\/+$/, "")}`;
}

export interface WorkspaceThreadGroup {
  key: string;
  path: string;
  label: string;
  kind: WorkspaceOption["kind"];
  threads: ThreadSummary[];
}

export interface ProjectWorkspaceThreadGroup {
  /** Stable profile, target, project origin, and exact-cwd identity. */
  key: string;
  identity: string;
  projectKey: string;
  projectName: string;
  projectNameKey?: "currentComputer";
  rootProject: boolean;
  path?: string;
  label: string;
  kind: WorkspaceOption["kind"];
  threads: ThreadSummary[];
}

export interface ProjectThreadGroup {
  key: string;
  projectKey: string;
  name: string;
  nameKey?: "currentComputer";
  workspaces: ProjectWorkspaceThreadGroup[];
  pinned?: boolean;
  pinnedOrder?: number;
  pinSupported?: boolean;
  rootProject: boolean;
}

function workspaceBaseName(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).at(-1) ?? path;
}

/**
 * Project/workspace hierarchy for Home, preserving the Gateway target and
 * registry project key as identity. Unregistered cwd history stays in Sessions;
 * it cannot create projects or be reassigned to the configured root.
 */
export function groupThreadsByProject(
  profile: GatewayProfile,
  server: KCoderServer,
  threads: readonly ThreadSummary[],
  workspaces: readonly WorkspaceOption[],
): ProjectThreadGroup[] {
  const entries = new Map<string, ProjectWorkspaceThreadGroup>();
  const add = (input: {
    path?: string;
    label: string;
    kind: WorkspaceOption["kind"];
    projectKey: string;
    projectName: string;
    projectNameKey?: "currentComputer";
    rootProject?: boolean;
  }): ProjectWorkspaceThreadGroup => {
    const scopeKey = workspaceThreadScopeIdentity(input.path);
    const existing = entries.get(scopeKey);
    const identity = JSON.stringify([workspaceEntryIdentity(profile, server, input.projectKey, input.path), input.rootProject === true]);
    const entry: ProjectWorkspaceThreadGroup = {
      key: identity,
      identity,
      projectKey: input.projectKey,
      projectName: input.projectName,
      rootProject: input.rootProject === true,
      ...(input.projectNameKey ? { projectNameKey: input.projectNameKey } : {}),
      path: input.path,
      label: input.label,
      kind: input.kind,
      threads: existing?.threads ?? [],
    };
    entries.set(scopeKey, entry);
    return entry;
  };

  // Match Desktop's synthetic target-root descriptor, but only turn an actual
  // configured path into a creatable Home row.
  if (server.workspacePath) add({
    path: server.workspacePath,
    label: workspaceBaseName(server.workspacePath),
    kind: "workspace",
    projectKey: `runtime-target:${server.id}`,
    rootProject: true,
    projectName: server.label,
    ...(server.labelKey === "currentComputer" ? { projectNameKey: "currentComputer" as const } : {}),
  });

  // Desktop's per-target descriptor map is keyed by canonical workspace path;
  // a registry item replaces the synthetic descriptor for the same path.
  for (const workspace of workspaces) {
    const path = workspace.path.trim();
    if (!path) continue;
    const projectKey = workspace.projectKey ?? workspaceThreadScopeIdentity(path);
    const projectName = workspace.projectName?.trim() || workspace.label.trim() || workspaceBaseName(path);
    add({
      path,
      label: workspace.kind === "worktree" ? workspace.label.trim() || workspaceBaseName(path) : workspaceBaseName(path),
      kind: workspace.kind,
      projectKey,
      projectName,
      rootProject: workspace.rootProject === true,
      ...(workspace.projectNameKey ? { projectNameKey: workspace.projectNameKey } : {}),
    });
  }

  for (const thread of threads) {
    const path = thread.cwd?.trim() || server.workspacePath;
    const scopeKey = workspaceThreadScopeIdentity(path);
    let entry = entries.get(scopeKey);
    if (!entry) {
      if (path) continue;
      entry = add({
        label: t("sessions.default_workspace"),
        kind: "workspace",
        projectKey: `runtime-target:${server.id}`,
        projectName: server.label,
        rootProject: true,
        ...(server.labelKey === "currentComputer" ? { projectNameKey: "currentComputer" as const } : {}),
      });
    }
    entry.threads.push(thread);
  }

  const projects = new Map<string, ProjectThreadGroup>();
  const sidebarKey = (projectKey: string, rootProject: boolean) => JSON.stringify([projectKey, rootProject]);
  const sidebarMetadata = new Map(workspaces.filter(item => item.projectKey && typeof item.projectPinned === "boolean")
    .map(item => [sidebarKey(item.projectKey!, item.rootProject === true), { pinned: item.projectPinned, pinnedOrder: item.projectPinnedOrder, pinSupported: item.projectPinSupported }]));
  for (const entry of entries.values()) {
    const key = JSON.stringify([workspaceProjectIdentity(profile, server, entry.projectKey), entry.rootProject]);
    let project = projects.get(key);
    if (!project) {
      project = {
        key,
        projectKey: entry.projectKey,
        rootProject: entry.rootProject,
        name: entry.projectNameKey === "currentComputer" ? t("home.current_computer") : entry.projectName,
        ...(entry.projectNameKey ? { nameKey: entry.projectNameKey } : {}),
        workspaces: [],
        ...sidebarMetadata.get(sidebarKey(entry.projectKey, entry.rootProject)),
      };
      projects.set(key, project);
    }
    project.workspaces.push(entry);
  }
  return [...projects.values()].filter(project => project.workspaces.some(entry => entry.threads.length > 0 || entry.path !== undefined));
}

function normalizedWorkspacePath(path: string | undefined): string {
  const trimmed = path?.trim() || "/";
  return trimmed === "/" ? trimmed : trimmed.replace(/\/+$/, "");
}

/** Place server tasks under their actual cwd rather than presenting all of them as sessions in the default workspace. */
export function groupThreadsByWorkspace(
  threads: readonly ThreadSummary[],
  workspaces: readonly WorkspaceOption[],
  defaultPath?: string,
): WorkspaceThreadGroup[] {
  const groups = new Map<string, WorkspaceThreadGroup>();
  const addWorkspace = (
    pathValue: string,
    label?: string,
    kind: WorkspaceOption["kind"] = "workspace",
  ) => {
    const path = normalizedWorkspacePath(pathValue);
    if (groups.has(path)) return;
    groups.set(path, {
      key: path,
      path,
      label: label?.trim() || path.split("/").filter(Boolean).at(-1) || "/",
      kind,
      threads: [],
    });
  };
  for (const workspace of workspaces)
    addWorkspace(workspace.path, workspace.label, workspace.kind);
  addWorkspace(defaultPath || "/");
  for (const thread of threads) {
    const path = normalizedWorkspacePath(thread.cwd || defaultPath);
    addWorkspace(path);
    groups.get(path)?.threads.push(thread);
  }
  const normalizedDefault = normalizedWorkspacePath(defaultPath);
  return [...groups.values()].filter(
    (group) =>
      group.threads.length > 0 ||
      group.path === normalizedDefault ||
      workspaces.some(
        (item) => normalizedWorkspacePath(item.path) === group.path,
      ),
  );
}

export function projectVisibleThreads(
  threads: readonly ThreadSummary[],
  expanded: boolean,
): ThreadSummary[] {
  return expanded ? [...threads] : threads.slice(0, INITIAL_VISIBLE_THREADS);
}

export function hiddenThreadCount(
  threads: readonly ThreadSummary[],
  expanded: boolean,
): number {
  return expanded ? 0 : Math.max(0, threads.length - INITIAL_VISIBLE_THREADS);
}

export type ThreadActivityTone = "idle" | "running" | "waiting" | "failed" | "unknown";

export interface ThreadActivityPresentation {
  activity: ThreadRunActivity;
  label: string;
  tone: ThreadActivityTone;
  recentErrorLabel: string | null;
}

/** Project thread status and negotiated run facts consistently for every list surface. */
export function threadActivityPresentation(
  thread: ThreadSummary,
): ThreadActivityPresentation {
  const summary = parseThreadRunSummary(thread.runSummary);
  const activity = threadRunActivity(
    thread.status,
    summary,
  );
  const label = {
    idle: "",
    running: t("task.running"),
    waiting_approval: t("task.waiting_for_approval"),
    waiting_answer: t("task.waiting_for_answer"),
    background: t("task.running_in_background"),
    aggregating: t("task.waiting_for_aggregation"),
    failed: t("task.execution_failed"),
    unknown: t("task.status_needs_verification"),
  }[activity];
  const tone: ThreadActivityTone =
    activity === "running" || activity === "background" || activity === "aggregating"
      ? "running"
      : activity === "waiting_approval" || activity === "waiting_answer"
        ? "waiting"
        : activity === "failed"
          ? "failed"
          : activity === "unknown"
            ? "unknown"
            : "idle";
  const recentErrorLabel = summary?.recentError?.kind === "failed"
    ? t("task.recent_failed")
    : summary?.recentError?.kind === "interrupted"
      ? t("task.recent_interrupted")
      : null;
  return { activity, label, tone, recentErrorLabel };
}
