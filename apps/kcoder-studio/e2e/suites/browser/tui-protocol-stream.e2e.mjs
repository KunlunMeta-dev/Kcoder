import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startProtocolStreamFixture } from '../../harness/protocol-stream-fixture.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
await runE2E(import.meta.url, {
  testId: 'tui-three-protocol-stream-consumption', tier: 'manual-live',
  modelPolicy: 'model-independent real PTY/xterm TUI with fixed loopback SSE and one actual tool per protocol',
}, async context => {
  const fixture = await startProtocolStreamFixture(context);
  const chromium = await startChromium(context);
  const results = [];
  for (const apiFormat of ['anthropic_messages', 'openai_chat_completions', 'openai_responses']) {
    const home = context.pathInState(apiFormat);
    const key = 'tui-protocol-fixture'; context.registerSecret(key);
    await context.writeStateJson(`${apiFormat}/credentials.json`, { fixture: { type: 'api', key } });
    await context.writeStateJson(`${apiFormat}/settings.json`, {
      active_provider: 'fixture', max_retries: 0, permission_mode: 'yolo',
      providers: { fixture: { api_format: apiFormat,
        endpoint: apiFormat === 'anthropic_messages' ? fixture.baseUrl.replace(/\/v1$/, '') : fixture.baseUrl,
        ...(apiFormat === 'openai_chat_completions' ? { chat_protocol: 'minimax' } : {}),
        default_model: 'fixture-model', no_proxy: true, context_window_tokens: 128000,
        max_output_tokens: 1024, output_headroom_tokens: 1024 } },
    });
    const command = `env KCODER_CONFIG_DIR=${quote(home)} ${quote(resolve(repoRoot, 'target/debug/kcoder'))} --cwd {workspace} --max-retries 0 --max-duration-secs 30`;
    const label = `tui-${apiFormat}`;
    const child = context.spawnOwned(label, process.execPath, [resolve(repoRoot, 'tools/tui-lab/bin/tui-lab.mjs'),
      'open', '--headless', '--description', `p1-${apiFormat}-protocol`, '--out', context.pathInState(`${label}-lab`), '--command', command],
      { cwd: repoRoot, env: context.isolatedEnvironment({ PLAYWRIGHT_BROWSERS_PATH: '/root/.cache/ms-playwright' }) });
    let output = '';
    child.stdout.on('data', data => { output = (output + data).slice(-16000); });
    const url = await waitFor(() => {
      if (child.exitCode !== null) throw new Error('owned TUI Lab exited before readiness');
      return output.match(/open at (http:\/\/127\.0\.0\.1:[^\s]+)/)?.[1];
    }, 45000, 'owned TUI Lab');
    const page = await chromium.newPage({ viewport: { width: 1440, height: 1100 } });
    try {
      await page.goto(url);
      await page.waitForFunction(() => window.tuiLab?.text().includes('fixture-model'), null, { timeout: 30000 });
      const runDir = output.match(/Run directory: ([^\n]+)/)?.[1]?.trim();
      assert.ok(runDir?.startsWith(context.stateDir));
      const meta = JSON.parse(await readFile(resolve(runDir, 'meta.json'), 'utf8'));
      for (const [index, mode] of ['complete', 'tool', 'eof'].entries()) {
        const before = fixture.requests.length;
        await page.locator('.xterm-helper-textarea').focus();
        await page.keyboard.insertText(`FIXTURE_${mode.toUpperCase()}`); await page.keyboard.press('Enter');
        await waitFor(() => fixture.requests.length >= before + (mode === 'tool' ? 2 : 1), 30000, 'TUI model requests');
        await page.waitForFunction(({ expected, mode }) => {
          const text = window.tuiLab.text();
          return window.tuiLab.title().startsWith('[READY]') && !text.includes('esc interrupt') &&
            (text.match(/TEXT_TAIL/g) || []).length >= expected &&
            (mode !== 'eof' || /stream_incomplete|provider.*error|错误|失败/i.test(text));
        }, { expected: index + 1, mode }, { timeout: 30000 });
        const screen = await page.evaluate(() => window.tuiLab.text());
        await context.writeArtifactJson(`${apiFormat}-${mode}.json`, { screen, requestCount: fixture.requests.length - before });
        assert.ok(screen.includes('THINK_TAIL'), 'terminal must preserve upstream thinking');
        if (mode === 'eof') assert.match(screen, /stream_incomplete|provider.*error|错误|失败/i);
        assert.equal(fixture.requests.length - before, mode === 'tool' ? 2 : 1);
        if (mode === 'tool') assert.equal(await readFile(resolve(meta.workspace, 'protocol-tool-count.txt'), 'utf8'), 'x');
        results.push({ apiFormat, mode, terminalReady: true });
      }
      await page.screenshot({ path: context.pathInArtifacts(`${apiFormat}-tui.png`) });
    } catch (error) {
      await context.writeArtifactJson(`${apiFormat}-failure.json`, { screen: await page.evaluate(() => window.tuiLab?.text()).catch(() => '') });
      await page.screenshot({ path: context.pathInArtifacts(`${apiFormat}-failure.png`) }).catch(() => {});
      throw error;
    } finally { await page.close(); await context.stopOwned(label); }
  }
  return { results, requests: fixture.requests.length };
});
