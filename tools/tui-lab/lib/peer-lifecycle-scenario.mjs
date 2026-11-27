import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { startPeerDeviceGateway } from '../../../apps/kcoder-studio/e2e/harness/peer-device-gateway.mjs';
import { waitFor } from '../../../apps/kcoder-studio/e2e/harness/run-context.mjs';
import { createRunContext, verifyRunContextIntegrity } from './run-context.mjs';
import { browserLaunchOptions } from './runner-options.mjs';
import { submitTerminalLine } from './terminal-interaction.mjs';
import { captureStep } from './browser-evidence.mjs';
import { runBrowserScenarioLifecycle, cleanupOwnedBrowserSessions, settleLifecycleStep } from './browser-lifecycle.mjs';

const trigger = phase => `OWNED_PEER_LIFECYCLE_USER_${phase}`;
const bodyText = phase => `OWNED_PEER_LIFECYCLE_BODY_${phase}`;
const finished = phase => `OWNED_PEER_LIFECYCLE_DONE_${phase}`;
const blocks = message => typeof message.content === 'string' ? message.content :
  (message.content ?? []).map(block => block.text ?? '').join('');

/** One actual TUI keeps its PID across clear and provider replacement. The
 * other TUI remains the original enqueue-only receiver throughout the case.
 */
export async function runPeerLifecycleScenario(options, runtime) {
  assert.equal(process.platform, 'linux');
  const binary = process.env.KCODER_E2E_KCODER_BIN;
  assert.ok(binary && path.isAbsolute(binary));
  const routed = options.scenario === 'peer-lifecycle-gateway';
  const artifacts = await createRunContext(options, 'peer-lifecycle', runtime.runContextRuntime());
  const sessions = [], pages = [], trace = [], errors = [], observations = [], historyCheckpoints = [], receipts = new Map(), calls = new Map();
  let browser, gateway, destination, successful = false, oldHistory, oldBytes, oldAtHandoff;
  const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
  const checkpointHistory = (stage, bytes) => {
    const rows = bytes.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    historyCheckpoints.push({ stage, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      rows: rows.map(row => { const message = row.message ?? row; return { sessionId: row.session_id,
        role: message.role, origin: message.origin,
        content: typeof message.content === 'string' ? message.content : (message.content ?? []).map(block => ({
          type: block.type, id: block.id, toolUseId: block.tool_use_id, name: block.name,
          ...(block.type === 'text' ? { text: block.text } : {}) })) }; }) });
  };
  const histories = async () => {
    const found = [];
    const visit = async (directory, depth = 0) => {
      if (depth > 8) return;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory() && !/^(?:checkpoints|context-history|llm-history|snapshots|archives|builtin-skills|skills|attachments|requests|cache|logs)$/.test(entry.name)) await visit(file, depth + 1);
        else if (entry.name.endsWith('.jsonl') && !entry.name.endsWith('.exit.jsonl')) found.push(file);
      }
    };
    await visit(artifacts.configDir); await visit(artifacts.workspace);
    return found;
  };
  const provider = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(404).end(); return; }
    try {
      let raw = '';
      for await (const chunk of request) { raw += chunk; assert.ok(Buffer.byteLength(raw) <= 2 * 1024 * 1024); }
      const input = JSON.parse(raw);
      const latest = [...input.messages].reverse().find(message => message.role === 'user');
      const phase = Number(blocks(latest).match(/^OWNED_PEER_LIFECYCLE_USER_([123])$/)?.[1]);
      assert.ok([1, 2, 3].includes(phase), 'enqueue-only receiver must never request a Provider');
      assert.equal(input.model, phase === 3 ? 'owned-peer-model-two' : 'owned-peer-model-one');
      const number = (calls.get(phase) ?? 0) + 1; calls.set(phase, number); assert.ok(number <= 4);
      if (phase === 2 && number === 1) {
        // This request is emitted only after the new interactive binding has
        // retired its original writer. Freeze before any replacement work.
        oldAtHandoff = await readFile(oldHistory);
        checkpointHistory('replacement-provider-entry', oldAtHandoff);
      }
      const output = id => {
        const result = input.messages.find(message => message.role === 'tool' && message.tool_call_id === id);
        assert.ok(result); return JSON.parse(blocks(result));
      };
      const tool = (id, name, value) => ({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(value) } }] });
      let delta, finish = 'tool_calls';
      if (number === 1) {
        for (const name of ['ListSessions', 'SendSessionMessage', 'GetSessionMessageReceipt']) assert.ok(input.tools.some(tool => tool.function?.name === name));
        delta = tool(`lifecycle-list-${phase}`, 'ListSessions', {});
      } else if (number === 2) {
        const listing = output(`lifecycle-list-${phase}`);
        const live = listing.targets.filter(target => target.presence === 'resident' && target.allowedModes.includes('enqueue_only'));
        assert.equal(live.length, 1, 'old cleared history cannot advertise a live writer');
        if (destination) assert.deepEqual(live[0].address, destination);
        destination = live[0].address;
        delta = tool(`lifecycle-send-${phase}`, 'SendSessionMessage', { targetThreadId: destination.threadId,
          targetAddress: destination, mode: 'enqueue_only', text: bodyText(phase) });
      } else if (number === 3) {
        const receipt = output(`lifecycle-send-${phase}`); receipts.set(phase, receipt);
        assert.ok(['queued', 'delivering', 'applied'].includes(receipt.status));
        await pages[1].waitForFunction(marker => window.tuiLab.visibleText().includes(marker), bodyText(phase), { timeout: options.timeoutMs });
        delta = tool(`lifecycle-get-${phase}`, 'GetSessionMessageReceipt', { clientMessageId: receipt.clientMessageId });
      } else {
        const receipt = output(`lifecycle-get-${phase}`).receipt;
        assert.equal(receipt.status, 'applied'); assert.equal(receipt.messageId, receipts.get(phase).messageId);
        if (phase === 1) {
          oldHistory = (await histories()).find(file => path.basename(file) === `${receipt.sourceAddress.threadId}.jsonl`);
          assert.ok(oldHistory);
          await waitFor(async () => (await readFile(oldHistory, 'utf8')).includes('"tool_use_id":"lifecycle-get-1"'),
            options.timeoutMs, 'original phase-one receipt tool result persisted before final Provider response', 20);
        }
        receipts.set(phase, receipt); delta = { role: 'assistant', content: finished(phase) }; finish = 'stop';
      }
      observations.push({ phase, number, model: input.model });
      const frame = (delta, finish_reason) => ({ id: 'owned-lifecycle', object: 'chat.completion.chunk', model: input.model,
        choices: [{ index: 0, delta, finish_reason }] });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(frame(delta, null))}\n\ndata: ${JSON.stringify(frame({}, finish))}\n\ndata: [DONE]\n\n`);
    } catch (error) { errors.push(String(error)); if (!response.headersSent) response.writeHead(400); response.end(); }
  });
  return runBrowserScenarioLifecycle({
    execute: async () => {
      await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
      const profile = model => ({ api_format: 'openai_chat_completions', endpoint: `http://127.0.0.1:${provider.address().port}/v1`,
        authentication: { mode: 'none' }, no_proxy: true, discover_models: false, default_model: model,
        context_window_tokens: 1048576, max_output_tokens: 8192, output_headroom_tokens: 8192 });
      await mkdir(artifacts.configDir, { recursive: true });
      await json(path.join(artifacts.configDir, 'settings.json'), { active_provider: 'first', credential_store: 'file',
        permission_mode: 'yolo', max_retries: 0, cross_session_messages: { enabled: true, wake_idle: true },
        auto_memory_enabled: false, auto_tool_memory_enabled: false, session_memory: { enabled: false },
        providers: { first: profile('owned-peer-model-one'), second: profile('owned-peer-model-two') } });
      if (routed) gateway = await startPeerDeviceGateway({ binary, profile: artifacts.configDir, workspace: artifacts.workspace, parentArtifacts: artifacts.dir });
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
      const runOptions = { ...options, repoRoot: runtime.repoRoot, workspaceDir: artifacts.workspace,
        configHome: artifacts.configHome, requestsDir: artifacts.requestsDir,
        commandOverride: `${quote(binary)} --cwd {workspace}${gateway ? ` --peer-gateway-server ${gateway.alias}` : ''}` };
      await runtime.writeStartMeta(artifacts, { ...runOptions, runDir: artifacts.dir }, runOptions.commandOverride, options.scenario);
      browser = await chromium.launch(browserLaunchOptions(options));
      const image = await stat(binary, { bigint: true }), digest = createHash('sha256');
      await new Promise((resolve, reject) => createReadStream(binary).on('data', bytes => digest.update(bytes)).on('end', resolve).on('error', reject));
      const binarySha256 = digest.digest('hex');
      for (const label of ['source', 'receiver']) {
        const directory = path.join(artifacts.dir, label); await mkdir(directory);
        const session = await runtime.startSession({ ...runOptions, runDir: directory }); sessions.push(session);
        const page = await browser.newPage({ viewport: { width: 1100, height: 760 } }); pages.push(page); await page.goto(session.url);
        await page.waitForFunction(() => window.tuiLab?.ready && window.tuiLab.visibleText().includes('Ask KCoder'), null, { timeout: options.timeoutMs });
        assert.equal(await page.evaluate(() => window.tuiLab.renderer), 'webgl');
        const actual = await stat(`/proc/${session.ptyProcess.pid}/exe`, { bigint: true });
        assert.equal(actual.dev, image.dev); assert.equal(actual.ino, image.ino);
      }
      const phase = async number => {
        await submitTerminalLine(pages[0], trigger(number));
        await pages[0].waitForFunction(marker => window.tuiLab.visibleText().includes(marker) &&
          !window.tuiLab.visibleText().toLowerCase().includes('esc interrupt'), finished(number), { timeout: options.timeoutMs });
        assert.deepEqual(errors, []);
      };
      await phase(1);
      const oldId = receipts.get(1).sourceAddress.threadId;
      oldHistory = (await histories()).find(file => path.basename(file) === `${oldId}.jsonl`);
      assert.ok(oldHistory);
      oldBytes = await waitFor(async () => {
        const bytes = await readFile(oldHistory);
        let rows;
        try { rows = bytes.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); }
        catch { return null; }
        // Painted completion may precede the asynchronous tool-result flush.
        // Freeze the complete tool round trip; only its final DONE may drain.
        return rows.some(row => (row.message ?? row).content?.some?.(block => block.type === 'tool_result'
          && block.tool_use_id === 'lifecycle-get-1')) ? bytes : null;
      }, options.timeoutMs, 'original phase-one receipt result durable before clear');
      checkpointHistory('before-clear', oldBytes);
      await submitTerminalLine(pages[0], '/clear');
      await pages[0].waitForFunction(() => window.tuiLab.visibleText().includes('Conversation cleared.'), null, { timeout: options.timeoutMs });
      await phase(2);
      assert.notEqual(receipts.get(2).sourceAddress.threadId, oldId);
      assert.ok(oldAtHandoff);
      assert.ok(oldAtHandoff.subarray(0, oldBytes.length).equals(oldBytes), 'clear preserves the append-only original prefix');
      const originalRows = oldAtHandoff.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
      assert.ok(originalRows.every(row => row.session_id === oldId), 'the original writer never borrows the replacement SID');
      const originalDone = originalRows.filter(row => { const message = row.message ?? row; return message.role === 'assistant' && blocks(message) === finished(1); });
      assert.equal(originalDone.length, 1, 'the original completion is durable exactly once before the replacement Provider');
      const suffix = oldAtHandoff.subarray(oldBytes.length).toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
      assert.ok(suffix.length <= 1 && suffix.every(row => { const message = row.message ?? row; return message.role === 'assistant' && blocks(message) === finished(1); }),
        'only the original pending phase-one completion may finish during clear');
      const afterPhaseTwo = await readFile(oldHistory); checkpointHistory('phase-two-complete', afterPhaseTwo);
      assert.deepEqual(afterPhaseTwo, oldAtHandoff, 'phase-two work cannot append to the retired history');
      await submitTerminalLine(pages[0], '/model second');
      await pages[0].waitForFunction(() => window.tuiLab.visibleText().includes('Model switched to: owned-peer-model-two'), null, { timeout: options.timeoutMs });
      await phase(3);
      assert.deepEqual(receipts.get(2).sourceAddress, receipts.get(3).sourceAddress);
      const afterPhaseThree = await readFile(oldHistory); checkpointHistory('phase-three-complete', afterPhaseThree);
      assert.deepEqual(afterPhaseThree, oldAtHandoff, 'the retired writer cannot append after its authoritative handoff');
      const peerRows = [];
      for (const file of await histories()) for (const line of (await readFile(file, 'utf8')).split('\n').filter(Boolean)) {
        const raw = JSON.parse(line), message = raw.message ?? raw;
        if (message.origin === 'peer_agent' && [...receipts.values()].some(receipt => receipt.messageId === message.agent_message?.messageId)) peerRows.push(message);
      }
      assert.equal(peerRows.length, 3); assert.deepEqual(Object.fromEntries(calls), { 1: 4, 2: 4, 3: 4 });
      for (const session of sessions) assert.equal(session.getExitInfo(), null);
      await captureStep(pages[0], trace, 'same-native-process-after-clear-and-provider-switch', path.join(artifacts.dir, 'source-rebound.png'));
      await captureStep(pages[1], trace, 'original-receiver-three-unique-peer-rows', path.join(artifacts.dir, 'receiver-original.png'));
      successful = true;
      return { binarySha256, realPty: true, renderer: 'webgl', actualGateway: routed, gatewayEvidence: gateway?.artifacts,
        originalPids: sessions.map(session => session.ptyProcess.pid), receipts: Object.fromEntries(receipts),
        providerRequests: Object.fromEntries(calls), peerRows: peerRows.length, originalHistoryPrefixPreserved: true,
        originalHistoryStableAfterHandoff: true, originalDrainBytes: oldAtHandoff.length - oldBytes.length,
        actualClear: true, actualProviderSwitch: true, noReceiverProviderOrUser: true, loopbackProviderOnly: true };
    },
    captureBeforeCleanup: async () => {
      for (let index = 0; index < pages.length; index++) {
        await writeFile(path.join(artifacts.dir, `${index}.screen.txt`), await pages[index].evaluate(() => window.tuiLab?.visibleText() ?? '').catch(() => ''));
        await writeFile(path.join(artifacts.dir, `${index}.pty.log`), sessions[index].getPtyLog());
      }
      await json(path.join(artifacts.dir, 'provider-observations.json'), observations);
      await json(path.join(artifacts.dir, 'history-checkpoints.json'), historyCheckpoints);
    },
    cleanup: async () => {
      const report = await cleanupOwnedBrowserSessions({ browser, sessions });
      if (gateway) report.steps.push(await settleLifecycleStep('owned-lifecycle-gateway', () => gateway.finish(successful ? undefined : new Error('Lifecycle parent did not complete'))));
      report.steps.push(await settleLifecycleStep('owned-lifecycle-provider', () => new Promise(resolve => { provider.closeAllConnections(); provider.close(resolve); })));
      return report;
    },
    onFailure: async error => { await json(path.join(artifacts.dir, 'failure.json'), { error: String(error), errors, observations,
      cleanup: error.cleanup, cleanupError: error.cleanupError && String(error.cleanupError),
      historyCheckpoints, receipts: Object.fromEntries(receipts) }); console.error(artifacts.dir); },
    onSuccess: async (result, cleanup) => { await verifyRunContextIntegrity(artifacts, runtime.runContextRuntime());
      await json(artifacts.assertions, { ok: true, ...result }); await json(artifacts.meta, { result, cleanup, trace }); console.log(artifacts.dir); },
  });
}
