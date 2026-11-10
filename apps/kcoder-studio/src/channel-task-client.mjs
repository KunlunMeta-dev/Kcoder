import { toolRestrictions as validateToolRestrictions } from '../../kcoder-channel-host/src/channels/tool-restrictions.mjs';

const problem = (code, accepted) => Object.assign(new Error(code), { code, accepted });

/** An ordinary resident-task client owned by the Gateway's channel manager. */
export class ChannelTaskClient {
  constructor(broker) {
    this.broker = broker;
    this.pending = new Map();
    this.turns = new Map();
    this.waiting = new Map();
    this.observers = new Map();
    this.sequence = 0;
    this.client = { channel: 'runtime', send: message => { this.receive(message); return true; },
      pause() {}, resume() {}, close: () => this.close() };
    broker.attach(this.client);
  }

  async initialize(timeoutMs = 60000) {
    this.initializing ??= this.request('initialize', { protocolVersion: '2026-07-27',
      clientInfo: { name: 'kcoder-channels', version: '1' }, capabilities: { experimental: {
        gatewaySharedThreadsV1: true, sessionLifetimeV1: true, turnReceiptsV1: true,
      } } }, timeoutMs).then(result => {
      if (result.capabilities?.experimental?.unattendedTurnsV1 !== true || result.capabilities?.experimental?.channelToolRestrictionsV1 !== true) {
        throw problem('CHANNEL_TASK_BACKEND_UPDATE_REQUIRED', false);
      }
    });
    return this.initializing;
  }

  request(method, params, timeoutMs = 60000) {
    if (this.closed) return Promise.reject(problem('CHANNEL_TASK_DISCONNECTED'));
    const id = `channels-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(problem('CHANNEL_TASK_REQUEST_UNKNOWN')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.broker.receive(this.client, JSON.stringify({ jsonrpc: '2.0', id, method, params })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(problem('CHANNEL_TASK_REQUEST_FAILED')); }
    });
  }

  receive(message) {
    if (message.id !== undefined && !message.method) {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) {
        // Keep a closed diagnostic code for read-only ownership failures, never raw backend paths.
        const workspaceMismatch = request.method === 'thread/read' && [
          'persisted thread belongs to another workspace', 'thread metadata belongs to another workspace',
        ].includes(message.error.message);
        request.reject(problem(workspaceMismatch ? 'CHANNEL_TASK_WORKSPACE_MISMATCH' : 'CHANNEL_TASK_REJECTED',
          request.method === 'turn/start' ? undefined : false));
      } else request.resolve(message.result);
      return;
    }
    const threadId = message.params?.threadId;
    this.observers.get(threadId)?.(message, { channelInput: this.turns.has(threadId) });
    if (message.method !== 'turn/completed') return;
    const params = message.params;
    this.waiting.get(params?.threadId)?.();
    const active = this.turns.get(params?.threadId);
    if (!active || (active.turnId && active.turnId !== (params.turnId ?? params.turn?.id))) return;
    // Notifications may precede turn/start's response. Buffer only this request's bounded turn events.
    if (!active.turnId) {
      if (active.buffer.length >= 32) return active.reject(problem('CHANNEL_TASK_EVENT_CAPACITY'));
      active.buffer.push(message); return;
    }
    if (params.error || !['completed', 'complete'].includes(params.turn?.status)) {
      active.reject(Object.assign(problem('CHANNEL_TASK_TURN_FAILED', true), { outcome: 'failed' }));
    } else active.resolve({ threadId: params.threadId, turnId: active.turnId, attemptId: params.turn?.attemptId });
  }

  async run({ id, target, event, signal, onAccepted, toolRestrictions }) {
    const policy = validateToolRestrictions(toolRestrictions);
    signal.throwIfAborted();
    await this.attachTask(target.threadId);
    await this.waitUntilIdle(target.threadId, signal);
    signal.throwIfAborted();
    if (this.turns.has(target.threadId)) throw problem('CHANNEL_TASK_BUSY', false);
    let resolve, reject;
    const completion = new Promise((yes, no) => { resolve = yes; reject = no; });
    // A completion rejection can race the submission reply; attach its observer immediately.
    completion.catch(() => {});
    const turn = { buffer: [], resolve, reject };
    this.turns.set(target.threadId, turn);
    const abort = () => reject(problem('CHANNEL_TASK_RESPONSE_UNKNOWN'));
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => reject(problem('CHANNEL_TASK_COMPLETION_UNKNOWN')), 15 * 60 * 1000);
    try {
      // The stable source identity is also the app-server's existing submission receipt key.
      const accepted = await this.request('turn/start', { threadId: target.threadId,
        clientMessageId: `channel-${id}`, unattended: true, channelToolRestrictions: policy,
        input: [{ type: 'text', text: event.text }] });
      if (!accepted.turn?.id) throw problem('CHANNEL_TASK_ACCEPTANCE_UNKNOWN');
      turn.turnId = accepted.turn.id;
      onAccepted?.(accepted.turn);
      for (const message of turn.buffer.splice(0)) this.receive(message);
      if (signal.aborted) abort();
      const receipt = await completion;
      return { ...receipt, text: await this.resultText(receipt) };
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      this.turns.delete(target.threadId);
    }
  }

  async attachTask(threadId) {
    await this.initialize();
    await this.request('thread/resume', { threadId });
    // The connected channel manager is a runtime client; no browser needs to remain open.
    await this.request('gateway/thread/attach', { threadId, viewId: 'channel-manager' });
  }

  async watch(threadId, observer) {
    await this.attachTask(threadId);
    // Resume notifications precede this boundary and must not replay an older turn.
    this.observers.set(threadId, observer);
  }

  async readTurn(source) {
    const messages = []; let beforeCursor;
    for (let page = 0; page < 20; page++) {
      const result = await this.request('thread/read', { threadId: source.target.threadId, limit: 200,
        ...(beforeCursor ? { beforeCursor } : {}) });
      messages.unshift(...result.messages.filter(row => row.turnId === source.turnId));
      if (!result.hasMoreBefore || result.messages.some(row => row.turnId === source.turnId && row.role === 'user')) break;
      if (!result.beforeCursor || result.beforeCursor === beforeCursor || page === 19) throw problem('CHANNEL_TASK_RESULT_INCOMPLETE');
      beforeCursor = result.beforeCursor;
    }
    const user = messages.find(row => row.role === 'user');
    if (!user?.clientMessageId) return { state: 'unknown' };
    const { receipt } = await this.request('turn/receipt/read', {
      threadId: source.target.threadId, clientMessageId: user.clientMessageId,
    });
    if (!receipt || receipt.turnId !== source.turnId ||
      (source.attemptId && receipt.attemptId !== source.attemptId)) return { state: 'unknown' };
    if (receipt.status !== 'completed') return { state: receipt.status };
    const selected = messages.filter(row => !receipt.attemptId || row.role === 'user' || row.attemptId === receipt.attemptId);
    if (selected.some(row => row.contentTruncated)) throw problem('CHANNEL_TASK_RESULT_TRUNCATED');
    return { state: 'completed', user: user.content,
      assistant: selected.filter(row => row.role === 'assistant').map(row => row.content).join('\n\n') };
  }

  async waitUntilIdle(threadId, signal) {
    const busy = () => this.broker.activeTurns?.has(threadId) || this.broker.activeAutomationThreads?.has(threadId);
    while (busy()) {
      if (this.closed) throw problem('CHANNEL_TASK_NOT_SUBMITTED', false);
      signal.throwIfAborted();
      await new Promise((resolve, reject) => {
        const finish = error => {
          clearTimeout(timer); signal.removeEventListener('abort', abort); this.waiting.delete(threadId);
          error ? reject(error) : resolve();
        };
        const abort = () => finish(problem('CHANNEL_TASK_NOT_SUBMITTED', false));
        const timer = setTimeout(() => finish(problem('CHANNEL_TASK_BUSY', false)), 15 * 60 * 1000);
        this.waiting.set(threadId, () => finish());
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }

  async resultText(receipt) {
    const text = []; let beforeCursor;
    for (let page = 0; page < 20; page++) {
      const result = await this.request('thread/read', { threadId: receipt.threadId, limit: 200,
        ...(beforeCursor ? { beforeCursor } : {}) });
      const messages = result.messages.filter(message => message.turnId === receipt.turnId
        && (!receipt.attemptId || message.attemptId === receipt.attemptId) && message.role === 'assistant');
      if (messages.some(message => message.contentTruncated)) throw problem('CHANNEL_TASK_RESULT_TRUNCATED', true);
      text.unshift(...messages.map(message => message.content));
      // The original user input bounds this turn; older task history is unrelated to this reply.
      if (!result.hasMoreBefore || result.messages.some(message => message.turnId === receipt.turnId && message.role === 'user')) {
        return text.join('\n\n');
      }
      if (!result.beforeCursor || result.beforeCursor === beforeCursor) break;
      beforeCursor = result.beforeCursor;
    }
    throw problem('CHANNEL_TASK_RESULT_INCOMPLETE', true);
  }

  async recover({ id, target, signal }) {
    signal.throwIfAborted(); await this.initialize();
    const { receipt } = await this.request('turn/receipt/read', { threadId: target.threadId, clientMessageId: `channel-${id}` });
    if (!receipt) return { state: 'unknown' };
    if (receipt.status === 'completed') return { state: 'completed', ...receipt, text: await this.resultText(receipt) };
    return { ...receipt, state: ['failed', 'interrupted'].includes(receipt.status) ? 'failed' : 'unknown' };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.observers.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.reject(problem('CHANNEL_TASK_DISCONNECTED'));
    }
    this.pending.clear();
    for (const turn of this.turns.values()) turn.reject(problem('CHANNEL_TASK_RESPONSE_UNKNOWN'));
    for (const wake of this.waiting.values()) wake();
    this.broker.detach(this.client);
  }
}
