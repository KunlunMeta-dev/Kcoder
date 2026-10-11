import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { extractTuiSessionId, waitForProjectDirForSession } from '../../../../../tools/tui-lab/lib/session-memory-evidence.mjs';
import { chromium } from '../../../renderer/node_modules/@playwright/test/index.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { prepareIsolatedRealModelConfig, realModelPreflight } from '../../harness/real-model.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
await runE2E(import.meta.url, { testId: 'real-minimax-three-protocols-two-turn-and-tui',
  tier: 'manual-live', modelPolicy: 'real-model-required; MiniMax-M3; twelve turns maximum; 2048 output tokens per turn; no retry' }, async context => {
  const workspace = await materializeWorkspace(context, 'minimal', { instanceId: 'protocol-matrix' });
  const model = await realModelPreflight(process.env.KCODER_E2E_MODEL_PROFILE, { cwd: workspace.path });
  assert.equal(model.model, 'MiniMax-M3', 'UNMET_PREREQUISITE: this matrix requires MiniMax-M3');
  const origin = new URL(model.providerConfig.endpoint).origin;
  assert.ok(['api.minimax.cn', 'api.minimaxi.com', 'api.minimax.io'].includes(new URL(origin).hostname), 'UNMET_PREREQUISITE: official MiniMax endpoint required');

  const isolated = await prepareIsolatedRealModelConfig(context, model);
  const credentialEnv = Object.fromEntries(model.credentialEnv.filter(name => process.env[name]).map(name => [name, process.env[name]]));
  const results = [];
  const browserCache = process.env.PLAYWRIGHT_BROWSERS_PATH || resolve(homedir(), '.cache/ms-playwright');
  const deadline = Date.now() + 600000;
  const remaining = () => { assert.ok(Date.now() < deadline, 'matrix wall-clock budget exceeded'); return Math.min(60000, deadline - Date.now()); };
  for (const [name, api_format, endpoint, extra_body] of [
    ['chat', 'openai_chat_completions', origin + '/v1', { thinking: { type: 'adaptive' }, reasoning_split: true }],
    ['anthropic', 'anthropic_messages', origin + '/anthropic', { thinking: { type: 'adaptive' } }],
    ['responses', 'openai_responses', origin + '/v1', { reasoning: { effort: 'medium' } }],
  ]) {
    assert.ok(Date.now() < deadline, 'matrix wall-clock budget exceeded');
    const settingsFile = await context.writeStateJson(`real-model-config/${name}.json`, {
      active_provider: model.profile, max_retries: 0, tools: { disabled: ['*'] },
      providers: { [model.profile]: { ...model.providerConfig, api_format, endpoint,
        default_model: model.model, models: { [model.model]: {
          context_window_tokens: 128000, max_output_tokens: 2048, output_headroom_tokens: 2048,
          capabilities: { text: true, tools: false, vision: false, reasoning: true, structured_output: false }, extra_body,
        } }, max_output_tokens: 2048, output_headroom_tokens: 2048,
        extra_body: {}, max_retries: 0 } },
    }, 0o400);
    const serversFile = await context.writeStateJson(`servers-${name}.json`, [{ id: name, label: name,
      transport: 'local', command: model.kcoderBin, workspace: workspace.path, settingsFile, profile: model.profile }]);
    const gateway = await startGateway(context, { label: `matrix-${name}`, workspace: workspace.path,
      serversFile, kcoderBin: model.kcoderBin, env: { KCODER_CONFIG_DIR: isolated.configDir,
        KCODER_MAX_TOKENS: '2048', KCODER_MAX_RETRIES: '0', KCODER_MAX_DURATION_SECS: '45', ...credentialEnv } });
    const rpc = await openRpc(gatewayRpcUrl(gateway, name, await waitForGatewayRpcToken(context, gateway)));
    context.addCleanup(`close ${name} matrix RPC`, () => rpc.close());
    await initializeRpc(rpc, 'protocol-matrix');
    const { thread } = await rpc.request('thread/start');
    const prompts = ['Calculate 12 times 15. Reply with the number and MATRIX_FIRST_OK. Do not use tools.',
      'What number did you just calculate? Reply with the number and MATRIX_SECOND_OK. Do not use tools.'];
    const turns = [];
    for (const [index, prompt] of prompts.entries()) {
      const { turn } = await rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: prompt }] });
      const done = await rpc.waitFor(m => m.method === 'turn/completed' && m.params?.threadId === thread.id && m.params?.turnId === turn.id, remaining(), 'model completion');
      assert.equal(done.params.turn.status, 'completed');
      const events = rpc.messages().filter(m => m.params?.threadId === thread.id && m.params?.turnId === turn.id);
      const thinking = events.filter(m => m.params?.event?.type === 'assistant_thinking_delta').length;
      const text = events.filter(m => m.method === 'item/delta').map(m => m.params?.delta?.text || '').join('');
      await context.writeArtifactJson(`${name}-turn-${index}.json`, { completed: true, thinkingEvents: thinking, textCharacters: text.length });
      // A simple follow-up may validly omit visible reasoning (consolidation plan §M).
      // Validate completion/text first; the affected primary request must still exercise thinking.
      assert.ok(text.includes('180') && text.includes(index ? 'MATRIX_SECOND_OK' : 'MATRIX_FIRST_OK'));
      if (index === 0) assert.ok(thinking > 0, `${name} primary turn must emit structured thinking`);
      turns.push({ completed: true, thinkingEvents: thinking });
    }
    await rpc.request('thread/delete', { threadId: thread.id });
    rpc.close(); await context.stopOwned(`matrix-${name}`);
    await context.writeArtifactJson(`rpc-${name}.json`, { protocol: name, turns });
    console.log(`${name}: real RPC turns passed`);
    // Reuse the real node-pty/xterm.js laboratory, not a home-grown terminal parser.
    if (process.platform !== 'linux') throw new Error('UNMET_PREREQUISITE: TUI matrix currently requires Linux');
    const label = `tui-${name}`;
    const command = `env KCODER_CONFIG_DIR=${quote(isolated.configDir)} ${quote(model.kcoderBin)} --settings-file ${quote(settingsFile)} --profile ${quote(model.profile)} --cwd {workspace} --max-retries 0 --max-duration-secs 45`;
    const child = context.spawnOwned(label, process.execPath, [resolve(repoRoot, 'tools/tui-lab/bin/tui-lab.mjs'), 'open', '--headless', '--description', `real-${name}-protocol-matrix`, '--command', command],
      { cwd: repoRoot, env: context.isolatedEnvironment({ PLAYWRIGHT_BROWSERS_PATH: browserCache, ...credentialEnv }) });
    let output = '';
    child.stdout.on('data', data => { output = (output + data).slice(-12000); });
    const url = await waitFor(() => output.match(/open at (http:\/\/127\.0\.0\.1:[^\s]+)/)?.[1], 45000, 'TUI Lab');
    const browser = await chromium.launch({ headless: true });
    context.addCleanup(`close ${name} TUI browser`, () => browser.close().catch(() => {}));
    const page = await browser.newPage(); await page.goto(url);
    await page.waitForFunction(() => window.tuiLab?.text().includes('MiniMax-M3'));
    const tuiSessionId = extractTuiSessionId(await page.evaluate(() => window.tuiLab.text()));
    try {
      for (const [index, prompt] of prompts.entries()) {
        await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.insertText(prompt); await page.keyboard.press('Enter');
        const marker = index ? 'MATRIX_SECOND_OK' : 'MATRIX_FIRST_OK';
        const project = await waitForProjectDirForSession(isolated.configDir, tuiSessionId, remaining());
        await waitFor(async () => {
          try {
            const rows = (await readFile(resolve(project, `${tuiSessionId}.jsonl`), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
            return rows.some(row => row.role === 'assistant' && Array.isArray(row.content)
              && row.content.some(block => block.type === 'text' && block.text?.includes('180') && block.text.includes(marker)));
          } catch { return false; }
        }, remaining(), 'committed TUI answer');
        await page.waitForFunction(marker => window.tuiLab.text().includes(marker) && window.tuiLab.text().includes('180') && window.tuiLab.title().startsWith('[READY]'), marker, { timeout: remaining() });
      }
    } catch (error) {
      await context.writeArtifactJson(`tui-${name}-failure.json`, { screen: await page.evaluate(() => window.tuiLab.text()) });
      await page.screenshot({ path: context.pathInArtifacts(`tui-${name}-failure.png`) });
      throw error;
    }
    await browser.close(); await context.stopOwned(label);
    results.push({ protocol: name, turns, tuiTwoTurns: true });
    console.log(`${name}: real TUI turns passed`);
  }
  await context.writeArtifactJson('protocol-matrix.json', results);
});
