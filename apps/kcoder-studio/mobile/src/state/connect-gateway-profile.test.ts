import { describe, expect, it, vi } from "vitest";
import type { GatewayProfile } from "@/gateway/types";
import { ProfileCoordinator } from "./profile-coordinator";
import { connectGatewayProfile } from "./connect-gateway-profile";

const profile = (id = "new", accessToken = "known-access-token"): GatewayProfile => ({
  id,
  label: id,
  baseUrl: `http://${id}.test`,
  accessToken,
  expiresAt: 1_000,
  rpcToken: "known-rpc-token",
});

describe("connectGatewayProfile cleanup boundary", () => {
  it("revokes a known token when cancellation arrives after exchange but before commit", async () => {
    const controller = new AbortController();
    const exchangedProfile = profile();
    const commit = vi.fn(async () => ({
      snapshot: { profiles: [], activeId: null },
      committed: false,
      activated: false,
    }));
    const revoke = vi.fn(async () => {
      throw new Error("cleanup unavailable");
    });

    const result = await connectGatewayProfile({
      signal: controller.signal,
      exchange: async () => {
        controller.abort();
        return exchangedProfile;
      },
      commit,
      applyCommit: () => exchangedProfile,
      revoke,
    });

    expect(result).toBeNull();
    expect(commit).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(exchangedProfile);
  });

  it("does not revoke when persistence throws because the stored outcome is unknown", async () => {
    const coordinator = new ProfileCoordinator();
    const intent = coordinator.beginConnection();
    const exchangedProfile = profile();
    const persistError = new Error("secure store commit outcome unknown");
    const revoke = vi.fn(async () => {});

    await expect(connectGatewayProfile({
      exchange: async () => exchangedProfile,
      commit: (nextProfile, onCommit) => coordinator.commitConnection(
        intent,
        nextProfile,
        async () => { throw persistError; },
        undefined,
        onCommit,
      ),
      applyCommit: () => exchangedProfile,
      revoke,
    })).rejects.toBe(persistError);

    expect(coordinator.getSnapshot().profiles).toEqual([]);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("keeps the token when a saved but unactivated profile returns null", async () => {
    const coordinator = new ProfileCoordinator();
    const staleIntent = coordinator.beginConnection();
    coordinator.beginConnection();
    const exchangedProfile = profile();
    const revoke = vi.fn(async () => {});

    const result = await connectGatewayProfile({
      exchange: async () => exchangedProfile,
      commit: (nextProfile, onCommit) => coordinator.commitConnection(
        staleIntent,
        nextProfile,
        async () => {},
        undefined,
        onCommit,
      ),
      applyCommit: () => null,
      revoke,
    });

    expect(result).toBeNull();
    expect(coordinator.getSnapshot()).toMatchObject({
      profiles: [{ id: "new", accessToken: "known-access-token" }],
      activeId: null,
    });
    expect(revoke).not.toHaveBeenCalled();
  });

  it("does not revoke when a commit effect throws after the coordinator commits", async () => {
    const coordinator = new ProfileCoordinator();
    const intent = coordinator.beginConnection();
    const exchangedProfile = profile();
    const effectError = new Error("React effect failed");
    const revoke = vi.fn(async () => {});

    await expect(connectGatewayProfile({
      exchange: async () => exchangedProfile,
      commit: (nextProfile, onCommit) => coordinator.commitConnection(
        intent,
        nextProfile,
        async () => {},
        undefined,
        onCommit,
      ),
      applyCommit: () => { throw effectError; },
      revoke,
    })).rejects.toBe(effectError);

    expect(coordinator.getSnapshot().profiles).toMatchObject([
      { id: "new", accessToken: "known-access-token" },
    ]);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("revokes when the coordinator explicitly returns an uncommitted result after rollback", async () => {
    const coordinator = new ProfileCoordinator();
    const existing = profile("existing", "previous-token");
    coordinator.hydrate({ profiles: [existing], activeId: existing.id });
    const intent = coordinator.beginConnection();
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => {
      coordinator.cancelConnectionIntent(intent);
    });
    const exchangedProfile = profile("new-host");
    let releasePersist!: () => void;
    let persistStarted!: () => void;
    const blocked = new Promise<void>((resolve) => { releasePersist = resolve; });
    const started = new Promise<void>((resolve) => { persistStarted = resolve; });
    const persist = vi.fn(async () => {
      if (persist.mock.calls.length === 1) {
        persistStarted();
        await blocked;
      }
    });
    const revoke = vi.fn(async () => {});

    const pending = connectGatewayProfile({
      signal: controller.signal,
      exchange: async () => exchangedProfile,
      commit: (nextProfile, onCommit) => coordinator.commitConnection(
        intent,
        nextProfile,
        persist,
        controller.signal,
        onCommit,
      ),
      applyCommit: () => exchangedProfile,
      revoke,
    });
    await started;
    controller.abort();
    releasePersist();

    expect(await pending).toBeNull();
    expect(coordinator.getSnapshot()).toMatchObject({
      profiles: [{ id: "existing", accessToken: "previous-token" }],
      activeId: "existing",
    });
    expect(persist).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(exchangedProfile);
  });
});
