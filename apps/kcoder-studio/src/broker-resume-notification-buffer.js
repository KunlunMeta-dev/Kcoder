import { isDeepStrictEqual } from 'node:util';

export const RESUME_NOTIFICATION_HANDOFF_INCOMPLETE_CODE = -32047;

export const RESUME_NOTIFICATION_BUFFER_LIMITS = Object.freeze({
  perPendingFrames: 64,
  perPendingBytes: 256 * 1024,
  globalFrames: 512,
  globalBytes: 2 * 1024 * 1024,
});

export function makeResumeNotificationHandoffIncompleteResponse(id) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: RESUME_NOTIFICATION_HANDOFF_INCOMPLETE_CODE,
      message: "The app-server resumed this thread, but the Gateway could not safely deliver every notification received during handoff. Retry thread/resume to reconcile the thread before continuing.",
      data: {
        gatewayRecoveryV1: {
          kind: "resume_notification_handoff_incomplete",
          upstreamOutcome: "succeeded",
          retryScope: "thread/resume",
        },
      },
    },
  };
}

export class BrokerResumeNotificationBuffer {
  #queues = new Map();
  #globalFrames = 0;
  #globalBytes = 0;

  capture(pending, message) {
    let queue = this.#queues.get(pending);
    if (!queue) {
      queue = { messages: [], bytes: 0, overflowed: false };
      this.#queues.set(pending, queue);
    }
    if (queue.overflowed) return false;

    // Replayed question snapshots and terminal receipts add no state. Keep
    // their first position, but never collapse distinct identities or contents.
    if (['asyncQuestion/changed', 'question/resolved', 'approval/resolved'].includes(message.method) &&
      queue.messages.some(previous => previous.method === message.method &&
        isDeepStrictEqual(previous, message))) return true;

    if (queue.messages.length >= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames ||
        this.#globalFrames >= RESUME_NOTIFICATION_BUFFER_LIMITS.globalFrames) {
      queue.overflowed = true;
      return false;
    }

    const byteBudget = Math.min(
      RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingBytes - queue.bytes,
      RESUME_NOTIFICATION_BUFFER_LIMITS.globalBytes - this.#globalBytes,
    );
    let messageBytes;
    try {
      messageBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
      const item = message.params?.item;
      if (messageBytes > byteBudget && message.method === 'item/completed' &&
          (item?.name === 'mcp__kcoder_computer_use__Screenshot' ||
           item?.name === 'mcp__kcoder_computer_use__Snapshot') &&
          Array.isArray(item.outputImages) && item.outputImages.length > 0) {
        // Keep the ordered receipt; the image remains available in history.
        const compactItem = { ...item, outputImages: [], outputImagesOmitted: true };
        message = { ...message, params: { ...message.params, item: compactItem } };
        messageBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
        if (messageBytes > byteBudget && typeof compactItem.output === 'string') {
          compactItem.output = null;
          compactItem.outputTruncated = true;
          messageBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
        }
      }
    } catch {
      queue.overflowed = true;
      return false;
    }
    if (messageBytes > byteBudget) {
      queue.overflowed = true;
      return false;
    }

    queue.messages.push(message);
    queue.bytes += messageBytes;
    this.#globalFrames += 1;
    this.#globalBytes += messageBytes;
    return true;
  }

  isOverflowed(pending) {
    return this.#queues.get(pending)?.overflowed === true;
  }

  take(pending) {
    const queue = this.#queues.get(pending);
    if (!queue) return { messages: [], overflowed: false };
    this.#queues.delete(pending);
    this.#release(queue);
    return { messages: queue.messages, overflowed: queue.overflowed };
  }

  discard(pending) {
    const queue = this.#queues.get(pending);
    if (!queue) return false;
    this.#queues.delete(pending);
    this.#release(queue);
    return true;
  }

  clear() {
    this.#queues.clear();
    this.#globalFrames = 0;
    this.#globalBytes = 0;
  }

  #release(queue) {
    this.#globalFrames -= queue.messages.length;
    this.#globalBytes -= queue.bytes;
  }
}
