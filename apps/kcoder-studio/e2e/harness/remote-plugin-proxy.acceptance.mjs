import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { AppServerStdioClient, waitForStdioChildClose } from './app-server-stdio.mjs';
import { runE2E } from './run-context.mjs';
import { repoRoot } from './run-context.mjs';
import { materializeWorkspace } from './workspace-fixture.mjs';
import { startGateway, waitForGatewayRpcToken } from './gateway.mjs';
import { login } from './http.mjs';
import { closeRpcAndWait, gatewayRpcUrl, openRpc } from './rpc.mjs';
import { startSshFixture } from './ssh-fixture.mjs';

await runE2E(import.meta.url, { testId: 'owned-target-plugin-proxy-owner-routing', tier: 'full-integration', retainSuccessLogs: true,
  modelPolicy: 'Actual installed Native and authenticated owned Gateway with fresh profile/workspace. Status and disabled proxy settings only, no model turn or external traffic.' }, async context => {
  const phase = process.env.KCODER_E2E_PROXY_ACCEPTANCE_PHASE ?? 'baseline';
  const transport = process.env.KCODER_E2E_PROXY_TRANSPORT ?? 'local';
  assert.ok(['baseline', 'fixed'].includes(phase));
  assert.ok(['local', 'ssh'].includes(transport));
  const binary = await realpath(process.env.KCODER_E2E_KCODER_BIN || '/usr/local/bin/kcoder');
  const binarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'proxy-owner' });
  const modelHttp = [];
  const noInference = createServer((request, response) => {
    modelHttp.push({ method: request.method, path: new URL(request.url, 'http://127.0.0.1').pathname });
    request.resume(); response.writeHead(503); response.end();
  });
  await new Promise(resolve => noInference.listen(0, '127.0.0.1', resolve));
  context.registerPort('inert-proxy-no-inference', noInference.address().port);
  context.addCleanup('close owned inert proxy model sentinel', () => new Promise((resolve, reject) => noInference.close(error => error ? reject(error) : resolve())));
  const settings = await context.writeStateJson('profile/settings.json', {
    active_provider: 'OwnedProxy', model: 'owned-proxy', credential_store: 'file', max_retries: 0,
    providers: { OwnedProxy: { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
      endpoint: `http://127.0.0.1:${noInference.address().port}/v1`, default_model: 'owned-proxy', discover_models: false,
      no_proxy: true, context_window_tokens: 128000, max_output_tokens: 4096, output_headroom_tokens: 8192 } },
    plugins: { installation: { auto_detect_proxy: false } },
    integrations: { services: { enabled: true }, connectivity: { enabled: true } },
    memory: { structured_enabled: false, observer_mode: 'disabled' }, session_memory: { enabled: false },
  });
  const profile = dirname(settings);
  let ssh;
  if (transport === 'ssh') {
    const remoteHome = context.pathInState('ssh-native-home'); await mkdir(remoteHome, { mode: 0o700 });
    const wrapper = context.pathInState('ssh-native-proxy.sh');
    const expected = `${binary} --settings-file ${settings} --cwd ${workspace} app-server`;
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    await writeFile(wrapper, `#!/bin/sh\nset -eu\n[ "$SSH_ORIGINAL_COMMAND" = ${quote(expected)} ] || exit 23\nexec env -i PATH=/usr/bin:/bin HOME=${quote(remoteHome)} USERPROFILE=${quote(remoteHome)} KCODER_CONFIG_DIR=${quote(profile)} XDG_CONFIG_HOME=${quote(remoteHome)} XDG_CACHE_HOME=${quote(remoteHome)} TMPDIR=${quote(remoteHome)} ${quote(binary)} --settings-file ${quote(settings)} --cwd ${quote(workspace)} app-server\n`, { mode: 0o700 });
    await chmod(wrapper, 0o700);
    ssh = await startSshFixture(context, { configDirectory: profile, forcedCommand: wrapper, strictKnownHost: true });
  }
  const server = { id: 'h20-owned', label: 'H20 isolated proxy target', transport, command: binary, workspace, settingsFile: settings,
    ...(ssh ? { host: ssh.listenHost, user: ssh.user, port: ssh.port } : {}) };
  const serversFile = await context.writeStateJson('servers.json', [server]);
  const gateway = await startGateway(context, { label: 'proxy-owned-gateway', workspace, serversFile, kcoderBin: binary,
    auth: true, redactedStderrDiagnostics: true, env: { KCODER_CONFIG_DIR: profile, ...(ssh?.gatewayEnv ?? {}) } });
  const cookie = await login(gateway.baseUrl, gateway.authToken); context.registerSecret(cookie);
  const token = await waitForGatewayRpcToken(context, gateway, { headers: { cookie }, expectedToken: 'cookie-auth' });
  const evidence = { phase, transport, transportBoundary: transport === 'ssh' ? 'Linux Gateway through real owned loopback OpenSSH; not Windows Gateway or physical cross-host acceptance' : 'H20-local Gateway and local Native target', binary, binarySha256, workspace, profile, original: null, ordinaryGateway: null,
    ordinaryNativePeer: null, management: null, modelRequests: 0, modelTurnsStarted: 0, personalConfigurationUsed: false };
  const open = async management => {
    const url = new URL(gatewayRpcUrl(gateway, 'h20-owned', token));
    if (management) url.searchParams.set('nativeManagement', '1');
    const rpc = await openRpc(url.href, { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
    context.addCleanup(`close ${management ? 'management' : 'ordinary'} owned proxy RPC`, () => closeRpcAndWait(rpc));
    const initialized = await rpc.request('initialize', { protocolVersion: '2026-07-27',
      clientInfo: { name: 'owned-plugin-proxy-scope', version: '1' }, capabilities: { experimental: {
        integrationScopeV1: true, interactionBindingV1: true, connectivityV1: true,
        gatewaySharedThreadsV1: !management, taskSourcesV1: !management, threadRuntimeHandoffV1: !management,
      } } }, 30000);
    return { rpc, initialized };
  };
  try {
    const owner = await open(false);
    const scope = await owner.rpc.request('integrations/scope/read', {});
    evidence.original = { scope, capability: owner.initialized.capabilities?.experimental?.pluginProxyDiscoveryV1,
      connectivity: owner.initialized.capabilities?.experimental?.connectivityV1,
      residentThreads: owner.initialized.capabilities?.experimental?.residentThreads };
    try {
      const normal = await open(false);
      evidence.ordinaryGateway = { succeeded: true, status: await normal.rpc.request('plugin/proxy/status', {}) };
    } catch (error) { evidence.ordinaryGateway = { succeeded: false, error: context.redactText(error.message) }; }

    const child = context.spawnOwned('proxy-ordinary-native-peer', binary, ['--cwd', workspace, '--settings-file', settings, 'app-server'], {
      cwd: workspace, stdin: 'pipe', env: context.isolatedEnvironment({ KCODER_CONFIG_DIR: profile }),
    });
    const client = new AppServerStdioClient('proxy-ordinary-native-peer', child, { defaultTimeoutMs: 15000 });
    context.addCleanup('close exact ordinary Native peer', async () => {
      child.stdin.end(); await waitForStdioChildClose(child, 10000, 'owned ordinary proxy peer'); client.closeReader();
    });
    try {
      const response = await client.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'owned-proxy-peer', version: '1' } });
      evidence.ordinaryNativePeer = { succeeded: !response.error, error: response.error?.message ?? null };
    } catch (error) { evidence.ordinaryNativePeer = { succeeded: false, error: context.redactText(error.message), exitCode: child.exitCode }; }
    try {
      const control = await open(true);
      const status = await control.rpc.request('plugin/proxy/status', {});
      const configured = await control.rpc.request('plugin/proxy/configure', { enabled: false });
      const readback = await control.rpc.request('plugin/proxy/status', {});
      evidence.management = { succeeded: true, capability: control.initialized.capabilities?.experimental?.pluginProxyDiscoveryV1,
        taskSources: control.initialized.capabilities?.experimental?.taskSourcesV1, status, configured, readback };
    } catch (error) { evidence.management = { succeeded: false, error: context.redactText(error.message) }; }
    evidence.modelHttp = modelHttp;
    if (phase === 'fixed') {
      const output = context.pathInState('actual-proxy-chain.json');
      const child = context.spawnOwned('actual-renderer-proxy-chain', process.execPath, [resolve(repoRoot, 'apps/kcoder-studio/renderer/node_modules/vitest/vitest.mjs'), 'run',
        'src/kcoder/gatewayPluginProxy.native.test.ts', '--maxWorkers=1', '--no-file-parallelism'], {
        cwd: resolve(repoRoot, 'apps/kcoder-studio/renderer'),
        env: context.isolatedEnvironment({ KCODER_E2E_PROXY_NATIVE_CHAIN: '1', KCODER_E2E_PROXY_GATEWAY: gateway.baseUrl,
          KCODER_E2E_PROXY_COOKIE: cookie, KCODER_E2E_PROXY_TOKEN: token, KCODER_E2E_PROXY_TRANSPORT: transport,
          KCODER_E2E_PROXY_WORKSPACE: workspace, KCODER_E2E_PROXY_OUTPUT: output }),
      });
      await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('Actual renderer proxy chain failed'))); });
      evidence.rendererChain = JSON.parse(await readFile(output, 'utf8'));
      assert.equal(evidence.rendererChain.passed, true);
      await context.writeArtifactJson('actual-proxy-chain.json', evidence.rendererChain);
    }
    const ownerReadback = await owner.rpc.request('integrations/scope/read', {});
    evidence.originalAfterProxy = { accountId: ownerReadback.accountId, targetId: ownerReadback.targetId,
      workspaceId: ownerReadback.workspaceId, identityGeneration: ownerReadback.identityGeneration };
    for (const key of ['accountId', 'targetId', 'workspaceId', 'identityGeneration']) assert.equal(ownerReadback[key], scope[key], 'Proxy management must preserve the original SDK owner');
    evidence.modelRequests = modelHttp.filter(row => row.method === 'POST').length;
    await context.writeArtifactJson('proxy-owner-routing.json', evidence);
    assert.equal(evidence.modelRequests, 0);
    if (phase === 'fixed') {
      assert.equal(evidence.management?.succeeded, true);
      assert.equal(evidence.management.capability, true);
      assert.equal(evidence.management.readback.autoDetect, false);
    }
    return evidence;
  } catch (error) {
    await context.writeArtifactJson('proxy-owner-routing-failure.json', { ...evidence, failure: context.redactText(error.message) });
    throw error;
  }
});
