import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { asyncQuestionLocator, asyncQuestionReplayIdentity } from './broker-async-question-answer.js';
import { isTurnLifecycleMethod } from './broker-shared-interactions.js';

export const RESUME_NOTIFICATION_HANDOFF_INCOMPLETE_CODE = -32047;

export const RESUME_NOTIFICATION_BUFFER_LIMITS = Object.freeze({
  perPendingFrames: 64,
  perPendingBytes: 256 * 1024,
  globalFrames: 512,
  globalBytes: 2 * 1024 * 1024,
});

function replayIdentity(message, sessionId) {
  const { jsonrpc = '2.0', params } = message;
  if (!isTurnLifecycleMethod(message.method)) return { ...message, jsonrpc };

  // Compare equivalent lifecycle wire forms without rewriting the delivered frame.
  const normalized = { ...params, sequence: params.sequence === 0 ? 0 : params.sequence };
  // A legacy start without a producer ID belongs to the initialized upstream.
  // Preserve its original wire frame and only normalize the comparison.
  if (message.method === 'turn/started' && sessionId && normalized.serverId === undefined)
    normalized.serverId = `server-${sessionId}`;
  // Rust deserializes both null and omission as None for these fields.
  if (message.method === 'turn/started' && normalized.attemptId === null) delete normalized.attemptId;
  const turn = params.turn;
  if (turn?.attemptId === null || turn?.memorySnapshotId === null) {
    normalized.turn = { ...turn };
    if (turn.attemptId === null) delete normalized.turn.attemptId;
    if (turn.memorySnapshotId === null) delete normalized.turn.memorySnapshotId;
  }
  return { ...message, jsonrpc, params: normalized };
}

function withQuestionProducer(message, defaultServerId) {
  if (defaultServerId === undefined || message.params.serverId !== undefined) return message;
  return { ...message, params: { ...message.params, serverId: defaultServerId } };
}

function compactQuestion(message) {
  const question = message.params.question;
  return { ...message, params: { ...message.params,
    question: { ...asyncQuestionLocator(question), revision: question.revision } } };
}

function isHintForQuestionEvent(hint, snapshot, defaultServerId, sequence = snapshot.params.sequence) {
  const { serverId, question } = snapshot.params;
  const locator = hint.params.question;
  // An old hint may omit source fields. Only an exact transport event may
  // supply those missing fields. Explicit source fields must still match.
  return Number.isSafeInteger(sequence) && hint.params.sequence === sequence &&
    (hint.params.serverId ?? defaultServerId) === (serverId ?? defaultServerId) && locator.threadId === question.threadId &&
    locator.questionId === question.questionId &&
    ['requestId', 'sourceTurnId', 'toolCallId'].every(field =>
      locator[field] === undefined || locator[field] === question[field]);
}

function sameQuestionRevision(first, second, defaultServerId) {
  const { serverId, question } = first.params;
  // Source locators can themselves conflict within one durable revision.
  return second.method === first.method && (second.params.serverId ?? defaultServerId) === (serverId ?? defaultServerId) &&
    second.params.question.threadId === question.threadId &&
    second.params.question.questionId === question.questionId &&
    second.params.question.revision === question.revision;
}

function questionRevisionKey(message, defaultServerId) {
  const { serverId, question } = message.params;
  return snapshotDigest([serverId ?? defaultServerId, question.threadId, question.questionId, question.revision]);
}

function hasSameRevisionSnapshot(entries, full, defaultServerId) {
  return entries.some(({ message }) => message !== full &&
    sameQuestionRevision(full, message, defaultServerId) && message.params.question.questions !== undefined);
}

function snapshotDigest(identity) {
  // Match replay equality without keeping compacted question or answer text.
  const canonical = JSON.stringify(identity, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
      : value);
  return createHash('sha256').update(canonical).digest('hex');
}

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
  #sessionId;

  constructor(getSessionId = () => undefined) {
    this.#sessionId = getSessionId;
  }

  capture(pending, message, compactedDigest, correctedHintIndex = -1) {
    let queue = this.#queues.get(pending);
    if (!queue) {
      queue = { entries: [], bytes: 0, overflowed: false };
      this.#queues.set(pending, queue);
    }
    if (queue.overflowed) return false;

    // Replayed snapshots and receipts add no state. Turn IDs can span retry
    // attempts, so only sequenced turn lifecycle events have a replay identity.
    const replayable = ['question/resolved', 'approval/resolved'].includes(message.method) ||
      (isTurnLifecycleMethod(message.method) &&
        Number.isSafeInteger(message.params?.sequence) && message.params.sequence >= 0);
    // Normalize a frame once, instead of rebuilding every retained answer map
    // for each incoming replay. This metadata lives only as long as the queue.
    const sessionId = this.#sessionId();
    const defaultServerId = sessionId ? `server-${sessionId}` : undefined;
    const questionUpdate = message.method === 'asyncQuestion/changed';
    // Compare producer aliases without altering the retained wire frame.
    const questionIdentity = (frame, asHint) =>
      asyncQuestionReplayIdentity(withQuestionProducer(frame, defaultServerId), asHint);
    const identity = questionUpdate ? questionIdentity(message)
      : replayable ? replayIdentity(message, sessionId) : undefined;
    const fullQuestion = questionUpdate &&
      message.params.question.questions !== undefined;
    const hintIdentity = fullQuestion && Number.isSafeInteger(message.params.sequence)
      ? questionIdentity(message, true) : undefined;
    if (message.method === 'asyncQuestion/changed' && !fullQuestion && !compactedDigest) {
      const replay = queue.questionReplayLocators?.get(message.params.sequence);
      if (replay && isHintForQuestionEvent(message, replay, defaultServerId)) return true;
    }
    let hintIndex = -1;
    let compactedReplay;
    let reclaimedReplay = false;
    if (fullQuestion) {
      compactedReplay = queue.entries.find(entry => entry.compactedDigest &&
        sameQuestionRevision(message, entry.message, defaultServerId));
      const digest = compactedReplay?.compactedDigest ??
        queue.replacedDigests?.get(questionRevisionKey(message, defaultServerId));
      if (digest && snapshotDigest(identity) !== digest) {
        queue.overflowed = true;
        return false;
      }
      if (hintIdentity !== undefined) {
        // Partial locators for one event can differ by which fields they omit.
        // Keep the earliest position for correction and release every later hint.
        const matches = [];
        for (const [index, entry] of queue.entries.entries()) {
          if (entry.message.method === message.method && !entry.compactedDigest &&
              entry.message.params.question.questions === undefined &&
              isHintForQuestionEvent(entry.message, message, defaultServerId)) matches.push(index);
        }
        hintIndex = matches[0] ?? -1;
        for (let index = matches.length - 1; index > 0; index--)
          this.#removeEntry(queue, matches[index]);
      }
      // A reclaimed snapshot's digest detects conflicts but cannot deliver
      // the question. Correct its same-sequence hint in place if one remains.
      reclaimedReplay = Boolean(digest && !compactedReplay && hintIndex === -1);
    }
    let replacedIndex = correctedHintIndex;
    if (!compactedReplay && !reclaimedReplay && identity !== undefined && correctedHintIndex === -1) {
      replacedIndex = queue.entries.findIndex(previous => {
        if (previous.message.method !== message.method || !isDeepStrictEqual(previous.identity, identity))
          return false;
        // A newer sparse hint cannot replace evidence of an older complete snapshot.
        return !(previous.compactedDigest && !compactedDigest &&
          message.params.question.revision > previous.message.params.question.revision &&
          (!Number.isSafeInteger(message.params.sequence) ||
           message.params.sequence !== previous.compactedSequence));
      });
      if (replacedIndex !== -1 && !fullQuestion) {
        const entry = queue.entries[replacedIndex];
        const previous = entry.message;
        // A compacted snapshot still outranks a sparse replay of the same event.
        if (entry.compactedDigest && !compactedDigest && Number.isSafeInteger(message.params.sequence) &&
            entry.compactedSequence === message.params.sequence) return true;
        // Reuse the earlier hint's wire position and bytes. The complete
        // snapshot's digest and sequence still belong to its own event.
        if (compactedDigest && message.params.question.revision === previous.params.question.revision) {
          entry.compactedDigest = compactedDigest;
          entry.compactedSequence = message.params.sequence;
        }
        // A client may already know a newer revision than the earliest hint.
        // Keep the highest revision and deliver that intact frame in wire order.
        if (message.method !== 'asyncQuestion/changed' ||
            !(message.params.question.revision > previous.params.question.revision)) {
          // A newer hint covers readback, but cannot certify the older snapshot.
          if (compactedDigest && message.params.question.revision < previous.params.question.revision)
            return this.#rememberDisplacedSnapshot(queue, message, compactedDigest, message.params.sequence, defaultServerId);
          return true;
        }
      }
    }

    const retainedReplay = compactedReplay ?? queue.entries[replacedIndex];
    if (fullQuestion && (retainedReplay || reclaimedReplay)) {
      const firstSequence = compactedReplay ? compactedReplay.compactedSequence : retainedReplay?.message.params.sequence;
      if (hintIndex !== -1) this.#removeEntry(queue, hintIndex);
      if (message.params.sequence !== firstSequence)
        this.#rememberQuestionEvent(queue, message, message.params.sequence);
      return true;
    }

    // A full snapshot can correct a legacy hint for the exact same event.
    // At capacity, compacting it first would let the hint's revision win.
    if (hintIndex !== -1) {
      const hint = queue.entries[hintIndex];
      const availableBytes = Math.min(RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingBytes - queue.bytes,
        RESUME_NOTIFICATION_BUFFER_LIMITS.globalBytes - this.#globalBytes);
      let replacement = { message, identity, bytes: Buffer.byteLength(JSON.stringify(message), 'utf8') };
      if (replacement.bytes > availableBytes + hint.bytes &&
          !hasSameRevisionSnapshot(queue.entries, message, defaultServerId)) {
        // Even under byte pressure, retain the snapshot's revision for readback.
        const compacted = compactQuestion(message);
        replacement = { message: compacted, identity: hintIdentity, compactedDigest: snapshotDigest(identity),
          compactedSequence: message.params.sequence,
          bytes: Buffer.byteLength(JSON.stringify(compacted), 'utf8') };
      }
      const growth = replacement.bytes - hint.bytes;
      if (growth <= availableBytes) {
        queue.entries[hintIndex] = replacement;
        queue.bytes += growth;
        this.#globalBytes += growth;
        return true;
      }
    }

    const frameLimitReached = replacedIndex === -1 &&
      (queue.entries.length >= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames ||
       this.#globalFrames >= RESUME_NOTIFICATION_BUFFER_LIMITS.globalFrames);

    let replacedBytes = replacedIndex === -1 ? 0 : queue.entries[replacedIndex].bytes;
    const availableBytes = Math.min(
      RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingBytes - queue.bytes,
      RESUME_NOTIFICATION_BUFFER_LIMITS.globalBytes - this.#globalBytes,
    );
    const byteBudget = availableBytes + replacedBytes;
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
    const needsSpace = frameLimitReached || messageBytes > byteBudget;
    const removed = replacedIndex === -1 ? [] : [replacedIndex];
    const compacted = [];
    const question = message.method === 'asyncQuestion/changed' ? message.params.question : undefined;
    if (question && question.questions === undefined) {
      // A full snapshot or its compacted locator can cover this readback hint.
      for (const [index, previous] of queue.entries.entries()) {
        const frame = previous.message;
        if (index === correctedHintIndex || frame.method !== message.method) continue;
        const fullSnapshot = frame.params.question.questions !== undefined;
        // Use the original sequence even when compaction reused an older hint's slot.
        if (!compactedDigest && (fullSnapshot || Number.isSafeInteger(previous.compactedSequence)) &&
            isHintForQuestionEvent(message, frame, defaultServerId, previous.compactedSequence)) return true;
        if (!fullSnapshot && !previous.compactedDigest) continue;
        const binding = fullSnapshot ? questionIdentity(frame, true) : previous.identity;
        if (!isDeepStrictEqual(binding, identity)) continue;
        if (frame.params.question.revision >= question.revision) {
          // A correction must still replace the partial frame at its original position.
          if (correctedHintIndex === -1) {
            if (compactedDigest)
              return this.#rememberDisplacedSnapshot(queue, message, compactedDigest, message.params.sequence, defaultServerId);
            return true;
          }
          continue;
        }
        if (needsSpace &&
            (removed.length === 0 || messageBytes > availableBytes + replacedBytes) &&
            messageBytes <= availableBytes + replacedBytes + previous.bytes &&
            !hasSameRevisionSnapshot(queue.entries, frame, defaultServerId)) {
          // Keep the old hint marked for removal when its space alone is insufficient.
          removed.push(index);
          replacedBytes += previous.bytes;
        }
      }
    }
    if (needsSpace) {
      if (question && question.questions !== undefined) {
        // The recovering client can read the durable snapshot from the original task.
        const hint = compactQuestion(message);
        // Exact replays have already been handled. Keep conflicting snapshots
        // visible by failing the bounded handoff if the full frame cannot fit.
        if (hasSameRevisionSnapshot(queue.entries, message, defaultServerId)) {
          queue.overflowed = true;
          return false;
        }
        return this.capture(pending, hint, snapshotDigest(identity), hintIndex);
      }
      if ((frameLimitReached && removed.length === 0) || messageBytes > availableBytes + replacedBytes) {
        // Reclaim covered updates if replacing an older hint did not free enough space.
        for (const [index, { message: older, identity: olderIdentity, bytes, compactedDigest }] of queue.entries.entries()) {
          if (removed.includes(index) || older.method !== 'asyncQuestion/changed') continue;
          const olderQuestion = older.params.question;
          const isHint = olderQuestion.questions === undefined;
          const binding = isHint ? olderIdentity : questionIdentity(older, true);
          // A newer revision cannot resolve two conflicting snapshots.
          if (!isHint && hasSameRevisionSnapshot(queue.entries, older, defaultServerId)) continue;
          const covered = queue.entries.some(({ message: newer, compactedDigest: newerDigest }) =>
            newer.method === older.method &&
            (newer.params.question.questions !== undefined || newerDigest) &&
            (newer.params.question.revision > olderQuestion.revision ||
             (isHint && !compactedDigest && newer.params.question.revision === olderQuestion.revision)) &&
            isDeepStrictEqual(questionIdentity(newer, true), binding));
          if (!covered) continue;
          removed.push(index);
          replacedBytes += bytes;
          if (messageBytes <= availableBytes + replacedBytes) break;
        }
      }
      if (messageBytes > availableBytes + replacedBytes &&
          (!frameLimitReached || removed.length > 0)) {
        // Keep the locator in its original position. Live clients already got
        // the full frame, and the recovering client can read the durable record.
        for (const [index, entry] of queue.entries.entries()) {
          const full = entry.message;
          if (removed.includes(index) || full.method !== 'asyncQuestion/changed' ||
              full.params.question.questions === undefined) continue;
          const hint = compactQuestion(full);
          const bytes = Buffer.byteLength(JSON.stringify(hint), 'utf8');
          const saved = entry.bytes - bytes;
          // Preserve same-revision conflicts so clients can reconcile them.
          if (hasSameRevisionSnapshot(queue.entries, full, defaultServerId)) continue;
          compacted.push([index, { message: hint, identity: questionIdentity(hint), bytes,
            compactedDigest: snapshotDigest(entry.identity), compactedSequence: full.params.sequence }]);
          replacedBytes += saved;
          if (messageBytes <= availableBytes + replacedBytes) break;
        }
      }
      if ((frameLimitReached && removed.length === 0) || messageBytes > availableBytes + replacedBytes) {
        queue.overflowed = true;
        return false;
      }
    }

    for (const index of removed) {
      const entry = queue.entries[index];
      if (entry.message.method !== 'asyncQuestion/changed' ||
          (!entry.compactedDigest && entry.message.params.question.questions === undefined)) continue;
      if (!this.#rememberDisplacedSnapshot(queue, entry.message,
        entry.compactedDigest ?? snapshotDigest(entry.identity),
        entry.compactedDigest ? entry.compactedSequence : entry.message.params.sequence, defaultServerId)) return false;
    }
    // Apply compaction only after the conflict evidence fits, together with
    // the byte accounting below. Refusal leaves the original frames in place.
    for (const [index, entry] of compacted) queue.entries[index] = entry;
    for (const index of removed.sort((a, b) => b - a)) queue.entries.splice(index, 1);
    this.#globalFrames += 1 - removed.length;
    const entry = { message, identity, bytes: messageBytes, compactedDigest,
      compactedSequence: compactedDigest ? message.params.sequence : undefined };
    if (correctedHintIndex === -1) queue.entries.push(entry);
    else {
      // A corrected sequence keeps its original place even when other frames
      // had to be reclaimed to fit the compact locator.
      const precedingRemovals = removed.filter(index => index < correctedHintIndex).length;
      queue.entries.splice(correctedHintIndex - precedingRemovals, 0, entry);
    }
    queue.bytes += messageBytes - replacedBytes;
    this.#globalBytes += messageBytes - replacedBytes;
    return true;
  }

  isOverflowed(pending) {
    return this.#queues.get(pending)?.overflowed === true;
  }

  discardReplayedQuestion(pending, delivered, identity, locatorIdentity) {
    const queue = this.#queues.get(pending);
    if (!queue) return;
    const sessionId = this.#sessionId();
    const defaultServerId = sessionId ? `server-${sessionId}` : undefined;
    identity = withQuestionProducer(identity, defaultServerId);
    if (locatorIdentity !== undefined) locatorIdentity = withQuestionProducer(locatorIdentity, defaultServerId);
    const { revision } = delivered.params.question;
    let deliveredDigest;
    for (let index = queue.entries.length - 1; index >= 0; index--) {
      const { message, identity: queuedIdentity, compactedDigest } = queue.entries[index];
      if (message.method !== 'asyncQuestion/changed') continue;
      // A live snapshot can correct the same event in an older pending resume,
      // even when its legacy hint omitted source fields or misreported revision.
      if (locatorIdentity !== undefined && !compactedDigest &&
          message.params.question.questions === undefined && isHintForQuestionEvent(message, delivered, defaultServerId)) {
        this.#removeEntry(queue, index);
        continue;
      }
      if (message.params.question.revision !== revision) continue;
      if (!isDeepStrictEqual(queuedIdentity, identity) &&
          (locatorIdentity === undefined || !isDeepStrictEqual(queuedIdentity, locatorIdentity))) continue;
      // Only a matching full snapshot can retire compacted conflict evidence.
      if (compactedDigest && (locatorIdentity === undefined ||
          (deliveredDigest ??= snapshotDigest(identity)) !== compactedDigest)) continue;
      this.#removeEntry(queue, index);
    }
  }

  #rememberDisplacedSnapshot(queue, message, digest, sequence, defaultServerId) {
    const digests = queue.replacedDigests ??= new Map();
    const key = questionRevisionKey(message, defaultServerId);
    if (!digests.has(key) && digests.size >= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames) {
      queue.overflowed = true;
      return false;
    }
    digests.set(key, digest);
    this.#rememberQuestionEvent(queue, message, sequence);
    return true;
  }

  #rememberQuestionEvent(queue, message, sequence) {
    if (!Number.isSafeInteger(sequence)) return;
    const locator = compactQuestion(message);
    locator.params.sequence = sequence;
    const locators = queue.questionReplayLocators ??= new Map();
    locators.delete(sequence);
    locators.set(sequence, locator);
    if (locators.size > RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames)
      locators.delete(locators.keys().next().value);
  }

  #removeEntry(queue, index) {
    const [{ bytes }] = queue.entries.splice(index, 1);
    queue.bytes -= bytes;
    this.#globalFrames--;
    this.#globalBytes -= bytes;
  }

  take(pending) {
    const queue = this.#queues.get(pending);
    if (!queue) return { messages: [], overflowed: false };
    this.#queues.delete(pending);
    this.#release(queue);
    return { messages: queue.entries.map(entry => entry.message), overflowed: queue.overflowed };
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
    this.#globalFrames -= queue.entries.length;
    this.#globalBytes -= queue.bytes;
  }
}
