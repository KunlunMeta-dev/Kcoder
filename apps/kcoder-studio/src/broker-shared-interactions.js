import { hasWellFormedJsonStrings } from './broker-json-strings.js';
import { isContract } from '../shared/generated/validator.mjs';
import { isOfficeTaskAdoption } from './broker-office-task-owner.js';

const TYPES = new Map([['approval/request', 'ApprovalResponse'], ['question/request', 'QuestionResponse']]);
const MAX_INTERACTIONS = 512;
export const TURN_TERMINAL_TRACKED_METHODS = new Set(['turn/start', 'computerUse/recover', 'asyncQuestion/answer']);

export function hasInvalidInteractionResolutionEnvelope(message) {
  return ['approval/resolved', 'question/resolved'].includes(message.method) &&
    (message.id !== undefined || message.result !== undefined || message.error !== undefined ||
      (message.jsonrpc !== undefined && message.jsonrpc !== '2.0'));
}

export function isTurnLifecycleMethod(method) {
  return ['turn/started', 'turn/completed', 'turn/failed', 'turn/interrupted'].includes(method);
}

export function hasConflictingTurnIdentity(message) {
  if (!isTurnLifecycleMethod(message.method)) return false;
  // Lifecycle locators belong inside object params. Top-level legacy routing
  // must not admit a malformed frame that fails every peer during cleanup.
  if (!message.params || typeof message.params !== 'object' || Array.isArray(message.params)) return true;
  // Only notification envelopes can certify lifecycle before input cleanup or
  // recovery buffering. Preserve older producers that omit the version.
  if (message.id !== undefined || message.result !== undefined || message.error !== undefined ||
      (message.jsonrpc !== undefined && message.jsonrpc !== '2.0')) return true;
  // Legacy initialize replies may omit sessionId. Even without an epoch to
  // compare, a malformed explicit producer cannot certify turn lifecycle.
  const { serverId, sequence } = message.params;
  if (serverId !== undefined && (typeof serverId !== 'string' || !serverId.isWellFormed() ||
      !/\P{White_Space}/u.test(serverId) || serverId.length > 256)) return true;
  // Only omission is legacy ordering. Invalid explicit sequences cannot close
  // original input or consume recovery capacity outside the replay fence.
  if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 0)) return true;
  // Explicit lifecycle states must agree before changing the current attempt,
  // closing input or reserving recovery capacity. Preserve omitted legacy states.
  const status = message.params?.turn?.status;
  if (status !== undefined && (message.method === 'turn/started'
    ? status !== 'running' : !['completed', 'failed', 'interrupted'].includes(status))) return true;
  return hasConflictingInteractionBindings(message.params);
}

export function hasObservedTerminalTurn(pending, turnId, attemptId) {
  const attempts = pending.observedTerminalTurns?.get(turnId);
  return Boolean(pending.observedTerminalUnknown || attempts &&
    // Legacy receipts or terminals without an attempt retain turn-level matching.
    (attempts.has(null) || typeof attemptId !== 'string' || attempts.has(attemptId)));
}

export function observeTerminalTurn(pending, turnId, attemptId) {
  if (!turnId) { pending.observedTerminalUnknown = true; return; }
  pending.observedTerminalTurns ??= new Map();
  const attempts = pending.observedTerminalTurns.get(turnId);
  // Retries reuse turn IDs. Keep exact attempts within the request's identity budget.
  if (attempts?.has(attemptId)) return;
  const count = [...pending.observedTerminalTurns.values()].reduce((total, value) => total + value.size, 0);
  if (count >= 64) pending.observedTerminalUnknown = true;
  else if (attempts) attempts.add(attemptId);
  else pending.observedTerminalTurns.set(turnId, new Set([attemptId]));
}

function hasConflictingInteractionBindings(params) {
  // Explicit nested task/turn locators must be objects before their optional fields
  // can be treated as absent. Malformed snapshots cannot settle original input.
  if ([params?.thread, params?.widget, params?.turn].some(value => value != null &&
      (typeof value !== 'object' || Array.isArray(value)))) return true;
  // Compatibility aliases may supplement an identity, but cannot contradict it.
  // Fence before routing, recovery buffering or retiring the original input.
  // An invalid explicit locator must not degrade into an omitted legacy field
  // and close every input in the task. Nullable optional locators stay compatible.
  // Use the same Rust whitespace rule as attempts and client lifecycle guards.
  // A blank alias must not replace execution or consume question recovery slots.
  const conflicts = values => values.some(value => value != null &&
    (typeof value !== 'string' || !value.isWellFormed() || !/\P{White_Space}/u.test(value))) ||
    new Set(values.filter(value => typeof value === 'string')).size > 1;
  return conflicts([params?.threadId, params?.thread_id, params?.thread?.threadId,
    params?.thread?.id, params?.widget?.threadId, params?.turn?.threadId]) ||
    conflicts([params?.turnId, params?.turn_id, params?.turn?.turnId, params?.turn?.id]) ||
    // Requests and interaction terminals need the same attempt fence as turn
    // lifecycle frames before reserving a waiter or retiring the original card.
    conflicts([params?.attemptId, params?.turn?.attemptId]);
}

function interactionBindings(message) {
  const field = message.method === 'approval/request' ? 'approvalId' : 'questionId';
  const params = message.params;
  // Retain the same task and turn selected by broker routing even when the
  // first prompt uses legacy locators. Keep the delivered wire frame unchanged.
  const threadId = [params?.threadId, params?.thread_id, params?.thread?.threadId,
    params?.thread?.id, params?.widget?.threadId].find(value => typeof value === 'string');
  const turnId = [params?.turnId, params?.turn_id, params?.turn?.turnId,
    params?.turn?.id].find(value => typeof value === 'string');
  return { threadId, turnId, [field]: params?.[field] };
}

function sameTerminalTurn(identity, threadId, turnId, appServerEpoch) {
  return identity?.threadId === threadId && identity.turnId === turnId &&
    identity.appServerEpoch === (appServerEpoch ?? null);
}

/** Viewers observe the original interaction; only its requesting client replies. */
export class BrokerSharedInteractions {
  #broker;
  #entries = new Map();
  #terminalTurns = new Set();
  #terminalEvents = new Map();
  #attemptTerminalSequences = new Set();
  #supersededAttempts = new Set();
  #terminalRequestIds = new Map();
  #retiredRequests = new Map();
  // Carry reuse only from admission to registration; never retain wire payloads.
  #reusedRequests = new WeakMap();
  constructor(broker) { this.#broker = broker; }

  rememberSupersededAttempt(threadId, turnId, attemptId) {
    const previous = this.#broker.activeTurns.get(threadId);
    if (previous?.turnId !== turnId || typeof previous.attemptId !== 'string' ||
        typeof attemptId !== 'string' || previous.attemptId === attemptId) return;
    // A confirmed admission supersedes this exact attempt even if its terminal
    // was missed. Unrelated in-flight requests cannot make it current again.
    this.#supersededAttempts.add(JSON.stringify([threadId, turnId, previous.attemptId]));
    if (this.#supersededAttempts.size > 2048)
      this.#supersededAttempts.delete(this.#supersededAttempts.values().next().value);
  }

  isSupersededAttempt(threadId, turnId, attemptId) {
    return this.#supersededAttempts.has(JSON.stringify([threadId, turnId, attemptId]));
  }

  isEndedAttempt(threadId, turnId, attemptId) {
    return typeof attemptId === 'string' &&
      this.#terminalEvents.has(JSON.stringify([threadId, turnId, attemptId]));
  }

  rejectReplayedTurnTerminal(message) {
    if (!['turn/completed', 'turn/failed', 'turn/interrupted'].includes(message.method)) return false;
    const { threadId, turnId } = interactionBindings(message);
    const params = message.params;
    const attemptId = params.turn?.attemptId ?? params.attemptId;
    const attemptScoped = typeof attemptId === 'string';
    // An attempt-scoped terminal needs its turn before it can settle input.
    // Otherwise the legacy task-wide cleanup would fence every pending answer.
    if (attemptScoped && !turnId) return true;
    const hasSequence = Number.isSafeInteger(params.sequence) && params.sequence >= 0;
    // The broker has already checked any explicit server ID against initialize.
    const sessionId = this.#broker.initializeResponse?.result?.sessionId;
    const serverId = params.serverId ?? (sessionId ? `server-${sessionId}` : null);
    // A compatibility replay may omit the attempt but retain the sequence.
    // Remember its explicit binding even if the attempt has been superseded.
    if (hasSequence) {
      const sequenceKey = JSON.stringify([serverId, threadId, turnId, params.sequence]);
      if (attemptScoped) {
        this.#attemptTerminalSequences.add(sequenceKey);
        if (this.#attemptTerminalSequences.size > 2048)
          this.#attemptTerminalSequences.delete(this.#attemptTerminalSequences.values().next().value);
      } else if (this.#attemptTerminalSequences.has(sequenceKey)) return true;
    } else if (!attemptScoped) return false;
    const active = this.#broker.activeTurns?.get(threadId);
    const drain = this.#broker.threadDrains?.get(threadId);
    if (this.isSupersededAttempt(threadId, turnId, attemptId)) return true;
    const conflictsWithActive = active?.turnId === turnId && typeof active?.attemptId === 'string' &&
      attemptScoped && attemptId !== active.attemptId;
    const pendingAdmissions = conflictsWithActive ? [...this.#broker.pending.values()].filter(pending =>
      TURN_TERMINAL_TRACKED_METHODS.has(pending.method) &&
      pending.params?.threadId === threadId) : [];
    if (conflictsWithActive && !pendingAdmissions.length) return true;
    // Legacy disconnect removes the active owner before its interrupt settles.
    // Keep the drain and its queued input bound to the interrupted attempt.
    const conflictsWithDrain = drain?.turnId === turnId && typeof drain?.attemptId === 'string' &&
      typeof attemptId === 'string' && attemptId !== drain.attemptId;
    // An explicit attempt has one terminal event even if replay assigns a new
    // sequence. Retain its identity after active-turn cleanup, so an unrelated
    // pending answer cannot let that ended attempt close the retry's question.
    // Legacy terminals without attempts still need their transport sequence.
    // The validated broker lifetime already identifies the producer. Optional
    // server metadata and compatibility terminal names cannot revive an attempt.
    const key = JSON.stringify(attemptScoped ? [threadId, turnId, attemptId]
      : [message.method, serverId, threadId, turnId, params.sequence]);
    const original = this.#terminalEvents.get(key);
    // Owned handoff buffers route the original frame again for delivery.
    // Keep only a weak reference, never the terminal's potentially large body.
    if (original) return conflictsWithActive || conflictsWithDrain || original.deref() !== message;
    this.#terminalEvents.set(key, new WeakRef(message));
    if (this.#terminalEvents.size > 2048)
      this.#terminalEvents.delete(this.#terminalEvents.keys().next().value);
    // Observe another attempt's terminal only for pending receipt reconciliation.
    // Its notification cannot settle the active turn or its prompt.
    for (const pending of pendingAdmissions) observeTerminalTurn(pending, turnId, attemptId);
    return conflictsWithActive || conflictsWithDrain;
  }

  rejectUnownedRequest(message, ownerUnavailable = false) {
    if (!TYPES.has(message.method)) return false;
    // Top-level legacy routing cannot bind malformed params to an input waiter.
    // Drop before registration, adoption buffering or replying to an unconfirmed ID.
    if (!message.params || typeof message.params !== 'object' || Array.isArray(message.params)) return true;
    // Invalid envelopes cannot reserve a waiter or enter early adoption buffers.
    // Preserve legacy omission without answering an unconfirmed transport ID.
    if (message.jsonrpc !== undefined && message.jsonrpc !== '2.0') return true;
    // Match reply/receipt kind checks before ambiguous input reserves a waiter.
    const otherKind = message.method === 'question/request' ? 'approvalId' : 'questionId';
    if (message.params?.[otherKind] != null) return true;
    // Legacy approval choices constrain replies. Reject unusable lists before
    // reserving input; otherwise answering can throw or offer no valid decision.
    const decisions = message.params?.availableDecisions;
    if (message.method === 'approval/request' && decisions != null &&
        (!Array.isArray(decisions) || decisions.length === 0 || decisions.some(decision =>
          !isContract('ApprovalResponse', { decision })))) return true;
    // Remember malformed questions until the owner binding is known. A trusted
    // first request can then be settled instead of leaving Rust awaiting forever.
    // Conflicting identities and reused request IDs remain silent rejections.
    const questions = message.params?.questions;
    const invalidQuestionPayload = message.method === 'question/request' && questions !== undefined &&
        (!Array.isArray(questions) || questions.length === 0 || questions.some(question =>
          typeof question?.id !== 'string' || !question.id.isWellFormed() || !/\P{White_Space}/u.test(question.id) ||
          ['prompt', 'question'].some(field => question[field] !== undefined &&
            (typeof question[field] !== 'string' || !question[field].isWellFormed() || !/\P{White_Space}/u.test(question[field]))) ||
          (question.options !== undefined && (!Array.isArray(question.options) ||
            question.options.some(option => !option || typeof option !== 'object' || Array.isArray(option) ||
              (option.label === undefined && option.value === undefined) ||
              ['label', 'value'].some(field => option[field] !== undefined &&
                (typeof option[field] !== 'string' || !option[field].isWellFormed() || !/\P{White_Space}/u.test(option[field])))) ||
            // Choices are keyed by their wire answer value, including legacy label fallback.
            new Set(question.options.map(option => option.value ?? option.label)).size !== question.options.length))) ||
          new Set(questions.map(question => question.id)).size !== questions.length);
    // Reject Rust whitespace as well as client whitespace before reserving input.
    // An explicit unusable card identity cannot reserve the transport waiter.
    // Preserve legacy omission, but never reinterpret an invalid value as it.
    const field = message.method === 'question/request' ? 'questionId' : 'approvalId';
    const identity = message.params?.[field];
    if (identity !== undefined && (typeof identity !== 'string' || !identity.isWellFormed() || !/[^\s\p{White_Space}]/u.test(identity))) return true;
    // Invalid lifetimes cannot reserve a waiter that later valid input needs,
    // or produce a refusal response addressed to that original waiter.
    const epoch = message.params?.appServerEpoch;
    if (epoch != null && (typeof epoch !== 'string' || !epoch.isWellFormed() || !/[^\s\p{White_Space}]/u.test(epoch))) return true;
    // Reject ambiguous first bindings without settling a possibly unrelated waiter.
    if (hasConflictingInteractionBindings(message.params)) return true;
    // Match terminal receipt IDs before opening a card or reserving capacity.
    // Do not reply to an invalid ID: it cannot identify the original waiter.
    if (!(typeof message.id === 'string' && message.id.isWellFormed() && /[^\s\p{White_Space}]/u.test(message.id)) &&
        !(Number.isSafeInteger(message.id) && message.id >= 0)) return true;
    // A stale producer must not reserve this lifetime's transport ID. Do not
    // reply to that ID either: it may belong to the current server's waiter.
    const sessionId = this.#broker.initializeResponse?.result?.sessionId;
    if (sessionId && message.params?.serverId !== undefined &&
        message.params.serverId !== `server-${sessionId}`) return true;
    // Replayed requests must not reset ownership, submission or terminal state.
    // Keep the first binding even on an ID collision: replying to that reused ID
    // could settle the original request instead of the conflicting frame. Check
    // before legacy task routing can bypass the canonical threadId requirement.
    const settled = this.#terminalRequestIds.has(message.id) && this.#entries.get(message.id)?.resolved;
    if ((!settled && this.#entries.has(message.id)) || this.#broker.serverRequests?.has(message.id) ||
        (!settled && this.#broker.repliedServerRequests?.has(message.id))) return true;
    const bindings = interactionBindings(message);
    const { threadId, turnId } = bindings;
    // Terminal cleanup removes the active predecessor before a retry can
    // remember it as superseded. Both existing records prove that this exact
    // attempt cannot reopen input; never answer its potentially reused ID.
    const attemptId = message.params.turn?.attemptId ?? message.params.attemptId;
    if (this.isSupersededAttempt(threadId, turnId, attemptId) ||
        this.isEndedAttempt(threadId, turnId, attemptId)) return true;
    // Missing task locators cannot bypass an already retired transport ID.
    if (!threadId) return this.#retiredRequests.has(message.id) || this.#terminalRequestIds.has(message.id);
    const active = this.#broker.activeTurns.get(threadId);
    const owner = this.#broker.ownerFor(message);
    const currentSessionId = this.#broker.initializeResponse?.result?.sessionId;
    const trustedCurrentOwner = !ownerUnavailable && !this.#broker.threadDrains.has(threadId) &&
      typeof message.params?.threadId === 'string' && message.params.threadId === threadId &&
      typeof message.params?.turnId === 'string' && message.params.turnId === turnId &&
      active?.turnId === turnId && active.owner === owner && owner &&
      this.#broker.threadOwners?.get(threadId) === owner && this.#broker.clients.has(owner) &&
      (message.params?.serverId === undefined || currentSessionId &&
        message.params.serverId === `server-${currentSessionId}`);
    const retired = this.#retiredRequests.get(message.id);
    const terminal = this.#terminalRequestIds.get(message.id);
    if (terminal) {
      // Settled IDs fence their original turn, while a distinct confirmed
      // active turn may legally reuse the transport ID on a new connection.
      if (sameTerminalTurn(terminal, threadId, turnId, message.params?.appServerEpoch) ||
          !trustedCurrentOwner) return true;
      this.#terminalRequestIds.delete(message.id);
      this.#reusedRequests.set(message,
        terminal.threadId === threadId && terminal.turnId === turnId ? 'epoch' : 'turn');
      // A verified new turn replaces only the settled card and its reply cache.
      this.#entries.delete(message.id);
      this.#broker.repliedServerRequests?.delete(message.id);
    }
    if (retired) {
      const sameRetiredTurn = retired.bindings.threadId === threadId && retired.bindings.turnId === turnId &&
        retired.message.params.appServerEpoch === message.params?.appServerEpoch;
      // An ID remains retired for duplicate frames from its original turn, but
      // the existing registry can be reused by a distinct confirmed turn/epoch.
      if (sameRetiredTurn || !trustedCurrentOwner) return true;
      this.#retiredRequests.delete(message.id);
      this.#reusedRequests.set(message,
        retired.bindings.threadId === threadId && retired.bindings.turnId === turnId ? 'epoch' : 'turn');
    }
    if (invalidQuestionPayload) {
      if (trustedCurrentOwner) {
        // Keep only the bounded identity needed to fence a replay or reconcile a
        // late receipt; never publish malformed content to a client projection.
        this.#retainBinding(message.id, { message, bindings });
        this.#broker.safeWriteMessage({ jsonrpc: '2.0', id: message.id,
          error: { code: -32602, message: 'Invalid question/request payload' } });
      }
      return true;
    }
    // Admission events can precede their answer receipt after its client left.
    // If no current owner or pending adoption can receive this interaction,
    // retain the refusal just like every other lifecycle rejection below.
    const ownerless = ownerUnavailable || !this.#broker.ownerFor(message) &&
      !(this.#broker.automationThreads.has(threadId) && [...this.#broker.clients].some(client =>
        client.channel === 'runtime' && client.initialized && !client.nativeManagementOnly)) &&
      ![...this.#broker.pending.values()].some(isOfficeTaskAdoption);
    if (this.#broker.threadDrains.has(threadId) ||
        // A confirmed retry runs a new attempt under the same turn ID. Its
        // active admission supersedes the earlier attempt's terminal, while
        // the request-ID fences above keep the old attempt's inputs closed.
        (this.#terminalTurns.has(JSON.stringify([threadId, turnId])) && (!active || active.turnId !== turnId)) ||
        (active && turnId && active.turnId !== turnId) ||
        (active?.owner && !this.#broker.clients.has(active.owner)) || ownerless) {
      // This refusal stays final after the transient lifecycle gate clears.
      this.#retainBinding(message.id, { message, bindings });
      this.#broker.safeWriteMessage({ jsonrpc: '2.0', id: message.id,
        error: { code: -32040, message: ownerless
          ? `app-server request has no connected owner: ${message.method}`
          : 'original interaction turn has ended or its client disconnected' } });
      return true;
    }
    // Reserve bounded binding capacity before the broker registers or delivers
    // the request. An untracked card cannot retain its original reply fence.
    if (this.#entries.size >= MAX_INTERACTIONS) {
      for (const [id, entry] of this.#entries) {
        // Older exclusive targets may never publish a terminal notification.
        // Their forwarded replies retain the existing bounded native replay path.
        const legacyReply = entry.message.params.appServerEpoch == null &&
          this.#broker.repliedServerRequests.has(id);
        // Detached owners retain receipt bindings, but no longer reserve input capacity.
        if (!entry.owner || entry.resolved || entry.turnEnded || legacyReply) {
          if (!entry.resolved) this.#retainBinding(id, entry);
          this.#entries.delete(id);
        }
        if (this.#entries.size < MAX_INTERACTIONS) break;
      }
    }
    if (this.#entries.size >= MAX_INTERACTIONS) {
      // Refusal closes this transport request even if capacity later becomes
      // available. Keep its binding for the eventual authoritative receipt.
      this.#retainBinding(message.id, { message, bindings });
      this.#broker.safeWriteMessage({ jsonrpc: '2.0', id: message.id,
        error: { code: -32040, message: 'Gateway interaction capacity limit reached' } });
      return true;
    }
    return false;
  }

  request(message, owner) {
    if (!TYPES.has(message.method)) return;
    const bindings = interactionBindings(message);
    if (!bindings.threadId) return;
    const entry = { message, bindings, owner, originalOwner: owner ? new WeakRef(owner) : null,
      recipients: new Set([owner]), submitted: false, resolved: null,
      replyBindingRequired: this.#reusedRequests.get(message) };
    this.#reusedRequests.delete(message);
    this.#entries.set(message.id, entry);
    for (const client of this.#broker.sharedThreads.members(bindings.threadId)) {
      if (client === owner || !this.#broker.clients.has(client)) continue;
      entry.recipients.add(client);
      this.sendToClient(client, message);
    }
  }

  replay(threadId, client) {
    for (const entry of this.#entries.values()) {
      if (entry.bindings.threadId !== threadId || !entry.owner || entry.resolved || entry.turnEnded || !this.#broker.sharedThreads.has(threadId, client)) continue;
      entry.recipients.add(client);
      this.sendToClient(client, entry.message);
    }
  }

  sendToClient(client, message, { detachUnqueued = false } = {}) {
    if (!this.#broker.clients.has(client)) return;
    try {
      if (typeof client.sendWithQueueStatus === 'function') {
        const { queued } = client.sendWithQueueStatus(message);
        if (queued || !detachUnqueued) return queued;
      } else {
        client.send(message);
        // Legacy send() returns writability, which can be false after enqueueing.
        return true;
      }
    } catch { /* The socket write failed. */ }
    // Isolate a failing recipient. For question receipts an explicitly unqueued
    // frame also means this connection cannot observe its operation's outcome.
    this.#broker.detach(client);
    try { client.close(); } catch { /* The client is already detached. */ }
    return false;
  }

  canRead(client, params) {
    const entry = this.#entries.get(params?.requestId);
    return Boolean(entry && entry.bindings.threadId === params.threadId && entry.recipients.has(client));
  }

  bindExclusiveReply(client, response) {
    const entry = this.#entries.get(response.id);
    if (this.#broker.initializeResponse?.result?.capabilities?.experimental?.interactionBindingV1 !== true ||
        !entry || entry.originalOwner?.deref() !== client || !entry.recipients.has(client) || !response.result || typeof response.result !== 'object') return response;
    // Rust Option fields treat null as omission. Fill only the original
    // delivered binding, preserving explicit mismatches during receipt replay.
    if (!Object.entries(entry.bindings).every(([key, value]) => typeof value === 'string' && value &&
        (response.result[key] == null || response.result[key] === value))) return response;
    return { ...response, result: { ...response.result, ...entry.bindings } };
  }

  reply(client, response) {
    const entry = this.#entries.get(response.id);
    if (!entry) return false;
    // A turn terminal event closes input even if its interaction receipt is
    // delayed. Keep that native receipt readable without forwarding stale input.
    if (entry.turnEnded) {
      if (!entry.recipients.has(client)) throw new Error('server request was not delivered to this client');
      client.send(entry.resolved ?? { jsonrpc: '2.0', method: 'gateway/interaction/replyRejected',
        params: { ...entry.bindings, appServerEpoch: entry.message.params.appServerEpoch, requestId: response.id, reason: 'turn_ended' } });
      return true;
    }
    const originalReplyOwner = this.#broker.serverRequests.get(response.id) === client ||
      this.#broker.repliedServerRequests.get(response.id) === client;
    // Outer interaction IDs do not bind the answer map's item IDs. Refuse
    // foreign items before either shared or exclusive forwarding consumes the
    // original waiter. Partial answers and freeform values keep their contract.
    if (entry.message.method === 'question/request' &&
        originalReplyOwner &&
        Array.isArray(entry.message.params.questions) && response.error === undefined &&
        response.result?.answers && typeof response.result.answers === 'object') {
      const ids = new Set(entry.message.params.questions.map(question => question.id));
      if (Object.keys(response.result.answers).some(id => !ids.has(id))) {
        client.send({ jsonrpc: '2.0', method: 'gateway/interaction/replyRejected',
          params: { ...entry.bindings, appServerEpoch: entry.message.params.appServerEpoch, requestId: response.id, reason: 'invalid_response' } });
        return true;
      }
    }
    const shared = this.#broker.sharedThreads.has(entry.bindings.threadId, client);
    if (shared) {
      if (!entry.recipients.has(client)) throw new Error('server request was not delivered to this client');
      if (entry.resolved) {
        client.send(entry.resolved);
        return true;
      }
      if (entry.owner !== client) {
        client.send({ jsonrpc: '2.0', method: 'gateway/interaction/replyRejected',
          params: { ...entry.bindings, appServerEpoch: entry.message.params.appServerEpoch, requestId: response.id, reason: 'not_original_client' } });
        return true;
      }
      if (entry.submitted) return true;
    } else if (!originalReplyOwner || entry.resolved) {
      // Pending exclusive retries still need the original response checks below.
      // Settled replies retain the existing Native receipt reconciliation path.
      return false;
    }
    const params = entry.message.params;
    const kind = entry.message.method === 'approval/request' ? 'approvalId' : 'questionId';
    const otherKind = kind === 'approvalId' ? 'questionId' : 'approvalId';
    const result = response.result;
    // Reused transport IDs cannot distinguish an old unbound reply/cancellation
    // from new input. Require the actual card binding before filling any aliases.
    const validError = response.error && Number.isSafeInteger(response.error.code) &&
      typeof response.error.message === 'string' && result === undefined;
    const replyBinding = result ?? response.error?.data?.interactionBinding;
    const reusedBindingMatches = !entry.replyBindingRequired || replyBinding && replyBinding[otherKind] == null &&
      Object.entries(entry.bindings).every(([key, value]) => replyBinding[key] === value) &&
      (entry.replyBindingRequired === 'epoch'
        ? (replyBinding.appServerEpoch ?? null) === (params.appServerEpoch ?? null)
        : replyBinding.appServerEpoch == null || replyBinding.appServerEpoch === params.appServerEpoch);
    // Error replies may omit the binding for legacy compatibility, but an
    // explicit cancellation locators must match this card just like an answer.
    const bound = replyBinding && typeof replyBinding === 'object' && !Array.isArray(replyBinding) &&
      // Unknown schema fields must not hide another card's explicit identity.
      replyBinding[otherKind] == null &&
      // Native response schemas ignore this optional transport identity. Fence
      // an explicit old lifetime before consuming the current input waiter.
      (replyBinding.appServerEpoch == null || replyBinding.appServerEpoch === params.appServerEpoch) &&
      Object.entries(entry.bindings).every(([key, value]) => replyBinding[key] == null || replyBinding[key] === value);
    const allowed = kind !== 'approvalId' || !params.availableDecisions ||
      params.availableDecisions.includes(result?.decision);
    // Rust parses the whole frame as Value before typed reply validation, so
    // error data and schema-ignored keys/values must also be Unicode scalars.
    // Native rejects any method field on a response, including null/empty
    // values that the broker's legacy response routing treats as absent.
    if (response.method !== undefined || !hasWellFormedJsonStrings(response) ||
        (response.jsonrpc !== undefined && response.jsonrpc !== '2.0') ||
        (response.error !== undefined && !validError) || !reusedBindingMatches ||
        (validError && replyBinding != null && !bound) ||
        (!validError && (!bound || !isContract(TYPES.get(entry.message.method), result) ||
        (kind === 'approvalId' && !allowed)))) {
      client.send({ jsonrpc: '2.0', method: 'gateway/interaction/replyRejected',
        params: { ...entry.bindings, appServerEpoch: params.appServerEpoch, requestId: response.id, reason: 'invalid_response' } });
      return true;
    }
    // Validate pending exclusive input before its transport waiter is removed.
    // Native rejects malformed/misbound replies without settling the question;
    // the client also needs a rejection so its card can leave the busy state.
    if (!shared) return false;
    // Native interaction binding is independent of each presentation client's opt-in.
    const forwarded = validError ? response : { ...response, result: { ...result, ...entry.bindings } };
    entry.submitted = true;
    this.#broker.serverRequests.delete(response.id);
    try {
      this.#broker.forwardClientRequest(client, forwarded);
    } catch (error) {
      entry.submitted = false;
      this.#broker.serverRequests.set(response.id, entry.owner);
      throw error;
    }
    return true;
  }

  acceptsResolution(message) {
    if (!['approval/resolved', 'question/resolved'].includes(message.method)) return true;
    // Reject invalid envelopes before retiring input, retaining a terminal ID
    // or reserving recovery capacity. Older producers may omit the version.
    if (hasInvalidInteractionResolutionEnvelope(message)) return false;
    // Invalid explicit ordering cannot settle input or occupy recovery capacity.
    // Older producers may omit the sequence.
    const sequence = message.params?.sequence;
    if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 0)) return false;
    // A restored receipt may precede its prompt. Invalid lifetime identities
    // cannot retire that unseen waiter or reserve notification handoff capacity.
    const epoch = message.params?.appServerEpoch;
    if (epoch != null && (typeof epoch !== 'string' || !epoch.isWellFormed() || !/[^\s\p{White_Space}]/u.test(epoch))) return false;
    // A terminal receipt must agree with every explicit task and turn alias.
    if (hasConflictingInteractionBindings(message.params)) return false;
    // Explicit Native identity must match initialize, before any receipt can
    // retire input or enter recovery buffers. Gateway target IDs are separate.
    const sessionId = this.#broker.initializeResponse?.result?.sessionId;
    if (sessionId && message.params?.serverId !== undefined &&
        message.params.serverId !== `server-${sessionId}`) return false;
    // Conflicting interaction kinds cannot settle or retire the original input,
    // including receipts arriving before their restored prompt is known.
    const otherKind = message.method === 'question/resolved' ? 'approvalId' : 'questionId';
    if (message.params?.[otherKind] != null) return false;
    // Recovery may deliver a receipt before its prompt. Require its complete
    // identity before retiring that unseen request or reserving handoff space.
    const kind = message.method === 'question/resolved' ? 'questionId' : 'approvalId';
    if (!['threadId', 'turnId', kind].every(key =>
      typeof message.params?.[key] === 'string' && message.params[key].isWellFormed() && /[^\s\p{White_Space}]/u.test(message.params[key]))) return false;
    // A matching transport identity cannot make a malformed outcome terminal.
    // Validate before recovery buffering or recording the first receipt, or a
    // bad frame would consume the waiter and suppress the later real outcome.
    if (typeof message.params?.reason !== 'string' || !message.params.reason.isWellFormed() || !/\P{White_Space}/u.test(message.params.reason) ||
        (message.method === 'approval/resolved' && message.params?.decision !== undefined &&
          !isContract('ApprovalResponse', { decision: message.params.decision }))) return false;
    // Uncorrelatable receipts cannot settle input, but could otherwise exhaust
    // recovery capacity before the original prompt has even been restored.
    const requestId = message.params?.requestId;
    if (!(typeof requestId === 'string' && requestId.isWellFormed() && /[^\s\p{White_Space}]/u.test(requestId)) &&
        !(Number.isSafeInteger(requestId) && requestId >= 0)) return false;
    const terminal = this.#terminalRequestIds.get(message.params?.requestId);
    // A new request clears the previous terminal ID only after its own live
    // owner/turn was verified. Until then, no receipt on another task may
    // replace that terminal binding, even when it shares the same client.
    if (terminal) return false;
    const entry = this.#entries.get(message.params?.requestId) ??
      this.#retiredRequests.get(message.params?.requestId);
    const { threadId, turnId, turn, attemptId } = message.params;
    const actualAttempt = turn?.attemptId ?? attemptId;
    if (!entry) {
      // An unseen receipt can arrive during recovery. Once a retry is running,
      // a known predecessor must not retire an ID before the retry's prompt arrives.
      if (this.isSupersededAttempt(threadId, turnId, actualAttempt)) return false;
      const active = this.#broker.activeTurns.get(threadId);
      return !(active?.turnId === turnId && typeof active.attemptId === 'string' &&
        active.attemptId !== actualAttempt && this.isEndedAttempt(threadId, turnId, actualAttempt));
    }
    const expectedMethod = entry.message.method === 'question/request' ? 'question/resolved' : 'approval/resolved';
    // Retry attempts can share the task, turn and transport IDs. Compare the
    // two validated frames before retiring the waiter; legacy omission remains
    // compatible, while an explicit different attempt cannot settle this card.
    const expectedAttempt = entry.message.params.turn?.attemptId ?? entry.message.params.attemptId;
    // A transport ID does not identify the question, kind or server lifetime.
    // Keep the first terminal receipt immutable for every late reader.
    return !entry.resolved && message.method === expectedMethod &&
      (expectedAttempt == null || actualAttempt == null || expectedAttempt === actualAttempt) &&
      Object.entries(entry.bindings).every(([key, value]) => message.params?.[key] === value) &&
      (entry.message.params.appServerEpoch ?? null) === (message.params?.appServerEpoch ?? null);
  }

  *threadsForTurn(turnId) {
    for (const entries of [this.#entries, this.#retiredRequests]) {
      for (const entry of entries.values()) {
        if (entry.bindings.turnId === turnId) yield entry.bindings.threadId;
      }
    }
  }

  rememberTerminalTurn(message) {
    // Match the broker's routing precedence for both current and compatibility
    // identities, so execution and its delivered inputs close together.
    const threadId = [message.params?.threadId, message.params?.thread_id,
      message.params?.thread?.threadId, message.params?.thread?.id,
      message.params?.widget?.threadId].find(value => typeof value === 'string');
    const turnId = [message.params?.turnId, message.params?.turn_id,
      message.params?.turn?.turnId, message.params?.turn?.id].find(value => typeof value === 'string');
    if (['turn/completed', 'turn/failed', 'turn/interrupted'].includes(message.method) &&
        (threadId || turnId)) {
      if (threadId && turnId) this.#terminalTurns.add(JSON.stringify([threadId, turnId]));
      // Compatibility terminal frames may omit one identity before the first
      // prompt arrives. Preserve the known active binding before the broker
      // clears it, so a delayed request cannot reopen that completed turn.
      if (!threadId || !turnId) {
        for (const [activeThreadId, active] of this.#broker.activeTurns) {
          if ((threadId && activeThreadId !== threadId) || (turnId && active.turnId !== turnId)) continue;
          this.#terminalTurns.add(JSON.stringify([activeThreadId, active.turnId]));
        }
      }
      for (const [id, entry] of this.#entries) {
        if ((threadId && entry.bindings.threadId !== threadId) || (turnId && entry.bindings.turnId !== turnId)) continue;
        // Match thread-only or turn-only routing while retaining each delivered
        // input's complete identity so delayed cards cannot reopen it.
        if (!threadId || !turnId) this.#terminalTurns.add(JSON.stringify([entry.bindings.threadId, entry.bindings.turnId]));
        entry.turnEnded = true;
        this.#broker.serverRequests.delete(id);
      }
      while (this.#terminalTurns.size > 2048) this.#terminalTurns.delete(this.#terminalTurns.values().next().value);
    }
  }

  resolved(message) {
    this.rememberTerminalTurn(message);
    if (!['approval/resolved', 'question/resolved'].includes(message.method)) return true;
    if (!this.acceptsResolution(message)) return false;
    // Recovery can deliver a terminal receipt before its request, or after all
    // original recipients detached. Retain only bounded transport identities so
    // a late request cannot reopen the card or admit another answer.
    const requestId = message.params?.requestId;
    if (typeof requestId === 'string' || typeof requestId === 'number') {
      this.#retiredRequests.delete(requestId);
      this.#terminalRequestIds.delete(requestId);
      this.#terminalRequestIds.set(requestId, {
        threadId: message.params.threadId,
        turnId: message.params.turnId,
        appServerEpoch: message.params.appServerEpoch ?? null,
      });
      while (this.#terminalRequestIds.size > 2048)
        this.#terminalRequestIds.delete(this.#terminalRequestIds.keys().next().value);
    }
    const entry = this.#entries.get(message.params?.requestId);
    if (!entry) return true;
    entry.resolved = message;
    entry.owner = null;
    // Free the source prompt/options; the bounded native receipt is enough for late replies.
    entry.message = { id: entry.message.id, method: entry.message.method,
      params: { threadId: message.params.threadId, turnId: message.params.turnId } };
    this.#broker.serverRequests.delete(message.params.requestId);
    return true;
  }

  #retainBinding(id, entry) {
    // Refusal, capacity eviction and disconnect retire input authority, while the
    // delayed Native receipt must still match the original complete binding.
    // Retain no prompt, answer, recipient or client reference.
    this.#retiredRequests.set(id, { bindings: entry.bindings,
      message: { method: entry.message.method,
        params: { appServerEpoch: entry.message.params.appServerEpoch,
          attemptId: entry.message.params.turn?.attemptId ?? entry.message.params.attemptId } } });
    while (this.#retiredRequests.size > 2048)
      this.#retiredRequests.delete(this.#retiredRequests.keys().next().value);
  }

  detach(client) {
    for (const [id, entry] of this.#entries) {
      if (entry.owner === client) {
        entry.owner = null;
        // Disconnect closes this client's input authority, not the Native
        // outcome. Fence replay even after every recipient leaves, while still
        // accepting the eventual authoritative terminal notification.
        this.#retainBinding(id, entry);
      }
      entry.recipients.delete(client);
      if (!entry.recipients.size) this.#entries.delete(id);
    }
  }
  clear() {
    this.#entries.clear();
    this.#terminalTurns.clear();
    this.#terminalEvents.clear();
    this.#attemptTerminalSequences.clear();
    this.#supersededAttempts.clear();
    this.#terminalRequestIds.clear();
    this.#retiredRequests.clear();
    this.#reusedRequests = new WeakMap();
  }
}
