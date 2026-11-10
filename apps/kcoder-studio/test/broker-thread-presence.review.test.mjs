import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

const METHOD = 'thread/presence/read';
const CAPABILITY = 'threadPresenceReadV1';

function brokerFixture() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({
    child,
    adapter: {
      rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }),
    },
    maxMessageBytes: 1024 * 1024,
    serverId: 'thread-presence-review',
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
  const client = authorizationOwner => {
    const value = {
      channel: 'runtime', authorizationOwner, messages: [],
      send(message) { this.messages.push(message); return true; },
      pause() {}, resume() {}, close() {},
    };
    broker.attach(value);
    return value;
  };
  const request = async (owner, message) => {
    broker.receive(owner, JSON.stringify(message));
    await new Promise(resolve => setImmediate(resolve));
    return upstream.at(-1);
  };
  const fromAppServer = async message => {
    child.stdout.write(`${JSON.stringify(message)}\n`);
    await new Promise(resolve => setImmediate(resolve));
  };
  return { broker, child, upstream, client, request, fromAppServer };
}

function initializeParams(offer) {
  return {
    protocolVersion: '2026-07-27',
    clientInfo: { name: 'presence-review', version: '1' },
    capabilities: offer === undefined ? {} : { experimental: { [CAPABILITY]: offer } },
  };
}

function initializeResult(supported = true) {
  return {
    protocolVersion: '2026-07-27',
    serverInfo: { name: 'presence-fixture', version: '1' },
    capabilities: { experimental: { residentThreads: true, ...(supported ? { [CAPABILITY]: true } : {}) } },
  };
}

const unknownPresence = { status: 'unknown', threadId: 'thread-presence-1', reason: 'coldSourceNotAuthorized' };

test('presence capability is intersected with each frozen client offer for cached, waiter, and either arrival order', async () => {
  for (const mode of ['cached', 'waiter']) {
    for (const order of ['legacy-first', 'modern-first']) {
      const f = brokerFixture();
      const modern = f.client('workspace-a');
      const legacy = f.client('workspace-b');
      const first = order === 'modern-first' ? modern : legacy;
      const second = first === modern ? legacy : modern;
      const offer = client => client === modern ? true : undefined;
      const initializeId = client => client === first ? 'first-init' : 'second-init';
      const init = (client, id, choice = offer(client)) => f.request(client, {
        jsonrpc: '2.0', id, method: 'initialize', params: initializeParams(choice),
      });

      const firstRequest = await init(first, 'first-init');
      assert.equal(firstRequest.method, 'initialize');
      assert.equal(firstRequest.params.capabilities.experimental[CAPABILITY], true,
        'the broker maintains its upstream offer independently of this client');
      assert.equal(first.threadPresenceReadV1, undefined, 'pending offers do not become enabled before initialize success');

      if (mode === 'waiter') {
        await init(second, 'second-init');
        assert.equal(f.upstream.length, 1, 'concurrent clients share one backend initialize');
      }
      await f.fromAppServer({ jsonrpc: '2.0', id: firstRequest.id, result: initializeResult(true) });
      if (mode === 'cached') await init(second, 'second-init');

      assert.equal(modern.initialized, true);
      assert.equal(legacy.initialized, true);
      assert.equal(modern.threadPresenceReadV1, true);
      assert.equal(legacy.threadPresenceReadV1, false);
      for (const [client, expected] of [[modern, true], [legacy, false]]) {
        const id = initializeId(client);
        const response = client.messages.find(message => message.id === id);
        assert.equal(response?.result?.capabilities?.experimental?.[CAPABILITY], expected,
          `${order} ${mode} response must be a backend/client offer intersection`);
        const duplicate = await init(client, `duplicate-${id}`);
        assert.equal(duplicate, f.upstream.at(-1), 'duplicate initialize must not reach the backend');
        assert.ok(client.messages.at(-1)?.error, 'duplicate initialize is rejected');
        assert.equal(client.threadPresenceReadV1, expected, 'duplicate initialize cannot upgrade or revoke the frozen choice');
      }

      const before = f.upstream.length;
      const legacyError = await f.request(legacy, {
        jsonrpc: '2.0', id: 'legacy-presence', method: METHOD, params: { threadId: 'thread-presence-1' },
      });
      assert.equal(f.upstream.length, before, 'a client that did not offer presence cannot call it');
      assert.equal(legacy.messages.at(-1)?.error?.code, -32602);
      assert.equal(legacy.messages.at(-1)?.error?.message, `${CAPABILITY} negotiation is required`);
      assert.equal(legacyError, f.upstream.at(-1));

      const declined = f.client('workspace-c');
      const beforeDeclinedInit = f.upstream.length;
      await init(declined, 'declined-init', false);
      assert.equal(f.upstream.length, beforeDeclinedInit, 'cached initialize does not create a backend connection');
      assert.equal(declined.threadPresenceReadV1, false);
      assert.equal(declined.messages.at(-1)?.result?.capabilities?.experimental?.[CAPABILITY], false,
        'an explicit false choice remains disabled even when the backend supports presence');
      const beforeDeclinedCall = f.upstream.length;
      await f.request(declined, {
        jsonrpc: '2.0', id: 'declined-presence', method: METHOD, params: { threadId: 'thread-presence-1' },
      });
      assert.equal(f.upstream.length, beforeDeclinedCall);
      assert.equal(declined.messages.at(-1)?.error?.message, `${CAPABILITY} negotiation is required`);

      const responseOwner = { authorizationOwner: 'workspace-a' };
      f.broker.threadOwners.set('thread-presence-1', responseOwner);
      const params = { threadId: 'thread-presence-1' };
      const presenceRequest = await f.request(modern, {
        jsonrpc: '2.0', id: `presence-${mode}-${order}`, method: METHOD, params,
      });
      assert.equal(presenceRequest.method, METHOD,
        'a negotiated read-only presence query may inspect the same workspace thread across Gateway owners');
      assert.deepEqual(presenceRequest.params, params);
      const untouched = structuredClone(unknownPresence);
      await f.fromAppServer({ jsonrpc: '2.0', id: presenceRequest.id, result: unknownPresence });
      assert.deepEqual(modern.messages.at(-1), { jsonrpc: '2.0', id: `presence-${mode}-${order}`, result: unknownPresence });
      assert.deepEqual(unknownPresence, untouched, 'Gateway forwards authoritative presence without interpretation');
      assert.equal(f.broker.threadOwners.get('thread-presence-1'), responseOwner,
        'the read does not establish or change thread ownership');
      f.broker.clearTransientState();
    }
  }
});

test('old backend support is a negotiation error and an uninitialized client cannot call presence', async () => {
  const f = brokerFixture();
  const uninitialized = f.client('workspace-a');
  const beforeInitialize = f.upstream.length;
  await f.request(uninitialized, {
    jsonrpc: '2.0', id: 'before-init', method: METHOD, params: { threadId: 'thread-presence-1' },
  });
  assert.equal(f.upstream.length, beforeInitialize);
  assert.deepEqual(uninitialized.messages.at(-1)?.error, {
    code: -32602, message: `${CAPABILITY} negotiation is required`,
  });

  const client = f.client('workspace-a');
  const init = await f.request(client, {
    jsonrpc: '2.0', id: 'old-backend-init', method: 'initialize', params: initializeParams(true),
  });
  assert.equal(init.params.capabilities.experimental[CAPABILITY], true);
  await f.fromAppServer({ jsonrpc: '2.0', id: init.id, result: initializeResult(false) });
  assert.equal(client.threadPresenceReadV1, true, 'the client choice remains frozen even when the backend is old');
  assert.equal(client.messages.at(-1)?.result?.capabilities?.experimental?.[CAPABILITY], undefined,
    'an old backend that omitted the capability remains wire-compatible');

  const beforePresence = f.upstream.length;
  await f.request(client, {
    jsonrpc: '2.0', id: 'old-backend-presence', method: METHOD, params: { threadId: 'thread-presence-1' },
  });
  assert.equal(f.upstream.length, beforePresence, 'unsupported presence is blocked before reaching an old backend');
  assert.deepEqual(client.messages.at(-1)?.error, {
    code: -32602, message: `${CAPABILITY} negotiation is required`,
  });
  f.broker.clearTransientState();
});
