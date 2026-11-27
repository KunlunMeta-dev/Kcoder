import { mkdir } from 'node:fs/promises';
import { WorkspaceAppServerBroker } from '../../src/workspace-app-server-broker.js';
import { createRuntimeTargetAdapter } from '../../src/runtime-target-adapter.js';
import { ChannelTaskClient } from '../../src/channel-task-client.mjs';
import { startApprovalModelFixture } from './approval-model.mjs';
import { materializeWorkspace } from './workspace-fixture.mjs';
import { waitFor } from './run-context.mjs';

/** A real task host and fixed local provider; no platform account, Native channel grants or shared data. */
export async function channelTaskFixture(context, binary, { responseText = 'CHANNEL_FIXTURE_RESULT' } = {}) {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'independent-channel' });
  const home = context.pathInState('home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const model = await startApprovalModelFixture(context, { textOnly: true, textOnlyResponse: responseText });
  context.registerSecret('channel-local-fixture-key');
  await context.writeStateJson('home/credentials.json', { fixture: { type: 'api', key: 'channel-local-fixture-key' } });
  const settings = await context.writeStateJson('home/settings.json', {
    credential_store: 'file', active_provider: 'fixture', permission_mode: 'ask', max_retries: 0,
    providers: { fixture: { api_format: 'openai_chat_completions', endpoint: model.baseUrl,
      default_model: 'fixture-model', context_window_tokens: 200000, max_output_tokens: 1024,
      output_headroom_tokens: 1024, no_proxy: true, request_timeout_secs: 30 } },
  });
  const child = context.spawnOwned('independent-channel-task-host', binary, ['--settings-file', settings, 'app-server'], {
    cwd: workspace, env: context.isolatedEnvironment({ KCODER_CONFIG_DIR: home }), stdin: 'pipe',
  });
  const broker = new WorkspaceAppServerBroker({ child, adapter: createRuntimeTargetAdapter('kcoder'),
    serverId: 'fixture-target', maxMessageBytes: 2 * 1024 * 1024 });
  const clients = new Set();
  context.addCleanup('detach owned channel task clients', () => { for (const client of clients) client.close(); });
  function client() { const value = new ChannelTaskClient(broker); clients.add(value); return value; }
  async function createPersistedTask() {
    const creator = client();
    try {
      await creator.initialize();
      const { thread } = await creator.request('thread/start', {});
      await creator.request('gateway/thread/attach', { threadId: thread.id, viewId: 'ordinary-client' });
      await creator.request('turn/start', { threadId: thread.id, clientMessageId: 'ordinary-seed',
        input: [{ type: 'text', text: 'ORDINARY_CLIENT_SEED' }] });
      await waitFor(async () => (await creator.request('turn/receipt/read', {
        threadId: thread.id, clientMessageId: 'ordinary-seed',
      })).receipt?.status === 'completed', 60000, 'ordinary conversation persistence');
      return thread;
    } finally { creator.close(); }
  }
  return { workspace, home, model, broker, client, createPersistedTask };
}
