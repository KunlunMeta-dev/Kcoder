import test from 'node:test';
import assert from 'node:assert/strict';
import { ASYNC_ANSWER_FINGERPRINT, asyncAnswerFingerprint } from '../src/broker-async-question-answer.js';
import { compactRequestParams } from '../src/broker-request-budget.js';
import { projectAsyncQuestionResponse } from '../src/broker-async-questions.js';

const answers = { first: { selectedOptionIds: ['one', 'two'], text: ' original ' }, second: {} };
const params = { threadId: 'thread', questionId: 'question', submissionId: 'submission', answers };
const pending = { method: 'asyncQuestion/answer', params };
const receipt = (saved = answers, accepted = true) => ({ id: 1, result: {
  threadId: 'thread', accepted, duplicate: false,
  question: { threadId: 'thread', questionId: 'question', answer: { submissionId: 'submission', answers: saved } },
} });

test('binding normalizes Rust defaults and map order while preserving exact selections and text', () => {
  const equivalent = { second: { selectedOptionIds: [], text: null }, first: { text: ' original ', selectedOptionIds: ['one', 'two'] } };
  assert.equal(asyncAnswerFingerprint(answers), asyncAnswerFingerprint(equivalent));
  const response = receipt(equivalent);
  assert.equal(projectAsyncQuestionResponse(response, pending), response);
});

for (const [name, saved] of [
  ['changed option', { ...answers, first: { ...answers.first, selectedOptionIds: ['one', 'three'] } }],
  ['reordered options', { ...answers, first: { ...answers.first, selectedOptionIds: ['two', 'one'] } }],
  ['trimmed text', { ...answers, first: { ...answers.first, text: 'original' } }],
  ['missing item', { first: answers.first }],
  ['extra item', { ...answers, third: {} }],
  ['missing answers', undefined],
  ['null answers', null],
  ['array answers', []],
  ['null item', { ...answers, second: null }],
  ['unknown item field', { ...answers, second: { unknown: true } }],
  ['null options', { ...answers, second: { selectedOptionIds: null } }],
  ['non-string option', { ...answers, second: { selectedOptionIds: [3] } }],
  ['non-string text', { ...answers, second: { text: 3 } }],
]) test(`${name} cannot certify an accepted answer before or after compaction`, () => {
  // Assign explicitly so undefined exercises a missing answer rather than the default argument.
  const response = receipt(); response.result.question.answer.answers = saved;
  for (const value of [params, compactRequestParams(params)]) {
    assert.equal(projectAsyncQuestionResponse(response, { ...pending, params: value }).error?.code, -32001);
  }
});

test('compaction keeps a fixed-size fingerprint through expiry and detach without keeping answer content', () => {
  const compact = compactRequestParams(params);
  assert.deepEqual(Object.keys(compact).sort(), ['questionId', 'submissionId', 'threadId']);
  assert.equal(compact[ASYNC_ANSWER_FINGERPRINT].length, 64);
  assert.equal(JSON.stringify(compact).includes('original'), false);
  const twice = compactRequestParams(compact);
  assert.deepEqual(twice, compact);
  const response = receipt();
  assert.equal(projectAsyncQuestionResponse(response, { ...pending, params: twice }), response);
  assert.deepEqual(compactRequestParams({ threadId: 'other', answers }), { threadId: 'other' });
});

test('a JSON-supplied fingerprint cannot certify a request missing its original answers', () => {
  const forged = { ...params, answers: undefined, asyncAnswerFingerprint: asyncAnswerFingerprint(answers) };
  assert.equal(projectAsyncQuestionResponse(receipt(), { ...pending, params: forged }).error?.code, -32001);
});

test('a losing device still receives the authoritative winner instead of matching its own answer', () => {
  const response = receipt({ winner: { text: 'another device' } }, false);
  response.result.question.answer.submissionId = 'winner';
  assert.equal(projectAsyncQuestionResponse(response, pending), response);
});
