import { afterEach, expect, test, vi } from "vitest";
import type { JsonRecord } from "@/gateway/rpc";
import { profileAuthorizationScopeKey } from "@/state/profile-coordinator";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import { TaskRuntimeRegistry } from "./task-runtime/registry";
import { FakeClient, profile, server } from "./task-runtime/fixture.test-support";
import type { InteractionOwnerBinding, PendingInteraction } from "./task-runtime/types";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}), gatewaySessionExpired: vi.fn(async () => false) }));
const registries: TaskRuntimeRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.removeProfile(profile.id);
  taskRuntimeTestHelpers.resetConnector();
});
const registryForTest = () => { const registry = new TaskRuntimeRegistry(); registries.push(registry); return registry; };
function clientForThread(threadId: string) {
  const client = new FakeClient([]);
  const originalRequest = client.request.bind(client);
  client.request = vi.fn(async <T,>(method: string, params: JsonRecord = {}) => {
    if (method === "thread/resume" || method === "thread/read") return {
      thread: { id: threadId, title: threadId, cwd: "/workspace", status: "idle" }, messages: [],
    } as T;
    return originalRequest<T>(method, params);
  }) as never;
  return client;
}
function approval(client: FakeClient, threadId: string, id: number, turnId = `turn-${id}`) {
  const params = { serverId: "server-engine-test", threadId, turnId, appServerEpoch: "shared-epoch", approvalId: `approval-${id}`, reason: "approve", action: { type: "command", command: "echo" } };
  client.emit({ id, method: "approval/request", params });
  return params;
}
async function resume(registry: TaskRuntimeRegistry, threadId: string, activation = 1) {
  const runtime = await TaskRuntime.resume({ profile, server, threadId, profileActivationEpoch: activation, isCurrentInteractionOwner: () => true });
  registry.put(profile.id, server.id, runtime);
  return runtime;
}

test("two runtimes can receive a shared epoch's higher ID before an unseen lower ID without losing the lower request", async () => {
  const a = clientForThread("thread-a"), b = clientForThread("thread-b");
  const clients = [a, b];
  taskRuntimeTestHelpers.setConnector(vi.fn(async () => clients.shift() as never) as never);
  const registry = registryForTest();
  const runtimeA = await resume(registry, "thread-a");
  const runtimeB = await resume(registry, "thread-b");
  approval(a, "thread-a", 1_000_001);
  approval(b, "thread-b", 1_000_000);
  expect(runtimeA.isInteractionActionable(runtimeA.pendingInteractions[0]!)).toBe(true);
  expect(runtimeB.isInteractionActionable(runtimeB.pendingInteractions[0]!)).toBe(true);
  expect(registry.interactionInboxRows(profileAuthorizationScopeKey(profile))).toEqual(expect.arrayContaining([
    expect.objectContaining({ threadId: "thread-a", requestId: 1_000_001, liveActionable: true }),
    expect.objectContaining({ threadId: "thread-b", requestId: 1_000_000, liveActionable: true }),
  ]));
  // An ID already owned by the other thread is a conflicting identity, not a new request.
  approval(b, "thread-b", 1_000_001, "conflicting-turn");
  expect(runtimeB.isInteractionActionable(runtimeB.pendingInteractions[1]!)).toBe(false);
  expect(runtimeA.isInteractionActionable(runtimeA.pendingInteractions[0]!)).toBe(true);
});

test("clearing a retired row cannot grant its exact request to a new runtime generation", async () => {
  const oldClient = clientForThread("thread-a"), newClient = clientForThread("thread-a");
  const clients = [oldClient, newClient];
  taskRuntimeTestHelpers.setConnector(vi.fn(async () => clients.shift() as never) as never);
  const registry = registryForTest();
  const oldRuntime = await resume(registry, "thread-a");
  approval(oldClient, "thread-a", 100);
  expect(oldRuntime.isInteractionActionable(oldRuntime.pendingInteractions[0]!)).toBe(true);
  registry.remove(profile.id, server.id, "thread-a");
  registry.clearReadonlyInteractionRows(profileAuthorizationScopeKey(profile));
  const newRuntime = await resume(registry, "thread-a", 2);
  approval(newClient, "thread-a", 100);
  approval(newClient, "thread-a", 99);
  expect(newRuntime.pendingInteractions[0]?.owner.status).toBe("unknown");
  expect(newRuntime.isInteractionActionable(newRuntime.pendingInteractions[0]!)).toBe(false);
  expect(newRuntime.isInteractionActionable(newRuntime.pendingInteractions[1]!)).toBe(true);
});

test("resolved replay protection survives tombstone eviction without rejecting unseen lower IDs", async () => {
  const client = clientForThread("thread-a");
  taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
  const registry = registryForTest();
  const runtime = await resume(registry, "thread-a");
  for (let id = 10; id < 610; id += 1) {
    const params = approval(client, "thread-a", id);
    client.emit({ method: "approval/resolved", params: { ...params, requestId: id } });
  }
  expect(runtime.pendingInteractions).toHaveLength(0);
  approval(client, "thread-a", 10);
  approval(client, "thread-a", 9);
  expect(runtime.pendingInteractions[0]?.owner.status).toBe("unknown");
  expect(runtime.isInteractionActionable(runtime.pendingInteractions[0]!)).toBe(false);
  expect(runtime.isInteractionActionable(runtime.pendingInteractions[1]!)).toBe(true);
});

test("the exact identity budget fails closed without forgetting old IDs and discloses saturation", () => {
  const registry = registryForTest();
  const policy = registry as unknown as { ownerForInteraction(profileId: string, interaction: PendingInteraction): InteractionOwnerBinding | undefined };
  const make = (requestId: number, scope = "scope-a"): PendingInteraction => ({
    kind: "approval", requestId, approvalId: `approval-${requestId}`, reason: "approve", action: { type: "command", command: "echo" },
    owner: { profileId: profile.id, profileAuthorizationScopeKey: scope, serverId: server.id, appServerId: "backend", serverConfigIdentity: "target-config", threadId: "thread-a", turnId: `turn-${requestId}`, appServerEpoch: "epoch-a", runtimeInstanceNonce: 1, profileActivationEpoch: 1, originClientGeneration: 1, status: "pending" },
  });
  for (let id = 1; id <= 4096; id += 1) expect(policy.ownerForInteraction(profile.id, make(id))).toBeUndefined();
  expect(policy.ownerForInteraction(profile.id, make(4097))?.status).toBe("unknown");
  const anotherEpoch = make(4098);
  anotherEpoch.owner = { ...anotherEpoch.owner, appServerEpoch: "epoch-b" };
  expect(policy.ownerForInteraction(profile.id, anotherEpoch)).toMatchObject({ status: "unknown", originClientGeneration: -1 });
  expect(policy.ownerForInteraction(profile.id, make(1))?.runtimeInstanceNonce).toBe(-1);
  expect(registry.interactionInboxOverflow("scope-a").mayContainUntrackedRows).toBe(true);
  expect(policy.ownerForInteraction(profile.id, make(1, "scope-b"))?.status).toBe("unknown");
  expect(policy.ownerForInteraction(profile.id, make(2, "scope-b"))).toMatchObject({ status: "unknown", originClientGeneration: -1 });
  expect(registry.interactionInboxOverflow("scope-b").mayContainUntrackedRows).toBe(true);
});
