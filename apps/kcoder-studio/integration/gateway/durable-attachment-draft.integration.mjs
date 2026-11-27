import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { startApprovalModelFixture } from '../../e2e/harness/approval-model.mjs';
import { startGateway } from '../../e2e/harness/gateway.mjs';
import { closeRpcAndWait, gatewayRpcUrl, initializeRpc, openRpc } from '../../e2e/harness/rpc.mjs';
import { repoRoot, runIntegration } from '../../e2e/harness/run-context.mjs';
import { materializeWorkspace } from '../../e2e/harness/workspace-fixture.mjs';

// Actual Gateway, durable device login and app-server restarts. The loopback
// Provider only completes a turn; this does not prove model or device behavior.
await runIntegration(import.meta.url, { testId: 'durable-composer-draft-survives-gateway-and-native-restart',
  tier: 'full-integration', retainSuccessEvidence: true, retainSuccessLogs: true,
  modelPolicy: 'model-independent attachment bytes, restart, authority and history persistence',
}, async context => {
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'draft-restart' });
  const provider = await startApprovalModelFixture(context, { textOnly: true, textOnlyResponse: 'DRAFT_ACCEPTED' });
  const settingsFile = await context.writeStateJson('config/settings.json', {
    active_provider: 'fixture', providers: { fixture: { api_format: 'openai_chat_completions',
      authentication: { mode: 'none' }, endpoint: provider.baseUrl, default_model: 'fixture',
      context_window_tokens: 128000, max_output_tokens: 64, output_headroom_tokens: 8192, no_proxy: true } },
  });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Draft fixture',
    transport: 'local', command: binary, workspace, settingsFile }]);
  let gateway;
  const launch = async label => {
    gateway = await startGateway(context, { label, auth: true, ...(gateway ? { authToken: gateway.authToken } : {}),
      workspace, serversFile, kcoderBin: binary, env: { KCODER_CONFIG_DIR: dirname(settingsFile) } });
  };
  const credentials = async (route, body) => {
    const response = await fetch(`${gateway.baseUrl}${route}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200, 'owned device authentication');
    const grant = await response.json();
    for (const key of ['accessToken', 'refreshToken', 'rpcToken']) context.registerSecret(grant[key]);
    return grant;
  };
  const connect = async (grant, label) => {
    const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', grant.rpcToken), {
      headers: { authorization: `Bearer ${grant.accessToken}`, origin: gateway.baseUrl } });
    context.addCleanup(`close ${label}`, () => closeRpcAndWait(rpc));
    const result = await initializeRpc(rpc, label);
    assert.equal(result.capabilities.experimental.durableAttachmentDraftsV1, true);
    return rpc;
  };
  await launch('draft-before-restart');
  let grant = await credentials('/api/mobile/session', { token: gateway.authToken,
    durableDeviceAuthorization: true, deviceLabel: 'owned-draft-device', requestInitialServers: false });
  let rpc = await connect(grant, 'draft-uploader');
  const { thread } = await rpc.request('thread/start', { cwd: workspace });
  const firstProcess = (await rpc.request('server/resources/read')).processId;
  const bytes = Buffer.from('Durable unsent attachment\n');
  const upload = await rpc.request('attachment/save', { filename: 'draft.txt', content_base64: bytes.toString('base64') });
  const retain = (client, paths, threadId = thread.id) => client.request('gateway/attachments/retain', { paths, threadId, durable: true });
  const sealed = await retain(rpc, [upload.path]);
  const path = sealed.drafts[0].path;
  assert.notEqual(path, upload.path);
  assert.deepEqual(await retain(rpc, [upload.path]), sealed, 'retry keeps the original receipt');
  await rpc.request('attachment/delete', { path: upload.path });
  await closeRpcAndWait(rpc);
  await context.stopOwned('draft-before-restart');
  assert.deepEqual(await readFile(path), bytes, 'disconnect and both process exits preserve sealed bytes');

  await launch('draft-after-restart');
  grant = await credentials('/api/mobile/session/refresh', { refreshToken: grant.refreshToken,
    deviceId: grant.deviceId, rotationId: randomUUID() });
  rpc = await connect(grant, 'draft-restored-device');
  await rpc.request('thread/resume', { threadId: thread.id });
  assert.notEqual((await rpc.request('server/resources/read')).processId, firstProcess);
  const restored = await retain(rpc, [path]);
  assert.equal(restored.drafts[0].path, path);
  assert.equal((await retain(rpc, [upload.path])).drafts[0].path, path, 'lost original receipt also recovers after restart');
  assert.equal((await readdir(dirname(dirname(dirname(path))))).filter(name => name.startsWith('d-')).length, 1);
  assert.equal((await rpc.request('attachment/read', { threadId: thread.id, path })).contentBase64, bytes.toString('base64'));
  const { thread: other } = await rpc.request('thread/start', { cwd: workspace });
  await assert.rejects(retain(rpc, [path], other.id), /another|not found|refusing/);
  const peerGrant = await credentials('/api/mobile/session', { token: gateway.authToken,
    durableDeviceAuthorization: true, deviceLabel: 'foreign-draft-device', requestInitialServers: false });
  const peer = await connect(peerGrant, 'foreign-draft-device');
  await assert.rejects(retain(peer, [path]), /another owner/);
  await closeRpcAndWait(peer);

  const text = `Read this attachment\n<kcoder_attachments version="1">\n${JSON.stringify({ filename: 'draft.txt', path })}\n</kcoder_attachments>`;
  const started = await rpc.request('turn/start', { threadId: thread.id, clientMessageId: randomUUID(), input: [{ type: 'text', text }] });
  await rpc.waitFor(message => message.method === 'turn/completed' && message.params?.threadId === thread.id &&
    message.params?.turnId === started.turn.id, 30_000, 'attachment turn completion');
  await assert.rejects(readFile(path), error => error.code === 'ENOENT', 'accepted input releases only the draft copy');
  const history = await rpc.request('thread/read', { threadId: thread.id });
  const encoded = JSON.stringify(history);
  assert.ok(encoded.includes('draft.txt'));
  assert.ok(encoded.includes('DRAFT_ACCEPTED'));
  // The historical attachment is reachable through the original staged alias
  // on this connection, although its sealed draft copy has been deleted.
  assert.equal((await rpc.request('attachment/read', { threadId: thread.id, path })).contentBase64, bytes.toString('base64'));
  const historyRoot = resolve(dirname(path), '../../../attachments');
  const historyEntries = await readdir(historyRoot);
  assert.equal(historyEntries.length, 1);
  const historicalPath = resolve(historyRoot, historyEntries[0], '00-draft.txt');
  assert.deepEqual(await readFile(historicalPath), bytes);
  await closeRpcAndWait(rpc);
  await context.stopOwned('draft-after-restart');
  await launch('draft-history-restarted');
  grant = await credentials('/api/mobile/session/refresh', { refreshToken: grant.refreshToken,
    deviceId: grant.deviceId, rotationId: randomUUID() });
  rpc = await connect(grant, 'draft-history-reader');
  await rpc.request('thread/resume', { threadId: thread.id });
  assert.equal((await rpc.request('attachment/read', { threadId: thread.id, path: historicalPath })).contentBase64, bytes.toString('base64'));
  assert.equal(provider.requests.length, 1, 'recovery never repeats an accepted turn');
  await context.writeArtifactJson('durable-draft-restart.json', { gatewayRestarted: true, nativeRestarted: true,
    deviceRefreshPreservesOwner: true, duplicateDrafts: 0, foreignThreadDenied: true, foreignDeviceDenied: true,
    draftReleasedAfterAcceptance: true, historyBytesPreserved: true, modelCalls: provider.requests.length });
});
