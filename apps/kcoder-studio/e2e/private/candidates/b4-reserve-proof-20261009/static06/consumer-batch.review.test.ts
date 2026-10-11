// Actual store, codec, consumer and GatewayRpcClient; controlled transport and
// serial manifest fixture only. This is not native, IndexedDB cross-tab or UI proof.
import { afterEach, expect, it, vi } from "vitest";
import { GatewayRpcClient } from "@/gateway/rpc";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { StagedAttachmentStore, type StagedAttachmentRecord } from "@/storage/staged-attachment-store";
import { StagedAttachmentConsumers, RetainedConsumerPrepaidSlotUnavailable, RetainedConsumerUnknown } from "@/storage/staged-attachment-consumers";
import type { AttachmentBytesBackend, AttachmentStoreChange } from "@/storage/staged-attachment-bytes";
import { normalizedRetentionStageRefs, RETENTION_CAPABILITY, RETENTION_ERROR_RESERVE_PREPAID_SLOT_UNAVAILABLE } from "@/protocol/attachment-retention";

const admission = { version: 1 as const, rootNamespace: "consumer_review", admissionEpoch: 7 };
const scopeId = "a".repeat(64);
const profile: GatewayProfile = { id: "consumer-review", label: "fixture", baseUrl: "https://fixture.invalid", accessToken: "synthetic", rpcToken: "synthetic-rpc", expiresAt: 9_999_999_999_999, authorizationGeneration: "generation-a", deviceId: "device-a" };
const server: KCoderServer = { id: "target", label: "target", description: "fixture", runtime: "kcoder", transport: "local" };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
class Manifest implements AttachmentBytesBackend {
  readonly kind = "web" as const;
  rows = new Map<string, StagedAttachmentRecord>(); bytes = new Map<string, Blob>(); tail = Promise.resolve(); failNext = false;
  snapshot() { return [...this.rows.values()].map(row => structuredClone(row)); }
  async transaction<T>(change: (rows: readonly unknown[]) => AttachmentStoreChange<T>): Promise<T> {
    const before = this.tail; const held = deferred<void>(); this.tail = held.promise; await before;
    try {
      const changeSet = change(this.snapshot());
      if (this.failNext) { this.failNext = false; throw new Error("controlled transaction abort"); }
      const writes = [...(changeSet.putRows ?? []), ...(changeSet.putRow ? [changeSet.putRow] : [])];
      for (const row of writes) this.rows.set(row.id, structuredClone(row.value) as StagedAttachmentRecord);
      if (changeSet.putBytes) this.bytes.set(changeSet.putBytes.id, changeSet.putBytes.blob);
      if (changeSet.deleteBytes) this.bytes.delete(changeSet.deleteBytes);
      return changeSet.value;
    } finally { held.resolve(); }
  }
  async source(id: string, expectedSize: number) {
    const blob = this.bytes.get(id); if (!blob || blob.size !== expectedSize) throw new Error("missing original source");
    return { size: blob.size, async read(offset: number, length: number) { return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()); } };
  }
}
type Frame = { id: number; method: string; params: Record<string, unknown> };
class Peer {
  calls: Frame[] = []; ready: unknown; next?: (socket: Socket, frame: Frame) => void;
  seen = deferred<Frame>(); atSend?: () => void;
  send(socket: Socket, frame: Frame) {
    if (frame.method === "initialized") return;
    if (frame.method === "initialize") { queueMicrotask(() => socket.reply(frame.id, { protocolVersion: frame.params.protocolVersion, capabilities: { experimental: { [RETENTION_CAPABILITY]: true } }, attachmentUploadAdmission: admission })); return; }
    this.calls.push(frame); this.atSend?.(); this.seen.resolve(frame);
    if (frame.method === "attachment/retention/reserve") {
      const refs = frame.params.stageRefs as Parameters<typeof normalizedRetentionStageRefs>[0];
      this.ready = { scopeId, result: { receipt: { clientRequestId: frame.params.clientRequestId, retentionId: `r1.${admission.rootNamespace}.7.${"f".repeat(32)}`, threadId: frame.params.threadId, revision: 1, state: "ready", entries: normalizedRetentionStageRefs(refs).map(stageRef => ({ stageRef, state: "ready" })) } } };
    }
    const action = this.next; this.next = undefined;
    if (action) action(socket, frame); else queueMicrotask(() => socket.reply(frame.id, this.ready));
  }
}
class Socket {
  static readonly OPEN = 1;
  static peer: Peer; readyState = 1;
  onopen: (() => void) | null = null; onerror: (() => void) | null = null; onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { queueMicrotask(() => this.onopen?.()); }
  send(raw: string) { Socket.peer.send(this, JSON.parse(raw) as Frame); }
  reply(id: number, result: unknown) { this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, result }) }); }
  error(id: number, code = -32000) { this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, error: { code, message: "controlled lost ACK" } }) }); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
}
const clients: GatewayRpcClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); vi.unstubAllGlobals(); });
async function setup(count = 2) {
  const backend = new Manifest(); const store = new StagedAttachmentStore(backend); let current = true;
  const context = { profile: { ...profile }, server: { ...server }, workspacePath: "/workspace", isCurrent: () => current };
  const rows: StagedAttachmentRecord[] = [];
  for (let index = 0; index < count; index++) {
    const blob = new Blob([new Uint8Array([index, 17])]);
    const prepared = await store.prepare(context, admission, `file-${index}.bin`, { size: blob.size, blob, async read(offset, length) { return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()); } });
    rows.push(await store.update(context, prepared, row => ({ ...row, phase: "sealed", confirmedBytes: row.size, scopeId, stageRef: { rootNamespace: admission.rootNamespace, epoch: 7, ownerId: "owner", entryId: `entry-${index}`, revision: 1 } })));
  }
  const peer = new Peer(); Socket.peer = peer; vi.stubGlobal("WebSocket", Socket as unknown as typeof WebSocket);
  const client = await GatewayRpcClient.connect(context.profile, context.server, context.workspacePath); clients.push(client);
  const consumers = new StagedAttachmentConsumers(context, client, store);
  return { backend, store, context, rows, peer, client, consumers, invalidate: () => { current = false; } };
}
it("binds all members before synchronous reserve, confirms exact proof and removes only local bytes", async () => {
  const f = await setup(); const handle = await f.consumers.prepare(f.rows.map(row => row.id), "thread", "message");
  f.peer.atSend = () => {
    const rows = f.backend.snapshot(); expect(rows.every(row => row.consumers[0]?.reserveId === handle.reserveId)).toBe(true);
    expect(rows.find(row => row.id === handle.leaderId)?.consumerBatch?.phase).toBe("reserveSent");
  };
  const proof = await f.consumers.reserveOrRead(handle); f.peer.atSend = undefined;
  expect(proof.stageRefs).toHaveLength(2); expect(f.peer.calls.map(frame => frame.method)).toEqual(["attachment/retention/reserve"]);
  await f.consumers.removeConfirmedSources(proof); expect(f.backend.bytes.size).toBe(0);
  expect(await f.consumers.listUnresolved()).toEqual([handle]); // terminal outbox survives byte cleanup
});
it("aborts an all-member binding atomically and does not send a reserve", async () => {
  const f = await setup(); const before = f.backend.snapshot(); f.backend.failNext = true;
  await expect(f.consumers.prepare(f.rows.map(row => row.id), "thread", "message")).rejects.toThrow();
  expect(f.backend.snapshot()).toEqual(before); expect(f.peer.calls).toHaveLength(0);
});
it("rejects one stale member without claiming the other or overwriting message membership", async () => {
  const f = await setup(); const stale = f.rows[0]!;
  await f.store.update(f.context, stale, row => ({ ...row })); const before = f.backend.snapshot();
  await expect(f.store.prepareConsumerBatch(f.context, f.rows, "thread", "message")).rejects.toThrow();
  expect(f.backend.snapshot()).toEqual(before);
  await f.consumers.prepare(f.rows.map(row => row.id), "thread", "message");
  await expect(f.consumers.prepare([f.rows[0]!.id], "thread", "message")).rejects.toThrow();
  expect(f.peer.calls).toHaveLength(0);
});
it("lost ACK and reload recover only original r1 by read, including null without new mutation", async () => {
  const f = await setup(); const handle = await f.consumers.prepare(f.rows.map(row => row.id), "thread", "message");
  f.peer.next = (socket, frame) => queueMicrotask(() => socket.error(frame.id));
  await expect(f.consumers.reserveOrRead(handle)).rejects.toMatchObject({ handle });
  const restored = new StagedAttachmentConsumers(f.context, f.client, new StagedAttachmentStore(f.backend));
  expect(await restored.listUnresolved()).toEqual([handle]);
  f.peer.next = (socket, frame) => queueMicrotask(() => socket.reply(frame.id, { scopeId, result: { receipt: null } }));
  await expect(restored.reserveOrRead(handle)).rejects.toMatchObject({ handle });
  const proof = await restored.reserveOrRead(handle);
  expect(f.peer.calls.map(frame => frame.method)).toEqual(["attachment/retention/reserve", "attachment/retention/read", "attachment/retention/read"]);
  for (const frame of f.peer.calls.slice(1)) expect(frame.params.selector).toEqual({ by: "clientRequestId", clientRequestId: handle.reserveId });
  await restored.removeConfirmedSources(proof); expect(f.backend.bytes.size).toBe(0);
});
it.each([{ kind: "scope" }, { kind: "entry" }, { kind: "nonready" }])("rejects $kind drift and preserves every local source", async ({ kind }) => {
  const f = await setup(); const handle = await f.consumers.prepare(f.rows.map(row => row.id), "thread", "message");
  f.peer.next = (socket, frame) => {
    const raw = structuredClone(f.peer.ready) as { scopeId: string; result: { receipt: { entries: { stageRef: { entryId: string }; state: string }[] } } };
    if (kind === "scope") raw.scopeId = "b".repeat(64);
    if (kind === "entry") raw.result.receipt.entries[0]!.stageRef.entryId = "foreign-entry";
    if (kind === "nonready") raw.result.receipt.entries[0]!.state = "unknown";
    queueMicrotask(() => socket.reply(frame.id, raw));
  };
  await expect(f.consumers.reserveOrRead(handle)).rejects.toMatchObject({ handle }); expect(f.backend.bytes.size).toBe(2);
});
it("newer exact-r1 read wins CAS while delayed Ready reserve cannot publish a proof", async () => {
  const f = await setup(); const handle = await f.consumers.prepare(f.rows.map(row => row.id), "thread", "message");
  const held = deferred<() => void>(); f.peer.next = (socket, frame) => held.resolve(() => socket.reply(frame.id, f.peer.ready));
  const first = f.consumers.reserveOrRead(handle); const rejected = expect(first).rejects.toMatchObject({ handle });
  const release = await held.promise;
  const second = new StagedAttachmentConsumers(f.context, f.client, f.store); const proof = await second.reserveOrRead(handle);
  release(); await rejected; expect(f.backend.bytes.size).toBe(2);
  await second.removeConfirmedSources(proof); expect(f.backend.bytes.size).toBe(0);
});
it("persisted/decoded or mutated proof cannot delete; reload needs actual original-r1 read", async () => {
  const f = await setup(); const handle = await f.consumers.prepare(f.rows.map(row => row.id), "thread", "message");
  const proof = await f.consumers.reserveOrRead(handle); const decoded = structuredClone(proof);
  await expect(f.consumers.removeConfirmedSources(decoded)).rejects.toThrow();
  const oldId = proof.handle.reserveId; proof.handle.reserveId = "invalid";
  await expect(f.consumers.removeConfirmedSources(proof)).rejects.toThrow(); proof.handle.reserveId = oldId;
  const restored = new StagedAttachmentConsumers(f.context, f.client, f.store);
  await expect(restored.removeConfirmedSources(proof)).rejects.toThrow(); expect(f.backend.bytes.size).toBe(2);
  await restored.removeConfirmedSources(await restored.reserveOrRead(handle)); expect(f.backend.bytes.size).toBe(0);
});
it("owner changes during held ACK preserve original binding and source bytes", async () => {
  const f = await setup(); const handle = await f.consumers.prepare(f.rows.map(row => row.id), "thread", "message");
  const held = deferred<() => void>(); f.peer.next = (socket, frame) => held.resolve(() => socket.reply(frame.id, f.peer.ready));
  const pending = f.consumers.reserveOrRead(handle); const rejected = expect(pending).rejects.toMatchObject({ handle });
  const release = await held.promise; f.invalidate(); release(); await rejected;
  expect(f.backend.bytes.size).toBe(2); expect(f.backend.snapshot().find(row => row.id === handle.leaderId)?.consumerBatch?.phase).toBe("reserveSent");
});

it("generic capacity is ambiguous and recovers only the original r1 by read", async () => {
  const f = await setup(); const handle = await f.consumers.prepare(f.rows.map(row => row.id), "thread", "message");
  f.peer.next = (socket, frame) => queueMicrotask(() => socket.error(frame.id, -32032));
  await expect(f.consumers.reserveOrRead(handle)).rejects.toMatchObject({ handle });
  expect((await f.store.loadConsumerBatch(f.context, handle)).phase).toBe("reserveSent");
  expect(f.peer.calls[0]!.params).not.toHaveProperty("consumeAcks");
  f.peer.next = (socket, frame) => queueMicrotask(() => socket.reply(frame.id, { scopeId, result: { receipt: null } }));
  await expect(f.consumers.reserveOrRead(handle)).rejects.toMatchObject({ handle });
  const proof = await f.consumers.reserveOrRead(handle);
  expect(f.peer.calls.map(frame => frame.method)).toEqual(["attachment/retention/reserve", "attachment/retention/read", "attachment/retention/read"]);
  expect(f.peer.calls.slice(1).every(frame => (frame.params.selector as { clientRequestId: string }).clientRequestId === handle.reserveId)).toBe(true);
  await f.consumers.removeConfirmedSources(proof); expect(f.backend.bytes.size).toBe(0);
});
it("legacy capacityRejected journal is read-only instead of re-reserved", async () => {
  const f = await setup(); const handle = await f.consumers.prepare(f.rows.map(row => row.id), "thread", "message");
  f.peer.next = (socket, frame) => queueMicrotask(() => socket.error(frame.id, -32032));
  await expect(f.consumers.reserveOrRead(handle)).rejects.toMatchObject({ handle });
  const leader = f.backend.rows.get(handle.leaderId)!;
  leader.consumerBatch!.phase = "capacityRejected"; // persisted static03 record
  const restored = new StagedAttachmentConsumers(f.context, f.client, new StagedAttachmentStore(f.backend));
  const proof = await restored.reserveOrRead(handle);
  expect(proof.handle.reserveId).toBe(handle.reserveId);
  expect(f.peer.calls.map(frame => frame.method)).toEqual(["attachment/retention/reserve", "attachment/retention/read"]);
});
it("dedicated prepaid-slot refusal is durable and limited to its exact batch", async () => {
  const f = await setup(); const handle = await f.consumers.prepare([f.rows[0]!.id], "thread", "message");
  f.peer.next = (socket, frame) => queueMicrotask(() => socket.error(frame.id, RETENTION_ERROR_RESERVE_PREPAID_SLOT_UNAVAILABLE));
  await expect(f.consumers.reserveOrRead(handle)).rejects.toBeInstanceOf(RetainedConsumerPrepaidSlotUnavailable);
  expect((await f.store.loadConsumerBatch(f.context, handle)).phase).toBe("prepaidSlotUnavailable");
  const restored = new StagedAttachmentConsumers(f.context, f.client, new StagedAttachmentStore(f.backend));
  await expect(restored.reserveOrRead(handle)).rejects.toMatchObject({ handle, retryable: false });
  expect(f.peer.calls).toHaveLength(1); expect(f.backend.bytes.size).toBe(2);
  const independent = await restored.prepare([f.rows[1]!.id], "thread", "independent-message");
  const proof = await restored.reserveOrRead(independent);
  expect(proof.handle.reserveId).toBe(independent.reserveId);
  expect(f.peer.calls).toHaveLength(2); expect(f.backend.bytes.size).toBe(2);
});
it("decoded durable Ready journal alone cannot authorize store cleanup after reload", async () => {
  const f = await setup(); const handle = await f.consumers.prepare(f.rows.map(row => row.id), "thread", "message");
  await f.consumers.reserveOrRead(handle);
  const persisted = await f.store.loadConsumerBatch(f.context, handle);
  await expect(f.store.cleanupConfirmedConsumer(f.context, persisted)).rejects.toThrow();
  const reloaded = new StagedAttachmentStore(f.backend);
  await expect(reloaded.cleanupConfirmedConsumer(f.context, persisted)).rejects.toThrow();
  expect(f.backend.bytes.size).toBe(2);
});

// A remote permanent refusal is not durable until its own journal CAS commits.
it("failed permanent-refusal checkpoint reloads Unknown and reads only original r1", async () => {
  const f = await setup();
  const handle = await f.consumers.prepare(f.rows.map(row => row.id), "thread", "message");
  f.peer.next = (socket, frame) => queueMicrotask(() => {
    f.backend.failNext = true;
    socket.error(frame.id, RETENTION_ERROR_RESERVE_PREPAID_SLOT_UNAVAILABLE);
  });
  await expect(f.consumers.reserveOrRead(handle)).rejects.toBeInstanceOf(RetainedConsumerUnknown);
  expect((await f.store.loadConsumerBatch(f.context, handle)).phase).toBe("reserveSent");
  const restored = new StagedAttachmentConsumers(f.context, f.client, new StagedAttachmentStore(f.backend));
  expect(await restored.listUnresolved()).toEqual([handle]);
  f.peer.next = (socket, frame) => queueMicrotask(() => socket.reply(frame.id, { scopeId, result: { receipt: null } }));
  await expect(restored.reserveOrRead(handle)).rejects.toBeInstanceOf(RetainedConsumerUnknown);
  const proof = await restored.reserveOrRead(handle);
  expect(proof.handle).toEqual(handle);
  expect(f.peer.calls.map(frame => frame.method)).toEqual(["attachment/retention/reserve", "attachment/retention/read", "attachment/retention/read"]);
  for (const frame of f.peer.calls.slice(1)) expect(frame.params.selector).toEqual({ by: "clientRequestId", clientRequestId: handle.reserveId });
  expect(f.backend.bytes.size).toBe(2);
});
