import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AppServerStdioClient, waitForStdioChildClose } from './app-server-stdio.mjs';
import { runE2E } from './run-context.mjs';
import { materializeWorkspace } from './workspace-fixture.mjs';

await runE2E(import.meta.url, { testId: 'owned-native-plugin-proxy-status', tier: 'full-integration',
  modelPolicy: 'Actual installed Native binary with a fresh owned profile; no model or external proxy traffic.' }, async context => {
  const binary = await realpath(process.env.KCODER_E2E_KCODER_BIN || '/usr/local/bin/kcoder');
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(binary)) digest.update(bytes);
  const binarySha256 = digest.digest('hex');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'proxy-status' });
  const settings = await context.writeStateJson('profile/settings.json', {
    providers: {}, credential_store: 'file', auto_memory_enabled: false,
    memory: { structured_enabled: false, observer_mode: 'disabled' },
    session_memory: { enabled: false },
  });
  const profile = dirname(settings);
  const child = context.spawnOwned('native-proxy-status', binary, ['app-server'], {
    cwd: workspace, stdin: 'pipe', env: context.isolatedEnvironment({ KCODER_CONFIG_DIR: profile }),
  });
  const client = new AppServerStdioClient('native-proxy-status', child, { defaultTimeoutMs: 30000 });
  context.addCleanup('close original proxy-status Native', async () => {
    child.stdin.end();
    try { await waitForStdioChildClose(child, 10000, 'native-proxy-status'); }
    finally { client.closeReader(); }
  }, { timeoutMs: 15000 });
  const initialized = await client.request('initialize', { protocolVersion: '2026-07-27',
    clientInfo: { name: 'owned-proxy-status', version: '1' }, capabilities: {} });
  const status = await client.request('plugin/proxy/status', {});
  await context.writeArtifactJson('native-proxy-status.json', { binary, binarySha256,
    advertised: initialized.result?.capabilities?.experimental?.pluginProxyDiscoveryV1,
    serverInfo: initialized.result?.serverInfo,
    error: status.error ?? null,
    result: status.result,
    personalConfigurationUsed: false, externalNetworkCalls: 0 });
  assert.equal(initialized.error ?? null, null);
  assert.equal(initialized.result?.capabilities?.experimental?.pluginProxyDiscoveryV1, true);
  assert.equal(status.error ?? null, null);
  assert.equal(typeof status.result?.autoDetect, 'boolean');
  return { binarySha256, advertised: true, readSucceeded: true, externalNetworkCalls: 0 };
});
