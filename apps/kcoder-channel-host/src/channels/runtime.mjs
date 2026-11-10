import { ChannelStore } from './store.mjs';
import { ChannelWorker } from './worker-client.mjs';
import { prepareChannelDestination } from '../adapters/contract.mjs';
import { channelMessageContent, connectionFeatures } from '../adapters/feature-options.mjs';

const UNBOUND_NOTICE_INTERVAL_MS = 60_000;

const failure = error => ({ code: /^[A-Z][A-Z0-9_]{1,100}$/.test(error?.code ?? error?.message)
  ? error.code ?? error.message : 'CHANNEL_OPERATION_FAILED' });
const sameTarget = (left, right) => left && right &&
  left.serverId === right.serverId && left.workspacePath === right.workspacePath && left.threadId === right.threadId
  && left.loginOwner === right.loginOwner;

/** Platform authentication happens at connection startup. Routing is an ordinary chat/task mapping. */
export class ChannelRuntime {
  constructor({ directory, settingsDirectory, tasks, workerFactory = (...args) => new ChannelWorker(...args) }) {
    if (typeof tasks?.run !== 'function' || typeof tasks?.recover !== 'function') throw new Error('CHANNEL_TASK_EXECUTOR_REQUIRED');
    this.store = new ChannelStore(directory, { settingsDirectory });
    // Only a manager restart reconciles sends; SDK store readers do not.
    this.store.recoverUnconfirmedOutputs();
    this.tasks = tasks;
    this.workerFactory = workerFactory;
    this.workers = new Map();
    this.starting = new Map();
    this.queues = new Map();
    this.jobs = new Set();
    this.inputJobs = new Set();
    this.controller = new AbortController();
  }

  async start() {
    const results = await Promise.allSettled(this.store.connections().filter(row => row.enabled).map(row => this.connect(row.id)));
    for (const input of this.store.unsettledInputs()) this.schedule(input, true);
    for (const input of this.store.pendingInputs()) this.schedule(input);
    this.recoveryTimer ??= setInterval(() => {
      if (!this.controller.signal.aborted)
        for (const input of this.store.unsettledInputs()) this.schedule(input, true);
    }, 5000);
    this.recoveryTimer.unref?.();
    return results.map((result, index) => ({ index, state: result.status,
      ...(result.status === 'rejected' ? failure(result.reason) : {}) }));
  }

  async connect(id) {
    this.controller.signal.throwIfAborted();
    if (this.starting.has(id)) return this.starting.get(id);
    const current = this.workers.get(id);
    if (current && current.connectionState() !== 'stopped') return current;
    const connection = this.store.connection(id), credentials = this.store.credentials(id);
    if (!connection || !credentials) throw new Error('CHANNEL_CONNECTION_NOT_CONFIGURED');
    const worker = this.workerFactory(connection, credentials, this.store.directory);
    const starting = (async () => {
      if (current) await current.stop();
      // Publish the owned worker before SDK callbacks can acknowledge initial long-poll input.
      this.workers.set(id, worker);
      try {
        await worker.start(event => this.receive(id, event, worker));
        this.controller.signal.throwIfAborted();
        this.store.setEnabled(id, true);
        for (const output of this.store.pendingOutputs(id)) await this.dispatchOutput(output);
        return worker;
      } catch (error) {
        await worker.stop();
        if (this.workers.get(id) === worker) this.workers.delete(id);
        throw error;
      }
    })();
    this.starting.set(id, starting);
    try { return await starting; } finally { this.starting.delete(id); }
  }

  async disconnect(id) {
    await this.starting.get(id)?.catch(() => {});
    this.store.setEnabled(id, false);
    const worker = this.workers.get(id);
    this.workers.delete(id);
    await worker?.stop();
  }

  bind(chatId, target, expectedRevision) { return this.store.bind(chatId, target, expectedRevision); }
  unbind(chatId, expectedRevision) { this.store.unbind(chatId, expectedRevision); }

  receive(id, event, source) {
    this.controller.signal.throwIfAborted();
    if (!source || this.workers.get(id) !== source) throw new Error('CHANNEL_CONNECTION_STOPPED');
    let notice;
    const input = this.store.transaction(() => {
      const input = this.store.receive(id, { ...event, receivedAtMs: Date.now() });
      if (!input.duplicate && input.state === 'unbound') notice = this.prepareUnboundNotice(input);
      return input;
    });
    if (!input.duplicate && input.state === 'pending') this.schedule(input);
    if (notice) {
      const operation = Promise.resolve().then(() => this.dispatchOutput(notice));
      this.jobs.add(operation);
      operation.finally(() => this.jobs.delete(operation)).catch(() => {});
    }
    // The SDK gets this acknowledgement after SQLite commits, without waiting for a model.
    return { accepted: true, inputId: input.id, state: input.state, duplicate: input.duplicate };
  }

  prepareUnboundNotice(input) {
    const revision = this.store.bindingRevision(input.chatId);
    if (this.store.hasRecentUnboundNotice(input.chatId, revision, Date.now() - UNBOUND_NOTICE_INTERVAL_MS)) return null;
    const chat = this.store.chat(input.chatId), connection = this.store.connection(chat.connectionId);
    const reference = `${connection.label} · ${chat.range.chatId.slice(-8)}${chat.range.topicId ? ` / ${String(chat.range.topicId).slice(-8)}` : ''}`;
    const text = String(connection.configuration.locale ?? 'zh-CN').startsWith('zh')
      ? `已收到消息，但此聊天尚未绑定 KCoder 任务，暂未执行。\n请在 KCoder 中打开目标任务，选择「绑定通道」并绑定本聊天。绑定后请重新发送消息。\n连接 / 聊天：${reference}`
      : `Message received, but this chat is not bound to a KCoder task, so it has not been executed.\nOpen the intended task in KCoder, choose "Bind channel", and select this chat. Send your message again after binding.\nConnection / chat: ${reference}`;
    return this.prepareOutput(`unbound-${input.id}`, input.chatId, { text },
      { event: input.event, bindingRevision: revision, bindingRequired: true });
  }

  schedule(input, recover = false) {
    if (this.inputJobs.has(input.id)) return;
    this.inputJobs.add(input.id);
    const key = JSON.stringify([input.target.serverId, input.target.workspacePath ?? null, input.target.threadId, input.target.loginOwner ?? null]);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => recover ? this.recover(input.id) : this.execute(input.id));
    this.queues.set(key, operation); this.jobs.add(operation);
    operation.finally(() => {
      this.jobs.delete(operation);
      this.inputJobs.delete(input.id);
      if (this.queues.get(key) === operation) this.queues.delete(key);
    }).catch(() => {});
  }

  current(input) {
    const binding = this.store.binding(input.chatId);
    return binding?.revision === input.bindingRevision && sameTarget(binding.target, input.target);
  }

  async execute(id) {
    if (this.controller.signal.aborted) return;
    const input = this.store.inbox(id), chat = this.store.chat(input.chatId);
    if (!this.current(input) || !this.workers.has(chat.connectionId)) {
      this.store.retirePending(id); return;
    }
    if (!this.store.claimInput(id)) return;
    try {
      if (input.event.attachments?.length) throw Object.assign(new Error('CHANNEL_ATTACHMENT_TRANSFER_UNAVAILABLE'), { accepted: false });
      // Existing app-server queues, model configuration and task tool policy remain authoritative.
      const result = await this.tasks.run({ id, target: input.target, event: input.event,
        toolRestrictions: this.store.settings().toolRestrictions,
        signal: this.controller.signal, onAccepted: receipt => this.store.recordAcceptance(id, receipt) });
      // Commit the result and its reply intent together. A crash cannot lose a completed task's reply.
      const output = this.store.transaction(() => {
        this.store.settleInput(id, 'completed', result);
        return this.replyOutput(input, result);
      });
      if (output) await this.dispatchOutput(output);
    } catch (error) {
      // A lost task response is not evidence that the original turn did not execute.
      this.store.settleInput(id, error?.accepted === false || error?.outcome === 'failed' ? 'failed' : 'unknown', failure(error));
    }
  }

  async recover(id) {
    if (this.controller.signal.aborted) return;
    const input = this.store.inbox(id), chat = this.store.chat(input.chatId);
    try {
      // Receipt lookup never re-submits an input, including after a Gateway or SDK restart.
      const result = await this.tasks.recover({ id, target: input.target, signal: this.controller.signal });
      const output = this.store.transaction(() => {
        this.store.recoverInput(id, result.state, result);
        return result.state === 'completed' ? this.replyOutput(input, result) : null;
      });
      if (output) await this.dispatchOutput(output);
    } catch (error) { this.store.recoverInput(id, 'unknown', failure(error)); }
  }

  async send(id, chatId, content, { event, bindingRevision } = {}) {
    this.controller.signal.throwIfAborted();
    return this.dispatchOutput(this.prepareOutput(id, chatId, content, { event, bindingRevision }));
  }

  replyOutput(input, result) {
    if (!this.current(input) || typeof result?.text !== 'string' || !result.text.length) return null;
    return this.prepareOutput(`reply-${input.id}`, input.chatId, { text: result.text },
      { event: input.event, bindingRevision: input.bindingRevision });
  }

  prepareOutput(id, chatId, content, { event, bindingRevision, bindingRequired = false } = {}) {
    const chat = this.store.chat(chatId);
    if (!chat) throw new Error('CHANNEL_CHAT_NOT_FOUND');
    const connection = this.store.connection(chat.connectionId);
    const existing = this.store.output(id);
    const messageFormat = existing ? existing.payload.messageFormat ?? 'auto'
      : connectionFeatures(chat.range.platform, connection.configuration.features).messageFormat;
    content = channelMessageContent(content, messageFormat);
    if (existing) {
      if (existing.chatId !== chatId || JSON.stringify(existing.payload.content) !== JSON.stringify(content)) throw new Error('CHANNEL_OUTPUT_ID_CONFLICT');
      return existing;
    }
    if (bindingRevision !== undefined && this.store.bindingRevision(chatId) !== bindingRevision) throw new Error('CHANNEL_BINDING_CHANGED');
    const source = event ?? chat.lastEvent;
    const destination = prepareChannelDestination(chat.range.platform,
      { ...chat.range, channelId: chat.connectionId, botId: source?.botId, conversationId: chat.range.chatId,
      externalSubjectId: source?.senderId, platformRoute: source?.platformRoute,
      replyRef: source?.replyRef, replyMessageId: source?.sourceMessageId ?? source?.eventId },
      { event: source ?? {}, now: Date.now(),
        replySequence: this.store.replySequence(chatId, source?.sourceMessageId ?? source?.eventId) });
    return this.store.enqueueOutput(id, chatId, { destination, content, messageFormat, createdAtMs: Date.now(),
      ...(bindingRequired ? { bindingRequired: true } : {}),
      ...(bindingRevision === undefined ? {} : { bindingRevision }) });
  }

  async dispatchOutput(output) {
    const { id, chatId, payload } = output;
    if (output.state !== 'pending') return output;
    // Recheck at dispatch too: a reconnect or an awaited history read may outlive a settings change.
    if (payload.source?.role && !this.store.settings().mirrorClientTurns) {
      this.store.cancelPendingClientMirrors();
      return this.store.output(id);
    }
    const chat = this.store.chat(chatId), worker = this.workers.get(chat.connectionId);
    // Offline connections retain unsent intents; a claimed/unknown send is never retried.
    if (!worker) return output;
    if (!this.store.claimOutput(id)) return this.store.output(id);
    if (payload.bindingRevision !== undefined && this.store.bindingRevision(chatId) !== payload.bindingRevision) {
      this.store.settleOutput(id, 'failed', { code: 'CHANNEL_BINDING_CHANGED' });
      return this.store.output(id);
    }
    if (payload.bindingRequired && Date.now() - payload.createdAtMs >= UNBOUND_NOTICE_INTERVAL_MS) {
      this.store.settleOutput(id, 'failed', { code: 'CHANNEL_BINDING_NOTICE_EXPIRED' });
      return this.store.output(id);
    }
    try {
      const receipt = await worker.send({ destination: payload.destination, content: payload.content }, { deliveryId: id });
      this.store.settleOutput(id, receipt?.state === 'accepted' ? 'accepted' : 'failed', receipt ?? { code: 'PLATFORM_RECEIPT_MISSING' });
    } catch (error) {
      this.store.settleOutput(id, error?.externalOutcome === 'failed' ? 'failed' : 'unknown', failure(error));
    }
    return this.store.output(id);
  }

  async close() {
    this.controller.abort();
    clearInterval(this.recoveryTimer);
    await Promise.allSettled(this.starting.values());
    await Promise.allSettled([...this.workers.values()].map(worker => worker.stop()));
    this.workers.clear();
    await Promise.allSettled(this.jobs);
    this.store.close();
  }
}
