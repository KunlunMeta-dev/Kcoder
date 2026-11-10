import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelStore } from '../src/channels/store.mjs';
import { ChannelAuthorizations } from '../src/channels/authorizations.mjs';
import { FeishuRegistration } from '../src/adapters/feishu-registration.mjs';
import { WeixinQrAuthorization } from '../src/adapters/weixin.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'channel-auth-')), store = new ChannelStore(root);
  let creates = 0, cancels = 0;
  const authorizations = new ChannelAuthorizations(store, { feishu: () => ({
    create: async () => { creates++; return { state: 'waiting', verificationUrl: 'https://accounts.feishu.cn/fixture' }; },
    poll: async function() { this.configuration = { appId: 'original-app' }; this.credentials = { appSecret: 'FIXTURE_PRIVATE_SECRET' }; return { state: 'ready', appId: 'original-app' }; },
    cancel: () => { cancels++; },
  }) });
  t.after(() => { authorizations.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, authorizations, creates: () => creates, cancels: () => cancels };
}
const begin = { action: 'authorization_begin', platform: 'feishu', flowId: 'original-flow', connectionId: 'original-connection', expectedRevision: 0 };

test('initial authentication is private and creates no connection before explicit save', async t => {
  const { store, authorizations, creates } = fixture(t);
  const first = await authorizations.request(begin, 'gateway-login');
  assert.equal(first.state, 'waiting');
  await authorizations.request(begin, 'gateway-login');
  assert.equal(creates(), 1); assert.deepEqual(store.connections(), []);
  const ready = await authorizations.request({ action: 'authorization_poll', flowId: begin.flowId }, 'gateway-login');
  assert.equal(ready.state, 'ready'); assert.deepEqual(store.connections(), []);
  assert.equal(JSON.stringify(ready).includes('FIXTURE_PRIVATE_SECRET'), false);
  const saved = await authorizations.request({ action: 'authorization_commit', flowId: begin.flowId, label: 'Saved' }, 'gateway-login');
  assert.equal(saved.state, 'saved'); assert.equal(store.credentials(begin.connectionId).appSecret, 'FIXTURE_PRIVATE_SECRET');
  assert.equal(store.connection(begin.connectionId).enabled, false);
  assert.equal((await authorizations.request({ action: 'authorization_commit', flowId: begin.flowId, label: 'Saved' }, 'gateway-login')).connection.revision, saved.connection.revision);
});

test('closing or a different login cannot publish pending private authentication data', async t => {
  const { store, authorizations, cancels } = fixture(t);
  await authorizations.request(begin, 'owner');
  await assert.rejects(authorizations.request({ action: 'authorization_poll', flowId: begin.flowId }, 'other'), /FLOW_MISSING/);
  await authorizations.request({ action: 'authorization_cancel', flowId: begin.flowId }, 'owner');
  await assert.rejects(authorizations.request({ action: 'authorization_commit', flowId: begin.flowId, label: 'No' }, 'owner'), /NOT_READY/);
  assert.deepEqual(store.connections(), []); assert.equal(cancels(), 1);
});

test('a stale authentication draft cannot overwrite a later saved connection', async t => {
  const { store, authorizations } = fixture(t);
  await authorizations.request(begin, 'owner');
  await authorizations.request({ action: 'authorization_poll', flowId: begin.flowId }, 'owner');
  store.saveConnection({ id: begin.connectionId, platform: 'feishu', label: 'Later', configuration: { appId: 'later-app' } }, { appSecret: 'LATER_FIXTURE_SECRET' });
  await assert.rejects(authorizations.request({ action: 'authorization_commit', flowId: begin.flowId, label: 'Stale' }, 'owner'), /STATE_CHANGED/);
  assert.equal(store.connection(begin.connectionId).configuration.appId, 'later-app');
});

test('official Feishu registration handles OAuth pending and Lark switching without publishing secrets', async () => {
  let now = 0;
  const responses = [
    [200, { supported_auth_methods: ['client_secret'] }],
    [200, { device_code: 'FIXTURE_DEVICE_CODE', verification_uri_complete: 'https://accounts.feishu.cn/confirm?from=other', interval: 1, expires_in: 600 }],
    [400, { error: 'authorization_pending' }],
    [200, { user_info: { tenant_brand: 'lark' } }],
    [200, { client_id: 'fixture-app', client_secret: 'FIXTURE_SECRET' }],
  ];
  const requests = [];
  const adapter = new FeishuRegistration({ now: () => now, fetchImpl: async (url, options) => {
    requests.push({ url, fields: Object.fromEntries(options.body) });
    const [status, body] = responses.shift(); return new Response(JSON.stringify(body), { status });
  } });
  const created = await adapter.create(); assert.equal(created.state, 'waiting');
  assert.equal(new URL(created.verificationUrl).searchParams.get('createOnly'), 'true');
  now = 1000; assert.equal((await adapter.poll()).state, 'waiting');
  now = 2000; await adapter.poll(); assert.equal((await adapter.poll()).state, 'ready');
  assert.equal(requests.at(-1).url.startsWith('https://accounts.larksuite.com/'), true);
  assert.equal(adapter.configuration.appId, 'fixture-app'); assert.equal(adapter.credentials.appSecret, 'FIXTURE_SECRET');
  assert.equal(JSON.stringify(adapter.state).includes('FIXTURE_SECRET'), false);
  assert.equal(JSON.stringify(adapter.state).includes('FIXTURE_DEVICE_CODE'), false);
  adapter.cancel(); assert.equal(adapter.credentials, undefined);
});

test('Weixin scan stores only the platform credential and client metadata, without an additional task grant', async t => {
  const { store } = fixture(t);
  const authorizations = new ChannelAuthorizations(store, { weixin: () => ({
    create: async () => ({ state: 'waiting', image: 'https://ilinkai.weixin.qq.com/fixture' }),
    poll: async () => ({ state: 'confirmed', privateCredentials: {
      botToken: 'FIXTURE_PRIVATE_BOT_TOKEN', accountId: 'scanned-account', apiBase: 'https://ilinkai.weixin.qq.com',
    } }), cancel() {},
  }) });
  t.after(() => authorizations.close());
  const request = { ...begin, platform: 'weixin' };
  await authorizations.request(request, 'owner');
  const ready = await authorizations.request({ action: 'authorization_poll', flowId: request.flowId }, 'owner');
  assert.equal(ready.state, 'ready'); assert.equal(JSON.stringify(ready).includes('FIXTURE_PRIVATE_BOT_TOKEN'), false);
  const saved = await authorizations.request({ action: 'authorization_commit', flowId: request.flowId, label: 'Weixin' }, 'owner');
  assert.equal(saved.state, 'saved');
  assert.equal(store.connection(request.connectionId).configuration.accountId, 'scanned-account');
  assert.equal(store.credentials(request.connectionId).botToken, 'FIXTURE_PRIVATE_BOT_TOKEN');
});

test('Weixin QR long polling survives 15 seconds and preserves the original scanned flow after its own timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(AbortSignal, 'timeout', duration => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), duration);
    return controller.signal;
  });
  const { store } = fixture(t);
  let creates = 0, polls = 0;
  const authorizations = new ChannelAuthorizations(store, { weixin: () => new WeixinQrAuthorization({
    transport: async (url, { signal }) => {
      if (url.includes('get_bot_qrcode')) { creates++; return { qrcode: 'original-private-qr', qrcode_img_content: 'https://ilinkai.weixin.qq.com/fixture' }; }
      assert.equal(new URL(url).searchParams.get('qrcode'), 'original-private-qr');
      if (++polls === 1) return { status: 'scaned' };
      if (polls === 2) return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return { status: 'confirmed', bot_token: 'FIXTURE_PRIVATE_TOKEN', ilink_bot_id: 'fixture-account' };
    },
  }) });
  t.after(() => authorizations.close());
  const request = { ...begin, platform: 'weixin' };
  const first = await authorizations.request(request, 'owner');
  assert.equal((await authorizations.request({ action: 'authorization_poll', flowId: request.flowId }, 'owner')).state, 'scanned');
  let settled = false;
  const pending = authorizations.request({ action: 'authorization_poll', flowId: request.flowId }, 'owner');
  pending.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(setImmediate);
  t.mock.timers.tick(15000); await new Promise(setImmediate);
  assert.equal(settled, false, 'the Gateway must not abort the SDK long poll at 15 seconds');
  t.mock.timers.tick(15000);
  const unchanged = await pending;
  assert.equal(unchanged.state, 'scanned');
  assert.equal(unchanged.verificationUrl, first.verificationUrl);
  assert.equal(unchanged.expiresAtMs, first.expiresAtMs);
  const ready = await authorizations.request({ action: 'authorization_poll', flowId: request.flowId }, 'owner');
  assert.equal(ready.state, 'ready'); assert.equal(creates, 1);
  assert.equal(JSON.stringify(ready).includes('FIXTURE_PRIVATE_TOKEN'), false);
  assert.deepEqual(store.connections(), [], 'polling never saves or connects an account');
});
