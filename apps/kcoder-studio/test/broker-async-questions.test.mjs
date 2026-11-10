import test from 'node:test';
import assert from 'node:assert/strict';
import { asyncQuestionAdmissionError, projectAsyncQuestionRequest, projectAsyncQuestionCapabilities,
  allowsAsyncQuestionNotification, projectAsyncQuestionResponse } from '../src/broker-async-questions.js';

const capability = { asyncUserQuestionsV1: true };
const client = { initialized: true, channel: 'runtime', ...capability };

test('async questions require both client and backend negotiation and explicit thread identity', () => {
  const request = { id: 1, method: 'asyncQuestion/answer', params: { threadId: 'thread' } };
  assert.equal(asyncQuestionAdmissionError(request, client, capability), null);
  for (const peer of [{ ...client, asyncUserQuestionsV1: false }, { ...client, initialized: false }, { ...client, channel: 'terminal' }])
    assert.match(asyncQuestionAdmissionError(request, peer, capability), /negotiation/);
  assert.match(asyncQuestionAdmissionError(request, client, {}), /negotiation/);
  assert.match(asyncQuestionAdmissionError({ ...request, id: undefined }, client, capability), /request ID/);
  for (const threadId of ['', ' ', 'unsafe\nthread', 'x'.repeat(513)])
    assert.match(asyncQuestionAdmissionError({ ...request, params: { threadId } }, client, capability), /threadId/);
});

test('shared backend capabilities cannot expose async tools to an older client', () => {
  const request = { id: 1, method: 'turn/start', params: { threadId: 'thread', asyncUserQuestions: true } };
  assert.equal(projectAsyncQuestionRequest(request, { ...client, asyncUserQuestionsV1: false }, capability).params.asyncUserQuestions, false);
  assert.equal(projectAsyncQuestionRequest(request, client, capability).params.asyncUserQuestions, true);
  assert.equal(projectAsyncQuestionRequest({ ...request, params: { ...request.params, asyncUserQuestions: false } }, client, capability).params.asyncUserQuestions, false);
  assert.equal(Object.hasOwn(projectAsyncQuestionRequest(request, client, {}).params, 'asyncUserQuestions'), false);
  assert.equal(projectAsyncQuestionCapabilities(capability, { ...client, asyncUserQuestionsV1: false }).asyncUserQuestionsV1, false);
});

test('question notifications never reach clients without an answer surface', () => {
  const message = { method: 'asyncQuestion/changed', params: { threadId: 'thread',
    question: { threadId: 'thread', questionId: 'q', revision: 1 } } };
  assert.equal(allowsAsyncQuestionNotification(message, client, capability), true);
  assert.equal(allowsAsyncQuestionNotification(message, { ...client, asyncUserQuestionsV1: false }, capability), false);
  assert.equal(allowsAsyncQuestionNotification({ method: 'turn/completed' }, {}, {}), true);
});


test('question list and cancellation receipts must match the original task and question', () => {
  const list = { method: 'asyncQuestion/list', params: { threadId: 'thread' } };
  const result = { threadId: 'thread', questions: [{ threadId: 'thread', questionId: 'q' }] };
  const response = { id: 1, result };
  assert.equal(projectAsyncQuestionResponse(response, list), response);
  for (const changed of [{ ...result, threadId: 'other' }, { ...result, questions: null },
    { ...result, questions: [{ threadId: 'other' }] }])
    assert.equal(projectAsyncQuestionResponse({ id: 1, result: changed }, list).error.code, -32001);
  const cancel = { method: 'asyncQuestion/cancel', params: { threadId: 'thread', questionId: 'q' } };
  const cancelled = { id: 1, result: { threadId: 'thread', question: result.questions[0] } };
  assert.equal(projectAsyncQuestionResponse(cancelled, cancel), cancelled);
  assert.equal(projectAsyncQuestionResponse(cancelled, { ...cancel, params: { ...cancel.params, questionId: 'other' } }).error.code, -32001);
});

test('a losing answer preserves the authoritative winner, while errors and unrelated RPCs pass through', () => {
  const pending = { method: 'asyncQuestion/answer', params: { threadId: 'thread', questionId: 'q', submissionId: 'loser' } };
  const response = { id: 1, result: { threadId: 'thread', accepted: false, duplicate: false,
    question: { threadId: 'thread', questionId: 'q', answer: { submissionId: 'winner' } } } };
  assert.equal(projectAsyncQuestionResponse(response, pending), response);
  const error = { id: 1, error: { code: -32064, message: 'answer was rejected' } };
  assert.equal(projectAsyncQuestionResponse(error, pending), error);
  assert.equal(projectAsyncQuestionResponse(response, { method: 'server/info' }), response);
});

test('answer turn binding is checked separately from the question and saved answer', () => {
  const answers = { item: { text: 'original' } };
  const pending = { method: 'asyncQuestion/answer', params: {
    threadId: 'thread', questionId: 'q', submissionId: 'submission', answers,
  } };
  const response = { id: 1, result: { threadId: 'thread', accepted: true, duplicate: false,
    question: { threadId: 'thread', questionId: 'q', answer: { submissionId: 'submission', answers } },
    startedTurn: { id: 'new-turn', threadId: 'thread', status: 'running' },
  } };
  assert.equal(projectAsyncQuestionResponse(response, pending), response);
  for (const threadId of ['other-thread', '', null]) {
    const foreign = { ...response, result: { ...response.result,
      startedTurn: { ...response.result.startedTurn, threadId } } };
    assert.equal(projectAsyncQuestionResponse(foreign, pending).error?.code, -32001);
  }
  const idle = { ...response, result: { ...response.result, startedTurn: null } };
  assert.equal(projectAsyncQuestionResponse(idle, pending), idle);
  const legacy = { ...response, result: { ...response.result,
    startedTurn: { id: 'new-turn', status: 'running' } } };
  assert.equal(projectAsyncQuestionResponse(legacy, pending), legacy);
});

for (const params of [
  { threadId: 'thread', question: { threadId: 'other-thread' } },
  { question: { threadId: 'thread' } },
  { threadId: '', question: { threadId: '' } },
  { threadId: 'thread' },
  { threadId: 'thread', question: null },
]) test(`async change requires the question and routing task to agree: ${JSON.stringify(params)}`, () => {
  assert.equal(allowsAsyncQuestionNotification({ method: 'asyncQuestion/changed', params }, client, capability), false);
});
