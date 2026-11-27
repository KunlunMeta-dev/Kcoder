import assert from 'node:assert/strict';
import test from 'node:test';
import { listWakeTargets } from './agent-message-router-wake-targets.js';

const address = (host, threadId) => ({ targetId: host, workspaceId: host + '-workspace', threadId });
const sender = address('remote', 'sender');
const recipient = address('local', 'recipient');
const row = address => ({ address, threadId: address.threadId, status: 'idle', presence: 'resident', allowedModes: [] });
const page = (targets, nextCursor, completeness = 'complete') => ({
  coverage: 'workspace_history', observedAtMs: 1, completeness, targets,
  ...(nextCursor ? { nextCursor } : {}),
});

function fixture({ peerSupported = true } = {}) {
  const calls = [];
  const options = {
    cursors: new Map(), now: () => 1, owner: {}, broker: {},
    attempt: { threadId: recipient.threadId, turnId: 'turn-1', attemptId: 'attempt-1' },
    origin: { sender, recipient, messageId: 'message-1' }, localIdentity: recipient, peerSupported,
    async readLocal(query, authorizationId) {
      calls.push({ query, authorizationId });
      return query.cursor
        ? page([row(address('local', 'second'))])
        : page([row(address('local', 'first'))], 'native-cursor');
    },
    async readPeer(query) {
      calls.push({ peer: query });
      return page([row(sender)], undefined, 'partial');
    },
    async verify() {},
  };
  return { calls, options, list: (query, overrides) => listWakeTargets({ ...options, ...overrides, query }) };
}

test('wake discovery preserves local pages and adds only the original sender with the original filters', async () => {
  const { calls, options, list } = fixture();
  const first = await list({ title: 'project', limit: 1 });
  assert.deepEqual(first.targets.map(x => x.threadId), ['first']);
  assert.notEqual(first.nextCursor, 'native-cursor');
  await assert.rejects(list({ cursor: first.nextCursor, title: 'changed' }),
    { message: 'AGENT_MESSAGES_CURSOR_FILTER_MISMATCH' });
  await assert.rejects(list({ cursor: first.nextCursor }, { attempt: { ...options.attempt, attemptId: 'replacement' } }),
    { message: 'AGENT_MESSAGES_CURSOR_INVALID' });
  const second = await list({ cursor: first.nextCursor });
  assert.deepEqual(second.targets.map(x => x.threadId), ['second']);
  assert.equal(calls[1].authorizationId, calls[0].authorizationId);
  assert.deepEqual(calls[1].query, { cursor: 'native-cursor', limit: 1 });
  const third = await list({ cursor: second.nextCursor });
  assert.deepEqual(third.targets.map(x => x.threadId), ['sender']);
  assert.deepEqual(calls[2].peer, { title: 'project', limit: 1 });
  assert.ok([first, second, third].every(x => x.completeness === 'partial'));
  assert.equal(third.nextCursor, undefined);
});

test('an older sender still leaves all local discovery pages available', async () => {
  const { calls, list } = fixture({ peerSupported: false });
  const first = await list({ limit: 1 });
  const second = await list({ cursor: first.nextCursor });
  assert.deepEqual([...first.targets, ...second.targets].map(x => x.threadId), ['first', 'second']);
  assert.equal(second.nextCursor, undefined);
  assert.equal(second.completeness, 'partial');
  assert.ok(calls.every(call => !call.peer));
});

test('a sender already included in the local directory does not appear again as a peer', async () => {
  const { list } = fixture();
  const localSender = address('local', 'sender');
  const result = await list({ limit: 1 }, {
    origin: { sender: localSender, recipient, messageId: 'message-1' },
    async readLocal() { return page([row(localSender)]); },
    async readPeer() { assert.fail('sender is already visible in the same workspace'); },
  });
  assert.deepEqual(result.targets.map(target => target.address), [localSender]);
  assert.equal(result.nextCursor, undefined);
});

test('discovery checks scope before issuing a next cursor or exposing a result', async () => {
  const { options, list } = fixture();
  await assert.rejects(list({ limit: 1 }, { async verify() { throw new Error('scope changed'); } }),
    { message: 'scope changed' });
  assert.equal(options.cursors.size, 0);
  await assert.rejects(list({ targetId: sender.targetId }, {
    async readPeer() { return page([row(address('remote', 'unrelated'))], undefined, 'partial'); },
  }), { message: 'AGENT_MESSAGES_INVALID_DISCOVERY_RESPONSE' });
  assert.equal(options.cursors.size, 0);
});

test('invalid native pages cannot return duplicate rows, unmatched filters or a repeated native cursor', async () => {
  const { list } = fixture();
  const local = row(address('local', 'row'));
  const invalid = { message: 'AGENT_MESSAGES_INVALID_DISCOVERY_RESPONSE' };
  await assert.rejects(list({}, { async readLocal() { return page([local, local]); } }), invalid);
  await assert.rejects(list({ status: 'running' }, { async readLocal() { return page([local]); } }), invalid);
  const first = await list({ limit: 1 });
  await assert.rejects(list({ cursor: first.nextCursor }, {
    async readLocal() { return page([], 'native-cursor'); },
  }), invalid);
});

test('wake discovery applies the ordinary title display bounds', async () => {
  const { list } = fixture();
  const title = '\u0000' + '😀'.repeat(250);
  const first = await list({ limit: 1 }, {
    async readLocal() { return page([{ ...row(address('local', 'row')), title }]); },
  });
  assert.equal(first.targets[0].title, '😀'.repeat(200));
});
