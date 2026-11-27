import assert from 'node:assert/strict';
import test from 'node:test';
import { committedSteerFrame, isCommittedSteerReceipt, isAgentSteerReply } from './steer-reply-fault.mjs';
const frame = value => { const body = Buffer.from(JSON.stringify(value)); const head = Buffer.alloc(body.length < 126 ? 2 : 4); head[0] = 0x81; head[1] = body.length < 126 ? body.length : 126; if (body.length >= 126) head.writeUInt16BE(body.length, 2); return Buffer.concat([head, body]); };
test('steer acknowledgement loss only matches one complete successful durable queued receipt', () => {
  const receipt = { agentId: 'actual', messageId: 'server-message', clientMessageId: 'cmd:0:exact-client', status: 'queued_live', queued: true };
  const bytes = frame({ id: 4, result: receipt });
  assert.equal(isCommittedSteerReceipt(committedSteerFrame(bytes)), true);
  assert.equal(committedSteerFrame(bytes.subarray(0, -1)), null);
  assert.equal(committedSteerFrame(Buffer.concat([bytes, bytes])), null);
  assert.equal(committedSteerFrame(frame({ method: 'agent/event', params: receipt })), null);
  assert.equal(committedSteerFrame(frame({ id: 4, error: { message: 'refused' } })), null);
  for (const overrides of [{ queued: false }, { status: 'rejected' }, { messageId: undefined }, { agentId: undefined }, { clientMessageId: 'unknown' }, { clientMessageId: 'cmd:1:other-epoch' }]) assert.equal(isCommittedSteerReceipt({ ...receipt, ...overrides }), false);
  assert.equal(isCommittedSteerReceipt({ receipt, receiptEpoch: 0 }), false);
});

test('repeat applied and rejected steer replies remain visible to no-resend accounting', () => {
  assert.equal(isAgentSteerReply({ agentId: 'actual', clientMessageId: 'cmd:0:same', queued: false, status: 'applied', messageId: 'same-message' }), true);
  assert.equal(isAgentSteerReply({ agentId: 'actual', clientMessageId: 'cmd:0:same', queued: false, status: 'rejected' }), true);
  assert.equal(isAgentSteerReply({ receipt: { clientMessageId: 'cmd:0:same' }, receiptEpoch: 0 }), false);
});
