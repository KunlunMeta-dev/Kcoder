import { isContract } from '../shared/generated/validator.mjs';

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
  if (!isOfficeTaskAdoption(pending) || response.error
    || !isContract('IntegrationReply', reply)
    || !['accepted', 'completed'].includes(reply.status) || reply.error !== null
    || reply.requestId !== pending.params.requestId
    || !pending.params.operationId || reply.operationId !== pending.params.operationId
    || !isContract('IntegrationRuntimeAcceptance', task)
    || !task.threadId || !task.turnId || task.state === 'outcome_unknown') return null;
  return task;
}

/** Hold early interactions without guessing which pending adoption owns a thread. */
export class BrokerOfficeTaskOwnerHandoff {
  #held = new Map();
  #bytes = 0;

  hasRequest(id) { return this.#held.has(id); }

  capture(message, pending) {
    if (!message.method || typeof message.params?.threadId !== 'string'
      || message.id !== undefined && (!['approval/request', 'question/request'].includes(message.method)
        // Match live interaction admission without coercing legacy string IDs.
        || !((typeof message.id === 'string' && message.id.trim()) ||
          (Number.isSafeInteger(message.id) && message.id >= 0)))) return false;
    const key = message.id === undefined ? message : message.id;
    // A held transport ID already owns its first binding and candidate set.
    // Consume replays without answering that waiter or replacing its prompt.
    if (this.#held.has(key)) return true;
    const candidates = new Set([...pending].filter(isOfficeTaskAdoption));
    if (!candidates.size) return false;
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (this.#held.size >= 64 || this.#bytes + bytes > 256 * 1024) return false;
    this.#held.set(key, { message, candidates, bytes });
    this.#bytes += bytes;
    return true;
  }

  settle(pending, task, deliver, refuse) {
    const ready = [], denied = [];
    for (const [id, held] of this.#held) {
      if (!held.candidates.delete(pending)) continue;
      if (task && held.message.params.threadId === task.threadId
        && (!held.message.params.turnId || held.message.params.turnId === task.turnId)) {
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

  clear() { this.#held.clear(); this.#bytes = 0; }
  #remove(id, held) { this.#held.delete(id); this.#bytes -= held.bytes; }
}
