import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createChannelsController } from '../../../src/channels-controller.mjs';
import { channelTaskFixture } from '../../harness/channel-task-runtime.mjs';
import { requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'independent-channel-original-task', tier: 'full-integration',
  modelPolicy: 'Real app-server and Gateway broker, portable channel state, controlled SDK event/receipt and fixed local provider. No real platform or model acceptance claim.',
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'candidate app-server');
  const fixture = await channelTaskFixture(context, binary);
  const probe = fixture.client(), rejected = [];
  const receive = probe.receive.bind(probe);
  probe.receive = message => { if (message.error) rejected.push(message.error.code); receive(message); };
  const retiredCapabilities = ['connectivityCredentialInputV1', 'connectivityWeixinQrV1',
    'connectivityFeishuRegistrationV1', 'connectivityChannelDraftV1',
    'nativeChannelServicesV1', 'nativeChannelServiceObservationsV1'];
  const initialized = await probe.request('initialize', { protocolVersion: '2026-07-27',
    clientInfo: { name: 'retired-channel-credential-probe', version: '1' }, capabilities: { experimental: {
      gatewaySharedThreadsV1: true, ...Object.fromEntries(retiredCapabilities.map(name => [name, true])),
    } } });
  for (const name of retiredCapabilities) assert.equal(Object.hasOwn(initialized.capabilities.experimental, name), false);
  for (const method of ['credentials/prepare', 'credentials/set', 'credentials/readState', 'credentials/revoke',
    'weixinQr', 'feishuRegistration']) {
    await assert.rejects(probe.request(`integrations/connectivity/${method}`, {}));
    assert.equal(rejected.at(-1), -32601, 'retired calls have no execution or authorization path');
  }
  for (const method of ['capabilities', 'prepare', 'read', 'current', 'start', 'stop', 'renew', 'revoke']) {
    await assert.rejects(probe.request(`integrations/services/channel/${method}`, {}));
    assert.equal(rejected.at(-1), -32601, 'channel service grants have no execution or authorization path');
  }
  probe.close();
  const evidence = [];
  for (const platform of ['feishu', 'qq', 'weixin']) {
    const thread = await fixture.createPersistedTask();
    const taskClient = fixture.client(), sends = []; let ingest;
    const settingsDirectory = context.pathInState(`studio-${platform}`);
    const controller = createChannelsController({ directory: context.pathInState(`studio-${platform}/channels`), settingsDirectory,
      selectBroker: async target => { assert.equal(target.threadId, thread.id); return { broker: fixture.broker }; },
      workerFactory: () => ({
        start: async receive => { ingest = receive; }, stop: async () => {}, connectionState: () => 'connected',
        send: async (payload, options) => { sends.push({ payload, options }); return { state: 'accepted', messageId: 'controlled-sdk-receipt' }; },
      }),
    });
    const { runtime } = controller;
    const clientsBeforeDescription = fixture.broker.clients.size;
    const description = await controller.describeTarget({ serverId: 'fixture-target', workspacePath: fixture.workspace, threadId: thread.id });
    assert.ok(description.title === null || typeof description.title === 'string');
    assert.equal(fixture.broker.clients.size, clientsBeforeDescription, 'reading a binding title does not retain a task attachment');
    assert.equal(runtime.store.settingsFile.path, join(settingsDirectory, 'settings.json'));
    assert.deepEqual(runtime.store.settings(), { mirrorClientTurns: false, toolRestrictions: {
      enabled: true,
      disabledTools: ['AskUserQuestion', 'AskUserQuestionAsync', 'EnterPlanMode', 'ExitPlanMode', 'ask_user_question'],
    } });
    context.addCleanup('close owned independent channel runtime', () => controller.close());
    runtime.store.saveConnection({ id: `fixture-${platform}`, label: 'Controlled SDK', platform },
      { [platform === 'weixin' ? 'botToken' : 'appSecret']: 'channel-fixture-private-value' });
    context.registerSecret('channel-fixture-private-value');
    const event = { platform, botId: 'fixture-bot', tenantId: 'fixture-tenant',
      conversationId: 'fixture-chat', chatKind: 'private', senderId: 'fixture-user', eventId: 'old', text: 'old input' };
    const known = runtime.store.receive(`fixture-${platform}`, event, { historical: true });
    runtime.bind(known.chatId, { serverId: 'fixture-target', workspacePath: fixture.workspace, threadId: thread.id });
    await runtime.connect(`fixture-${platform}`);
    await controller.bindingChanged();
    await taskClient.attachTask(thread.id);
    const disabledMessageId = `web-disabled-${platform}`;
    await taskClient.request('turn/start', { threadId: thread.id, clientMessageId: disabledMessageId,
      input: [{ type: 'text', text: 'UNSYNCED_ORDINARY_WEB_INPUT' }] });
    await waitFor(async () => (await taskClient.request('turn/receipt/read', {
      threadId: thread.id, clientMessageId: disabledMessageId,
    })).receipt?.status === 'completed', 60000, 'ordinary turn completes with client sync disabled');
    assert.equal(sends.length, 0);
    assert.equal(runtime.store.waitingTaskOutputs().length, 0);
    // Explicit opt-in applies equally to every platform's ordinary client mirror.
    runtime.store.setSettings({ mirrorClientTurns: true });
    await controller.bindingChanged();
    await taskClient.request('turn/start', { threadId: thread.id, clientMessageId: `web-${platform}`,
      input: [{ type: 'text', text: 'NEW_ORDINARY_WEB_INPUT' }] });
    taskClient.close();
    await waitFor(() => sends.length === 2, 60000, 'original web input and response mirrored after browser disconnect');
    assert.deepEqual(sends.map(send => send.payload.content.text), ['NEW_ORDINARY_WEB_INPUT', 'CHANNEL_FIXTURE_RESULT']);
    runtime.store.setSettings({ mirrorClientTurns: false });
    await controller.bindingChanged();
    const receipt = ingest({ ...event, eventId: 'new', text: 'NEW_CONTROLLED_PLATFORM_INPUT' });
    await waitFor(() => {
      const input = runtime.store.inbox(receipt.inputId);
      if (['unknown', 'failed'].includes(input?.state)) throw new Error(input.result?.code ?? 'Channel input failed');
      return input?.state === 'completed';
    }, 60000, 'original task execution');
    await waitFor(() => runtime.store.output(`reply-${receipt.inputId}`)?.state === 'accepted', 10000, 'controlled SDK receipt');
    assert.equal(sends.length, 3, 'the platform turn must not be echoed a second time by the web mirror');
    assert.equal(sends[2].payload.content.text, 'CHANNEL_FIXTURE_RESULT');
    assert.equal(runtime.store.inbox(known.id).state, 'historical');
    assert.equal(ingest({ ...event, eventId: 'new', text: 'NEW_CONTROLLED_PLATFORM_INPUT' }).duplicate, true);
    const reader = fixture.client(); await reader.initialize();
    const history = await reader.request('thread/read', { threadId: thread.id, limit: 100 }); reader.close();
    assert.equal(history.messages.filter(message => message.role === 'user' && message.content.includes('NEW_CONTROLLED_PLATFORM_INPUT')).length, 1);
    assert.equal(fixture.model.requests.length, (evidence.length + 1) * 4);
    const tools = fixture.model.requests.at(-1).tools?.map(tool => tool.function?.name) ?? [];
    for (const name of ['AskUserQuestion', 'AskUserQuestionAsync']) {
      assert.ok(tools.includes(name), 'channel restrictions do not hide supported question tools');
    }
    assert.equal(fixture.broker.serverRequests.size, 0);
    runtime.unbind(known.chatId); await controller.bindingChanged();
    assert.equal(fixture.broker.clients.size, 0, 'unbinding releases only the channel manager attachment');
    evidence.push({ platform, originalTask: true, creatorDisconnected: true, controlledSdkReceipts: sends.length,
      webInputAndResponseMirrored: true, bindingOwnerReleased: true,
      historicalInputsReplayed: 0, duplicateInputReplayed: false });
  }
  await context.writeArtifactJson('acceptance.json', { cases: evidence, channelNativeGrants: 0,
    fixedProviderRequests: fixture.model.requests.length, retiredRpcCount: rejected.length, realPlatformMessages: 0 });
});
