import test from 'node:test';
import assert from 'node:assert/strict';
import { GithubAdapter, githubRequest, githubDeliveryMarker, githubRateLimitWait } from '../src/adapters/github.mjs';

const url = 'https://api.github.com/repos/owner/repo/issues/7/comments';
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers },
});

test('actual Octokit keeps bounded GET pagination parameters, authentication and rate-limit headers', async () => {
  const calls = [], controller = new AbortController();
  const result = await githubRequest(url + '?per_page=50&page=2', { signal: controller.signal,
    headers: { Authorization: 'Bearer fixture-only' }, fetchImpl: async (address, options) => {
      calls.push({ address, options }); return json([{ id: 1 }], 200, { 'x-ratelimit-remaining': '3', link: '<next>' });
    } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].address, url + '?per_page=50&page=2');
  assert.equal(calls[0].options.headers.authorization, 'Bearer fixture-only');
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(result.body, [{ id: 1 }]);
  assert.equal(result.headers.remaining, '3'); assert.equal(result.headers.link, '<next>');
});

for (const status of [201, 429, 503]) test(`actual Octokit POST sends the exact comment once on HTTP ${status}`, async () => {
  const calls = [];
  const result = await githubRequest(url, { method: 'POST', body: { body: 'original comment' }, fetchImpl: async (address, options) => {
    calls.push({ address, options }); return json({ id: 42 }, status, { 'retry-after': '120' });
  } });
  assert.equal(calls.length, 1, 'no implicit retry or throttling plugin may replay a write');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { body: 'original comment' });
  assert.equal(result.status, status);
  if (status === 429) assert.equal(githubRateLimitWait(result), 120000);
});

for (const status of [200, 503]) test(`actual Octokit rejects oversized HTTP ${status} before response decoding`, async () => {
  let calls = 0;
  await assert.rejects(githubRequest(url, { maxBytes: 32, fetchImpl: async () => {
    calls++; return json({ content: 'x'.repeat(100) }, status);
  } }), { code: 'PLATFORM_RESPONSE_TOO_LARGE' });
  assert.equal(calls, 1);
});

test('actual Octokit respects cancellation and rejects foreign hosts before any request', async () => {
  let calls = 0;
  await assert.rejects(githubRequest('https://example.invalid/comments', { fetchImpl: async () => { calls++; } }), { code: 'UNAPPROVED_HOST' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(githubRequest(url, { signal: controller.signal, fetchImpl: async (_address, options) => {
    options.signal.throwIfAborted(); calls++;
  } }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('a lost Octokit POST receipt reconciles the original marker without posting again', async () => {
  let posts = 0, reads = 0;
  const adapter = new GithubAdapter({ configuration: { botLogin: 'fixture-bot', repositories: ['owner/repo'] },
    credentials: { token: 'fixture-only' }, transport: (address, options) => githubRequest(address, {
      ...options, fetchImpl: async (_target, request) => {
        if (request.method === 'POST') { posts++; throw new Error('fixture-lost-reply'); }
        reads++; return json([{ id: 42, body: 'original\n' + githubDeliveryMarker('original-delivery'), user: { login: 'fixture-bot' } }]);
      },
    }) });
  const result = await adapter.send({ destination: { conversationId: 'owner/repo', topicId: '7' }, content: { text: 'original' } }, { deliveryId: 'original-delivery' });
  assert.equal(result.state, 'accepted'); assert.equal(result.messageId, '42'); assert.equal(result.reconciled, true);
  assert.equal(posts, 1); assert.equal(reads, 1);
});

test('an absent marker after HTTP 503 stays unknown and explicit reconciliation only reads', async () => {
  let posts = 0, reads = 0;
  const adapter = new GithubAdapter({ configuration: { botLogin: 'fixture-bot', repositories: ['owner/repo'] },
    credentials: { token: 'fixture-only' }, transport: (address, options) => githubRequest(address, {
      ...options, fetchImpl: async (_target, request) => {
        if (request.method === 'POST') { posts++; return json({ message: 'fixture-unavailable' }, 503); }
        reads++; return json([]);
      },
    }) });
  const payload = { destination: { conversationId: 'owner/repo', topicId: '7' }, content: { text: 'original' } };
  await assert.rejects(adapter.send(payload, { deliveryId: 'original' }), { code: 'GITHUB_DELIVERY_UNCONFIRMED' });
  assert.equal((await adapter.reconcile({}, payload, { deliveryId: 'original' })).state, 'unknown');
  assert.equal(posts, 1); assert.equal(reads, 2);
});
