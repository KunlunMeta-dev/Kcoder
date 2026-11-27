import assert from 'node:assert/strict';
import test from 'node:test';
import definitions from '../src/channel-platforms.json' with { type: 'json' };
import { officialAdapters } from '../src/adapters/index.mjs';
import { assertChannelAdapter, channelPlatform, channelContextTtl, prepareChannelDestination } from '../src/adapters/contract.mjs';
import { validateChannelConfiguration, validateChannelCredentials } from '../src/channels/configuration.mjs';
import { PLATFORMS, PLATFORM_IDENTITY_FIELD } from '../src/validation.mjs';
import { CHANNEL_CATALOG } from '../src/catalog.mjs';
import { installationFacts } from '../src/installation.mjs';
import { ChannelAuthorizations } from '../src/channels/authorizations.mjs';

test('every platform has one descriptor, a factory and matching SDK installation metadata', () => {
  const platforms = Object.keys(definitions).sort();
  assert.deepEqual([...officialAdapters().keys()].sort(), platforms);
  assert.deepEqual([...PLATFORMS].sort(), platforms);
  assert.deepEqual(CHANNEL_CATALOG.map(row => row.kind).sort(), platforms);
  assert.deepEqual(installationFacts().map(row => row.kind).sort(), platforms);
  assert.deepEqual(Object.keys(new ChannelAuthorizations({}).factories).sort(),
    platforms.filter(platform => definitions[platform].authentication === 'qr'));
  const installed = installationFacts();
  assert.equal(installed.find(value => value.kind === 'github').packageName, '@octokit/rest');
  assert.equal(installed.find(value => value.kind === 'dingtalk').installed, true);
  assert.equal(installed.find(value => value.kind === 'wecom').version, '1.0.7');
});

for (const [platform, definition] of Object.entries(definitions)) {
  test(`${platform}: public configuration, private credential and lifecycle contract (no network)`, () => {
    assert.equal(PLATFORM_IDENTITY_FIELD[platform], definition.identityField);
    assert.ok(definition.configurationFields.includes(definition.identityField));
    assert.ok(!definition.configurationFields.includes(definition.credentialField));
    const configuration = { [definition.identityField]: 'fixture-bot' };
    const credentials = { [definition.credentialField]: 'fixture-private' };
    validateChannelConfiguration(platform, configuration);
    validateChannelCredentials(platform, credentials);
    assert.throws(() => validateChannelConfiguration(platform, { ...configuration, [definition.credentialField]: 'fixture-private' }));
    assert.throws(() => validateChannelCredentials(platform, { ...credentials, unknown: 'fixture' }));
    // SDK support for media/cards does not enable them in the independent task runtime.
    assert.deepEqual(definition.runtimeCapabilities, { text: true, attachments: false, cards: false, streaming: false });
    const adapter = officialAdapters().get(platform)({ configuration, credentials });
    assert.equal(assertChannelAdapter(adapter), adapter);
    assert.ok(['stopped', 'degraded'].includes(adapter.connectionState()));
  });
}

test('incomplete lifecycle implementations and invalid optional reconnect fail before startup', () => {
  const adapter = Object.fromEntries(['start', 'stop', 'send', 'connectionState', 'setConnectionObserver'].map(key => [key, () => {}]));
  for (const key of Object.keys(adapter)) {
    assert.throws(() => assertChannelAdapter({ ...adapter, [key]: undefined }), /CHANNEL_ADAPTER_CONTRACT_INVALID/);
  }
  assert.throws(() => assertChannelAdapter({ ...adapter, reconnect: true }), /CHANNEL_ADAPTER_CONTRACT_INVALID/);
  assert.throws(() => channelPlatform('__proto__'), /CHANNEL_PLATFORM_UNSUPPORTED/);
});

test('QQ delivery policy freezes the original reply budget, other platforms do not inherit QQ fields', () => {
  const now = 10_000_000, destination = { chatKind: 'private', replyMessageId: 'original' };
  const context = { event: { chatKind: 'private', occurredAtMs: now, receivedAtMs: now }, replySequence: 1, now };
  const reply = prepareChannelDestination('qq', destination, context);
  assert.equal(reply.sendMode, 'reply');
  assert.equal(reply.replyExpiresAt, now + 3_600_000);
  assert.equal(prepareChannelDestination('qq', destination, { ...context, replySequence: 5 }).sendMode, 'proactive');
  assert.equal(prepareChannelDestination('qq', destination, { ...context, now: now + 3_600_000 }).sendMode, 'proactive');
  for (const platform of PLATFORMS.filter(value => value !== 'qq')) {
    assert.deepEqual(prepareChannelDestination(platform, destination, context), destination);
  }
  assert.equal(destination.sendMode, undefined, 'pure preparation cannot mutate an already persisted destination');
});

test('only a Weixin reply token has platform-controlled lifetime; all other contexts retain their TTL', () => {
  const reply = { contextToken: 'fixture-private', toUserId: 'recipient' };
  assert.equal(channelContextTtl('weixin', reply, 100), undefined);
  assert.equal(channelContextTtl('weixin', { checkpoint: 'cursor' }, 100), 100);
  for (const platform of PLATFORMS.filter(value => value !== 'weixin')) assert.equal(channelContextTtl(platform, reply, 100), 100);
});
