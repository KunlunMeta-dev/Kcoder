import { describe, expect, it, vi } from "vitest";
import type { GatewayProfile } from "@/gateway/types";
import { TaskRuntimeRegistry } from "@/runtime/task-runtime/registry";
import { ProfileCoordinator } from "./profile-coordinator";
import { applyProfileConnectionEffects } from "./profile-connection-effects";

function profile(id: string, accessToken = id, baseUrl = "http://same.test"): GatewayProfile {
  return {
    id,
    label: id,
    baseUrl,
    accessToken,
    rpcToken: id,
    expiresAt: Date.now() + 60_000,
  };
}

describe("profile connection effects", () => {
  it("被新连接淘汰的同 host 响应不会移除新 active profile 的 task runtime", async () => {
    const coordinator = new ProfileCoordinator();
    coordinator.hydrate({ profiles: [profile("stable", "before")], activeId: "stable" });
    const oldIntent = coordinator.beginConnection();
    const currentIntent = coordinator.beginConnection();
    const currentCommit = await coordinator.commitConnection(
      currentIntent,
      profile("new-exchange", "current-token"),
      async () => {},
    );

    const registry = new TaskRuntimeRegistry();
    const closeRuntime = vi.fn();
    const runtime = {
      getSnapshot: () => ({ threadId: "thread-1", running: true, interaction: null }),
      isDisposed: () => false,
      hasLiveTerminalSessions: () => false,
      close: closeRuntime,
    };
    const effects = {
      setProfiles: vi.fn(),
      setActiveId: vi.fn(),
      removeProfileRuntimes: (id: string) => registry.removeProfile(id),
      clearRuntime: vi.fn(),
    };

    expect(
      applyProfileConnectionEffects(
        currentCommit,
        profile("new-exchange", "current-token"),
        () => coordinator.isLatestConnectionIntent(currentIntent),
        effects,
      ),
    ).toMatchObject({ id: "stable", accessToken: "current-token" });
    registry.put("stable", "server", runtime as never);

    const staleCommit = await coordinator.commitConnection(
      oldIntent,
      profile("old-exchange", "old-token"),
      async () => {},
    );
    const result = applyProfileConnectionEffects(
      staleCommit,
      profile("old-exchange", "old-token"),
      () => coordinator.isLatestConnectionIntent(oldIntent),
      effects,
    );

    expect(result).toBeNull();
    expect(registry.get("stable", "server", "thread-1")).toBe(runtime);
    expect(closeRuntime).not.toHaveBeenCalled();
    expect(effects.clearRuntime).toHaveBeenCalledTimes(1);
    expect(effects.setActiveId).toHaveBeenCalledTimes(1);
    expect(effects.setProfiles).toHaveBeenCalledTimes(1);
  });

  it("持久化期间出现更新意图时回写原 activeId 且不清理当前 runtime", async () => {
    const coordinator = new ProfileCoordinator();
    coordinator.hydrate({ profiles: [profile("stable", "before")], activeId: "stable" });
    const oldIntent = coordinator.beginConnection();
    let releasePersist!: () => void;
    let persistStarted!: () => void;
    const blocked = new Promise<void>((resolve) => { releasePersist = resolve; });
    const started = new Promise<void>((resolve) => { persistStarted = resolve; });
    const persistedActiveIds: Array<string | null> = [];
    const pendingCommit = coordinator.commitConnection(
      oldIntent,
      profile("new-host", "new-token", "http://new.test"),
      async (_profiles, activeId) => {
        persistedActiveIds.push(activeId);
        if (persistedActiveIds.length === 1) {
          persistStarted();
          await blocked;
        }
      },
    );
    await started;
    coordinator.beginConnection();
    releasePersist();
    const commit = await pendingCommit;

    const registry = new TaskRuntimeRegistry();
    const closeRuntime = vi.fn();
    const runtime = {
      getSnapshot: () => ({ threadId: "thread-1", running: true, interaction: null }),
      isDisposed: () => false,
      hasLiveTerminalSessions: () => false,
      close: closeRuntime,
    };
    registry.put("stable", "server", runtime as never);
    const effects = {
      setProfiles: vi.fn(),
      setActiveId: vi.fn(),
      removeProfileRuntimes: (id: string) => registry.removeProfile(id),
      clearRuntime: vi.fn(),
    };

    expect(commit).toMatchObject({ committed: true, activated: false });
    expect(commit.snapshot.activeId).toBe("stable");
    expect(persistedActiveIds).toEqual(["new-host", "stable"]);
    expect(
      applyProfileConnectionEffects(
        commit,
        profile("new-host", "new-token", "http://new.test"),
        () => coordinator.isLatestConnectionIntent(oldIntent),
        effects,
      ),
    ).toBeNull();
    expect(registry.get("stable", "server", "thread-1")).toBe(runtime);
    expect(closeRuntime).not.toHaveBeenCalled();
    expect(effects.setProfiles).toHaveBeenCalledTimes(1);
    expect(effects.setActiveId).not.toHaveBeenCalled();
    expect(effects.clearRuntime).not.toHaveBeenCalled();
  });

  it("首次连接尚未激活时保留 null activeId，不回退到唯一 profile", async () => {
    const coordinator = new ProfileCoordinator();
    coordinator.hydrate({ profiles: [], activeId: null });
    const staleIntent = coordinator.beginConnection();
    let releasePersist!: () => void;
    let persistStarted!: () => void;
    const blocked = new Promise<void>((resolve) => { releasePersist = resolve; });
    const started = new Promise<void>((resolve) => { persistStarted = resolve; });
    const persistedActiveIds: Array<string | null> = [];
    const pendingCommit = coordinator.commitConnection(
      staleIntent,
      profile("first-host", "first-token", "http://first.test"),
      async (_profiles, activeId) => {
        persistedActiveIds.push(activeId);
        if (persistedActiveIds.length === 1) {
          persistStarted();
          await blocked;
        }
      },
    );
    await started;
    coordinator.beginConnection();
    releasePersist();
    const commit = await pendingCommit;

    expect(commit).toMatchObject({ committed: true, activated: false });
    expect(commit.snapshot.profiles).toHaveLength(1);
    expect(commit.snapshot.activeId).toBeNull();
    expect(persistedActiveIds).toEqual(["first-host", null]);
  });

  it("路由在持久化期间取消时回写旧快照且不应用连接副作用", async () => {
    const coordinator = new ProfileCoordinator();
    coordinator.hydrate({ profiles: [profile("stable", "before")], activeId: "stable" });
    const intent = coordinator.beginConnection();
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => {
      coordinator.cancelConnectionIntent(intent);
    });
    let releasePersist!: () => void;
    let persistStarted!: () => void;
    const blocked = new Promise<void>((resolve) => { releasePersist = resolve; });
    const started = new Promise<void>((resolve) => { persistStarted = resolve; });
    const persistedActiveIds: Array<string | null> = [];
    const onCommit = vi.fn();
    const pendingCommit = coordinator.commitConnection(
      intent,
      profile("new-host", "new-token", "http://new.test"),
      async (_profiles, activeId) => {
        persistedActiveIds.push(activeId);
        if (persistedActiveIds.length === 1) {
          persistStarted();
          await blocked;
        }
      },
      controller.signal,
      onCommit,
    );
    await started;
    controller.abort();
    releasePersist();
    const commit = await pendingCommit;

    expect(commit).toMatchObject({ committed: false, activated: false });
    expect(commit.snapshot.profiles).toMatchObject([{ id: "stable", accessToken: "before" }]);
    expect(commit.snapshot.activeId).toBe("stable");
    expect(persistedActiveIds).toEqual(["new-host", "stable"]);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("在 coordinator 原子提交回调中应用副作用，之后的新意图不会撤销已提交状态", async () => {
    const coordinator = new ProfileCoordinator();
    coordinator.hydrate({ profiles: [profile("stable", "before")], activeId: "stable" });
    const intent = coordinator.beginConnection();
    const effects = {
      setProfiles: vi.fn(),
      setActiveId: vi.fn(),
      removeProfileRuntimes: vi.fn(),
      clearRuntime: vi.fn(),
    };
    let returnedProfile: GatewayProfile | null = null;
    const commit = await coordinator.commitConnection(
      intent,
      profile("new-exchange", "new-token"),
      async () => {},
      undefined,
      (result) => {
        returnedProfile = applyProfileConnectionEffects(
          result,
          profile("new-exchange", "new-token"),
          () => coordinator.isLatestConnectionIntent(intent),
          effects,
        );
      },
    );

    coordinator.beginConnection();

    expect(commit).toMatchObject({ committed: true, activated: true });
    expect(returnedProfile).toMatchObject({ id: "stable", accessToken: "new-token" });
    expect(effects.setActiveId).toHaveBeenCalledWith("stable");
    expect(effects.clearRuntime).toHaveBeenCalledTimes(1);
  });

  it("before-effect 的 intent 核验失败时不移除 runtime 或变更 activeId", async () => {
    const coordinator = new ProfileCoordinator();
    coordinator.hydrate({ profiles: [profile("stable", "before")], activeId: "stable" });
    const intent = coordinator.beginConnection();
    const commit = await coordinator.commitConnection(
      intent,
      profile("new-exchange", "new-token"),
      async () => {},
    );
    const effects = {
      setProfiles: vi.fn(),
      setActiveId: vi.fn(),
      removeProfileRuntimes: vi.fn(),
      clearRuntime: vi.fn(),
    };

    const result = applyProfileConnectionEffects(
      commit,
      profile("new-exchange", "new-token"),
      () => false,
      effects,
    );

    expect(result).toBeNull();
    expect(effects.setProfiles).toHaveBeenCalledTimes(1);
    expect(effects.removeProfileRuntimes).not.toHaveBeenCalled();
    expect(effects.setActiveId).not.toHaveBeenCalled();
    expect(effects.clearRuntime).not.toHaveBeenCalled();
  });
});
