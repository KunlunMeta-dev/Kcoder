import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { startSshFixture } from '../../harness/ssh-fixture.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { login } from '../../harness/http.mjs';
import { openRpc, closeRpcAndWait, gatewayRpcUrl, isTurnCompletion } from '../../harness/rpc.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { runE2E, requireExecutable } from '../../harness/run-context.mjs';
import { verifyFormalDesktopMaterialTransfer } from '../../harness/desktop-target-material.mjs';

await runE2E(import.meta.url, { testId: 'native-local-desktop-versus-ssh-execution-target', tier: 'full-integration',
  modelPolicy: 'Actual Cookie-authenticated raw WS and normal Native app-server on local/owned loopback SSH targets. Deterministic no-desktop turn only. Linux negative host/platform admission; actual Windows input is a separate manual suite. No paid model or cross-host filesystem claim.' },
async context => {
  assert.equal(process.platform, 'linux');
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'explicit frozen normal CLI');
  const binarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  assert.equal(binarySha256, process.env.KCODER_E2E_KCODER_BIN_SHA256);
  const local = await materializeWorkspace(context, 'minimal', { instanceId: 'desktop-host' });
  const remote = await materializeWorkspace(context, 'minimal', { instanceId: 'ssh-execution' });
  const model = await startApprovalModelFixture(context, { responseSteps: ({ body }) => {
    assert.equal((body.tools ?? []).some(tool => tool.function?.name?.startsWith('mcp__kcoder_computer_use__')), false,
      'normal execution target permission must not mount desktop tools');
    return [{ delta: { role: 'assistant', content: 'OWNED_SSH_NORMAL_TURN' }, finishReason: 'stop' }];
  } });
  const settings = { credential_store: 'file', permission_mode: 'yolo', active_provider: 'fixture', mcp_servers: [], hooks: {},
    providers: { fixture: { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl,
      default_model: 'fixture', no_proxy: true, discover_models: false, context_window_tokens: 128000,
      max_output_tokens: 1024, output_headroom_tokens: 1024 } } };
  const localSettings = await context.writeStateJson('local-profile/settings.json', settings);
  const remoteSettings = await context.writeStateJson('remote-profile/settings.json', settings);
  const ssh = await startSshFixture(context, { strictKnownHost: true });
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const launch = async (name, profile) => {
    const path = context.pathInState(name);
    await writeFile(path, `#!/bin/sh\nexec env KCODER_CONFIG_DIR=${quote(profile)} ${quote(binary)} "$@"\n`, { mode: 0o700 });
    return path;
  };
  const serversFile = await context.writeStateJson('servers.json', [
    { id: 'desktop-local', label: 'Owned local desktop host', transport: 'local',
      command: await launch('local-launch', context.pathInState('local-profile')), workspace: local.path, settingsFile: localSettings },
    { id: 'execution-ssh', label: 'Owned SSH execution only', transport: 'ssh', host: '127.0.0.1', port: ssh.port, user: ssh.user,
      command: await launch('ssh-launch', context.pathInState('remote-profile')), workspace: remote.path, settingsFile: remoteSettings },
  ]);
  const gateway = await startGateway(context, { auth: true, workspace: local.path, serversFile, kcoderBin: binary,
    env: { ...ssh.gatewayEnv, KCODER_CONFIG_DIR: context.pathInState('local-profile') } });
  const cookie = await login(gateway.baseUrl, gateway.authToken); context.registerSecret(cookie);
  await waitForGatewayRpcToken(context, gateway, { headers: { cookie }, expectedToken: 'cookie-auth' });
  const proof = [];
  let materialProof;
  for (const serverId of ['desktop-local', 'execution-ssh']) {
    const rpc = await openRpc(gatewayRpcUrl(gateway, serverId, 'cookie-auth'), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
    context.addCleanup(`close ${serverId} protocol owner`, () => closeRpcAndWait(rpc, serverId));
    const initialized = await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'raw-desktop-boundary', version: '1' },
      capabilities: { experimental: { computerUseTurnV1: true, computerUseStatusV1: true,
        computerUseRecoveryV1: true, computerUseSessionAuthorizationV1: true } } });
    const threadId = (await rpc.request('thread/start')).thread.id;
    const requestsBefore = model.requests.length;
    const approved = { threadId, input: [{ type: 'text', text: 'REMOTE_DESKTOP_MUST_NOT_RUN' }],
      computerUse: { approved: true, target: 'local_windows_desktop' } };
    if (serverId === 'execution-ssh') {
      for (const name of ['computerUseTurnV1', 'computerUseStatusV1', 'computerUseRecoveryV1', 'computerUseSessionAuthorizationV1'])
        assert.equal(initialized.capabilities.experimental[name], false);
      for (const [method, params] of [['turn/start', approved], ['computerUse/status', {}],
        ['computerUse/recover', { threadId, previousTurnId: 'ungranted' }], ['computerUse/revoke', { threadId }]])
        await assert.rejects(rpc.request(method, params), /local target.*local desktop/);
    } else {
      const status = await rpc.request('computerUse/status');
      assert.equal(status.canControl, false); assert.equal(status.availability, 'unsupported_platform');
      await assert.rejects(rpc.request('turn/start', approved), /Windows/);
    }
    assert.equal(model.requests.length, requestsBefore);
    const beforeNormal = await rpc.request('thread/read', { threadId, includeTurns: true });
    assert.equal(JSON.stringify(beforeNormal).includes('REMOTE_DESKTOP_MUST_NOT_RUN'), false);
    if (serverId === 'execution-ssh') {
      const normal = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: 'Normal SSH task without desktop lease' }] });
      const completed = await rpc.waitFor(message => isTurnCompletion(message, threadId, normal.turn.id), 30000, 'normal SSH turn');
      assert.equal(completed.params.turn.status, 'completed');
      const localReader = await openRpc(gatewayRpcUrl(gateway, 'desktop-local', 'cookie-auth'),
        { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
      context.addCleanup('close local material reader', () => closeRpcAndWait(localReader, 'local material reader'));
      await localReader.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'owned-local-material-reader', version: '1' } });
      await localReader.request('thread/resume', { threadId: proof[0].threadId });
      materialProof = await verifyFormalDesktopMaterialTransfer(context, { local: localReader, remote: rpc,
        localThreadId: proof[0].threadId, remoteThreadId: threadId });
      await closeRpcAndWait(localReader, 'local material reader');
    }
    proof.push({ serverId, threadId, desktopApprovalRejected: true, noRejectedUserMessagePersisted: true,
      localPlatformSupported: false, executionDoesNotGrantDesktop: true });
    await closeRpcAndWait(rpc, serverId);
  }
  assert.equal(model.requests.length, 1);
  await context.writeArtifactJson('desktop-target-boundaries.json', { binarySha256, proof, deterministicModelRequests: model.requests.length,
    nativeDesktopActions: 0, paidModelCalls: 0, trueWindowsInteraction: 'separate_registered_manual_suite',
    formalFileTransfer: materialProof });
  return { localAndSshAdmissionVerified: true, rejectedDesktopRequests: 5, normalSshTurnCompleted: true, modelQualityTest: false };
});
