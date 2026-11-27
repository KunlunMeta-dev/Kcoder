import assert from 'node:assert/strict';
import test from 'node:test';
import { createLoginFailureBudget, createLoginTickets } from './gateway-login-policy.mjs';

test('login failure budgets expire precisely and remain bounded across shared peers', () => {
  let time = 0;
  const budget = createLoginFailureBudget({ now: () => time, maximumPeers: 2 });
  const peer = address => ({ socket: { remoteAddress: address } });
  const request = peer('shared');
  for (let i = 0; i < 5; i++) budget.record(request);
  assert.equal(budget.retryAfter(request), 60);
  time = 59_001; assert.equal(budget.retryAfter(request), 1);
  time = 60_000; assert.equal(budget.retryAfter(request), 0);
  budget.record(peer('one')); budget.record(peer('two')); budget.record(peer('three'));
  assert.equal(budget.retryAfter(peer('one')), 0);
});

test('single-use tickets expire, cannot cross instances and admit only one concurrent exchange', async () => {
  let time = 0;
  const tickets = createLoginTickets({ now: () => time, maximumTickets: 2 });
  const first = tickets.issue();
  assert.equal(first.expiresAt, 300_000);
  assert.equal(createLoginTickets().consume(first.token), false);
  assert.deepEqual(await Promise.all([Promise.resolve().then(() => tickets.consume(first.token)),
    Promise.resolve().then(() => tickets.consume(first.token))]), [true, false]);
  const expired = tickets.issue(); time = 300_000; assert.equal(tickets.consume(expired.token), false);
  const evicted = tickets.issue(); tickets.issue(); tickets.issue();
  assert.equal(tickets.consume(evicted.token), false);
  for (const value of [null, 'master-password', 'x'.repeat(65536)]) assert.equal(tickets.consume(value), false);
});
