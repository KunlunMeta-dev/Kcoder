import assert from 'node:assert/strict';
import test from 'node:test';
import { observeCrossHostNativeErrors } from './windows-cross-host-rpc-observation.mjs';

test('broker error observation preserves original dispatch/callback/receipt and retains only reviewed constant fields', () => {
  const calls = [], records = []; let response;
  class Broker { sendInternalRequest(...args) { calls.push(args); args[2].onResponse?.(response); return 'original-request-id'; } }
  const original = Broker.prototype.sendInternalRequest, restore = observeCrossHostNativeErrors(Broker, record => records.push(record));
  const broker = new Broker(), params = { requestId: '11111111-1111-4111-8111-111111111111', payload: 'never-retained' }, replies = [], callback = value => replies.push(value);
  const fields = { onResponse: callback, marker: {} };
  response = { error: { code: -32047, message: 'source_transfer_busy', data: params } };
  assert.equal(broker.sendInternalRequest('migration/sourceTransfer/internal/source/manifest', params, fields), 'original-request-id');
  assert.equal(calls[0][1], params); assert.equal(calls[0][2].marker, fields.marker); assert.equal(replies[0], response); assert.equal(fields.onResponse, callback);
  assert.deepEqual(records, [{ method: 'migration/sourceTransfer/internal/source/manifest', requestId: params.requestId, code: -32047, constant_error_message: 'source_transfer_busy' }]);
  response = { error: { code: -32047, message: 'SECRET_MUST_NOT_ESCAPE /private/path', data: params } };
  broker.sendInternalRequest('migration/sourceTransfer/internal/target/begin', params, fields);
  assert.equal(records[1].constant_error_message, 'unclassified_native_error'); assert.ok(!JSON.stringify(records).includes('SECRET_MUST_NOT_ESCAPE'));
  response = { result: params }; broker.sendInternalRequest('migration/sourceTransfer/internal/source/state', params, fields); assert.equal(records.length, 2);
  response = { error: { message: 'source_transfer_busy' } }; broker.sendInternalRequest('thread/read', params, fields);
  assert.equal(calls.at(-1)[2], fields); assert.equal(records.length, 2);
  restore(); assert.equal(Broker.prototype.sendInternalRequest, original);
});

test('failed evidence emission cannot swallow a Native response or authorize a replacement request', () => {
  let calls = 0, callback = 0;
  class Broker { sendInternalRequest(_method, _params, fields) { calls++; fields.onResponse({ error: { code: -32047, message: 'source_transfer_busy' } }); return 'same-id'; } }
  const restore = observeCrossHostNativeErrors(Broker, () => { throw Error('evidence sink unavailable'); });
  assert.equal(new Broker().sendInternalRequest('migration/sourceTransfer/internal/target/begin', {}, { onResponse: () => callback++ }), 'same-id');
  assert.equal(calls, 1); assert.equal(callback, 1); restore();
});
