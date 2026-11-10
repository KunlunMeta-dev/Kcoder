import { afterEach, expect, test, vi } from "vitest";
import type { JsonRecord } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "../task-runtime";
import { FakeClient, profile, server } from "./fixture.test-support";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach(runtime => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
});

async function fixture(kind: "question" | "approval", legacy = false) {
  const client = new FakeClient([]);
  client.respond = vi.fn();
  client.respondError = vi.fn();
  taskRuntimeTestHelpers.setConnector(async () => client as never);
  const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1",
    profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
  runtimes.push(runtime);
  const binding: JsonRecord = { serverId: client.getAppServerId(), threadId: "thread-1",
    turnId: "turn", appServerEpoch: "epoch", [`${kind}Id`]: "original" };
  if (legacy) delete binding.appServerEpoch;
  client.emit({ id: 41, method: `${kind}/request`, params: { ...binding,
    ...(kind === "question" ? { questions: [{ id: "item", prompt: "Continue?", options: [] }] }
      : { action: { type: "command", command: "echo fixture" } }),
  } });
  const receipt = { method: `${kind}/resolved`, params: { ...binding, requestId: 41,
    sequence: 42, reason: "client_response" } };
  return { runtime, client, receipt };
}

for (const kind of ["question", "approval"] as const) {
  test.each([
    { name: "numeric", value: 7 },
    { name: "boolean", value: false },
    { name: "empty string", value: "" },
    { name: "array", value: [] },
    { name: "object", value: {} },
    { name: "foreign string", value: "foreign" },
  ])(
    `${kind}: $name epoch cannot settle an omitted legacy binding`, async ({ value }) => {
      const { runtime, client, receipt } = await fixture(kind, true);
      const original = runtime.pendingInteractions[0]!;
      expect(original.owner.appServerEpoch).toBeNull();
      const resolved = vi.fn();
      runtime.setInteractionLedgerObserver({ ownerFor: () => undefined, wasResolved: () => false,
        changed: vi.fn(), resolved });
      client.emit({ ...receipt, params: { ...receipt.params, appServerEpoch: value } });
      expect(runtime.pendingInteractions).toEqual([original]);
      expect(resolved).not.toHaveBeenCalled();
      // Reuse the same sequence. Rejecting a malformed tuple must leave the
      // authoritative receipt eligible, including on legacy transports.
      client.emit(receipt);
      expect(runtime.pendingInteractions).toEqual([]);
      expect(resolved).toHaveBeenCalledExactlyOnceWith(original);
      client.emit(receipt);
      expect(resolved).toHaveBeenCalledTimes(1);
      expect(client.respond).not.toHaveBeenCalled();
      expect(client.respondError).not.toHaveBeenCalled();
    },
  );

  test.each([undefined, null])(`${kind}: legacy epoch=%s still settles its original card`, async value => {
    const { runtime, client, receipt } = await fixture(kind, true);
    expect(runtime.pendingInteractions).toHaveLength(1);
    client.emit({ ...receipt, params: { ...receipt.params, appServerEpoch: value } });
    expect(runtime.pendingInteractions).toEqual([]);
  });

  test(`${kind}: exact current binding still settles its original card`, async () => {
    const { runtime, client, receipt } = await fixture(kind);
    expect(runtime.pendingInteractions).toHaveLength(1);
    client.emit(receipt);
    expect(runtime.pendingInteractions).toEqual([]);
  });
}
