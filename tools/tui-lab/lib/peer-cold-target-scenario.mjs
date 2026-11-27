import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { waitFor } from '../../../apps/kcoder-studio/e2e/harness/run-context.mjs';
import { createRunContext, verifyRunContextIntegrity } from './run-context.mjs';
import { browserLaunchOptions } from './runner-options.mjs';
import { submitTerminalLine } from './terminal-interaction.mjs';
import { captureStep } from './browser-evidence.mjs';
import { cleanupOwnedBrowserSessions, runBrowserScenarioLifecycle, settleLifecycleStep } from './browser-lifecycle.mjs';
import { observeOwnedPeerSessionLease } from './peer-session-lease-observation.mjs';

const SEED = 'OWNED_COLD_TARGET_ORIGINAL_USER';
const SEED_DONE = 'OWNED_COLD_TARGET_ORIGINAL_TERMINAL';
const seedInput = turn => turn === 1 ? SEED : `${SEED}_${turn}`;
const seedOutput = turn => turn === 1 ? SEED_DONE : `${SEED_DONE}_${turn}`;
const ENQUEUE = 'OWNED_SOURCE_ENQUEUE_TO_COLD_TARGET';
const WAKE = 'OWNED_SOURCE_WAKE_COLD_ORIGINAL_TARGET';
const BODY = phase => `OWNED_COLD_TARGET_BODY_${phase}`;
const SOURCE_DONE = phase => `OWNED_COLD_TARGET_SOURCE_DONE_${phase}`;
const TARGET_DONE = 'OWNED_COLD_TARGET_WAKE_COMPLETED';
const REPLY = 'OWNED_COLD_TARGET_REPLY_TO_ORIGINAL_SOURCE';
const text = message => typeof message?.content === 'string' ? message.content
  : (message?.content ?? []).map(block => block.text ?? '').join('');

/** Actual process exit, original-ID manual resume, another process exit and
 * automatic cold activation all use the same owned TUI history/lease namespace.
 */
export async function runPeerColdTargetScenario(options, runtime) {
  assert.equal(process.platform, 'linux');
  const seedTurns = options.scenario === 'peer-cold-target-long-history' ? 257 : 1;
  const binary = process.env.KCODER_E2E_KCODER_BIN;
  assert.ok(binary && path.isAbsolute(binary));
  const artifacts = await createRunContext(options, 'peer-cold-target', runtime.runContextRuntime());
  const sessions = [], pages = [], trace = [], errors = [], processes = [], snapshots = [], directoryPages = [], receipts = new Map(), unconfirmed = [];
  const calls = { seed: 0, sourceEnqueue: 0, sourceWake: 0, targetWake: 0 };
  let browser, destination, originalHistory, originalThread, historyOwnerRoot, leaseFile, originalLease, binarySha256, reply, optionsForRun, initialLedger;
  const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
  const rows = async () => (await readFile(originalHistory, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const checkpoint = async stage => {
    const nativeRows = await rows();
    const lease = await observeOwnedPeerSessionLease(leaseFile, historyOwnerRoot);
    assert.equal(lease.dev, originalLease.dev); assert.equal(lease.ino, originalLease.ino);
    snapshots.push({ stage, rows: nativeRows, lease, calls: { ...calls } });
    return { nativeRows, lease };
  };
  const findHistory = async (marker = SEED) => {
    const found = [];
    const visit = async (directory, depth = 0) => {
      assert.ok(depth <= 8, 'owned history lookup stays bounded');
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory() && !/^(?:checkpoints|context-history|llm-history|snapshots|archives|builtin-skills|skills|attachments|requests|cache|logs)$/.test(entry.name)) await visit(file, depth + 1);
        else if (entry.name.endsWith('.jsonl') && !entry.name.endsWith('.exit.jsonl')) {
          const content = await readFile(file, 'utf8');
          if (content.split('\n').filter(Boolean).some(line => text((JSON.parse(line).message ?? JSON.parse(line))) === marker)) found.push(file);
        }
      }
    };
    await visit(artifacts.configDir); await visit(artifacts.workspace);
    assert.equal(found.length, 1, 'the original target has one authoritative native history');
    return found[0];
  };
  const provider = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(404).end(); return; }
    try {
      let raw = '';
      for await (const chunk of request) { raw += chunk; assert.ok(Buffer.byteLength(raw) <= 2 * 1024 * 1024); }
      const input = JSON.parse(raw);
      const user = input.messages.filter(message => message.role === 'user').map(text);
      const phase = user.filter(value => value === ENQUEUE || value === WAKE).at(-1) === WAKE ? 2 : 1;
      const source = user.includes(ENQUEUE) || user.includes(WAKE);
      const lastTool = [...input.messages].reverse().find(message => message.role === 'tool');
      const output = message => { assert.ok(message, 'original tool result exists'); return JSON.parse(text(message)); };
      const sendOutput = message => {
        try { return output(message); }
        catch (error) {
          const encoded = text(message).match(/^Tool `SendSessionMessage` execution failed: (\{[^\n]+\})\.(?:\n|$)/)?.[1];
          if (!encoded) throw error;
          const original = JSON.parse(encoded); unconfirmed.push(original);
          assert.equal(original.status, 'unknown'); assert.match(original.clientMessageId, /^peer-[a-f0-9]{64}$/);
          // Query only this original ID. An error never becomes a receipt or a resend.
          return { clientMessageId: original.clientMessageId, status: 'unknown' };
        }
      };
      const tool = (id, name, value) => ({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(value) } }] });
      let delta, finish = 'stop';
      if (source) {
        const key = phase === 1 ? 'sourceEnqueue' : 'sourceWake'; assert.ok(++calls[key] <= 7);
        if (!lastTool || !lastTool.tool_call_id.startsWith(`cold-${phase}-`)) {
          delta = tool(`cold-${phase}-list`, 'ListSessions', {}); finish = 'tool_calls';
        } else if (lastTool.tool_call_id.endsWith('-list')) {
          const listing = output(lastTool); directoryPages.push({ phase, listing });
          const targets = listing.targets;
          const target = destination ? targets.find(row => row.threadId === destination.threadId) : targets[0];
          assert.ok(target && target.archivedAt == null);
          assert.equal(target.threadId, originalThread);
          assert.equal(target.presence, 'not_resident');
          if (seedTurns === 1) assert.equal(target.lastTurn?.status, 'completed');
          else { assert.equal(target.status, 'unknown'); assert.ok(target.lastTurn == null); }
          assert.ok(target.allowedModes.includes(phase === 1 ? 'enqueue_only' : 'wake_if_idle'));
          if (destination) assert.deepEqual(target.address, destination);
          destination = target.address;
          delta = tool(`cold-${phase}-send`, 'SendSessionMessage', { targetThreadId: destination.threadId,
            targetAddress: destination, mode: phase === 1 ? 'enqueue_only' : 'wake_if_idle', text: BODY(phase) }); finish = 'tool_calls';
        } else if (lastTool.tool_call_id.endsWith('-send')) {
          const receipt = sendOutput(lastTool); assert.ok(['queued', 'delivering', 'applied', 'unknown'].includes(receipt.status));
          receipts.set(phase, receipt);
          delta = tool(`cold-${phase}-get-0`, 'GetSessionMessageReceipt', { clientMessageId: receipt.clientMessageId }); finish = 'tool_calls';
        } else if (text(lastTool).startsWith('Tool `GetSessionMessageReceipt` execution failed:')) {
          assert.ok(lastTool.tool_call_id.endsWith('-get-0'), 'only one transient receipt read may be retried');
          const clientMessageId = receipts.get(phase).clientMessageId;
          unconfirmed.push({ operation: 'get_receipt', clientMessageId, status: 'unknown' });
          await new Promise(resolve => setTimeout(resolve, 250));
          delta = tool(`cold-${phase}-get-retry`, 'GetSessionMessageReceipt', { clientMessageId }); finish = 'tool_calls';
        } else {
          const result = output(lastTool).receipt; assert.ok(result);
          if (receipts.get(phase).messageId) assert.equal(result.messageId, receipts.get(phase).messageId);
          assert.equal(result.clientMessageId, receipts.get(phase).clientMessageId);
          assert.deepEqual(result.targetAddress, destination);
          if (phase === 1) assert.equal(result.status, 'queued');
          if (phase === 2 && result.status !== 'applied') {
            assert.ok(lastTool.tool_call_id.endsWith('-get-0') || lastTool.tool_call_id.endsWith('-get-retry'), 'one original-ID reconciliation is bounded');
            await waitFor(async () => calls.targetWake === 2 && (await rows()).some(row => text(row.message ?? row) === TARGET_DONE),
              options.timeoutMs, 'cold target original model result durable');
            delta = tool(`cold-${phase}-get-1`, 'GetSessionMessageReceipt', { clientMessageId: result.clientMessageId }); finish = 'tool_calls';
          } else {
            if (phase === 2) assert.equal(result.status, 'applied');
            receipts.set(phase, result); delta = { role: 'assistant', content: SOURCE_DONE(phase) };
          }
        }
      } else {
        const reference = input.messages.flatMap(message => typeof message.content === 'string' ? [message.content] : (message.content ?? []).map(block => block.text ?? ''))
          .filter(value => value.includes('"kind":"untrusted_peer_agent_reference"'))
          .map(value => JSON.parse(value.slice(value.indexOf('{')))).find(value => value.text === BODY(2));
        if (!reference) {
          assert.ok(++calls.seed <= seedTurns);
          assert.equal(user.at(-1), seedInput(calls.seed));
          delta = { role: 'assistant', content: seedOutput(calls.seed) };
        }
        else {
          assert.equal(reference.targetThreadId, destination.threadId); assert.ok(++calls.targetWake <= 2);
          if (calls.targetWake === 1) {
            delta = tool('cold-target-reply', 'SendSessionMessage', { targetThreadId: reference.sourceThreadId,
              targetAddress: reference.sourceAddress, mode: 'enqueue_only', text: REPLY }); finish = 'tool_calls';
          } else { reply = output(lastTool); assert.ok(['queued', 'delivering', 'applied'].includes(reply.status)); delta = { role: 'assistant', content: TARGET_DONE }; }
        }
      }
      const frame = (value, stop) => ({ id: 'owned-cold-target', object: 'chat.completion.chunk', model: input.model,
        choices: [{ index: 0, delta: value, finish_reason: stop }] });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(frame(delta, null))}\n\ndata: ${JSON.stringify(frame({}, finish))}\n\ndata: [DONE]\n\n`);
    } catch (error) { errors.push(String(error)); if (!response.headersSent) response.writeHead(400); response.end(); }
  });
  const open = async (label, resume) => {
    const directory = path.join(artifacts.dir, label); await mkdir(directory);
    const session = await runtime.startSession({ ...optionsForRun, runDir: directory,
      commandOverride: `${optionsForRun.commandOverride}${resume ? ` --resume ${resume}` : ''}` }); sessions.push(session);
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } }); pages.push(page);
    await page.goto(session.url);
    await page.waitForFunction(() => window.tuiLab?.ready && window.tuiLab.visibleText().includes('Ask KCoder'), null, { timeout: options.timeoutMs });
    assert.equal(await page.evaluate(() => window.tuiLab.renderer), 'webgl');
    const image = await stat(binary, { bigint: true }), actual = await stat(`/proc/${session.ptyProcess.pid}/exe`, { bigint: true });
    assert.equal(actual.dev, image.dev); assert.equal(actual.ino, image.ino);
    processes.push({ label, pid: session.ptyProcess.pid, resumedId: resume, executableDev: String(actual.dev), executableIno: String(actual.ino) });
    return { session, page };
  };
  return runBrowserScenarioLifecycle({
    execute: async () => {
      await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
      await mkdir(artifacts.configDir, { recursive: true });
      await json(path.join(artifacts.configDir, 'settings.json'), { active_provider: 'fixture', credential_store: 'file',
        permission_mode: 'yolo', max_retries: 0, cross_session_messages: { enabled: true, wake_idle: true },
        auto_memory_enabled: false, auto_tool_memory_enabled: false, session_memory: { enabled: false },
        providers: { fixture: { api_format: 'openai_chat_completions', endpoint: `http://127.0.0.1:${provider.address().port}/v1`,
          authentication: { mode: 'none' }, no_proxy: true, discover_models: false, default_model: 'owned-cold-target-fixture',
          context_window_tokens: 1048576, max_output_tokens: 8192, output_headroom_tokens: 8192 } } });
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
      optionsForRun = { ...options, repoRoot: runtime.repoRoot, workspaceDir: artifacts.workspace, configHome: artifacts.configHome,
        requestsDir: artifacts.requestsDir, commandOverride: `${quote(binary)} --cwd {workspace}` };
      await runtime.writeStartMeta(artifacts, { ...optionsForRun, runDir: artifacts.dir }, optionsForRun.commandOverride, options.scenario);
      const digest = createHash('sha256');
      await new Promise((resolve, reject) => createReadStream(binary).on('data', bytes => digest.update(bytes)).on('end', resolve).on('error', reject));
      binarySha256 = digest.digest('hex');
      assert.ok(!(process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX === '1' && process.env.KCODER_E2E_REQUIRE_CHROMIUM_SANDBOX === '1'));
      browser = await chromium.launch({ ...browserLaunchOptions(options),
        ...(process.env.KCODER_E2E_CHROMIUM_BIN ? { executablePath: process.env.KCODER_E2E_CHROMIUM_BIN } : {}),
        ...(process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX === '1' ? { chromiumSandbox: false } :
          process.env.KCODER_E2E_REQUIRE_CHROMIUM_SANDBOX === '1' ? { chromiumSandbox: true } : {}),
      });
      const target = await open('target-original');
      await submitTerminalLine(target.page, SEED);
      await target.page.waitForFunction(marker => window.tuiLab.visibleText().includes(marker) && !window.tuiLab.visibleText().toLowerCase().includes('esc interrupt'), SEED_DONE, { timeout: options.timeoutMs });
      for (let turn = 2; turn <= seedTurns; turn++) {
        await submitTerminalLine(target.page, seedInput(turn));
        await target.page.waitForFunction(marker => window.tuiLab.visibleText().includes(marker)
          && !window.tuiLab.visibleText().toLowerCase().includes('esc interrupt'), seedOutput(turn), { timeout: options.timeoutMs });
      }
      originalHistory = await findHistory(); leaseFile = originalHistory.replace(/\.jsonl$/, '.lease');
      historyOwnerRoot = originalHistory.startsWith(artifacts.configDir + path.sep) ? artifacts.configDir : artifacts.workspace;
      originalLease = await observeOwnedPeerSessionLease(leaseFile, historyOwnerRoot);
      assert.deepEqual(originalLease.holders.map(value => value.pid), [target.session.ptyProcess.pid]);
      await captureStep(target.page, trace, 'original-target-terminal-before-real-process-exit', path.join(artifacts.dir, 'target-original.png'));
      await target.session.stop(); await target.session.exitPromise;
      assert.deepEqual((await checkpoint('target-original-exited')).lease.holders, []);
      originalThread = path.basename(originalHistory, '.jsonl');
      const attemptDir = path.join(artifacts.workspace, '.kcoder', 'sessions', originalThread, 'turn-attempts');
      const attemptFiles = (await readdir(attemptDir, { withFileTypes: true }))
        .filter(entry => entry.name.endsWith('.attempt.json'));
      assert.equal(attemptFiles.length, seedTurns);
      const attempts = await Promise.all(attemptFiles.map(async entry => {
        assert.ok(entry.isFile() && !entry.isSymbolicLink());
        return JSON.parse(await readFile(path.join(attemptDir, entry.name), 'utf8'));
      }));
      for (const attempt of attempts) {
        assert.equal(attempt.identity.threadId, originalThread);
        assert.equal(attempt.status, 'completed');
        assert.equal(attempt.completion?.status, 'completed');
      }
      assert.equal(new Set(attempts.map(attempt => attempt.identity.attemptId)).size, seedTurns);
      initialLedger = { threadId: originalThread, completedAttempts: attempts.length };
      const source = await open('source-original');
      await submitTerminalLine(source.page, ENQUEUE);
      await waitFor(async () => { assert.deepEqual(errors, []); return source.page.evaluate(marker => window.tuiLab.visibleText().includes(marker), SOURCE_DONE(1)); },
        options.timeoutMs, 'the original Source enqueues once to the absent owner');
      await source.page.waitForTimeout(1200);
      assert.deepEqual(errors, []); assert.equal(calls.seed, seedTurns); assert.equal(calls.targetWake, 0);
      assert.deepEqual((await checkpoint('enqueue-only-original-owner-absent')).lease.holders, []);
      const resumed = await open('target-original-id-resumed', destination.threadId);
      await resumed.page.waitForFunction(marker => window.tuiLab.visibleText().includes(marker), BODY(1), { timeout: options.timeoutMs });
      assert.equal(calls.targetWake, 0); assert.equal(calls.seed, seedTurns);
      assert.deepEqual((await checkpoint('normal-resume-applies-enqueue-with-zero-model')).lease.holders.map(value => value.pid), [resumed.session.ptyProcess.pid]);
      await captureStep(resumed.page, trace, 'original-id-resume-shows-enqueue-without-a-new-user-or-model', path.join(artifacts.dir, 'target-resumed-enqueue.png'));
      await resumed.session.stop(); await resumed.session.exitPromise;
      assert.deepEqual((await checkpoint('resumed-target-exited-before-wake')).lease.holders, []);
      await submitTerminalLine(source.page, WAKE);
      await waitFor(async () => { assert.deepEqual(errors, []); return source.page.evaluate(marker => window.tuiLab.visibleText().includes(marker)
        && !window.tuiLab.visibleText().toLowerCase().includes('esc interrupt'), SOURCE_DONE(2)); }, options.timeoutMs, 'the original cold Wake receipt settles');
      await source.page.waitForFunction(marker => window.tuiLab.visibleText().includes(marker), REPLY, { timeout: options.timeoutMs });
      await waitFor(async () => (await observeOwnedPeerSessionLease(leaseFile, historyOwnerRoot)).holders.length === 0,
        options.timeoutMs, 'the owned cold dispatcher releases its original target lease');
      const completed = await checkpoint('cold-wake-reply-complete-and-original-lease-released');
      assert.deepEqual(errors, []); assert.deepEqual(calls, { seed: seedTurns, sourceEnqueue: calls.sourceEnqueue, sourceWake: calls.sourceWake, targetWake: 2 });
      assert.ok([4, 5].includes(calls.sourceEnqueue));
      assert.ok([4, 5, 6].includes(calls.sourceWake)); assert.ok(reply);
      const messages = completed.nativeRows.map(row => row.message ?? row);
      assert.deepEqual(messages.filter(message => message.origin === 'user').map(text),
        Array.from({ length: seedTurns }, (_, index) => seedInput(index + 1)));
      const sourceHistory = await findHistory(ENQUEUE);
      const sourceMessages = (await readFile(sourceHistory, 'utf8')).split('\n').filter(Boolean).map(line => { const row = JSON.parse(line); return row.message ?? row; });
      assert.deepEqual(sourceMessages.filter(message => message.origin === 'user').map(text), [ENQUEUE, WAKE]);
      assert.equal(sourceMessages.filter(message => message.origin === 'peer_agent' && text(message) === REPLY).length, 1);
      const sourceReply = sourceMessages.find(message => message.origin === 'peer_agent' && text(message) === REPLY);
      assert.equal(sourceReply.agent_message.messageId, reply.messageId);
      assert.equal(sourceReply.agent_message.sourceThreadId, destination.threadId);
      const peers = messages.filter(message => message.origin === 'peer_agent'); assert.equal(peers.length, 2);
      for (let phase = 1; phase <= 2; phase++) {
        const peer = peers.find(message => text(message) === BODY(phase)); assert.ok(peer);
        assert.equal(peer.agent_message.messageId, receipts.get(phase).messageId);
        assert.equal(peer.agent_message.targetThreadId, destination.threadId);
        assert.equal(peer.agent_message.bodySha256, createHash('sha256').update(BODY(phase)).digest('hex'));
      }
      assert.equal(source.session.getExitInfo(), null);
      await captureStep(source.page, trace, 'cold-target-replied-to-the-original-live-source', path.join(artifacts.dir, 'source-received-cold-reply.png'));
      return { binarySha256, realPty: true, renderer: 'webgl', originalTarget: destination, processes,
        providerRequests: calls, receipts: Object.fromEntries(receipts), directoryPages, unconfirmed, reply, originalHistory, snapshots, initialLedger,
        realTargetExits: 2, zeroModelOnEnqueueAndManualResume: true, originalArtifactLeaseIdentityPreserved: true,
        coldTargetWakeAndReply: true, originalUserTurns: seedTurns, noFabricatedTargetUser: true, loopbackProviderOnly: true };
    },
    captureBeforeCleanup: async () => {
      for (let index = 0; index < sessions.length; index++) {
        await writeFile(path.join(artifacts.dir, `${index}.pty.log`), sessions[index].getPtyLog());
        await writeFile(path.join(artifacts.dir, `${index}.screen.txt`), await pages[index]?.evaluate(() => window.tuiLab?.visibleText() ?? '').catch(() => '') ?? '');
      }
      await json(path.join(artifacts.dir, 'native-history-and-lease-checkpoints.json'), snapshots);
    },
    cleanup: async () => {
      const report = await cleanupOwnedBrowserSessions({ browser, sessions });
      report.steps.push(await settleLifecycleStep('owned-cold-loopback-provider', () => new Promise(resolve => { provider.closeAllConnections(); provider.close(resolve); })));
      return report;
    },
    onFailure: async error => { await json(path.join(artifacts.dir, 'failure.json'), { error: String(error), errors, calls,
      receipts: Object.fromEntries(receipts), directoryPages, unconfirmed, reply, snapshots, initialLedger, processes, cleanup: error.cleanup }); console.error(artifacts.dir); },
    onSuccess: async (result, cleanup) => { await verifyRunContextIntegrity(artifacts, runtime.runContextRuntime());
      await json(artifacts.assertions, { ok: true, ...result }); await json(artifacts.meta, { result, cleanup, trace }); console.log(artifacts.dir); },
  });
}
