import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createRunContext, verifyRunContextIntegrity } from './run-context.mjs';
import { browserLaunchOptions } from './runner-options.mjs';
import { submitTerminalLine } from './terminal-interaction.mjs';
import { runBrowserScenarioLifecycle, settleLifecycleStep } from './browser-lifecycle.mjs';

// Only model protocol is deterministic. The tool, PTY, question dialog, input
// editing and result returned to the real Engine all use production code.
export async function runQuestionFreeformScenario(options, runtime) {
  const artifacts = await createRunContext(options, 'question-freeform', runtime.runContextRuntime());
  const expected = ['都不符合，先核对原始资料。\n保留我自己的要求。', '仅采用自定义方案👩‍💻'];
  let requests = 0, roundtrip = false, session, browser, page;
  const exposedNames = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(200).end(); return; }
    try {
      let raw = '';
      for await (const chunk of request) { raw += chunk; assert.ok(Buffer.byteLength(raw) <= 2 * 1024 * 1024); }
      const body = JSON.parse(raw); requests++;
      assert.ok(requests <= 2);
      let delta, finish;
      if (requests === 1) {
        const names = (body.tools ?? []).map(tool => tool.function?.name ?? tool.name).filter(name => typeof name === 'string');
        exposedNames.push(...names);
        const questionTool = names.find(name => /ask_?user_?question/i.test(name));
        assert.ok(questionTool, 'The real Provider must expose the question tool');
        const questions = [false, true].map((multi_select, index) => ({
          question: `FREEFORM_QUESTION_${index + 1}`, header: 'Answer', multi_select,
          options: [{ label: 'Plan A', description: 'Suggested first plan' }, { label: 'Plan B', description: 'Suggested second plan' }],
        }));
        delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'ask-freeform', type: 'function', function: { name: questionTool, arguments: JSON.stringify({ questions }) } }] };
        finish = 'tool_calls';
      } else {
        const result = body.messages.filter(message => message.role === 'tool').map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
        for (const value of expected) assert.ok(result.includes(value) || result.includes(JSON.stringify(value).slice(1, -1)), 'Actual tool result must contain the exact user answer');
        assert.ok(!result.includes('None of the above'), 'The Other label is not the answer');
        roundtrip = true; delta = { role: 'assistant', content: 'ASKUSER_FREEFORM_ROUNDTRIP_OK' }; finish = 'stop';
      }
      const frame = (value, stop) => ({ id: 'freeform-fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: value, finish_reason: stop }] });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(frame(delta, null))}\n\ndata: ${JSON.stringify(frame({}, finish))}\n\ndata: [DONE]\n\n`);
    } catch { response.writeHead(400).end(); }
  });
  const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
  const runOptions = { ...options, repoRoot: runtime.repoRoot,
    commandOverride: options.commandOverride || '{repoRoot}/target/debug/kcoder --cwd {workspace}',
    runDir: artifacts.dir, workspaceDir: artifacts.workspace, configHome: artifacts.configHome, requestsDir: artifacts.requestsDir };
  return runBrowserScenarioLifecycle({
    execute: async () => {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      await mkdir(artifacts.configDir, { recursive: true });
      await json(path.join(artifacts.configDir, 'settings.json'), { active_provider: 'fixture', credential_store: 'file', permission_mode: 'ask', allowed_tools: ['AskUserQuestion'], max_retries: 0,
        providers: { fixture: { api_format: 'openai_chat_completions', endpoint: `http://127.0.0.1:${server.address().port}/v1`,
          authentication: { mode: 'none' }, default_model: 'fixture', context_window_tokens: 128000, max_output_tokens: 2048, output_headroom_tokens: 2048,
          capabilities: { text: true, tools: true, reasoning: false }, no_proxy: true, discover_models: false } } });
      await runtime.writeStartMeta(artifacts, runOptions, runOptions.commandOverride, 'question-freeform');
      session = await runtime.startSession(runOptions);
      browser = await chromium.launch(browserLaunchOptions(options));
      page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
      await page.goto(session.url);
      await page.waitForFunction(() => window.tuiLab?.ready, null, { timeout: options.timeoutMs });
      assert.equal(await page.evaluate(() => window.tuiLab.renderer), 'webgl');
      const wait = text => page.waitForFunction(text => window.tuiLab.visibleText().includes(text), text, { timeout: options.timeoutMs });
      await wait('Ask KCoder'); await submitTerminalLine(page, 'Ask the two fixture questions.');
      for (let index = 0; index < 2; index++) {
        await wait(`Question ${index + 1}/2`);
        await wait(`FREEFORM_QUESTION_${index + 1}`);
        await page.keyboard.press('End'); await page.keyboard.press('Enter');
        await wait('Answer:');
        await page.evaluate(text => window.tuiLab.sendInput(`\u001b[200~${text}\u001b[201~`), expected[index]);
        await wait(index === 0 ? '都不符合' : '仅采用自定义方案');
        await page.screenshot({ path: path.join(artifacts.dir, `question-${index + 1}-custom.png`) });
        await page.keyboard.press('Enter');
      }
      await wait('ASKUSER_FREEFORM_ROUNDTRIP_OK');
      assert.equal(roundtrip, true); assert.equal(requests, 2);
      return { realPty: true, renderer: 'webgl', singleChoiceCustom: true, multiChoiceCustomOnly: true, unicodeAndNewlinePreserved: true, providerProtocolOnly: true };
    },
    captureBeforeCleanup: async () => {
      if (page) { await page.screenshot({ path: path.join(artifacts.dir, 'last-screen.png') }).catch(() => {}); await writeFile(artifacts.text, await page.evaluate(() => window.tuiLab?.visibleText() || '').catch(() => '')).catch(() => {}); }
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
    onFailure: async error => { await json(path.join(artifacts.dir, 'failure.json'), { error: String(error), requests, exposedNames }); console.error(artifacts.dir); },
    onSuccess: async (result, cleanup) => { await verifyRunContextIntegrity(artifacts, runtime.runContextRuntime()); await json(artifacts.assertions, { ok: true, ...result }); await json(artifacts.meta, { mode: 'question-freeform', result, cleanup }); console.log(artifacts.dir); },
  });
}
