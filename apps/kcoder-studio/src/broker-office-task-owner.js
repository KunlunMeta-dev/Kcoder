import { isDeepStrictEqual } from 'node:util';
import { asyncQuestionLocator, asyncQuestionReplayIdentity } from './broker-async-question-answer.js';
import { hasValidAsyncQuestionNotificationBinding } from './broker-async-questions.js';
import { isContract } from '../shared/generated/validator.mjs';

const MAX_HELD_BYTES = 256 * 1024;
const MAX_HELD_FRAMES = 64;

export function isOfficeTaskAdoption(pending) {
  return pending?.method === 'integrations/assistant/adopt'
    && pending.params?.payload?.startTask === true
    && pending.client?.channel === 'runtime' && pending.client?.initialized === true
    && !pending.expired && isContract('IntegrationRequest', pending.params);
}

/** The reply is from Native on the original request, never from a client notification. */
export function acceptedOfficeTask(pending, response) {
  const reply = response?.result;
  const task = reply?.result?.nativeTask;
  // Legacy response routing treats falsy methods as absent; they cannot certify ownership.
  if (!isOfficeTaskAdoption(pending) || response.method !== undefined || response.error !== undefined
    || (response.jsonrpc !== undefined && response.jsonrpc !== '2.0')
    || !isContract('IntegrationReply', reply)
    || !['accepted', 'completed'].includes(reply.status) || reply.error !== null
    || reply.requestId !== pending.params.requestId
    || !pending.params.operationId || reply.operationId !== pending.params.operationId
    || !isContract('IntegrationRuntimeAcceptance', task)
    // Match live question/turn binding guards before installing an owner or an
    // active turn that subsequent requests and terminal receipts cannot identify.
    || !/\P{White_Space}/u.test(task.threadId)
    || typeof task.turnId !== 'string' || !/\P{White_Space}/u.test(task.turnId)
    || task.state === 'outcome_unknown') return null;
  return task;
}

function replayIdentity(message) {
  if (message.method === 'asyncQuestion/changed') return asyncQuestionReplayIdentity(message);
  const { sequence: _sequence, ...params } = message.params;
  return { ...message, params };
}

function compactQuestion(message) {
  const { params } = message;
  return { ...message, params: { ...params,
    question: { ...asyncQuestionLocator(params.question), revision: params.question.revision } } };
}

function sameQuestion(first, second) {
  return first.serverId === second.serverId && first.question.threadId === second.question.threadId &&
    first.question.questionId === second.question.questionId;
}

function isHintForQuestionEvent(hint, snapshot, hintSequence, snapshotSequence) {
  // An exact transport event can supply omitted legacy source fields.
  return Number.isSafeInteger(snapshotSequence) && hintSequence === snapshotSequence && sameQuestion(hint, snapshot) &&
    ['requestId', 'sourceTurnId', 'toolCallId'].every(field =>
      hint.question[field] === undefined || hint.question[field] === snapshot.question[field]);
}

/** Hold early interactions without guessing which pending adoption owns a thread. */
export class BrokerOfficeTaskOwnerHandoff {
  #held = new Map();
  #bytes = 0;

  hasRequest(id) { return this.#held.has(id); }

  capture(message, pending, { compacted = false } = {}) {
    // Freeze the same locators as normal broker routing. Early legacy prompts
    // must wait for their own task/turn receipt without rewriting the wire frame.
    const params = message.params;
    const threadId = [params?.threadId, params?.thread_id, params?.thread?.threadId,
      params?.thread?.id, params?.widget?.threadId].find(value => typeof value === 'string');
    const turnId = [params?.turnId, params?.turn_id, params?.turn?.turnId,
      params?.turn?.id].find(value => typeof value === 'string');
    if (!message.method || typeof threadId !== 'string'
      || message.id !== undefined && (!['approval/request', 'question/request'].includes(message.method)
        // Match live interaction admission without coercing legacy string IDs.
        || !((typeof message.id === 'string' && message.id.trim()) ||
          (Number.isSafeInteger(message.id) && message.id >= 0)))) return false;
    if (message.method === 'asyncQuestion/changed' &&
      !hasValidAsyncQuestionNotificationBinding(message.params)) return false;
    const key = message.id === undefined ? message : message.id;
    // A held transport ID already owns its first binding and candidate set.
    // Consume replays without answering that waiter or replacing its prompt.
    if (this.#held.has(key)) return true;
    // Equivalent replays add no state. A newer legacy hint must replace an older
    // hint, which a client with a newer card could ignore without reading.
    const identity = ['asyncQuestion/changed', 'question/resolved', 'approval/resolved'].includes(message.method)
      ? replayIdentity(message) : undefined;
    const hint = message.method === 'asyncQuestion/changed' && params.question.questions === undefined;
    if (hint && !compacted) {
      // Resolve coverage before replacing any older hint. A complete snapshot
      // wins over a sparse replay of the same event even if revisions differ.
      for (const { message: previous, compactedSnapshot, replaySequences } of this.#held.values()) {
        if (previous.method !== message.method) continue;
        const full = previous.params.question.questions !== undefined;
        const matchesReplay = full && previous.params.question.revision === params.question.revision &&
          replaySequences?.has(params.sequence);
        const previousSequence = matchesReplay ? params.sequence
          : compactedSnapshot ? compactedSnapshot.sequence : previous.params.sequence;
        if ((full || compactedSnapshot) &&
            isHintForQuestionEvent(params, previous.params, params.sequence, previousSequence)) return true;
        if (full && previous.params.question.revision >= params.question.revision &&
            isDeepStrictEqual(asyncQuestionReplayIdentity(previous, true), identity)) return true;
      }
    }
    if (identity !== undefined) {
      for (const [previousKey, held] of this.#held) {
        if (!isDeepStrictEqual(held.identity, identity)) continue;
        if (hint && params.question.revision > held.message.params.question.revision) {
          // Keep evidence of the complete event when a later sparse hint arrives.
          if (!compacted && held.compactedSnapshot) continue;
          return this.#replaceQuestion(previousKey, held, key, message, identity, compacted);
        }
        if (compacted && !held.compactedSnapshot && params.question.revision === held.message.params.question.revision) {
          // Reuse the earlier hint's frame and budget while tracking the full event's sequence.
          held.compactedSnapshot = { sequence: params.sequence };
        }
        if (message.method === 'asyncQuestion/changed' && !hint && Number.isSafeInteger(params.sequence) &&
            held.message.params.sequence !== params.sequence) {
          // An exact snapshot replay can still correct a hint at its new sequence.
          // Retain a bounded window for hints arriving after the replay too.
          const sequences = held.replaySequences ??= new Set();
          sequences.add(params.sequence);
          if (sequences.size > MAX_HELD_FRAMES) sequences.delete(sequences.values().next().value);
          for (const [key, entry] of this.#coveredHints(message, held)) this.#remove(key, entry);
        }
        return true;
      }
    }
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (message.method === 'asyncQuestion/changed' && !hint) {
      const locator = asyncQuestionReplayIdentity(message, true);
      let correction;
      for (const [previousKey, held] of this.#held) {
        const previous = held.message;
        if (previous.method !== message.method || previous.params.question.questions !== undefined) continue;
        const previousQuestion = previous.params.question;
        // Check durable conflicts before correcting any same-sequence hint.
        // The source locator can itself be part of the conflict.
        if (sameQuestion(previous.params, params) && (held.conflictingRevision === params.question.revision ||
            (held.compactedSnapshot && previousQuestion.revision === params.question.revision))) return true;
        const previousSequence = held.compactedSnapshot ? held.compactedSnapshot.sequence : previous.params.sequence;
        if (!correction && isHintForQuestionEvent(previous.params, params, previousSequence, params.sequence))
          correction = [previousKey, held];
      }
      if (correction) {
        const [previousKey, held] = correction;
        // The complete frame supplies the revision of this event. Keep the
        // slot and candidates, compacting the corrected revision if necessary.
        const covered = [...this.#coveredHints(message, held)].filter(([key]) => key !== previousKey);
        const remainingBytes = this.#bytes - held.bytes - covered.reduce((total, [, entry]) => total + entry.bytes, 0);
        const fits = remainingBytes + bytes <= MAX_HELD_BYTES;
        const replacement = fits ? message : compactQuestion(message);
        const replacementBytes = fits ? bytes : Buffer.byteLength(JSON.stringify(replacement));
        if (remainingBytes + replacementBytes <= MAX_HELD_BYTES) {
          for (const [key, entry] of covered) this.#remove(key, entry);
          this.#held.set(previousKey, { ...held, message: replacement, identity: fits ? identity : locator,
            bytes: replacementBytes, compactedSnapshot: fits ? undefined : { sequence: params.sequence } });
          this.#bytes = remainingBytes + replacementBytes;
        }
        return true;
      }
    }
    if (this.#held.size >= MAX_HELD_FRAMES || this.#bytes + bytes > MAX_HELD_BYTES) {
      if (message.method !== 'asyncQuestion/changed') return false;
      if (hint) {
        // Reuse a matching snapshot's slot for durable readback. Equivalent
        // full replays were already handled before compaction.
        for (const [previousKey, held] of this.#held) {
          const previous = held.message;
          if (previous.method !== message.method || previous.params.question.questions === undefined ||
              !sameQuestion(previous.params, params)) continue;
          const previousRevision = previous.params.question.revision;
          const previousIdentity = asyncQuestionReplayIdentity(previous, true);
          const sameSource = isDeepStrictEqual(previousIdentity, identity);
          if (compacted && previousRevision === params.question.revision) {
            // A locator conflict needs readback of the same durable record too.
            // Keep the original source and adoption candidates for that read.
            const readback = sameSource ? message : { ...message, params: {
              ...params, question: compactQuestion(previous).params.question,
            } };
            if (this.#replace(previousKey, { ...held, conflictingRevision: previousRevision },
              key, readback, previousIdentity, Buffer.byteLength(JSON.stringify(readback)), true)) return true;
          } else if (sameSource && previousRevision < params.question.revision &&
              this.#replaceQuestion(previousKey, held, key, message, identity, compacted, bytes)) return true;
        }
        return false;
      }
      // A compact locator can replace a matching entry even at the frame cap.
      // A compacted full snapshot may carry content distinct from the saved snapshot.
      return this.capture(compactQuestion(message), pending, { compacted: true });
    }
    const candidates = new Set([...pending].filter(isOfficeTaskAdoption));
    if (!candidates.size) return false;
    this.#held.set(key, { message, identity, threadId, turnId, candidates, bytes,
      compactedSnapshot: compacted ? { sequence: params.sequence } : undefined });
    this.#bytes += bytes;
    return true;
  }

  settle(pending, task, deliver, refuse) {
    const ready = [], denied = [];
    for (const [id, held] of this.#held) {
      if (!held.candidates.delete(pending)) continue;
      if (task && held.threadId === task.threadId
        && (!held.turnId || held.turnId === task.turnId)) {
        this.#remove(id, held);
        ready.push(held.message);
      } else if (!held.candidates.size) {
        this.#remove(id, held);
        denied.push(held.message);
      }
    }
    for (const message of denied) refuse(message);
    for (const message of ready) deliver(message);
  }

  prune(current, refuse) {
    for (const [id, held] of this.#held) {
      for (const pending of held.candidates) if (!current(pending)) held.candidates.delete(pending);
      if (!held.candidates.size) {
        this.#remove(id, held);
        refuse(held.message);
      }
    }
  }

  *#coveredHints(snapshot, held) {
    for (const [key, entry] of this.#held) {
      const hint = entry.message;
      if (hint.method !== snapshot.method || entry.compactedSnapshot ||
          hint.params.question.questions !== undefined ||
          !isHintForQuestionEvent(hint.params, snapshot.params, hint.params.sequence, snapshot.params.sequence) ||
          ![...entry.candidates].every(candidate => held.candidates.has(candidate))) continue;
      yield [key, entry];
    }
  }

  #replaceQuestion(previousKey, held, key, message, identity, compacted, bytes = Buffer.byteLength(JSON.stringify(message))) {
    if (this.#replace(previousKey, held, key, message, identity, bytes, compacted)) return true;
    // Keep the newer readback revision even when the optional answer cannot fit.
    const hint = compactQuestion(message);
    return this.#replace(previousKey, held, key, hint, identity, Buffer.byteLength(JSON.stringify(hint)), compacted);
  }

  #replace(previousKey, held, key, message, identity, bytes, compacted) {
    if (this.#bytes - held.bytes + bytes > MAX_HELD_BYTES) return false;
    this.#remove(previousKey, held);
    // Keep the original adoption candidates at the newer frame's position.
    this.#held.set(key, { ...held, message, identity, bytes, replaySequences: undefined,
      compactedSnapshot: compacted ? { sequence: message.params.sequence } : undefined });
    this.#bytes += bytes;
    return true;
  }

  clear() { this.#held.clear(); this.#bytes = 0; }
  #remove(id, held) { this.#held.delete(id); this.#bytes -= held.bytes; }
}
