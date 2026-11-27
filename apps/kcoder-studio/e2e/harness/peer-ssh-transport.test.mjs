import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { RunContext, isolatedEnvironment } from './run-context.mjs';
import { startSshFixture } from './ssh-fixture.mjs';
import { startPeerSshTargets } from './peer-ssh-targets.mjs';
import { capturePeerSshLaunch, peerSshLaunchArguments, observePeerSshAuthentication,
  isCapturedPeerSshTransport } from '../../src/remotes/peer-ssh-transport.mjs';
import { launchSpec } from '../../src/server-config.js';
import { WorkspaceAppServerBroker } from '../../src/workspace-app-server-broker.js';
import { ROUTER_METHODS, ROUTER_CAPABILITY } from '../../src/agent-message-router-private.js';

const target = { id: 'owned-ssh', runtime: 'kcoder', transport: 'ssh', host: '127.0.0.1', user: 'owned', command: '/owned/kcoder' };

test('public JSON, labels and true capability booleans cannot mint a Peer SSH launch', () => {
  assert.throws(() => capturePeerSshLaunch({ target, fingerprint: { authenticated: true, verify() {} }, verifyCurrent() {} }), /SSH_LAUNCH_UNAVAILABLE/);
  assert.throws(() => peerSshLaunchArguments({ nonce: 'a'.repeat(64) }, target), /SSH_LAUNCH_UNAVAILABLE/);
  assert.throws(() => launchSpec(target, { peerSshLaunch: { peerParent: true } }), /SSH_LAUNCH_UNAVAILABLE/);
  const spec = launchSpec(target);
  assert.equal(spec.command, 'ssh');
  assert.deepEqual(spec.args.slice(-2), ['/owned/kcoder', 'app-server']);
  assert.ok(!spec.args.some(value => value.includes('peer-router-parent')));
  assert.equal(isCapturedPeerSshTransport({ ready: true, assertCurrent() {} }), false);
});

test('a real local process emitting forged OpenSSH diagnostics cannot become an authenticated SSH transport', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'reject-local-ssh-diagnostic-forgery',
    tier: 'model-independent', modelPolicy: 'Actual owned local process negative control; no Native or model authority claim.' });
  let failure;
  try {
    const child = context.spawnOwned('forged-ssh-diagnostics', process.execPath, ['-e',
      'setTimeout(()=>process.stderr.write("debug1: Server host key: ssh-ed25519 SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\\ndebug1: Authenticating to 127.0.0.1 as \'owned\'\\nAuthenticated to 127.0.0.1 using \\\"publickey\\\".\\n"),100);setInterval(()=>{},1000)'], { stdin: 'pipe' });
    child.spawnfile = 'ssh';
    const observed = observePeerSshAuthentication({ child, target, isTrackedChild: value => value === child,
      verifyCurrent() {}, timeoutMs: 3_000 });
    await assert.rejects(observed.ready, /SSH_IMAGE_CHANGED/);
    assert.equal(isCapturedPeerSshTransport(observed, child), false);
  } catch (error) { failure = error; throw error; }
  finally { await context.finish(failure ? 'failed' : 'passed', { actualLocalProcessForgeryRejected: true }, failure); }
});

test('an ordinary SSH broker cannot invoke a private route using a forged transport object', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, adapter: { toBackend: value => value, fromBackend: value => value },
    maxMessageBytes: 65536, serverId: target.id, targetTransport: 'ssh' });
  broker.initializeResponse = { result: { capabilities: { experimental: { [ROUTER_CAPABILITY]: true } } } };
  broker.peerSshTransport = { ready: true, assertCurrent() {} };
  try { await assert.rejects(broker.sendAgentMessageRouterRequest(ROUTER_METHODS.identity, {}), /ROUTER_UNSUPPORTED/); }
  finally { child.emit('close', 0, null); }
});

test('actual SSH binds the authenticated key/user, waits for probe close and rejects changed scope or known-host policy', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'actual-ssh-peer-launch-fences',
    tier: 'model-independent', modelPolicy: 'Actual owned loopback OpenSSH authentication and kernel process/policy negative controls; no Native/model/different-UID claim.' });
  let failure;
  try {
    const ssh = await startSshFixture(context, { strictKnownHost: true });
    const selected = { ...target, user: ssh.user, port: ssh.port };
    let current = true;
    const verifyCurrent = () => { if (!current) throw new Error('OWNED_ACCOUNT_OR_CATALOG_GENERATION_CHANGED'); };
    const child = context.spawnOwned('actual-ssh-observation', 'ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'LogLevel=DEBUG1',
      '-p', String(ssh.port), `${ssh.user}@${ssh.listenHost}`, '/bin/sleep', '20'],
    { stdin: 'pipe', env: isolatedEnvironment(ssh.gatewayEnv, [], { HOME: context.pathInState('home') }) });
    const observed = observePeerSshAuthentication({ child, target: selected,
      isTrackedChild: value => value === child, verifyCurrent, timeoutMs: 10_000 });
    const facts = await observed.ready;
    assert.equal(facts.username, ssh.user); assert.match(facts.key, /^ssh-ed25519 SHA256:/);
    const original = { statSync: fs.statSync, readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync };
    const warm = { metadata: 0, bodyReads: 0, writes: 0 };
    try {
      fs.statSync = (...args) => { warm.metadata++; return original.statSync(...args); };
      fs.readFileSync = (...args) => { warm.bodyReads++; return original.readFileSync(...args); };
      fs.writeFileSync = (...args) => { warm.writes++; return original.writeFileSync(...args); };
      syncBuiltinESMExports();
      for (let tick = 0; tick < 10; tick++) facts.verify();
    } finally { Object.assign(fs, original); syncBuiltinESMExports(); }
    assert.ok(warm.metadata >= 10 && warm.metadata <= 40, 'Warm SSH identity checks have bounded metadata I/O');
    assert.equal(warm.bodyReads, 0); assert.equal(warm.writes, 0);
    await context.writeArtifactJson('peer-ssh-warm-io.json', { ...warm, checks: 10,
      fullExecutableReads: 0, nativeParentIoMeasured: false });
    assert.throws(() => capturePeerSshLaunch({ target: selected, fingerprint: facts, verifyCurrent }), /PROBE_EXIT_UNCONFIRMED/);
    await context.stopOwned('actual-ssh-observation');
    assert.throws(() => observed.verify(), /SSH_TRANSPORT_CLOSED/);
    const launch = capturePeerSshLaunch({ target: selected, fingerprint: facts, verifyCurrent });
    const args = peerSshLaunchArguments(launch, selected);
    assert.equal(args[0], '--peer-router-parent-ssh-v1'); assert.match(args[1], /^[a-f0-9]{64}$/);
    current = false;
    assert.throws(() => peerSshLaunchArguments(launch, selected), /GENERATION_CHANGED/);
    current = true;
    await writeFile(`${ssh.root}/known_hosts`, '# revoked owned host key\n', { mode: 0o600 });
    assert.throws(() => peerSshLaunchArguments(launch, selected), /SSH_POLICY_CHANGED/);
  } catch (error) { failure = error; throw error; }
  finally { await context.finish(failure ? 'failed' : 'passed', { actualSshAuthentication: true,
    oldTransportAfterCloseRejected: true, generationChangeRejected: true, changedKnownHostPolicyRejected: true }, failure); }
});

test('an actual older Native initializes over ordinary SSH without being granted a Peer parent',
  { skip: !process.env.KCODER_E2E_PEER_UNSUPPORTED_BIN }, async () => {
    const context = await RunContext.create(import.meta.url, { testId: 'actual-old-native-ssh-peer-unsupported',
      tier: 'model-independent', modelPolicy: 'Explicitly supplied older Native, owned HTTP login and actual SSH initialization negative control only. No peer message or model behavior claim.' });
    let failure;
    try {
      await assert.rejects(startPeerSshTargets(context, process.env.KCODER_E2E_PEER_UNSUPPORTED_BIN), error =>
        error?.code === 'ERR_ASSERTION' && error.actual === false && error.expected === true &&
        /Actual Native crossSessionDiscoveryV1 is required/.test(error.message));
    } catch (error) { failure = error; throw error; }
    finally { await context.finish(failure ? 'failed' : 'passed', { actualOldNativeSshInitialized: true,
      peerParentUnsupported: true, peerMessagesSent: 0 }, failure); }
  });
