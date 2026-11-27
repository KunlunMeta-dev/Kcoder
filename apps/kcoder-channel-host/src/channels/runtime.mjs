import { ChannelStore } from './store.mjs';
import { ChannelWorker } from './worker-client.mjs';
import { prepareChannelDestination } from '../adapters/contract.mjs';
import { channelMessageContent, connectionFeatures } from '../adapters/feature-options.mjs';
import { isDeepStrictEqual } from 'node:util';
import { PLATFORM_IDENTITY_FIELD } from '../validation.mjs';

const UNBOUND_NOTICE_INTERVAL_MS = 60_000;

const failure = error => ({ code: /^[A-Z][A-Z0-9_]{1,100}$/.test(error?.code ?? error?.message)
  ? error.code ?? error.message : 'CHANNEL_OPERATION_FAILED' });
const sameTarget = (left, right) => left && right &&
  left.serverId === right.serverId && left.workspacePath === right.workspacePath && left.threadId === right.threadId
  && left.loginOwner === right.loginOwner;
const workerConfiguration = value => { const { locale, ...configuration } = value; return configuration; };

/** Platform authentication happens at connection startup. Routing is an ordinary chat/task mapping. */
export class ChannelRuntime {
  constructor({ directory, settingsDirectory, tasks, onChanged, workerFactory = (...args) => new ChannelWorker(...args) }) {
    if (typeof tasks?.run !== 'function' || typeof tasks?.recover !== 'function') throw new Error('CHANNEL_TASK_EXECUTOR_REQUIRED');
    this.store = new ChannelStore(directory, { settingsDirectory, onChanged });
    // Only a manager restart reconciles sends; SDK store readers do not.
    this.store.recoverUnconfirmedOutputs();
    this.tasks = tasks;
    this.workerFactory = workerFactory;
    this.workers = new Map();
    this.failedWorkers = new Map();
    this.workerIdentities = new WeakMap();
    this.starting = new Map();
    this.queues = new Map();
    this.jobs = new Set();
    this.inputJobs = new Set();
    this.controller = new AbortController();
  }

  async start() {
    const connections = this.store.connections().filter(row => row.enabled);
    const results = await Promise.allSettled(connections.map(row => this.connect(row.id)));
    for (const input of this.store.unsettledInputs()) this.schedule(input, true);
    for (const input of this.store.pendingInputs()) this.schedule(input);
    this.recoveryTimer ??= setInterval(() => {
      if (!this.controller.signal.aborted)
        for (const input of this.store.unsettledInputs()) this.schedule(input, true);
    }, 5000);
    this.recoveryTimer.unref?.();
    return results.map((result, index) => ({ index, connectionId: connections[index].id, state: result.status,
      ...(result.status === 'rejected' ? failure(result.reason) : {}) }));
  }

  async connect(id) {
    this.controller.signal.throwIfAborted();
    if (this.starting.has(id)) return this.starting.get(id);
    const current = this.workers.get(id);
    if (current && current.connectionState() !== 'stopped') return current;
    const { connection, credentials } = this.store.transaction(() => ({ connection: this.store.connection(id), credentials: this.store.credentials(id) }));
    if (!connection || !credentials) throw new Error('CHANNEL_CONNECTION_NOT_CONFIGURED');
    const failed = this.failedWorkers.get(id);
    let worker = failed ? null : this.workerFactory(connection, credentials, this.store.directory);
    const starting = (async () => {
      if (failed) { await failed.stop(); this.failedWorkers.delete(id); worker = this.workerFactory(connection, credentials, this.store.directory); }
      if (current) await current.stop();
      this.workerIdentities.set(worker, { platform: connection.platform,
        botId: connection.configuration[PLATFORM_IDENTITY_FIELD[connection.platform]] });
      // Publish the owned worker before SDK callbacks can acknowledge initial long-poll input.
      this.workers.set(id, worker);
      try {
        // Reserve the original queue order before startup can deliver newer platform input.
        for (const input of this.store.pendingInputs())
          if (this.store.chat(input.chatId)?.connectionId === id) this.schedule(input);
        await worker.start(event => this.receive(id, event, worker), () => this.store.changed());
        this.controller.signal.throwIfAborted();
        this.store.transaction(() => {
          const current = this.store.connection(id);
          // Labels and locale affect presentation, not SDK authentication or actor identity.
          if (!current || current.platform !== connection.platform
            || !isDeepStrictEqual(workerConfiguration(current.configuration), workerConfiguration(connection.configuration))
            || !isDeepStrictEqual(this.store.credentials(id), credentials)) throw new Error('CHANNEL_CONNECTION_STATE_CHANGED');
          this.store.setEnabled(id, true, current.revision);
        });
        for (const output of this.store.pendingOutputs(id)) await this.dispatchOutput(output);
        return worker;
      } catch (error) {
        try { await worker.stop(); } catch { this.failedWorkers.set(id, worker); }
        finally { if (this.workers.get(id) === worker) this.workers.delete(id); }
        throw error;
      }
    })();
    this.starting.set(id, starting);
    try { return await starting; } finally { this.starting.delete(id); }
  }

  async disconnect(id) {
    await this.starting.get(id)?.catch(() => {});
    this.store.setEnabled(id, false);
    const worker = this.workers.get(id) ?? this.failedWorkers.get(id);
    this.workers.delete(id);
    try { await worker?.stop(); this.failedWorkers.delete(id); }
    catch (error) { this.failedWorkers.set(id, worker); throw error; }
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
    let waitingForWorker = false;
    const operation = previous.catch(() => {}).then(async () => {
      if (recover) return this.recover(input.id);
      waitingForWorker = await this.execute(input.id) === 'worker_offline';
    });
    this.queues.set(key, operation); this.jobs.add(operation);
    operation.finally(() => {
      this.jobs.delete(operation);
      this.inputJobs.delete(input.id);
      if (this.queues.get(key) === operation) this.queues.delete(key);
      // Reconnect may have observed this job just before its offline attempt settled.
      if (waitingForWorker && !this.controller.signal.aborted) {
        const pending = this.store.inbox(input.id);
        if (pending?.state === 'pending' && this.workers.get(this.store.chat(pending.chatId)?.connectionId)?.connectionState() === 'connected')
          this.schedule(pending);
      }
    }).catch(() => {});
  }

  current(input) {
    const binding = this.store.binding(input.chatId);
    return binding?.revision === input.bindingRevision && sameTarget(binding.target, input.target);
  }

  async execute(id) {
    if (this.controller.signal.aborted) return;
    const input = this.store.inbox(id);
    if (!input || input.state !== 'pending') return;
    const starting = this.starting.get(this.store.chat(input.chatId)?.connectionId);
    if (starting) {
      await starting.catch(() => {});
      if (this.controller.signal.aborted || this.store.inbox(id)?.state !== 'pending') return;
    }
    const chat = this.store.chat(input.chatId);
    if (!chat || !this.current(input)) {
      this.store.retirePending(id); return;
    }
    // SDK acknowledgement is durable; a temporary disconnect cannot discard accepted work.
    if (this.workers.get(chat.connectionId)?.connectionState() !== 'connected') return 'worker_offline';
    if (!this.store.claimInput(id)) return;
    try {
      if (input.event.attachments?.length) throw Object.assign(new Error('CHANNEL_ATTACHMENT_TRANSFER_UNAVAILABLE'), { accepted: false });
      // Existing app-server queues, model configuration and task tool policy remain authoritative.
      const result = await this.tasks.run({ id, target: input.target, event: input.event,
        toolRestrictions: this.store.settings().toolRestrictions,
        signal: this.controller.signal, onAccepted: receipt => this.store.recordAcceptance(id, receipt) });
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('CHANNEL_TASK_RESULT_UNCONFIRMED');
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
    const input = this.store.inbox(id);
    if (!input || !['running', 'unknown'].includes(input.state)) return;
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
    if (!this.current(input) || typeof result?.text !== 'string' || !result.text.trim()) return null;
    return this.prepareOutput(`reply-${input.id}`, input.chatId, { text: result.text },
      { event: input.event, bindingRevision: input.bindingRevision });
  }

  prepareOutput(id, chatId, content, { event, bindingRevision, bindingRequired = false } = {}) {
    return this.store.transaction(() => {
    const chat = this.store.chat(chatId);
    if (!chat) throw new Error('CHANNEL_CHAT_NOT_FOUND');
    const connection = this.store.connection(chat.connectionId);
    if (!connection) throw new Error('CHANNEL_CONNECTION_NOT_CONFIGURED');
    if (bindingRevision !== undefined && this.store.bindingRevision(chatId) !== bindingRevision) throw new Error('CHANNEL_BINDING_CHANGED');
    const existing = this.store.output(id);
    const messageFormat = existing ? existing.payload.messageFormat ?? 'auto'
      : connectionFeatures(chat.range.platform, connection.configuration.features).messageFormat;
    content = channelMessageContent(content, messageFormat);
    if (existing) {
      if (existing.chatId !== chatId || !isDeepStrictEqual(existing.payload.content, content)
        || (bindingRevision !== undefined && existing.payload.bindingRevision !== bindingRevision)) throw new Error('CHANNEL_OUTPUT_ID_CONFLICT');
      return existing;
    }
    const source = event ?? chat.lastEvent;
    const destination = prepareChannelDestination(chat.range.platform,
      { ...chat.range, channelId: chat.connectionId, botId: source?.botId ?? connection.configuration[PLATFORM_IDENTITY_FIELD[connection.platform]], conversationId: chat.range.chatId,
      externalSubjectId: source?.senderId, platformRoute: source?.platformRoute,
      replyRef: source?.replyRef, replyMessageId: source?.sourceMessageId ?? source?.eventId },
      { event: source ?? {}, now: Date.now(),
        replySequence: this.store.replySequence(chatId, source?.sourceMessageId ?? source?.eventId) });
    return this.store.enqueueOutput(id, chatId, { destination, content, messageFormat, createdAtMs: Date.now(),
      ...(bindingRequired ? { bindingRequired: true } : {}),
      ...(bindingRevision === undefined ? {} : { bindingRevision }) });
    });
  }

  async dispatchOutput(output) {
    const { id, chatId, payload } = output;
    if (output.state !== 'pending') return output;
    if (this.controller.signal.aborted) return output;
    // Recheck at dispatch too: a reconnect or an awaited history read may outlive a settings change.
    if (payload.source?.role && !this.store.settings().mirrorClientTurns) {
      this.store.cancelPendingClientMirrors();
      return this.store.output(id);
    }
    const chat = this.store.chat(chatId), worker = this.workers.get(chat?.connectionId);
    const connection = chat && this.store.connection(chat.connectionId);
    if (!chat || !connection) {
      if (this.store.claimOutput(id)) this.store.settleOutput(id, 'failed', { code: chat ? 'CHANNEL_CONNECTION_REMOVED' : 'CHANNEL_CHAT_NOT_FOUND' });
      return this.store.output(id);
    }
    // Offline connections retain unsent intents; a claimed/unknown send is never retried.
    if (!worker || worker.connectionState() !== 'connected') return output;
    const actor = this.workerIdentities.get(worker), original = payload.destination?.botId;
    const configured = connection.configuration[PLATFORM_IDENTITY_FIELD[connection.platform]];
    if (typeof original !== 'string' || !original || actor?.platform !== connection.platform
        || actor.botId !== original || configured !== original) {
      if (this.store.claimOutput(id)) this.store.settleOutput(id, 'failed', {
        code: typeof original === 'string' && original ? 'CHANNEL_OUTPUT_ACTOR_CHANGED' : 'CHANNEL_OUTPUT_ACTOR_UNCONFIRMED' });
      return this.store.output(id);
    }
    if (!this.store.claimOutput(id)) return this.store.output(id);
    if (typeof payload.content?.text === 'string' && !payload.content.text.trim()) {
      this.store.settleOutput(id, 'failed', { code: 'CHANNEL_TASK_MESSAGE_EMPTY' });
      return this.store.output(id);
    }
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
      this.store.settleOutput(id, receipt?.state === 'accepted' ? 'accepted' : receipt?.state === 'failed' ? 'failed' : 'unknown', receipt ?? { code: 'PLATFORM_RECEIPT_MISSING' });
    } catch (error) {
      this.store.settleOutput(id, error?.externalOutcome === 'failed' ? 'failed' : 'unknown', failure(error));
    }
    return this.store.output(id);
  }

  async close() {
    if (this.closed) return;
    if (this.closing) return this.closing;
    this.controller.abort();
    clearInterval(this.recoveryTimer);
    this.closing = (async () => {
    await Promise.allSettled(this.starting.values());
    const owned = new Map([...this.failedWorkers, ...this.workers]);
    const stopped = await Promise.allSettled([...owned.values()].map(worker => worker.stop()));
    let failure;
    [...owned].forEach(([id, worker], index) => {
      if (stopped[index].status === 'rejected') { this.failedWorkers.set(id, worker); failure ??= stopped[index].reason; }
      else this.failedWorkers.delete(id);
    });
    this.workers.clear();
    await Promise.allSettled(this.jobs);
    if (failure) throw failure;
    this.store.close();
    this.closed = true;
    })();
    try { return await this.closing; } finally { this.closing = null; }
  }
}
