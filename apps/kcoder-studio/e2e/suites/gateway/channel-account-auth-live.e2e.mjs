import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { FeishuAdapter } from '../../../../kcoder-channel-host/src/adapters/sdk.mjs';
import { QQAdapter } from '../../../../kcoder-channel-host/src/adapters/qq.mjs';
import { WeixinAdapter } from '../../../../kcoder-channel-host/src/adapters/weixin.mjs';
import { runE2E } from '../../harness/run-context.mjs';

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'channel-existing-account-authentication', tier: 'manual-live',
  modelPolicy: 'Read-only authentication with existing platform credentials and observed Weixin peer. No long-poll, socket subscription, platform send, task input or model call.',
}, async context => {
  assert.equal(process.env.KCODER_E2E_CHANNEL_AUTH, '1');
  const path = process.env.KCODER_E2E_CHANNEL_ENV_FILE, records = process.env.KCODER_E2E_CHANNEL_OBSERVATIONS;
  assert.ok(path && records);
  for (const file of [path, records]) {
    const info = await lstat(file);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o077) === 0);
  }
  const env = parseEnv(await readFile(path, 'utf8'));
  for (const [name, value] of Object.entries(env)) if (name.startsWith('KCODER_TEST_') && value) context.registerSecret(value);
  const observed = JSON.parse(await readFile(records, 'utf8'));
  const original = observed.inbox.map(row => JSON.parse(row.event_json)).find(event => event.platform === 'weixin');
  assert.ok(original?.senderId); context.registerSecret(original.senderId);
  assert.equal(original.botId, env.KCODER_TEST_WEIXIN_ACCOUNT_ID);
  const feishu = new FeishuAdapter({ configuration: { appId: env.KCODER_TEST_FEISHU_APP_ID }, credentials: { appSecret: env.KCODER_TEST_FEISHU_APP_SECRET } });
  const qq = new QQAdapter({ configuration: { appId: env.KCODER_TEST_QQ_APP_ID }, credentials: { appSecret: env.KCODER_TEST_QQ_APP_SECRET } });
  const weixin = new WeixinAdapter({ configuration: { accountId: env.KCODER_TEST_WEIXIN_ACCOUNT_ID, apiBase: env.KCODER_TEST_WEIXIN_API_BASE },
    credentials: { botToken: env.KCODER_TEST_WEIXIN_BOT_TOKEN } });
  const probes = [
    ['feishu', async () => { const token = await feishu.accessToken(AbortSignal.timeout(15000)); assert.ok(token); context.registerSecret(token); }],
    ['qq', async () => { const token = await qq.accessToken(AbortSignal.timeout(15000)); assert.ok(token); context.registerSecret(token); }],
    ['weixin', async () => {
      const result = await weixin.post('ilink/bot/getconfig', { ilink_user_id: original.senderId }, AbortSignal.timeout(15000));
      if (result.typing_ticket) context.registerSecret(result.typing_ticket);
      assert.equal(result.ret, 0);
    }],
  ];
  const evidence = [];
  for (const [platform, probe] of probes) {
    const started = Date.now();
    try { await probe(); evidence.push({ platform, authenticated: true, durationMs: Date.now() - started }); }
    catch (error) { evidence.push({ platform, authenticated: false, durationMs: Date.now() - started,
      code: /^[A-Z][A-Z0-9_]{1,100}$/.test(error?.code) ? error.code : error.name }); }
  }
  await context.writeArtifactJson('platform-authentication.json', { probes: evidence, platformMessages: 0, receivedMessagesConsumed: 0, modelCalls: 0 });
  assert.ok(evidence.every(row => row.authenticated), 'See redacted per-platform authentication evidence');
});
