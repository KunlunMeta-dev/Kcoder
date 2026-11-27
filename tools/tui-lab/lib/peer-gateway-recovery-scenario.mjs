import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { startPeerDeviceGateway } from '../../../apps/kcoder-studio/e2e/harness/peer-device-gateway.mjs';
import { peerNotificationFacts } from '../../../apps/kcoder-studio/e2e/harness/peer-notification-facts.mjs';
import { createRunContext, verifyRunContextIntegrity } from './run-context.mjs';
import { browserLaunchOptions } from './runner-options.mjs';
import { submitTerminalLine } from './terminal-interaction.mjs';
import { attachBrowserConsole, captureStep, formatBrowserConsole } from './browser-evidence.mjs';
import { runBrowserScenarioLifecycle, cleanupOwnedBrowserSessions, settleLifecycleStep } from './browser-lifecycle.mjs';

const SOURCE = 'OWNED_WSS_SOURCE_USER';
const HOLD = 'OWNED_RECEIVER_FOREGROUND_HOLD';
const PEER = 'OWNED_DISPATCHED_PEER_SURVIVES_SOURCE_SOCKET';
const SOURCE_DONE = 'OWNED_SOURCE_MODEL_FINISHED';
const RECEIVER_DONE = 'OWNED_RECEIVER_PEER_MODEL_FINISHED';
const FOREGROUND_DONE = 'OWNED_RECEIVER_ORIGINAL_FOREGROUND_FINISHED';

/** Network loss and revocation use separate cases. The real receiver turn is
 * held at its actual loopback Provider response; no product authorization hook
 * or fake Source is introduced to force the queue into the desired state.
 */
export async function runPeerGatewayRecoveryScenario(options, runtime) {
  assert.equal(process.platform, 'linux');
  const exitOwner = options.scenario === 'peer-gateway-owner-expiry';
  let independentBrowser, browserThread, expiredTransportDevice;
  const revoke = options.scenario === 'peer-gateway-revoke';
  const localClose = options.scenario === 'peer-local-source-close';
  const local = localClose || options.scenario === 'peer-local-ttl';
  const ttl = options.scenario === 'peer-local-ttl' || options.scenario === 'peer-gateway-ttl';
  const noAppend = revoke || ttl;
  let expiredReceipt;
  const binary = process.env.KCODER_E2E_KCODER_BIN;
  assert.ok(binary && path.isAbsolute(binary), 'one frozen candidate is required');
  const artifacts = await createRunContext(options, 'peer-gateway-recovery', runtime.runContextRuntime());
  const sessions = [], pages = [], trace = [], errors = [], observations = [], browserConsole = [];
  let browser, gateway, receipt, destination, sourceAddress, authorityBefore, authorityAfter, nativeAppliedFacts;
  const originalTurnRefusals = [];
  let sourceCalls = 0, receiverCalls = 0, successful = false;
  let releaseReceiver, receiverStarted;
  const held = new Promise(resolve => { releaseReceiver = resolve; });
  const started = new Promise(resolve => { receiverStarted = resolve; });
  const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
  const provider = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(404).end(); return; }
    try {
      let bytes = '';
      for await (const chunk of request) { bytes += chunk; assert.ok(Buffer.byteLength(bytes) <= 2 * 1024 * 1024); }
      const body = JSON.parse(bytes), context = JSON.stringify(body.messages);
      const source = context.includes(SOURCE), number = source ? ++sourceCalls : ++receiverCalls;
      assert.ok(sourceCalls <= (ttl ? 11 : 3) && receiverCalls <= (noAppend || exitOwner ? 1 : 2), 'the case has a fixed Provider budget');
      observations.push({ source, number, peerBody: context.includes(PEER), lowTrust: context.includes('untrusted_peer_agent_reference') });
      const result = id => {
        const row = body.messages.find(message => message.role === 'tool' && message.tool_call_id === id);
        assert.ok(row, 'an actual tool result is required');
        return JSON.parse(typeof row.content === 'string' ? row.content : row.content.map(block => block.text ?? '').join(''));
      };
      const tool = (id, name, input) => ({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] });
      let delta, finish = 'stop';
      if (source && number === 1) { delta = tool('discover-held-receiver', 'ListSessions', {}); finish = 'tool_calls'; }
      else if (source && number === 2) {
        const page = result('discover-held-receiver');
        assert.equal(page.coverage, 'workspace_history');
        assert.equal(page.targets.length, 1);
        const target = page.targets[0]; destination = target.address;
        assert.equal(target.status, 'running');
        assert.ok(target.allowedModes.includes('enqueue_only'));
        delta = tool('dispatch-before-socket-loss', 'SendSessionMessage', {
          targetThreadId: target.threadId, targetAddress: destination, mode: 'enqueue_only', text: PEER,
        }); finish = 'tool_calls';
      } else if (source && number === 3) {
        receipt = result('dispatch-before-socket-loss');
        assert.equal(receipt.status, 'queued', 'the held target has not appended the dispatched operation yet');
        sourceAddress = receipt.sourceAddress;
        assert.equal(receiverCalls, 1);
        if (exitOwner || localClose) {
          delta = { role: 'assistant', content: SOURCE_DONE };
        } else if (ttl) {
          delta = tool('query-original-expiry-1', 'GetSessionMessageReceipt', { clientMessageId: receipt.clientMessageId });
          finish = 'tool_calls';
        } else {
        authorityBefore = await gateway.observeDeviceAuthorization();
        assert.equal(authorityBefore.authorized, true);
        if (revoke) {
          await gateway.revoke();
          authorityAfter = await gateway.observeDeviceAuthorization({ reloadFile: false });
          assert.equal(authorityAfter.authorized, false);
          assert.ok([401, 403].includes(authorityAfter.httpStatus));
        } else {
          gateway.network.closeSourceOnly();
          const network = gateway.network.snapshot();
          assert.equal(network.sourceDrops, 1);
          assert.equal(network.receiverConnectedAtSourceDrop, true);
          authorityAfter = await gateway.observeDeviceAuthorization();
          assert.equal(authorityAfter.authorized, true, 'transport loss must not revoke the device family');
        }
        releaseReceiver();
        delta = { role: 'assistant', content: SOURCE_DONE };
        }
      } else if (source && ttl) {
        const observed = result(`query-original-expiry-${number - 3}`)?.receipt;
        assert.ok(observed && observed.messageId === receipt.messageId && observed.clientMessageId === receipt.clientMessageId);
        if (observed.status === 'expired') {
          expiredReceipt = observed; releaseReceiver();
          delta = { role: 'assistant', content: SOURCE_DONE };
        } else {
          assert.ok(['queued', 'delivering'].includes(observed.status));
          await new Promise(resolve => setTimeout(resolve, 250));
          delta = tool(`query-original-expiry-${number - 2}`, 'GetSessionMessageReceipt', { clientMessageId: receipt.clientMessageId });
          finish = 'tool_calls';
        }
      } else if (!source && number === 1) {
        assert.ok(context.includes(HOLD) && !context.includes(PEER));
        receiverStarted(); await held;
        delta = { role: 'assistant', content: FOREGROUND_DONE };
      } else {
        assert.equal(noAppend, false);
        assert.equal(number, 2);
        assert.ok(context.includes(PEER) && context.includes('untrusted_peer_agent_reference'));
        assert.ok(!context.includes(SOURCE));
        delta = { role: 'assistant', content: RECEIVER_DONE };
      }
      const frame = (value, stop) => ({ id: 'owned-network-peer', object: 'chat.completion.chunk', model: body.model,
        choices: [{ index: 0, delta: value, finish_reason: stop }] });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(frame(delta, null))}\n\ndata: ${JSON.stringify(frame({}, finish))}\n\ndata: [DONE]\n\n`);
    } catch (error) { errors.push(String(error)); releaseReceiver(); if (!response.headersSent) response.writeHead(400); response.end(); }
  });
  return runBrowserScenarioLifecycle({
    execute: async () => {
      await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
      await mkdir(artifacts.configDir, { recursive: true });
      await json(path.join(artifacts.configDir, 'settings.json'), {
        active_provider: 'fixture', credential_store: 'file', permission_mode: 'yolo', max_retries: 0,
        cross_session_messages: { enabled: true, wake_idle: true, ...(ttl ? { message_ttl_seconds: 1 } : {}) },
        auto_memory_enabled: false, auto_tool_memory_enabled: false, session_memory: { enabled: false },
        providers: { fixture: { api_format: 'openai_chat_completions', endpoint: `http://127.0.0.1:${provider.address().port}/v1`,
          authentication: { mode: 'none' }, no_proxy: true, discover_models: false, default_model: 'owned-peer-network-fixture',
          context_window_tokens: 1048576, max_output_tokens: 8192, output_headroom_tokens: 8192 } },
      });
      if (!local) gateway = await startPeerDeviceGateway({ binary, profile: artifacts.configDir, workspace: artifacts.workspace,
        parentArtifacts: artifacts.dir, sourceOnlyNetworkFault: !ttl,
        ...(exitOwner ? { accessTtlMs: 3000, socketGraceMs: 1000 } : {}) });
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
      const runOptions = { ...options, repoRoot: runtime.repoRoot, workspaceDir: artifacts.workspace,
        configHome: artifacts.configHome, requestsDir: artifacts.requestsDir,
        commandOverride: `${quote(binary)} --cwd {workspace}${gateway ? ` --peer-gateway-server ${gateway.alias}` : ''}` };
      await runtime.writeStartMeta(artifacts, { ...runOptions, runDir: artifacts.dir }, runOptions.commandOverride, options.scenario);
      browser = await chromium.launch(browserLaunchOptions(options));
      const expectedImage = await stat(binary, { bigint: true });
      for (const label of exitOwner ? ['source'] : ['source', 'receiver']) {
        const directory = path.join(artifacts.dir, label); await mkdir(directory);
        const session = await runtime.startSession({ ...runOptions, runDir: directory }); sessions.push(session);
        const page = await browser.newPage({ viewport: { width: 1100, height: 760 } }); pages.push(page);
        attachBrowserConsole(page, browserConsole);
        await page.goto(session.url);
        await page.waitForFunction(() => window.tuiLab?.ready && window.tuiLab.visibleText().includes('Ask KCoder'), null, { timeout: options.timeoutMs });
        assert.equal(await page.evaluate(() => window.tuiLab.renderer), 'webgl');
        const actual = await stat(`/proc/${session.ptyProcess.pid}/exe`, { bigint: true });
        assert.equal(actual.dev, expectedImage.dev); assert.equal(actual.ino, expectedImage.ino);
      }
      const image = createHash('sha256');
      await new Promise((resolve, reject) => createReadStream(binary).on('data', data => image.update(data)).on('end', resolve).on('error', reject));
      const binarySha256 = image.digest('hex');
      if (exitOwner) {
        independentBrowser = await gateway.openBrowserRuntime();
        assert.equal(independentBrowser.authentication, 'actual-http-browser-cookie');
        assert.equal(independentBrowser.independentDeviceFamily, true);
        browserThread = (await independentBrowser.request('thread/start', {})).thread;
        const original = { threadId: browserThread.id, clientMessageId: 'owned-browser-expiry-hold', input: [{ type: 'text', text: HOLD }] };
        for (let attempt = 0; ; attempt += 1) {
          const frameStart = independentBrowser.messages().length;
          try { await independentBrowser.request('turn/start', original); break; }
          catch (error) {
            // A real pre-admission turn-gate refusal plus the exact original
            // missing receipt permits a bounded same-ID retry. No transport
            // failure or unknown execution is replayed.
            const errors = independentBrowser.messages().slice(frameStart).filter(frame => Object.hasOwn(frame, 'id') && frame.error);
            assert.equal(errors.length, 1);
            assert.equal(errors[0].error.code, -32003);
            assert.equal(errors[0].error.message, 'Turn already running');
            const observed = await independentBrowser.request('turn/receipt/read', { threadId: browserThread.id, clientMessageId: original.clientMessageId });
            assert.equal(observed.receipt, null);
            originalTurnRefusals.push({ attempt, code: errors[0].error.code, receipt: null });
            if (attempt >= 9) throw error;
            await pages[0].waitForTimeout(100);
          }
        }
      } else {
        if (!ttl && !local) await gateway.waitForPeerSockets(2);
        await submitTerminalLine(pages[1], HOLD);
      }
      let startedTimer;
      try { await Promise.race([started, new Promise((_, reject) => { startedTimer = setTimeout(() => reject(new Error('actual receiver Provider did not reach the owned barrier')), options.timeoutMs); })]); }
      finally { clearTimeout(startedTimer); }
      await submitTerminalLine(pages[0], `${SOURCE}: send one permitted contribution to the running peer.`);
      await pages[0].waitForFunction(marker => window.tuiLab.visibleText().includes(marker), SOURCE_DONE, { timeout: options.timeoutMs });
      if (localClose) {
        await pages[0].waitForFunction(() => !window.tuiLab.visibleText().toLowerCase().includes('esc interrupt'), null, { timeout: options.timeoutMs });
        await sessions[0].stop(); await sessions[0].exitPromise;
        assert.equal(sessions[1].getExitInfo(), null, 'stopping the original Source leaves the actual receiver alive');
        releaseReceiver();
      }
      if (exitOwner) {
        authorityBefore = await gateway.observeDeviceAuthorization();
        assert.equal(authorityBefore.authorized, true);
        await pages[0].waitForFunction(() => !window.tuiLab.visibleText().toLowerCase().includes('esc interrupt'), null, { timeout: options.timeoutMs });
        await sessions[0].stop(); await sessions[0].exitPromise;
        const limit = Date.now() + 15_000;
        do {
          const devices = await independentBrowser.devices();
          const actual = devices.find(device => device.id === authorityBefore.deviceId);
          assert.ok(actual && actual.expiresAt > Date.now(), 'durable device grant is still present and valid under independent browser authority');
          expiredTransportDevice = actual;
          if (Date.now() > actual.lastUsedAt + 4500) break;
          assert.ok(Date.now() < limit, 'the stopped Source must stop refreshing its transport family');
          await pages[0].waitForTimeout(250);
        } while (true);
        authorityAfter = await gateway.observeDeviceAuthorization({ reloadFile: false });
        assert.equal(authorityAfter.authorized, false); assert.ok([401, 403].includes(authorityAfter.httpStatus));
        assert.equal(gateway.network.snapshot().sourceConnected, false);
        assert.equal(gateway.network.snapshot().peerUpgrades, 1, 'independent browser destination did not share the Source device family');
        assert.equal(independentBrowser.socket.readyState, 1);
        releaseReceiver();
        // enqueue_only requires its original history application, not an
        // additional automatic model turn after the foreground response ends.
        const applied = await independentBrowser.waitFor(message => {
          const facts = peerNotificationFacts(message);
          return facts?.method === 'item/completed' && facts.messageId === receipt.messageId;
        }, options.timeoutMs, 'original peer application after Source process exit/family deadline');
        nativeAppliedFacts = peerNotificationFacts(applied);
        assert.equal(nativeAppliedFacts.sourceAddress.threadId, sourceAddress.threadId);
        assert.equal(nativeAppliedFacts.targetAddress.threadId, destination.threadId);
        await pages[0].waitForTimeout(1000);
        const native = await independentBrowser.request('thread/read', { threadId: browserThread.id, limit: 100 });
        assert.equal(native.messages.filter(message => message.role === 'peer_agent' && message.content === PEER).length, 1);
        const peer = native.messages.find(message => message.role === 'peer_agent' && message.content === PEER);
        assert.equal(peer.agentMessage?.messageId, receipt.messageId);
      } else {
      if (localClose) {
        await pages[1].waitForFunction(({ peer, foreground }) => window.tuiLab.visibleText().includes(peer)
          && window.tuiLab.visibleText().includes(foreground), { peer: PEER, foreground: FOREGROUND_DONE }, { timeout: options.timeoutMs });
      } else await pages[1].waitForFunction(marker => window.tuiLab.visibleText().includes(marker), noAppend ? FOREGROUND_DONE : RECEIVER_DONE, { timeout: options.timeoutMs });
      }
      if (!exitOwner) await pages[1].waitForFunction(() => !window.tuiLab.visibleText().toLowerCase().includes('esc interrupt'), null, { timeout: options.timeoutMs });
      await pages[0].waitForTimeout(1500);
      assert.deepEqual(errors, []); if (ttl) assert.equal(expiredReceipt.status, 'expired'); else assert.equal(sourceCalls, 3);
      if (localClose) assert.ok([1, 2].includes(receiverCalls), 'only the original held User turn may continue after its safe boundary');
      else assert.equal(receiverCalls, noAppend || exitOwner ? 1 : 2);
      const peers = []; let bodyRows = 0, realUserRows = 0, disguisedPeerUsers = 0;
      const visit = async (directory, depth = 0) => {
        if (depth > 8) return;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) continue;
          const file = path.join(directory, entry.name);
          if (entry.isDirectory() && !/^(?:checkpoints|context-history|llm-history|snapshots|archives|builtin-skills|skills|attachments|requests|cache)$/.test(entry.name)) await visit(file, depth + 1);
          else if (entry.name === `${destination.threadId}.jsonl` || entry.name === 'session.jsonl' && path.basename(directory) === destination.threadId)
            for (const line of (await readFile(file, 'utf8')).split('\n').filter(Boolean)) {
              const value = JSON.parse(line), message = value.message ?? value;
              const plain = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.map(block => block.text ?? '').join('') : '';
              if (plain === PEER) bodyRows += 1;
              if (message.origin === 'user' && plain === HOLD) realUserRows += 1;
              if (message.origin === 'user' && plain === PEER) disguisedPeerUsers += 1;
              if (message.origin === 'peer_agent' && message.agent_message?.messageId === receipt.messageId) peers.push(message);
            }
        }
      };
      await visit(artifacts.configDir); await visit(artifacts.workspace);
      assert.equal(peers.length, noAppend ? 0 : 1);
      assert.equal(bodyRows, noAppend ? 0 : 1, 'revoked delivery cannot disguise its body as an ordinary user row');
      if (localClose) { assert.equal(realUserRows, 1); assert.equal(disguisedPeerUsers, 0); }
      for (const session of exitOwner ? [] : localClose ? sessions.slice(1) : sessions) {
        const alive = await stat(`/proc/${session.ptyProcess.pid}/exe`, { bigint: true });
        assert.equal(alive.dev, expectedImage.dev); assert.equal(alive.ino, expectedImage.ino);
      }
      await captureStep(pages[0], trace, exitOwner || localClose ? 'source-owner-exited-after-original-queued-receipt' : 'source-still-alive-after-device-network-action', path.join(artifacts.dir, 'source-complete.png'));
      if (!exitOwner) await captureStep(pages[1], trace, 'real-receiver-boundary-result', path.join(artifacts.dir, 'receiver-complete.png'));
      successful = true;
      return { realPty: true, renderer: 'webgl', actualHttpDevicePairing: !local, actualGateway: !local, standaloneTuiMaintenanceOnly: local, binarySha256,
        revoked: revoke, sourceProcessExited: exitOwner || localClose, localColdSourceRecovery: localClose, realUserRows, disguisedPeerUsers, expiredTransportDevice,
        independentDestinationAuthentication: independentBrowser?.authentication, ttlSeconds: ttl ? 1 : undefined, expiredReceipt, sourceCalls, receiverCalls, peerRows: peers.length, bodyRows, sourceAddress, destination,
        stableMessageId: receipt.messageId, originalClientMessageId: receipt.clientMessageId, originalTurnRefusals, nativeAppliedFacts, authorityBefore, authorityAfter, network: gateway?.network?.snapshot(),
        originalNativeProcessesAlive: exitOwner ? [] : localClose ? [sessions[1].ptyProcess.pid] : sessions.map(session => session.ptyProcess.pid),
        sourceExitedPid: exitOwner || localClose ? sessions[0].ptyProcess.pid : undefined,
        persistentDeviceStillAuthorized: exitOwner ? true : undefined, noFakeReceiverUser: true,
        sourceSocketLossDoesNotRevoke: !revoke && !ttl, actualReactDom: false, gatewayEvidence: gateway?.artifacts, loopbackProviderOnly: true };
    },
    captureBeforeCleanup: async () => {
      for (let index = 0; index < pages.length; index++) {
        await writeFile(path.join(artifacts.dir, `${index}.screen.txt`), await pages[index].evaluate(() => window.tuiLab?.visibleText() ?? '').catch(() => ''));
        await writeFile(path.join(artifacts.dir, `${index}.pty.log`), sessions[index].getPtyLog());
      }
      await json(path.join(artifacts.dir, 'provider-observations.json'), observations);
      await json(path.join(artifacts.dir, 'original-owner-observations.json'), { receipt, sourceAddress, destination,
        authorityBefore, authorityAfter, expiredTransportDevice, originalTurnRefusals, nativeAppliedFacts });
      await writeFile(artifacts.browserConsoleLog, formatBrowserConsole(browserConsole));
    },
    cleanup: async () => {
      releaseReceiver();
      const report = await cleanupOwnedBrowserSessions({ browser, sessions });
      if (gateway) report.steps.push(await settleLifecycleStep('owned-device-gateway', () => gateway.finish(successful ? undefined : new Error('Parent Native network case did not complete'))));
      report.steps.push(await settleLifecycleStep('owned-loopback-provider', () => new Promise(resolve => { provider.closeAllConnections(); provider.close(resolve); })));
      return report;
    },
    onFailure: async error => { await json(path.join(artifacts.dir, 'failure.json'), { error: String(error), errors, sourceCalls, receiverCalls,
      receipt, sourceAddress, destination, cleanup: error.cleanup, trace }); console.error(artifacts.dir); },
    onSuccess: async (result, cleanup) => {
      await verifyRunContextIntegrity(artifacts, runtime.runContextRuntime());
      await json(artifacts.assertions, { ok: true, ...result });
      await json(artifacts.meta, { result, cleanup, trace }); console.log(artifacts.dir);
    },
  });
}
