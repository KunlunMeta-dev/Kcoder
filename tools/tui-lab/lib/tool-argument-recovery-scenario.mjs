import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createRunContext, verifyRunContextIntegrity } from './run-context.mjs';
import { browserLaunchOptions } from './runner-options.mjs';
import { submitTerminalLine } from './terminal-interaction.mjs';
import { attachBrowserConsole, captureStep, formatBrowserConsole } from './browser-evidence.mjs';
import { runBrowserScenarioLifecycle, settleLifecycleStep } from './browser-lifecycle.mjs';

// The provider protocol is a loopback fault fixture. The actual CLI, write tool,
// PTY and xterm/WebGL renderer establish the terminal behavior being asserted.
export async function runToolArgumentRecoveryScenario(options, runtime) {
  if (process.platform !== 'linux') throw Error('tool argument recovery PTY proof currently requires Linux');
  const kind = options.scenario.slice('tool-arguments-'.length);
  assert.ok(['max-tokens', 'response-limit', 'write-limit'].includes(kind));
  const artifacts = await createRunContext(options, 'tool-arguments', runtime.runContextRuntime());
  const expectedLimit = 512 * 1024;
  const oldLimitPlusOne = 256 * 1024 + 1;
  const desired = kind === 'write-limit' ? 'ALLOW_256K_PLUS_ONE\n' + 'y'.repeat(oldLimitPlusOne - 'ALLOW_256K_PLUS_ONE\n'.length) : 'SMALL_WRITE_SUCCEEDED';
  const fixtureErrors = [], observations = [], trace = [], browserConsole = [];
  let requests = 0, firstModel, session, browser, page, executable;
  let releasePrefix, releaseCorrection;
  const prefixGate = new Promise(resolve => { releasePrefix = resolve; });
  const correctionGate = new Promise(resolve => { releaseCorrection = resolve; });
  const target = path.join(artifacts.workspace, 'result.txt');
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(404).end(); return; }
    try {
      let raw = '';
      for await (const chunk of request) { raw += chunk; assert.ok(Buffer.byteLength(raw) <= 2 * 1024 * 1024); }
      const body = JSON.parse(raw);
      const number = ++requests;
      if (number === 1) firstModel = body.model;
      else assert.equal(body.model, firstModel, 'recovery must retain the same configured model');
      const context = JSON.stringify(body.messages);
      observations.push({ number, model: body.model, contextBytes: Buffer.byteLength(context),
        hasSmallStepFeedback: context.includes('replaces the entire file') && context.includes(String(expectedLimit)),
        hasUnfinishedArguments: context.includes('BAD_UNEXECUTED_PREVIEW'),
        toolCount: Array.isArray(body.tools) ? body.tools.length : null,
        messageRoles: body.messages.map(message => message.role),
        memoryRequest: /memory|MEMORY/.test(JSON.stringify(body.messages[0])),
        stream: body.stream });
      assert.ok(number <= 3, 'the fixture must not permit an unbounded regeneration');
      assert.ok(body.tools.some(tool => tool.function?.name === 'write'));
      const frame = (delta, finish = null) => ({ id: 'owned-write-fixture', object: 'chat.completion.chunk', model: body.model,
        choices: [{ index: 0, delta, finish_reason: finish }] });
      const send = (delta, finish) => response.write(`data: ${JSON.stringify(frame(delta, finish))}\n\n`);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (number === 1) {
        if (kind === 'write-limit') {
          send({ role: 'assistant', tool_calls: [{ index: 0, id: 'write-rejected', type: 'function', function: {
            name: 'write', arguments: JSON.stringify({ file_path: 'result.txt', content: 'x'.repeat(expectedLimit + 1) }),
          } }] });
          send({}, 'tool_calls'); response.end('data: [DONE]\n\n');
        } else {
          send({ role: 'assistant', tool_calls: [{ index: 0, id: 'write-rejected', type: 'function', function: {
            name: 'write', arguments: '{"file_path":"result.txt","content":"BAD_UNEXECUTED_PREVIEW',
          } }] });
          await prefixGate;
          if (kind === 'response-limit') send({ tool_calls: [{ index: 0, function: { arguments: 'X'.repeat(1024) } }] });
          send({}, kind === 'max-tokens' ? 'length' : 'tool_calls');
          response.end('data: [DONE]\n\n');
        }
      } else if (number === 2) {
        assert.equal(existsSync(target), false, 'the refused original write must never create the file');
        if (kind !== 'write-limit') {
          assert.ok(!context.includes('BAD_UNEXECUTED_PREVIEW'), 'partial JSON must not enter the next request');
          assert.ok(context.includes('No tools in that response were executed') && context.includes('replaces the entire file'));
        } else {
          assert.ok(body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'write-rejected'), 'complete rejected calls require their original terminal result');
        }
        await correctionGate;
        send({ role: 'assistant', tool_calls: [{ index: 0, id: 'write-small', type: 'function', function: {
          name: 'write', arguments: JSON.stringify({ file_path: 'result.txt', content: desired }),
        } }] });
        send({}, 'tool_calls'); response.end('data: [DONE]\n\n');
      } else {
        assert.equal(await readFile(target, 'utf8'), desired, 'the corrected complete write uses the real tool');
        send({ role: 'assistant', content: 'TUI_WRITE_ARGUMENT_RECOVERED' });
        send({}, 'stop'); response.end('data: [DONE]\n\n');
      }
    } catch (error) {
      fixtureErrors.push(String(error));
      if (!response.headersSent) response.writeHead(400);
      response.end();
    }
  });
  const json = (file, data) => writeFile(file, JSON.stringify(data, null, 2) + '\n');
  const runOptions = { ...options, repoRoot: runtime.repoRoot,
    commandOverride: options.commandOverride || '{repoRoot}/target/debug/kcoder --cwd {workspace}',
    runDir: artifacts.dir, workspaceDir: artifacts.workspace, configHome: artifacts.configHome, requestsDir: artifacts.requestsDir };
  return runBrowserScenarioLifecycle({
    execute: async () => {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      await mkdir(artifacts.configDir, { recursive: true });
      await json(path.join(artifacts.configDir, 'settings.json'), {
        active_provider: 'fixture', credential_store: 'file', permission_mode: 'yolo', max_retries: 1,
        // This fixture covers the foreground write, not independent memory updates.
        auto_memory_enabled: false, auto_tool_memory_enabled: false, session_memory: { enabled: false },
        providers: { fixture: { api_format: 'openai_chat_completions',
          endpoint: `http://127.0.0.1:${server.address().port}/v1`, authentication: { mode: 'none' },
          default_model: 'owned-write-fixture', context_window_tokens: 1048576, max_output_tokens: 8192,
          output_headroom_tokens: 8192, capabilities: { text: true, tools: true, reasoning: false },
          ...(kind === 'response-limit' ? { response_limits: { tool_arguments_bytes: 256, total_decoded_bytes: 4096 } } : {}),
          no_proxy: true, discover_models: false } },
      });
      await runtime.writeStartMeta(artifacts, runOptions, runOptions.commandOverride, 'tool-arguments');
      session = await runtime.startSession(runOptions);
      browser = await chromium.launch(browserLaunchOptions(options));
      page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
      attachBrowserConsole(page, browserConsole);
      await page.goto(session.url);
      await page.waitForFunction(() => window.tuiLab?.ready, null, { timeout: options.timeoutMs });
      assert.equal(await page.evaluate(() => window.tuiLab.renderer), 'webgl');
      const wait = text => page.waitForFunction(value => window.tuiLab.visibleText().includes(value), text, { timeout: options.timeoutMs });
      await wait('Ask KCoder');
      const proc = `/proc/${session.ptyProcess.pid}/exe`;
      const digest = createHash('sha256');
      await new Promise((resolve, reject) => createReadStream(proc).on('data', chunk => digest.update(chunk)).on('end', resolve).on('error', reject));
      executable = { pid: session.ptyProcess.pid, path: await readlink(proc), sha256: digest.digest('hex') };
      await submitTerminalLine(page, 'Write the owned result artifact in complete small steps and finish.');
      if (kind !== 'write-limit') {
        await wait('BAD_UNEXECUTED_PREVIEW');
        assert.equal(existsSync(target), false);
        await captureStep(page, trace, 'partial-before-rejection', path.join(artifacts.dir, 'partial-before-rejection.png'));
        releasePrefix();
      }
      const continuationDeadline = Date.now() + Math.min(options.timeoutMs, 10000);
      while (requests < 2 && Date.now() < continuationDeadline && fixtureErrors.length === 0) await page.waitForTimeout(25);
      assert.equal(requests, 2, 'the rejected write must lead to a next model step, not end the task');
      assert.deepEqual(fixtureErrors, []);
      await page.keyboard.press('Alt+t');
      await captureStep(page, trace, 'after-rejection-before-corrected-call', path.join(artifacts.dir, 'after-rejection-before-corrected-call.png'));
      releaseCorrection();
      await wait('TUI_WRITE_ARGUMENT_RECOVERED');
      await page.waitForFunction(() => !window.tuiLab.visibleText().includes('esc interrupt'), null, { timeout: options.timeoutMs });
      const text = await page.evaluate(() => window.tuiLab.visibleText());
      assert.ok(!text.includes('Tool result unknown: write'), 'a known pre-dispatch refusal must not become an unknown result');
      assert.equal(requests, 3);
      assert.deepEqual(fixtureErrors, []);
      assert.equal(await readFile(target, 'utf8'), desired);
      await captureStep(page, trace, 'complete-and-input-ready', path.join(artifacts.dir, 'complete-and-input-ready.png'));
      assert.equal(requests, 3);
      assert.deepEqual(fixtureErrors, []);
      return { realPty: true, renderer: 'webgl', loopbackModelOnly: true, kind, actualWriteTool: true,
        sourceLimitBytes: expectedLimit, correctedFileBytes: Buffer.byteLength(desired), requests,
        noUnknownWrite: true, originalRefusalNeverWrote: true };
    },
    captureBeforeCleanup: async () => {
      if (page) await writeFile(artifacts.text, await page.evaluate(() => window.tuiLab?.visibleText() || '').catch(() => '')).catch(() => {});
      if (session) await writeFile(artifacts.ptyLog, session.getPtyLog());
      await writeFile(artifacts.browserConsoleLog, formatBrowserConsole(browserConsole));
      await json(path.join(artifacts.dir, 'request-observations.json'), observations);
    },
    cleanup: async () => {
      releasePrefix(); releaseCorrection();
      const steps = [];
      if (browser) steps.push(await settleLifecycleStep('browser', () => browser.close()));
      if (session) steps.push(await settleLifecycleStep('session', () => session.stop()));
      steps.push(await settleLifecycleStep('fixture', () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
      const exit = session ? await settleLifecycleStep('pty-exit', () => session.exitPromise) : { status: 'completed' };
      return { steps, ptyExitObserved: exit.status === 'completed' };
    },
    onFailure: async error => { await json(path.join(artifacts.dir, 'failure.json'), { error: String(error), executable, requests, fixtureErrors, trace }); console.error(artifacts.dir); },
    onSuccess: async (result, cleanup) => {
      await verifyRunContextIntegrity(artifacts, runtime.runContextRuntime());
      await json(artifacts.assertions, { ok: true, ...result });
      await json(artifacts.meta, { mode: 'tool-arguments', command: runOptions.commandOverride, executable, result, trace, cleanup });
      console.log(artifacts.dir);
    },
  });
}
