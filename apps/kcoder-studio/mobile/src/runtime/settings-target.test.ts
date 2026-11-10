import { describe, expect, it, vi } from "vitest";
import { MobileRpcError } from "@/gateway/rpc";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { WorkspaceProfileFenceError } from "@/storage/workspace-profile-fence";
import {
  resolveSettingsServerId,
  SettingsTargetChangedError,
  SettingsTargetSession,
  settingsTargetIdentity,
  type SettingsTargetProfileRpc,
  type SettingsTargetRpcClient,
  type SettingsTargetSessionDependencies,
} from "./settings-target";

type MockRequest = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
type MockClient = SettingsTargetRpcClient & {
  request: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  emitClose(): void;
};

const profile: GatewayProfile = {
  id: "gateway-a",
  label: "Gateway A",
  baseUrl: "https://gateway.example/a",
  accessToken: "secret-access",
  expiresAt: Number.MAX_SAFE_INTEGER,
  rpcToken: "secret-rpc",
  authorizationGeneration: "auth-generation-1",
  deviceId: "device-1",
};

const serverA: KCoderServer = {
  id: "server-a",
  label: "Server A",
  description: "A",
  runtime: "kcoder",
  transport: "ssh",
  workspacePath: "/workspace/a",
  host: "host-a",
  user: "user-a",
};

const serverB: KCoderServer = {
  ...serverA,
  id: "server-b",
  label: "Server B",
  workspacePath: "/workspace/b",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeClient(
  request: MockRequest = async () => undefined,
  close: () => void = () => {},
) : MockClient {
  const closeListeners = new Set<() => void>();
  return {
    request: vi.fn(request),
    close: vi.fn(close),
    subscribeClose: (listener: () => void) => {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    getCapabilities: vi.fn(() => ({ approvals: true, questions: true, experimental: { providerConfiguration: true } })),
    emitClose: () => {
      for (const listener of [...closeListeners]) listener();
    },
  } as unknown as MockClient;
}

const passProfileFence: SettingsTargetProfileRpc = async (_identity, send) => ({ response: send() });

it("history view renew/release/read cannot reconnect or use a replacement Mobile socket", async () => {
  const original = makeClient(async () => ({ lease: null })), replacement = makeClient(async () => ({ lease: null }));
  const connect = vi.fn().mockResolvedValueOnce(original).mockResolvedValueOnce(replacement);
  const session = new SettingsTargetSession(profile, serverA, () => true, dependencies(connect));
  const requestId = "11111111-1111-4111-8111-111111111111";
  await session.request("migration/history/view/open", { requestId, jobId: "job", expectedArchiveId: "archive" }, "runtime");
  original.emitClose();
  for (const action of ["read", "renew", "release"])
    await expect(session.request(`migration/history/view/${action}`, { requestId, leaseId: "owned", expectedSequence: 1 }, "runtime")).rejects.toMatchObject({ delivery: "not-sent" });
  expect(connect).toHaveBeenCalledTimes(1);
  await session.connect("runtime");
  await expect(session.request("migration/history/view/release", { requestId, leaseId: "owned" }, "runtime")).rejects.toMatchObject({ delivery: "not-sent" });
  expect(replacement.request).not.toHaveBeenCalled();
  session.close();
});

it("a pending history view dispatch checks its original socket again after the async profile fence", async () => {
  const original = makeClient(), replacement = makeClient(), latch = deferred<void>();
  let blocked = false;
  const session = new SettingsTargetSession(profile, serverA, () => true, {
    connect: vi.fn().mockResolvedValueOnce(original).mockResolvedValueOnce(replacement),
    profileRpc: async (_identity, send) => { if (blocked) await latch.promise; return { response: send() }; },
  });
  await session.connect(); blocked = true;
  const operation = session.request("migration/history/view/open", { requestId: "11111111-1111-4111-8111-111111111111", jobId: "job", expectedArchiveId: "archive" }, "runtime");
  await Promise.resolve(); original.emitClose(); blocked = false;
  await session.connect(); latch.resolve();
  await expect(operation).rejects.toMatchObject({ delivery: "not-sent" });
  expect(original.request).not.toHaveBeenCalled(); expect(replacement.request).not.toHaveBeenCalled();
  session.close();
});

function dependencies(
  connect: SettingsTargetSessionDependencies["connect"],
): SettingsTargetSessionDependencies {
  return { connect, profileRpc: passProfileFence };
}

describe("settings target identity and selection", () => {
  it("never chooses the first of multiple servers without an explicit local choice", () => {
    expect(resolveSettingsServerId([serverA, serverB], null)).toBeNull();
    expect(resolveSettingsServerId([serverA, serverB], "server-b")).toBe("server-b");
    expect(resolveSettingsServerId([serverA], null)).toBe("server-a");
  });

  it("includes authorization generation and exact workspace presence in target identity", () => {
    const base = settingsTargetIdentity(profile, serverA);
    expect(settingsTargetIdentity({ ...profile, authorizationGeneration: "auth-generation-2" }, serverA)).not.toBe(base);
    expect(settingsTargetIdentity(profile, serverA, undefined)).not.toBe(settingsTargetIdentity(profile, serverA, ""));
    expect(settingsTargetIdentity(profile, serverA)).not.toBe(settingsTargetIdentity(profile, serverB));
  });

  it("uses rotated credentials for a future channel without replacing the live target session", async () => {
    const profiles: GatewayProfile[] = [];
    const client = makeClient();
    const session = new SettingsTargetSession(profile, serverA, () => true, dependencies(async (currentProfile) => {
      profiles.push(currentProfile);
      return client;
    }));

    await session.connect("runtime");
    session.updateProfile({ ...profile, accessToken: "rotated-access", rpcToken: "rotated-rpc" });
    await session.connect("browser");

    expect(profiles).toHaveLength(2);
    expect(profiles[0]?.accessToken).toBe("secret-access");
    expect(profiles[1]?.accessToken).toBe("rotated-access");
    expect(profiles[1]?.rpcToken).toBe("rotated-rpc");
    session.close();
  });

  it("classifies a persisted profile authorization fence as a not-sent stale target", async () => {
    const connector = vi.fn(async () => makeClient());
    const staleProfileFence: SettingsTargetProfileRpc = async () => {
      throw new WorkspaceProfileFenceError();
    };
    const session = new SettingsTargetSession(profile, serverA, () => true, {
      connect: connector,
      profileRpc: staleProfileFence,
    });

    await expect(session.request("settings/write", { value: 1 }, "runtime"))
      .rejects.toMatchObject({ code: "SETTINGS_TARGET_CHANGED", delivery: "not-sent" });
    expect(connector).not.toHaveBeenCalled();
    session.close();
  });
});

describe("SettingsTargetSession", () => {
  it("rejects a captured target request before dispatch after target ownership changes", async () => {
    let current = true;
    const client = makeClient();
    const session = new SettingsTargetSession(profile, serverA, () => current, dependencies(async () => client));
    await session.connect();

    current = false;
    await expect(session.request("settings/write", { value: 1 }, "runtime"))
      .rejects.toMatchObject({ code: "SETTINGS_TARGET_CHANGED", delivery: "not-sent" });
    expect(client.request).not.toHaveBeenCalled();
    session.close();
  });

  it("does not present a late response from the previous target as success or replay the write", async () => {
    let current = true;
    const response = deferred<unknown>();
    const client = makeClient(async () => response.promise);
    const session = new SettingsTargetSession(profile, serverA, () => current, dependencies(async () => client));
    const pending = session.request("settings/write", { value: 1 }, "runtime");
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(1));

    current = false;
    response.resolve({ saved: true });
    await expect(pending).rejects.toMatchObject({ code: "SETTINGS_TARGET_CHANGED", delivery: "unknown" });
    expect(client.request).toHaveBeenCalledTimes(1);
    session.close();
  });

  it("aborts a pending target connection immediately and closes a late client it owned", async () => {
    const lateConnection = deferred<SettingsTargetRpcClient>();
    const connected = vi.fn(() => lateConnection.promise);
    const session = new SettingsTargetSession(
      profile,
      serverA,
      () => true,
      dependencies(async () => connected()),
    );
    const pending = session.connect();
    await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(1));

    session.close();
    await expect(pending).rejects.toMatchObject({ code: "SETTINGS_TARGET_CHANGED", delivery: "not-sent" });

    const lateClient = makeClient();
    lateConnection.resolve(lateClient);
    await vi.waitFor(() => expect(lateClient.close).toHaveBeenCalledTimes(1));
  });

  it.each(["owner-change", "session-close"] as const)("closes a completed connection when %s precedes its holder delivery", async reason => {
    let current = true;
    const holderEntered = deferred<void>();
    const holderRelease = deferred<void>();
    const client = makeClient();
    const peerClient = makeClient();
    const peer = new SettingsTargetSession(profile, serverB, () => true, dependencies(async () => peerClient));
    await peer.connect();
    const session = new SettingsTargetSession(profile, serverA, () => current, {
      connect: async () => client,
      profileRpc: async (_identity, send) => {
        const response = send();
        holderEntered.resolve();
        await holderRelease.promise;
        return { response };
      },
    });
    const outcome = session.connect().then(() => null, error => error);
    await holderEntered.promise;
    await Promise.resolve();
    if (reason === "owner-change") current = false;
    else session.close();
    holderRelease.resolve();

    expect(await outcome).toMatchObject({ code: "SETTINGS_TARGET_CHANGED", delivery: "not-sent" });
    await vi.waitFor(() => expect(client.close).toHaveBeenCalledTimes(1));
    expect(peerClient.close).not.toHaveBeenCalled();
    session.close();
    expect(client.close).toHaveBeenCalledTimes(1);
    peer.close();
  });

  it("closes only clients owned by the session and reuses each owned channel client", async () => {
    const clientA = makeClient();
    const browserClientA = makeClient();
    const clientB = makeClient();
    const browserClientB = makeClient();
    const connected: Array<{ serverId: string; channel: string }> = [];
    const connector: SettingsTargetSessionDependencies["connect"] = async (_profile, server, _workspace, channel) => {
      connected.push({ serverId: server.id, channel });
      return server.id === serverA.id
        ? channel === "browser" ? browserClientA : clientA
        : channel === "browser" ? browserClientB : clientB;
    };
    const sessionA = new SettingsTargetSession(profile, serverA, () => true, dependencies(connector));
    const sessionB = new SettingsTargetSession(profile, serverB, () => true, dependencies(connector));

    await sessionA.connect();
    await sessionA.connect();
    await sessionA.connect("browser");
    await sessionB.connect();
    await sessionB.connect("browser");
    expect(connected).toEqual([
      { serverId: "server-a", channel: "runtime" },
      { serverId: "server-a", channel: "browser" },
      { serverId: "server-b", channel: "runtime" },
      { serverId: "server-b", channel: "browser" },
    ]);

    sessionA.close();
    expect(clientA.close).toHaveBeenCalledTimes(1);
    expect(browserClientA.close).toHaveBeenCalledTimes(1);
    expect(clientB.close).not.toHaveBeenCalled();
    expect(browserClientB.close).not.toHaveBeenCalled();
    sessionB.close();
    expect(clientB.close).toHaveBeenCalledTimes(1);
    expect(browserClientB.close).toHaveBeenCalledTimes(1);
  });

  it("settles in-flight owned RPCs immediately when its session closes", async () => {
    const response = deferred<unknown>();
    const client = makeClient(async () => response.promise, () => response.reject(new Error("closed")));
    const session = new SettingsTargetSession(profile, serverA, () => true, dependencies(async () => client));
    const pending = session.request("settings/write", { value: 1 }, "runtime");
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(1));

    session.close();
    await expect(pending).rejects.toMatchObject({ code: "SETTINGS_TARGET_CHANGED", delivery: "unknown" });
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("invalidates an unexpectedly closed runtime client so an explicit read retry reconnects", async () => {
    const firstClient = makeClient(async () => "first");
    const replacementClient = makeClient(async () => "replacement");
    let connections = 0;
    const connect = vi.fn(async () => ++connections === 1 ? firstClient : replacementClient);
    const session = new SettingsTargetSession(profile, serverA, () => true, dependencies(connect));
    const closeEvents: string[] = [];
    session.subscribeClose(({ channel }) => closeEvents.push(channel));

    await expect(session.request("settings/read", {}, "runtime")).resolves.toBe("first");
    firstClient.emitClose();
    expect(closeEvents).toEqual(["runtime"]);
    expect(session.getCapabilities().appServer).toBeNull();

    await expect(session.request("settings/read", {}, "runtime")).resolves.toBe("replacement");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(firstClient.request).toHaveBeenCalledTimes(1);
    expect(replacementClient.request).toHaveBeenCalledTimes(1);

    // A delayed duplicate close from the old socket cannot evict its replacement.
    firstClient.emitClose();
    expect(session.getCapabilities().appServer).toEqual(replacementClient.getCapabilities());
    await expect(session.connect()).resolves.toBe(replacementClient);
    expect(connect).toHaveBeenCalledTimes(2);
    session.close();
  });

  it("leaves an interrupted mutation unknown and never resends it automatically", async () => {
    const response = deferred<unknown>();
    const client = makeClient(() => response.promise);
    const connect = vi.fn(async () => client);
    const session = new SettingsTargetSession(profile, serverA, () => true, dependencies(connect));
    const mutation = session.request("settings/write", { value: 1 }, "runtime");
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(1));

    client.emitClose();
    response.reject(new MobileRpcError("connection closed"));

    await expect(mutation).rejects.toMatchObject({ name: "MobileRpcError", delivery: "unknown" });
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    session.close();
  });

  it("isolates browser-channel closure from runtime and peer clients", async () => {
    const runtimeClient = makeClient();
    const browserClient = makeClient();
    const replacementBrowserClient = makeClient();
    const peerClient = makeClient();
    let browserConnections = 0;
    const connector: SettingsTargetSessionDependencies["connect"] = async (_profile, server, _workspace, channel) => {
      if (server.id === serverB.id) return peerClient;
      if (channel === "browser") return ++browserConnections === 1 ? browserClient : replacementBrowserClient;
      return runtimeClient;
    };
    const session = new SettingsTargetSession(profile, serverA, () => true, dependencies(connector));
    const peerSession = new SettingsTargetSession(profile, serverB, () => true, dependencies(connector));
    const closeEvents: string[] = [];
    session.subscribeClose(({ channel }) => closeEvents.push(channel));
    await session.connect("runtime");
    await session.connect("browser");
    await peerSession.connect("runtime");

    browserClient.emitClose();
    expect(closeEvents).toEqual(["browser"]);
    expect(session.getCapabilities().appServer).toEqual(runtimeClient.getCapabilities());
    expect(runtimeClient.close).not.toHaveBeenCalled();
    expect(peerClient.close).not.toHaveBeenCalled();

    await expect(session.connect("browser")).resolves.toBe(replacementBrowserClient);
    session.close();
    peerSession.close();
    expect(browserClient.close).not.toHaveBeenCalled();
    expect(replacementBrowserClient.close).toHaveBeenCalledTimes(1);
    expect(runtimeClient.close).toHaveBeenCalledTimes(1);
    expect(peerClient.close).toHaveBeenCalledTimes(1);
  });
});
