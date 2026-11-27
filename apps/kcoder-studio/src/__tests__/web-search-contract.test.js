import test from 'node:test';
import assert from 'node:assert/strict';
import { WEB_SEARCH_METHODS, webSearchCapability, validWebSearchParams, validWebSearchResult, webSearchProbeRejection } from '../../shared/webSearchMethods.mjs';
import { gatewayRequestOutcome } from '../../shared/gatewayRequestDeadline.js';
import { inspectGatewayChannelMessage } from '../gateway-channel.js';

test('status/read and probe/read are read-only; start/cancel preserve unknown delivery semantics', () => {
  for (const method of [WEB_SEARCH_METHODS.status, WEB_SEARCH_METHODS.read]) assert.equal(gatewayRequestOutcome(method), 'readOnly');
  for (const method of [WEB_SEARCH_METHODS.start, WEB_SEARCH_METHODS.cancel]) assert.equal(gatewayRequestOutcome(method), 'unknown');
});
test('search contracts reject private query injection and unknown control methods', () => {
  const request = { requestId: 'probe-1', expectedRevision: 'r1', mode: 'kcoder' };
  assert.equal(validWebSearchParams(WEB_SEARCH_METHODS.start, request), true);
  for (const field of ['query', 'endpoint', 'owner', 'apiKey']) assert.equal(validWebSearchParams(WEB_SEARCH_METHODS.start, { ...request, [field]: 'private' }), false);
  assert.equal(webSearchCapability('webSearch/settings/save'), undefined);
  assert.equal(validWebSearchResult(WEB_SEARCH_METHODS.read, { targetId: 'target', revision: 'r1', requestId: 'probe-1', state: 'unknown' }), true);
});
test('Gateway retains runtime target boundary for diagnostics and denies browser channel', () => {
  for (const method of Object.values(WEB_SEARCH_METHODS)) {
    const frame = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} });
    assert.equal(inspectGatewayChannelMessage('runtime', frame).allowed, true);
    assert.equal(inspectGatewayChannelMessage('browser', frame).allowed, false);
  }
});

test('only known pre-dispatch rejection codes settle a probe; transport loss remains unknown', () => {
  assert.equal(webSearchProbeRejection(new Error('SEARCH_DIAGNOSTIC_UNSUPPORTED')), 'unsupported');
  assert.equal(webSearchProbeRejection(new Error('SEARCH_PROBE_POLICY_DENIED')), 'policy_denied');
  assert.equal(webSearchProbeRejection(new Error('SEARCH_PROBE_RECEIPT_LIMIT')), 'rejected');
  assert.equal(webSearchProbeRejection(new Error('SEARCH_TARGET_CHANGED')), null);
  assert.equal(webSearchProbeRejection(new Error('connection lost after dispatch')), null);
});
