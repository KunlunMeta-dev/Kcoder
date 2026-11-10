import { ChannelRuntime } from '../../kcoder-channel-host/src/channels/runtime.mjs';
import { ChannelTaskClient } from './channel-task-client.mjs';
import { ChannelTaskMirrors, channelTargetKey } from './channel-task-mirrors.mjs';
import { ChannelAuthorizations } from '../../kcoder-channel-host/src/channels/authorizations.mjs';

/** Gateway-owned platform connections, using the normal workspace broker for task execution. */
export function createChannelsController({ directory, settingsDirectory, selectBroker, workerFactory }) {
  const clients = new Map(); let closed = false;
  async function entry(target) {
    if (closed) throw new Error('CHANNEL_MANAGER_STOPPED');
    const id = channelTargetKey(target), { broker } = await selectBroker(target);
    if (closed) throw new Error('CHANNEL_MANAGER_STOPPED');
    let current = clients.get(id);
    if (!current || current.client.closed || current.client.broker !== broker) {
      current?.client.close();
      current = { client: new ChannelTaskClient(broker), references: 0, retained: false };
      clients.set(id, current);
    }
    return current;
  }
  function collect(target, current) {
    if (current.retained || current.references) return;
    current.client.close();
    if (clients.get(channelTargetKey(target)) === current) clients.delete(channelTargetKey(target));
  }
  async function useClient(target, operation) {
    const current = await entry(target); current.references++;
    try { return await operation(current.client); }
    finally { current.references--; collect(target, current); }
  }
  const runtime = new ChannelRuntime({ directory, settingsDirectory, workerFactory, tasks: {
    run: input => useClient(input.target, client => client.run(input)),
    recover: input => useClient(input.target, client => client.recover(input)),
  } });
  const mirrors = new ChannelTaskMirrors({ runtime, useClient,
    retain: async target => { const current = await entry(target); current.retained = true; return current.client; },
    release: async target => {
      const current = clients.get(channelTargetKey(target));
      if (current) { current.retained = false; current.client.observers.clear(); collect(target, current); }
    },
  });
  const authorizations = new ChannelAuthorizations(runtime.store);
  const bindingChanged = () => mirrors.sync();
  return { runtime, authorizations, bindingChanged,
    async start() { const result = await runtime.start(); await bindingChanged(); return result; },
    validateTarget: target => useClient(target, async client => {
      await client.initialize(); await client.request('thread/read', { threadId: target.threadId, limit: 1 });
    }),
    describeTarget: target => useClient(target, async client => {
      await client.initialize(8000);
      const { thread } = await client.request('thread/read', { threadId: target.threadId, limit: 1 }, 8000);
      if (thread?.id !== target.threadId) throw new Error('CHANNEL_TASK_TARGET_UNAVAILABLE');
      return { title: typeof thread.title === 'string' ? thread.title.slice(0, 1000) : null };
    }),
    async close() {
      closed = true; authorizations.close();
      for (const current of clients.values()) current.client.close();
      await mirrors.close();
      clients.clear(); await runtime.close();
    },
  };
}
