import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { BrokerOfficeTaskOwnerHandoff } from '../src/broker-office-task-owner.js';

function fixture(t, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  t.after(() => broker.clearTransientState());
  const caps = { integrationScopeV1: true, officeWorkspaceV1: true, asyncUserQuestionsV1: true };
  broker.initializeResponse = { result: { sessionId: 'current', capabilities: { experimental: caps } } };
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const join = () => {
    const client = { channel: 'runtime', ...caps, messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    return client;
  };
  const owner = join(), peer = join();
  const params = { contractVersion: 'parallel-v1', requestId: 'adoption', operationId: 'operation', timeoutMs: 30000,
    scope: { accountId: 'owned', targetId: 'local', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' },
    payload: { id: 'builtin.office-task', version: '2', startTask: true, inputs: {} } };
  broker.receive(owner, JSON.stringify({ id: 1, method: 'integrations/assistant/adopt', params }));
  const adoption = upstream.at(-1);
  assert.equal(adoption.method, 'integrations/assistant/adopt');
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const question = { id: 500, method: 'question/request', params: {
    threadId: 'thread', turnId: 'turn', questionId: 'live-question',
    questions: [{ id: 'item', prompt: 'Continue the original task?', options: [], allowsFreeform: true }],
  } };
  const changed = { method: 'asyncQuestion/changed', params: { threadId: 'thread',
    question: { threadId: 'thread', questionId: 'async-question', revision: 1 } } };
  const accept = () => emit({ id: adoption.id, result: { contractVersion: 'parallel-v1',
    requestId: params.requestId, operationId: params.operationId, status: 'completed', error: null,
    entityRevision: null, observedAt: '2026-11-17T04:00:00Z',
    result: { nativeTask: { threadId: 'thread', turnId: 'turn', state: 'running' } } } });
  return { broker, owner, peer, upstream, emit, question, changed, accept };
}

const resolution = (kind, sequence) => ({ method: `${kind}/resolved`, params: {
  serverId: 'server-current', threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch',
  requestId: 400, [`${kind}Id`]: 'ended-interaction', reason: 'client_response', sequence,
  ...(kind === 'approval' ? { decision: 'accept' } : {}),
} });

function assertQuestionSurvives(f, held) {
  f.emit(f.changed);
  f.emit(f.question);
  assert.equal(f.upstream.length, 1, 'early receipts cannot force refusal of the real waiter');
  f.accept();
  assert.deepEqual(f.owner.messages.slice(1), [...held, f.changed, f.question]);
  assert.equal(f.peer.messages.length, 0, 'the original task keeps its input owner');
  assert.equal(f.broker.serverRequests.get(500), f.owner);
  f.broker.receive(f.owner, JSON.stringify({ id: 500,
    result: { answers: { item: { answers: ['Continue'] } } } }));
  assert.equal(f.upstream.filter(message => message.id === 500 && message.result).length, 1);
  assert.equal(f.upstream.filter(message => message.method === 'integrations/assistant/adopt').length, 1);
  assert.equal(f.upstream.some(message => ['asyncQuestion/answer', 'turn/interrupt'].includes(message.method)), false);
}

for (const shared of [false, true]) {
  for (const kind of ['question', 'approval']) {
    for (const [name, invalidate] of [
      ['version', frame => { frame.jsonrpc = '1.0'; }],
      ['server', frame => { frame.params.serverId = 'server-previous'; }],
      ['sequence', frame => { frame.params.sequence = -1; }],
      ['epoch', frame => { frame.params.appServerEpoch = ' '; }],
      ['kind', frame => { frame.params[kind === 'question' ? 'approvalId' : 'questionId'] = 'foreign'; }],
      ['reason', frame => { frame.params.reason = '\ud800'; }],
    ]) {
      test(`invalid early ${kind} resolution ${name} leaves question capacity (shared=${shared})`, t => {
        const f = fixture(t, shared);
        for (let index = 0; index < 65; index++) {
          const frame = resolution(kind, index);
          frame.params.requestId += index;
          invalidate(frame);
          f.emit(frame);
        }
        assertQuestionSurvives(f, []);
      });
    }

    test(`resequenced early ${kind} resolutions leave question capacity (shared=${shared})`, t => {
      const f = fixture(t, shared), first = resolution(kind, 0);
      for (let sequence = 0; sequence < 65; sequence++) f.emit(resolution(kind, sequence));
      assertQuestionSurvives(f, [first]);
    });
  }
}

for (const kind of ['question', 'approval']) {
  test(`${kind} terminal replay cannot add an adoption candidate`, t => {
    const f = fixture(t, false), handoff = new BrokerOfficeTaskOwnerHandoff();
    const original = [...f.broker.pending.values()].find(pending => pending.method === 'integrations/assistant/adopt');
    const later = { ...original }, first = resolution(kind, 0), replay = resolution(kind, 1);
    assert.equal(handoff.capture(first, [original]), true);
    assert.equal(handoff.capture(replay, [original, later]), true);
    const delivered = [], refused = [];
    handoff.settle(original, null, frame => delivered.push(frame), frame => refused.push(frame));
    handoff.settle(later, { threadId: 'thread', turnId: 'turn' }, frame => delivered.push(frame), frame => refused.push(frame));
    assert.deepEqual(refused, [first], 'only the original candidate owned the first receipt');
    assert.deepEqual(delivered, []);
    assert.equal(first.params.sequence, 0);
    assert.equal(replay.params.sequence, 1);
  });

  test(`${kind} terminal replay preserves real binding differences and capacity`, t => {
    const f = fixture(t, false), handoff = new BrokerOfficeTaskOwnerHandoff();
    const candidates = [...f.broker.pending.values()], first = resolution(kind, 0);
    const frames = [first, ...['serverId', 'threadId', 'turnId', 'appServerEpoch', 'requestId', `${kind}Id`, 'reason',
      ...(kind === 'approval' ? ['decision'] : [])].map((field, index) => {
      const frame = resolution(kind, index + 1);
      frame.params[field] = field === 'requestId' ? 401 : field === 'decision' ? 'decline' : `other-${field}`;
      return frame;
    }), { ...resolution(kind, 20), jsonrpc: '2.0' }];
    for (const frame of frames) assert.equal(handoff.capture(frame, candidates), true);
    for (let index = frames.length; index < 64; index++) {
      const frame = resolution(kind, index + 30);
      frame.params.requestId = 1000 + index;
      assert.equal(handoff.capture(frame, candidates), true);
      frames.push(frame);
    }
    assert.equal(handoff.capture(resolution(kind, 100), candidates), true, 'replay fits a full queue');
    const overflow = resolution(kind, 101);
    overflow.params.requestId = 2000;
    assert.equal(handoff.capture(overflow, candidates), false, 'distinct outcomes still respect the cap');
    const refused = [];
    handoff.settle(candidates[0], null, () => assert.fail('unconfirmed adoption cannot deliver'), frame => refused.push(frame));
    assert.deepEqual(refused, frames, 'different bindings and outcomes keep their first wire order');
    assert.equal(handoff.capture(overflow, candidates), true, 'settling releases the owned capacity');
  });
}
