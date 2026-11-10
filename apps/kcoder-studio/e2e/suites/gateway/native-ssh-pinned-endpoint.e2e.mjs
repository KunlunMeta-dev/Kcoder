import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { startSshFixture } from '../../harness/ssh-fixture.mjs';
import { runE2E, requireExecutable } from '../../harness/run-context.mjs';
import { createNativeSshEndpointFactory } from '../../../src/remotes/native-ssh-endpoint.mjs';
import { captureNativeRemoteSourceClient } from '../../../src/remotes/source-client-owner.mjs';
import { workspaceCwdObservationTargetIdentity } from '../../../src/workspace-cwd-observation.js';

await runE2E(import.meta.url, {
  testId: 'owned-ssh-image-pin-standard-acp-initialize', tier: 'manual-live', retainSuccessEvidence: true,
  modelPolicy: 'Actual owned Linux sshd/keys/known-host/native image and original ACP initialize. Source client is a routing fixture; no Source Accepted, Receiver task, cross-physical-host, Office or model behavior claim.',
}, async context => {
  assert.equal(process.platform, 'linux');
  assert.equal(process.getuid(), 0, 'Owned sshd requires the existing explicit root fixture');
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'explicit immutable Native image');
  const before = await stat(binary);
  const sha = createHash('sha256').update(await readFile(binary)).digest('hex');
  assert.equal(sha, process.env.KCODER_E2E_KCODER_BIN_SHA256);
  const profile = context.pathInState('receiver-profile');
  const workspace = context.pathInState('receiver-workspace');
  await context.writeStateJson('receiver-profile/settings.json', { active_provider: 'owned',
    providers: { owned: { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
      endpoint: 'http://127.0.0.1:1/v1', default_model: 'never-called', context_window_tokens: 8192,
      output_headroom_tokens: 1024, max_output_tokens: 1024, discover_models: false } },
    memory: { observer_mode: 'disabled', structured_enabled: false }, session_memory: { enabled: false } });
  await context.writeStateJson('receiver-workspace/owned.json', { isolated: true });
  const ssh = await startSshFixture(context, { configDirectory: profile });
  const hostKey = (await readFile(join(ssh.root, 'host-key.pub'), 'utf8')).trim().split(/\s+/).slice(0, 2).join(' ');
  await writeFile(join(ssh.root, 'known_hosts'), `[127.0.0.1]:${ssh.port} ${hostKey}\n`, { mode: 0o600 });
  const target = { id: 'owned-receiver', runtime: 'kcoder', transport: 'ssh', host: '127.0.0.1',
    port: ssh.port, user: ssh.user, command: binary, remoteCwd: workspace,
    settingsFile: join(profile, 'settings.json') };
  const source = { id: 'routing-fixture', runtime: 'kcoder', transport: 'local' };
  const targets = new Map([[target.id, target], [source.id, source]]);
  const client = { initialized: true, authorizationOwner: 'routing-owner' };
  const broker = { closed: false, clients: new Set([client]) };
  const sourceClient = captureNativeRemoteSourceClient({ client, broker, sourceTarget: source,
    authorizationOwner: client.authorizationOwner, session: { allowedServerIds: new Set(targets.keys()) },
    verifySession: () => true, getTarget: id => targets.get(id), targetSignature: JSON.stringify,
    accountIdentity: () => null, accountGeneration: () => 1 });
  const sourceChild = {};
  let count = 0;
  const labels = new WeakMap();
  const factory = createNativeSshEndpointFactory({ assertSourceNativeChild({ child }) { assert.equal(child, sourceChild); },
    sourceClientForAttempt: () => sourceClient,
    spawnChild(command, args, options) {
      assert.equal(command, 'ssh');
      const label = `native-ssh-pin-${++count}`;
      const child = context.spawnOwned(label, '/usr/bin/ssh', ['-F', '/dev/null', '-i', join(ssh.root, 'client-key'),
        '-o', 'IdentitiesOnly=yes', '-o', `UserKnownHostsFile=${join(ssh.root, 'known_hosts')}`, ...args], { ...options, stdin: 'pipe' });
      labels.set(child, label);
      return child;
    }, stopChild: child => context.stopOwned(labels.get(child)) });
  context.addCleanup('close exact owned SSH endpoint factory', () => factory.close());
  const base = { child: sourceChild, serverId: source.id };
  const params = { operationId: 'routing-only-operation', endpointInstanceId: 'routing-only-endpoint',
    sourceAcceptedSha256: 'a'.repeat(64), sourceAttempt: { threadId: 'routing-only-thread', turnId: 'routing-only-turn', attemptId: 'routing-only-attempt' },
    deadlineUtcMs: Date.now() + 30000, target: { targetId: target.id,
      targetRevision: workspaceCwdObservationTargetIdentity(JSON.stringify(target)), targetPlatform: 'linux', expectedNativeSha256: sha } };
  const opened = await factory.handleOwnedRequest({ ...base, method: 'server/nativeRemote/open', params });
  assert.equal(opened.state, 'opened');
  await factory.handleOwnedRequest({ ...base, method: 'server/nativeRemote/exchange', params: { ...params,
    direction: 'frame_write', sequence: 1, frame: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'owned-pin-fixture', version: '1' } } } } });
  let reply;
  const deadline = Date.now() + 10000;
  let acknowledgeThrough = 0;
  while (!reply && Date.now() < deadline) {
    const result = await factory.handleOwnedRequest({ ...base, method: 'server/nativeRemote/exchange', params: {
      ...params, direction: 'frame_read', acknowledgeThrough, maximumFrames: 16, waitMs: 500 } });
    for (const item of result.frames) {
      acknowledgeThrough = item.sequence;
      if (item.frame.id === 1) reply = item.frame;
    }
  }
  assert.ok(reply, 'The original Native ACP process must reply');
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.protocolVersion, 1);
  assert.equal(reply.result.agentInfo.name, 'kcoder');
  const closed = await factory.handleOwnedRequest({ ...base, method: 'server/nativeRemote/close', params });
  assert.equal(closed.nativeOwnerCleanupConfirmed, false, 'SSH exit does not prove Native Receiver task cleanup');
  await assert.rejects(factory.handleOwnedRequest({ ...base, method: 'server/nativeRemote/open', params: {
    ...params, endpointInstanceId: 'wrong-pin-endpoint', target: { ...params.target, expectedNativeSha256: '0'.repeat(64) } } }));
  const after = await stat(binary);
  assert.deepEqual([after.dev, after.ino, after.size, after.nlink], [before.dev, before.ino, before.size, before.nlink]);
  assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'), sha);
  await context.writeArtifactJson('ssh-native-pin-evidence.json', { actualSshAuthentication: true, ownedKnownHost: true,
    sameConnectionImagePinAndExec: true, nativeSha256: sha, acpInitialize: true, wrongPinRejected: true,
    modelCalls: 0, actualSourceAccepted: false, actualReceiverTask: false, crossPhysicalHost: false,
    nativeOwnerCleanupConfirmed: false });
});
