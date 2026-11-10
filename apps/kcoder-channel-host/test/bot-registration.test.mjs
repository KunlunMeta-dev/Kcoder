import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotRegistration } from '../src/adapters/bot-registration.mjs';
import { ChannelAuthorizations } from '../src/channels/authorizations.mjs';
import { ChannelStore } from '../src/channels/store.mjs';

const definitions = {
  wecom: {
    origin: 'https://work.weixin.qq.com', method: 'GET',
    begin: [{ data: { scode: 'PRIVATE_CODE', auth_url: 'https://work.weixin.qq.com/ai/qc/c?s=fixture' } }],
    waiting: { data: { status: 'waiting' } },
    success: { data: { status: 'success', bot_info: { botid: 'fixture-bot', secret: 'PRIVATE_SECRET' } } },
    expired: { data: { status: 'expired' } }, denied: { data: { status: 'denied' } },
    configuration: { botId: 'fixture-bot' }, credentials: { secret: 'PRIVATE_SECRET' },
  },
  dingtalk: {
    origin: 'https://oapi.dingtalk.com', method: 'POST',
    begin: [{ errcode: 0, nonce: 'PRIVATE_NONCE' }, { errcode: 0, device_code: 'PRIVATE_CODE',
      verification_uri_complete: 'https://open-dev.dingtalk.com/openapp/registration/openClaw?user_code=fixture', interval: 3, expires_in: 7200 }],
    waiting: { errcode: 0, status: 'WAITING' },
    success: { errcode: 0, status: 'SUCCESS', client_id: 'fixture-bot', client_secret: 'PRIVATE_SECRET' },
    expired: { errcode: 0, status: 'EXPIRED' }, denied: { errcode: 0, status: 'FAIL' },
    configuration: { clientId: 'fixture-bot' }, credentials: { clientSecret: 'PRIVATE_SECRET' },
  },
};

function fixture(platform) {
  const definition = definitions[platform], responses = structuredClone(definition.begin);
  let now = 0; const requests = [];
  const adapter = new BotRegistration(platform, { now: () => now, fetchImpl: async (url, options) => {
    requests.push({ url: String(url), ...options });
    const result = responses.shift();
    if (result instanceof Error) throw result;
    assert.notEqual(result, undefined, 'unexpected extra platform request');
    return new Response(JSON.stringify(result));
  } });
  return { adapter, responses, requests, definition, advance: (ms = 3000) => { now += ms; } };
}

for (const platform of Object.keys(definitions)) {
  test(`${platform}: official request shape, bounded polling, private credentials and cancellation`, async () => {
    const { adapter, requests, responses, advance, definition } = fixture(platform);
    const first = await adapter.create();
    assert.equal(first.state, 'waiting');
    assert.equal(first.intervalMs, 3000);
    assert.equal(JSON.stringify(first).includes('PRIVATE_'), false);
    const initialCount = requests.length;
    await adapter.poll(); assert.equal(requests.length, initialCount, 'honor server poll interval');
    responses.push(definition.waiting); advance(); await adapter.poll();
    responses.push(definition.success); advance(); const ready = await adapter.poll();
    assert.equal(ready.state, 'ready'); assert.equal(ready.verificationUrl, undefined);
    assert.deepEqual(adapter.configuration, definition.configuration); assert.deepEqual(adapter.credentials, definition.credentials);
    assert.equal(JSON.stringify(ready).includes('PRIVATE_'), false);
    for (const request of requests) {
      assert.equal(new URL(request.url).origin, definition.origin); assert.equal(request.method, definition.method);
      assert.equal(request.redirect, 'error'); assert.ok(request.signal);
    }
    if (platform === 'dingtalk') {
      assert.deepEqual(JSON.parse(requests[0].body), { source: 'DING_DWS_CLAW' });
      assert.deepEqual(JSON.parse(requests[1].body), { nonce: 'PRIVATE_NONCE' });
      assert.deepEqual(JSON.parse(requests.at(-1).body), { device_code: 'PRIVATE_CODE' });
    } else assert.equal(new URL(requests.at(-1).url).searchParams.get('scode'), 'PRIVATE_CODE');
    const count = requests.length; await adapter.poll(); assert.equal(requests.length, count);
    adapter.cancel(); assert.equal(adapter.credentials, undefined); assert.equal(adapter.code, undefined);
  });

  for (const terminal of ['expired', 'denied']) test(`${platform}: ${terminal} is terminal and never grants credentials`, async () => {
    const { adapter, responses, definition, advance, requests } = fixture(platform);
    await adapter.create(); responses.push(definition[terminal]); advance();
    const state = await adapter.poll(); assert.equal(state.state, terminal); assert.equal(state.verificationUrl, undefined);
    const count = requests.length; await adapter.poll(); assert.equal(requests.length, count);
    assert.equal(adapter.credentials, undefined); assert.equal(adapter.code, undefined);
  });

  test(`${platform}: local expiry and a network failure do not issue a new bot flow`, async () => {
    const { adapter, responses, advance, requests } = fixture(platform);
    const first = await adapter.create();
    responses.push(new TypeError('fetch failed')); advance(); await assert.rejects(adapter.poll());
    assert.equal(adapter.state.verificationUrl, first.verificationUrl);
    const count = requests.length; advance(first.expiresAtMs);
    assert.equal((await adapter.poll()).state, 'expired'); assert.equal(requests.length, count);
    assert.equal(adapter.credentials, undefined);
  });

  test(`${platform}: missing success credentials are rejected and cannot be committed`, async () => {
    const { adapter, responses, advance, definition } = fixture(platform);
    await adapter.create();
    const success = structuredClone(definition.success);
    if (platform === 'wecom') delete success.data.bot_info.secret; else delete success.client_secret;
    responses.push(success); advance();
    await assert.rejects(adapter.poll(), /CREDENTIALS_INVALID/); assert.equal(adapter.credentials, undefined);
  });

  test(`${platform}: cancel fences a late credential response even if the transport ignores AbortSignal`, async () => {
    const f = fixture(platform); await f.adapter.create(); f.advance();
    let finish;
    f.adapter.fetch = () => new Promise(resolve => { finish = resolve; });
    const pending = f.adapter.poll(); f.adapter.cancel();
    finish(new Response(JSON.stringify(f.definition.success)));
    await assert.rejects(pending); assert.equal(f.adapter.credentials, undefined); assert.equal(f.adapter.state.state, 'cancelled');
  });

  test(`${platform}: common authorization saves once, enforces owner/revision, and never starts transport`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'bot-registration-')), store = new ChannelStore(directory);
    const f = fixture(platform), authorizations = new ChannelAuthorizations(store, { [platform]: () => f.adapter });
    t.after(() => { authorizations.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
    const begin = { action: 'authorization_begin', flowId: 'same-flow', connectionId: 'same-connection', expectedRevision: 0, platform };
    await authorizations.request(begin, 'owner');
    await authorizations.request(begin, 'owner'); assert.equal(f.requests.length, f.definition.begin.length);
    await assert.rejects(authorizations.request({ action: 'authorization_read', flowId: begin.flowId }, 'peer'), /FLOW_MISSING/);
    const commit = { action: 'authorization_commit', flowId: begin.flowId, label: 'Verified' };
    await assert.rejects(authorizations.request(commit, 'owner'), /NOT_READY/);
    f.responses.push(f.definition.success); f.advance();
    const ready = await authorizations.request({ action: 'authorization_poll', flowId: begin.flowId }, 'owner');
    assert.equal(JSON.stringify(ready).includes('PRIVATE_'), false); assert.deepEqual(store.connections(), []);
    const [saved, repeated] = await Promise.all([authorizations.request(commit, 'owner'), authorizations.request(commit, 'owner')]);
    assert.deepEqual(saved, repeated); assert.equal(store.connections().length, 1); assert.equal(store.connection(begin.connectionId).enabled, false);
    assert.deepEqual(store.credentials(begin.connectionId), f.definition.credentials);
    assert.deepEqual(store.connection(begin.connectionId).configuration, f.definition.configuration);
    assert.equal(f.adapter.credentials, undefined);
  });
}

test('registration rejects untrusted browser URLs, malformed codes and prototype platform names', async () => {
  for (const url of ['https://evil.example/qr', 'http://work.weixin.qq.com/qr', 'https://user@work.weixin.qq.com/qr', 'https://work.weixin.qq.com:8443/qr']) {
    const f = fixture('wecom'); f.responses[0] = { data: { scode: 'private', auth_url: url } };
    await assert.rejects(f.adapter.create(), /URL_INVALID/);
  }
  const f = fixture('dingtalk'); f.responses[1].device_code = '';
  await assert.rejects(f.adapter.create(), /RESPONSE_INVALID/);
  const authorization = new ChannelAuthorizations({});
  await assert.rejects(authorization.request({ action: 'authorization_begin', platform: '__proto__', flowId: 'f', connectionId: 'c', expectedRevision: 0 }, 'owner'), /FLOW_MISSING/);
  authorization.close();
});

test('DingTalk two-hour registrations remain addressable after one hour and report expiry', async () => {
  const f = fixture('dingtalk'); let now = 0;
  const authorizations = new ChannelAuthorizations({}, { now: () => now, dingtalk: () => f.adapter });
  const begin = { action: 'authorization_begin', flowId: 'two-hour', connectionId: 'bot', platform: 'dingtalk', expectedRevision: 0 };
  await authorizations.request(begin, 'owner'); now = 3600001; f.advance(now);
  assert.equal((await authorizations.request({ action: 'authorization_read', flowId: begin.flowId }, 'owner')).state, 'waiting');
  now = 7200001; f.advance(3600000);
  assert.equal((await authorizations.request({ action: 'authorization_poll', flowId: begin.flowId }, 'owner')).state, 'expired');
  authorizations.close();
});
