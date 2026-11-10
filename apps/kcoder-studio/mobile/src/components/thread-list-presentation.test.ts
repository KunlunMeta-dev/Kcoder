import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";
import { t } from "@/i18n";
import { getLocale, setLocale } from "@/i18n/locale-state";
import type { GatewayProfile, KCoderServer, ThreadSummary } from "@/gateway/types";
import {
  groupThreadsByProject,
  hiddenThreadCount,
  groupThreadsByWorkspace,
  projectVisibleThreads,
  threadActivityPresentation,
  workspaceSectionCollapseKey,
  workspaceTargetPresentations,
  workspaceTargetColor,
} from "./thread-list-presentation";
import type { ThreadRecentError, ThreadRunActivity, ThreadRunSummary } from "../../../shared/threadRunSummary";

function threads(count: number): ThreadSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `thread-${index}`,
    status: "idle",
    createdAt: index,
    updatedAt: index,
  }));
}

it("keeps target badge colors stable across workspaces, token renewal and Gateway route changes", () => {
  const profile = { baseUrl: "https://gateway.example", connectionRoutes: { gatewayId: "a".repeat(64) } } as GatewayProfile;
  const server = { id: "target-a", workspacePath: "/one" } as KCoderServer;
  const anotherWorkspace = { ...server, workspacePath: "/two" };
  const color = workspaceTargetColor(profile, server);
  expect(workspaceTargetColor({ ...profile, baseUrl: "http://192.0.2.1", accessToken: "renewed", authorizationGeneration: "renewed" } as GatewayProfile, anotherWorkspace)).toBe(color);
  expect(workspaceTargetColor({ ...profile }, { ...server })).toBe(color);
  expect(workspaceTargetColor(profile, { id: "target-b" })).not.toBe(color);
  const legacy = { baseUrl: "https://legacy.example" } as GatewayProfile;
  expect(workspaceTargetColor(legacy, server)).toBe(workspaceTargetColor({ ...legacy, accessToken: "renewed" } as GatewayProfile, server));
});

describe("thread list presentation", () => {
  it("uses one readable target descriptor and disambiguates identical targets by server id", () => {
    const first: KCoderServer = {
      id: "target-a", label: "Shared", description: "", runtime: "kcoder", transport: "local", workspacePath: "/repo",
    };
    const second = { ...first, id: "target-b" };
    const remote: KCoderServer = {
      id: "target-c", label: "Remote", description: "", runtime: "kcoder", transport: "ssh", host: "builder.test", user: "work", port: 2222,
    };
    const result = workspaceTargetPresentations([first, second, remote]);
    const local = t("home.workspace_target_local", { p0: "Shared" });
    const ssh = t("home.workspace_target_ssh", { p0: "Remote", p1: "work@builder.test:2222" });

    expect(result.get("target-a")).toEqual({ display: `target-a · ${local}`, accessible: `${local} (target-a)` });
    expect(result.get("target-b")).toEqual({ display: `target-b · ${local}`, accessible: `${local} (target-b)` });
    expect(result.get("target-c")).toEqual({ display: ssh, accessible: `${ssh} (target-c)` });
  });

  it("preserves the existing profile-scoped fold key for missing and normalized paths", () => {
    expect(workspaceSectionCollapseKey("target-a", undefined)).toBe("target-a\0/");
    expect(workspaceSectionCollapseKey("target-a", " /repo/// ")).toBe("target-a\0/repo");
    expect(workspaceSectionCollapseKey("target-b", "/repo/")).toBe("target-b\0/repo");
  });

  it("groups exact workspace paths by registry projectKey and never invents a cwd for an implicit root", () => {
    const profile: GatewayProfile = {
      id: "gateway-a", label: "Gateway A", baseUrl: "https://gateway.test", accessToken: "a", rpcToken: "r",
      expiresAt: Number.MAX_SAFE_INTEGER, authorizationGeneration: "auth-a", deviceId: "device-a",
    };
    const target: KCoderServer = {
      id: "target-a", label: "Target A", description: "", runtime: "kcoder", transport: "local", workspacePath: "/repo",
    };
    const rows = [
      { path: "/repo/main", label: "Project", kind: "workspace" as const, projectKey: "project-key", projectName: "Project" },
      { path: "/repo/tools", label: "Project", kind: "workspace" as const, projectKey: "project-key", projectName: "Project" },
    ];
    const project = groupThreadsByProject(profile, target, [
      { ...threads(1)[0]!, cwd: "/repo/main/" },
      { ...threads(1)[0]!, id: "thread-2", cwd: "/repo/tools" },
    ], rows);
    expect(project).toHaveLength(2); // the exact configured root stays its own target project
    const registered = project.find(item => item.projectKey === "project-key")!;
    expect(registered.name).toBe("Project");
    expect(registered.workspaces.map(item => [item.path, item.label, item.threads.map(thread => thread.id)])).toEqual([
      ["/repo/main", "main", ["thread-0"]],
      ["/repo/tools", "tools", ["thread-2"]],
    ]);
    expect(registered.workspaces[0]?.identity).not.toBe(registered.workspaces[1]?.identity);

    const withoutDefault = groupThreadsByProject(profile, { ...target, label: "This Computer", labelKey: "currentComputer", workspacePath: undefined }, [
      { ...threads(1)[0]!, cwd: undefined },
      { ...threads(1)[0]!, id: "unregistered-thread", cwd: "/not-registered" },
    ], [{ path: "/registered", label: "Registered", kind: "workspace", projectKey: "registered-key", projectName: "Registered" }]);
    expect(withoutDefault.flatMap(item => item.workspaces.map(workspace => workspace.path))).toContain(undefined);
    expect(withoutDefault.flatMap(item => item.workspaces.map(workspace => workspace.path))).not.toContain("/");
    expect(withoutDefault.find(item => item.projectKey === "registered-key")?.workspaces[0]?.path).toBe("/registered");
    expect(withoutDefault.some(item => item.projectKey === "/not-registered")).toBe(false);
  });

  it("does not promote old history directories into projects or reassign them to the configured root", () => {
    const profile = { id: "gateway-a", baseUrl: "https://gateway.test", authorizationGeneration: "auth-a" } as GatewayProfile;
    const target = { id: "target-a", label: "Current project", workspacePath: "/current/workspace" } as KCoderServer;
    const current = { ...threads(1)[0]!, id: "current", cwd: "/current/workspace" };
    const old = { ...threads(1)[0]!, id: "old", cwd: "/retired/preview/workspace" };
    const registered = { ...threads(1)[0]!, id: "registered", cwd: "/registered/workspace" };
    const history = [current, old, registered];
    const projects = groupThreadsByProject(profile, target, history, [
      { path: target.workspacePath!, label: "Current project", kind: "workspace", projectKey: "runtime-target:target-a", rootProject: true, projectPinned: true },
      { path: "/registered/workspace", label: "Registered project", kind: "workspace", projectKey: "registered", projectName: "Registered project" },
    ]);

    expect(projects.map(project => [project.name, project.pinned, project.workspaces.flatMap(workspace => workspace.threads.map(thread => thread.id))]))
      .toEqual([["Current project", true, ["current"]], ["Registered project", undefined, ["registered"]]]);
    expect(history).toEqual([current, old, registered]);
    expect(old.cwd).toBe("/retired/preview/workspace");
  });

  it("默认限制列表并允许完整展开", () => {
    const items = threads(11);
    expect(projectVisibleThreads(items, false).map((item) => item.id)).toEqual(
      threads(8).map((item) => item.id),
    );
    expect(projectVisibleThreads(items, true)).toHaveLength(11);
    expect(hiddenThreadCount(items, false)).toBe(3);
    expect(hiddenThreadCount(items, true)).toBe(0);
  });

  it("为完整旧状态矩阵保留会话语义，缺少摘要时遵循服务端 coarse status", () => {
    const cases: Array<[
      ThreadSummary["status"],
      ThreadRunActivity,
      string,
      "idle" | "running" | "waiting" | "failed" | "unknown",
    ]> = [
      ["idle", "idle", "", "idle"],
      ["running", "running", t("task.running"), "running"],
      ["waiting_for_approval", "waiting_approval", t("task.waiting_for_approval"), "waiting"],
      ["waiting_for_answer", "waiting_answer", t("task.waiting_for_answer"), "waiting"],
      ["background", "background", t("task.running_in_background"), "running"],
      ["aggregating", "aggregating", t("task.waiting_for_aggregation"), "running"],
      ["failed", "failed", t("task.execution_failed"), "failed"],
      ["unknown", "unknown", t("task.status_needs_verification"), "unknown"],
    ];
    for (const [status, expectedActivity, label, tone] of cases) {
      const presentation = threadActivityPresentation({
        id: status,
        status,
        createdAt: 0,
        updatedAt: 0,
      });
      expect(presentation.activity).toBe(expectedActivity);
      expect(presentation.label).toBe(label);
      expect(presentation.tone).toBe(tone);
    }
  });

  it("摘要中的 user wait、background、aggregation 和 unknown 覆盖粗状态", () => {
    const completeSummary = (
      overrides: Partial<ThreadRunSummary> = {},
    ): ThreadRunSummary => ({
      mainTurn: "idle",
      pendingApprovals: 0,
      pendingQuestions: 0,
      activeJobs: 0,
      tasksPending: 0,
      tasksRunning: 0,
      pendingFollowups: 0,
      pendingGoals: 0,
      ...overrides,
    });
    const cases: Array<[
      ThreadSummary["status"],
      ThreadRunSummary,
      string,
      "idle" | "running" | "waiting" | "failed" | "unknown",
    ]> = [
      ["running", completeSummary({ pendingApprovals: 1 }), t("task.waiting_for_approval"), "waiting"],
      ["running", completeSummary({ pendingQuestions: 1 }), t("task.waiting_for_answer"), "waiting"],
      ["idle", completeSummary({ mainTurn: "running" }), t("task.running"), "running"],
      ["idle", completeSummary({ activeJobs: 1 }), t("task.running_in_background"), "running"],
      ["idle", completeSummary({ pendingFollowups: 1 }), t("task.waiting_for_aggregation"), "running"],
      ["running", completeSummary({ mainTurn: "unknown" }), t("task.status_needs_verification"), "unknown"],
      ["running", completeSummary(), "", "idle"],
    ];
    for (const [status, runSummary, label, tone] of cases) {
      const presentation = threadActivityPresentation({
        id: `${status}-${label}`,
        status,
        runSummary,
        createdAt: 0,
        updatedAt: 0,
      });
      expect(presentation.label).toBe(label);
      expect(presentation.tone).toBe(tone);
    }
  });

  it("在冲突的服务端事实间保持活动优先级，且合法全 idle 持久化摘要沿用粗状态", () => {
    const persistedSummary = (
      overrides: Partial<ThreadRunSummary> = {},
    ): ThreadRunSummary => ({
      mainTurn: "unknown",
      pendingApprovals: null,
      pendingQuestions: null,
      activeJobs: null,
      tasksPending: null,
      tasksRunning: null,
      pendingFollowups: null,
      pendingGoals: null,
      ...overrides,
    });
    const completeSummary = (
      overrides: Partial<ThreadRunSummary> = {},
    ): ThreadRunSummary => ({
      mainTurn: "idle",
      pendingApprovals: 0,
      pendingQuestions: 0,
      activeJobs: 0,
      tasksPending: 0,
      tasksRunning: 0,
      pendingFollowups: 0,
      pendingGoals: 0,
      ...overrides,
    });
    const cases: Array<[
      string,
      ThreadSummary["status"],
      ThreadRunSummary,
      ThreadRunActivity,
      string,
      "idle" | "running" | "waiting" | "failed" | "unknown",
    ]> = [
      ["approval beats question", "running", completeSummary({ pendingApprovals: 1, pendingQuestions: 1 }), "waiting_approval", t("task.waiting_for_approval"), "waiting"],
      ["main turn beats background", "idle", completeSummary({ mainTurn: "running", activeJobs: 1 }), "running", t("task.running"), "running"],
      ["background beats aggregation", "idle", completeSummary({ activeJobs: 1, pendingFollowups: 1 }), "background", t("task.running_in_background"), "running"],
      ["known approval survives unknown counters", "idle", persistedSummary({ pendingApprovals: 1 }), "waiting_approval", t("task.waiting_for_approval"), "waiting"],
      ["all-null persisted summary retains idle", "idle", persistedSummary(), "idle", "", "idle"],
    ];
    for (const [caseName, status, runSummary, activity, label, tone] of cases) {
      const presentation = threadActivityPresentation({
        id: caseName,
        status,
        runSummary,
        createdAt: 0,
        updatedAt: 0,
      });
      expect(presentation.activity, caseName).toBe(activity);
      expect(presentation.label, caseName).toBe(label);
      expect(presentation.tone, caseName).toBe(tone);
    }
  });

  it("localizes recent failures separately without replacing idle or active state", () => {
    const previousLocale = getLocale();
    const completeSummary = (
      overrides: Partial<ThreadRunSummary> = {},
    ): ThreadRunSummary => ({
      mainTurn: "idle",
      pendingApprovals: 0,
      pendingQuestions: 0,
      activeJobs: 0,
      tasksPending: 0,
      tasksRunning: 0,
      pendingFollowups: 0,
      pendingGoals: 0,
      ...overrides,
    });
    const failed: ThreadRecentError = {
      turnId: "turn-1",
      kind: "failed",
      source: "execution",
      category: "execution",
      atMs: 1,
    };
    const interrupted: ThreadRecentError = {
      ...failed,
      turnId: "turn-2",
      kind: "interrupted",
      atMs: 2,
    };
    const present = (
      status: ThreadSummary["status"],
      runSummary: ThreadRunSummary,
    ) => threadActivityPresentation({ id: "recent-error", status, runSummary, createdAt: 0, updatedAt: 0 });

    try {
      setLocale("en");
      const idleFailure = present("idle", completeSummary({ recentError: failed }));
      expect(idleFailure).toMatchObject({
        activity: "idle",
        label: "",
        tone: "idle",
        recentErrorLabel: "Recently failed",
      });

      const activeFailure = present("idle", completeSummary({ mainTurn: "running", recentError: failed }));
      expect(activeFailure).toMatchObject({
        activity: "running",
        label: t("task.running"),
        tone: "running",
        recentErrorLabel: "Recently failed",
      });
      expect(present("idle", completeSummary({ recentError: interrupted })).recentErrorLabel)
        .toBe("Recently interrupted");

      setLocale("zh-CN");
      expect(present("idle", completeSummary({ recentError: failed })).recentErrorLabel)
        .toBe("最近失败");
      expect(present("idle", completeSummary({ recentError: interrupted })).recentErrorLabel)
        .toBe("最近中断");
    } finally {
      setLocale(previousLocale);
    }
  });

  it("does not show a recent error hint when recentError is absent or null", () => {
    const completeSummary = (
      overrides: Partial<ThreadRunSummary> = {},
    ): ThreadRunSummary => ({
      mainTurn: "idle",
      pendingApprovals: 0,
      pendingQuestions: 0,
      activeJobs: 0,
      tasksPending: 0,
      tasksRunning: 0,
      pendingFollowups: 0,
      pendingGoals: 0,
      ...overrides,
    });
    for (const runSummary of [completeSummary(), completeSummary({ recentError: null })]) {
      expect(threadActivityPresentation({
        id: "no-recent-error",
        status: "idle",
        runSummary,
        createdAt: 0,
        updatedAt: 0,
      }).recentErrorLabel).toBeNull();
    }
  });

  it("无效或旧端缺少摘要时仍按 coarse status 显示，unknown 不会退化为 idle", () => {
    const presentation = threadActivityPresentation({
      id: "legacy-background",
      status: "background",
      runSummary: { mainTurn: "idle" } as unknown as ThreadRunSummary,
      createdAt: 0,
      updatedAt: 0,
    });
    expect(presentation.activity).toBe("background");
    expect(presentation.label).toBe(t("task.running_in_background"));
    expect(presentation.tone).toBe("running");

    const unknown = threadActivityPresentation({
      id: "unknown",
      status: "unknown",
      createdAt: 0,
      updatedAt: 0,
    });
    expect(unknown.activity).toBe("unknown");
    expect(unknown.tone).toBe("unknown");
    expect(unknown.label).toBe(t("task.status_needs_verification"));
  });

  it("Home、Sessions、Drawer 使用同一 thread activity selector", () => {
    const paths = [
      "../app/h/[profileId]/index.tsx",
      "../app/sessions.tsx",
      "./mobile-drawer.tsx",
    ];
    for (const path of paths) {
      const source = readFileSync(
        fileURLToPath(new URL(path, import.meta.url)),
        "utf8",
      );
      expect(source).toContain("threadActivityPresentation(");
      if (path !== "../app/sessions.tsx") expect(source).toContain("activity.recentErrorLabel");
    }
  });

  it("按真实 cwd 分组，并保留尚无任务的已登记 workspace", () => {
    const items = threads(3);
    items[0].cwd = "/repo/main/";
    items[1].cwd = "/repo/worktree";
    items[2].cwd = "/repo/unregistered";
    const groups = groupThreadsByWorkspace(items, [
      { path: "/repo/main", label: "主项目", kind: "workspace" },
      { path: "/repo/worktree", label: "功能分支", kind: "worktree" },
      { path: "/repo/empty", label: "空工作区", kind: "workspace" },
    ], "/repo/main");

    expect(groups.map((group) => [group.path, group.label, group.threads.map((item) => item.id)])).toEqual([
      ["/repo/main", "主项目", ["thread-0"]],
      ["/repo/worktree", "功能分支", ["thread-1"]],
      ["/repo/empty", "空工作区", []],
      ["/repo/unregistered", "unregistered", ["thread-2"]],
    ]);
  });
});
