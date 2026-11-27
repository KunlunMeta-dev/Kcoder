import assert from 'node:assert/strict';
import { startApprovalModelFixture } from './approval-model.mjs';
import { startGateway } from './gateway.mjs';
import { startSshFixture } from './ssh-fixture.mjs';
import { materializeWorkspace } from './workspace-fixture.mjs';
import { openOwnedPeerBrowserRuntime } from './peer-browser-runtime.mjs';
import { waitFor } from './run-context.mjs';

/** Actual loopback SSH, independent Native profiles and HTTP login. The SSH
 * account is the current owned test account; this does not prove distinct UIDs.
 */
export async function startPeerSshTargets(context, binary, { modelOptions, wakeIdleTargets = [], localBinary = binary, sshBinary = binary } = {}) {
  assert.equal(process.platform, 'linux');
  const model = await startApprovalModelFixture(context, { textOnly: true,
    textOnlyResponse: 'OWNED_CROSS_TARGET_PEER_READY', ...modelOptions });
  const endpoints = new Map();
  for (const alias of ['peer-local', 'peer-ssh']) {
    const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: alias });
    const profile = context.pathInState(`${alias}-profile`);
    const settings = await context.writeStateJson(`${alias}-profile/settings.json`, {
      active_provider: 'OwnedTransportPeer', credential_store: 'file', permission_mode: 'yolo', max_retries: 0,
      cross_session_messages: { enabled: true, wake_idle: wakeIdleTargets.includes(alias) }, auto_memory_enabled: false,
      auto_tool_memory_enabled: false, session_memory: { enabled: false },
      providers: { OwnedTransportPeer: { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
        endpoint: model.baseUrl, default_model: 'owned-transport-peer', no_proxy: true, discover_models: false,
        context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 1024,
        capabilities: { text: true, tools: true, reasoning: false } } },
    });
    context.registerTemporaryDirectory(`${alias}-profile`, profile);
    endpoints.set(alias, { alias, workspace, profile, settings });
  }
  const local = endpoints.get('peer-local'), remote = endpoints.get('peer-ssh');
  const ssh = await startSshFixture(context, { configDirectory: remote.profile, strictKnownHost: true });
  const serversFile = await context.writeStateJson('peer-targets.json', [
    { id: local.alias, label: 'Owned local Native peer', runtime: 'kcoder', transport: 'local',
      command: localBinary, workspace: local.workspace, settingsFile: local.settings },
    { id: remote.alias, label: 'Owned SSH Native peer', runtime: 'kcoder', transport: 'ssh',
      host: ssh.listenHost, user: ssh.user, port: ssh.port, acceptNewHostKey: false,
      command: sshBinary, workspace: remote.workspace, settingsFile: remote.settings },
  ]);
  const gateway = await startGateway(context, { auth: true, workspace: local.workspace,
    serversFile, kcoderBin: binary, env: { ...ssh.gatewayEnv,
      KCODER_CONFIG_DIR: local.profile, KCODER_HOME: local.profile } });
  const clients = new Map();
  for (const endpoint of endpoints.values()) {
    clients.set(endpoint.alias, await openOwnedPeerBrowserRuntime(context, gateway, {
      serverId: endpoint.alias, workspace: endpoint.workspace,
    }));
  }
  return { endpoints, clients, model, gateway, ssh,
    async seed(alias) {
      const client = clients.get(alias);
      const { thread } = await client.request('thread/start', {});
      const clientMessageId = `owned-seed-${alias}`;
      await client.request('turn/start', { threadId: thread.id, clientMessageId,
        input: [{ type: 'text', text: `OWNED_TRANSPORT_SEED_${alias}` }] });
      await waitFor(async () => {
        const { receipt } = await client.request('turn/receipt/read', { threadId: thread.id, clientMessageId });
        assert.ok(!['failed', 'interrupted'].includes(receipt?.status), 'Owned transport seed failed');
        return receipt?.status === 'completed';
      }, 30_000, 'actual original Native seed on selected transport');
      return thread;
    },
  };
}
