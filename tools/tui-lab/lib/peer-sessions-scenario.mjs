import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readlink, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { startPeerDeviceGateway } from '../../../apps/kcoder-studio/e2e/harness/peer-device-gateway.mjs';
import { createRunContext, verifyRunContextIntegrity } from './run-context.mjs';
import { browserLaunchOptions } from './runner-options.mjs';
import { submitTerminalLine, pressTerminalEscape } from './terminal-interaction.mjs';
import { waitFor } from '../../../apps/kcoder-studio/e2e/harness/run-context.mjs';
import { createExpectedTurnProtocol, EXPECTED_TARGET, EXPECTED_TARGET_CANCEL, EXPECTED_END_DONE, EXPECTED_CANCEL_DONE } from './peer-expected-turn-protocol.mjs';
import { attachBrowserConsole, captureStep, formatBrowserConsole } from './browser-evidence.mjs';
import { runBrowserScenarioLifecycle, cleanupOwnedBrowserSessions, settleLifecycleStep } from './browser-lifecycle.mjs';

const TRIGGER = 'OWNED_SENDER_TRIGGER';
const PEER = 'OWNED_CROSS_SESSION_PEER_BODY';
const ACK = 'OWNED_PEER_RECEIVER_REPLIED';
const BACK = 'OWNED_CROSS_SESSION_RETURN_ACK';
const SENT = 'OWNED_SOURCE_SEND_COMPLETE';

// Fixed loopback model frames isolate routing, actual Native owners and UI lifecycle.
// They do not establish model reasoning quality or any other platform's behavior.
export async function runPeerSessionsScenario(options, runtime) {
  assert.equal(process.platform, 'linux', 'this independent PTY carrier proof currently requires Linux');
  const renewal = options.scenario === 'peer-sessions-gateway-renewal';
  const expectedTurn = options.scenario.endsWith('-expected-turn');
  const useGateway = options.scenario.startsWith('peer-sessions-gateway');
  let renewalEvidence;
  let deviceGateway, scenarioFailure = new Error('Parent TUI proof did not reach its successful assertions');
  const artifacts = await createRunContext(options, 'peer-sessions', runtime.runContextRuntime());
  const sessions = [], pages = [], trace = [], errors = [], observations = [], browserConsole = [], executables = [];
  let browser, requests = 0, receipt, backReceipt, destination, sourceAddress, sourceRequests = 0, receiverRequests = 0, discoveryCoverage;
  let releaseSourceIdle;
  const sourceIdle = new Promise(resolve => { releaseSourceIdle = resolve; });
  const expectedProtocol = expectedTurn ? createExpectedTurnProtocol({ sourceIdle, peer: PEER, sent: SENT, acknowledged: ACK }) : null;
  const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(404).end(); return; }
    try {
      let raw = '';
      for await (const chunk of request) { raw += chunk; assert.ok(Buffer.byteLength(raw) <= 2 * 1024 * 1024); }
      const body = JSON.parse(raw), context = JSON.stringify(body.messages);
      assert.ok(++requests <= (expectedTurn ? 13 : 5), 'the fixture never permits a message ping-pong or regeneration loop');
      assert.equal(body.model, 'owned-peer-fixture');
      const isSource = context.includes(TRIGGER);
      const number = isSource ? ++sourceRequests : ++receiverRequests;
      observations.push({ request: requests, role: isSource ? 'source' : 'receiver', number,
        hasPeerBody: context.includes(PEER), hasLowTrustEnvelope: context.includes('untrusted_peer_agent_reference') });
      let delta, finish;
      const call = (id, name, input) => ({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] });
      const output = id => {
        const row = body.messages.find(message => message.role === 'tool' && message.tool_call_id === id);
        assert.ok(row, `actual ${id} result is required`);
        return JSON.parse(typeof row.content === 'string' ? row.content : row.content.map(block => block.text ?? '').join(''));
      };
      if (expectedProtocol) {
        const result = await expectedProtocol.respond({ isSource, number, context, response, call, output });
        if (!result) return;
        ({ delta, finish } = result);
        const actual = expectedProtocol.snapshot();
        if (actual.receipt) ({ receipt, sourceAddress, destination } = actual);
      } else if (isSource && number === 1) {
        for (const name of ['ListSessions', 'SendSessionMessage', 'GetSessionMessageReceipt']) assert.ok(body.tools.some(tool => tool.function?.name === name));
        delta = call('discover-real-peer', 'ListSessions', {}); finish = 'tool_calls';
      } else if (isSource && number === 2) {
        const listing = output('discover-real-peer');
        discoveryCoverage = listing.coverage;
        if (useGateway) assert.equal(listing.coverage, 'workspace_history');
        else assert.ok(['resident_only', 'workspace_history'].includes(listing.coverage));
        assert.equal(listing.targets.length, 1, 'only the other actual independent TUI is in this owned scope');
        const target = listing.targets[0]; destination = target.address;
        assert.equal(target.presence, 'resident'); assert.equal(target.status, 'idle');
        assert.equal(destination.threadId, target.threadId);
        assert.ok(target.allowedModes.includes('wake_if_idle'));
        delta = call('send-real-peer', 'SendSessionMessage', { targetThreadId: target.threadId, targetAddress: destination, mode: 'wake_if_idle', text: PEER }); finish = 'tool_calls';
      } else if (isSource && number === 3) {
        receipt = output('send-real-peer');
        assert.ok(['queued', 'delivering', 'applied'].includes(receipt.status));
        assert.equal(receipt.targetThreadId, destination.threadId);
        sourceAddress = receipt.sourceAddress;
        assert.ok(sourceAddress && sourceAddress.threadId !== destination.threadId);
        delta = { role: 'assistant', content: SENT }; finish = 'stop';
      } else {
        assert.ok(!isSource, 'an enqueue-only reply cannot request another source Provider step');
        assert.ok(context.includes(PEER) && context.includes('untrusted_peer_agent_reference'), 'API delivery must preserve the lower-trust envelope');
        assert.ok(!context.includes(TRIGGER), 'the source user prompt is never copied as a target user input');
        if (number === 1) {
          await sourceIdle;
          const quoted = body.messages.flatMap(message => typeof message.content === 'string' ? [message.content] : (message.content ?? []).map(block => block.text ?? ''))
            .filter(text => text.includes('"kind":"untrusted_peer_agent_reference"')).map(text => JSON.parse(text.slice(text.indexOf('{'))))
            .find(value => value.kind === 'untrusted_peer_agent_reference' && value.text === PEER);
          assert.ok(quoted?.sourceAddress, 'the real received Peer envelope supplies the reply selector');
          assert.deepEqual(quoted.sourceAddress, sourceAddress);
          delta = call('reply-to-real-source', 'SendSessionMessage', { targetThreadId: quoted.sourceThreadId, targetAddress: quoted.sourceAddress, mode: 'enqueue_only', text: BACK }); finish = 'tool_calls';
        } else {
          assert.equal(number, 2);
          backReceipt = output('reply-to-real-source');
          assert.ok(['queued', 'delivering', 'applied'].includes(backReceipt.status));
          assert.equal(backReceipt.targetThreadId, sourceAddress.threadId);
          delta = { role: 'assistant', content: ACK }; finish = 'stop';
        }
      }
      const frame = (value, stop) => ({ id: 'owned-peer-frame', object: 'chat.completion.chunk', model: body.model,
        choices: [{ index: 0, delta: value, finish_reason: stop }] });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(frame(delta, null))}\n\ndata: ${JSON.stringify(frame({}, finish))}\n\ndata: [DONE]\n\n`);
    } catch (error) { errors.push(String(error)); if (!response.headersSent) response.writeHead(400); response.end(); }
  });
  const runOptions = { ...options, repoRoot: runtime.repoRoot,
    commandOverride: options.commandOverride || '{repoRoot}/target/debug/kcoder --cwd {workspace}',
    workspaceDir: artifacts.workspace, configHome: artifacts.configHome, requestsDir: artifacts.requestsDir };
  return runBrowserScenarioLifecycle({
    execute: async () => {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      await mkdir(artifacts.configDir, { recursive: true });
      await json(path.join(artifacts.configDir, 'settings.json'), {
        active_provider: 'fixture', credential_store: 'file', permission_mode: 'yolo', max_retries: 0,
        cross_session_messages: { enabled: true, wake_idle: true },
        auto_memory_enabled: false, auto_tool_memory_enabled: false, session_memory: { enabled: false },
        providers: { fixture: { api_format: 'openai_chat_completions', endpoint: `http://127.0.0.1:${server.address().port}/v1`,
          authentication: { mode: 'none' }, no_proxy: true, discover_models: false, default_model: 'owned-peer-fixture',
          context_window_tokens: 1048576, max_output_tokens: 8192, output_headroom_tokens: 8192,
          capabilities: { text: true, tools: true, reasoning: false } } },
      });
      if (useGateway) {
        const binary = process.env.KCODER_E2E_KCODER_BIN;
        assert.ok(binary && path.isAbsolute(binary), 'Gateway PTY acceptance requires one fixed KCODER_E2E_KCODER_BIN');
        deviceGateway = await startPeerDeviceGateway({ binary, profile: artifacts.configDir,
          workspace: artifacts.workspace, parentArtifacts: artifacts.dir,
          ...(renewal ? { sourceOnlyNetworkFault: true, accessTtlMs: 3000, socketGraceMs: 1000 } : {}) });
        const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
        runOptions.commandOverride = `${quote(binary)} --cwd {workspace} --peer-gateway-server ${deviceGateway.alias}`;
      }
      await runtime.writeStartMeta(artifacts, { ...runOptions, runDir: artifacts.dir }, runOptions.commandOverride, options.scenario);
      browser = await chromium.launch({ ...browserLaunchOptions(options), ...(process.env.KCODER_E2E_CHROMIUM_BIN ? { executablePath: process.env.KCODER_E2E_CHROMIUM_BIN } : {}) });
      for (const label of ['source', 'receiver']) {
        const directory = path.join(artifacts.dir, label); await mkdir(directory);
        const session = await runtime.startSession({ ...runOptions, runDir: directory }); sessions.push(session);
        const page = await browser.newPage({ viewport: { width: 1100, height: 760 } }); pages.push(page);
        attachBrowserConsole(page, browserConsole); await page.goto(session.url);
        await page.waitForFunction(() => window.tuiLab?.ready && window.tuiLab.visibleText().includes('Ask KCoder'), null, { timeout: options.timeoutMs });
        assert.equal(await page.evaluate(() => window.tuiLab.renderer), 'webgl');
        const executablePath = `/proc/${session.ptyProcess.pid}/exe`, hash = createHash('sha256');
        await new Promise((resolve, reject) => createReadStream(executablePath).on('data', bytes => hash.update(bytes)).on('end', resolve).on('error', reject));
        executables.push({ label, pid: session.ptyProcess.pid, path: await readlink(executablePath), sha256: hash.digest('hex') });
      }
      if (deviceGateway) await deviceGateway.rememberCredentials();
      assert.notEqual(executables[0].pid, executables[1].pid);
      assert.equal(executables[0].sha256, executables[1].sha256);
      if (expectedTurn) assert.equal(executables[0].sha256, process.env.KCODER_E2E_KCODER_BIN_SHA256);
      assert.equal(requests, 0, 'two idle original sessions do not create synthetic bootstrap turns');
      if (renewal) {
        await deviceGateway.waitForPeerSockets(2);
        const began = performance.now();
        await pages[0].waitForTimeout(9000);
        const authorization = await deviceGateway.observeDeviceAuthorization();
        const network = deviceGateway.network.snapshot();
        assert.equal(authorization.httpStatus, 200); assert.equal(authorization.authorized, true);
        assert.equal(network.peerUpgrades, 2, 'renewal preserves the two original sockets without reconnecting');
        assert.equal(network.sourceConnected, true); assert.equal(network.receiverConnected, true);
        renewalEvidence = { originalAccessTtlMs: 3000, originalSocketGraceMs: 1000,
          elapsedMs: performance.now() - began, authorization, network,
          sameDeviceFamilySharedByTwoOwners: true, claim: 'owned credential renewal keeps live transport; not proof that a family already expired' };
      }
      await captureStep(pages[1], trace, 'receiver-original-idle', path.join(artifacts.dir, 'receiver-original-idle.png'));
      if (expectedTurn) {
        await submitTerminalLine(pages[1], EXPECTED_TARGET);
        await waitFor(() => receiverRequests === 1, options.timeoutMs, 'actual target Provider response held');
      }
      await submitTerminalLine(pages[0], `${TRIGGER}: discover the other permitted session and send one message.`);
      await pages[0].waitForFunction(marker => window.tuiLab.visibleText().includes(marker), SENT, { timeout: options.timeoutMs });
      await pages[0].waitForFunction(() => !window.tuiLab.visibleText().toLowerCase().includes('esc interrupt'), null, { timeout: options.timeoutMs });
      releaseSourceIdle();
      await pages[1].waitForFunction(marker => window.tuiLab.visibleText().includes(marker), ACK, { timeout: options.timeoutMs });
      await pages[1].waitForFunction(() => !window.tuiLab.visibleText().includes('esc interrupt'), null, { timeout: options.timeoutMs });
      if (expectedTurn) {
        await submitTerminalLine(pages[0], `${TRIGGER}: reconcile the same original CID and refuse a new old-turn CID.`);
        await pages[0].waitForFunction(marker => window.tuiLab.visibleText().includes(marker), EXPECTED_END_DONE, { timeout: options.timeoutMs });
        await pages[0].waitForFunction(() => !window.tuiLab.visibleText().toLowerCase().includes('esc interrupt'), null, { timeout: options.timeoutMs });
        await submitTerminalLine(pages[1], EXPECTED_TARGET_CANCEL);
        await waitFor(() => receiverRequests === 3, options.timeoutMs, 'actual second target turn held for cancellation');
        await submitTerminalLine(pages[0], `${TRIGGER}: observe the real next turn, then refuse its cancelled selector.`);
        await waitFor(() => expectedProtocol.selectorReady, options.timeoutMs, 'actual next target turn selector');
        await pressTerminalEscape(pages[1], process.platform);
        await pages[1].waitForFunction(() => !window.tuiLab.visibleText().toLowerCase().includes('esc interrupt'), null, { timeout: options.timeoutMs });
        expectedProtocol.releaseCancellation();
        await pages[0].waitForFunction(marker => window.tuiLab.visibleText().includes(marker), EXPECTED_CANCEL_DONE, { timeout: options.timeoutMs });
      } else {
        await pages[0].waitForFunction(marker => window.tuiLab.visibleText().includes(marker), BACK, { timeout: options.timeoutMs });
      }
      await pages[0].waitForTimeout(1200);
      assert.deepEqual(errors, []); assert.equal(sourceRequests, expectedTurn ? 10 : 3); assert.equal(receiverRequests, expectedTurn ? 3 : 2);
      const receiverText = await pages[1].evaluate(() => window.tuiLab.visibleText());
      assert.ok(receiverText.includes(PEER)); assert.ok(!receiverText.includes(TRIGGER));
      assert.ok(receiverText.includes('[Peer agent'), 'the actual TUI must distinguish a peer from its user');
      assert.ok(!receiverText.includes('Tool result unknown'));
      await captureStep(pages[0], trace, 'source-receipt-and-input-ready', path.join(artifacts.dir, 'source-complete.png'));
      await captureStep(pages[1], trace, 'receiver-peer-and-reply', path.join(artifacts.dir, 'receiver-complete.png'));
      const peers = [];
      const visit = async (directory, depth = 0) => {
        if (depth > 8) return;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) continue;
          const file = path.join(directory, entry.name);
          if (entry.isDirectory() && !/^(?:checkpoints|context-history|llm-history|snapshots|archives|builtin-skills|skills|attachments|requests|cache)$/.test(entry.name)) await visit(file, depth + 1);
          else if ([`${destination.threadId}.jsonl`, `${sourceAddress.threadId}.jsonl`].includes(entry.name) || entry.name === 'session.jsonl' && [destination.threadId, sourceAddress.threadId].includes(path.basename(directory))) for (const line of (await readFile(file, 'utf8')).split('\n').filter(Boolean)) {
            const value = JSON.parse(line), message = value.message ?? value;
            if (message && message.origin === 'peer_agent' && (expectedTurn || [receipt.messageId, backReceipt?.messageId].includes(message.agent_message?.messageId))) peers.push(message);
          }
        }
      };
      await visit(artifacts.configDir); await visit(artifacts.workspace);
      assert.equal(peers.length, expectedTurn ? 1 : 2, 'only the actual admitted peer envelopes appear in history');
      const delivered = peers.find(row => row.agent_message.messageId === receipt.messageId);
      const returned = peers.find(row => row.agent_message.messageId === backReceipt?.messageId);
      assert.equal(delivered.agent_message.sourceThreadId, sourceAddress.threadId);
      assert.equal(delivered.agent_message.targetThreadId, destination.threadId);
      if (!expectedTurn) {
        assert.equal(returned.agent_message.sourceThreadId, destination.threadId);
        assert.equal(returned.agent_message.targetThreadId, sourceAddress.threadId);
      }
      scenarioFailure = null;
      return { realPty: true, renderer: 'webgl', independentNativeProcesses: 2, sourceRequests, receiverRequests,
        nativeHistoryPeerRows: peers.length, enqueueOnlyReplyDoesNotWakeSource: true, noSyntheticReceiverUserPrompt: true, realTools: ['ListSessions', 'SendSessionMessage'],
        sourceAddress, destination, messageId: receipt.messageId, loopbackModelOnly: true,
        actualAuthenticatedGateway: useGateway, discoveryCoverage, renewalEvidence, expectedTurnOwnerEvidence: expectedProtocol?.snapshot(), gatewayEvidence: deviceGateway?.artifacts };
    },
    captureBeforeCleanup: async () => {
      for (let index = 0; index < pages.length; index++) {
        await writeFile(path.join(artifacts.dir, index === 0 ? 'source.screen.txt' : 'receiver.screen.txt'), await pages[index].evaluate(() => window.tuiLab?.visibleText() ?? '').catch(() => ''));
        await writeFile(path.join(artifacts.dir, index === 0 ? 'source.pty.log' : 'receiver.pty.log'), sessions[index].getPtyLog());
      }
      await json(path.join(artifacts.dir, 'request-observations.json'), observations);
      await writeFile(artifacts.browserConsoleLog, formatBrowserConsole(browserConsole));
    },
    cleanup: async () => {
      releaseSourceIdle(); expectedProtocol?.releaseCancellation();
      const report = await cleanupOwnedBrowserSessions({ browser, sessions });
      if (deviceGateway) report.steps.push(await settleLifecycleStep('owned-device-gateway', () => deviceGateway.finish(scenarioFailure)));
      report.steps.push(await settleLifecycleStep('owned-model-fixture', () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
      return report;
    },
    onFailure: async error => { await json(path.join(artifacts.dir, 'failure.json'), { error: String(error), errors, requests, sourceRequests, receiverRequests, executables, trace }); console.error(artifacts.dir); },
    onSuccess: async (result, cleanup) => {
      await verifyRunContextIntegrity(artifacts, runtime.runContextRuntime());
      await json(artifacts.assertions, { ok: true, ...result }); await json(artifacts.meta, { mode: 'peer-sessions', executables, result, trace, cleanup }); console.log(artifacts.dir);
    },
  });
}
