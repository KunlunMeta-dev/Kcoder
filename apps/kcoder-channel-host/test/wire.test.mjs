import test from 'node:test';
import assert from 'node:assert/strict';
import { PORTS, reply } from '../src/applications/wire.mjs';

test('invalid operation identities cannot be echoed as objects in an error receipt', () => {
  const response = reply({ requestId: 'valid-request', operationId: { privateValue: 'fixture' } }, 'rejected');
  assert.equal(response.requestId, 'valid-request'); assert.equal(response.operationId, null);
});
test('reply revisions accept explicit strings or integers and reject objects', () => {
  assert.equal(reply({ requestId: 'request' }, 'completed', {}, null, undefined).entityRevision, null);
  assert.equal(reply({ requestId: 'request' }, 'completed', {}, null, 2).entityRevision, '2');
  assert.equal(reply({ requestId: 'request' }, 'completed', {}, null, 'v2').entityRevision, 'v2');
  assert.throws(() => reply({ requestId: 'request' }, 'completed', {}, null, {}), { code: 'INVALID_REVISION' });
});
test('the declared method arrays are immutable', () => {
  assert.throws(() => PORTS['P-CONNECTION'].push('fixture-extra-method'), TypeError);
});
