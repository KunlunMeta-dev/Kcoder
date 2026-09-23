import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createRunContext, verifyRunContextIntegrity } from './run-context.mjs';
import { browserLaunchOptions } from './runner-options.mjs';
import { submitTerminalLine } from './terminal-interaction.mjs';
import { runBrowserScenarioLifecycle, settleLifecycleStep } from './browser-lifecycle.mjs';

// A real Provider transport and TUI; the loopback server only supplies model output.
export async function runModelRefreshScenario(options, runtime) {
  const artifacts = await createRunContext(options, 'model-refresh', runtime.runContextRuntime());
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(200).end(); return; }
    try {
      let input = '';
      for await (const chunk of request) { input += chunk; if (input.length > 2 * 1024 * 1024) throw new Error('oversized fixture request'); }
      const body = JSON.parse(input);
      assert.equal(body.reasoning_effort, 'high', 'rejected shortcut must preserve the fixed reasoning policy');
      requests.push({ model: body.model, temperature: body.temperature });
      const text = `P1_REAL_TURN_${requests.length}_COMPLETE`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } catch { response.writeHead(400).end(); }
  });
  let session, browser, page;
  const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
  const runOptions = { ...options, repoRoot: runtime.repoRoot, commandOverride: '{repoRoot}/target/debug/kcoder --cwd {workspace}',
    runDir: artifacts.dir, workspaceDir: artifacts.workspace, configHome: artifacts.configHome, requestsDir: artifacts.requestsDir };
  let config;
  return runBrowserScenarioLifecycle({
    execute: async () => {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      await mkdir(artifacts.configDir, { recursive: true });
      config = { active_provider: 'fixture', credential_store: 'file', permission_mode: 'yolo', max_retries: 0,
        summary_provider: null, summary_model: null,
        providers: { fixture: { api_format: 'openai_chat_completions', endpoint: `http://127.0.0.1:${server.address().port}/v1`,
          default_model: 'fixture-model', context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 1024,
          capabilities: { text: true, tools: true, reasoning: true }, reasoning_effort: 'high', reasoning_policy: { mode: 'always_on', efforts: ['high'] },
          no_proxy: true, extra_body: { temperature: 0.2 } } } };
      await json(path.join(artifacts.configDir, 'settings.json'), config);
      await writeFile(path.join(artifacts.configDir, 'credentials.json'), JSON.stringify({ fixture: { type: 'api', key: 'synthetic-tui-fixture' } }), { mode: 0o600 });
      await runtime.writeStartMeta(artifacts, runOptions, runOptions.commandOverride, 'model-refresh');
      session = await runtime.startSession(runOptions);
      browser = await chromium.launch(browserLaunchOptions(options));
      page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
      await page.goto(session.url);
      await page.waitForFunction(() => window.tuiLab?.ready, null, { timeout: options.timeoutMs });
      const waitText = text => page.waitForFunction(text => window.tuiLab.visibleText().includes(text), text, { timeout: options.timeoutMs });
      await waitText('Ask KCoder');
      await page.keyboard.press('Alt+,');
      await waitText('Cannot change reasoning');
      assert.equal(requests.length, 0);
      const settingsBefore = await readFile(path.join(artifacts.configDir, 'settings.json'), 'utf8');
      await submitTerminalLine(page, '/set model_reasoning_effort none');
      await waitText('Cannot set reasoning');
      assert.equal(await readFile(path.join(artifacts.configDir, 'settings.json'), 'utf8'), settingsBefore);
      assert.equal(requests.length, 0);
      await page.screenshot({ path: path.join(artifacts.dir, 'reasoning-policy-rejection.png') });
      await submitTerminalLine(page, 'Reply with the fixture completion marker.');
      await waitText('P1_REAL_TURN_1_COMPLETE');
      await page.waitForTimeout(500);
      config.providers.fixture.extra_body.temperature = 0.7;
      await json(path.join(artifacts.configDir, 'settings.json'), config);
      await submitTerminalLine(page, 'Reply again with the fixture completion marker.');
      await waitText('P1_REAL_TURN_2_COMPLETE');
      await page.waitForTimeout(500);
      assert.deepEqual(requests, [{ model: 'fixture-model', temperature: 0.2 }, { model: 'fixture-model', temperature: 0.7 }]);
      await page.screenshot({ path: path.join(artifacts.dir, 'model-refresh.png') });
      await json(path.join(artifacts.configDir, 'settings.json'), { ...config, providers: {} });
      await submitTerminalLine(page, 'Keep this third message while the model is unavailable.');
      await waitText('queued input was kept');
      assert.equal(requests.length, 2);
      config.providers.fixture.extra_body.temperature = 0.8;
      await json(path.join(artifacts.configDir, 'settings.json'), config);
      await submitTerminalLine(page, 'Continue after repairing the model configuration.');
      await waitText('P1_REAL_TURN_4_COMPLETE');
      assert.equal(requests.length, 4);
      assert.deepEqual(requests.slice(2).map(request => request.temperature), [0.8, 0.8]);
      await page.screenshot({ path: path.join(artifacts.dir, 'queue-recovered.png') });
      await writeFile(artifacts.text, await page.evaluate(() => window.tuiLab.visibleText()));
      await json(path.join(artifacts.dir, 'model-requests.json'), requests);
      return { reasoningPolicyShortcutRejected: true, nextTurnReloaded: true, rejectedQueueRecovered: true, realProvider: true, requests: requests.length };
    },
    captureBeforeCleanup: async () => {
      if (page) {
        await page.screenshot({ path: path.join(artifacts.dir, 'last-screen.png') }).catch(() => {});
        await writeFile(artifacts.text, await page.evaluate(() => window.tuiLab?.visibleText() || '').catch(() => '')).catch(() => {});
      }
      if (session) await writeFile(artifacts.ptyLog, session.getPtyLog());
    },
    cleanup: async () => {
      const steps = [];
      if (browser) steps.push(await settleLifecycleStep('browser', () => browser.close()));
      if (session) steps.push(await settleLifecycleStep('session', () => session.stop()));
      steps.push(await settleLifecycleStep('fixture', () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
      const exit = session ? await settleLifecycleStep('pty-exit', () => session.exitPromise) : { status: 'completed' };
      return { steps, ptyExitObserved: exit.status === 'completed' };
    },
    onFailure: async error => { await json(path.join(artifacts.dir, 'failure.json'), { error: String(error), requests }); console.error(artifacts.dir); },
    onSuccess: async (result, cleanup) => {
      await verifyRunContextIntegrity(artifacts, runtime.runContextRuntime());
      await json(artifacts.assertions, { ok: true, ...result });
      await json(artifacts.meta, { mode: 'model-refresh', result, cleanup });
      console.log(artifacts.dir);
    },
  });
}
