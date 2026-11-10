import { randomUUID } from 'node:crypto';

/** Transport-scoped attachment handles; the app-server alone decides survival. */
export class BrokerSessionAttachments {
  #broker;
  #clients = new Map();
  #timer;
  constructor(broker) { this.#broker = broker; }
  enabled() {
    return this.#broker.initializeResponse?.result?.capabilities?.experimental?.sessionLifetimeV1 === true;
  }
  attach(client, threadId, viewId = 'initial') {
    if (!this.enabled() || client?.channel !== 'runtime' || !client.initialized ||
        !this.#broker.clients.has(client)) return false;
    let tasks = this.#clients.get(client);
    if (!tasks) this.#clients.set(client, tasks = new Map());
    let handle = tasks.get(threadId);
    if (handle && handle.viewId !== viewId && viewId !== 'initial') {
      this.#send('thread/detach', threadId, handle);
      handle = null;
    }
    if (!handle) {
      handle = { clientId: randomUUID(), generation: randomUUID(), viewId };
      tasks.set(threadId, handle);
    }
    this.#send('thread/attach', threadId, handle);
    this.#timer ??= setInterval(() => this.#renew(), 30_000);
    this.#timer.unref?.();
    return true;
  }
  release(client, threadId, viewId) {
    const tasks = this.#clients.get(client), handle = tasks?.get(threadId);
    if (!handle || (viewId && handle.viewId !== viewId)) return false;
    tasks.delete(threadId);
    this.#send('thread/detach', threadId, handle);
    if (!tasks.size) this.#clients.delete(client);
    this.#stopIdleTimer();
    return true;
  }
  detach(client) {
    for (const threadId of this.#clients.get(client)?.keys() ?? []) this.release(client, threadId);
  }
  clear() { this.#clients.clear(); clearInterval(this.#timer); this.#timer = undefined; }
  #stopIdleTimer() {
    if (!this.#clients.size) { clearInterval(this.#timer); this.#timer = undefined; }
  }
  #renew() {
    for (const [client, tasks] of this.#clients) {
      if (!this.#broker.clients.has(client)) { this.detach(client); continue; }
      for (const [threadId, handle] of tasks) this.#send('thread/attach', threadId, handle);
    }
  }
  #send(method, threadId, handle) {
    this.#broker.sendInternalRequest(method, { threadId,
      clientId: handle.clientId, generation: handle.generation });
  }
}
