import assert from 'node:assert/strict';
import test from 'node:test';
import { createGatewayRpcQuery, isGatewayRpcQuery } from '../shared/gatewayRpcQuery.js';
import { encodePeerFrame, parsePeerFrame } from '../shared/gatewayPeerTransport.js';

test('all public RPC connection metadata round-trips through the P2P frame contract', () => {
  const values = {
    token: 'r'.repeat(48), server: 'target-a', channel: 'runtime',
    workspace: 'C:\\工作区\\a b?c&d#e', channelObserver: 'mobile-page-observer', runtimeObserver: 'none',
  };
  const params = createGatewayRpcQuery(values);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(params.toString())), values);
  const frame = { version: 1, type: 'ws.open', id: 'rpc-one', path: `/rpc?${params}`,
    authorization: `Bearer ${'a'.repeat(64)}`, protocols: [] };
  assert.deepEqual(parsePeerFrame(encodePeerFrame(frame)), frame);
  assert.equal(createGatewayRpcQuery({ token: 'rpc', workspace: undefined }).toString(), 'token=rpc');
});

test('unknown or repeated parameters cannot enter a tunneled RPC connection', () => {
  const params = createGatewayRpcQuery({ token: 'rpc', server: 'local', channel: 'runtime',
    workspace: '/work', channelObserver: 'page', runtimeObserver: 'none' });
  for (const key of params.keys()) {
    const repeated = new URLSearchParams(params);
    repeated.append(key, 'another-value');
    assert.equal(isGatewayRpcQuery(repeated), false, key);
  }
  for (const key of ['admin', 'nativeManagement', 'unknown']) {
    const unknown = new URLSearchParams(params);
    unknown.set(key, '1');
    assert.equal(isGatewayRpcQuery(unknown), false, key);
    assert.throws(() => createGatewayRpcQuery({ token: 'rpc', [key]: '1' }), TypeError);
  }
});

test('RPC query construction enforces the same token boundary as the receiver', () => {
  assert.equal(isGatewayRpcQuery(createGatewayRpcQuery({ token: 'r'.repeat(256) })), true);
  for (const values of [{}, { token: 'r'.repeat(257) }, { token: 123 }]) {
    assert.throws(() => createGatewayRpcQuery(values), TypeError);
  }
  assert.equal(isGatewayRpcQuery(new URLSearchParams()), false);
  assert.equal(isGatewayRpcQuery(new URLSearchParams({ token: 'r'.repeat(257) })), false);
});
