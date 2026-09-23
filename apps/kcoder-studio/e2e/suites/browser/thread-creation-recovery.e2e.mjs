import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await runE2E(import.meta.url, {
  testId: 'renderer-recovers-creation-without-repeating-startup', tier: 'full-integration',
  modelPolicy: 'loopback response; real startup hook and disconnect before creation reply',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'creation' });
  const model = await startApprovalModelFixture(context, { textOnly: true, textOnlyResponse: 'CREATION_RECOVERED' });
  const config = context.pathInState('config');
  await context.writeStateJson('config/settings.json', { active_provider: 'fixture', max_retries: 0,
    hooks: { SessionStart: [{ hooks: [{ type: 'command', shell: 'sh', timeout: 5,
      command: 'sleep 1; printf x >> creation-startup-count.txt' }] }] },
    providers: { fixture: { api_format: 'openai_chat_completions', endpoint: model.baseUrl,
      default_model: 'fixture-model', context_window_tokens: 64000, output_headroom_tokens: 1024,
      max_output_tokens: 1024, no_proxy: true } } });
  const key = 'synthetic-creation-receipt'; context.registerSecret(key);
  await context.writeStateJson('config/credentials.json', { fixture: { type: 'api', key } });
  const binary = resolve(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'));
  const gateway = await startGateway(context, { workspace, kcoderBin: binary, env: { KCODER_CONFIG_DIR: config } });
  await waitForGatewayRpcToken(context, gateway);
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(() => {
    const Original = window.WebSocket;
    const probe = window.__creationProbe = { starts: 0, queries: 0, cut: false };
    window.WebSocket = class extends Original {
      send(data) {
        let request; try { request = JSON.parse(data); } catch { return super.send(data); }
        if (request.method === 'thread/creation/read') probe.queries += 1;
        const result = super.send(data);
        if (request.method === 'thread/start' && ++probe.starts === 1) {
          probe.cut = true;
          setTimeout(() => this.close(), 50);
        }
        return result;
      }
    };
  });
  await page.goto(`${gateway.baseUrl}/?e2e=1`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('chat-message-input').waitFor({ timeout: 30000 });
  await page.getByTestId('chat-message-input').click();
  await page.keyboard.insertText('CREATE_ONCE');
  await page.getByTestId('send-message-button').click();
  await page.getByText('CREATION_RECOVERED', { exact: true }).waitFor({ timeout: 30000 });
  const probe = await page.evaluate(() => window.__creationProbe);
  assert.deepEqual(probe, { starts: 1, queries: 1, cut: true });
  assert.equal(await readFile(resolve(workspace, 'creation-startup-count.txt'), 'utf8'), 'x');
  assert.equal(model.requests.length, 1);
  await page.screenshot({ path: context.pathInArtifacts('creation-recovered.png') });
  return { threadStarts: 1, creationQueries: 1, startupHookExecutions: 1, modelRequests: 1 };
});
