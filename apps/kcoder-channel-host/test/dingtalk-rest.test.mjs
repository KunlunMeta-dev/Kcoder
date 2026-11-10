import test from 'node:test';
import assert from 'node:assert/strict';
import { DingTalkRest } from '../src/adapters/dingtalk-rest.mjs';
import { platformJson } from '../src/transport.mjs';

test('actual DingTalk SDK constructs token, gateway, message, card and download requests', async () => {
  const calls = [];
  const sdk = new DingTalkRest(async (url, options) => {
    calls.push({ url, options });
    return { accessToken: 'fixture-token', endpoint: 'wss://fixture.dingtalk.com', ticket: 'fixture-ticket',
      processQueryKey: 'receipt', success: true,
      result: options.method === 'PUT' ? true : { outTrackId: 'original', deliverResults: [{ success: true }] },
      downloadUrl: 'https://down.dingtalk.com/file' };
  });
  const options = { token: 'fixture-token' };
  await sdk.accessToken({ appKey: 'fixture-app', appSecret: 'fixture-private', ignored: 'must-not-send' });
  await sdk.openConnection({ clientId: 'fixture-app', clientSecret: 'fixture-private', ua: 'fixture', subscriptions: [{ type: 'CALLBACK', topic: '/robot' }] });
  await sdk.sendMessage({ robotCode: 'bot', msgKey: 'sampleText', msgParam: '{}', userIds: ['original-user'] }, false, options);
  await sdk.sendMessage({ robotCode: 'bot', msgKey: 'sampleText', msgParam: '{}', openConversationId: 'original-group' }, true, options);
  await sdk.card({ cardTemplateId: 'template', outTrackId: 'original', cardData: { cardParamMap: { content: 'original' } } }, false, options);
  await sdk.card({ outTrackId: 'original', cardData: { cardParamMap: { content: 'updated' } } }, true, options);
  await sdk.download({ robotCode: 'bot', downloadCode: 'file-code' }, options);
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), [
    '/v1.0/oauth2/accessToken', '/v1.0/gateway/connections/open', '/v1.0/robot/oToMessages/batchSend',
    '/v1.0/robot/groupMessages/send', '/v1.0/card/instances/createAndDeliver', '/v1.0/card/instances', '/v1.0/robot/messageFiles/download',
  ]);
  assert.equal(calls[0].options.body.ignored, undefined);
  assert.deepEqual(calls[2].options.body.userIds, ['original-user']);
  assert.equal(calls[3].options.body.openConversationId, 'original-group');
  assert.equal(calls[5].options.method, 'PUT'); assert.equal(calls[5].options.body.outTrackId, 'original');
  assert.equal(calls[2].options.headers['x-acs-dingtalk-access-token'], 'fixture-token');
  assert.ok(calls.every(call => call.url.startsWith('https://api.dingtalk.com/') && call.options.hosts[0] === 'api.dingtalk.com'));
});

for (const status of [400, 500]) test(`actual DingTalk SDK does not replay an HTTP ${status} send`, async () => {
  let calls = 0;
  const sdk = new DingTalkRest((url, options) => platformJson(url, { ...options, fetchImpl: async () => {
    calls++; return new Response('{"code":"fixture-rejected"}', { status });
  } }));
  await assert.rejects(sdk.sendMessage({ robotCode: 'bot', msgKey: 'sampleText', msgParam: '{}', userIds: ['user'] }, false, { token: 'fixture' }),
    error => error.externalOutcome === (status === 400 ? 'failed' : 'unknown'));
  assert.equal(calls, 1);
});

test('cancellation before SDK dispatch is a definite non-send; a lost receipt stays uncertain', async () => {
  let calls = 0;
  const sdk = new DingTalkRest(async () => { calls++; throw new Error('lost receipt'); });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(sdk.sendMessage({}, false, { signal: controller.signal }), error => error.externalOutcome === 'failed');
  assert.equal(calls, 0);
  await assert.rejects(sdk.sendMessage({}, false, {}), error => error.message === 'lost receipt' && error.externalOutcome !== 'failed');
  assert.equal(calls, 1);
});

test('concurrent SDK clients keep their own credential, destination and cancellation signal', async () => {
  const calls = [];
  const sdk = new DingTalkRest(async (_url, options) => { calls.push(options); return { processQueryKey: options.body.userIds[0] }; });
  const first = new AbortController(), second = new AbortController();
  const results = await Promise.all(['one', 'two'].map((id, index) => sdk.sendMessage({ userIds: [id] }, false,
    { token: id, signal: index ? second.signal : first.signal })));
  assert.deepEqual(results.map(value => value.processQueryKey), ['one', 'two']);
  assert.equal(calls[0].headers['x-acs-dingtalk-access-token'], 'one');
  assert.equal(calls[1].headers['x-acs-dingtalk-access-token'], 'two');
  assert.equal(calls[0].signal, first.signal); assert.equal(calls[1].signal, second.signal);
});
