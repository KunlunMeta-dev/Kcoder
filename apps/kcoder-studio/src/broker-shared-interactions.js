import { isContract } from '../shared/generated/validator.mjs';
import { isOfficeTaskAdoption } from './broker-office-task-owner.js';

const TYPES = new Map([['approval/request', 'ApprovalResponse'], ['question/request', 'QuestionResponse']]);
const MAX_INTERACTIONS = 512;

export function hasConflictingTurnIdentity(message) {
  if (!['turn/started', 'turn/completed', 'turn/failed', 'turn/interrupted'].includes(message.method)) return false;
  // A request cannot certify turn lifecycle, even when its task/turn fields match.
  if (message.id !== undefined) return true;
  return hasConflictingInteractionBindings(message.params);
}

function hasConflictingInteractionBindings(params) {
  // Compatibility aliases may supplement an identity, but cannot contradict it.
  // Fence before routing, recovery buffering or retiring the original input.
  // An invalid explicit locator must not degrade into an omitted legacy field
  // and close every input in the task. Nullable optional locators stay compatible.
  const conflicts = values => values.some(value => value != null &&
    (typeof value !== 'string' || !value.trim())) ||
    new Set(values.filter(value => typeof value === 'string')).size > 1;
  return conflicts([params?.threadId, params?.thread_id, params?.thread?.threadId,
    params?.thread?.id, params?.widget?.threadId, params?.turn?.threadId]) ||
    conflicts([params?.turnId, params?.turn_id, params?.turn?.turnId, params?.turn?.id]);
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

/** Viewers observe the original interaction; only its requesting client replies. */
export class BrokerSharedInteractions {
  #broker;
  #entries = new Map();
  #terminalTurns = new Set();
  #terminalRequestIds = new Set();
  #retiredRequests = new Map();
  constructor(broker) { this.#broker = broker; }

  rejectUnownedRequest(message, ownerUnavailable = false) {
    if (!TYPES.has(message.method)) return false;
    // Match reply/receipt kind checks before ambiguous input reserves a waiter.
    const otherKind = message.method === 'question/request' ? 'approvalId' : 'questionId';
    if (message.params?.[otherKind] != null) return true;
    // An explicit unusable card identity cannot reserve the transport waiter.
    // Preserve legacy omission, but never reinterpret an invalid value as it.
    const field = message.method === 'question/request' ? 'questionId' : 'approvalId';
    const identity = message.params?.[field];
    if (identity !== undefined && (typeof identity !== 'string' || !identity.trim())) return true;
    // Invalid lifetimes cannot reserve a waiter that later valid input needs,
    // or produce a refusal response addressed to that original waiter.
    const epoch = message.params?.appServerEpoch;
    if (epoch != null && (typeof epoch !== 'string' || !epoch.trim())) return true;
    // Reject ambiguous first bindings without settling a possibly unrelated waiter.
    if (hasConflictingInteractionBindings(message.params)) return true;
    // Match terminal receipt IDs before opening a card or reserving capacity.
    // Do not reply to an invalid ID: it cannot identify the original waiter.
    if (!(typeof message.id === 'string' && message.id.trim()) &&
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
    if (this.#entries.has(message.id) || this.#terminalRequestIds.has(message.id) ||
        this.#retiredRequests.has(message.id)) return true;
    const bindings = interactionBindings(message);
    const { threadId, turnId } = bindings;
    if (!threadId) return false;
    const active = this.#broker.activeTurns.get(threadId);
    // Admission events can precede their answer receipt after its client left.
    // If no current owner or pending adoption can receive this interaction,
    // retain the refusal just like every other lifecycle rejection below.
    const ownerless = ownerUnavailable || !this.#broker.ownerFor(message) &&
      !(this.#broker.automationThreads.has(threadId) && [...this.#broker.clients].some(client =>
        client.channel === 'runtime' && client.initialized && !client.nativeManagementOnly)) &&
      ![...this.#broker.pending.values()].some(isOfficeTaskAdoption);
    if (this.#broker.threadDrains.has(threadId) ||
        this.#terminalTurns.has(JSON.stringify([threadId, turnId])) ||
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
      recipients: new Set([owner]), submitted: false, resolved: null };
    this.#entries.set(message.id, entry);
    for (const client of this.#broker.sharedThreads.members(bindings.threadId)) {
      if (client === owner || !this.#broker.clients.has(client)) continue;
      entry.recipients.add(client);
      client.send(message);
    }
  }

  replay(threadId, client) {
    for (const entry of this.#entries.values()) {
      if (entry.bindings.threadId !== threadId || !entry.owner || entry.resolved || entry.turnEnded || !this.#broker.sharedThreads.has(threadId, client)) continue;
      entry.recipients.add(client);
      client.send(entry.message);
    }
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
    // Outer interaction IDs do not bind the answer map's item IDs. Refuse
    // foreign items before either shared or exclusive forwarding consumes the
    // original waiter. Partial answers and freeform values keep their contract.
    if (entry.message.method === 'question/request' &&
        this.#broker.serverRequests.get(response.id) === client &&
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
    } else if (this.#broker.serverRequests.get(response.id) !== client) {
      // Submitted exclusive replies retain the original Native receipt/replay path.
      return false;
    }
    const params = entry.message.params;
    const kind = entry.message.method === 'approval/request' ? 'approvalId' : 'questionId';
    const otherKind = kind === 'approvalId' ? 'questionId' : 'approvalId';
    const result = response.result;
    const validError = response.error && Number.isSafeInteger(response.error.code) && typeof response.error.message === 'string' && result === undefined;
    const bound = result && typeof result === 'object' &&
      // Unknown schema fields must not hide another card's explicit identity.
      result[otherKind] == null &&
      // Native response schemas ignore this optional transport identity. Fence
      // an explicit old lifetime before consuming the current input waiter.
      (result.appServerEpoch == null || result.appServerEpoch === params.appServerEpoch) &&
      Object.entries(entry.bindings).every(([key, value]) => result[key] == null || result[key] === value);
    const allowed = !params.availableDecisions || params.availableDecisions.includes(result?.decision);
    if ((response.jsonrpc !== undefined && response.jsonrpc !== '2.0') ||
        (response.error !== undefined && !validError) ||
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
    // Reject request envelopes before retiring input or retaining a terminal ID.
    if (message.id !== undefined) return false;
    // A restored receipt may precede its prompt. Invalid lifetime identities
    // cannot retire that unseen waiter or reserve notification handoff capacity.
    const epoch = message.params?.appServerEpoch;
    if (epoch != null && (typeof epoch !== 'string' || !epoch.trim())) return false;
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
      typeof message.params?.[key] === 'string' && message.params[key].trim())) return false;
    // A matching transport identity cannot make a malformed outcome terminal.
    // Validate before recovery buffering or recording the first receipt, or a
    // bad frame would consume the waiter and suppress the later real outcome.
    if (typeof message.params?.reason !== 'string' ||
        (message.method === 'approval/resolved' && message.params?.decision !== undefined &&
          !isContract('ApprovalResponse', { decision: message.params.decision }))) return false;
    // Uncorrelatable receipts cannot settle input, but could otherwise exhaust
    // recovery capacity before the original prompt has even been restored.
    const requestId = message.params?.requestId;
    if (!(typeof requestId === 'string' && requestId.trim()) &&
        !(Number.isSafeInteger(requestId) && requestId >= 0)) return false;
    if (this.#terminalRequestIds.has(message.params?.requestId)) return false;
    const entry = this.#entries.get(message.params?.requestId) ??
      this.#retiredRequests.get(message.params?.requestId);
    // Restored clients may observe a receipt without a locally pending request.
    if (!entry) return true;
    const expectedMethod = entry.message.method === 'question/request' ? 'question/resolved' : 'approval/resolved';
    // A transport ID does not identify the question, kind or server lifetime.
    // Keep the first terminal receipt immutable for every late reader.
    return !entry.resolved && message.method === expectedMethod &&
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
      this.#terminalRequestIds.add(requestId);
      while (this.#terminalRequestIds.size > 2048)
        this.#terminalRequestIds.delete(this.#terminalRequestIds.values().next().value);
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
        params: { appServerEpoch: entry.message.params.appServerEpoch } } });
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
  clear() { this.#entries.clear(); this.#terminalTurns.clear(); this.#terminalRequestIds.clear(); this.#retiredRequests.clear(); }
}
