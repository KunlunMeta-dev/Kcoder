import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { copyFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import { connect, createServer as createNetServer } from 'node:net';
import { abortableResponseDelay } from './approval-model.mjs';
import { rpcClient } from './rpc.mjs';
import { selectSuites, suiteEnvironmentNames } from './runner-options.mjs';
import { preparePackagedStartupResources } from '../../desktop/packaged-resource-startup.mjs';
import { openOwnedDeviceRpc } from './owned-device-rpc.mjs';
import { RunContext, runE2E, waitFor } from './run-context.mjs';
import { installWebSocketReadyStateProbeInPage } from './websocket-ready-state-probe.mjs';
import { verifyFormalDesktopMaterialTransfer } from './desktop-target-material.mjs';
import { ownedLoopbackHostResolverArgument } from './chromium.mjs';
import { withReplacedOwnedProfile } from './remote-original-identity-boundaries.mjs';
import { startGateway } from './gateway.mjs';
import { runWindowsTaskBoardStatusProbe } from './windows-task-board-status-probe.mjs';
import { createOctopPublicFrameCollector } from './octop-search-baseline.mjs';
import { closeOriginalMigrationProcess } from './windows-migration-task-continuation.mjs';
import { dropCommittedProviderSaveReply } from './save-reply-fault.mjs';
import { canRetryOwnedRelayStartup, startLocalRelay } from './local-relay.mjs';
import { startRelay } from '../../../kcoder-relay/src/server.mjs';
import { startPipedFullProfile } from './full-profile-kcoder.mjs';
import { closePhysicalProductDiagnostic } from './physical-web-ssh-diagnostic.mjs';

class RpcSocket extends EventTarget {
  sent = [];
  closed = false;
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.closed = true; }
  receive(value) { this.dispatchEvent(new MessageEvent('message', { data: value })); }
}

test('physical diagnostic cleanup settles independent owned boundaries after stdin and stop fail', async () => {
  const order = [], stdinError = new Error('owned stdin failed'), stopError = new Error('owned stop failed');
  const child = { exitCode: null, signalCode: null, stdin: { end() { order.push('stdin'); throw stdinError; } } };
  const context = { async stopOwned(label) { assert.equal(label, 'physical-product-ssh-diagnostic'); order.push('stop'); throw stopError; } };
  const rpc = { closeReader() { order.push('reader'); }, failPending(error) { assert.match(error.message, /outcomes remain unknown/); order.push('pending'); } };
  await assert.rejects(closePhysicalProductDiagnostic(context, child, rpc, {
    async waitForClose() { order.push('wait'); throw new Error('owned grace deadline'); },
  }), error => error instanceof AggregateError && error.errors[0] === stdinError && error.errors[1] === stopError);
  assert.deepEqual(order, ['stdin', 'wait', 'stop', 'reader', 'pending']);
});

test('a reader cleanup error cannot skip physical diagnostic pending outcomes', async () => {
  const readerError = new Error('owned reader failed'); let settled = false;
  await assert.rejects(closePhysicalProductDiagnostic({}, { exitCode: 0, signalCode: null }, {
    closeReader() { throw readerError; }, failPending() { settled = true; },
  }), error => error instanceof AggregateError && error.errors[0] === readerError);
  assert.equal(settled, true);
});

test('server request IDs cannot settle client RPC requests', async () => {
  const socket = new RpcSocket(), client = rpcClient(socket);
  let settled = false;
  const result = client.request('thread/read', {});
  void result.then(() => { settled = true; });
  socket.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'approval/request', params: {} }));
  await Promise.resolve();
  assert.equal(settled, false);
  socket.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { original: true } }));
  assert.deepEqual(await result, { original: true });
});

test('malformed RPC frames settle pending work as unknown without throwing from an event listener', async () => {
  const socket = new RpcSocket(), client = rpcClient(socket);
  const rejected = assert.rejects(client.request('turn/start', {}), /outcome is unknown/);
  assert.doesNotThrow(() => socket.receive('not-json'));
  await rejected;
  assert.equal(socket.closed, true);
});

test('a failing RPC waiter predicate rejects that waiter and preserves other requests', async () => {
  const socket = new RpcSocket(), client = rpcClient(socket), failure = new Error('owned predicate failure');
  const rejected = assert.rejects(client.waitFor(() => { throw failure; }, 1000, 'owned predicate'), error => error === failure);
  socket.receive(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: {} }));
  await rejected;
  assert.equal(socket.closed, false);
});

test('already closed approval responses allocate no delay and no timer', async () => {
  for (const state of [{ destroyed: true }, { writableEnded: true }]) {
    const response = Object.assign(new EventEmitter(), state), timers = new Set();
    assert.equal(await abortableResponseDelay(response, 30_000, timers), false);
    assert.equal(timers.size, 0);
    assert.equal(response.listenerCount('close'), 0);
  }
});

test('unsupported WebSocket instrumentation preserves the created application socket', () => {
  class Socket { constructor(url) { this.url = url; } send() {} }
  Socket.CLOSED = 3;
  Socket.prototype.readyState = 1;
  const window = { WebSocket: Socket, location: { href: 'http://127.0.0.1/' } };
  vm.runInNewContext(`(${installWebSocketReadyStateProbeInPage.toString()})()`, { window, URL });
  const socket = new window.WebSocket('ws://127.0.0.1/rpc?channel=runtime');
  assert.equal(socket instanceof Socket, true);
  assert.equal(socket.readyState, 1);
  assert.equal(window.__kcoderE2eWebSocketReadyStateProbe.unsupportedReadyStateSourceCount, 1);
  assert.equal(window.__kcoderE2eWebSocketReadyStateProbe.runtimeSockets.length, 0);
});

test('optional native metadata accepts parsed null without bypassing cancellation', async () => {
  const calls = [];
  const result = await preparePackagedStartupResources({
    readMetadata: async () => null,
    channel: async options => { calls.push(options.appMetadata); },
    component: async options => { calls.push(options.appMetadata); },
  });
  assert.deepEqual(calls, [null, null]);
  assert.equal(Object.hasOwn(result, 'relayPublicUrl'), false);
});

test('registry real-model suites outside the model folder require both explicit consents', () => {
  const suite = 'suites/mobile/mobile-qa-real-provider-history.e2e.mjs';
  assert.throws(() => selectSuites([suite], ['--suite', suite], {}), /consent/);
  assert.throws(() => selectSuites([suite], ['--real-model'], {}), /both explicit consents/);
  assert.deepEqual(selectSuites([suite], [], {}), []);
  assert.deepEqual(selectSuites([suite], ['--suite', suite, '--real-model'], { KCODER_E2E_REAL_MODEL: '1' }), [suite]);
  const names = suiteEnvironmentNames(suite, {});
  for (const name of ['KCODER_E2E_MODEL_PROFILE', 'KCODER_CONFIG_DIR', 'KCODER_E2E_REAL_MODEL_PREREQUISITE_ONLY']) assert.ok(names.includes(name));
});

test('Office prices are forwarded only to their registered cost-bounded suite', () => {
  const names = ['KCODER_E2E_OFFICE_INPUT_USD_PER_MILLION', 'KCODER_E2E_OFFICE_OUTPUT_USD_PER_MILLION', 'KCODER_E2E_OFFICE_MAX_USD'];
  for (const name of names) {
    assert.ok(suiteEnvironmentNames('../integration/model/real-model-kworker-office.integration.mjs', {}).includes(name));
    assert.equal(suiteEnvironmentNames('../integration/gateway/auth-multitarget.integration.mjs', {}).includes(name), false);
  }
});

test('Chromium accepts only exact owned Relay DNS names for loopback mapping', () => {
  const host = `g-${'a'.repeat(40)}.relay.kcoder.localhost`;
  assert.equal(ownedLoopbackHostResolverArgument([host]), `--host-resolver-rules=MAP ${host} 127.0.0.1`);
  for (const candidate of ['*.relay.kcoder.localhost', 'example.com', `${host},MAP * 127.0.0.1`, '127.0.0.1']) {
    assert.throws(() => ownedLoopbackHostResolverArgument([candidate]), /exact owned/);
  }
});

test('Octop frame collection retains an EOF-delimited final result and rejects incomplete JSON', () => {
  const collector = createOctopPublicFrameCollector();
  collector.push('OCTOP_RESEARCH {"type":"ready"}\nOCTOP_RESEARCH {"type":"sample_');
  collector.push('end","ok":true}');
  collector.finish();
  assert.deepEqual(collector.frames, [{ type: 'ready' }, { type: 'sample_end', ok: true }]);
  assert.equal(collector.malformed, false);
  const malformed = createOctopPublicFrameCollector();
  malformed.push('OCTOP_RESEARCH {"type":"ready"');
  malformed.finish();
  assert.equal(malformed.malformed, true);
  assert.equal(malformed.frames.length, 0);
});

test('failed fault-evidence publication cannot suppress the intended original socket loss', async () => {
  const calls = [];
  let callbackError;
  assert.equal(dropCommittedProviderSaveReply({ destroy() { calls.push('destroy'); } }, '/owned/evidence',
    error => { callbackError = error; }, {
      persist() { calls.push('persist'); throw new Error('Owned evidence EEXIST'); },
      diagnostic() { calls.push('diagnostic'); },
    }), true);
  await Promise.resolve();
  assert.deepEqual(calls, ['destroy', 'persist', 'diagnostic']);
  assert.equal(callbackError.code, 'E2E_FAULT_EVIDENCE_UNCONFIRMED');
});

test('one attachment release failure cannot prevent release of a second owned target', async () => {
  const released = [];
  const rpc = name => {
    let contents;
    return { async request(method, params) {
      if (method === 'attachment/upload/start') return { upload_id: name };
      if (method === 'attachment/upload/chunk') { contents = params.content_base64; return {}; }
      if (method === 'attachment/upload/finish') return { path: `${name}-owned` };
      if (method === 'attachment/read') {
        if (params.path !== `${name}-owned`) throw new Error('Attachment belongs to the other target');
        return { contentBase64: contents, size: Buffer.from(contents, 'base64').length };
      }
      if (method === 'attachment/delete') {
        released.push(name);
        if (name === 'local') throw new Error('owned local release failed');
        return {};
      }
      throw new Error('Unexpected attachment fixture method');
    } };
  };
  await assert.rejects(verifyFormalDesktopMaterialTransfer({ addCleanup() {} }, {
    local: rpc('local'), remote: rpc('remote'), localThreadId: 'owned-local', remoteThreadId: 'owned-remote',
  }), /cleanup was not confirmed/);
  assert.deepEqual(released, ['local', 'remote']);
});

test('owned Mobile session revocation still runs after its RPC close fails', async () => {
  const calls = [], cleanup = [];
  const socket = new EventTarget();
  socket.readyState = 1;
  const client = { socket, request: async () => ({ ready: true }), close() { throw new Error('owned close failed'); } };
  const owner = await openOwnedDeviceRpc({ registerSecret() {}, addCleanup: (_name, fn) => cleanup.push(fn) },
    { baseUrl: 'http://127.0.0.1:43111', wsUrl: 'ws://127.0.0.1:43111', authToken: 'owned' }, 'local', undefined, {
      connect: async () => client,
      fetchImpl: async (_url, options) => {
        calls.push(options.method);
        return options.method === 'POST'
          ? { status: 200, json: async () => ({ accessToken: 'owned-access', rpcToken: 'owned-rpc' }) }
          : { status: 204 };
      },
    });
  await assert.rejects(owner.close(), /cleanup was not confirmed/);
  assert.deepEqual(calls, ['POST', 'DELETE']);
});

test('installer protocol rejects null JSON without killing its owned fixture', async () => {
  await runE2E(import.meta.url, { testId: 'installer-body-shape-a', tier: 'contract' }, async context => {
    await context.writeStateJson('.owner.json', { owner: 'owned-installer-protocol-a' });
    const ready = context.pathInState('installer-ready.json');
    context.spawnOwned('owned-installer-protocol', process.execPath,
      [fileURLToPath(new URL('./windows-installer-model.cjs', import.meta.url)), ready]);
    const state = await waitFor(async () => {
      try { return JSON.parse(await readFile(ready, 'utf8')); } catch { return null; }
    }, 5000, 'owned installer protocol readiness', 20, context.abortSignal);
    context.registerPort('owned-installer-protocol', state.port);
    const url = `http://127.0.0.1:${state.port}`;
    for (const body of ['null', '[]', '1']) {
      const response = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(1000) });
      assert.equal(response.status, 400);
    }
    const response = await fetch(url, { method: 'POST', body: '{}', signal: AbortSignal.timeout(1000) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /WINDOWS_HISTORY_REPLY/);
  });
});

test('owned process shutdown has its own bounded lifecycle after a shorter generic cleanup budget', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'owned-stop-budget-a', tier: 'contract', cleanupTimeoutMs: 1 });
  let failure;
  try {
    const child = context.spawnOwned('owned-slow-term', process.execPath,
      ['-e', "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),30));console.log('ready');setInterval(()=>{},1000)"]);
    let ready = false;
    child.stdout.on('data', () => { ready = true; });
    await waitFor(() => ready, 5000, 'owned delayed shutdown readiness', 10, context.abortSignal);
  } catch (error) { failure = error; }
  await context.finish(failure ? 'failed' : 'passed', null, failure);
});

test('a child log stream error reaches owned cleanup without an uncaught event exception', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'owned-log-failure-a', tier: 'contract' });
  context.spawnOwned('owned-log-error', process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  const record = context.processes.get('owned-log-error');
  assert.doesNotThrow(() => record.log.emit('error', Object.assign(new Error('synthetic private diagnostic'), { code: 'EIO' })));
  assert.match(context.abortReason.message, /log stream failed \(EIO\)/);
  await assert.rejects(context.finish('failed', null, context.abortReason), /log stream failed/);
  assert.equal(record.stopped, true);
  assert.equal(context.finished, true);
});

test('an explicitly bounded cleanup can outlive a shorter generic cleanup budget', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'cleanup-deadline-override-a', tier: 'contract', cleanupTimeoutMs: 1 });
  let completed = false;
  context.addCleanup('owned delayed cleanup', async () => { await new Promise(done => setTimeout(done, 20)); completed = true; }, { timeoutMs: 1000 });
  assert.throws(() => context.addCleanup('invalid deadline', () => {}, { timeoutMs: 0 }), /positive integer/);
  await context.finish('passed');
  assert.equal(completed, true);
});

test('Gateway startup parses a real IPv6 announcement and targets that listener', async () => {
  await runE2E(import.meta.url, { testId: 'ipv6-gateway-parser-a', tier: 'contract' }, async context => {
    const gatewayRoot = context.pathInState('ipv6-gateway');
    await mkdir(gatewayRoot);
    await copyFile(fileURLToPath(new URL('./fixtures/high-risk-a-ipv6-gateway.mjs', import.meta.url)), resolve(gatewayRoot, 'dev-server.mjs'));
    const gateway = await startGateway(context, { host: '::1', gatewayRoot });
    assert.equal(new URL(gateway.baseUrl).hostname, '[::1]');
    assert.equal(new URL(gateway.wsUrl).hostname, '[::1]');
    const response = await fetch(gateway.baseUrl, { signal: AbortSignal.timeout(1000) });
    assert.equal(await response.text(), 'owned IPv6 startup parser');
  });
});

test('task-board startup failure closes its owned provider before any Native spawn', async () => {
  await runE2E(import.meta.url, { testId: 'task-board-startup-cleanup-a', tier: 'contract' }, async context => {
    await mkdir(context.pathInState('board-profile/settings.json'), { recursive: true });
    let port;
    await assert.rejects(runWindowsTaskBoardStatusProbe({ root: context.stateDir, binary: process.execPath, environment: {},
      onProviderListening: ownedPort => { port = ownedPort; context.registerPort('task-board-startup-failure', port); } }), { code: 'EISDIR' });
    assert.ok(Number.isInteger(port));
    await new Promise((accept, reject) => {
      const probe = connect(port, '127.0.0.1');
      probe.once('connect', () => { probe.destroy(); reject(new Error('Owned provider survived setup failure')); });
      probe.once('error', error => error.code === 'ECONNREFUSED' ? accept() : reject(error));
    });
  });
});

test('an actual owned port collision retries only after the original Relay startup rolled back', async () => {
  await runE2E(import.meta.url, { testId: 'relay-startup-port-collision-a', tier: 'contract' }, async context => {
    let launches = 0, occupiedPort;
    const blocker = createNetServer(socket => socket.destroy());
    context.addCleanup('close exact collision fixture listener', async () => {
      if (blocker.listening) await new Promise(resolveClose => blocker.close(resolveClose));
    });
    const relay = await startLocalRelay(context, {}, { launch: async options => {
      if (++launches === 1) {
        occupiedPort = options.proxyPort;
        await new Promise((accept, reject) => { blocker.once('error', reject); blocker.listen(occupiedPort, '127.0.0.1', accept); });
        context.registerPort('owned-collision-blocker', occupiedPort);
      }
      return startRelay(options);
    } });
    assert.equal(launches, 2); assert.notEqual(relay.proxyPort, occupiedPort);
    await relay.close();
  });
});

test('a present original startup lock or an unrelated failure forbids Relay retry', async () => {
  await runE2E(import.meta.url, { testId: 'relay-startup-lock-guard-a', tier: 'contract' }, async context => {
    const store = context.pathInState('owned-store.json');
    const collision = Object.assign(new Error('owned collision'), { code: 'EADDRINUSE' });
    await writeFile(`${store}.lock`, 'synthetic fixture only; no live worker');
    assert.equal(await canRetryOwnedRelayStartup(collision, store), false);
    await rm(`${store}.lock`);
    assert.equal(await canRetryOwnedRelayStartup(collision, store), true);
    assert.equal(await canRetryOwnedRelayStartup(Object.assign(new Error('denied'), { code: 'EACCES' }), store), false);
  });
});

test('a graceful migration close failure still closes its reader and settles pending RPCs', async () => {
  const calls = [];
  const child = { exitCode: null, signalCode: null,
    stdin: { destroyed: false, end() { calls.push('stdin-end'); } },
    kill(signal) { calls.push(signal); this.signalCode = signal; },
  };
  let waits = 0;
  await assert.rejects(closeOriginalMigrationProcess(child, {
    closeReader() { calls.push('reader-close'); },
    failPending(error) { assert.match(error.message, /outcomes remain unknown/); calls.push('pending-settled'); },
  }, { waitForClose: async () => { if (++waits === 1) throw new Error('Owned graceful close deadline'); } }), /cleanup was not confirmed/);
  assert.deepEqual(calls, ['stdin-end', 'SIGKILL', 'reader-close', 'pending-settled']);
});

test('full-profile app-server fixture rejects a TTY before creating its child', () => {
  let created = 0;
  assert.throws(() => startPipedFullProfile({ stdin: { isTTY: true }, stdout: { isTTY: false },
    spawnProcess: () => { created++; } }), /requires piped app-server stdio/);
  assert.equal(created, 0);
});

test('piped full-profile fixture preserves PID-directed signals and removes only its handlers', () => {
  const owner = new EventEmitter(), child = new EventEmitter(), signals = [];
  owner.stderr = { write() {} }; child.kill = signal => signals.push(signal);
  const peer = () => {};
  owner.on('SIGINT', peer);
  startPipedFullProfile({ stdin: { isTTY: false }, stdout: { isTTY: false }, owner,
    binary: '/owned/native', args: ['app-server'], spawnProcess: (binary, args, options) => {
      assert.equal(binary, '/owned/native'); assert.deepEqual(args, ['--tool-profile', 'full', 'app-server']);
      assert.equal(options.stdio, 'inherit'); assert.equal(Object.hasOwn(options, 'detached'), false); return child;
    } });
  owner.emit('SIGINT'); owner.emit('SIGTERM');
  assert.deepEqual(signals, ['SIGINT', 'SIGTERM']);
  child.emit('exit', 0); child.emit('close', 0);
  assert.equal(owner.exitCode, 0); assert.equal(owner.listenerCount('SIGINT'), 1); assert.equal(owner.listeners('SIGINT')[0], peer);
});

test('profile replacement cannot mutate the original when cleanup registration is refused', {
  skip: typeof process.getuid !== 'function' ? 'POSIX profile identity fixture' : false,
}, async () => {
  await runE2E(import.meta.url, { testId: 'profile-restore-registration-a', tier: 'contract' }, async context => {
    const settings = await context.writeStateJson('owned-profile/settings.json', { marker: 'original' });
    const profilePath = resolve(settings, '..');
    const original = await lstat(profilePath);
    const refusal = new Error('owned cleanup registration refused');
    const rejecting = Object.create(context);
    rejecting.addCleanup = () => { throw refusal; };
    await assert.rejects(withReplacedOwnedProfile(rejecting, profilePath, 'owned', async () => {}), error => error === refusal);
    assert.equal((await lstat(profilePath)).ino, original.ino);
    assert.equal(await readFile(settings, 'utf8'), '{\n  "marker": "original"\n}\n');
    await assert.rejects(lstat(`${profilePath}-original-identity-preserved`), { code: 'ENOENT' });
  });
});
