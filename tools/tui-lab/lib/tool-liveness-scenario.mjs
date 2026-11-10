import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { attachBrowserConsole, captureStep, formatBrowserConsole } from './browser-evidence.mjs';
import { createRunContext, verifyRunContextIntegrity } from './run-context.mjs';
import { browserLaunchOptions } from './runner-options.mjs';
import { submitTerminalLine } from './terminal-interaction.mjs';
import { runBrowserScenarioLifecycle, settleLifecycleStep } from './browser-lifecycle.mjs';

// The model protocol is a loopback fixture; the shell tools, TUI, PTY and
// xterm renderer are the real implementation under test.
export async function runToolLivenessScenario(options, runtime) {
  if (process.platform !== 'linux') throw new Error('tool-liveness currently requires a Linux shell');
  const artifacts = await createRunContext(options, 'tool-liveness', runtime.runContextRuntime());
  const requests = [];
  const samples = [];
  const browserConsole = [];
  const trace = [];
  const mixedFamilies = options.scenario === 'mixed-families';
  const mixedSleep = options.scenario === 'sleep-tool' || mixedFamilies;
  const longWait = options.scenario === 'long-wait';
  let session, browser, page;
  let executable;
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(404).end(); return; }
    try {
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        assert.ok(Buffer.byteLength(raw) <= 2 * 1024 * 1024);
      }
      const body = JSON.parse(raw);
      requests.push(body);
      let delta, finish;
      if (requests.length === 1) {
        assert.ok(body.tools.some(tool => tool.function?.name === 'bash'));
        if (mixedSleep) assert.ok(body.tools.some(tool => tool.function?.name === 'Sleep'));
        if (mixedFamilies) {
          for (const name of ['read', 'grep']) assert.ok(body.tools.some(tool => tool.function?.name === name));
        }
        const tools = mixedFamilies ? [
          { name: 'read', input: { file_path: 'src/sample.txt', offset: 1, limit: 20 } },
          { name: 'grep', input: { pattern: 'sample', path: 'src', output_mode: 'content', head_limit: 20 } },
          { name: 'bash', input: { command: "printf 'started' > .tui-liveness-started; printf 'LIVENESS_FAST_DONE\\n'", timeout: 20000 } },
          { name: 'Sleep', input: { duration_seconds: 20 } },
        ] : mixedSleep ? [
          { name: 'bash', input: { command: "printf 'started' > .tui-liveness-started; printf 'LIVENESS_FAST_DONE\\n'", timeout: 20000 } },
          { name: 'Sleep', input: { duration_seconds: 20 } },
        ] : [
          { name: 'bash', input: { command: "printf 'LIVENESS_FAST_DONE\\n'", timeout: 20000 } },
          { name: 'bash', input: { command: `printf 'started' > .tui-liveness-started; sleep ${longWait ? 30 : 20}; printf 'LIVENESS_SLOW_DONE\\n'`, timeout: 40000 } },
        ];
        delta = { role: 'assistant', tool_calls: tools.map((tool, index) => ({
          index, id: `liveness-${index}`, type: 'function',
          function: { name: tool.name, arguments: JSON.stringify(tool.input) },
        })) };
        finish = 'tool_calls';
      } else {
        const ids = body.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id);
        for (let index = 0; index < (mixedFamilies ? 4 : 2); index++) {
          assert.ok(ids.includes(`liveness-${index}`), 'Every original tool result must reach the model');
        }
        delta = { role: 'assistant', content: 'TUI_LIVENESS_FINISHED' };
        finish = 'stop';
      }
      const frame = (value, stop) => ({ id: 'liveness-fixture', object: 'chat.completion.chunk', model: body.model,
        choices: [{ index: 0, delta: value, finish_reason: stop }] });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(frame(delta, null))}\n\ndata: ${JSON.stringify(frame({}, finish))}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      response.writeHead(400).end();
      samples.push({ fixtureError: String(error) });
    }
  });
  const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
  const runOptions = { ...options, repoRoot: runtime.repoRoot,
    commandOverride: options.commandOverride || '{repoRoot}/target/debug/kcoder --cwd {workspace}',
    runDir: artifacts.dir, workspaceDir: artifacts.workspace, configHome: artifacts.configHome, requestsDir: artifacts.requestsDir };

  const collectFrames = async (phase) => {
    const seen = new Set();
    for (let index = 0; index < 16; index++) {
      const visible = await page.evaluate(() => window.tuiLab.visibleText());
      const title = mixedFamilies ? /[◇◈◆]\s*tools\s+read x1.*grep x1.*bash x1.*Sleep x1/
        : mixedSleep ? /[◇◈◆]\s*tools\s+bash x1.*Sleep x1/ : /[◇◈◆]\s*tools\s+bash x2/;
      const line = visible.split('\n').find(row => title.test(row));
      assert.ok(line, `The two-tool summary must remain visible during ${phase}`);
      assert.ok(visible.includes(mixedSleep ? 'Sleep running' : 'bash running'), 'The slow tool must still be running');
      const indicator = line.match(/[◇◈◆]/)?.[0];
      seen.add(indicator);
      samples.push({ phase, atMs: Date.now(), indicator, line });
      await page.waitForTimeout(150);
    }
    assert.ok(seen.size >= 2, `The running tool summary stopped animating during ${phase}: ${[...seen]}`);
    return [...seen];
  };

  const collectExpandedFooterFrames = async () => {
    const seen = new Set();
    for (let index = 0; index < 16; index++) {
      const visible = await page.evaluate(() => window.tuiLab.visibleText());
      const footer = visible.split('\n').findLast(row => row.includes('Running') && /[▁▃▆█]{4}/.test(row));
      assert.ok(footer, 'The expanded tool view must retain a running activity indicator');
      const indicator = footer.match(/[▁▃▆█]{4}/)?.[0];
      seen.add(indicator);
      samples.push({ phase: 'expanded-footer', atMs: Date.now(), indicator, line: footer });
      await page.waitForTimeout(150);
    }
    assert.ok(seen.size >= 2, `The expanded tool activity stopped animating: ${[...seen]}`);
    return [...seen];
  };

  return runBrowserScenarioLifecycle({
    execute: async () => {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      await mkdir(artifacts.configDir, { recursive: true });
      await json(path.join(artifacts.configDir, 'settings.json'), {
        active_provider: 'fixture', credential_store: 'file', permission_mode: 'yolo', max_retries: 0,
        providers: { fixture: { api_format: 'openai_chat_completions',
          endpoint: `http://127.0.0.1:${server.address().port}/v1`, authentication: { mode: 'none' },
          default_model: 'fixture', context_window_tokens: 128000, max_output_tokens: 2048,
          output_headroom_tokens: 2048, capabilities: { text: true, tools: true, reasoning: false },
          no_proxy: true, discover_models: false } },
      });
      await runtime.writeStartMeta(artifacts, runOptions, runOptions.commandOverride, 'tool-liveness');
      session = await runtime.startSession(runOptions);
      browser = await chromium.launch(browserLaunchOptions(options));
      page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
      attachBrowserConsole(page, browserConsole);
      await page.goto(session.url);
      await page.waitForFunction(() => window.tuiLab?.ready, null, { timeout: options.timeoutMs });
      assert.equal(await page.evaluate(() => window.tuiLab.renderer), 'webgl');
      const wait = text => page.waitForFunction(text => window.tuiLab.visibleText().includes(text), text, { timeout: options.timeoutMs });
      await wait('Ask KCoder');
      const procExe = `/proc/${session.ptyProcess.pid}/exe`;
      const exePath = await readlink(procExe);
      const digest = createHash('sha256');
      await new Promise((resolve, reject) => createReadStream(procExe)
        .on('data', chunk => digest.update(chunk)).on('end', resolve).on('error', reject));
      executable = { pid: session.ptyProcess.pid, path: exePath, sha256: digest.digest('hex') };
      await submitTerminalLine(page, 'Run the two controlled shell tools.');

      const started = path.join(artifacts.workspace, '.tui-liveness-started');
      const deadline = Date.now() + options.timeoutMs;
      while (!existsSync(started) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      assert.ok(existsSync(started), 'The real slow shell must have started');
      const observedStart = Date.now();
      await page.waitForFunction(({ mixedSleep, mixedFamilies }) => {
        const text = window.tuiLab.visibleText();
        const title = mixedFamilies ? /[◇◈◆]\s*tools\s+read x1.*grep x1.*bash x1.*Sleep x1/
          : mixedSleep ? /[◇◈◆]\s*tools\s+bash x1.*Sleep x1/ : /[◇◈◆]\s*tools\s+bash x2/;
        return title.test(text)
          && (mixedSleep ? text.includes('Sleep running') : text.includes('bash running'));
      }, { mixedSleep, mixedFamilies }, { timeout: options.timeoutMs });

      const idleFrames = await collectFrames('without-input');
      await captureStep(page, trace, 'running-without-input', path.join(artifacts.dir, 'running-without-input.png'));
      let lateFrames;
      if (longWait) {
        await page.waitForTimeout(Math.max(0, 16000 - (Date.now() - observedStart)));
        lateFrames = await collectFrames('after-silence-threshold');
        await captureStep(page, trace, 'long-wait-without-input', path.join(artifacts.dir, 'long-wait-without-input.png'));
      }
      await page.locator('#terminal').click();
      await page.keyboard.type('queued while running');
      await wait('queued while running');
      const typingFrames = await collectFrames('while-typing');
      await page.keyboard.press('Enter');
      await wait('Messages to be submitted');
      await captureStep(page, trace, 'queued-during-tool', path.join(artifacts.dir, 'queued-during-tool.png'));
      let expandedFrames;
      if (mixedFamilies) {
        await page.keyboard.press('Alt+t');
        expandedFrames = await collectExpandedFooterFrames();
        await captureStep(page, trace, 'expanded-during-tool', path.join(artifacts.dir, 'expanded-during-tool.png'));
      }
      await wait('TUI_LIVENESS_FINISHED');
      assert.ok(requests.length >= 2);
      await json(path.join(artifacts.dir, 'animation-samples.json'), samples);
      return { realPty: true, renderer: 'webgl', realShell: true, mixedSleep, mixedFamilies, longWait, loopbackModelOnly: true,
        animatedWithoutInput: idleFrames, animatedAfterSilenceThreshold: lateFrames,
        animatedWhileTyping: typingFrames, expandedFrames, queuedInputVisible: true };
    },
    captureBeforeCleanup: async () => {
      if (page) {
        await page.screenshot({ path: path.join(artifacts.dir, 'last-screen.png') }).catch(() => {});
        await writeFile(artifacts.text, await page.evaluate(() => window.tuiLab?.visibleText() || '').catch(() => '')).catch(() => {});
      }
      if (session) await writeFile(artifacts.ptyLog, session.getPtyLog());
      await writeFile(artifacts.browserConsoleLog, formatBrowserConsole(browserConsole));
      await json(path.join(artifacts.dir, 'animation-samples.json'), samples);
    },
    cleanup: async () => {
      const steps = [];
      if (browser) steps.push(await settleLifecycleStep('browser', () => browser.close()));
      if (session) steps.push(await settleLifecycleStep('session', () => session.stop()));
      steps.push(await settleLifecycleStep('fixture', () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
      const exit = session ? await settleLifecycleStep('pty-exit', () => session.exitPromise) : { status: 'completed' };
      return { steps, ptyExitObserved: exit.status === 'completed' };
    },
    onFailure: async error => { await json(path.join(artifacts.dir, 'failure.json'), { error: String(error), executable, requests: requests.length, samples }); console.error(artifacts.dir); },
    onSuccess: async (result, cleanup) => {
      await verifyRunContextIntegrity(artifacts, runtime.runContextRuntime());
      await json(artifacts.assertions, { ok: true, ...result });
      await json(artifacts.meta, { mode: 'tool-liveness', command: runOptions.commandOverride, executable, result, trace, cleanup });
      console.log(artifacts.dir);
    },
  });
}
