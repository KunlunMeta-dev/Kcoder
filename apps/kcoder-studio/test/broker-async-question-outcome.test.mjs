import assert from 'node:assert/strict';
import test from 'node:test';
import { isGatewayUnknownOutcome } from '../shared/gatewayRequestDeadline.js';
import { projectAsyncQuestionResponse } from '../src/broker-async-questions.js';

for (const method of ['asyncQuestion/list', 'asyncQuestion/answer', 'asyncQuestion/cancel']) {
  test(`${method} keeps an invalid refusal unconfirmed with or without broker projection`, () => {
    const pending = { method, params: { threadId: 'original' } };
    const refusal = JSON.parse('{"id":1,"error":{"code":-32064,"message":"Invalid question \\ud800"}}');
    const projected = projectAsyncQuestionResponse(refusal, pending);
    assert.equal(projected.error.code, -32001);
    assert.equal(isGatewayUnknownOutcome(projected.error, method), true);
    assert.equal(isGatewayUnknownOutcome(refusal.error, method), true);

    const validRefusal = { code: -32064, message: '问题已关闭 🔒' };
    assert.equal(projectAsyncQuestionResponse({ id: 1, error: validRefusal }, pending).error, validRefusal);
    assert.equal(isGatewayUnknownOutcome(validRefusal, method), false);
  });
}

const metadataCases = [
  ['nested value', { details: [{ reason: '\ud800' }] }],
  ['nested key', { details: { ['\udc00']: 'reason' } }],
];

for (const method of ['asyncQuestion/list', 'asyncQuestion/answer', 'asyncQuestion/cancel']) {
  for (const [name, data] of metadataCases) {
    test(`${method} keeps a refusal with an invalid ${name} unconfirmed on direct transports`, () => {
      const error = { code: -32064, message: 'Question is closed', data };
      const pending = { method, params: { threadId: 'original' } };
      const wire = JSON.parse(JSON.stringify({ id: 1, error }));
      assert.equal(projectAsyncQuestionResponse(wire, pending).error.code, -32001);
      assert.equal(isGatewayUnknownOutcome(wire.error, method), true);
      assert.equal(isGatewayUnknownOutcome({ ...error, data: { details: [{ '原因🔒': '问题已关闭' }] } }, method), false);
      assert.equal(isGatewayUnknownOutcome(wire.error, 'thread/read'), false);
    });
  }
}
