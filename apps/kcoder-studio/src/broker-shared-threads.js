import { BrokerResumeNotificationBuffer } from './broker-resume-notification-buffer.js';
import { allowsAsyncQuestionNotification } from './broker-async-questions.js';

// This capability belongs to the Gateway, not to the app-server protocol.
export const SHARED_THREADS_CAPABILITY = 'gatewaySharedThreadsV1';
export const SHARED_RESUME = Symbol('shared-resume');
const READS = new Set(['tools/catalog', 'agent/list', 'asyncQuestion/list']);
const EVENTS = new Set(['turn/started', 'turn/completed', 'turn/failed', 'turn/interrupted',
  'item/started', 'item/delta', 'item/completed', 'item/event',
  'thread/goal/updated', 'thread/goal/continuation', 'approval/resolved', 'question/resolved', 'asyncQuestion/changed',
  'turn/steer/applied', 'turn/steer/dropped']);

/** Shared transcript membership is separate from the controller of a turn/resources. */
export class BrokerSharedThreads {
  #broker;
  #members = new Map();
  #resumes = new Set();
  #buffer = new BrokerResumeNotificationBuffer();
  #starts = new Map();

  constructor(broker) { this.#broker = broker; }

  enabled(client) {
    return this.#broker.shareability === 'resident' && client?.initialized === true &&
      client.channel === 'runtime' && client[SHARED_THREADS_CAPABILITY] === true;
  }

  canJoin(client, threadId, owner) {
    return this.#broker.shareability === 'resident' && client?.initialized === true &&
      client.channel === 'runtime' && (!owner || owner.channel === 'runtime') &&
      !this.#broker.ephemeralThreadOwners.has(threadId) &&
      (this.enabled(client) || this.#members.has(threadId));
  }

  has(threadId, client) { return this.#members.get(threadId)?.has(client) === true; }
  members(threadId) { return this.#members.get(threadId) ?? []; }
  allowsRead(threadId, client, method) { return this.has(threadId, client) && READS.has(method); }

  join(threadId, client) {
    if (this.#broker.ephemeralThreadOwners.has(threadId)) return;
    if (!this.#members.has(threadId) && !this.enabled(client)) return;
    let members = this.#members.get(threadId);
    if (!members) this.#members.set(threadId, members = new Set());
    const controller = this.#broker.threadOwners.get(threadId);
    if (controller && this.#broker.clients.has(controller)) members.add(controller);
    members.add(client);
  }

  pendingResume(pending) { this.#resumes.add(pending); }
  abandon(pending) { this.#resumes.delete(pending); this.#buffer.discard(pending); }
  finishResume(pending) {
    this.#resumes.delete(pending);
    return this.#buffer.take(pending);
  }

  capture(threadId, message) {
    if (!EVENTS.has(message.method)) return;
    // Preserve terminal interaction bindings before live routing clears the
    // active turn, including when recovery buffers this notification.
    this.#broker.sharedInteractions.rememberTerminalTurn(message);
    // Handoff delivery bypasses live routing. Reject mismatched and duplicate
    // receipts before they can enter a queue or consume its bounded capacity.
    if (!this.#broker.sharedInteractions.acceptsResolution(message)) return;
    for (const pending of this.#resumes) {
      // Undeliverable question updates must not consume this viewer's handoff budget.
      if (!allowsAsyncQuestionNotification(message, pending.client,
        this.#broker.initializeResponse?.result?.capabilities?.experimental)) continue;
      if (pending.claimedThreadId === threadId && !pending.expired &&
          this.#broker.clients.has(pending.client)) this.#buffer.capture(pending, message);
    }
  }

  notify(threadId, message, owner) {
    if (!EVENTS.has(message.method)) return;
    for (const client of this.#members.get(threadId) ?? []) {
      if (client !== owner && this.#broker.clients.has(client)) this.#broker.sendServerNotification(client, message);
    }
  }

  admissionError(threadId, client, method) {
    if (method === 'thread/resume' && this.canJoin(client, threadId, this.#broker.threadOwners.get(threadId)) && !this.has(threadId, client)) {
      const entries = [...this.#members.values()];
      if (entries.reduce((count, members) => count + members.size, 0) >= 1024 ||
          entries.filter(members => members.has(client)).length >= 64 ||
          (this.#members.get(threadId)?.size ?? 0) >= 32)
        return 'Too many shared conversations are open; close an unused conversation first';
    }
    if (!this.has(threadId, client)) return null;
    if (['thread/dispose', 'thread/runtime/handoff/release'].includes(method) && this.#members.get(threadId).size > 1)
      return 'This conversation is still open on another device; close only this client connection';
    if (method !== 'turn/start') return null;
    const active = this.#broker.activeTurns.get(threadId);
    if ((active && active.owner !== client) || this.#starts.has(threadId) ||
        (this.#broker.activeAutomationThreads.has(threadId) && !active))
      return 'Another device is responding in this conversation; wait for its turn to finish';
    return null;
  }

  start(pending) {
    const threadId = pending.params?.threadId;
    if (pending.method !== 'turn/start' || !this.has(threadId, pending.client)) return;
    pending.sharedPreviousOwner = this.#broker.threadOwners.get(threadId);
    this.#starts.set(threadId, pending);
    // Establish the turn's controller before any upstream approval or event can arrive.
    this.#broker.threadOwners.set(threadId, pending.client);
    if (pending.sharedPreviousOwner && pending.sharedPreviousOwner !== pending.client &&
        this.#broker.initializeResponse?.result?.capabilities?.experimental?.mcpAppsV1 === true)
      this.#broker.sendInternalRequest('mcp/apps/revoke', { threadId });
  }

  response(pending, response) {
    const threadId = pending.params?.threadId;
    if (this.#starts.get(threadId) !== pending) return;
    this.#starts.delete(threadId);
    const terminalReceipt = ['completed', 'failed', 'interrupted'].includes(response.result?.turn?.status);
    // An earlier async answer receipt can arrive during this reservation. The
    // confirmed turn must bind its interactions to its own input client again.
    if (!response.error && !terminalReceipt && typeof response.result?.turn?.id === 'string' &&
        response.result.turn.id && this.#broker.clients.has(pending.client))
      this.#broker.threadOwners.set(threadId, pending.client);
    // Reading a completed retry receipt releases control just like a rejected
    // admission; it cannot own a newer turn started by an async answer.
    const owner = this.#broker.threadOwners.get(threadId);
    if ((response.error || terminalReceipt) && (!owner || owner === pending.client)) {
      // The same client may have admitted an async answer while this start was
      // reserved. Its confirmed active turn owns interactions after rejection.
      const previous = this.#broker.activeTurns.get(threadId)?.owner ?? pending.sharedPreviousOwner;
      if (previous && this.#broker.clients.has(previous)) this.#broker.threadOwners.set(threadId, previous);
      else this.#broker.threadOwners.delete(threadId);
    }
  }

  detach(client) {
    for (const [threadId, members] of this.#members) {
      members.delete(client);
      if (!members.size) this.#members.delete(threadId);
    }
    for (const pending of this.#resumes) if (pending.client === client) this.abandon(pending);
  }

  handoff(client) {
    for (const [threadId, members] of this.#members) {
      if (this.#broker.threadOwners.get(threadId) !== client || this.#starts.has(threadId)) continue;
      const next = [...members].find(peer => peer !== client && this.#broker.clients.has(peer));
      if (!next) continue;
      // A remaining viewer can control its next turn. The disconnected
      // client's active turn and interactions keep their original owner.
      this.#broker.threadOwners.set(threadId, next);
    }
  }

  leave(threadId, client) {
    const members = this.#members.get(threadId);
    members?.delete(client);
    if (members?.size === 0) this.#members.delete(threadId);
  }

  delete(threadId) { this.#members.delete(threadId); }
  clear() { this.#members.clear(); this.#resumes.clear(); this.#buffer.clear(); this.#starts.clear(); }
}
