import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { FeishuAdapter } from '../../../../kcoder-channel-host/src/adapters/sdk.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'feishu-official-sdk-connect-send-readback', tier: 'manual-live',
  modelPolicy: 'Real official SDK connection and one authorized private-chat send/readback. No model or Native inbound execution claim.',
}, async context => {
  assert.equal(process.env.KCODER_E2E_LIVE_FEISHU, '1');
  assert.equal(process.env.KCODER_E2E_FEISHU_SEND_MESSAGE, '1');
  const routeFile = process.env.KCODER_E2E_FEISHU_ROUTE_FILE;
  const receiptFile = process.env.KCODER_E2E_FEISHU_SEND_RECEIPT;
  assert.ok(routeFile && receiptFile);
  const info = await lstat(routeFile);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o077) === 0);
  const route = JSON.parse(await readFile(routeFile, 'utf8'));
  assert.equal(route.source, 'kcoder-existing-single-private-chat');
  assert.match(route.chatId, /^oc_[a-zA-Z0-9]+$/);
  assert.match(route.sourceMessageId, /^om_[a-zA-Z0-9]+$/);
  const env = parseEnv(await readFile(process.env.KCODER_E2E_FEISHU_ENV_FILE || `${repoRoot}/.env`, 'utf8'));
  const appId = env.KCODER_TEST_FEISHU_APP_ID, appSecret = env.KCODER_TEST_FEISHU_APP_SECRET;
  assert.ok(appId && appSecret);
  assert.equal(route.appId, appId);
  for (const value of [appSecret, route.chatId, route.recipientOpenId]) context.registerSecret(value);
  const require = createRequire(new URL('../../../../kcoder-channel-host/package.json', import.meta.url));
  const sdk = require('@larksuiteoapi/node-sdk');
  const logger = Object.fromEntries(['error', 'warn', 'info', 'debug', 'trace'].map(name => [name, () => {}]));
  const client = new sdk.Client({ appId, appSecret, logger });
  // Verify the original bot-accessible private route before any new external send.
  const original = await client.im.message.get({ path: { message_id: route.sourceMessageId } });
  assert.equal(original.code, 0);
  assert.ok(original.data?.items?.some(item => item.message_id === route.sourceMessageId && item.chat_id === route.chatId));
  const checkpointFile = context.pathInState('feishu-feedback.json');
  const checkpoint = {
    load: () => readFile(checkpointFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; }),
    save: async value => {
      await writeFile(`${checkpointFile}.pending`, value, { mode: 0o600 });
      await rename(`${checkpointFile}.pending`, checkpointFile);
    },
  };
  const adapter = new FeishuAdapter({ configuration: { appId }, credentials: { appSecret }, checkpoint });
  context.addCleanup('close this run official Feishu SDK connection', () => adapter.stop());
  let incomingEvents = 0;
  await adapter.start(async () => { incomingEvents++; }, { signal: AbortSignal.timeout(15000) });
  assert.equal(adapter.connectionState(), 'connected');
  const deliveryId = randomUUID();
  const marker = `KCoder macOS SDK ${deliveryId.slice(0, 8)}`;
  const intent = { deliveryId, marker, phase: 'recorded-before-send' };
  await writeFile(receiptFile, JSON.stringify(intent) + '\n', { mode: 0o600, flag: 'wx' });
  const sent = await client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: {
    receive_id: route.chatId, msg_type: 'text', content: JSON.stringify({ text: marker }), uuid: deliveryId,
  } });
  assert.equal(sent.code, 0);
  assert.match(sent.data?.message_id ?? '', /^om_/);
  await writeFile(receiptFile, JSON.stringify({ ...intent, phase: 'platform-accepted', messageId: sent.data.message_id }) + '\n', { mode: 0o600 });
  const observed = await client.im.message.get({ path: { message_id: sent.data.message_id } });
  assert.equal(observed.code, 0);
  assert.ok(observed.data?.items?.some(item => item.message_id === sent.data.message_id
    && item.chat_id === route.chatId && JSON.parse(item.body.content).text === marker));
  const proof = { platform: process.platform, sdkConnected: true, sendAccepted: true, readBack: true,
    messageId: sent.data.message_id, deliveryId, marker, incomingEvents,
    nativeInboundExecutionTested: false, modelCalls: 0 };
  await writeFile(receiptFile, JSON.stringify({ ...proof, phase: 'verified' }) + '\n', { mode: 0o600 });
  await context.writeArtifactJson('official-sdk-proof.json', proof);
  return proof;
});
