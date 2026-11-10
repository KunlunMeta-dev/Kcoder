import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, open } from 'node:fs/promises';
import { officialAdapters } from '../../../../kcoder-channel-host/src/adapters/index.mjs';
import { platformJson } from '../../../../kcoder-channel-host/src/transport.mjs';
import { importChannels } from '../../../../kcoder-channel-host/src/channels/migration.mjs';
import { createChannelsController } from '../../../src/channels-controller.mjs';
import { channelTaskFixture } from '../../harness/channel-task-runtime.mjs';
import { requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'three-platform-existing-context-background-task-forward', tier: 'manual-live',
  modelPolicy: 'Real isolated app-server and Gateway controller, fixed local provider, controlled ingress and at most one real SDK send per Feishu/QQ/Weixin account. Existing authenticated routes only; no receive-loop, user action, historical replay or live-model claim.',
}, async context => {
  assert.equal(process.env.KCODER_E2E_CHANNEL_SEND, '1');
  const inputs = [process.env.KCODER_E2E_CHANNEL_IMPORT_FILE, process.env.KCODER_E2E_CHANNEL_CONTEXT_FILE];
  for (const file of inputs) {
    assert.ok(file);
    const info = await lstat(file);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && !(info.mode & 0o077));
  }
  const bundle = JSON.parse(await readFile(inputs[0], 'utf8'));
  const allContexts = JSON.parse(await readFile(inputs[1], 'utf8'));
  const marker = `KCoder 独立通道后台转发验证 ${randomUUID().slice(0, 8)}`;
  const platforms = (process.env.KCODER_E2E_CHANNEL_PLATFORMS ?? 'feishu,qq,weixin').split(',');
  assert.ok(platforms.length && new Set(platforms).size === platforms.length
    && platforms.every(platform => ['feishu', 'qq', 'weixin'].includes(platform)));
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'candidate app-server');
  const fixture = await channelTaskFixture(context, binary, { responseText: marker });
  const intentFile = process.env.KCODER_E2E_CHANNEL_SEND_RECEIPT;
  assert.ok(intentFile);
  // Exclusive durable receipt prevents accidental reuse of this original send attempt.
  const journal = await open(intentFile, 'wx', 0o600);
  context.addCleanup('close original platform-send journal', () => journal.close());
  const record = async value => { await journal.writeFile(JSON.stringify(value) + '\n'); await journal.sync(); };
  const evidence = [];
  for (const platform of platforms) {
    const row = bundle.connections.find(connection => connection.platform === platform);
    assert.ok(row, `Existing ${platform} account required`);
    const contexts = allContexts.filter(item => item.connectionId === row.id && item.value);
    for (const value of Object.values(row.credentials)) if (typeof value === 'string') context.registerSecret(value);
    for (const item of contexts) for (const value of Object.values(item.value))
      if (typeof value === 'string' && value.length >= 8) context.registerSecret(value);
    const original = row.chats.map(chat => chat.event).sort((a, b) =>
      (b.receivedAtMs ?? b.occurredAtMs ?? 0) - (a.receivedAtMs ?? a.occurredAtMs ?? 0))[0];
    assert.ok(original?.conversationId && original.eventId, `Existing ${platform} route required`);
    context.registerSecret(original.conversationId); context.registerSecret(original.senderId);
    if (platform === 'weixin') assert.ok(original.replyRef && contexts.some(item => item.reference === original.replyRef));
    const thread = await fixture.createPersistedTask();
    let ingest, sends = 0, platformReply;
    // Do not create a second live listener or consume the deployed account's inbound messages.
    const controller = createChannelsController({ directory: context.pathInState(`channels-${platform}`),
      selectBroker: async target => { assert.equal(target.threadId, thread.id); return { broker: fixture.broker }; },
      workerFactory: (connection, credentials) => {
        const adapter = officialAdapters().get(platform)({ configuration: connection.configuration, credentials,
          transport: async (url, options) => {
            const data = await platformJson(url, options);
            if (platform === 'weixin' && new URL(url).pathname.endsWith('/sendmessage')) {
              platformReply = { ret: Number.isSafeInteger(data?.ret) ? data.ret : null,
                errcode: Number.isSafeInteger(data?.errcode) ? data.errcode : null,
                prepareFailed: data?.errmsg === 'prepare failed' };
            }
            return data;
          },
          secretStore: { get: async id => runtime.store.context(connection.id, id) } });
        return { start: async receive => { ingest = receive; }, stop: () => adapter.stop(), connectionState: () => 'connected',
          send: (payload, options) => { sends++; return adapter.send(payload, { ...options, signal: AbortSignal.timeout(15000) }); } };
      },
    });
    const { runtime } = controller;
    context.addCleanup(`close isolated ${platform} channel manager`, () => controller.close());
    importChannels(runtime.store, { version: 1, connections: [{ ...row, chats: [], contexts: contexts.map(item => ({
      id: item.reference, value: item.value, expiresAtMs: item.expiresAtMs,
    })) }] });
    // Observe the authenticated route without re-enqueuing its historical input.
    const chat = runtime.store.observeChat(row.id, original);
    const target = { serverId: 'fixture-target', workspacePath: fixture.workspace, threadId: thread.id };
    await controller.validateTarget(target);
    runtime.bind(chat.id, target); await controller.bindingChanged();
    await runtime.connect(row.id);
    await record({ platform, marker, phase: 'recorded-before-controlled-ingress' });
    // Preserve the real reply identity and timestamp, especially QQ's finite passive-reply window.
    const event = { ...original, sourceMessageId: original.sourceMessageId ?? original.eventId,
      eventId: `controlled-${randomUUID()}`, text: 'CONTROLLED_BACKGROUND_FORWARD_CHECK' };
    const received = ingest(event);
    await waitFor(() => {
      const input = runtime.store.inbox(received.inputId);
      if (['unknown', 'failed'].includes(input?.state)) throw new Error(input.result?.code ?? 'CHANNEL_INPUT_FAILED');
      return input?.state === 'completed';
    }, 60000, `${platform} isolated original-task completion`);
    await waitFor(() => ['accepted', 'failed', 'unknown'].includes(runtime.store.output(`reply-${received.inputId}`)?.state), 20000, `${platform} SDK receipt`);
    const sent = runtime.store.output(`reply-${received.inputId}`);
    assert.equal(ingest(event).duplicate, true);
    assert.equal(sends, 1, 'Duplicate input must not cause a second external send');
    runtime.unbind(chat.id); await controller.bindingChanged();
    assert.equal(fixture.broker.clients.size, 0, 'Only the background manager retained the original task');
    const proof = { platform, marker, state: sent.state, code: sent.receipt?.code,
      ...(platformReply ? { platformReply } : {}),
      realAppServer: true, backgroundBinding: true, creatorDisconnected: true, taskCompleted: true,
      controlledIngress: true, platformReceiveLoopStarted: false, historicalInputsReplayed: 0,
      sdkSendAttempts: sends, userActionRequired: false };
    evidence.push(proof); await record(proof);
  }
  assert.equal(fixture.model.requests.length, platforms.length * 2, 'Only the seed and one controlled turn per original task');
  await context.writeArtifactJson('background-forward.json', { cases: evidence,
    fixedProviderCalls: fixture.model.requests.length, allPlatformsAccepted: evidence.every(row => row.state === 'accepted') });
  assert.ok(evidence.every(row => row.state === 'accepted'), 'See per-platform receipts; an expired QQ context or unknown send is not a delivery pass');
});
