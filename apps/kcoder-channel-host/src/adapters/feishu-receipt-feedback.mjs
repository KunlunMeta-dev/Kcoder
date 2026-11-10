import { createHash } from 'node:crypto';
import { requireValue, publicError } from '../errors.mjs';

const LIMIT = 256;
/** Connection-owned transport feedback, never task acceptance or model authority. */
export class FeishuReceiptFeedback {
  constructor({ checkpoint, post, current, now = Date.now }) {
    this.checkpoint = checkpoint; this.post = post; this.current = current; this.now = now;
    this.rows = new Map(); this.serial = Promise.resolve(); this.pending = new Set();
  }
  async load() {
    requireValue(this.checkpoint?.load && this.checkpoint?.save, 'FEISHU_FEEDBACK_STORE_UNAVAILABLE');
    const raw = await this.checkpoint.load();
    if (!raw) return;
    const value = JSON.parse(raw);
    requireValue(value?.version === 1 && value.kind === 'feishu-receipt-feedback'
      && Array.isArray(value.rows) && value.rows.length <= LIMIT, 'FEISHU_FEEDBACK_STORE_INVALID');
    for (const row of value.rows) {
      requireValue(/^[a-f0-9]{64}$/.test(row?.key) && ['unknown', 'accepted', 'failed'].includes(row.state)
        && Number.isSafeInteger(row.atMs), 'FEISHU_FEEDBACK_STORE_INVALID');
      this.rows.set(row.key, row);
    }
  }
  persist() {
    const serialize = () => JSON.stringify({version: 1, kind: 'feishu-receipt-feedback', rows: [...this.rows.values()]});
    let cursor = serialize();
    while (Buffer.byteLength(cursor) > 60 * 1024) {
      const oldest = [...this.rows].find(([, row]) => !this.pending.has(row.key));
      requireValue(oldest, 'FEISHU_FEEDBACK_CAPACITY');
      this.rows.delete(oldest[0]); cursor = serialize();
    }
    return this.checkpoint.save(cursor);
  }
  locked(action) {
    const result = this.serial.then(action);
    this.serial = result.catch(() => {});
    return result;
  }
  async receive(event) {
    const key = createHash('sha256').update(JSON.stringify([
      event.platform, event.channelId, event.botId, event.tenantId, event.conversationId,
      event.topicId ?? null, event.sourceMessageId,
    ])).digest('hex');
    const fresh = await this.locked(async () => {
      requireValue(this.current(), 'STALE_PLATFORM_SOURCE');
      if (this.rows.has(key)) return false;
      requireValue(this.pending.size < 16, 'FEISHU_FEEDBACK_CAPACITY');
      while (this.rows.size >= LIMIT) {
        const oldest = [...this.rows].find(([, row]) => !this.pending.has(row.key));
        requireValue(oldest, 'FEISHU_FEEDBACK_CAPACITY');
        this.rows.delete(oldest[0]);
      }
      // Persist an unknown intent before the single POST. A lost result is not retried.
      this.rows.set(key, {key, state: 'unknown', atMs: this.now()});
      await this.persist();
      requireValue(this.current(), 'STALE_PLATFORM_SOURCE');
      this.pending.add(key);
      return true;
    });
    if (!fresh) return false;
    // Start best-effort feedback without waiting for its HTTP result.
    let pending;
    try { pending = this.post(event.sourceMessageId); }
    catch (error) { pending = Promise.reject(error); }
    void Promise.resolve(pending).then(result => this.settle(key, result), error => this.settle(key, {
      state: error?.externalOutcome === 'failed' ? 'failed' : 'unknown', code: publicError(error).code,
    })).catch(() => {}).finally(() => this.pending.delete(key));
    return true;
  }
  settle(key, result) {
    return this.locked(async () => {
      const old = this.rows.get(key);
      if (!old || !this.current()) return;
      const row = {...old, state: result.state === 'accepted' ? 'accepted' : result.state === 'failed' ? 'failed' : 'unknown'};
      if (typeof result.reactionId === 'string' && result.reactionId.length <= 128) row.reactionId = result.reactionId;
      if (typeof result.code === 'string' && /^[A-Z_]{1,80}$/.test(result.code)) row.code = result.code;
      this.rows.set(key, row);
      await this.persist();
    });
  }
}
