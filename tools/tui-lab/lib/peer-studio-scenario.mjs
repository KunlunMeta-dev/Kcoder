import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { startPeerDeviceGateway } from '../../../apps/kcoder-studio/e2e/harness/peer-device-gateway.mjs';
import { assertRendererBuildFresh } from '../../../apps/kcoder-studio/e2e/harness/renderer-build.mjs';
import { waitFor } from '../../../apps/kcoder-studio/e2e/harness/run-context.mjs';
import { peerNotificationFacts, peerCapabilityFacts } from '../../../apps/kcoder-studio/e2e/harness/peer-notification-facts.mjs';
import { createRunContext, verifyRunContextIntegrity } from './run-context.mjs';
import { browserLaunchOptions } from './runner-options.mjs';
import { submitTerminalLine } from './terminal-interaction.mjs';
import { runBrowserScenarioLifecycle, cleanupOwnedBrowserSessions, settleLifecycleStep } from './browser-lifecycle.mjs';
import { observePeerCredentialLock } from './peer-credential-lock-observer.mjs';
import { armPeerReadTransportFault } from './peer-read-transport-fault.mjs';
import { validAgentMessageAddress } from '../../../apps/kcoder-studio/shared/agentMessageMethods.mjs';
import { observeCrossTargetNativeEvidence } from './peer-studio-cross-target-evidence.mjs';

const SEED = 'OWNED_STUDIO_UI_SEED';
const READY = 'OWNED_STUDIO_UI_READY';
const TRIGGER = 'OWNED_TUI_TO_STUDIO_SEND';
const PEER = 'OWNED_TUI_PEER <b>untrusted literal</b>';
const SENT = 'OWNED_TUI_SEND_ACCEPTED';
const BACK = 'OWNED_STUDIO_TO_TUI_REPLY';

/** Real React/Chromium and real PTY/xterm. Only Provider frames are fixed, so
 * this proves UI/routing/receipt boundaries, not autonomous model behavior.
 */
export async function runPeerStudioScenario(options, runtime) {
  assert.equal(process.platform, 'linux');
  await assertRendererBuildFresh();
  const binary = process.env.KCODER_E2E_KCODER_BIN;
  assert.ok(binary && path.isAbsolute(binary), 'One frozen Native image is required');
  const artifacts = await createRunContext(options, 'peer-studio', runtime.runContextRuntime());
  const failOriginalRead = options.scenario === 'peer-studio-readonly-failure';
  const crossTarget = options.scenario === 'peer-studio-gateway-cross-target';
  const studioActor = { alias: crossTarget ? 'cross-studio' : 'owned-peer-native', profile: artifacts.configDir,
    configHome: artifacts.configHome, workspace: artifacts.workspace };
  const tuiActor = crossTarget ? { alias: 'cross-tui', configHome: path.join(artifacts.configHome, 'tui'),
    profile: path.join(artifacts.configHome, 'tui', 'kcoder'), workspace: path.join(artifacts.dir, 'tui-workspace') } : studioActor;
  const tuiListPages = [], tuiCursors = new Set();
  let rendererIdentity, nativeEvidence, originalStudioRoute, returnNavigationOffset;
  let gateway, browser, terminal, studio, lockObserver, failure = new Error('Studio/TUI acceptance has not completed');
  let studioThreadId, studioUrl, sourceAddress, destination, tuiReceipt, outgoing, originalReadFault;
  const sessions = [], observations = [], errors = [], wire = [];
  let rejectProviderFailure;
  const providerFailure = new Promise((_, reject) => { rejectProviderFailure = reject; });
  providerFailure.catch(() => {});
  let connectionSequence = 0;
  let modelRequests = 0, tuiRequests = 0, studioRequests = 0;
  let uiDiscoveryOffset = 0, uiPaginationClicks = 0;
  const json = (file, value) => writeFile(file, JSON.stringify(gateway?.redactEvidence(value) ?? value, null, 2) + '\n');
  const provider = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(404).end(); return; }
    try {
      let raw = ''; for await (const chunk of request) { raw += chunk; assert.ok(Buffer.byteLength(raw) <= 2 * 1024 * 1024); }
      const body = JSON.parse(raw), text = JSON.stringify(body.messages), tui = text.includes(TRIGGER);
      assert.ok(++modelRequests <= (crossTarget ? 6 : 4), 'Only the three actual owned workspace catalogs may be paged');
      const number = tui ? ++tuiRequests : ++studioRequests;
      const lastTool = [...body.messages].reverse().find(message => message.role === 'tool');
      observations.push({ role: tui ? 'tui' : 'studio', number, hasPeer: text.includes(PEER) || text.includes(BACK),
        ...(crossTarget && lastTool ? { toolCallId: lastTool.tool_call_id, originalToolOutput: lastTool.content } : {}),
        lowerTrust: text.includes('untrusted_peer_agent_reference') });
      const call = (id, name, input) => ({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function',
        function: { name, arguments: JSON.stringify(input) } }] });
      const result = id => {
        const message = body.messages.find(message => message.role === 'tool' && message.tool_call_id === id);
        assert.ok(message); return JSON.parse(typeof message.content === 'string' ? message.content : message.content.map(part => part.text ?? '').join(''));
      };
      let delta, finish = 'stop';
      if (!tui) {
        assert.equal(number, 1); assert.ok(text.includes(SEED)); delta = { role: 'assistant', content: READY };
      } else if (number === 1) {
        for (const name of ['ListSessions', 'SendSessionMessage', 'GetSessionMessageReceipt'])
          assert.ok(body.tools?.some(tool => tool.function?.name === name), `Actual Gateway ${name} must be available`);
        delta = call(crossTarget ? 'actual-studio-discovery-0' : 'actual-studio-discovery', 'ListSessions', {}); finish = 'tool_calls';
      }
      else if (lastTool?.tool_call_id.startsWith('actual-studio-discovery')) {
        const listing = result(lastTool.tool_call_id); tuiListPages.push(listing);
        assert.ok(tuiListPages.length <= (crossTarget ? 3 : 1));
        assert.equal(listing.coverage, 'workspace_history');
        const target = listing.targets.find(row => row.threadId === studioThreadId);
        if (crossTarget && !target) {
          assert.ok(listing.nextCursor && !tuiCursors.has(listing.nextCursor), 'Only follow a new cursor from the actual List result');
          tuiCursors.add(listing.nextCursor);
          delta = call(`actual-studio-discovery-${tuiListPages.length}`, 'ListSessions', { cursor: listing.nextCursor });
        } else {
          assert.ok(target?.address, 'Actual original Studio session must be discoverable');
          destination = target.address;
          delta = call('actual-studio-send', 'SendSessionMessage', { targetThreadId: target.threadId,
            targetAddress: destination, mode: 'enqueue_only', text: PEER });
        }
        finish = 'tool_calls';
      } else {
        assert.equal(number, tuiListPages.length + 2); tuiReceipt = result('actual-studio-send');
        assert.ok(['queued', 'delivering', 'applied'].includes(tuiReceipt.status));
        sourceAddress = tuiReceipt.sourceAddress; assert.ok(sourceAddress);
        if (crossTarget) {
          assert.notEqual(sourceAddress.targetId, destination.targetId, 'Aliases never substitute for distinct canonical targets');
          assert.notEqual(sourceAddress.workspaceId, destination.workspaceId);
        }
        delta = { role: 'assistant', content: SENT };
      }
      const frame = (delta, reason) => ({ id: 'owned-studio-peer', object: 'chat.completion.chunk', model: body.model,
        choices: [{ index: 0, delta, finish_reason: reason }] });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(frame(delta, null))}\n\ndata: ${JSON.stringify(frame({}, finish))}\n\ndata: [DONE]\n\n`);
    } catch (error) { errors.push(String(error)); rejectProviderFailure(error); if (!response.headersSent) response.writeHead(400); response.end(); }
  });
  return runBrowserScenarioLifecycle({
    execute: async () => {
      await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
      if (crossTarget) {
        await cp(artifacts.workspace, tuiActor.workspace, { recursive: true, force: false, errorOnExist: true });
        const rendererIndex = path.join(process.env.KCODER_E2E_RENDERER_ROOT ?? path.join(runtime.repoRoot, 'apps/kcoder-studio/renderer/dist'), 'index.html');
        rendererIdentity = { index: rendererIndex, sha256: createHash('sha256').update(await readFile(rendererIndex)).digest('hex') };
        assert.equal(rendererIdentity.sha256, process.env.KCODER_E2E_RENDERER_INDEX_SHA256, 'Use the explicitly fixed current React build');
      }
      for (const actor of crossTarget ? [studioActor, tuiActor] : [studioActor]) {
      await mkdir(actor.profile, { recursive: true, mode: 0o700 });
      await json(path.join(actor.profile, 'settings.json'), { active_provider: 'owned-peer', credential_store: 'file',
        permission_mode: 'yolo', max_retries: 0, cross_session_messages: { enabled: true, wake_idle: false },
        auto_memory_enabled: false, auto_tool_memory_enabled: false, session_memory: { enabled: false },
        providers: { 'owned-peer': { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
          endpoint: `http://127.0.0.1:${provider.address().port}/v1`, no_proxy: true, discover_models: false,
          default_model: 'owned-studio-peer', context_window_tokens: 1048576, max_output_tokens: 8192, output_headroom_tokens: 8192,
          capabilities: { text: true, tools: true, reasoning: false } } } });
      }
      gateway = await startPeerDeviceGateway({ binary, profile: artifacts.configDir, workspace: artifacts.workspace,
        ...(crossTarget ? { actors: [studioActor, tuiActor], directDefaultNative: true } : {}),
        parentArtifacts: artifacts.dir, peerNotificationDiagnostics: true });
      if (crossTarget) await json(path.join(artifacts.dir, 'cross-target-inputs.json'), {
        actors: [studioActor, tuiActor], binary, nativeSha256: process.env.KCODER_E2E_KCODER_BIN_SHA256,
        rendererIdentity, maximumProviderRequests: 6, directDefaultNative: gateway.directDefaultNative,
        gatewayArtifacts: gateway.artifacts,
      });
      studio = (await gateway.openStudioPage()).page;
      studio.on('websocket', socket => {
        const pending = new Map(), connection = ++connectionSequence;
        if (crossTarget) {
          // Retain routing facts only, never the socket URL or authentication.
          const endpoint = new URL(socket.url());
          wire.push({ connection, lane: 'browser-socket-context', serverId: endpoint.searchParams.get('server'),
            workspacePath: endpoint.searchParams.get('workspace') });
        }
        socket.on('framesent', event => {
          try {
            const value = JSON.parse(String(event.payload));
            if (!value.method) return;
            const params = value.params ?? {};
            const row = { connection, method: value.method, threadId: params.threadId ?? params.sourceThreadId,
              ...(validAgentMessageAddress(params.expectedSessionAddress) ? { expectedSessionAddress: {
                targetId: params.expectedSessionAddress.targetId, workspaceId: params.expectedSessionAddress.workspaceId,
                threadId: params.expectedSessionAddress.threadId } } : {}),
              ...(value.method === 'initialize' ? { requestedPeer: params.capabilities?.experimental?.peerAgentMessagesV1 === true } : {}),
              ...(params.address ? { address: params.address } : {}),
              ...(params.query ? { queryClientMessageId: params.query.clientMessageId } : {}),
              ...(crossTarget && value.method === 'thread/agentMessage/targets' && typeof params.cursor === 'string'
                ? { cursor: params.cursor } : {}),
              ...(params.message ? { clientMessageId: params.message.clientMessageId, targetAddress: params.message.targetAddress } : {}) };
            wire.push(row); pending.set(value.id, row);
          } catch { /* Unrelated transport frame. */ }
        });
        socket.on('framereceived', event => {
          try {
            const value = JSON.parse(String(event.payload));
            const notice = peerNotificationFacts(value), caps = peerCapabilityFacts(value);
            if (notice) wire.push({ connection, lane: 'browser-ws-received', ...notice });
            if (caps) wire.push({ connection, lane: 'browser-initialize', ...caps });
            const request = pending.get(value.id);
            if (!request) return;
            request.replyObserved = true;
            if (value.error) request.errorCode = value.error.code;
            if (crossTarget && request.method === 'thread/agentMessage/targets')
              request.nextCursor = typeof value.result?.nextCursor === 'string' ? value.result.nextCursor : null;
            if (['runtime.models.list', 'runtime.providers.list'].includes(request.method)) {
              request.resultKeys = value.result && typeof value.result === 'object' ? Object.keys(value.result) : [];
              request.entries = Array.isArray(value.result?.items) ? value.result.items.length : null;
            }
            const receipt = value.result?.receipt ?? value.result;
            if (receipt?.messageId && receipt.clientMessageId) {
              request.receipt = { messageId: receipt.messageId, clientMessageId: receipt.clientMessageId, status: receipt.status,
                sourceAddress: receipt.sourceAddress, targetAddress: receipt.targetAddress };
            }
          } catch { /* Unrelated transport frame. */ }
        });
      });
      // A new connection after this point also remains observable; use the
      // ordinary page reload before creating its actual source session.
      await studio.reload({ waitUntil: 'domcontentloaded' });
      await waitFor(() => ['runtime.models.list', 'runtime.providers.list'].every(method =>
        wire.some(row => row.method === method && row.replyObserved && !row.errorCode)),
      30_000, 'actual renderer Native model/provider catalog replies');
      const selector = studio.getByTestId('model-selector-button');
      await selector.click();
      await studio.getByTestId('model-reset-default-button').waitFor({ state: 'visible' });
      await studio.getByTestId('model-reset-default-button').click(); await selector.click();
      await studio.getByTestId('chat-message-input').fill(SEED);
      await studio.getByTestId('send-message-button').click();
      await studio.getByTestId('message-assistant').filter({ hasText: READY }).waitFor({ timeout: options.timeoutMs });
      studioUrl = studio.url();
      const taskId = new URL(studioUrl).searchParams.get('taskId');
      assert.ok(taskId?.startsWith(`kcoder:${gateway.alias}:`)); studioThreadId = taskId.slice(`kcoder:${gateway.alias}:`.length);
      if (crossTarget) originalStudioRoute = { pathname: new URL(studioUrl).pathname,
        deviceId: new URL(studioUrl).searchParams.get('deviceId'), taskId };
      browser = await chromium.launch({ ...browserLaunchOptions(options),
        ...(process.env.KCODER_E2E_CHROMIUM_BIN ? { executablePath: process.env.KCODER_E2E_CHROMIUM_BIN } : {}) });
      const tuiDir = path.join(artifacts.dir, 'original-tui'); await mkdir(tuiDir);
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
      const runOptions = { ...options, repoRoot: runtime.repoRoot, workspaceDir: tuiActor.workspace, configHome: tuiActor.configHome,
        runDir: tuiDir, commandOverride: `${quote(binary)} --cwd {workspace} --peer-gateway-server ${tuiActor.alias}` };
      await runtime.writeStartMeta(artifacts, runOptions, runOptions.commandOverride, options.scenario);
      lockObserver = observePeerCredentialLock(tuiActor.profile);
      const session = await runtime.startSession(runOptions); sessions.push(session);
      const whileTuiAlive = (operation, phase) => Promise.race([operation, ...(crossTarget ? [providerFailure] : []), session.exitPromise.then(exit => {
        throw new Error(`Original TUI exited before ${phase} (code ${exit.exitCode}); inspect the owned PTY evidence`);
      })]);
      terminal = await browser.newPage({ viewport: { width: 1100, height: 760 } }); await terminal.goto(session.url);
      await whileTuiAlive(terminal.waitForFunction(() => window.tuiLab?.ready && window.tuiLab.visibleText().includes('Ask KCoder'), null,
        { timeout: options.timeoutMs }), 'welcome');
      assert.equal(await terminal.evaluate(() => window.tuiLab.renderer), 'webgl');
      const executablePath = `/proc/${session.ptyProcess.pid}/exe`, digest = createHash('sha256');
      await new Promise((resolve, reject) => createReadStream(executablePath).on('data', bytes => digest.update(bytes)).on('end', resolve).on('error', reject));
      const executable = { pid: session.ptyProcess.pid, path: await readlink(executablePath), sha256: digest.digest('hex') };
      assert.equal(executable.sha256, process.env.KCODER_E2E_KCODER_BIN_SHA256);
      if (crossTarget) await waitFor(() => gateway.network.snapshot().sourceConnected
        && gateway.network.snapshot().peerUpgrades === 1, 30_000, 'the original TUI device WSS alongside the real Studio broker');
      await submitTerminalLine(terminal, TRIGGER);
      await whileTuiAlive(terminal.waitForFunction(marker => window.tuiLab.visibleText().includes(marker), SENT,
        { timeout: options.timeoutMs }), 'original send receipt');
      await terminal.waitForFunction(() => !window.tuiLab.visibleText().toLowerCase().includes('esc interrupt'), null,
        { timeout: options.timeoutMs });
      const bubble = studio.getByTestId('peer-agent-message').filter({ hasText: PEER });
      await whileTuiAlive(bubble.waitFor({ timeout: Math.min(options.timeoutMs, 20_000) }), 'Studio peer display');
      assert.equal(await bubble.locator('b').count(), 0, 'Peer text never becomes trusted markup');
      assert.equal(await studio.getByTestId('message-user').filter({ hasText: PEER }).count(), 0);
      await studio.screenshot({ path: path.join(artifacts.dir, 'studio-peer-low-trust.png'), fullPage: true });
      // Use the displayed original source. Navigation must preserve that full
      // address, read history, and never manufacture a new source/user turn.
      const readFault = failOriginalRead ? await armPeerReadTransportFault(studio, sourceAddress.threadId) : null;
      originalReadFault = readFault;
      if (readFault) {
        // WebSocket routing applies only to sockets created after registration.
        // Reload the owned view so every subsequent source reader is observed.
        await studio.reload({ waitUntil: 'domcontentloaded' });
        await bubble.waitFor({ timeout: options.timeoutMs });
      }
      const beforeNavigation = wire.length;
      await bubble.getByRole('button').click();
      await studio.waitForURL(url => url.searchParams.get('taskId') === `kcoder:${tuiActor.alias}:${sourceAddress.threadId}`, { timeout: options.timeoutMs });
      assert.deepEqual(JSON.parse(new URL(studio.url()).searchParams.get('expectedSessionAddress')), sourceAddress,
        'Source navigation retains the complete canonical address through the route');
      if (failOriginalRead) {
        await studio.getByText(/无法读取此会话的原历史|Unable to read this session's original history/).waitFor({ timeout: options.timeoutMs });
        const fault = readFault();
        assert.ok(fault); assert.equal(fault.requestForwardedUnchanged, true); assert.equal(fault.noSyntheticNativeReply, true);
        assert.equal(fault.originalReplyObserved, true); assert.equal(fault.replyDropped, true);
        assert.equal(session.getExitInfo(), null, 'A failed read cannot release the original TUI lease owner');
        assert.equal(modelRequests, 4);
        const navigation = wire.slice(beforeNavigation);
        assert.equal(navigation.some(row => ['thread/start', 'turn/start'].includes(row.method)), false);
        assert.ok(navigation.filter(row => row.method === 'thread/resume' && row.threadId === sourceAddress.threadId).length <= 1);
        const originalReads = navigation.filter(row => ['thread/resume', 'thread/read', 'thread/read/indexed'].includes(row.method) && row.threadId === sourceAddress.threadId);
        assert.ok(originalReads.length >= 2);
        for (const row of originalReads) assert.deepEqual(row.expectedSessionAddress, sourceAddress);
        assert.equal(await studio.getByTestId('message-assistant').filter({ hasText: SENT }).count(), 0,
          'An unconfirmed read cannot commit an empty or fabricated successful original history');
        await json(path.join(artifacts.dir, 'original-history-read-fault.json'), fault);
        await studio.screenshot({ path: path.join(artifacts.dir, 'original-history-read-failure.png'), fullPage: true });
        failure = null;
        return { actualReactChromium: true, actualTuiPty: true, terminalRenderer: 'webgl', actualHttpAuthentication: true,
          originalReadTransportFault: fault, originalReadErrorVisible: true, sourceNavigationCreatesTurn: false,
          originalTuiStayedAlive: true, providerRequests: modelRequests, syntheticClientSubject: false,
          executable, originalTuiMessageId: tuiReceipt.messageId, originalTuiClientMessageId: tuiReceipt.clientMessageId,
          sourceAddress, destination, gatewayArtifacts: gateway.artifacts, autonomousModelBehaviorProven: false };
      }
      await studio.getByTestId('message-assistant').filter({ hasText: SENT }).waitFor({ timeout: options.timeoutMs });
      await studio.getByTestId('composer-disabled-reason').filter({ hasText: /另一个窗口或终端|another window or terminal/ }).waitFor();
      const readOnlyInput = studio.getByTestId('chat-message-input');
      await waitFor(async () => !(await readOnlyInput.evaluate(element => element.isContentEditable)),
        5_000, 'native read-only ProseMirror effects settle');
      assert.equal(await readOnlyInput.getAttribute('contenteditable'), 'false');
      await waitFor(async () => !(await readOnlyInput.isEditable()), 5_000, 'read-only ProseMirror accessibility effects settle');
      assert.equal(await readOnlyInput.getAttribute('aria-disabled'), 'true');
      assert.equal(await readOnlyInput.getAttribute('aria-readonly'), 'true');
      const originalDraft = await readOnlyInput.innerText();
      await readOnlyInput.focus();
      await studio.keyboard.type('OWNED_READ_ONLY_DRAFT_MUST_NOT_CHANGE');
      await studio.keyboard.press('Enter');
      await studio.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await readOnlyInput.innerText(), originalDraft, 'Typing or Enter cannot change the read-only draft');
      assert.equal(modelRequests, tuiListPages.length + 3, 'A read-only viewer cannot add a Provider/user turn');
      await json(path.join(artifacts.dir, 'source-readonly-composer-state.json'), {
        phase: 'live-original-tui-history', sourceAddress,
        ...await readOnlyInput.evaluate(element => ({ nativeContentEditable: element.isContentEditable,
          contentEditable: element.getAttribute('contenteditable'), ariaDisabled: element.getAttribute('aria-disabled'),
          ariaReadOnly: element.getAttribute('aria-readonly') })),
        playwrightEditable: await readOnlyInput.isEditable(), typingChangedDraft: false, providerRequests: modelRequests,
      });
      assert.equal(await studio.getByTestId('session-messages-open').count(), 0, 'A history viewer cannot become the original TUI sender');
      assert.equal(session.getExitInfo(), null, 'Navigation must not release the original Native owner');
      const navigation = wire.slice(beforeNavigation);
      const originalReads = navigation.filter(row => ['thread/resume', 'thread/read', 'thread/read/indexed'].includes(row.method) && row.threadId === sourceAddress.threadId);
      assert.ok(originalReads.length >= 2);
      for (const row of originalReads) assert.deepEqual(row.expectedSessionAddress, sourceAddress);
      assert.ok(navigation.some(row => row.method === 'thread/agentMessage/resolve' && row.address?.targetId === sourceAddress.targetId &&
        row.address.workspaceId === sourceAddress.workspaceId && row.address.threadId === sourceAddress.threadId));
      assert.equal(navigation.some(row => ['thread/start', 'turn/start'].includes(row.method)), false);
      assert.ok(navigation.filter(row => row.method === 'thread/resume' && row.threadId === sourceAddress.threadId).length <= 1,
        'The same read-only view never retries an external owner as a transport failure');
      await studio.screenshot({ path: path.join(artifacts.dir, 'studio-source-original-history.png'), fullPage: true });
      returnNavigationOffset = wire.length;
      await studio.goto(studioUrl, { waitUntil: 'domcontentloaded' });
      await studio.getByTestId('message-assistant').filter({ hasText: READY }).waitFor({ timeout: options.timeoutMs });
      uiDiscoveryOffset = wire.length;
      await studio.getByTestId('session-messages-open').click();
      const dialog = studio.getByTestId('session-messages-dialog'); await dialog.waitFor();
      const candidates = dialog.getByTestId('session-message-target');
      const target = candidates.filter({ hasText: TRIGGER }).or(candidates.filter({ hasText: sourceAddress.threadId })).first();
      if (crossTarget) {
        const more = dialog.getByRole('button', { name: /^(Next page|下一页)$/ });
        for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
          const ready = await waitFor(async () => await target.isVisible() ? 'target'
            : await more.isVisible() && await more.isEnabled() ? 'more' : null, 30_000, 'actual cross-target UI discovery page');
          if (ready === 'target') break;
          assert.ok(pageNumber < 2, 'Only the default, original Studio and original TUI workspaces are paged');
          await more.click(); uiPaginationClicks++;
        }
      }
      await target.waitFor({ timeout: 30_000 }); await target.click();
      await dialog.getByTestId('session-message-input').fill(BACK);
      await dialog.getByTestId('session-message-send').click();
      await whileTuiAlive(terminal.waitForFunction(marker => window.tuiLab.visibleText().includes(marker), BACK,
        { timeout: options.timeoutMs }), 'Studio return message');
      assert.ok((await terminal.evaluate(() => window.tuiLab.visibleText())).includes('[Peer agent'));
      outgoing = wire.find(row => row.method === 'thread/agentMessage/send' && row.targetAddress?.threadId === sourceAddress.threadId);
      assert.ok(outgoing?.receipt?.messageId); assert.deepEqual(outgoing.targetAddress, sourceAddress);
      const lookupButton = dialog.getByRole('button', { name: /Check receipt|核对回执/ }).last();
      const lookup = await waitFor(async () => {
        const read = wire.find(row => row.method === 'thread/agentMessage/get' && row.receipt?.status === 'applied' &&
          row.receipt.messageId === outgoing.receipt.messageId);
        if (read) return read;
        if (await lookupButton.isEnabled()) await lookupButton.click();
        return null;
      }, 30_000, 'original Studio receipt Applied', 500);
      assert.equal(lookup?.receipt.status, 'applied');
      assert.equal(lookup.queryClientMessageId, outgoing.clientMessageId);
      await dialog.getByText(/Added to session|已加入会话/, { exact: false }).last().waitFor({ timeout: options.timeoutMs });
      assert.equal(studioRequests, 1); assert.equal(tuiRequests, tuiListPages.length + 2); assert.deepEqual(errors, []);
      if (crossTarget) {
        assert.equal(wire.filter(row => row.method === 'thread/agentMessage/send').length, 1, 'The original UI Send is never replayed');
        nativeEvidence = await observeCrossTargetNativeEvidence({ actors: [studioActor, tuiActor],
          addresses: [destination, sourceAddress], receipts: [tuiReceipt, outgoing.receipt],
          userTexts: [SEED, TRIGGER], peerTexts: [PEER, BACK] });
        assert.equal(modelRequests, tuiListPages.length + 3, 'Cross-target navigation/reply never invokes another model turn');
      }
      await studio.screenshot({ path: path.join(artifacts.dir, 'studio-original-receipt.png'), fullPage: true });
      await terminal.screenshot({ path: path.join(artifacts.dir, 'tui-peer-reply.png'), fullPage: true });
      failure = null;
      return { actualReactChromium: true, actualTuiPty: true, terminalRenderer: 'webgl', actualHttpAuthentication: true,
        syntheticClientSubject: false, independentNativeProcesses: true, executable, sourceAddress, destination,
        originalTuiMessageId: tuiReceipt.messageId, originalStudioMessageId: outgoing.receipt.messageId,
        sourceNavigationReadOriginal: true, sourceNavigationCreatesTurn: false, studioRequests, tuiRequests,
        ...(crossTarget ? { distinctCanonicalTargetIds: true, distinctProfilesAndWorkspaces: true,
          tuiListPages: tuiListPages.length, modelRequests, rendererIdentity, nativeEvidence,
          uiPaginationClicks, uiDiscoveryRequests: wire.slice(uiDiscoveryOffset).filter(row => row.method === 'thread/agentMessage/targets'),
          transport: 'actual-http-pairing-and-device-wss', network: gateway.network.snapshot() } : {}),
        autonomousModelBehaviorProven: false, windowsElectronProven: false, gatewayArtifacts: gateway.artifacts };
    },
    captureBeforeCleanup: async error => {
      if (error) failure = error;
      if (lockObserver) await json(path.join(artifacts.dir, 'credential-lock-holders.json'), {
        actors: { ...gateway.actorPids(), sourceNativePid: sessions[0]?.ptyProcess.pid }, events: await lockObserver.stop(),
      });
      if (terminal) await writeFile(path.join(artifacts.dir, 'tui.screen.txt'), gateway.redactEvidence(await terminal.evaluate(() => window.tuiLab?.visibleText() ?? '').catch(() => '')));
      if (studio) await writeFile(path.join(artifacts.dir, 'studio.screen.txt'), gateway.redactEvidence(await studio.locator('body').innerText().catch(() => '')));
      if (studio) {
        const input = studio.getByTestId('chat-message-input');
        if (await input.count()) await json(path.join(artifacts.dir, 'composer-state.json'), {
          phase: 'current-view-before-cleanup', taskId: new URL(studio.url()).searchParams.get('taskId'),
          ...await input.evaluate(element => ({ nativeContentEditable: element.isContentEditable,
            contentEditable: element.getAttribute('contenteditable'), ariaDisabled: element.getAttribute('aria-disabled'),
            ariaReadOnly: element.getAttribute('aria-readonly'), role: element.getAttribute('role') })),
          playwrightEditable: await input.isEditable(),
        });
      }
      if (studio) await studio.screenshot({ path: path.join(artifacts.dir, 'studio-final.png'), fullPage: true }).catch(() => {});
      if (sessions[0]) await writeFile(path.join(artifacts.dir, 'tui.pty.log'), gateway.redactEvidence(sessions[0].getPtyLog()));
      await json(path.join(artifacts.dir, 'peer-ui-wire.json'), wire);
      await json(path.join(artifacts.dir, 'provider-observations.json'), { modelRequests, observations, errors });
      if (originalReadFault) await json(path.join(artifacts.dir, 'original-history-read-fault.json'), originalReadFault());
    },
    cleanup: async () => {
      await lockObserver?.stop();
      const report = await cleanupOwnedBrowserSessions({ browser, sessions });
      if (gateway) report.steps.push(await settleLifecycleStep('owned-studio-gateway', () => gateway.finish(failure), 30_000));
      report.steps.push(await settleLifecycleStep('owned-provider', () => new Promise(resolve => { provider.closeAllConnections(); provider.close(resolve); })));
      return report;
    },
    onFailure: async error => { await json(path.join(artifacts.dir, 'failure.json'), { error: String(error), modelRequests,
      // Cleanup may reference the original error. Persist facts, not that cycle.
      cleanup: error.cleanup && { ptyExitObserved: error.cleanup.ptyExitObserved,
        ptyExits: error.cleanup.ptyExits, profileRetained: error.cleanup.profileRetained,
        steps: error.cleanup.steps.map(step => ({ name: step.name, status: step.status,
          ...(step.error ? { error: String(step.error) } : {}) })) },
      cleanupError: error.cleanupError && String(error.cleanupError),
      ...(crossTarget ? { originalStudioRoute, returnNavigationOffset } : {}),
      originalReadFault: originalReadFault?.(), gatewayArtifacts: gateway?.artifacts, wire }); console.error(artifacts.dir); },
    onSuccess: async (result, cleanup) => {
      await verifyRunContextIntegrity(artifacts, runtime.runContextRuntime());
      await json(artifacts.assertions, { ok: true, ...result });
      await json(artifacts.meta, { mode: options.scenario, result, cleanup }); console.log(artifacts.dir);
    },
  });
}
