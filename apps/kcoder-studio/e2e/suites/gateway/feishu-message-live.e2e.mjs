import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { FeishuAdapter } from '../../../../kcoder-channel-host/src/adapters/sdk.mjs';
import { runE2E, repoRoot } from '../../harness/run-context.mjs';

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'feishu-official-single-real-message', tier: 'manual-live',
  modelPolicy: 'Explicit one-message send to the verified existing private chat through the real product REST adapter. No model or Native outbox claim.',
}, async context => {
  assert.equal(process.env.KCODER_E2E_LIVE_FEISHU, '1');
  assert.equal(process.env.KCODER_E2E_FEISHU_SEND_MESSAGE, '1', 'Explicit real-send authorization required');
  const routePath = process.env.KCODER_E2E_FEISHU_ROUTE_FILE;
  const receiptPath = process.env.KCODER_E2E_FEISHU_SEND_RECEIPT;
  assert.ok(routePath && receiptPath, 'Private verified route and durable original-send locator required');
  const info = await lstat(routePath);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o077) === 0);
  const route = JSON.parse(await readFile(routePath, 'utf8'));
  assert.equal(route.source, 'octop-existing-single-private-chat');
  assert.match(route.chatId, /^oc_[a-zA-Z0-9]+$/);
  assert.match(route.recipientOpenId, /^ou_[a-zA-Z0-9]+$/);
  const values = new Map((await readFile(`${repoRoot}/.env`, 'utf8')).split(/\r?\n/)
    .filter(line => /^[A-Z][A-Z0-9_]*=/.test(line)).map(line => {
      const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).replace(/^['"]|['"]$/g, '')];
    }));
  const appId = values.get('KCODER_TEST_FEISHU_APP_ID'), appSecret = values.get('KCODER_TEST_FEISHU_APP_SECRET');
  assert.ok(appId && appSecret); assert.equal(route.appId, appId);
  for (const secret of [appSecret, route.chatId, route.recipientOpenId]) context.registerSecret(secret);
  const deliveryId = randomUUID();
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()).replaceAll('-', '');
  const marker = `KC-FS-${date}-${deliveryId.slice(0, 8)}`;
  const text = `KCoder 飞书消息测试\n这是一条通过你现有飞书应用发送的真实测试消息。\n测试编号：${marker}`;
  // The exclusive durable locator precedes any external send. Unknown never replays.
  await writeFile(receiptPath, JSON.stringify({ phase: 'original-send-recorded', deliveryId, marker,
    receiverSha256: createHash('sha256').update(route.chatId).digest('hex'), text }) + '\n', { mode: 0o600, flag: 'wx' });
  const adapter = new FeishuAdapter({ configuration: { appId }, credentials: { appSecret } });
  context.addCleanup('close owned Feishu REST probe', () => adapter.stop());
  const receipt = await adapter.send({ destination: { conversationId: route.chatId }, content: { text } },
    { deliveryId, signal: AbortSignal.timeout(15000) });
  await writeFile(receiptPath, JSON.stringify({ phase: 'platform-reply-received', deliveryId, marker,
    receipt, receiverSha256: createHash('sha256').update(route.chatId).digest('hex'), text }) + '\n', { mode: 0o600 });
  assert.equal(receipt.state, 'accepted'); assert.match(receipt.messageId, /^om_/);
  let readBack = false;
  const token = await adapter.accessToken(AbortSignal.timeout(10000)); context.registerSecret(token);
  const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(receipt.messageId)}`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
  const observed = await response.json();
  if (observed.code === 0) {
    const item = observed.data?.items?.find(item => item.message_id === receipt.messageId);
    readBack = !!item && item.chat_id === route.chatId && JSON.parse(item.body.content).text === text;
  }
  const proof = { realMessageSent: true, officialAdapter: true, marker, messageId: receipt.messageId,
    readBack, platformReadCode: observed.code, nativeOutboxTested: false, humanReadConfirmed: false, modelCalls: 0 };
  await context.writeArtifactJson('feishu-message-proof.json', proof);
  await writeFile(receiptPath, JSON.stringify({ phase: 'accepted', deliveryId, ...proof,
    receiverSha256: createHash('sha256').update(route.chatId).digest('hex'), text }) + '\n', { mode: 0o600 });
  return proof;
});
