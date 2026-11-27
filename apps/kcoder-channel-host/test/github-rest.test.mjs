import test from 'node:test';
import assert from 'node:assert/strict';
import { GithubAdapter, githubRequest, githubDeliveryMarker, githubRateLimitWait } from '../src/adapters/github.mjs';

const url = 'https://api.github.com/repos/owner/repo/issues/7/comments';
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers },
});
const makeAdapter = fetchImpl => new GithubAdapter({
  configuration: { botLogin: 'fixture-bot', repositories: ['owner/repo'] },
  credentials: { token: 'fixture-only' },
  transport: (address, options) => githubRequest(address, { ...options, fetchImpl }),
});

test('actual Octokit forwards GET pagination parameters, authentication and rate-limit headers', async () => {
  const calls = [], controller = new AbortController();
  const result = await githubRequest(url + '?per_page=50&page=2', { signal: controller.signal,
    headers: { Authorization: 'Bearer fixture-only' }, fetchImpl: async (address, options) => {
      calls.push({ address, options }); return json([{ id: 1 }], 200, { 'x-ratelimit-remaining': '3', link: '<next>', date: 'Wed, 04 Nov 2026 08:00:00 GMT' });
    } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].address, url + '?per_page=50&page=2');
  assert.equal(calls[0].options.headers.authorization, 'Bearer fixture-only');
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(result.body, [{ id: 1 }]);
  assert.equal(result.headers.remaining, '3'); assert.equal(result.headers.link, '<next>');
  assert.equal(result.headers.date, 'Wed, 04 Nov 2026 08:00:00 GMT');
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
  const adapter = makeAdapter(async (_target, request) => {
        if (request.method === 'POST') { posts++; throw new Error('fixture-lost-reply'); }
        reads++; return json([{ id: 42, body: 'original\n' + githubDeliveryMarker('original-delivery'), user: { login: 'fixture-bot' } }]);
  });
  const result = await adapter.send({ destination: { conversationId: 'owner/repo', topicId: '7' }, content: { text: 'original' } }, { deliveryId: 'original-delivery' });
  assert.equal(result.state, 'accepted'); assert.equal(result.messageId, '42'); assert.equal(result.reconciled, true);
  assert.equal(posts, 1); assert.equal(reads, 1);
});

test('an absent marker after HTTP 503 stays unknown and explicit reconciliation only reads', async () => {
  let posts = 0, reads = 0;
  const adapter = makeAdapter(async (_target, request) => {
        if (request.method === 'POST') { posts++; return json({ message: 'fixture-unavailable' }, 503); }
        reads++; return json([]);
  });
  const payload = { destination: { conversationId: 'owner/repo', topicId: '7' }, content: { text: 'original' } };
  await assert.rejects(adapter.send(payload, { deliveryId: 'original' }), { code: 'GITHUB_DELIVERY_UNCONFIRMED' });
  assert.equal((await adapter.reconcile({}, payload, { deliveryId: 'original' })).state, 'unknown');
  assert.equal(posts, 1); assert.equal(reads, 2);
});

test('lost POST receipts reconcile the last page regardless of Link query order or spacing', async () => {
  for (const link of ['<https://api.github.com/repos/owner/repo/issues/7/comments?page=5&per_page=100>; rel="last"',
    '<https://api.github.com/repos/owner/repo/issues/7/comments?per_page=100&page=5>;rel="last", <https://api.github.com/repos/owner/repo/issues/7/comments?page=2>; rel="next"']) {
    let posts = 0; const pages = [];
    const adapter = makeAdapter(async (target, request) => {
          if (request.method === 'POST') { posts++; throw new Error('fixture-lost-reply'); }
          const page = Number(new URL(target).searchParams.get('page')); pages.push(page);
          return json(page === 5 ? [{ id: 42, body: githubDeliveryMarker('original'), user: { login: 'fixture-bot' } }] : [], 200, { link });
    });
    const receipt = await adapter.send({ destination: { conversationId: 'owner/repo', topicId: '7' }, content: { text: 'original' } }, { deliveryId: 'original' });
    assert.equal(receipt.messageId, '42'); assert.equal(receipt.reconciled, true);
    assert.equal(posts, 1); assert.deepEqual(pages, [1, 5]);
  }
});

test('cancellation after a POST begins keeps the send unknown and does not start a marker scan', async () => {
  let posts=0,reads=0;const controller=new AbortController();
  const adapter=makeAdapter(async(_target,request)=>{
      if(request.method==='POST'){posts++;controller.abort();request.signal.throwIfAborted();}
      reads++;return json([]);
  });
  await assert.rejects(adapter.send({destination:{conversationId:'owner/repo',topicId:'7'},content:{text:'original'}},
    {deliveryId:'cancelled',signal:controller.signal}),error=>error.code==='GITHUB_DELIVERY_UNCONFIRMED'&&error.externalOutcome!=='failed');
  assert.equal(posts,1);assert.equal(reads,0);
});

test('marker reconciliation inherits caller cancellation without replaying the POST', async () => {
  let posts=0,reads=0,scanAborted=false;const controller=new AbortController();
  const adapter=makeAdapter(async(_target,request)=>{
      if(request.method==='POST'){posts++;throw new Error('fixture-lost-reply');}
      reads++;controller.abort();scanAborted=request.signal.aborted;request.signal.throwIfAborted();return json([]);
  });
  await assert.rejects(adapter.send({destination:{conversationId:'owner/repo',topicId:'7'},content:{text:'original'}},
    {deliveryId:'cancelled-scan',signal:controller.signal}),error=>error.code==='GITHUB_DELIVERY_UNCONFIRMED'&&error.externalOutcome!=='failed');
  assert.equal(posts,1);assert.equal(reads,1);assert.equal(scanAborted,true);
});
