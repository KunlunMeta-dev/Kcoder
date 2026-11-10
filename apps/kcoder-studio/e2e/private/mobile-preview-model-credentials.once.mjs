import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { loadEnv } from '../../../kcoder-relay/src/config.mjs';
import { mobilePreviewModelEnvironment } from '../../src/mobile-preview-config.js';
import { runE2E, repoRoot } from '../harness/run-context.mjs';
import { startGateway, waitForGatewayRpcToken } from '../harness/gateway.mjs';
import { openRpc, initializeRpc, closeRpcAndWait } from '../harness/rpc.mjs';

if (process.env.KCODER_E2E_REAL_MODEL !== '1') throw new Error('Explicit real-model acceptance consent is required');
process.umask(0o077);
loadEnv(resolve(repoRoot, '.env'));
await runE2E(import.meta.url, { testId: 'preview-model-credential-environment', tier: 'manual-live',
  modelPolicy: 'One real default-model turn in an owned Gateway, workspace and profile; output <=512 tokens, no retry, 60 second turn deadline; no user conversations',
}, async run => {
  const modelEnv = mobilePreviewModelEnvironment(process.env);
  assert.ok(modelEnv.KUNLUNMETA_BASE_API_KEY, 'The configured model credential must exist');
  run.registerSecret(modelEnv.KUNLUNMETA_BASE_API_KEY);
  const require = createRequire(resolve(repoRoot, 'apps/kcoder-studio/package.json'));
  const { parse } = require('jsonc-parser');
  const settings = parse(await readFile(resolve(process.env.KCODER_RELAY_CONFIG_DIR, 'settings.json'), 'utf8'));
  assert.ok(settings.providers?.kunlunmeta, 'The existing target must configure the selected provider');
  const workspace = run.pathInState('workspace');
  const config = run.pathInState('config');
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await mkdir(config, { recursive: true, mode: 0o700 });
  await run.writeStateJson('config/settings.json', { ...settings, providers: { kunlunmeta: settings.providers.kunlunmeta } });
  const serversFile = await run.writeStateJson('servers.json', [{ id: 'owned', label: 'Owned model acceptance',
    runtime: 'kcoder', transport: 'local', workspace }]);
  const gateway = await startGateway(run, { label: 'owned-preview-provider', workspace, serversFile,
    serversStore: run.pathInState('servers-store.json'), kcoderBin: process.env.KCODER_RELAY_KCODER_BIN,
    env: { ...modelEnv, KCODER_CONFIG_DIR: config, KCODER_STUDIO_MOCK: '0', KCODER_STUDIO_P2P: '0',
      KCODER_MAX_TOKENS: '512', KCODER_MAX_RETRIES: '0', KCODER_MAX_DURATION_SECS: '60' } });
  const token = await waitForGatewayRpcToken(run, gateway);
  const rpc = await openRpc(`${gateway.wsUrl}/rpc?${new URLSearchParams({ server: 'owned', token })}`);
  run.addCleanup('close owned model acceptance RPC', () => closeRpcAndWait(rpc));
  await initializeRpc(rpc, 'owned-preview-provider-acceptance');
  const created = await rpc.request('thread/start', { cwd: workspace });
  assert.ok(created.thread?.id, 'The owned conversation must be created');
  const threadId = created.thread.id;
  const started = await rpc.request('turn/start', { threadId,
    input: [{ type: 'text', text: 'Reply only OK. Do not call any tools.' }] }, 30000);
  assert.ok(started.turn?.id || started.turnId, 'The real turn must be accepted with provider credentials');
  const completed = await rpc.waitFor(frame => frame.method === 'turn/completed' && frame.params?.threadId === threadId,
    70000, 'owned real model completion');
  const status = completed.params?.turn?.status ?? completed.params?.status;
  assert.equal(status, 'completed', 'The configured provider must complete the bounded real turn');
  const read = await rpc.request('thread/read', { threadId });
  assert.ok(read.messages?.some(message => message.role === 'assistant' && message.content?.trim()),
    'A persisted assistant response must be present; the user prompt does not prove a model response');
  let currentGatewayDefaultVerified = false;
  if (process.env.KCODER_E2E_LIVE_GATEWAY_CONNECTIVITY === '1') {
    const login = new URL((await readFile(process.env.KCODER_E2E_CONNECTIVITY_LOGIN_FILE, 'utf8')).trim());
    const pairingToken = new URLSearchParams(login.hash.slice(1)).get('token');
    assert.ok(pairingToken);
    run.registerSecret(pairingToken);
    const base = login.searchParams.get('gateway');
    assert.equal(new URL(base).origin, new URL(process.env.KCODER_RELAY_PUBLIC_URL).origin);
    const response = await fetch(base + '/api/mobile/session', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: pairingToken, durableDeviceAuthorization: true, deviceLabel: 'Owned provider configuration acceptance' }) });
    assert.equal(response.status, 200);
    const session = await response.json();
    for (const value of [session.accessToken, session.refreshToken, session.rpcToken]) run.registerSecret(value);
    run.addCleanup('revoke owned current Gateway inspection device', async () => {
      const revoked = await fetch(base + '/api/mobile/session', { method: 'DELETE', headers: { authorization: `Bearer ${session.accessToken}` } });
      assert.equal(revoked.status, 204);
    });
    const endpoint = new URL(base + '/rpc'); endpoint.protocol = 'wss:';
    endpoint.search = new URLSearchParams({ server: 'local', token: session.rpcToken }).toString();
    const current = await openRpc(endpoint.toString(), { headers: { authorization: `Bearer ${session.accessToken}` } });
    run.addCleanup('close owned current Gateway inspection RPC', () => closeRpcAndWait(current));
    await initializeRpc(current, 'owned-preview-provider-inspection');
    const providers = await current.request('runtime.providers.list', {});
    const selected = providers.profiles?.find(profile => profile.isDefault);
    assert.ok(selected?.apiKeyConfigured, 'The actual public Gateway default model must resolve its provider credential');
    currentGatewayDefaultVerified = true;
  }
  return { credentialPassedToOwnedGateway: true, realTurnAccepted: true, status, realModelResponse: true,
    currentGatewayDefaultVerified,
    boundary: 'Owned Gateway/profile/workspace with the actual configured provider; user pending submissions untouched' };
});
