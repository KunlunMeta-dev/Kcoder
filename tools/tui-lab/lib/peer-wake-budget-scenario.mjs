import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createRunContext, verifyRunContextIntegrity } from './run-context.mjs';
import { browserLaunchOptions } from './runner-options.mjs';
import { submitTerminalLine } from './terminal-interaction.mjs';
import { captureStep } from './browser-evidence.mjs';
import { runBrowserScenarioLifecycle, cleanupOwnedBrowserSessions, settleLifecycleStep } from './browser-lifecycle.mjs';

const TRIGGER = 'OWNED_ONE_USER_SIX_WAKE_MESSAGES';
const RESET = 'OWNED_REAL_USER_RESETS_WAKE_ALLOWANCE';
const RESET_DONE = 'OWNED_REAL_USER_RESET_FINISHED';
const FINISHED = 'OWNED_SIX_WAKE_SENDS_FINISHED';
const wake = number => `OWNED_BUDGET_WAKE_${number}`;
const done = number => `OWNED_BUDGET_RECEIVER_DONE_${number}`;
const textBlocks = message => typeof message?.content === 'string' ? [message.content]
  : (message?.content ?? []).map(block => block.text ?? '');

/** The fifth message is accepted as data but cannot create an automatic model
 * turn. Only a new physical PTY user input resets the durable allowance.
 */
export async function runPeerWakeBudgetScenario(options, runtime) {
  assert.equal(process.platform, 'linux');
  const binary = process.env.KCODER_E2E_KCODER_BIN;
  assert.ok(binary && path.isAbsolute(binary));
  const artifacts = await createRunContext(options, 'peer-wake-budget', runtime.runContextRuntime());
  const sessions = [], pages = [], trace = [], observations = [], errors = [], toolFailures = [], processes = [], browserLogs = [];
  const sent = new Map(), applied = new Map(), replies = new Map(), peerCalls = new Map(), reconciliations = [];
  let browser, destination, binaryIdentity, sourceCalls = 0, realReceiverCalls = 0, fifthObserved;
  let releaseReset, fifthReady;
  const reset = new Promise(resolve => { releaseReset = resolve; });
  const fifth = new Promise(resolve => { fifthReady = resolve; });
  const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
  const nativeHistory = async () => {
    const histories = [];
    const source = [...sent.values()].find(receipt => receipt.sourceAddress)?.sourceAddress;
    const ids = new Set([source?.threadId, destination?.threadId].filter(Boolean));
    const visit = async (directory, depth = 0) => {
      if (depth > 8) return;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory() && !/^(?:checkpoints|context-history|llm-history|snapshots|archives|builtin-skills|skills|attachments|requests|cache|logs)$/.test(entry.name)) await visit(file, depth + 1);
        else if ((entry.name.endsWith('.jsonl') && ids.has(entry.name.replace(/\.jsonl$/, ''))) ||
          (entry.name === 'session.jsonl' && ids.has(path.basename(directory)))) {
          const bytes = await readFile(file);
          const rows = bytes.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
          histories.push({ path: file, sha256: createHash('sha256').update(bytes).digest('hex'), rows });
        }
      }
    };
    await visit(artifacts.configDir); await visit(artifacts.workspace);
    return histories;
  };
  const provider = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(404).end(); return; }
    try {
      let raw = '';
      for await (const chunk of request) { raw += chunk; assert.ok(Buffer.byteLength(raw) <= 2 * 1024 * 1024); }
      const body = JSON.parse(raw), context = JSON.stringify(body.messages);
      const source = context.includes(TRIGGER);
      const output = message => {
        assert.ok(message, 'the expected original tool result is missing');
        const text = textBlocks(message).join('');
        if (text.startsWith('Tool `')) {
          toolFailures.push({ toolCallId: message.tool_call_id, text });
          assert.fail(`original tool ${message.tool_call_id} failed: ${text}`);
        }
        return JSON.parse(text);
      };
      const sendResult = message => {
        const text = textBlocks(message).join('');
        try { return JSON.parse(text); }
        catch {
          // The native error publishes the original identity even if its
          // admission reply was lost. Reconcile that ID and never resend.
          const encoded = text.match(/^Tool `SendSessionMessage` execution failed: (\{[^\n]+\})\.(?:\n|$)/)?.[1];
          assert.ok(encoded, 'SendSessionMessage must return a receipt or its structured original-ID error');
          const error = JSON.parse(encoded);
          assert.equal(error.status, 'unknown');
          assert.match(error.clientMessageId, /^peer-[a-f0-9]{64}$/);
          reconciliations.push({ clientMessageId: error.clientMessageId, code: error.code });
          return { clientMessageId: error.clientMessageId, status: 'unknown' };
        }
      };
      const lastTool = [...body.messages].reverse().find(message => message.role === 'tool');
      const tool = (id, name, input) => ({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] });
      const send = number => tool(`budget-send-${number}`, 'SendSessionMessage', {
        targetThreadId: destination.threadId, targetAddress: destination, mode: 'wake_if_idle', text: wake(number),
      });
      const query = (number, poll = 0) => tool(`budget-get-${number}-${poll}`, 'GetSessionMessageReceipt', {
        clientMessageId: sent.get(number).clientMessageId,
      });
      let delta, finish = 'stop';
      if (source) {
        assert.ok(++sourceCalls <= 40);
        if (!lastTool) { delta = tool('budget-discover', 'ListSessions', {}); finish = 'tool_calls'; }
        else if (lastTool.tool_call_id === 'budget-discover') {
          const listing = output(lastTool); assert.equal(listing.targets.length, 1);
          destination = listing.targets[0].address; delta = send(1); finish = 'tool_calls';
        } else if (/^budget-send-/.test(lastTool.tool_call_id)) {
          const number = Number(lastTool.tool_call_id.split('-').at(-1));
          const receipt = sendResult(lastTool); assert.ok(['queued', 'delivering', 'applied', 'unknown'].includes(receipt.status));
          if (receipt.targetAddress) assert.equal(receipt.targetAddress.threadId, destination.threadId);
          sent.set(number, receipt);
          // Observe the actual destination's committed Peer row before querying
          // the receipt. Fast identical polls would correctly trip Engine's
          // ordinary doom-loop protection and would not test the wake budget.
          if (receipt.status !== 'unknown') await pages[1].waitForFunction(marker => window.tuiLab.visibleText().includes(marker), wake(number), { timeout: options.timeoutMs });
          delta = query(number); finish = 'tool_calls';
        } else {
          const match = lastTool.tool_call_id.match(/^budget-get-(\d+)-(\d+)$/); assert.ok(match);
          const number = Number(match[1]), poll = Number(match[2]), receipt = output(lastTool).receipt;
          assert.ok(receipt, `the original ${sent.get(number).clientMessageId} has no admitted receipt; do not replace or replay it`);
          assert.equal(receipt.clientMessageId, sent.get(number).clientMessageId);
          if (sent.get(number).messageId) assert.equal(receipt.messageId, sent.get(number).messageId);
          else sent.set(number, receipt);
          if (receipt.status !== 'applied') {
            assert.ok(['queued', 'delivering'].includes(receipt.status)); assert.ok(poll < 5);
            await pages[1].waitForFunction(marker => window.tuiLab.visibleText().includes(marker), wake(number), { timeout: options.timeoutMs });
            delta = query(number, poll + 1); finish = 'tool_calls';
          } else if (number === 5) {
            applied.set(number, receipt);
            fifthObserved = receipt; fifthReady(); await reset;
            delta = send(6); finish = 'tool_calls';
          } else {
            applied.set(number, receipt);
            await pages[1].waitForFunction(marker => window.tuiLab.visibleText().includes(marker) &&
              !window.tuiLab.visibleText().toLowerCase().includes('esc interrupt'), done(number), { timeout: options.timeoutMs });
            if (number < 5) { delta = send(number + 1); finish = 'tool_calls'; }
            else delta = { role: 'assistant', content: FINISHED };
          }
        }
      } else {
        const latestInput = [...body.messages].reverse().find(message => message.role === 'user');
        if (textBlocks(latestInput).some(text => text === RESET)) {
          assert.equal(++realReceiverCalls, 1); delta = { role: 'assistant', content: RESET_DONE };
        } else {
          const reference = body.messages.flatMap(textBlocks).filter(text => text.includes('"kind":"untrusted_peer_agent_reference"'))
            .map(text => JSON.parse(text.slice(text.indexOf('{')))).filter(value => /^OWNED_BUDGET_WAKE_\d+$/.test(value.text)).at(-1);
          assert.ok(reference); const number = Number(reference.text.split('_').at(-1));
          assert.ok(number !== 5, 'the fifth peer must never start a Provider request');
          const count = (peerCalls.get(number) ?? 0) + 1; peerCalls.set(number, count); assert.ok(count <= 2);
          if (count === 1) {
            delta = tool(`budget-ack-${number}`, 'SendSessionMessage', {
              targetThreadId: reference.sourceThreadId, targetAddress: reference.sourceAddress,
              mode: 'enqueue_only', text: `OWNED_BUDGET_ACK_${number}`,
            }); finish = 'tool_calls';
          } else {
            const receipt = output(lastTool); assert.ok(['queued', 'delivering', 'applied'].includes(receipt.status));
            replies.set(number, receipt); delta = { role: 'assistant', content: done(number) };
          }
        }
      }
      observations.push({ source, sourceCalls, realReceiverCalls, peerCalls: Object.fromEntries(peerCalls) });
      const frame = (value, stop) => ({ id: 'owned-peer-budget', object: 'chat.completion.chunk', model: body.model,
        choices: [{ index: 0, delta: value, finish_reason: stop }] });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(frame(delta, null))}\n\ndata: ${JSON.stringify(frame({}, finish))}\n\ndata: [DONE]\n\n`);
    } catch (error) { errors.push(String(error)); releaseReset(); fifthReady(); if (!response.headersSent) response.writeHead(400); response.end(); }
  });
  return runBrowserScenarioLifecycle({
    execute: async () => {
      await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
      await mkdir(artifacts.configDir, { recursive: true });
      await json(path.join(artifacts.configDir, 'settings.json'), {
        active_provider: 'fixture', credential_store: 'file', permission_mode: 'yolo', max_retries: 0,
        cross_session_messages: { enabled: true, wake_idle: true },
        auto_memory_enabled: false, auto_tool_memory_enabled: false, session_memory: { enabled: false },
        providers: { fixture: { api_format: 'openai_chat_completions', endpoint: `http://127.0.0.1:${provider.address().port}/v1`,
          authentication: { mode: 'none' }, no_proxy: true, discover_models: false, default_model: 'owned-peer-budget-fixture',
          context_window_tokens: 1048576, max_output_tokens: 8192, output_headroom_tokens: 8192 } },
      });
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
      const runOptions = { ...options, repoRoot: runtime.repoRoot, workspaceDir: artifacts.workspace,
        configHome: artifacts.configHome, requestsDir: artifacts.requestsDir, commandOverride: `${quote(binary)} --cwd {workspace}` };
      await runtime.writeStartMeta(artifacts, { ...runOptions, runDir: artifacts.dir }, runOptions.commandOverride, options.scenario);
      browser = await chromium.launch(browserLaunchOptions(options));
      const image = await stat(binary, { bigint: true });
      const digest = createHash('sha256');
      await new Promise((resolve, reject) => createReadStream(binary).on('data', data => digest.update(data)).on('end', resolve).on('error', reject));
      const binarySha256 = digest.digest('hex');
      binaryIdentity = { path: binary, sha256: binarySha256, dev: String(image.dev), ino: String(image.ino) };
      for (const label of ['source', 'receiver']) {
        const directory = path.join(artifacts.dir, label); await mkdir(directory);
        const session = await runtime.startSession({ ...runOptions, runDir: directory }); sessions.push(session);
        const page = await browser.newPage({ viewport: { width: 1100, height: 760 } }); pages.push(page);
        page.on('console', message => browserLogs.push(`[${label}] ${message.type()}: ${message.text()}`));
        page.on('pageerror', error => browserLogs.push(`[${label}] pageerror: ${String(error)}`));
        await page.goto(session.url);
        await page.waitForFunction(() => window.tuiLab?.ready && window.tuiLab.visibleText().includes('Ask KCoder'), null, { timeout: options.timeoutMs });
        assert.equal(await page.evaluate(() => window.tuiLab.renderer), 'webgl');
        const actual = await stat(`/proc/${session.ptyProcess.pid}/exe`, { bigint: true });
        assert.equal(actual.dev, image.dev); assert.equal(actual.ino, image.ino);
        processes.push({ label, pid: session.ptyProcess.pid, executableDev: String(actual.dev), executableIno: String(actual.ino), renderer: 'webgl' });
        await json(path.join(artifacts.dir, 'native-processes.json'), { binaryIdentity, processes });
      }
      await submitTerminalLine(pages[0], TRIGGER);
      let timer;
      try { await Promise.race([fifth, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('five real peer deliveries did not complete')), options.timeoutMs); })]); }
      finally { clearTimeout(timer); }
      assert.deepEqual(errors, []); assert.equal(fifthObserved.status, 'applied');
      await pages[1].waitForFunction(marker => window.tuiLab.visibleText().includes(marker), wake(5), { timeout: options.timeoutMs });
      await pages[1].waitForTimeout(1200);
      assert.deepEqual(Object.fromEntries(peerCalls), { 1: 2, 2: 2, 3: 2, 4: 2 });
      assert.equal(realReceiverCalls, 0);
      await captureStep(pages[1], trace, 'fifth-message-visible-without-a-model-turn', path.join(artifacts.dir, 'budget-exhausted.png'));
      await submitTerminalLine(pages[1], RESET);
      await pages[1].waitForFunction(marker => window.tuiLab.visibleText().includes(marker) &&
        !window.tuiLab.visibleText().toLowerCase().includes('esc interrupt'), RESET_DONE, { timeout: options.timeoutMs });
      releaseReset();
      await pages[0].waitForFunction(marker => window.tuiLab.visibleText().includes(marker), FINISHED, { timeout: options.timeoutMs });
      assert.deepEqual(errors, []); assert.equal(sent.size, 6); assert.equal(applied.size, 6); assert.equal(replies.size, 5);
      assert.deepEqual(Object.fromEntries(peerCalls), { 1: 2, 2: 2, 3: 2, 4: 2, 6: 2 }); assert.equal(realReceiverCalls, 1);
      const history = await nativeHistory();
      const destinationHistory = history.filter(item => item.rows.some(row => row.session_id === destination.threadId));
      const sourceAddress = sent.get(1).sourceAddress;
      const sourceHistory = history.filter(item => item.rows.some(row => row.session_id === sourceAddress.threadId));
      assert.equal(destinationHistory.length, 1, 'the original receiver has one authoritative Native history');
      assert.equal(sourceHistory.length, 1, 'the original source has one authoritative Native history');
      const messages = destinationHistory[0].rows.map(row => row.message ?? row);
      const peers = messages.filter(message => message.origin === 'peer_agent');
      const nativeUsers = messages.filter(message => message.origin === 'user');
      assert.equal(peers.length, 6); assert.equal(nativeUsers.length, 1);
      assert.equal(textBlocks(nativeUsers[0]).join(''), RESET);
      assert.equal(messages.filter(message => textBlocks(message).join('') === RESET).length, 1);
      const sourceUsers = sourceHistory[0].rows.map(row => row.message ?? row).filter(message => message.origin === 'user');
      assert.equal(sourceUsers.length, 1); assert.equal(textBlocks(sourceUsers[0]).join(''), TRIGGER);
      assert.equal(new Set([...applied.values()].map(receipt => receipt.messageId)).size, 6);
      assert.equal(new Set([...applied.values()].map(receipt => receipt.clientMessageId)).size, 6);
      for (let number = 1; number <= 6; number++) {
        const receipt = applied.get(number), peer = peers[number - 1];
        assert.equal(textBlocks(peer).join(''), wake(number));
        assert.equal(peer.agent_message.messageId, receipt.messageId);
        assert.equal(peer.agent_message.sourceThreadId, sourceAddress.threadId);
        assert.equal(peer.agent_message.targetThreadId, destination.threadId);
        assert.equal(peer.agent_message.bodySha256, createHash('sha256').update(wake(number)).digest('hex'));
        assert.deepEqual(peer.agent_message.sourceAddress, sourceAddress);
        assert.deepEqual(peer.agent_message.targetAddress, destination);
        assert.deepEqual(receipt.sourceAddress, sourceAddress);
        assert.deepEqual(receipt.targetAddress, destination);
        assert.equal(receipt.clientMessageId, sent.get(number).clientMessageId);
        assert.equal(receipt.messageId, sent.get(number).messageId);
      }
      for (const session of sessions) assert.equal(session.getExitInfo(), null);
      await captureStep(pages[1], trace, 'real-user-reset-allows-sixth-peer-turn', path.join(artifacts.dir, 'budget-reset.png'));
      return { realPty: true, renderer: 'webgl', binarySha256, independentProcesses: 2, sourceRealUserTurns: 1,
        destinationRealUserTurns: 1, acceptedWakeMessages: sent.size, nativePeerRows: peers.length,
        fifthAppliedWithoutModel: true, fifthReceipt: fifthObserved, peerProviderRequests: Object.fromEntries(peerCalls),
        enqueueReplies: replies.size, sourceCalls, realReceiverCalls, reconciliations, noFakeUserReset: true, loopbackProviderOnly: true,
        binaryIdentity, processes, receipts: Object.fromEntries(applied), replyReceipts: Object.fromEntries(replies),
        nativeHistory: history.map(({ rows, ...identity }) => ({ ...identity, rows: rows.length })) };
    },
    captureBeforeCleanup: async () => {
      for (let index = 0; index < pages.length; index++) {
        await writeFile(path.join(artifacts.dir, `${index}.screen.txt`), await pages[index].evaluate(() => window.tuiLab?.visibleText() ?? '').catch(() => ''));
        await writeFile(path.join(artifacts.dir, `${index}.pty.log`), sessions[index].getPtyLog());
      }
      await writeFile(path.join(artifacts.dir, 'pty.log'), sessions.map((session, index) => `[owned-session-${index + 1}]\n${session.getPtyLog()}`).join('\n'));
      await writeFile(path.join(artifacts.dir, 'browser-console.log'), browserLogs.join('\n'));
      await json(path.join(artifacts.dir, 'provider-observations.json'), observations);
      await json(path.join(artifacts.dir, 'native-history-evidence.json'), await nativeHistory().catch(error => ({ error: String(error) })));
    },
    cleanup: async () => {
      releaseReset(); fifthReady();
      const report = await cleanupOwnedBrowserSessions({ browser, sessions });
      report.steps.push(await settleLifecycleStep('owned-budget-provider', () => new Promise(resolve => { provider.closeAllConnections(); provider.close(resolve); })));
      return report;
    },
    onFailure: async error => { await json(path.join(artifacts.dir, 'failure.json'), {
      error: String(error), errors, toolFailures, binaryIdentity, processes,
      sent: Object.fromEntries(sent), applied: Object.fromEntries(applied), replies: Object.fromEntries(replies),
      peerProviderRequests: Object.fromEntries(peerCalls), sourceCalls, realReceiverCalls,
      reconciliations, observations, trace, cleanup: error.cleanup, cleanupError: error.cleanupError ? String(error.cleanupError) : undefined,
    }); console.error(artifacts.dir); },
    onSuccess: async (result, cleanup) => { await verifyRunContextIntegrity(artifacts, runtime.runContextRuntime());
      await json(artifacts.assertions, { ok: true, ...result }); await json(artifacts.meta, { result, cleanup, trace }); console.log(artifacts.dir); },
  });
}
