import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startProtocolStreamFixture } from '../../harness/protocol-stream-fixture.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'three-protocol-studio-thinking-tools-and-eof', tier: 'full-integration',
  modelPolicy: 'model-independent real Studio projection of fixed protocol streams and one actual tool execution',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'protocol-ui' });
  const fixture = await startProtocolStreamFixture(context);
  const chromium = await startChromium(context);
  const results = [];
  for (const apiFormat of ['anthropic_messages', 'openai_chat_completions', 'openai_responses']) {
    const home = context.pathInState(apiFormat);
    const key = 'protocol-ui-only'; context.registerSecret(key);
    await context.writeStateJson(`${apiFormat}/credentials.json`, { fixture: { type: 'api', key } });
    await context.writeStateJson(`${apiFormat}/settings.json`, {
      active_provider: 'fixture', max_retries: 0, permission_mode: 'yolo',
      providers: { fixture: { api_format: apiFormat,
        endpoint: apiFormat === 'anthropic_messages' ? fixture.baseUrl.replace(/\/v1$/, '') : fixture.baseUrl,
        ...(apiFormat === 'openai_chat_completions' ? { chat_protocol: 'minimax' } : {}),
        default_model: 'fixture-model', no_proxy: true, context_window_tokens: 128000,
        max_output_tokens: 1024, output_headroom_tokens: 1024 } },
    });
    const serversFile = await context.writeStateJson(`${apiFormat}-servers.json`, [{
      id: 'local', label: 'Protocol UI', transport: 'local', command: resolve(repoRoot, 'target/debug/kcoder'), workspace,
    }]);
    const gateway = await startGateway(context, { label: apiFormat, workspace, serversFile, auth: true,
      env: { KCODER_CONFIG_DIR: home, KCODER_MAX_RETRIES: '0' } });
    const page = await chromium.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.goto(gateway.baseUrl);
      await page.locator('input[name="token"]').fill(gateway.authToken);
      await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
      await page.getByTestId('desktop-sidebar').waitFor({ timeout: 60000 });
      const project = page.getByTestId('project-item').filter({ hasText: 'Protocol UI' }).first();
      for (const mode of ['complete', 'eof', 'tool', 'no_thinking']) {
        const before = fixture.requests.length;
        const countBefore = await readFile(resolve(workspace, 'protocol-tool-count.txt'), 'utf8').catch(() => '');
        await project.hover();
        await project.getByTestId('project-new-conversation-button').click();
        await page.getByTestId('chat-message-input').click();
        await page.keyboard.insertText(`FIXTURE_${mode.toUpperCase()}`);
        await page.getByTestId('send-message-button').click();
        await page.getByText('TEXT_TAIL', { exact: true }).waitFor({ timeout: 30000 });
        if (mode === 'eof') await page.getByTestId('assistant-error-card').waitFor({ timeout: 30000 });
        await waitFor(async () => await page.getByTestId('assistant-thinking-spinner').count() === 0, 30000, 'thinking terminal state');
        if (mode === 'no_thinking') {
          assert.equal(await page.getByTestId('assistant-thinking-details').count(), 0);
        } else {
        const processing = page.getByTestId('final-processing-toggle');
        const toggle = page.getByTestId('assistant-thinking-toggle');
        await waitFor(async () => {
          if (await toggle.isVisible()) return true;
          if (await processing.isVisible() && await processing.getAttribute('aria-expanded') !== 'true') await processing.click();
          return false;
        }, 30000, 'expand settled processing details');
        if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
        assert.equal(await page.getByTestId('assistant-thinking-content').innerText(), 'THINK_TAIL');
        }
        assert.equal(await page.getByText('TEXT_TAIL', { exact: true }).count(), 1);
        assert.equal(await page.getByTestId('assistant-error-card').count(), mode === 'eof' ? 1 : 0);
        assert.equal(await readFile(resolve(workspace, 'protocol-tool-count.txt'), 'utf8').catch(() => ''), countBefore + (mode === 'tool' ? 'x' : ''));
        assert.equal(fixture.requests.length - before, mode === 'tool' ? 2 : 1);
        results.push({ apiFormat, mode, visibleThinking: true, preservedText: true });
      }
    } catch (error) {
      await page.screenshot({ path: context.pathInArtifacts(`${apiFormat}-failure.png`) }).catch(() => {});
      throw error;
    } finally { await page.close(); }
    await context.stopOwned(apiFormat);
  }
  return { results, requests: fixture.requests.length };
});
