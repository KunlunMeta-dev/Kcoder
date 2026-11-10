// Explicitly authorized live login controller. It never sends a chat message or runs a model.
import assert from 'node:assert/strict';
import { readFile, writeFile, chmod, chown } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { RunContext } from '../harness/run-context.mjs';
import { startChromium } from '../harness/chromium.mjs';

assert.equal(process.env.KCODER_LIVE_WEIXIN_UI, '1', 'Explicit live Weixin UI authorization required');
const deploymentFile = process.env.KCODER_LIVE_WEIXIN_DEPLOYMENT;
assert.ok(deploymentFile, 'Explicit deployment receipt required');
const deployment = JSON.parse(await readFile(deploymentFile, 'utf8'));
assert.equal(deployment.owner, 'kcoder-weixin');
assert.ok(deployment.uid > 0);
const stat = (await readFile(`/proc/${deployment.gatewayPid}/stat`, 'utf8')).split(') ').at(-1).split(' ');
assert.equal(Number(stat[19]), deployment.gatewayBirthTicks, 'Original Gateway process changed');
const log = await readFile(deployment.gatewayLog, 'utf8');
const origin = [...log.matchAll(/KCoder Studio: (http:\/\/127\.0\.0\.1:\d+)/g)].at(-1)?.[1];
assert.ok(origin, 'Original authenticated loopback Gateway is not ready');
const context = await RunContext.create(import.meta.url, {
  testId: 'authorized-current-linux-weixin-login-only', tier: 'manual-live',
  modelPolicy: 'Actual dedicated-owner Gateway. QR login only, no model or platform chat sends.',
});
const token = (await readFile(`${deployment.home}/.config/kcoder-studio/gateway-auth-token`, 'utf8')).trim();
context.registerSecret(token);
const chromium = await startChromium(context);
const page = await chromium.newPage({ viewport: { width: 1280, height: 960 } });
let input;
let failure;
const output = value => console.log(JSON.stringify(value));
try {
  await page.goto(`${origin}/connections`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[name="token"]').fill(token);
  await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')),
    page.locator('button[type="submit"]').click()]);
  await page.getByTestId('native-connectivity-workspace').waitFor({ timeout: 30000 });
  input = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  output({ stage: 'UI_READY', pathname: new URL(page.url()).pathname, runRoot: context.runRoot });
  for await (const line of input) {
    let command;
    try { command = JSON.parse(line).command; } catch { output({ error: 'INVALID_COMMAND' }); continue; }
    if (command === 'close') break;
    try {
      if (command === 'inspect') {
        const buttons = await page.getByRole('button').allTextContents();
        const codes = (await page.locator('code').allTextContents()).filter(value => /^[A-Z][A-Z0-9_]+$/.test(value));
        output({ stage: 'OBSERVED', buttons, codes });
      } else if (command === 'open_channels') {
        await page.getByRole('tab', { name: '通讯渠道', exact: true }).click();
        output({ stage: 'CHANNELS_SELECTED' });
      } else if (command === 'prepare_current_configuration') {
        const metadataPath = process.env.KCODER_LIVE_WEIXIN_CONNECTION;
        assert.ok(metadataPath, 'Explicit original connection metadata required');
        const original = JSON.parse(await readFile(metadataPath, 'utf8'));
        assert.equal(original.channelKind, 'weixin');
        assert.equal(original.enabled, 0);
        assert.equal(original.hasCredential, 0);
        assert.equal(original.accountId, '');
        assert.equal(original.grantCount, 0);
        const requestId = randomUUID(), operationId = randomUUID();
        const intent = { requestId, operationId, connectionId: original.id, expectedRevision: String(original.revision) };
        // A persistent exclusive intent prevents an unknown save from being replayed.
        await writeFile(`${metadataPath}.save-intent.json`, `${JSON.stringify(intent)}\n`, { flag: 'wx', mode: 0o600 });
        await context.writeArtifactJson('current-configuration-save-intent.json', intent);
        const result = await page.evaluate(async ({ workspacePath, original, requestId, operationId }) => {
          const invoke = window.__ELECTRON_INTERNALS__.invoke;
          const target = { serverId: 'local', workspacePath };
          const scope = await invoke('local_executor_request', { method: 'runtime.integrations.request',
            params: { ...target, method: 'integrations/scope/read', params: {} } });
          const observedOwner = { accountId: scope.accountId, organizationId: scope.organizationId ?? null,
            targetId: scope.targetId, workspaceId: scope.workspaceId };
          if (JSON.stringify(observedOwner) !== original.scope) throw new Error('ORIGINAL_CONNECTION_OWNER_CHANGED');
          const response = await invoke('local_executor_request', { method: 'runtime.integrations.request', params: {
            ...target, method: 'integrations/connectivity/prepareConnectionAction', params: {
              contractVersion: 'parallel-v1', requestId, scope, operationId,
              expectedRevision: String(original.revision), timeoutMs: 30000,
              payload: { action: 'save', connectionId: original.id, kind: 'weixin', label: original.label,
                configuration: { accountId: '' }, resourceGrants: [] },
            },
          } });
          return { status: response.status, code: response.error?.code ?? null,
            operationId: response.operationId, revision: response.entityRevision,
            connection: response.result ? { id: response.result.id, revision: response.result.revision,
              kind: response.result.kind, enabled: response.result.enabled,
              hasCredential: response.result.hasCredential, state: response.result.state } : null };
        }, { workspacePath: deployment.workspace, original, requestId, operationId });
        await context.writeArtifactJson('current-configuration-save-result.json', result);
        output({ stage: 'CURRENT_CONFIGURATION_SAVE_OBSERVED', ...result });
        if (result.status === 'completed') {
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.getByTestId('native-connectivity-workspace').waitFor({ timeout: 30000 });
        }
      } else if (command === 'create_qr') {
        await page.getByRole('tab', { name: '通讯渠道', exact: true }).click();
        const label = '微信（当前 Linux）';
        const article = page.locator('article').filter({ has: page.getByRole('heading', { name: label, exact: true }) });
        if (process.env.KCODER_LIVE_WEIXIN_CONNECTION) {
          await article.waitFor({ timeout: 30000 });
        } else if (!await article.count()) {
          await page.getByTestId('application-configuration-catalog').getByRole('button', { name: '微信 / Weixin', exact: true }).click();
          await page.getByLabel('连接名称', { exact: true }).fill(label);
          await page.getByRole('button', { name: '保存配置', exact: true }).click();
          await article.waitFor({ timeout: 30000 });
        }
        await article.getByRole('button', { name: '授权或更新私有凭证', exact: true }).click();
        const qr = page.getByTestId('weixin-qr-authorization');
        await qr.waitFor({ timeout: 30000 });
        await qr.getByRole('button', { name: '获取授权二维码', exact: true }).click();
        await qr.locator('svg, img').first().waitFor({ timeout: 45000 });
        const destination = `${deployment.home}/.config/kcoder-studio/weixin-login-qr.png`;
        await qr.locator('svg, img').first().screenshot({ path: destination });
        await chmod(destination, 0o600); await chown(destination, deployment.uid, deployment.gid);
        output({ stage: 'QR_READY', path: destination, status: await qr.getByRole('status').allTextContents() });
      } else if (command === 'poll' || command === 'read') {
        const qr = page.getByTestId('weixin-qr-authorization');
        await qr.getByRole('button', { name: command === 'poll' ? '核对扫码状态' : '读取原回执', exact: true }).click();
        await page.waitForTimeout(1000);
        output({ stage: 'ORIGINAL_AUTHORIZATION_STATUS', status: await qr.getByRole('status').allTextContents(),
          codes: (await qr.locator('code').allTextContents()).filter(value => /^[A-Z][A-Z0-9_]+$/.test(value)) });
      } else output({ error: 'UNSUPPORTED_COMMAND' });
    } catch (error) {
      const codes = (await page.locator('code').allTextContents()).filter(value => /^[A-Z][A-Z0-9_]+$/.test(value));
      const text = context.redactText(String(error.message)).replaceAll(origin, '<owned-gateway>');
      output({ stage: 'ACTION_UNCONFIRMED', command, codes, error: text.slice(0, 800) });
    }
  }
} catch (error) {
  failure = error;
  output({ stage: 'CONTROLLER_FAILED', error: context.redactText(String(error.message)).slice(0, 800) });
} finally {
  input?.close();
  await context.finish(failure ? 'failed' : 'passed', { loginControllerOnly: true, modelCalls: 0, chatSends: 0 }, failure);
}
