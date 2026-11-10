import test from 'node:test';
import assert from 'node:assert/strict';
import { openOwnedMobileRpc } from './owned-mobile-rpc.mjs';

test('observer uses normal authorization and revokes only its newly owned session', async () => {
  const requests = [], secrets = [], cleanups = [];
  const context = { registerSecret(value) { secrets.push(value); }, addCleanup(name, close) { cleanups.push(close); } };
  const socket = { readyState: 3, constructor: { CLOSED: 3 } };
  const rpc = { socket, request: async method => { assert.equal(method, 'initialize'); return { capabilities: {} }; } };
  const fetchImpl = async (url, options) => { requests.push({ url, options }); return options.method === 'POST' ? { status: 200, json: async () => ({ accessToken: 'owned-access', rpcToken: 'owned-rpc' }) } : { status: 204 }; };
  const result = await openOwnedMobileRpc(context, { baseUrl: 'http://127.0.0.1:19761', wsUrl: 'ws://127.0.0.1:19761', authToken: 'fixture-login' }, 'target', '/owned', { fetchImpl, connect: async (url, options) => {
    assert.equal(new URL(url).searchParams.get('workspace'), '/owned');
    assert.equal(options.headers.authorization, 'Bearer owned-access'); return rpc;
  } });
  assert.deepEqual(secrets, ['owned-access', 'owned-rpc']);
  await result.close(); await cleanups[0]();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.headers.authorization, 'Bearer owned-access');
  assert.equal(requests[1].options.method, 'DELETE');
});

test('failed RPC admission still has a cleanup for its own authorization receipt', async () => {
  let cleanup, revoked = 0;
  const context = { registerSecret() {}, addCleanup(name, close) { cleanup = close; } };
  const fetchImpl = async (url, options) => options.method === 'POST' ? { status: 200, json: async () => ({ accessToken: 'owned', rpcToken: 'rpc' }) } : (++revoked, { status: 204 });
  await assert.rejects(openOwnedMobileRpc(context, { baseUrl: 'http://127.0.0.1:19761', wsUrl: 'ws://127.0.0.1:19761', authToken: 'fixture' }, 'target', undefined, { fetchImpl, connect: async () => { throw new Error('owned connection refusal'); } }));
  await cleanup(); assert.equal(revoked, 1);
});
