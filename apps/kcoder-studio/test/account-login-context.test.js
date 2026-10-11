import test from 'node:test';
import assert from 'node:assert/strict';
import { ANONYMOUS_LOGIN_OWNER, ACCOUNT_USERNAME_PATTERN, authorityIdFor, createAccountLoginContexts } from '../src/account-login-context.js';

const alice = { principalId: '0b6cfba4-5f61-4d17-9d92-3d60a1ef2f01', username: 'alice', role: 'user' };
const bob = { principalId: '8a2f6d0e-1c3b-4a5f-9e8d-7b6a5c4d3e2f', username: 'bob', role: 'admin' };

test('the same target keeps independent identities per login owner', () => {
  const contexts = createAccountLoginContexts();
  contexts.publish('session-a', 'server', alice, { username: 'alice', password: 'secret-a' });
  contexts.publish('session-b', 'server', bob, { username: 'bob', password: 'secret-b' });

  assert.equal(contexts.identity('session-a', 'server').username, 'alice');
  assert.equal(contexts.identity('session-b', 'server').username, 'bob');
  assert.equal(contexts.credential('session-a', 'server').password, 'secret-a');
  assert.equal(contexts.credential('session-b', 'server').password, 'secret-b');

  // Switching one owner does not touch the other.
  contexts.invalidate('session-a', 'server');
  assert.equal(contexts.identity('session-a', 'server'), null);
  assert.equal(contexts.credential('session-a', 'server'), null);
  assert.equal(contexts.identity('session-b', 'server').username, 'bob');
  assert.equal(contexts.credential('session-b', 'server').password, 'secret-b');
});

test('generation increases on invalidate and identity change but not on re-authentication', () => {
  const contexts = createAccountLoginContexts();
  assert.equal(contexts.generation('owner', 'server'), 0);
  contexts.publish('owner', 'server', alice, { username: 'alice', password: 'one' });
  const afterLogin = contexts.generation('owner', 'server');
  assert.equal(afterLogin, 1);

  // A restarted broker re-publishes the same principal without churning.
  contexts.publish('owner', 'server', alice, { username: 'alice', password: 'one' });
  assert.equal(contexts.generation('owner', 'server'), afterLogin);

  contexts.invalidate('owner', 'server');
  assert.equal(contexts.generation('owner', 'server'), afterLogin + 1);
  contexts.publish('owner', 'server', bob, { username: 'bob', password: 'two' });
  assert.equal(contexts.generation('owner', 'server'), afterLogin + 2);
  assert.equal(contexts.identity('owner', 'server').username, 'bob');
});

test('mutations serialize per login owner and target', async () => {
  const contexts = createAccountLoginContexts();
  const order = [];
  const first = contexts.mutate('owner', 'server', async () => {
    order.push('first-start');
    await new Promise(resolve => setTimeout(resolve, 10));
    order.push('first-end');
  });
  const second = contexts.mutate('owner', 'server', async () => {
    order.push('second');
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);

  // A failing mutation does not poison the queue.
  await assert.rejects(contexts.mutate('owner', 'server', async () => { throw new Error('boom'); }), /boom/);
  await contexts.mutate('owner', 'server', async () => { order.push('recovered'); });
  assert.equal(order.at(-1), 'recovered');
});

test('invalidateTarget drops every owner of the target and only that target', () => {
  const contexts = createAccountLoginContexts();
  contexts.publish('session-a', 'server', alice, { username: 'alice', password: 'a' });
  contexts.publish('session-b', 'server', alice, { username: 'alice', password: 'a' });
  contexts.publish('session-a', 'other', alice, { username: 'alice', password: 'a' });
  contexts.invalidateTarget('server');
  assert.equal(contexts.identity('session-a', 'server'), null);
  assert.equal(contexts.identity('session-b', 'server'), null);
  assert.equal(contexts.identity('session-a', 'other').username, 'alice');
});

test('unverified identities and missing credentials are rejected', () => {
  const contexts = createAccountLoginContexts();
  assert.throws(() => contexts.publish('owner', 'server', { username: 'alice' }, { username: 'alice', password: 'x' }));
  assert.throws(() => contexts.publish('owner', 'server', alice, null));
  assert.equal(contexts.identity('owner', 'server'), null);
});

test('authority ids derive from connection parameters and distinguish targets', () => {
  assert.equal(authorityIdFor({ host: 'example.test', port: 22 }), authorityIdFor({ host: 'example.test' }));
  assert.notEqual(authorityIdFor({ host: 'example.test' }), authorityIdFor({ host: 'other.test' }));
  assert.notEqual(authorityIdFor({ host: 'example.test' }), authorityIdFor({ host: 'example.test', port: 2222 }));
  assert.match(authorityIdFor({ host: 'example.test' }), /^[0-9a-f]{16}$/);
});

test('anonymous owner constant and username pattern are stable', () => {
  assert.equal(ANONYMOUS_LOGIN_OWNER, 'local');
  assert.match(ACCOUNT_USERNAME_PATTERN.source, /^\^\[a-z\]/);
});
