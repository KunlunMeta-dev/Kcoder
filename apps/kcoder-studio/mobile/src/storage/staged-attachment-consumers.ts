import { GatewayRpcClient, MobileRpcError } from "@/gateway/rpc";
import { RETENTION_ERROR_RESERVE_PREPAID_SLOT_UNAVAILABLE, normalizedRetentionStageRefs, type RetentionStageRefV1 } from "@/protocol/attachment-retention";
import {
  AttachmentStoreConflict,
  StagedAttachmentStore,
  type AttachmentStoreContext,
  type RetentionConsumerBatch,
  type RetentionConsumerBatchHandle,
} from "./staged-attachment-store";

/** The durable handle survives failed sends, reload and late callbacks. */
export class RetainedConsumerUnknown extends Error {
  constructor(readonly handle: RetentionConsumerBatchHandle) {
    super("附件保留状态尚未核对。原文件、消息和保留 ID 已保存，请继续核对原操作。");
    this.name = "RetainedConsumerUnknown";
  }
}
/** Permanent refusal is limited to this batch's original referenced stages. */
export class RetainedConsumerPrepaidSlotUnavailable extends Error {
  readonly retryable = false;
  constructor(readonly handle: RetentionConsumerBatchHandle) {
    super("这些附件的预付清理额度已不可用；重复保留不会恢复额度。原文件和操作 ID 已保留。");
    this.name = "RetainedConsumerPrepaidSlotUnavailable";
  }
}
export interface RetainedConsumerReady {
  handle: RetentionConsumerBatchHandle;
  retentionId: string;
  expectedRevision: number;
  entryIds: string[];
  stageRefs: RetentionStageRefV1[];
  scopeId: string;
}
function handleOf(batch: RetentionConsumerBatch): RetentionConsumerBatchHandle {
  return { leaderId: batch.leaderId, reserveId: batch.reserveId, threadId: batch.threadId, clientMessageId: batch.clientMessageId };
}

/** Borrows exactly one caller-owned initialized client; never reconnects/replays. */
export class StagedAttachmentConsumers {
  private readonly guardedContext: AttachmentStoreContext;
  // Operation-local proof objects are minted only after an actual scoped RPC ACK.
  // Reload must read the original r1 again, never trust a decoded boolean/handle.
  private readonly verified = new WeakMap<RetainedConsumerReady, { serialized: string; batch: RetentionConsumerBatch }>();
  constructor(
    private readonly context: AttachmentStoreContext,
    private readonly client: GatewayRpcClient,
    private readonly store = new StagedAttachmentStore(),
    private readonly signal?: AbortSignal,
  ) {
    this.guardedContext = { ...context, isCurrent: () => { this.current(); return true; } };
  }
  private current(): void {
    if (this.signal?.aborted || !this.context.isCurrent() || !this.client.matchesRetainedAttachmentOwner(this.context.profile, this.context.server, this.context.workspacePath) || !this.client.getAttachmentUploadAdmission()) throw new AttachmentStoreConflict();
  }
  async prepare(localAttachmentIds: readonly string[], threadId: string, clientMessageId: string): Promise<RetentionConsumerBatchHandle> {
    this.current();
    const rows = await Promise.all(localAttachmentIds.map(id => this.store.load(this.guardedContext, id)));
    this.current();
    if (rows.some(row => !row)) throw new AttachmentStoreConflict();
    // Atomic all-row CAS, including original message and r1, precedes any RPC.
    const batch = await this.store.prepareConsumerBatch(this.guardedContext, rows.map(row => row!), threadId, clientMessageId);
    return handleOf(batch);
  }
  async listUnresolved(): Promise<RetentionConsumerBatchHandle[]> {
    this.current();
    const rows = await this.store.listUnresolved(this.guardedContext);
    this.current();
    // Source-removed rows remain discoverable through this message binding. The
    // byte cleanup marker is not the consumer/terminal outbox completion marker.
    return rows.flatMap(row => row.consumerBatch ? [handleOf(row.consumerBatch)] : []);
  }
  /** Each call performs one reserve OR exact-r1 read, never an automatic retry. */
  async reserveOrRead(handle: RetentionConsumerBatchHandle): Promise<RetainedConsumerReady> {
    let sent: RetentionConsumerBatch | undefined;
    this.current();
    const original = await this.store.loadConsumerBatch(this.guardedContext, handle);
    this.current();
    if (original.phase === "prepaidSlotUnavailable") throw new RetainedConsumerPrepaidSlotUnavailable(handle);
    if (original.admission.rootNamespace !== this.client.getAttachmentUploadAdmission()!.rootNamespace) throw new RetainedConsumerUnknown(handle);
    try {
      const held = await this.store.dispatchConsumerBatch(this.guardedContext, original, (method, params) => {
        this.current();
        return this.client.request<unknown>(method, { ...params }, 30_000);
      });
      sent = held.batch;
      const raw = await held.response;
      this.current();
      const batch = await this.store.observeConsumerBatch(this.guardedContext, held.batch, raw);
      this.current();
      const receipt = batch.observation?.result.receipt;
      if (batch.phase !== "ready" || !receipt) throw new RetainedConsumerUnknown(handle);
      const proof: RetainedConsumerReady = {
        handle: handleOf(batch), retentionId: receipt.retentionId, expectedRevision: receipt.revision,
        entryIds: receipt.entries.map(entry => entry.stageRef.entryId),
        stageRefs: normalizedRetentionStageRefs(receipt.entries.map(entry => entry.stageRef)), scopeId: batch.scopeId,
      };
      this.verified.set(proof, { serialized: JSON.stringify([proof, batch.revision]), batch });
      return proof;
    } catch (error) {
      if (sent?.phase === "reserveSent" && error instanceof MobileRpcError && error.reason === "remote" && error.code === RETENTION_ERROR_RESERVE_PREPAID_SLOT_UNAVAILABLE) {
        // This reserve-only code cannot arise from a piggyback consume. Generic
        // -32032, timeout and lost ACK remain exact-r1 readback, never re-reserve.
        try {
          await this.store.recordConsumerPrepaidSlotUnavailable(this.guardedContext, sent);
        } catch {
          // The refusal is not durable: preserve reserveSent and recover r1 by read.
          throw new RetainedConsumerUnknown(handle);
        }
        throw new RetainedConsumerPrepaidSlotUnavailable(handle);
      }
      // The sent journal remains at its original IDs. Do not clear it, cancel,
      // infer absence as permission, or retry a mutation after an unknown ACK.
      throw new RetainedConsumerUnknown(handle);
    }
  }
  /** Local byte deletion requires the store's exact durable scoped ACK proof. */
  async removeConfirmedSources(proof: RetainedConsumerReady): Promise<void> {
    this.current();
    const handle = proof.handle;
    const batch = await this.store.loadConsumerBatch(this.guardedContext, handle);
    const capability = this.verified.get(proof);
    if (batch.phase !== "ready" || capability?.serialized !== JSON.stringify([proof, batch.revision])) throw new RetainedConsumerUnknown(handle);
    await this.store.cleanupConfirmedConsumer(this.guardedContext, capability.batch);
  }
}
