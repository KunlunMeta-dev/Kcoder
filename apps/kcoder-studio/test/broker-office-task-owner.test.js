import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

const scope = { accountId: 'owned', targetId: 'local', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' };
function fixture(t, shared = false) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const written = []; child.stdin.on('data', chunk => written.push(JSON.parse(chunk.toString())));
  const broker = new WorkspaceAppServerBroker({ child, adapter: { rawPassthrough: true, fromUpstream: m => ({ upstream: [], client: [m] }) }, maxMessageBytes: 1024 * 1024, serverId: 'owned', residentThreads: true });
  t.after(() => child.emit('close', 0));
  const caps = { integrationScopeV1: true, officeWorkspaceV1: true };
  broker.initializeResponse = { result: { capabilities: { experimental: caps } } };
  const owner = () => {
    const c = { channel: 'runtime', ...caps, messages: [], send(m) { this.messages.push(m); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(c); c.initialized = true; c.gatewaySharedThreadsV1 = shared; return c;
  };
  const adopt = (c, id) => {
    const params = { contractVersion: 'parallel-v1', scope, requestId: `request-${id}`, operationId: `office-${id}`, timeoutMs: 30000, payload: { id: 'builtin.office-task', version: '2', startTask: true, inputs: { request: 'Owned fixture document' } } };
    broker.receive(c, JSON.stringify({ jsonrpc: '2.0', id, method: 'integrations/assistant/adopt', params }));
    return { ...written.at(-1), params };
  };
  const reply = (request, thread = 'actual-thread', changes = {}) => broker.routeServerMessage({ jsonrpc: '2.0', id: request.id, result: {
    contractVersion: 'parallel-v1', requestId: request.params.requestId, operationId: request.params.operationId,
    status: 'completed', error: null, entityRevision: null, observedAt: '2026-10-29T00:00:00Z',
    result: { nativeTask: { threadId: thread, turnId: 'turn-1', state: 'running' } }, ...changes,
  } });
  return { broker, written, owner, adopt, reply };
}
const approval = (id = 2000001, threadId = 'actual-thread') => ({ jsonrpc: '2.0', id, method: 'approval/request', params: { threadId, turnId: 'turn-1', action: { type: 'tool', name: 'tool_search', input: { query: 'OfficeDocument' } } } });

for (const kind of ['question', 'approval']) {
  for (const shared of [false, true]) {
    for (const outcome of ['accepted', 'rejected', 'expired', 'disconnected']) {
      test(`${kind}: early string IDs retain their original adoption binding (${outcome}, shared=${shared})`, t => {
        const f = fixture(t, shared), original = f.owner(), peer = f.owner();
        const adoption = f.adopt(original, 1), field = kind === 'question' ? 'questionId' : 'approvalId';
        // Numeric-looking strings remain exact transport IDs, including spaces.
        const request = { id: ' 500 ', method: `${kind}/request`, params: {
          threadId: 'actual-thread', turnId: 'turn-1', [field]: 'original-card', appServerEpoch: 'epoch',
        } };
        f.broker.routeServerMessage(request);
        assert.equal(f.written.length, 1, 'a valid early waiter cannot be rejected before its adoption receipt');
        assert.equal(original.messages.length + peer.messages.length, 0, 'no client owns the early card yet');
        f.broker.routeServerMessage(structuredClone(request));
        f.broker.routeServerMessage({ ...request, params: { ...request.params, threadId: 'peer-thread' } });
        assert.equal(f.written.length, 1, 'duplicates and conflicting bindings cannot answer the held waiter');

        if (outcome === 'expired') f.broker.expireRequest(adoption.id);
        if (outcome === 'disconnected') f.broker.detach(original);
        f.reply(adoption, 'actual-thread', outcome === 'rejected' ? { operationId: 'wrong-operation' } : {});
        assert.equal(peer.messages.length, 0, 'adoption cannot transfer the card to another client');
        if (outcome === 'accepted') {
          assert.deepEqual(original.messages.at(-1), request);
          assert.equal(f.broker.serverRequests.get(request.id), original);
          const peerReply = { id: request.id,
            result: kind === 'question' ? { answers: {} } : { decision: 'decline' } };
          if (shared) {
            for (const client of [original, peer]) {
              f.broker.receive(client, JSON.stringify({ id: 20, method: 'thread/resume', params: { threadId: 'actual-thread' } }));
              f.broker.routeServerMessage({ id: f.written.at(-1).id, result: { thread: { id: 'actual-thread' } } });
              assert.equal(f.broker.sharedThreads.has('actual-thread', client), true);
            }
            assert.deepEqual(peer.messages.at(-1), request, 'a joined viewer can observe the original held card');
            f.broker.receive(peer, JSON.stringify(peerReply));
            assert.equal(peer.messages.at(-1).params.reason, 'not_original_client');
          } else assert.throws(() => f.broker.receive(peer, JSON.stringify(peerReply)), /another client/);
          f.broker.receive(original, JSON.stringify({ id: request.id,
            result: kind === 'question' ? { answers: {} } : { decision: 'decline' } }));
          assert.equal(f.written.filter(message => message.id === request.id && message.result).length, 1);
        } else {
          assert.equal(f.written.filter(message => message.id === request.id && message.error?.code === -32040).length, 1);
          assert.equal(f.broker.serverRequests.has(request.id), false);
          assert.equal(original.messages.some(message => message.method === request.method), false);
          f.broker.receive(peer, JSON.stringify({ id: 10, method: 'thread/resume', params: { threadId: 'actual-thread' } }));
          f.broker.routeServerMessage({ id: f.written.at(-1).id, result: { thread: { id: 'actual-thread' } } });
          const delivered = peer.messages.length, written = f.written.length;
          f.broker.routeServerMessage(request);
          assert.equal(peer.messages.length, delivered, 'a refused string ID cannot reopen after recovery');
          assert.equal(f.written.length, written, 'recovery cannot refuse the same waiter twice');
        }
        const receipt = { method: `${kind}/resolved`, params: { ...request.params,
          requestId: request.id, reason: 'client_response', ...(kind === 'approval' ? { decision: 'decline' } : {}) } };
        f.broker.routeServerMessage(receipt);
        assert.deepEqual((outcome === 'accepted' ? original : peer).messages.at(-1), receipt,
          'the original terminal receipt keeps the exact string identity');
        if (shared && outcome === 'accepted') assert.deepEqual(peer.messages.at(-1), receipt);
      });
    }
  }
}

test('real Office acceptance binds only its original connected UI and preserves the normal reply owner', t => {
  const f = fixture(t), a = f.owner(), peer = f.owner(), request = f.adopt(a, 1);
  f.reply(request);
  f.broker.routeServerMessage(approval());
  assert.equal(f.broker.threadOwners.get('actual-thread'), a);
  assert.equal(a.messages.at(-1).method, 'approval/request');
  assert.equal(peer.messages.length, 0);
  assert.throws(() => f.broker.receive(peer, JSON.stringify({ id: 2000001, result: { decision: 'accept' } })), /another client/);
  f.broker.receive(a, JSON.stringify({ id: 2000001, result: { decision: 'decline' } }));
  assert.equal(f.written.at(-1).result.decision, 'decline');
});

test('early lifecycle and approval wait for the exact acceptance, then preserve wire order after its response', t => {
  const f = fixture(t), a = f.owner(), peer = f.owner();
  const request = f.adopt(a, 1), other = f.adopt(peer, 2);
  f.broker.routeServerMessage({ method: 'turn/started', params: { threadId: 'actual-thread', turnId: 'turn-1', attemptId: 'original-attempt' } });
  f.broker.routeServerMessage(approval());
  assert.equal(a.messages.length + peer.messages.length, 0);
  f.reply(other, 'peer-thread');
  assert.equal(peer.messages.length, 1);
  f.reply(request);
  assert.deepEqual(a.messages.map(m => m.method ?? 'reply'), ['reply', 'turn/started', 'approval/request']);
  assert.equal(f.written.length, 2, 'holding an interaction cannot answer or rerun its operation');
});

test('wrong original operation and unknown receipts cannot bind or approve a task', t => {
  const f = fixture(t), a = f.owner();
  let request = f.adopt(a, 1); f.broker.routeServerMessage(approval());
  f.reply(request, 'actual-thread', { operationId: 'other-op' });
  assert.equal(f.broker.threadOwners.size, 0);
  assert.equal(f.written.at(-1).error.code, -32040);
  request = f.adopt(a, 2); f.broker.routeServerMessage(approval(2000002));
  f.reply(request, 'actual-thread', { status: 'unknown', result: null, error: { code: 'OFFICE_OUTCOME_UNKNOWN', message: 'Unknown', retryable: false, recovery: 'reconcile_original', details: {} } });
  assert.equal(f.broker.threadOwners.size, 0);
  assert.ok(!a.messages.some(m => m.method === 'approval/request'));
});

test('disconnect and expiry drop held approvals; a late acceptance never selects a peer', t => {
  const f = fixture(t), a = f.owner(), peer = f.owner();
  const request = f.adopt(a, 1); f.broker.routeServerMessage(approval());
  f.broker.detach(a); f.reply(request);
  assert.equal(f.broker.threadOwners.size, 0);
  assert.equal(peer.messages.length, 0);
  assert.ok(f.written.some(m => m.id === 2000001 && m.error?.code === -32040));
  const next = f.adopt(peer, 2); f.broker.routeServerMessage(approval(2000002));
  f.broker.expireRequest(next.id); f.reply(next);
  assert.equal(f.broker.threadOwners.size, 0);
  assert.ok(!peer.messages.some(m => m.method === 'approval/request'));
});

test('a native Office reply cannot take an already owned peer thread', t => {
  const f = fixture(t), a = f.owner(), peer = f.owner();
  f.broker.threadOwners.set('actual-thread', peer);
  f.reply(f.adopt(a, 1));
  assert.equal(f.broker.threadOwners.get('actual-thread'), peer);
  assert.equal(a.messages.at(-1).error.code, -32023);
});

for (const kind of ['question', 'approval']) {
  const prompt = (id = 2000001) => ({ id, method: `${kind}/request`, params: {
    threadId: 'actual-thread', turnId: 'turn-1', appServerEpoch: 'original-epoch',
    [kind === 'question' ? 'questionId' : 'approvalId']: 'original-interaction',
  } });

  test(`${kind}: duplicate early frames cannot reject the held waiter or deliver a second card`, t => {
    const f = fixture(t), original = f.owner(), peer = f.owner();
    const adoption = f.adopt(original, 1), request = prompt();
    f.broker.routeServerMessage(request);
    for (let index = 0; index < 3; index++) f.broker.routeServerMessage(structuredClone(request));
    assert.equal(f.written.length, 1, 'the original waiter must remain unanswered while adoption is pending');
    f.reply(adoption);
    assert.deepEqual(original.messages.filter(message => message.method === request.method), [request]);
    assert.equal(peer.messages.length, 0);
    assert.equal(f.broker.serverRequests.get(request.id), original);
    const beforeReply = f.written.length;
    f.broker.receive(original, JSON.stringify({ id: request.id,
      result: kind === 'question' ? { answers: { item: { answers: ['yes'] } } } : { decision: 'decline' } }));
    assert.equal(f.written.length, beforeReply + 1, 'the original client can still submit exactly one explicit reply');
    assert.equal(f.written.at(-1).id, request.id);
    assert.equal(f.written.at(-1).error, undefined);
  });

  test(`${kind}: replays at the full early buffer keep the original slot and capacity rejection`, t => {
    const f = fixture(t), original = f.owner(), adoption = f.adopt(original, 1);
    const requests = Array.from({ length: 64 }, (_, index) => prompt(2000001 + index));
    for (const request of requests) f.broker.routeServerMessage(request);
    for (let index = 0; index < 65; index++) f.broker.routeServerMessage(structuredClone(requests[0]));
    assert.equal(f.written.length, 1, 'replays consume neither a new slot nor a new refusal');
    const overflow = prompt(2000065);
    f.broker.routeServerMessage(overflow);
    assert.equal(f.written.length, 2);
    assert.equal(f.written.at(-1).id, overflow.id);
    assert.equal(f.written.at(-1).error.code, -32040, 'new overflow requests still fail closed');
    f.reply(adoption);
    assert.deepEqual(original.messages.filter(message => message.method === requests[0].method), requests);
    assert.equal(f.broker.serverRequests.size, 64);
  });

  test(`${kind}: a conflicting early frame keeps the first identity and its original adoption candidates`, t => {
    const f = fixture(t), original = f.owner(), peer = f.owner();
    const adoption = f.adopt(original, 1), request = prompt();
    f.broker.routeServerMessage(request);
    const other = f.adopt(peer, 2);
    f.broker.routeServerMessage({ ...request,
      method: kind === 'question' ? 'approval/request' : 'question/request',
      params: { threadId: 'other-thread', turnId: 'other-turn', appServerEpoch: 'other-epoch',
        questionId: 'other-question', approvalId: 'other-approval' } });
    assert.equal(f.written.length, 2, 'a reused transport ID must not settle the original waiter');
    f.reply(adoption, 'actual-thread', { operationId: 'wrong-operation' });
    assert.equal(f.written.length, 3, 'only the original candidates decide whether the held request is refused');
    assert.equal(f.written.at(-1).id, request.id);
    assert.equal(f.written.at(-1).error.code, -32040);
    f.reply(other, 'other-thread');
    assert.equal(original.messages.some(message => message.id === request.id), false);
    assert.equal(peer.messages.some(message => message.id === request.id), false);
  });
}

for (const kind of ['question', 'approval']) {
  for (const failure of ['mismatched acceptance', 'expired adoption', 'disconnected adopter', 'handoff capacity', 'unrelated pending adoption']) {
    test(`${kind}: ${failure} retains the refused early interaction across a later resume`, t => {
      const f = fixture(t), original = f.owner(), adoption = f.adopt(original, 1);
      const field = kind === 'question' ? 'questionId' : 'approvalId';
      const request = { id: 2000100, method: `${kind}/request`, params: {
        threadId: 'actual-thread', turnId: 'turn-1', appServerEpoch: 'original-epoch',
        [field]: 'original-interaction',
      } };
      if (failure === 'handoff capacity') {
        for (let index = 0; index < 64; index++)
          f.broker.routeServerMessage({ ...request, id: 2000200 + index });
      }
      f.broker.routeServerMessage(request);
      // This newer candidate never owned the held request. Its pending state
      // must not disable retirement when the original candidate is rejected.
      if (failure === 'unrelated pending adoption') f.adopt(f.owner(), 2);
      if (failure === 'expired adoption') f.broker.expireRequest(adoption.id);
      if (failure === 'disconnected adopter') f.broker.detach(original);
      f.reply(adoption, 'actual-thread', { operationId: 'wrong-operation' });
      assert.equal(f.written.filter(message => message.id === request.id && message.error?.code === -32040).length, 1);

      const later = f.owner();
      f.broker.receive(later, JSON.stringify({ id: 10, method: 'thread/resume', params: { threadId: 'actual-thread' } }));
      f.broker.routeServerMessage({ id: f.written.at(-1).id, result: { thread: { id: 'actual-thread' } } });
      const written = f.written.length, delivered = later.messages.length;
      f.broker.routeServerMessage(structuredClone(request));
      assert.equal(later.messages.length, delivered, 'a refused interaction must not reopen on another client');
      assert.equal(f.written.length, written, 'a refused waiter receives only one rejection');
      assert.equal(f.broker.serverRequests.has(request.id), false);

      const terminal = { method: `${kind}/resolved`, params: { ...request.params,
        requestId: request.id, reason: 'cancelled', ...(kind === 'approval' ? { decision: 'decline' } : {}) } };
      for (const change of [{ [field]: 'foreign' }, { turnId: 'foreign' }, { appServerEpoch: 'foreign' }]) {
        f.broker.routeServerMessage({ ...terminal, params: { ...terminal.params, ...change } });
        assert.equal(later.messages.length, delivered, 'foreign receipts cannot settle the original refused request');
      }
      f.broker.routeServerMessage(terminal);
      assert.deepEqual(later.messages.at(-1), terminal, 'the original Native terminal remains observable');
      const fresh = { ...request, id: request.id + 1, params: { ...request.params, [field]: 'fresh-interaction' } };
      f.broker.routeServerMessage(fresh);
      assert.deepEqual(later.messages.at(-1), fresh, 'new interactions remain available');
    });
  }
}
