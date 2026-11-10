import { createHash } from 'node:crypto';

export const channelTargetKey = target => JSON.stringify([target.serverId, target.workspacePath ?? null, target.threadId, target.loginOwner ?? null]);
const key = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Mirrors only observed future turns; the existing Outbox owns durable intents and receipts. */
export class ChannelTaskMirrors {
  constructor({ runtime, retain, release, useClient }) {
    Object.assign(this, { runtime, retain, release, useClient });
    this.watches = new Map();
  }

  sync() {
    this.synchronizing = (this.synchronizing ?? Promise.resolve()).catch(() => {}).then(() => this.reconcile()).finally(() => {
      clearTimeout(this.timer);
      if (!this.closed && (this.watches.size || this.runtime.store.waitingTaskOutputs().length || this.retryWatch)) {
        this.timer = setTimeout(() => { void this.sync().catch(() => {}); }, 5000); this.timer.unref?.();
      }
    });
    return this.synchronizing;
  }

  async reconcile() {
    if (this.closed) return;
    const desired = new Map();
    const connections = this.runtime.store.settings().mirrorClientTurns ? this.runtime.store.connections() : [];
    for (const connection of connections.filter(row => row.enabled))
      for (const chat of this.runtime.store.chats(connection.id))
        if (chat.binding) desired.set(channelTargetKey(chat.binding.target), chat.binding.target);
    this.retryWatch = desired.size > 0;
    for (const [id, watch] of this.watches) if (!desired.has(id) || watch.client.closed) {
      this.watches.delete(id); await this.release(watch.target);
    }
    for (const [id, target] of desired) if (!this.watches.has(id)) {
      const client = await this.retain(target);
      const watch = { target, client };
      try {
        await client.watch(target.threadId, (event, facts) => {
          if (this.closed || this.watches.get(id) !== watch) return;
          if (event.method === 'turn/started' && !facts.channelInput) {
            try { this.observe(target, event.params); }
            catch { console.warn('CHANNEL_TASK_MIRROR_STORAGE_UNAVAILABLE'); }
          }
          if (event.method === 'turn/completed') this.kick();
        });
        this.watches.set(id, watch);
      } catch (error) { await this.release(target); throw error; }
    }
    this.kick();
  }

  observe(target, params) {
    if (!this.runtime.store.settings().mirrorClientTurns) return;
    const turnId = params.turn?.id ?? params.turnId;
    const attemptId = params.attemptId ?? params.turn?.attemptId;
    if (typeof turnId !== 'string' || !turnId) return;
    const source = { target, turnId, ...(attemptId ? { attemptId } : {}) };
    const store = this.runtime.store;
    // Freeze destinations before any asynchronous history read or binding change.
    store.transaction(() => {
      for (const connection of store.connections().filter(row => row.enabled))
        for (const chat of store.chats(connection.id)) {
          if (!chat.binding || channelTargetKey(chat.binding.target) !== channelTargetKey(target)) continue;
          for (const role of ['user', 'assistant']) {
            const id = `mirror-${key([source, chat.id, chat.binding.revision, role])}`;
            if (store.output(id)) continue;
            this.runtime.prepareOutput(id, chat.id, { text: '' }, { bindingRevision: chat.binding.revision });
            store.deferTaskOutput(id, { ...source, role });
          }
        }
    });
  }

  kick() {
    if (this.closed || this.pumping) return;
    this.pumping = this.pump().finally(() => { this.pumping = null; });
    this.pumping.catch(() => {});
  }

  async pump() {
    const store = this.runtime.store, reads = new Map();
    if (!store.settings().mirrorClientTurns) { store.cancelPendingClientMirrors(); return; }
    for (const output of store.waitingTaskOutputs()) {
      if (this.closed) return;
      const { source, bindingRevision } = output.payload;
      if (store.binding(output.chatId)?.revision !== bindingRevision) {
        store.resolveTaskOutput(output.id, null, 'CHANNEL_BINDING_CHANGED'); continue;
      }
      if (!store.connection(store.chat(output.chatId).connectionId)?.enabled) continue;
      const identity = key([source.target, source.turnId, source.attemptId]);
      try {
        if (!reads.has(identity)) reads.set(identity, await this.useClient(source.target, client => client.readTurn(source)));
        const result = reads.get(identity);
        if (['failed', 'interrupted'].includes(result.state)) {
          store.resolveTaskOutput(output.id, null, 'CHANNEL_TASK_TURN_FAILED'); continue;
        }
        if (result.state !== 'completed') continue;
        if (store.binding(output.chatId)?.revision !== bindingRevision) {
          store.resolveTaskOutput(output.id, null, 'CHANNEL_BINDING_CHANGED'); continue;
        }
        const text = result[source.role];
        store.resolveTaskOutput(output.id, text, text ? undefined : 'CHANNEL_TASK_MESSAGE_EMPTY');
        await this.runtime.dispatchOutput(store.output(output.id));
      } catch { /* Read-only recovery retains the original intent; it never replays a turn or send. */ }
    }
  }

  async close() {
    this.closed = true; clearTimeout(this.timer);
    await this.synchronizing?.catch(() => {});
    for (const watch of this.watches.values()) await this.release(watch.target);
    this.watches.clear(); await this.pumping;
  }
}
