import { describe, expect, it } from "vitest";
import type { GatewayProfile } from "@/gateway/types";
import { ProfileCoordinator, ProfileOperationGate } from "./profile-coordinator";

function profile(id: string): GatewayProfile {
  return { id, label: id, baseUrl: `http://${id}.test`, accessToken: id, rpcToken: id, expiresAt: Date.now() + 60_000 };
}

describe("ProfileCoordinator", () => {
  it("逆序完成的连接会合并，且只有最新意图成为当前 Gateway", async () => {
    const coordinator = new ProfileCoordinator();
    coordinator.hydrate({ profiles: [profile("A")], activeId: "A" });
    const intentB = coordinator.beginConnection();
    const intentC = coordinator.beginConnection();
    const persisted: string[] = [];
    const persist = async (profiles: GatewayProfile[], activeId: string | null) => {
      persisted.push(`${profiles.map((item) => item.id).join(",")}:${activeId}`);
    };

    const completedC = coordinator.commitConnection(intentC, profile("C"), persist);
    const completedB = coordinator.commitConnection(intentB, profile("B"), persist);
    await Promise.all([completedB, completedC]);

    const finalSnapshot = await completedB;
    expect(finalSnapshot.profiles.map((item) => item.id)).toEqual(["A", "C", "B"]);
    expect(finalSnapshot.activeId).toBe("C");
    expect(persisted).toEqual(["A,C:C", "A,C,B:C"]);
  });

  it("用户手动切换会使仍在网络中的旧配对失去激活权", async () => {
    const coordinator = new ProfileCoordinator();
    coordinator.hydrate({ profiles: [profile("A"), profile("B")], activeId: "A" });
    const staleIntent = coordinator.beginConnection();
    const persist = async () => {};
    await coordinator.activate("B", persist);
    const snapshot = await coordinator.commitConnection(staleIntent, profile("C"), persist);
    expect(snapshot.profiles.map((item) => item.id)).toEqual(["A", "B", "C"]);
    expect(snapshot.activeId).toBe("B");
  });

  it("同一 Gateway 的旧连接逆序完成时不会覆盖最新凭据或留下悬空 activeId", async () => {
    const coordinator = new ProfileCoordinator();
    coordinator.hydrate({ profiles: [profile("A")], activeId: "A" });
    const staleIntent = coordinator.beginConnection();
    const latestIntent = coordinator.beginConnection();
    const sameGateway = (id: string): GatewayProfile => ({ ...profile(id), baseUrl: "http://same.test" });
    const persist = async () => {};
    await coordinator.commitConnection(latestIntent, sameGateway("C"), persist);
    const snapshot = await coordinator.commitConnection(staleIntent, sameGateway("B"), persist);
    expect(snapshot.profiles.map((item) => item.id)).toEqual(["A", "C"]);
    expect(snapshot.activeId).toBe("C");
    expect(snapshot.profiles.some((item) => item.id === snapshot.activeId)).toBe(true);
  });

  it("同源旧连接先提交而最新网络请求失败时仍保持有效 activeId", async () => {
    const coordinator = new ProfileCoordinator();
    const existing = { ...profile("A"), baseUrl: "http://same.test" };
    coordinator.hydrate({ profiles: [existing], activeId: existing.id });
    const staleIntent = coordinator.beginConnection();
    coordinator.beginConnection();
    const snapshot = await coordinator.commitConnection(
      staleIntent,
      { ...profile("B"), baseUrl: existing.baseUrl },
      async () => {},
    );
    expect(snapshot.profiles.map((item) => item.id)).toEqual(["A"]);
    expect(snapshot.activeId).toBe("A");
    expect(snapshot.profiles[0].accessToken).toBe("B");
  });

  it("重新授权同一 Gateway 时保留 profile id 和依赖该 id 的工作区状态", async () => {
    const coordinator = new ProfileCoordinator();
    const existing = { ...profile("stable"), baseUrl: "http://same.test", accessToken: "expired" };
    coordinator.hydrate({ profiles: [existing], activeId: existing.id });
    const intent = coordinator.beginConnection();
    const snapshot = await coordinator.commitConnection(
      intent,
      { ...profile("new-random-id"), baseUrl: existing.baseUrl, accessToken: "renewed" },
      async () => {},
    );
    expect(snapshot.profiles).toHaveLength(1);
    expect(snapshot.profiles[0]).toMatchObject({ id: "stable", accessToken: "renewed" });
    expect(snapshot.activeId).toBe("stable");
  });

  it("可在 React state 提交前识别 coordinator 已激活的 profile", async () => {
    const coordinator = new ProfileCoordinator();
    coordinator.hydrate({ profiles: [profile("A"), profile("B")], activeId: "A" });
    expect(coordinator.isActive("A")).toBe(true);
    expect(coordinator.isActive("B")).toBe(false);
    await coordinator.activate("B", async () => {});
    expect(coordinator.isActive("B")).toBe(true);
  });
});

describe("ProfileOperationGate", () => {
  it("同一个 profile 的并发路由激活只执行一次", async () => {
    const gate = new ProfileOperationGate();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const activate = () => {
      calls += 1;
      return blocked;
    };

    const first = gate.run("B", activate);
    const second = gate.run("B", activate);

    expect(second).toBe(first);
    expect(calls).toBe(1);
    release();
    await first;

    const third = gate.run("B", async () => { calls += 1; });
    expect(third).not.toBe(first);
    await third;
    expect(calls).toBe(2);
  });

  it("失败后允许重新激活同一个 profile", async () => {
    const gate = new ProfileOperationGate();
    await expect(gate.run("B", async () => { throw new Error("persist failed"); })).rejects.toThrow("persist failed");
    await expect(gate.run("B", async () => {})).resolves.toBeUndefined();
  });
});
