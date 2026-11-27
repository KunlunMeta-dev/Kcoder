import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile, readdir, readlink, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { startPeerDeviceGateway } from '../../../apps/kcoder-studio/e2e/harness/peer-device-gateway.mjs';
import { waitFor } from '../../../apps/kcoder-studio/e2e/harness/run-context.mjs';
import { createRunContext, verifyRunContextIntegrity } from './run-context.mjs';
import { browserLaunchOptions } from './runner-options.mjs';
import { submitTerminalLine } from './terminal-interaction.mjs';
import { captureStep } from './browser-evidence.mjs';
import { cleanupOwnedBrowserSessions, runBrowserScenarioLifecycle, settleLifecycleStep } from './browser-lifecycle.mjs';

const TRIGGER = 'OWNED_CROSS_TARGET_SOURCE_USER';
const PEER = 'OWNED_CROSS_TARGET_FORWARD_BODY';
const BACK = 'OWNED_CROSS_TARGET_REPLY_BODY';
const SOURCE_DONE = 'OWNED_CROSS_TARGET_SOURCE_FINISHED';
const RECEIVER_DONE = 'OWNED_CROSS_TARGET_RECEIVER_FINISHED';
const text = message => typeof message?.content === 'string' ? message.content
  : (message?.content ?? []).map(block => block.text ?? '').join('');
const digest = value => createHash('sha256').update(value).digest('hex');

/** Distinct actual profiles/roots and canonical Native identities are mandatory.
 * Fixed model frames prove only the real tools, carrier, PTY and native history.
 */
export async function runPeerCrossTargetScenario(options, runtime) {
  assert.equal(process.platform, 'linux');
  const binary = process.env.KCODER_E2E_KCODER_BIN;
  const expectedSha = process.env.KCODER_E2E_KCODER_BIN_SHA256;
  assert.ok(binary && path.isAbsolute(binary)); assert.match(expectedSha ?? '', /^[a-f0-9]{64}$/);
  const artifacts = await createRunContext(options, 'peer-cross-target', runtime.runContextRuntime());
  const actors = [
    { alias: 'cross-source', configHome: artifacts.configHome, profile: artifacts.configDir, workspace: artifacts.workspace },
    { alias: 'cross-receiver', configHome: path.join(artifacts.configHome, 'receiver'),
      profile: path.join(artifacts.configHome, 'receiver', 'kcoder'), workspace: path.join(artifacts.dir, 'receiver-workspace') },
  ];
  const states = [0, 1].map(() => ({ calls: 0, pages: [], cursors: new Set(), destination: undefined, receipt: undefined }));
  const sessions = [], pages = [], processes = [], trace = [], errors = [], observations = [];
  let browser, gateway, sourceAddress, destination, requests = 0, outcome = Error('Cross-target proof did not complete');
  let releaseSource;
  const sourceIdle = new Promise(resolve => { releaseSource = resolve; });
  const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
  const provider = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(404).end(); return; }
    const ordinal = ++requests;
    try {
      assert.ok(ordinal <= 8, 'six base calls plus at most one extra real List page per actor');
      let raw = ''; for await (const chunk of request) { raw += chunk; assert.ok(Buffer.byteLength(raw) <= 2 * 1024 * 1024); }
      const body = JSON.parse(raw), context = JSON.stringify(body.messages);
      assert.equal(body.model, 'owned-cross-target-fixture');
      const index = body.messages.some(message => message.role === 'user' && text(message) === TRIGGER) ? 0 : 1;
      const state = states[index]; state.calls++;
      const last = [...body.messages].reverse().find(message => message.role === 'tool');
      observations.push({ ordinal, actor: actors[index].alias, actorCall: state.calls,
        toolCallId: last?.tool_call_id, originalToolOutput: last ? text(last) : undefined });
      const call = (id, name, input) => ({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function',
        function: { name, arguments: JSON.stringify(input) } }] });
      let delta, finish = 'tool_calls';
      if (state.calls === 1) {
        for (const name of ['ListSessions', 'SendSessionMessage']) assert.ok(body.tools.some(tool => tool.function?.name === name));
        if (index === 1) {
          await sourceIdle;
          assert.ok(context.includes('untrusted_peer_agent_reference') && context.includes(PEER));
          assert.ok(!context.includes(TRIGGER), 'no source User is fabricated in the receiver');
        }
        delta = call(`cross-${index}-list-0`, 'ListSessions', {});
      } else if (last?.tool_call_id.startsWith(`cross-${index}-list-`)) {
        // Original ToolError text is retained above; it must never become valid JSON.
        const listing = JSON.parse(text(last)); state.pages.push(listing);
        assert.ok(state.pages.length <= 2, 'only two real owned target catalogs are paged');
        assert.equal(listing.coverage, 'workspace_history');
        const wanted = index === 0 ? listing.targets[0] : listing.targets.find(row =>
          JSON.stringify(row.address) === JSON.stringify(sourceAddress));
        if (!wanted) {
          assert.ok(listing.nextCursor && !state.cursors.has(listing.nextCursor), 'follow only a new actual cursor');
          state.cursors.add(listing.nextCursor);
          delta = call(`cross-${index}-list-${state.pages.length}`, 'ListSessions', { cursor: listing.nextCursor });
        } else {
          assert.equal(listing.targets.length, 1, 'only the original other TUI is visible in this fresh catalog');
          assert.equal(wanted.presence, 'resident'); assert.equal(wanted.status, 'idle');
          assert.ok(wanted.address && wanted.address.threadId === wanted.threadId);
          assert.ok(wanted.allowedModes.includes(index === 0 ? 'wake_if_idle' : 'enqueue_only'));
          state.destination = wanted.address;
          if (index === 0) destination = wanted.address;
          else assert.deepEqual(wanted.address, sourceAddress);
          delta = call(`cross-${index}-send`, 'SendSessionMessage', { targetThreadId: wanted.threadId,
            targetAddress: wanted.address, mode: index === 0 ? 'wake_if_idle' : 'enqueue_only', text: index === 0 ? PEER : BACK });
        }
      } else {
        assert.equal(last?.tool_call_id, `cross-${index}-send`);
        const receipt = JSON.parse(text(last)); state.receipt = receipt;
        assert.ok(['queued', 'delivering', 'applied'].includes(receipt.status));
        assert.deepEqual(receipt.targetAddress, state.destination);
        if (index === 0) {
          sourceAddress = receipt.sourceAddress;
          assert.notEqual(sourceAddress.targetId, destination.targetId, 'different aliases cannot replace distinct canonical target IDs');
          assert.notEqual(sourceAddress.workspaceId, destination.workspaceId);
        } else { assert.deepEqual(receipt.sourceAddress, destination); assert.deepEqual(receipt.targetAddress, sourceAddress); }
        delta = { role: 'assistant', content: index === 0 ? SOURCE_DONE : RECEIVER_DONE }; finish = 'stop';
      }
      const frame = (value, stop) => ({ id: 'owned-cross-target-frame', object: 'chat.completion.chunk', model: body.model,
        choices: [{ index: 0, delta: value, finish_reason: stop }] });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(frame(delta, null))}\n\ndata: ${JSON.stringify(frame({}, finish))}\n\ndata: [DONE]\n\n`);
    } catch (error) { errors.push(String(error)); if (!response.headersSent) response.writeHead(400); response.end(); }
  });
  const histories = async (actor, id) => {
    const found = [];
    const visit = async (directory, depth = 0) => {
      assert.ok(depth <= 8);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory() && !/^(?:checkpoints|context-history|llm-history|snapshots|archives|builtin-skills|skills|attachments|requests|cache|logs|usage)$/.test(entry.name)) await visit(file, depth + 1);
        else if (entry.isFile() && (entry.name === `${id}.jsonl` || entry.name === 'session.jsonl' && path.basename(directory) === id)) found.push(file);
      }
    };
    await visit(actor.profile); await visit(actor.workspace); assert.equal(found.length, 1, 'one authoritative original history per actor');
    return { file: found[0], rows: (await readFile(found[0], 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)) };
  };
  const authoritativeReceipt = async (actor, address, messageId) => {
    const directory = path.join(actor.profile, 'peer-router-v1', `mailbox-${address.workspaceId}`);
    const disk = JSON.parse(await readFile(path.join(directory, 'messages.json'), 'utf8'));
    assert.equal(disk.format, 'sqlite'); const child = disk.binding.child;
    assert.match(child, /^receipt-archive-[A-Za-z0-9_-]+$/);
    // Evidence-only read of this run's original Native ledger. It grants no access or retry.
    // Loaded lazily: a top-level node:sqlite import prints an ExperimentalWarning
    // for every CLI invocation, including --help.
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(path.join(directory, child, 'catalog.sqlite3'), { readOnly: true });
    try {
      const row = database.prepare('SELECT body,sha FROM receipt_archive_rows WHERE message_id=?').get(messageId);
      assert.ok(row); assert.equal(digest(row.body), Buffer.from(row.sha).toString('hex'));
      return JSON.parse(Buffer.from(row.body).toString('utf8')).value.receipt;
    } finally { database.close(); }
  };
  return runBrowserScenarioLifecycle({
    execute: async () => {
      await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
      await cp(artifacts.workspace, actors[1].workspace, { recursive: true, force: false, errorOnExist: true });
      for (const actor of actors) {
        await mkdir(actor.configHome, { recursive: true, mode: 0o700 }); await mkdir(actor.profile, { recursive: true, mode: 0o700 });
        await json(path.join(actor.profile, 'settings.json'), { active_provider: 'fixture', credential_store: 'file', permission_mode: 'yolo', max_retries: 0,
          cross_session_messages: { enabled: true, wake_idle: true }, auto_memory_enabled: false, auto_tool_memory_enabled: false, session_memory: { enabled: false },
          providers: { fixture: { api_format: 'openai_chat_completions', endpoint: `http://127.0.0.1:${provider.address().port}/v1`, authentication: { mode: 'none' },
            no_proxy: true, discover_models: false, default_model: 'owned-cross-target-fixture', context_window_tokens: 1048576, max_output_tokens: 8192,
            output_headroom_tokens: 8192, capabilities: { text: true, tools: true, reasoning: false } } } });
      }
      assert.notEqual((await stat(actors[0].profile)).ino, (await stat(actors[1].profile)).ino);
      gateway = await startPeerDeviceGateway({ binary, profile: actors[0].profile, workspace: actors[0].workspace, actors, parentArtifacts: artifacts.dir });
      await runtime.writeStartMeta(artifacts, { ...options, repoRoot: runtime.repoRoot, runDir: artifacts.dir,
        workspaceDir: actors[0].workspace, configHome: actors[0].configHome, requestsDir: artifacts.requestsDir }, binary, options.scenario);
      await json(path.join(artifacts.dir, 'cross-target-inputs.json'), { binary, expectedSha, actors, providerBudget: { base: 6, extraListPages: 2, maximum: 8 }, gatewayArtifacts: gateway.artifacts });
      browser = await chromium.launch({ ...browserLaunchOptions(options), ...(process.env.KCODER_E2E_CHROMIUM_BIN ? { executablePath: process.env.KCODER_E2E_CHROMIUM_BIN } : {}) });
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
      for (const actor of actors) {
        const runDir = path.join(artifacts.dir, actor.alias); await mkdir(runDir);
        const session = await runtime.startSession({ ...options, repoRoot: runtime.repoRoot, runDir, workspaceDir: actor.workspace,
          configHome: actor.configHome, requestsDir: artifacts.requestsDir,
          commandOverride: `${quote(binary)} --cwd {workspace} --peer-gateway-server ${actor.alias}` }); sessions.push(session);
        const page = await browser.newPage({ viewport: { width: 1100, height: 760 } }); pages.push(page); await page.goto(session.url);
        await page.waitForFunction(() => window.tuiLab?.ready && window.tuiLab.visibleText().includes('Ask KCoder'), null, { timeout: options.timeoutMs });
        assert.equal(await page.evaluate(() => window.tuiLab.renderer), 'webgl');
        const image = `/proc/${session.ptyProcess.pid}/exe`, hash = createHash('sha256');
        await new Promise((done, reject) => createReadStream(image).on('data', bytes => hash.update(bytes)).on('end', done).on('error', reject));
        const observed = { actor: actor.alias, pid: session.ptyProcess.pid, path: await readlink(image), sha256: hash.digest('hex') };
        assert.equal(observed.sha256, expectedSha); processes.push(observed);
      }
      assert.notEqual(processes[0].pid, processes[1].pid); assert.equal(requests, 0);
      await gateway.waitForPeerSockets(2); await gateway.rememberCredentials(); assert.equal(new Set(gateway.deviceIds()).size, 2);
      await captureStep(pages[1], trace, 'original-independent-cross-target-receiver-idle', path.join(artifacts.dir, 'receiver-idle.png'));
      await submitTerminalLine(pages[0], TRIGGER);
      await waitFor(async () => { assert.deepEqual(errors, []); return pages[0].evaluate(marker => window.tuiLab.visibleText().includes(marker)
        && !window.tuiLab.visibleText().toLowerCase().includes('esc interrupt'), SOURCE_DONE); }, options.timeoutMs, 'original cross-target Source completes');
      releaseSource();
      await waitFor(async () => { assert.deepEqual(errors, []); return pages[1].evaluate(marker => window.tuiLab.visibleText().includes(marker)
        && !window.tuiLab.visibleText().toLowerCase().includes('esc interrupt'), RECEIVER_DONE); }, options.timeoutMs, 'original cross-target Receiver discovers and replies');
      await pages[0].waitForFunction(marker => window.tuiLab.visibleText().includes(marker), BACK, { timeout: options.timeoutMs });
      await pages[0].waitForTimeout(1000); assert.deepEqual(errors, []);
      assert.equal(states[0].calls, states[0].pages.length + 2); assert.equal(states[1].calls, states[1].pages.length + 2);
      assert.ok(states.every(state => state.pages.length >= 1 && state.pages.length <= 2));
      const history = [await histories(actors[0], sourceAddress.threadId), await histories(actors[1], destination.threadId)];
      for (let index = 0; index < 2; index++) {
        const messages = history[index].rows.map(row => row.message ?? row), peer = messages.filter(message => message.origin === 'peer_agent');
        assert.deepEqual(messages.filter(message => message.origin === 'user').map(text), index === 0 ? [TRIGGER] : []);
        assert.equal(peer.length, 1); const receipt = states[1 - index].receipt;
        assert.equal(text(peer[0]), index === 0 ? BACK : PEER); assert.equal(peer[0].agent_message.messageId, receipt.messageId);
        assert.deepEqual(peer[0].agent_message.sourceAddress, receipt.sourceAddress); assert.deepEqual(peer[0].agent_message.targetAddress, receipt.targetAddress);
        assert.equal(peer[0].agent_message.bodySha256, digest(index === 0 ? BACK : PEER));
      }
      const receipts = [await authoritativeReceipt(actors[1], destination, states[0].receipt.messageId), await authoritativeReceipt(actors[0], sourceAddress, states[1].receipt.messageId)];
      for (let index = 0; index < 2; index++) {
        assert.equal(receipts[index].status, 'applied'); assert.equal(receipts[index].messageId, states[index].receipt.messageId);
        assert.equal(receipts[index].clientMessageId, states[index].receipt.clientMessageId);
        assert.deepEqual(receipts[index].sourceAddress, states[index].receipt.sourceAddress); assert.deepEqual(receipts[index].targetAddress, states[index].receipt.targetAddress);
      }
      await captureStep(pages[0], trace, 'cross-target-source-has-original-reply', path.join(artifacts.dir, 'source-complete.png'));
      await captureStep(pages[1], trace, 'cross-target-receiver-has-original-peer', path.join(artifacts.dir, 'receiver-complete.png'));
      outcome = null;
      return { realPty: true, renderer: 'webgl', actualAuthenticatedGateway: true, transport: 'actual-http-pairing-and-device-wss',
        distinctProfilesAndWorkspaces: true, distinctCanonicalTargetIds: true, sourceAddress, destination, processes,
        providerRequests: requests, actorRequests: states.map(s => s.calls), listPages: states.map(s => s.pages.length),
        observedSendReceipts: states.map(s => s.receipt), authoritativeReceipts: receipts, nativeHistories: history,
        originalUserRows: [1, 0], originalPeerRows: [1, 1], noSyntheticReceiverUser: true, sendCountPerActor: [1, 1],
        deviceIds: gateway.deviceIds(), network: gateway.network.snapshot(), gatewayArtifacts: gateway.artifacts,
        loopbackProviderOnly: true, autonomousModelBehaviorProven: false, windowsIntegrationProven: false };
    },
    captureBeforeCleanup: async () => {
      for (let i = 0; i < sessions.length; i++) {
        await writeFile(path.join(artifacts.dir, `${actors[i].alias}.pty.log`), sessions[i].getPtyLog());
        await writeFile(path.join(artifacts.dir, `${actors[i].alias}.screen.txt`), await pages[i]?.evaluate(() => window.tuiLab?.visibleText() ?? '').catch(() => '') ?? '');
      }
      await json(path.join(artifacts.dir, 'cross-target-provider-observations.json'), observations);
    },
    cleanup: async () => {
      releaseSource(); const report = await cleanupOwnedBrowserSessions({ browser, sessions });
      if (gateway) report.steps.push(await settleLifecycleStep('owned-cross-target-device-gateway', () => gateway.finish(outcome)));
      report.steps.push(await settleLifecycleStep('owned-cross-target-provider', () => new Promise(done => { provider.closeAllConnections(); provider.close(done); })));
      return report;
    },
    onFailure: async error => { await json(artifacts.failure, { error: String(error), errors, requests, actorRequests: states.map(s => s.calls),
      listPages: states.map(s => s.pages), processes, sourceAddress, destination, gatewayArtifacts: gateway?.artifacts }); console.error(artifacts.dir); },
    onSuccess: async (result, cleanup) => { await verifyRunContextIntegrity(artifacts, runtime.runContextRuntime());
      await json(artifacts.assertions, { ok: true, ...result }); await json(artifacts.meta, { result, cleanup, trace }); console.log(artifacts.dir); },
  });
}
