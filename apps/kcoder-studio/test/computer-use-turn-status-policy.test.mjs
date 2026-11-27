import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { gatewayRequestOutcome, gatewayRequestTimeoutMs } from '../shared/gatewayRequestDeadline.js';

const METHOD = 'computerUse/turn/status';
const CAPABILITY = 'computerUseTurnStatusV1';
const THREAD = 'computer-use-status-thread';

function fixture(targetTransport = 'local', backendSupports = true, cachedInitialize = true) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({
    child,
    targetTransport,
    remotePlatform: 'linux',
    adapter: {
      rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }),
    },
    maxMessageBytes: 1024 * 1024,
    serverId: 'computer-use-turn-status-policy',
    residentThreads: true,
  });
  const upstream = [];
  let pending = '';
  child.stdin.on('data', chunk => {
    pending += chunk.toString('utf8');
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      upstream.push(JSON.parse(pending.slice(0, newline)));
      pending = pending.slice(newline + 1);
    }
  });
  const initializeResult = {
    protocolVersion: '2026-07-27',
    serverInfo: { name: 'computer-use-status-fixture', version: '1' },
    capabilities: {
      experimental: {
        residentThreads: true,
        computerUseTurnV1: true,
        computerUseStatusV1: true,
        computerUseRecoveryV1: true,
        computerUseSessionAuthorizationV1: true,
        gatewaySharedThreadsV1: true,
        ...(backendSupports ? { [CAPABILITY]: true } : {}),
      },
    },
  };
  broker.initializeResponse = cachedInitialize
    ? { jsonrpc: '2.0', id: null, result: initializeResult }
    : null;

  const client = () => {
    const value = {
      channel: 'runtime',
      messages: [],
      send(message) { this.messages.push(message); return true; },
      pause() {},
      resume() {},
      close() {},
    };
    broker.attach(value);
    return value;
  };
  let initializeCount = 0;
  const request = (value, method, params, id = `${method}-request`) => {
    const before = upstream.length;
    broker.receive(value, JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return { forwarded: upstream.length > before, upstream: upstream.at(-1), response: value.messages.at(-1) };
  };
  const initialize = (value, offerStatus = true) => request(value, 'initialize', {
    protocolVersion: '2026-07-27',
    clientInfo: { name: 'computer-use-status-test', version: '1' },
    capabilities: { experimental: {
      [CAPABILITY]: offerStatus,
      gatewaySharedThreadsV1: true,
    } },
  }, `initialize-${++initializeCount}`);
  const respond = async (requestFrame, result) => {
    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestFrame.id, result })}\n`);
    await new Promise(resolve => setImmediate(resolve));
  };
  const resume = async (value, threadId) => {
    const resumed = request(value, 'thread/resume', { threadId }, `resume-${threadId}-${upstream.length}`);
    assert.equal(resumed.forwarded, true);
    await respond(resumed.upstream, { thread: { id: threadId } });
    return resumed;
  };

  return { broker, child, upstream, client, request, initialize, respond, resume, initializeResult };
}

test('the backend offer and frozen client choice both include the status capability', async () => {
  const f = fixture('local', true, false);
  const optedIn = f.client();
  const initializeRequest = f.initialize(optedIn, true);
  assert.equal(initializeRequest.upstream?.method, 'initialize');
  assert.equal(initializeRequest.upstream?.params?.capabilities?.experimental?.[CAPABILITY], true,
    'shared backend initialize requests the method regardless of connection order');
  assert.equal(optedIn[CAPABILITY], undefined, 'the offer is not enabled before initialize succeeds');

  await f.respond(initializeRequest.upstream, f.initializeResult);
  assert.equal(optedIn[CAPABILITY], true);
  assert.equal(optedIn.messages.at(-1)?.result?.capabilities?.experimental?.[CAPABILITY], true);

  const declined = f.client();
  const beforeCachedInitialize = f.upstream.length;
  f.initialize(declined, false);
  assert.equal(f.upstream.length, beforeCachedInitialize);
  assert.equal(declined[CAPABILITY], false);
  assert.equal(declined.messages.at(-1)?.result?.capabilities?.experimental?.[CAPABILITY], false);
  f.broker.clearTransientState();
});

test('only a local target projects the status capability, independently from desktop-control capability', () => {
  for (const transport of ['local', 'ssh', 'unknown']) {
    const f = fixture(transport);
    const client = f.client();
    f.initialize(client, true);

    const experimental = client.messages.at(-1)?.result?.capabilities?.experimental;
    const local = transport === 'local';
    assert.equal(client[CAPABILITY], true, 'the client choice is frozen after initialize');
    assert.equal(experimental?.[CAPABILITY], local);
    for (const name of [
      'computerUseTurnV1',
      'computerUseStatusV1',
      'computerUseRecoveryV1',
      'computerUseSessionAuthorizationV1',
    ]) assert.equal(experimental?.[name], local);
    f.broker.clearTransientState();
  }
});

test('status read requires negotiated client/backend support and the exact current thread owner', async () => {
  const f = fixture();
  const owner = f.client();
  const sharedReader = f.client();
  f.initialize(owner, true);
  f.initialize(sharedReader, true);

  await f.resume(owner, THREAD);
  await f.resume(sharedReader, THREAD);
  assert.equal(f.broker.threadOwners.get(THREAD), owner,
    'a successful shared resume must not replace the active owner');
  assert.equal(f.broker.sharedThreads.has(THREAD, sharedReader), true);

  const upstreamBeforePeerRead = f.upstream.length;
  const peerRead = f.request(sharedReader, METHOD, { threadId: THREAD, turnId: 'turn-peer' });
  assert.equal(peerRead.forwarded, false);
  assert.equal(peerRead.response?.error?.code, -32023);
  assert.equal(f.upstream.length, upstreamBeforePeerRead,
    'a shared reader is not the strict owner for computer-use status');

  const unnegotiated = f.client();
  f.initialize(unnegotiated, false);
  await f.resume(unnegotiated, 'unnegotiated-thread');
  assert.equal(unnegotiated[CAPABILITY], false);
  const upstreamBeforeUnnegotiatedRead = f.upstream.length;
  const declinedRead = f.request(unnegotiated, METHOD,
    { threadId: 'unnegotiated-thread', turnId: 'turn-unnegotiated' });
  assert.equal(declinedRead.forwarded, false);
  assert.equal(declinedRead.response?.error?.code, -32602);
  assert.equal(f.upstream.length, upstreamBeforeUnnegotiatedRead);

  const oldBackend = fixture('local', false);
  const optedIn = oldBackend.client();
  oldBackend.initialize(optedIn, true);
  await oldBackend.resume(optedIn, 'old-backend-thread');
  const upstreamBeforeUnsupportedRead = oldBackend.upstream.length;
  const unsupportedRead = oldBackend.request(optedIn, METHOD,
    { threadId: 'old-backend-thread', turnId: 'turn-old-backend' });
  assert.equal(unsupportedRead.forwarded, false);
  assert.equal(unsupportedRead.response?.error?.code, -32602);
  assert.equal(oldBackend.upstream.length, upstreamBeforeUnsupportedRead);
  oldBackend.broker.clearTransientState();
  f.broker.clearTransientState();
});

test('a negotiated local Linux owner forwards the read unchanged, including an absent observation', async () => {
  const f = fixture('local');
  const owner = f.client();
  f.initialize(owner, true);
  await f.resume(owner, THREAD);

  const drain = { timedOut: false, queue: [] };
  f.broker.threadDrains.set(THREAD, drain);
  const params = { threadId: THREAD, turnId: 'turn-current' };
  const read = f.request(owner, METHOD, params, 'status-read');
  f.broker.threadDrains.delete(THREAD);
  assert.equal(read.forwarded, true);
  assert.equal(drain.queue.length, 0, 'read-only status does not wait behind a thread drain');
  assert.equal(read.upstream?.method, METHOD);
  assert.deepEqual(read.upstream?.params, params);
  assert.equal(f.broker.activeTurns.size, 0, 'a read does not create a turn');
  assert.equal(f.broker.threadOwners.get(THREAD), owner);

  const unknown = { threadId: THREAD, turnId: 'turn-current', sequence: 12 };
  await f.respond(read.upstream, unknown);
  assert.deepEqual(owner.messages.at(-1), { jsonrpc: '2.0', id: 'status-read', result: unknown });
  assert.equal(Object.hasOwn(owner.messages.at(-1).result, 'observation'), false,
    'an absent observation stays unknown; the Gateway does not synthesize state');
  f.broker.clearTransientState();
});

test('the status method alone receives an exact read-only deadline classification', () => {
  assert.equal(gatewayRequestOutcome(METHOD), 'readOnly');
  assert.equal(gatewayRequestTimeoutMs(METHOD), 30_000);
  for (const method of [
    'computerUse/turn/status/read',
    'computerUse/turn/status/extra',
    'computerUse/turn/statusV1',
    'computerUse/turn/statusExtra',
  ]) {
    assert.equal(gatewayRequestOutcome(method), 'unknown', `${method} must retain unknown outcome`);
    assert.equal(gatewayRequestTimeoutMs(method), 120_000);
  }
});
