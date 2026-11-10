import { THREAD_RUNTIME_HANDOFF_RELEASE } from '../shared/threadRuntimeHandoff.mjs';
import { ASYNC_ANSWER_FINGERPRINT, asyncAnswerFingerprint } from './broker-async-question-answer.js';
import { gatewayRequestTimeoutMs } from '../shared/gatewayRequestDeadline.js';
// Admission bounds include expired unanswered work. Expiration releases payload
// bytes, never a slot: a late response must still have an owner/cleanup receipt.
export class BrokerRequestBudget {
  constructor({ total = 512, perOwner = 128, bytes = 16 * 1024 * 1024,
    ownerBytes = 4 * 1024 * 1024, ttlMs = null } = {}, expire) {
    const positive = (value, fallback) => Number.isSafeInteger(value) && value > 0 ? value : fallback;
    this.limits = { total: positive(total, 512), perOwner: positive(perOwner, 128),
      bytes: positive(bytes, 16 * 1024 * 1024), ownerBytes: positive(ownerBytes, 4 * 1024 * 1024),
      ttlMs: ttlMs === null ? null : positive(ttlMs, 30_000) };
    this.records = new Map(); this.owners = new WeakMap(); this.expire = expire;
  }
  admit(id, client, message, internal = false, ownerLimit = internal ? this.limits.total : this.limits.perOwner) {
    const owner = this.owners.get(client) ?? Symbol('request owner'); this.owners.set(client, owner);
    const bytes = Buffer.byteLength(JSON.stringify(message));
    let count = 0, ownerBytes = 0, totalBytes = 0;
    for (const entry of this.records.values()) { totalBytes += entry.bytes; if (entry.owner === owner) { count++; ownerBytes += entry.bytes; } }
    if (this.records.size >= this.limits.total || count >= ownerLimit ||
        totalBytes + bytes > this.limits.bytes || ownerBytes + bytes > this.limits.ownerBytes) return false;
    const timer = setTimeout(() => { const entry = this.records.get(id); if (!entry) return; entry.bytes = 0; entry.expired = true; this.expire(id); }, this.limits.ttlMs ?? gatewayRequestTimeoutMs(message.method));
    timer.unref();
    this.records.set(id, { owner, bytes, channel: client.channel, timer, expired: false, work: !["server/resources/read", "server/shutdown/idle"].includes(message.method) });
    return true;
  }
  settle(id) { const entry = this.records.get(id); if (!entry) return null; clearTimeout(entry.timer); this.records.delete(id); return entry; }
  compact(id, bytes = 0) { const entry = this.records.get(id); if (entry) { clearTimeout(entry.timer); entry.bytes = bytes; entry.expired = true; } }
  clear() { for (const id of this.records.keys()) this.settle(id); }
  snapshot() { let retainedBytes = 0, expired = 0; for (const entry of this.records.values()) { retainedBytes += entry.bytes; if (entry.expired) expired++; } return { admitted: this.records.size, retainedBytes, expired }; }
}

export function compactRequestParams(params, method) {
  const compact = {};
  for (const key of ['threadId', 'thread_id', 'ownerThreadId', 'session_id', 'terminalId', 'upload_id', 'path', 'flowId', 'clientRequestId', 'questionId', 'submissionId']) {
    if (typeof params?.[key] === 'string' && params[key].length <= 32768) compact[key] = params[key];
  }
  if (method === THREAD_RUNTIME_HANDOFF_RELEASE) {
    // A late release receipt still needs the original operation/owner binding.
    for (const key of ['operationId', 'expectedServerId', 'expectedOwnerRef']) {
      if (typeof params?.[key] === 'string' && params[key].length <= 256) compact[key] = params[key];
    }
  }
  // Keep the broker's original routing precedence across timeout and detach.
  // Nested compatibility fields must never replace an explicit task identity.
  if (typeof params?.threadId !== 'string' && typeof params?.thread_id !== 'string') {
    const threadId = typeof params?.thread?.threadId === 'string' ? params.thread.threadId : params?.thread?.id;
    if (typeof threadId === 'string' && threadId.length <= 32768) compact.threadId = threadId;
  }
  if (typeof compact.questionId === 'string' && typeof compact.submissionId === 'string') {
    const fingerprint = params?.[ASYNC_ANSWER_FINGERPRINT] ?? asyncAnswerFingerprint(params?.answers);
    if (fingerprint !== null) compact[ASYNC_ANSWER_FINGERPRINT] = fingerprint;
  }
  return compact;
}
