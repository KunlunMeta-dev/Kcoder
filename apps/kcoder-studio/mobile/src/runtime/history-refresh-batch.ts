import { workspaceThreadScopeIdentity } from "./task-runtime/workspaces";
import {
  type HistoryRefreshProgress,
  type HistoryRefreshSnapshot,
} from "./history-refresh";

export interface HistoryRefreshBatchSnapshot {
  phase: HistoryRefreshSnapshot["phase"];
  totalWorkspaces: number;
  completedWorkspaces: string[];
  currentWorkspace?: string;
  progress?: HistoryRefreshProgress;
  error?: string;
  errorWorkspace?: string;
}

export interface HistoryRefreshBatchChild {
  readonly snapshot: HistoryRefreshSnapshot;
  start(acknowledged: boolean): Promise<void>;
  resume(): Promise<void>;
  cancel(): Promise<void>;
}

export type HistoryRefreshBatchChildFactory = (
  workspace: string,
  onChange: (snapshot: HistoryRefreshSnapshot) => void,
) => HistoryRefreshBatchChild;

function fixedWorkspaceSnapshot(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const workspaces: string[] = [];
  for (const path of paths) {
    if (typeof path !== "string" || !path.trim()) throw new Error("刷新范围包含无效工作区");
    const identity = workspaceThreadScopeIdentity(path);
    if (seen.has(identity)) continue;
    seen.add(identity);
    workspaces.push(path);
  }
  if (workspaces.length === 0) throw new Error("没有可刷新的已知工作区");
  return workspaces;
}

/** Serially refreshes one fixed, already-discovered workspace snapshot. */
export class HistoryRefreshBatchController {
  readonly workspaces: string[];
  snapshot: HistoryRefreshBatchSnapshot;
  private readonly completed: string[] = [];
  private active?: { workspace: string; controller: HistoryRefreshBatchChild };
  private running?: Promise<void>;
  private cancelled = false;
  private cancellation?: Promise<void>;

  constructor(
    paths: readonly string[],
    private readonly createChild: HistoryRefreshBatchChildFactory,
    private readonly onChange: (snapshot: HistoryRefreshBatchSnapshot) => void,
    private readonly isCurrent: () => boolean = () => true,
  ) {
    this.workspaces = fixedWorkspaceSnapshot(paths);
    this.snapshot = { phase: "idle", totalWorkspaces: this.workspaces.length, completedWorkspaces: [] };
  }

  start(acknowledged: boolean): Promise<void> {
    if (!acknowledged) throw new Error("请先明确确认手工及旧版写入器的刷新约定");
    if (this.snapshot.phase !== "idle" || this.cancelled) throw new Error("刷新已启动或关闭");
    return this.launch("start");
  }

  resume(): Promise<void> {
    if (this.snapshot.phase !== "paused" || this.cancelled || !this.active) throw new Error("没有可继续的刷新");
    return this.launch("resume");
  }

  cancel(): Promise<void> {
    if (this.cancellation) return this.cancellation;
    this.cancellation = this.cancelOwned();
    return this.cancellation;
  }

  private async cancelOwned(): Promise<void> {
    if (["ready", "incomplete", "error", "cancelled"].includes(this.snapshot.phase)) return;
    this.cancelled = true;
    const active = this.active?.controller;
    const running = this.running;
    if (active) await active.cancel();
    if (running) await running;
    if (this.snapshot.phase !== "cancelled") this.publish({
      phase: "cancelled",
      totalWorkspaces: this.workspaces.length,
      completedWorkspaces: [...this.completed],
      ...(this.active ? { currentWorkspace: this.active.workspace } : {}),
    });
  }

  private launch(mode: "start" | "resume"): Promise<void> {
    this.publish({
      ...this.snapshot,
      phase: "building",
      completedWorkspaces: [...this.completed],
    });
    const work = Promise.resolve().then(() => this.run(mode));
    let tracked: Promise<void>;
    tracked = work.finally(() => { if (this.running === tracked) this.running = undefined; });
    this.running = tracked;
    return tracked;
  }

  private async run(mode: "start" | "resume"): Promise<void> {
    while (!this.cancelled) {
      if (!this.isCurrent()) {
        this.cancelled = true;
        if (this.active) await this.active.controller.cancel();
        this.publish({ phase: "cancelled", totalWorkspaces: this.workspaces.length, completedWorkspaces: [...this.completed] });
        return;
      }

      if (!this.active) {
        const workspace = this.workspaces[this.completed.length];
        if (!workspace) {
          this.publish({ phase: "ready", totalWorkspaces: this.workspaces.length, completedWorkspaces: [...this.completed] });
          return;
        }
        let controller!: HistoryRefreshBatchChild;
        try {
          controller = this.createChild(workspace, (snapshot) => this.publishChild(workspace, controller, snapshot));
        } catch (error) {
          this.publish({
            phase: "error",
            totalWorkspaces: this.workspaces.length,
            completedWorkspaces: [...this.completed],
            currentWorkspace: workspace,
            errorWorkspace: workspace,
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        this.active = { workspace, controller };
      }

      const active = this.active;
      try {
        if (mode === "resume") await active.controller.resume();
        else await active.controller.start(true);
      } catch (error) {
        if (this.cancelled) break;
        this.publish({
          phase: "error",
          totalWorkspaces: this.workspaces.length,
          completedWorkspaces: [...this.completed],
          currentWorkspace: active.workspace,
          errorWorkspace: active.workspace,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      if (this.cancelled) break;
      if (!this.isCurrent()) {
        this.cancelled = true;
        await active.controller.cancel();
        break;
      }

      const child = active.controller.snapshot;
      if (child.phase === "ready") {
        this.completed.push(active.workspace);
        this.active = undefined;
        mode = "start";
        continue;
      }
      if (child.phase === "paused") {
        this.publish({
          phase: "paused",
          totalWorkspaces: this.workspaces.length,
          completedWorkspaces: [...this.completed],
          currentWorkspace: active.workspace,
          ...(child.progress ? { progress: child.progress } : {}),
        });
        return;
      }
      if (child.phase === "incomplete") {
        this.publish({
          phase: "incomplete",
          totalWorkspaces: this.workspaces.length,
          completedWorkspaces: [...this.completed],
          currentWorkspace: active.workspace,
          errorWorkspace: active.workspace,
          ...(child.progress ? { progress: child.progress } : {}),
        });
        return;
      }
      if (child.phase === "error") {
        this.publish({
          phase: "error",
          totalWorkspaces: this.workspaces.length,
          completedWorkspaces: [...this.completed],
          currentWorkspace: active.workspace,
          errorWorkspace: active.workspace,
          ...(child.error ? { error: child.error } : {}),
          ...(child.progress ? { progress: child.progress } : {}),
        });
        return;
      }
      if (child.phase === "cancelled") {
        this.cancelled = true;
        break;
      }
      this.publish({
        phase: "error",
        totalWorkspaces: this.workspaces.length,
        completedWorkspaces: [...this.completed],
        currentWorkspace: active.workspace,
        errorWorkspace: active.workspace,
        error: "工作区刷新未返回终态",
      });
      return;
    }

    this.publish({
      phase: "cancelled",
      totalWorkspaces: this.workspaces.length,
      completedWorkspaces: [...this.completed],
      ...(this.active ? { currentWorkspace: this.active.workspace } : {}),
    });
  }

  private publishChild(workspace: string, controller: HistoryRefreshBatchChild, child: HistoryRefreshSnapshot): void {
    if (this.active?.controller !== controller || this.active.workspace !== workspace) return;
    if (!this.isCurrent()) {
      if (!this.cancelled) void this.cancel();
      return;
    }
    const phase = child.phase === "ready" ? "building" : child.phase;
    this.publish({
      phase,
      totalWorkspaces: this.workspaces.length,
      completedWorkspaces: [...this.completed],
      currentWorkspace: workspace,
      ...(child.progress ? { progress: child.progress } : {}),
      ...(child.error ? { error: child.error, errorWorkspace: workspace } : {}),
    });
  }

  private publish(snapshot: HistoryRefreshBatchSnapshot): void {
    this.snapshot = snapshot;
    this.onChange(snapshot);
  }
}
