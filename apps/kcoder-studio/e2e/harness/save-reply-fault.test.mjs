import assert from 'node:assert/strict';
import test from 'node:test';
import { isCommittedProviderSaveFrame } from './save-reply-fault.mjs';
function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(body.length < 126 ? 2 : 4);
  header[0] = 0x81;
  header[1] = body.length < 126 ? body.length : 126;
  if (body.length >= 126) header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}
test('only a complete successful save receipt qualifies for transport loss', () => {
  for (const savedRevision of ['short', 'x'.repeat(200)]) {
    const data = frame({ id: 3, result: { savedRevision, profiles: [] } });
    assert.equal(isCommittedProviderSaveFrame(data), true);
    assert.equal(isCommittedProviderSaveFrame(data.subarray(0, -1)), false);
    assert.equal(isCommittedProviderSaveFrame(Buffer.concat([data, data])), false);
  }
  for (const value of [
    { id: 1, result: { revision: 'list', profiles: [] } },
    { id: 1, error: { message: 'refused' } },
    { result: { savedRevision: 'notification', profiles: [] } },
  ]) assert.equal(isCommittedProviderSaveFrame(frame(value)), false);
  assert.equal(isCommittedProviderSaveFrame(Buffer.from('HTTP/1.1 101 Switching Protocols')), false);
});
