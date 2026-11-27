import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createRunContext, verifyRunContextIntegrity } from './run-context.mjs';
import { browserLaunchOptions } from './runner-options.mjs';
import { submitTerminalLine } from './terminal-interaction.mjs';
import { attachBrowserConsole, captureStep, formatBrowserConsole } from './browser-evidence.mjs';
import { runBrowserScenarioLifecycle, settleLifecycleStep } from './browser-lifecycle.mjs';

// The provider is controlled; compaction, the PTY and xterm/WebGL are real.
export async function runCompactionLivenessScenario(options, runtime) {
  if (process.platform !== 'linux') throw new Error('compaction-liveness currently requires Linux PTY verification');
  const artifacts = await createRunContext(options, 'compaction-liveness', runtime.runContextRuntime());
  const samples = [], trace = [], browserConsole = [];
  let session, browser, page, executable, pendingSummary;
  let requests = 0;
  const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
  const respond = (response, text) => {
    const frame = (delta, finish_reason = null) => ({
      id: 'compaction-fixture', object: 'chat.completion.chunk', model: 'fixture',
      choices: [{ index: 0, delta, finish_reason }],
    });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify(frame({ role: 'assistant', content: text }))}\n\n`
      + `data: ${JSON.stringify(frame({}, 'stop'))}\n\ndata: [DONE]\n\n`);
  };
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(404).end(); return; }
    try {
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        assert.ok(Buffer.byteLength(raw) < 2 * 1024 * 1024);
      }
      JSON.parse(raw);
      requests += 1;
      assert.ok(requests <= 4, 'The fixture permits three turns and one summary only');
      if (requests === 4) pendingSummary = response;
      else respond(response, (requests === 1 ? 'Old evidence. '.repeat(500) : '') + `COMPACTION_TURN_${requests}_DONE`);
    } catch (error) {
      response.writeHead(400).end();
      samples.push({ fixtureError: String(error) });
    }
  });
  const runOptions = {
    ...options, repoRoot: runtime.repoRoot,
    commandOverride: options.commandOverride || '{repoRoot}/target/debug/kcoder --cwd {workspace}',
    runDir: artifacts.dir, workspaceDir: artifacts.workspace,
    configHome: artifacts.configHome, requestsDir: artifacts.requestsDir,
  };
  return runBrowserScenarioLifecycle({
    execute: async () => {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      await mkdir(artifacts.configDir, { recursive: true });
      await json(path.join(artifacts.configDir, 'settings.json'), {
        active_provider: 'fixture', credential_store: 'file', permission_mode: 'yolo', max_retries: 0,
        summary_profile: null, session_memory: { enabled: false }, tools: { profile: 'none' },
        providers: { fixture: {
          api_format: 'openai_chat_completions', endpoint: `http://127.0.0.1:${server.address().port}/v1`,
          authentication: { mode: 'none' }, default_model: 'fixture', context_window_tokens: 128000,
          max_output_tokens: 8192, output_headroom_tokens: 8192,
          capabilities: { text: true, tools: false, reasoning: false }, no_proxy: true, discover_models: false,
        } },
      });
      await runtime.writeStartMeta(artifacts, runOptions, runOptions.commandOverride, 'compaction-liveness');
      session = await runtime.startSession(runOptions);
      browser = await chromium.launch(browserLaunchOptions(options));
      page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
      attachBrowserConsole(page, browserConsole);
      await page.goto(session.url);
      await page.waitForFunction(() => window.tuiLab?.ready, null, { timeout: options.timeoutMs });
      assert.equal(await page.evaluate(() => window.tuiLab.renderer), 'webgl');
      const wait = text => page.waitForFunction(text => window.tuiLab.visibleText().includes(text), text,
        { timeout: options.timeoutMs });
      await wait('Ask KCoder');
      const procExe = `/proc/${session.ptyProcess.pid}/exe`;
      const digest = createHash('sha256');
      await new Promise((resolve, reject) => createReadStream(procExe)
        .on('data', chunk => digest.update(chunk)).on('end', resolve).on('error', reject));
      executable = { pid: session.ptyProcess.pid, path: await readlink(procExe), sha256: digest.digest('hex') };
      for (let turn = 1; turn <= 3; turn++) {
        await submitTerminalLine(page, `Controlled request ${turn}`);
        await wait(`COMPACTION_TURN_${turn}_DONE`);
        await page.waitForTimeout(200);
      }
      await submitTerminalLine(page, '/compact');
      await wait('Compacting context…');
      const frames = new Set();
      for (let sample = 0; sample < 12; sample++) {
        const rows = (await page.evaluate(() => window.tuiLab.visibleText())).split('\n');
        const row = rows.findIndex(line => line.includes('Compacting context…'));
        const previous = rows.findIndex(line => line.includes('COMPACTION_TURN_3_DONE'));
        assert.ok(row > previous && previous >= 0, 'The animation must follow the current output');
        assert.equal(rows.filter(line => line.includes('Compacting context…')).length, 1);
        frames.add(rows[row].trim());
        samples.push({ atMs: Date.now(), row, line: rows[row] });
        await page.waitForTimeout(120);
      }
      assert.ok(frames.size >= 2, 'The compaction row must keep animating without input or model output');
      await captureStep(page, trace, 'compacting', path.join(artifacts.dir, 'compacting.png'));
      assert.ok(pendingSummary, 'The real compactor must have reached the controlled provider');
      respond(pendingSummary, '<analysis>Checked the older source.</analysis><summary>Retained the older evidence and task requirements.</summary>');
      await wait('Context compaction completed');
      await page.waitForFunction(() => !window.tuiLab.visibleText().includes('Compacting context…'));
      const completedRows = (await page.evaluate(() => window.tuiLab.visibleText())).split('\n');
      assert.equal(completedRows.filter(line => line.includes('Context compaction completed')).length, 1,
        'The completed row must be retained once, without a duplicate generic receipt');
      await captureStep(page, trace, 'completed-retained', path.join(artifacts.dir, 'completed-retained.png'));
      return { realPty: true, renderer: 'webgl', loopbackModelOnly: true, requests,
        animatedFrames: frames.size, nextRow: true, completionRetained: true };
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
      steps.push(await settleLifecycleStep('fixture', () => new Promise(resolve => {
        server.closeAllConnections(); server.close(resolve);
      })));
      const exit = session ? await settleLifecycleStep('pty-exit', () => session.exitPromise) : { status: 'completed' };
      return { steps, ptyExitObserved: exit.status === 'completed' };
    },
    onFailure: async error => {
      await json(path.join(artifacts.dir, 'failure.json'), { error: String(error), executable, requests });
      console.error(artifacts.dir);
    },
    onSuccess: async (result, cleanup) => {
      await verifyRunContextIntegrity(artifacts, runtime.runContextRuntime());
      await json(artifacts.assertions, { ok: true, ...result });
      await json(artifacts.meta, { mode: 'compaction-liveness', executable, command: runOptions.commandOverride,
        result, trace, cleanup });
      console.log(artifacts.dir);
    },
  });
}
