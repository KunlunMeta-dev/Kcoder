import { parseThreadRunSummary, threadRunActivity } from '../../../shared/threadRunSummary';
import type { ThreadSummary } from "@/gateway/types";
import type { WorkspaceOption } from "@/runtime/task-runtime";

export const INITIAL_VISIBLE_THREADS = 8;

export interface WorkspaceThreadGroup {
  key: string;
  path: string;
  label: string;
  kind: WorkspaceOption["kind"];
  threads: ThreadSummary[];
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

export function threadStatusTone(
  status: ThreadSummary["status"],
): "idle" | "running" | "waiting" | "failed" {
  if (status === "running" || status === "background" || status === "aggregating") return "running";
  if (status === "waiting_for_approval" || status === "waiting_for_answer")
    return "waiting";
  if (status === "failed") return "failed";
  return "idle";
}

export function threadActivityLabel(thread: ThreadSummary): string {
  const activity = threadRunActivity(thread.status, parseThreadRunSummary(thread.runSummary));
  return { idle: '', running: '执行中', waiting_approval: '等待审批', waiting_answer: '等待回答', background: '后台运行', aggregating: '等待汇总', failed: '执行失败', unknown: '状态待核实' }[activity];
}
