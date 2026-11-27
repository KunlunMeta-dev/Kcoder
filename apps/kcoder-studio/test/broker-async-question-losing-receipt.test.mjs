import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

const winner = {
  threadId: 'thread', questionId: 'question', requestId: 'request', sourceTurnId: 'source',
  toolCallId: 'tool', revision: 2, createdAtMs: 1, status: 'queued',
  questions: [{ id: 'item', header: 'Mode', question: 'Which mode?', options: [], multiSelect: false }],
  answer: { submissionId: 'winner', acceptedAtMs: 2, answers: { item: { text: 'Peer answer' } } },
};

function fixture(t) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  let sequence = 0;
  const send = (client, method, params) => {
    const before = upstream.length;
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params }));
    const request = upstream.slice(before).find(message => message.method === method);
    assert.ok(request, `${method} reaches the original app-server`);
    return request;
  };
  const reply = (request, result) => child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true, asyncUserQuestionsV1: true });
    reply(send(client, 'thread/resume', { threadId: 'thread' }), { thread: { id: 'thread' } });
    return client;
  };
  return { broker, upstream, send, reply, join };
}

const invalid = [
  ['missing prompt', { ...winner, questions: undefined }],
  ['missing winner', { ...winner, answer: undefined }],
  ['null winner', { ...winner, answer: null }],
  ['missing answer map', { ...winner, answer: { ...winner.answer, answers: undefined } }],
  ['missing acceptance time', { ...winner, answer: { ...winner.answer, acceptedAtMs: undefined } }],
  ['foreign answer item', { ...winner, answer: { ...winner.answer, answers: { foreign: { text: 'Wrong item' } } } }],
  ['pending with an answer', { ...winner, status: 'pending' }],
];

for (const [name, question] of invalid) {
  test(`a losing device cannot receive ${name} as a successful answer receipt`, t => {
    const f = fixture(t), owner = f.join(), loser = f.join();
    const answer = f.send(loser, 'asyncQuestion/answer', { threadId: 'thread', questionId: 'question',
      expectedRevision: 1, submissionId: 'loser', answers: { item: { text: 'My retained draft' } } });
    f.reply(answer, { threadId: 'thread', accepted: false, duplicate: false, question });
    assert.equal(loser.messages.at(-1).error?.code, -32001,
      'a rejected submission is not authority for an absent or unusable saved winner');
    assert.equal(f.broker.threadOwners.get('thread'), owner);
    assert.equal(f.broker.activeTurns.size, 0);
    assert.equal(f.broker.threadDrains.size, 0);
    f.reply(f.send(loser, 'asyncQuestion/list', { threadId: 'thread', includeTerminal: true }), {
      threadId: 'thread', questions: [winner],
    });
    assert.deepEqual(loser.messages.at(-1).result.questions, [winner]);
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
    assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
  });
}

test('a losing device receives a complete valid peer winner unchanged', t => {
  const f = fixture(t), owner = f.join(), loser = f.join();
  const answer = f.send(loser, 'asyncQuestion/answer', { threadId: 'thread', questionId: 'question',
    expectedRevision: 1, submissionId: 'loser', answers: { item: { text: 'My draft' } } });
  const receipt = { threadId: 'thread', accepted: false, duplicate: false, question: winner };
  f.reply(answer, receipt);
  assert.deepEqual(loser.messages.at(-1).result, receipt);
  assert.equal(f.broker.threadOwners.get('thread'), owner);
  assert.equal(f.broker.activeTurns.size, 0);
});

for (const [name, contradictoryFields] of [
  ['claims a duplicate', { duplicate: true }],
  ['claims a started turn', { startedTurn: { threadId: 'thread', id: 'foreign-turn', status: 'running' } }],
]) {
  test(`a losing answer receipt that ${name} leaves the original outcome unknown`, t => {
    const f = fixture(t), owner = f.join(), loser = f.join();
    const answer = f.send(loser, 'asyncQuestion/answer', { threadId: 'thread', questionId: 'question',
      expectedRevision: 1, submissionId: 'loser', answers: { item: { text: 'Keep my draft' } } });
    f.reply(answer, { threadId: 'thread', accepted: false, duplicate: false, question: winner,
      ...contradictoryFields });
    assert.equal(loser.messages.at(-1).error?.code, -32001);
    assert.equal(f.broker.threadOwners.get('thread'), owner);
    assert.equal(f.broker.activeTurns.size, 0);
    assert.equal(f.broker.threadDrains.size, 0);
    f.reply(f.send(loser, 'asyncQuestion/list', { threadId: 'thread', includeTerminal: true }), {
      threadId: 'thread', questions: [winner],
    });
    assert.deepEqual(loser.messages.at(-1).result.questions, [winner]);
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
    assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
  });
}

test('a losing receipt cannot deny an exact retry of the saved answer', t => {
  const f = fixture(t), owner = f.join(), retrying = f.join();
  const params = { threadId: 'thread', questionId: 'question', expectedRevision: 1,
    submissionId: winner.answer.submissionId, answers: { item: { selectedOptionIds: [], text: 'Peer answer' } } };
  const receipt = { threadId: 'thread', accepted: false, duplicate: false, question: winner };
  f.reply(f.send(retrying, 'asyncQuestion/answer', params), receipt);
  assert.equal(retrying.messages.at(-1).error?.code, -32001);
  assert.equal(f.broker.threadOwners.get('thread'), owner);
  assert.equal(f.broker.activeTurns.size, 0);
  f.reply(f.send(retrying, 'asyncQuestion/list', { threadId: 'thread', includeTerminal: true }), {
    threadId: 'thread', questions: [winner],
  });
  assert.deepEqual(retrying.messages.at(-1).result.questions, [winner]);
  assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
});

test('a losing receipt can report different answers under the same submission ID', t => {
  const f = fixture(t), owner = f.join(), loser = f.join();
  const answer = f.send(loser, 'asyncQuestion/answer', { threadId: 'thread', questionId: 'question',
    expectedRevision: 1, submissionId: winner.answer.submissionId, answers: { item: { text: 'Different answer' } } });
  const receipt = { threadId: 'thread', accepted: false, duplicate: false, question: winner };
  f.reply(answer, receipt);
  assert.deepEqual(loser.messages.at(-1).result, receipt);
  assert.equal(f.broker.threadOwners.get('thread'), owner);
});
