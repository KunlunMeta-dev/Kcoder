import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'provider-configuration-file-sources', tier: 'full-integration',
  modelPolicy: 'model-independent real layered configuration, UI save, and HTTP request parameters',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  const model = await startApprovalModelFixture(context, { textOnly: true });
  const config = context.pathInState('config');
  await context.writeStateJson('config/settings.json', { active_provider: 'fixture', providers: { fixture: {
    api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl,
    default_model: 'source-model', no_proxy: true, context_window_tokens: 128000,
    max_output_tokens: 1024, output_headroom_tokens: 1024, extra_body: { temperature: 0.2 },
  } } });
  await mkdir(join(workspace, '.kcoder'), { recursive: true });
  await writeFile(join(workspace, '.kcoder/settings.json'), JSON.stringify({ provider_extra_body: { temperature: 0.9 } }));
  const gateway = await startGateway(context, { workspace, auth: true, env: { KCODER_CONFIG_DIR: config } });
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  try {
    await page.goto(gateway.baseUrl);
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
    await page.goto(`${gateway.baseUrl}/settings/personal/models`);
    await page.getByTestId('provider-edit-fixture::source-model').click();
    assert.match(await page.getByTestId('provider-file-sources').innerText(), /项目配置/);
    await page.getByTestId('provider-extra-body').fill('{"temperature":0.7}');
    await page.getByTestId('provider-save').click();
    await waitFor(async () => (await page.locator('[role="status"]').allTextContents()).some(text => text.includes('部分字段仍由更高优先级配置覆盖')), 30000, 'save acknowledges override');
    await page.getByTestId('provider-file-sources').scrollIntoViewIfNeeded();
    await page.screenshot({ path: context.pathInArtifacts('file-sources.png') });
    const saved = JSON.parse(await readFile(join(config, 'settings.json'), 'utf8'));
    assert.equal(saved.providers.fixture.models['source-model'].extra_body.temperature, 0.7);
    const cookie = (await page.context().cookies()).map(value => `${value.name}=${value.value}`).join('; ');
    context.registerSecret(cookie);
    const token = await waitForGatewayRpcToken(context, gateway, { headers: { cookie } });
    const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', token), { headers: { cookie, Origin: gateway.baseUrl } });
    context.addCleanup('close source verification RPC', () => rpc.close());
    await initializeRpc(rpc, 'model-sources');
    const { thread } = await rpc.request('thread/start');
    const { turn } = await rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'SOURCE_SCOPE_REQUEST' }] });
    const completed = await rpc.waitFor(message => message.method === 'turn/completed' && message.params?.threadId === thread.id && message.params?.turnId === turn.id, 30000, 'source request');
    assert.equal(completed.params.turn.status, 'completed');
    const request = model.requests.find(body => JSON.stringify(body.messages).includes('SOURCE_SCOPE_REQUEST'));
    assert.equal(request.temperature, 0.9);
    await writeFile(join(workspace, '.kcoder/settings.json'), JSON.stringify({
      provider_extra_body: { temperature: 0.9 },
      providers: { fixture: { default_model: 'project-model', models: { 'project-model': {
        context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 1024,
      } } } },
    }));
    await page.getByTestId('provider-refresh').click();
    await page.getByTestId('provider-source-unavailable').waitFor();
    await page.getByTestId('provider-save').click();
    await waitFor(async () => (await page.locator('[role="status"]').allTextContents()).some(text => text.includes('尚不能用于新轮次')), 30000, 'save reports removed effective model');

    return { savedUserTemperature: 0.7, actualTemperature: 0.9, sourceVisible: true, misleadingSuccessAvoided: true, overriddenModelUnavailable: true };
  } finally { await page.close(); }
});
