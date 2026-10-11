import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../protocol/fixtures/retention-upload-v1-contract.json";
import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
import { GatewayRpcClient, type RpcMessage } from "@/gateway/rpc";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { RETENTION_CAPABILITY, parseRetentionAdmission, parseRetentionStageRef, retentionGenerationId } from "@/protocol/attachment-retention";
import { StagedAttachmentStore, type StagedAttachmentRecord } from "@/storage/staged-attachment-store";
import type { AttachmentBytesBackend, AttachmentStoreChange, DurableByteSource } from "@/storage/staged-attachment-bytes";
import { RetainedAttachmentUploader } from "@/storage/retained-attachment-upload";

type Row = StagedAttachmentRecord;
type Remote = { ownerId: string; uploadId: string; filename: string; size: number; sha256: string; scopeId: string; state: "uploading" | "sealed" | "cancelled"; confirmed: number; stageRef?: { rootNamespace: string; epoch: number; ownerId: string; entryId: string; revision: number; path?: string } };

class MemoryAttachmentBackend implements AttachmentBytesBackend {
  readonly kind = "web" as const;
  private readonly rows = new Map<string, Row>();
  private readonly blobs = new Map<string, Blob>();
  private readonly readers = new Map<string, DurableByteSource>();
  private tail: Promise<void> = Promise.resolve();
  readonly sourceReadLengths: number[] = [];
  async transaction<T>(change: (rows: readonly unknown[]) => AttachmentStoreChange<T>): Promise<T> {
    const before = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await before;
    try {
      const update = change([...this.rows.values()].map(row => structuredClone(row)));
      if (update.deleteRow) this.rows.delete(update.deleteRow);
      if (update.putRow) this.rows.set(update.putRow.id, structuredClone(update.putRow.value) as Row);
      if (update.deleteBytes) this.blobs.delete(update.deleteBytes);
      if (update.putBytes) this.blobs.set(update.putBytes.id, update.putBytes.blob);
      return update.value;
    } finally { release(); }
  }
  async source(id: string, expectedSize: number) {
    const blob = this.blobs.get(id);
    const generated = this.readers.get(id);
    if ((!blob && !generated) || (blob && blob.size !== expectedSize) || (generated && generated.size !== expectedSize)) throw new Error("fixture source missing or wrong length");
    const backend = this;
    return { size: expectedSize, async read(offset: number, length: number) {
      backend.sourceReadLengths.push(length);
      return blob ? new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()) : generated!.read(offset, length);
    } };
  }
  inspectRows(): Row[] { return [...this.rows.values()].map(row => structuredClone(row)); }
  inspectBlob(id: string): Blob | undefined { return this.blobs.get(id); }
  inspectByUploadId(id: string): Row | undefined { return this.inspectRows().find(row => row.clientUploadId === id); }
  seedPrepared(row: Row, source: DurableByteSource): void { this.rows.set(row.id, structuredClone(row)); this.readers.set(row.id, source); }
}

type Frame = RpcMessage & { id: number; method: string; params: Record<string, any> };
type Summary = { method: string; id: number; ownerId?: string; uploadId?: string; offset?: number; length?: number; chunkSha256?: string; intentVisibleAtSend?: boolean };
class ControlledPeer {
  readonly requests: Summary[] = [];
  readonly remote = new Map<string, Remote>();
  dropMethod: string | undefined;
  holdMethod: string | undefined;
  private held: (() => void) | undefined;
  private heldResolve: (() => void) | undefined;
  private heldReady = false;
  private readonly backend: MemoryAttachmentBackend;
  constructor(backend: MemoryAttachmentBackend) { this.backend = backend; }
  waitFor(method: string, ordinal = 1): Promise<Summary> {
    const found = this.requests.filter(request => request.method === method)[ordinal - 1];
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const poll = () => {
        const item = this.requests.filter(request => request.method === method)[ordinal - 1];
        if (item) resolve(item);
        else if (Date.now() < deadline) setTimeout(poll, 1);
        else reject(new Error(`controlled peer did not observe ${method}`));
      };
      poll();
    });
  }
  waitForHeld(): Promise<void> {
    if (this.heldReady) return Promise.resolve();
    return new Promise(resolve => { this.heldResolve = resolve; });
  }
  releaseHeld(): void { const release = this.held; this.held = undefined; this.heldReady = false; release?.(); }
  onSend(socket: ControlledSocket, frame: Frame): void {
    const method = frame.method;
    const params = frame.params ?? {};
    if (method === "initialize") {
      queueMicrotask(() => socket.reply(frame.id, {
        protocolVersion: "2026-07-27",
        capabilities: { experimental: { [RETENTION_CAPABILITY]: true } },
        attachmentUploadAdmission: fixture.admission,
      }));
      return;
    }
    if (!method.startsWith("attachment/retention/upload/")) return;
    const ownerId = params.ownerRequest?.clientOwnerRequestId as string | undefined;
    const uploadId = params.clientUploadId as string | undefined;
    const key = `${ownerId}\n${uploadId}`;
    const local = uploadId ? this.backend.inspectByUploadId(uploadId) : undefined;
    const summary: Summary = {
      method, id: frame.id, ownerId, uploadId,
      ...(typeof params.offset === "number" ? { offset: params.offset } : {}),
      ...(typeof params.length === "number" ? { length: params.length } : {}),
      ...(typeof params.chunkSha256 === "string" ? { chunkSha256: params.chunkSha256 } : {}),
      intentVisibleAtSend: !!local && local.wire?.method === method && local.wire.revision === local.revision,
    };
    this.requests.push(summary);
    let remote = this.remote.get(key);
    const mode = method.slice("attachment/retention/upload/".length);
    if (mode === "start" || mode === "save") {
      remote ??= {
        ownerId: ownerId!, uploadId: uploadId!, filename: params.filename,
        size: params.size, sha256: params.contentSha256,
        scopeId: fixture.scopeId, state: "uploading", confirmed: 0,
      };
      this.remote.set(key, remote);
    } else if (mode === "read") {
      // Lookup does not allocate. A truly absent key remains absent.
    } else if (mode === "chunk") {
      if (!remote || remote.state !== "uploading" || params.offset !== remote.confirmed) throw new Error("non-contiguous or unauthorized chunk");
      const decoded = Buffer.from(params.contentBase64, "base64");
      if (decoded.byteLength !== params.length || createHash("sha256").update(decoded).digest("hex") !== params.chunkSha256) throw new Error("chunk body does not match its declared length/hash");
      remote.confirmed += decoded.byteLength;
    } else if (mode === "finish") {
      if (!remote || remote.confirmed !== remote.size) throw new Error("finish before all bytes were confirmed");
      remote.state = "sealed";
      remote.stageRef = parseRetentionStageRef({ rootNamespace: admission.rootNamespace, epoch: admission.admissionEpoch, ownerId: "fixture-owner", entryId: `entry-${uploadId}`, revision: 1, path: `/fixture/${uploadId}` });
    } else if (mode === "cancel") {
      if (!remote) throw new Error("cannot cancel unknown upload");
      remote.state = "cancelled";
    }
    if (this.dropMethod === method) { this.dropMethod = undefined; return; }
    const answer = () => socket.reply(frame.id, this.response(remote));
    if (this.holdMethod === method) {
      this.holdMethod = undefined; this.held = answer; this.heldReady = true; this.heldResolve?.(); this.heldResolve = undefined; return;
    }
    queueMicrotask(answer);
  }
  private response(remote: Remote | undefined): unknown {
    if (!remote) return {
      clientOwnerRequestId: "o1.fixture_root.7.00000000000000000000000000000001",
      clientUploadId: "u1.fixture_root.7.00000000000000000000000000000002",
      scopeId: fixture.scopeId,
      lookup: { outcome: "absent" },
    };
    return {
      clientOwnerRequestId: remote.ownerId, clientUploadId: remote.uploadId, scopeId: remote.scopeId,
      lookup: { outcome: "present", filename: remote.filename, size: remote.size, contentSha256: remote.sha256,
        recovery: { rootNamespace: "fixture_root", epoch: 7, state: remote.state, confirmedBytes: remote.confirmed, ...(remote.stageRef ? { stageRef: remote.stageRef } : {}) } },
    };
  }
}

class ControlledSocket {
  static OPEN = 1;
  static peer: ControlledPeer;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(_url: string, _protocols?: string | string[] | null, _options?: unknown) { queueMicrotask(() => this.onopen?.()); }
  send(raw: string): void {
    const frame = JSON.parse(raw) as Frame;
    if (frame.method === "initialized") return;
    try { ControlledSocket.peer.onSend(this, frame); }
    catch { queueMicrotask(() => this.reply(frame.id, undefined, { code: -32000, message: "controlled-peer-invalid-frame" })); }
  }
  reply(id: number, result?: unknown, error?: { code: number; message: string }): void {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) }) });
  }
  close(): void { if (this.readyState === 3) return; this.readyState = 3; queueMicrotask(() => this.onclose?.()); }
}

const originalWebSocket = globalThis.WebSocket;
const profileBase: GatewayProfile = {
  id: "private-b4-profile", label: "fixture", baseUrl: "https://gateway.invalid", accessToken: "synthetic-access-token",
  expiresAt: 9_999_999_999_999, rpcToken: "synthetic-rpc-token", authorizationGeneration: "auth-generation-a", deviceId: "device-a",
};
const server: KCoderServer = { id: "private-b4-target", label: "fixture", description: "fixture", runtime: "kcoder", transport: "local" };
const admission = parseRetentionAdmission(fixture.admission);

function sourceOf(bytes: Uint8Array): DurableByteSource {
  const blobBytes = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(blobBytes).set(bytes);
  const blob = new Blob([blobBytes]);
  return { size: blob.size, blob, async read(offset, length) { return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()); } };
}
function ownerContext(profile = profileBase, isCurrent: () => boolean = () => true) {
  return { profile, server, workspacePath: "/fixture/workspace", isCurrent };
}
async function connect(peer: ControlledPeer, profile = profileBase): Promise<GatewayRpcClient> {
  ControlledSocket.peer = peer;
  vi.stubGlobal("WebSocket", ControlledSocket as unknown as typeof WebSocket);
  return GatewayRpcClient.connect(profile, server, "/fixture/workspace");
}
function retentionRequests(peer: ControlledPeer): Summary[] {
  return peer.requests.filter(request => request.method.startsWith("attachment/retention/upload/"));
}
function bytes(length: number): Uint8Array { return Uint8Array.from({ length }, (_, index) => index * 17 + 3 & 0xff); }
function deterministicSource(size: number): DurableByteSource {
  return { size, async read(offset, length) {
    const output = new Uint8Array(length);
    for (let index = 0; index < length; index++) output[index] = (offset + index) * 17 + 3 & 0xff;
    return output;
  } };
}
function digestGenerated(size: number): string {
  const digest = createHash("sha256");
  for (let offset = 0; offset < size; offset += 64 * 1024) {
    const length = Math.min(64 * 1024, size - offset); const part = new Uint8Array(length);
    for (let index = 0; index < length; index++) part[index] = (offset + index) * 17 + 3 & 0xff;
    digest.update(part);
  }
  return digest.digest("hex");
}
function seededPreparedRow(size: number, contentSha256: string): Row {
  const id = "a".repeat(32); const localProfile = profileBase;
  const targetKey = JSON.stringify([server.id, server.runtime, server.transport,
    [server.workspacePath === undefined ? "absent" : "value", server.workspacePath ?? ""],
    server.host, server.user, server.port, server.command, server.profile, server.settingsFile,
    server.accountIdentity?.principalId, server.accountIdentity?.username, server.accountIdentity?.role,
    server.chromiumBin, server.chromiumNoSandbox, server.acceptNewHostKey]);
  const scope = {
    profile: { id: localProfile.id, baseUrl: localProfile.baseUrl, authorizationGeneration: localProfile.authorizationGeneration!, deviceId: localProfile.deviceId },
    target: JSON.stringify([targetKey, ["value", "/fixture/workspace"], "runtime"]),
  };
  const ownerRequest = { clientOwnerRequestId: retentionGenerationId("o1", admission, "c".repeat(32)), immutableParameters: { purpose: "mobile-attachment", localAttachmentId: id } };
  return {
    version: 1, id, revision: 1, scope, admission, ownerRequest,
    clientUploadId: retentionGenerationId("u1", admission, "d".repeat(32)), filename: "fifty-megabyte.bin", size,
    contentSha256, phase: "prepared", confirmedBytes: 0, consumers: [], cleanup: "none",
  };
}

beforeEach(() => installBrowserProfileFixture([profileBase]));
afterEach(() => { globalThis.WebSocket = originalWebSocket; vi.unstubAllGlobals(); });

describe("Retained uploader over controlled WebSocket", () => {
  it("prepares without a Gateway and atomically admits only one of two attempts at the 128-row cap", async () => {
    const backend = new MemoryAttachmentBackend(); const store = new StagedAttachmentStore(backend); const context = ownerContext();
    const existing: string[] = [];
    for (let index = 0; index < 127; index++) {
      const row = await store.prepare(context, admission, `seed-${index}.bin`, sourceOf(Uint8Array.of(index & 0xff)));
      existing.push(row.id);
    }
    expect(backend.inspectRows()).toHaveLength(127);
    expect(existing.every(id => backend.inspectBlob(id)?.size === 1)).toBe(true);
    const attempts = await Promise.allSettled([
      store.prepare(context, admission, "race-a.bin", sourceOf(Uint8Array.of(0xa1))),
      store.prepare(context, admission, "race-b.bin", sourceOf(Uint8Array.of(0xb2))),
    ]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(backend.inspectRows()).toHaveLength(128);
    expect(backend.inspectRows().every(row => !!backend.inspectBlob(row.id))).toBe(true);
    expect(backend.inspectRows().filter(row => row.filename === "race-a.bin" || row.filename === "race-b.bin")).toHaveLength(1);
  });

  it("rejects a stale revision instead of overwriting the winning row", async () => {
    const backend = new MemoryAttachmentBackend(); const store = new StagedAttachmentStore(backend); const context = ownerContext();
    const prepared = await store.prepare(context, admission, "cas.bin", sourceOf(Uint8Array.of(1, 2, 3)));
    const left = await store.load(context, prepared.id); const right = await store.load(context, prepared.id);
    expect(left?.revision).toBe(1); expect(right?.revision).toBe(1);
    const updates = await Promise.allSettled([
      store.update(context, left!, row => row),
      store.update(context, right!, row => row),
    ]);
    expect(updates.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(updates.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await store.load(context, prepared.id))?.revision).toBe(2);
    expect(backend.inspectBlob(prepared.id)?.size).toBe(3);
  });

  it("commits local row/Blob before zero retained RPC, resumes a lost chunk ACK by original IDs, and sends exact 512 KiB + 1 bytes", async () => {
    const backend = new MemoryAttachmentBackend(); const store = new StagedAttachmentStore(backend); const peer = new ControlledPeer(backend);
    const clientA = await connect(peer); const uploaderA = new RetainedAttachmentUploader(ownerContext(), clientA, store);
    const payload = bytes(512 * 1024 + 1); const prepared = await uploaderA.prepare("controlled.bin", sourceOf(payload));
    expect(prepared.phase).toBe("prepared");
    expect(backend.inspectBlob(prepared.id)?.size).toBe(payload.length);
    expect(retentionRequests(peer)).toHaveLength(0);

    peer.dropMethod = "attachment/retention/upload/chunk";
    const firstAttempt = uploaderA.resume(prepared.id).then(value => ({ value }), error => ({ error }));
    await peer.waitFor("attachment/retention/upload/chunk");
    const sentChunk = retentionRequests(peer).find(request => request.method.endsWith("/chunk"))!;
    expect(sentChunk).toMatchObject({ offset: 0, length: 512 * 1024, intentVisibleAtSend: true });
    expect(backend.inspectRows().find(row => row.id === prepared.id)?.wire?.method).toBe("attachment/retention/upload/chunk");
    clientA.close();
    const firstOutcome = await firstAttempt;
    expect("error" in firstOutcome && firstOutcome.error).toBeTruthy();

    const beforeReconnect = retentionRequests(peer).length;
    const clientB = await connect(peer); const uploaderB = new RetainedAttachmentUploader(ownerContext(), clientB, store);
    const handle = await uploaderB.resume(prepared.id);
    const resumed = retentionRequests(peer).slice(beforeReconnect);
    expect(resumed[0]?.method).toBe("attachment/retention/upload/read");
    expect(resumed.filter(request => request.method.endsWith("/start"))).toHaveLength(0);
    const chunks = retentionRequests(peer).filter(request => request.method.endsWith("/chunk"));
    expect(chunks.map(({ offset, length }) => [offset, length])).toEqual([[0, 512 * 1024], [512 * 1024, 1]]);
    expect(chunks.every(request => request.intentVisibleAtSend)).toBe(true);
    expect(chunks.map(request => request.uploadId)).toEqual([prepared.clientUploadId, prepared.clientUploadId]);
    expect(chunks.map(request => request.ownerId)).toEqual([prepared.ownerRequest.clientOwnerRequestId, prepared.ownerRequest.clientOwnerRequestId]);
    expect(Math.max(...backend.sourceReadLengths)).toBeLessThanOrEqual(64 * 1024);
    expect(handle).toMatchObject({ kind: "retained", localAttachmentId: prepared.id, size: payload.length, stageRef: { epoch: 7, rootNamespace: admission.rootNamespace } });
    const expectedSha = createHash("sha256").update(payload).digest("hex");
    expect(backend.inspectRows().find(row => row.id === prepared.id)?.contentSha256).toBe(expectedSha);
    expect(peer.remote.get(`${prepared.ownerRequest.clientOwnerRequestId}\n${prepared.clientUploadId}`)?.sha256).toBe(expectedSha);
    expect(backend.inspectRows().find(row => row.id === prepared.id)).toMatchObject({ phase: "sealed", confirmedBytes: payload.length });
    clientB.close();
  });

  it.each([
    ["start", 256 * 1024 + 1],
    ["finish", 256 * 1024 + 1],
  ] as const)("reads back the same IDs after a lost %s ACK", async (lostPhase, size) => {
    const backend = new MemoryAttachmentBackend(); const store = new StagedAttachmentStore(backend); const peer = new ControlledPeer(backend);
    const clientA = await connect(peer); const uploaderA = new RetainedAttachmentUploader(ownerContext(), clientA, store);
    const prepared = await uploaderA.prepare(`lost-${lostPhase}.bin`, sourceOf(bytes(size)));
    peer.dropMethod = `attachment/retention/upload/${lostPhase}`;
    const attempt = uploaderA.resume(prepared.id).then(value => ({ value }), error => ({ error }));
    await peer.waitFor(`attachment/retention/upload/${lostPhase}`);
    clientA.close();
    const lostAckOutcome = await attempt;
    expect("error" in lostAckOutcome && lostAckOutcome.error).toBeTruthy();
    const before = retentionRequests(peer).length;
    const clientB = await connect(peer); const uploaderB = new RetainedAttachmentUploader(ownerContext(), clientB, store);
    const result = await uploaderB.resume(prepared.id);
    const retry = retentionRequests(peer).slice(before);
    expect(retry[0]?.method).toBe("attachment/retention/upload/read");
    expect(retry.every(request => request.uploadId === prepared.clientUploadId && request.ownerId === prepared.ownerRequest.clientOwnerRequestId)).toBe(true);
    expect(result.localAttachmentId).toBe(prepared.id);
    expect(retentionRequests(peer).filter(request => request.method.endsWith(`/${lostPhase}`))).toHaveLength(1);
    clientB.close();
  });

  it("does not apply an accepted response or expose the old row after the captured scope changes", async () => {
    const backend = new MemoryAttachmentBackend(); const store = new StagedAttachmentStore(backend); const peer = new ControlledPeer(backend);
    let current = true; const context = ownerContext(profileBase, () => current);
    const clientA = await connect(peer); const uploaderA = new RetainedAttachmentUploader(context, clientA, store);
    const prepared = await uploaderA.prepare("held.bin", sourceOf(bytes(300_000)));
    peer.holdMethod = "attachment/retention/upload/start";
    const attempt = uploaderA.resume(prepared.id).then(value => ({ value }), error => ({ error }));
    await peer.waitForHeld();
    current = false;
    peer.releaseHeld();
    const staleOutcome = await attempt;
    expect("error" in staleOutcome && staleOutcome.error).toBeTruthy();
    const retained = backend.inspectRows().find(row => row.id === prepared.id)!;
    expect(retained).toMatchObject({ phase: "prepared", wire: { method: "attachment/retention/upload/start" }, confirmedBytes: 0 });
    const profileB = { ...profileBase, authorizationGeneration: "auth-generation-b", deviceId: "device-b" };
    installBrowserProfileFixture([profileB]);
    const clientB = await connect(peer, profileB); const uploaderB = new RetainedAttachmentUploader(ownerContext(profileB), clientB, store);
    expect(await uploaderB.listUnresolved()).toEqual([]);
    expect(retentionRequests(peer).filter(request => request.method.endsWith("/chunk") || request.method.endsWith("/finish"))).toHaveLength(0);
    clientA.close(); clientB.close();
  });

  it("sends an exact 50 MiB source as 100 contiguous 512 KiB chunks", async () => {
    const size = 50 * 1024 * 1024;
    const expectedSha = digestGenerated(size);
    const backend = new MemoryAttachmentBackend(); const store = new StagedAttachmentStore(backend); const peer = new ControlledPeer(backend);
    const row = seededPreparedRow(size, expectedSha);
    backend.seedPrepared(row, deterministicSource(size));
    const client = await connect(peer); const uploader = new RetainedAttachmentUploader(ownerContext(), client, store);
    const handle = await uploader.resume(row.id);
    const chunks = retentionRequests(peer).filter(request => request.method.endsWith("/chunk"));
    expect(chunks).toHaveLength(100);
    expect(chunks.every((request, index) => request.offset === index * 512 * 1024 && request.length === 512 * 1024 && request.intentVisibleAtSend)).toBe(true);
    expect(chunks.reduce((sum, request) => sum + (request.length ?? 0), 0)).toBe(size);
    expect(retentionRequests(peer).map(request => request.method.replace("attachment/retention/upload/", ""))).toEqual(["start", ...Array(100).fill("chunk"), "finish"]);
    expect(peer.remote.get(`${row.ownerRequest.clientOwnerRequestId}\n${row.clientUploadId}`)).toMatchObject({ confirmed: size, sha256: expectedSha, state: "sealed" });
    expect(handle).toMatchObject({ localAttachmentId: row.id, size });
    expect(Math.max(...backend.sourceReadLengths)).toBeLessThanOrEqual(64 * 1024);
    client.close();
  }, 180_000);
});
