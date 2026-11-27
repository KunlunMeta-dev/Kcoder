import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readlink, realpath, symlink, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { startSourceDesktop } from '../../harness/source-desktop.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { hashExecutableFile, findOwnedExecutableProcesses } from '../../harness/owned-executable-provenance.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { composerTextDifference, composerTextDigest, fillComposerText, nativeTurnText, normalizeComposerText, readComposerDiagnostics, readComposerText } from '../../harness/composer-input.mjs';
import { CONTENT, MARKERS, taskDeliveryResponses } from '../../fixtures/task-delivery/provider.mjs';
import { CANONICAL_REPOSITORY, ORIGIN, REPOSITORY, STATE_FILE, configureFixtureGit, git, loadForge, remoteHead, setCheck } from '../../fixtures/task-delivery/forge.mjs';
import { inspectOwnedKcoder } from '../../fixtures/task-delivery/inspect.mjs';
import { installedDeliveryInputs, prepareWindowsDelivery, resolveFixtureGit } from '../../fixtures/task-delivery/windows.mjs';

const workspaceHost = process.env.KCODER_E2E_WORKSPACE_HOST || 'browser';
assert.ok(['browser', 'electron'].includes(workspaceHost));
const installedDirectory = process.env.KCODER_E2E_PACKAGED_DIR;
assert.ok(!installedDirectory || workspaceHost === 'electron', 'an installed package requires the actual Electron host');
const sourceFixture = fileURLToPath(new URL('../../fixtures/task-delivery/', import.meta.url));
const A_DRAFT = 'KEEP_ORIGINAL_A_UNSENT_DRAFT';
const B_DRAFT = 'KEEP_SELECTED_B_UNSENT_DRAFT';
const B_FIX_DRAFT = 'KEEP_B_DRAFT_BEFORE_SELECTED_CI_FEEDBACK';
const MAX_REQUESTS = 16;

await runE2E(import.meta.url, {
  testId: `task-comparison-selected-delivery-native-evidence-and-draft-ownership${workspaceHost === 'electron' ? '-electron' : ''}${installedDirectory ? '-installed' : ''}`,
  cleanupTimeoutMs: installedDirectory ? 180000 : undefined,
  tier: 'full-integration',
  modelPolicy: `deterministic local provider for UI/protocol/tool/ownership round-trips; artifact=${installedDirectory ? 'actual-installed' : 'source'}; real Gateway, Native, worktrees, commits and local bare push; synthetic forge only, no real GitHub or model quality claim`,
  retainSuccessLogs: true,
}, async context => {
  assert.ok(['linux', 'win32'].includes(process.platform), 'UNMET_PREREQUISITE: owned Linux or Windows process evidence required');
  const windows = process.platform === 'win32';
  if (windows) {
    assert.equal(workspaceHost, 'electron', 'Windows acceptance requires the actual Electron host');
    assert.ok(installedDirectory, 'Windows acceptance requires the verified actual installation');
  }
  if (installedDirectory) assert.equal(windows, true, 'installed artifact acceptance requires actual Windows');
  const installed = installedDirectory ? installedDeliveryInputs(installedDirectory) : null;
  const deadline = Date.now() + 300_000;
  const nativeBin = installed?.nativeBin ?? (process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, `target/debug/kcoder${windows ? '.exe' : ''}`));
  const electronBin = installed?.electronBin ?? (process.env.KCODER_E2E_ELECTRON_BIN || resolve(repoRoot, `apps/kcoder-studio/node_modules/electron/dist/electron${windows ? '.exe' : ''}`));
  const gitBin = await resolveFixtureGit(); const gitProof = await hashExecutableFile(gitBin);
  configureFixtureGit(gitProof);
  // The dedicated suite process never reads an ambient Git profile while materializing fixtures.
  process.env.GIT_CONFIG_NOSYSTEM = '1'; process.env.GIT_CONFIG_GLOBAL = windows ? 'NUL' : '/dev/null';
  const processOwnerLabel = workspaceHost === 'electron' ? 'task-delivery-electron' : 'task-delivery-gateway';
  const evidence = { stage: 'setup', host: workspaceHost, boundary: 'real local Git and Native; synthetic forge/CI, not GitHub platform acceptance', steps: [], connections: [], deliveries: [], turnRequests: [], turnReceipts: [], gitObservations: [], bindingReceipts: [], composerDocuments: [], outboundChecks: [], failureReferences: [], threadReads: [], reviewTransitions: [], navigationEvents: [], workspaceMetadata: [], rpcErrors: [], diagnostics: { console: [], http: [], requests: [], sockets: [] } };
  evidence.nativeExecutable = await hashExecutableFile(nativeBin);
  evidence.artifact = installed ? 'actual-installed' : 'source';
  if (!installed) evidence.rendererFreshness = await assertRendererBuildFresh();
  const { path: workspace } = await materializeWorkspace(context, 'git-history', { instanceId: 'comparison-owner-a', gitBin });
  const config = context.pathInState('delivery-profile'); const bareRemote = context.pathInState('bare-remote.git');
  const bin = context.pathInState('fixture-bin');
  // Chromium's temporary Unix sockets need a short path; the scratch remains identity-bound to this run.
  const temp = windows ? context.pathInState(`${processOwnerLabel}-temporary`) : workspaceHost === 'electron'
    ? (await context.createOwnedScratchDirectory('td', { baseDirectory: '/tmp' })).path
    : context.pathInState('shell-temp');
  await Promise.all([mkdir(config, { recursive: true, mode: 0o700 }), mkdir(bin, { recursive: true, mode: 0o700 }), mkdir(temp, { recursive: true, mode: 0o700 })]);
  const windowsFixture = windows ? await prepareWindowsDelivery(context, { nativeBin, gitBin, electronBin }) : null;
  if (!windows) await symlink(join(sourceFixture, 'gh.mjs'), join(bin, 'gh'));
  await ownedCommand(context, 'init-owned-bare', gitBin, ['init', '--bare', '--initial-branch=main', bareRemote], workspace);
  await ownedCommand(context, 'seed-owned-bare', gitBin, ['-c', 'protocol.file.allow=always', 'push', bareRemote, 'HEAD:refs/heads/main'], workspace);
  await ownedCommand(context, 'set-logical-origin', gitBin, ['remote', 'add', 'origin', ORIGIN], workspace);
  const common = git(workspace, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  await writeFile(join(common, STATE_FILE), `${JSON.stringify({ version: 1, repository: REPOSITORY, origin: ORIGIN,
    runRoot: context.stateDir, bareRemote, pullRequests: [], checks: {}, publicationRequests: [] }, null, 2)}\n`, { mode: 0o600 });
  const originalDirty = 'USER_OWNED_DIRTY_SOURCE_MUST_SURVIVE\n';
  await writeFile(join(workspace, 'user-owned-dirty.txt'), originalDirty);
  const baseCommit = git(workspace, ['rev-parse', 'HEAD']);
  const model = await startApprovalModelFixture(context, { usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    responseSteps: taskDeliveryResponses({ deadline, maxRequests: MAX_REQUESTS, gitProof }) });
  // Explicit allowlists replace the implicit cwd grant. Each owned A/B/C task resolves '.' to its own cwd.
  const sandboxPolicy = { enabled: true, readonly: false, ...(!windows ? { landlock: true } : {}), allow_shell_escalation: false,
    allow_system_temp_writes: false, allow_shared_dev_cache_writes: false, allowed_paths: ['.', common, bareRemote, temp] };
  evidence.sandboxPolicy = sandboxPolicy;
  evidence.sandboxBackend = windows ? 'WindowsRestrictedToken' : 'Landlock';
  evidence.gitExecutable = gitProof;
  context.registerSecret('owned-local-delivery-key');
  await context.writeStateJson('delivery-profile/credentials.json', { 'delivery-fixture': { type: 'api', key: 'owned-local-delivery-key' } });
  await context.writeStateJson('delivery-profile/settings.json', { history_enabled: true, max_retries: 0,
    permission_mode: 'accept_edits', permission_rules: [
      { tool: 'write', input_pattern: 'file_path=owner-result.txt', action: 'allow' },
      { tool: 'write', input_pattern: 'file_path=alternative.txt', action: 'allow' },
    ], sandbox: sandboxPolicy,
    active_provider: 'delivery-fixture', providers: { 'delivery-fixture': { api_format: 'openai_chat_completions',
      endpoint: model.baseUrl, default_model: 'owned-task-delivery-model', context_window_tokens: 128000,
      output_headroom_tokens: 2048, max_output_tokens: 2048, max_retries: 0, request_timeout_secs: 20,
      no_proxy: true, discover_models: false, extra_body: {} } } });
  await pinSources(context);
  let gateway, page;
  const hostEnvironment = { PATH: `${bin}${delimiter}${process.env.PATH}`, TMPDIR: temp, ...(windows ? { TEMP: temp, TMP: temp } : {}) };
  if (workspaceHost === 'electron') {
    const desktop = await startSourceDesktop(context, { label: processOwnerLabel, workspace, profile: config, env: hostEnvironment,
      ...(installed ? { ...installed.desktop, nativeWitness: windowsFixture.nativeWitness }
        : { kcoderBin: windowsFixture?.nativeLauncher ?? nativeBin }) });
    page = desktop.page;
    evidence.electronExecutable = await hashExecutableFile(electronBin);
    if (installed) {
      assert.ok(desktop.installedIdentity && desktop.nativeWitness, 'installed resources and transparent Native witness must both be verified');
      assert.equal(await realpath(desktop.installedIdentity.nativePath), evidence.nativeExecutable.path);
      assert.equal(desktop.installedIdentity.nativeSha256, evidence.nativeExecutable.sha256, 'all Native facts must come from the installed manifest image');
      assert.equal(await realpath(desktop.installedIdentity.hostPath), evidence.electronExecutable.path);
      assert.equal(desktop.installedIdentity.hostSha256, evidence.electronExecutable.sha256);
      for (const key of ['path', 'sha256', 'configurationSha256', 'owner'])
        assert.equal(desktop.nativeWitness[key], windowsFixture.nativeWitness[key]);
      assert.equal(desktop.nativeWitness.nativeSha256, desktop.installedIdentity.nativeSha256);
      evidence.installedIdentity = desktop.installedIdentity; evidence.nativeWitness = desktop.nativeWitness;
    }
    if (windows) {
      assert.equal(desktop.hostReceipt?.phase, 'ready');
      evidence.windowsHostReceipt = desktop.hostReceipt;
    }
    context.registerPort('task-delivery-electron-gateway', Number(new URL(page.url()).port));
    await page.setViewportSize({ width: 1520, height: 1100 });
  } else {
    gateway = await startGateway(context, { label: processOwnerLabel, workspace, auth: true, kcoderBin: nativeBin,
      env: { KCODER_CONFIG_DIR: config, ...hostEnvironment } });
    const chromium = await startChromium(context, { label: 'task-delivery-chromium' });
    page = await chromium.newPage({ viewport: { width: 1520, height: 1100 } });
  }
  page.setDefaultTimeout(15000);
  evidence.blockedExternalRequests = [];
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      evidence.blockedExternalRequests.push({ hostname: url.hostname, path: url.pathname });
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  let latestComparison = null; let latestDelivery = null; let latestFailure = null; let pendingComposerSend = null; let approvals = 0; let failure;
  const budget = () => { assert.ok(Date.now() < deadline, 'coherent UI flow exceeded five-minute budget'); assert.ok(model.requests.length <= MAX_REQUESTS, 'provider request budget exceeded'); };
  page.on('console', message => { if (message.type() === 'error' && evidence.diagnostics.console.length < 40) evidence.diagnostics.console.push({ stage: evidence.stage, type: 'error', text: message.text() }); });
  page.on('pageerror', error => { if (evidence.diagnostics.console.length < 40) evidence.diagnostics.console.push({ stage: evidence.stage, type: 'pageerror', text: error.message }); });
  page.on('response', response => { if (response.status() >= 400 && evidence.diagnostics.http.length < 40) evidence.diagnostics.http.push({ status: response.status(), path: new URL(response.url()).pathname }); });
  page.on('requestfailed', request => { if (evidence.diagnostics.requests.length < 40) evidence.diagnostics.requests.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText }); });
  page.on('websocket', socket => {
    const url = new URL(socket.url()); evidence.connections.push({ server: url.searchParams.get('server'), workspace: url.searchParams.get('workspace') });
    const pendingMethods = new Map();
    socket.on('socketerror', error => evidence.diagnostics.sockets.push(String(error)));
    socket.on('framesent', event => {
      try {
        const frame = JSON.parse(String(event.payload));
        if (frame.id != null && frame.method) {
          const pending = { method: frame.method, commandKey: frame.params?.command_key ?? frame.params?.commandKey, path: frame.params?.path,
            ownerThreadId: frame.params?.ownerThreadId, threadId: frame.params?.threadId, taskId: frame.params?.taskId, comparisonId: frame.params?.comparisonId };
          if (['thread/read', 'thread/resume'].includes(frame.method) && evidence.threadReads.length < 64) {
            pending.threadRead = { method: frame.method, threadId: pending.threadId, workspace: url.searchParams.get('workspace'), status: 'pending' };
            evidence.threadReads.push(pending.threadRead);
          }
          pendingMethods.set(frame.id, pending);
        }
        if (frame.method === 'turn/start' && evidence.turnRequests.length < 16) {
          const actual = normalizeComposerText(nativeTurnText(frame.params));
          evidence.turnRequests.push({ threadId: frame.params?.threadId, clientMessageId: frame.params?.clientMessageId, text: composerTextDigest(actual) });
          if (pendingComposerSend) pendingComposerSend.actual.push({ threadId: frame.params?.threadId, clientMessageId: frame.params?.clientMessageId, text: actual });
        }
      } catch {}
    });
    socket.on('framereceived', event => {
      try {
        const frame = JSON.parse(String(event.payload));
        const pending = pendingMethods.get(frame.id);
        if (pending?.threadRead) Object.assign(pending.threadRead, { status: frame.error ? 'rejected' : 'received',
          resultThreadId: frame.result?.thread?.id ?? frame.result?.threadId ?? null,
          messageIds: frame.result?.messages?.slice(-12).map(message => ({ id: message.id, turnId: message.turnId, role: message.role })) ?? [], errorCode: frame.error?.code ?? null });
        if (frame.error && evidence.rpcErrors.length < 40) evidence.rpcErrors.push({ stage: evidence.stage, method: pending?.method ?? null, code: frame.error.code, message: frame.error.message });
        if (pending?.method === 'device/execute' && ['git_branch_list', 'git_branch'].includes(pending.commandKey) && evidence.gitObservations.length < 40)
          evidence.gitObservations.push({ commandKey: pending.commandKey, path: pending.path ?? null, workspace: url.searchParams.get('workspace'), success: frame.result?.success === true, stdout: frame.result?.stdout ?? null });
        if (pending?.method === 'runtime.worktrees.comparison.bind' && evidence.bindingReceipts.length < 8)
          evidence.bindingReceipts.push({ ownerThreadId: pending.ownerThreadId, threadId: pending.threadId, taskId: pending.taskId, comparisonId: pending.comparisonId, path: pending.path,
            error: frame.error ?? null, candidateThreads: frame.result?.candidates?.map(candidate => candidate.binding?.threadId) ?? null });
        if (frame.id != null && !frame.method) pendingMethods.delete(frame.id);
        if (frame.result?.checkId && typeof frame.result?.prompt === 'string' && typeof frame.result?.rawEvidence === 'string') {
          latestFailure = frame.result;
          if (evidence.failureReferences.length < 4) evidence.failureReferences.push({ threadId: latestFailure.threadId, recipient: latestFailure.recipient, headCommit: latestFailure.headCommit,
            checkId: latestFailure.checkId, rawEvidence: latestFailure.rawEvidence.slice(0, 8192), truncated: latestFailure.truncated });
        }
        if (['turn/started', 'turn/completed'].includes(frame.method) && evidence.turnReceipts.length < 32)
          evidence.turnReceipts.push({ method: frame.method, threadId: frame.params?.threadId, turnId: frame.params?.turn?.id ?? frame.params?.turnId });
        if (Array.isArray(frame.result?.candidates)) latestComparison = frame.result;
        if (frame.result?.deliveryId && frame.result?.source) {
          latestDelivery = frame.result;
          if (evidence.deliveries.length < 20) evidence.deliveries.push({ id: latestDelivery.deliveryId, threadId: latestDelivery.threadId,
            recipient: latestDelivery.recipient, source: latestDelivery.source, status: latestDelivery.status, requestId: latestDelivery.request?.requestId ?? null });
        }
      } catch {}
    });
  });
  const input = () => page.getByTestId('chat-message-input');
  const ownerMessage = () => page.getByTestId('message-assistant').filter({ hasText: MARKERS.ownerDone }).last();
  const review = () => page.getByTestId('environment-task-review-dialog');
  const comparisonPanel = () => review().getByTestId('task-comparison-panel');
  const deliveryPanel = () => review().getByTestId('task-delivery-panel');
  const activeTask = () => new URL(page.url()).searchParams.get('taskId');
  const assertConversationReviewAbsent = async () => {
    const messages = page.getByTestId('message-assistant');
    for (const id of ['task-review-panel', 'task-review-files', 'task-review-open-file', 'task-review-feedback',
      'native-review-evidence', 'native-review-open-artifact', 'native-review-feedback',
      'task-review-open-comparison', 'task-review-open-delivery', 'task-comparison-panel', 'task-delivery-panel'])
      assert.equal(await messages.getByTestId(id).count(), 0, `${id} must be confined to the review dialog, outside the conversation`);
  };
  const closeReviewDialog = async () => {
    if (await review().isVisible()) {
      await page.keyboard.press('Escape');
      await review().waitFor({ state: 'hidden', timeout: 5000 });
    }
  };
  const openReviewDialog = async () => {
    assert.equal(activeTask(), evidence.owner.taskId, 'review dialog must belong to the actual owner A');
    await ownerMessage().waitFor();
    await assertConversationReviewAbsent();
    if (!(await review().isVisible())) {
      const button = page.getByTestId('task-review-toolbar-button');
      await button.waitFor(); await button.click(); await review().waitFor();
    }
    await waitFor(async () => await review().getByTestId('task-review-panel').count() === 1,
      15000, 'one selected completed owner turn in the toolbar review dialog', 75, context.abortSignal);
  };
  let sectionClickCount = 0;
  const isDetached = error => /not attached|detached|has been disposed/i.test(String(error?.message));
  const ensureReviewSection = async (summaryId, panel, needsIdle = false) => {
    await openReviewDialog();
    const until = Date.now() + 30000; let clicks = 0; let lastObservation = '';
    while (Date.now() < until) {
      budget(); assert.equal(activeTask(), evidence.owner.taskId, 'review navigation must stay on actual owner A');
      const article = review(); const summary = article.getByTestId(summaryId);
      if (!(await article.count()) || !(await summary.count())) { await page.waitForTimeout(75); continue; }
      const messageId = await ownerMessage().getAttribute('data-message-id');
      const handle = await summary.elementHandle(); if (!handle) continue;
      const details = await handle.$('xpath=..');
      try {
        const open = details && await details.getAttribute('open') !== null;
        const present = await panel().count();
        const busy = present && needsIdle ? await panel().getAttribute('aria-busy', { timeout: 300 }).catch(() => null) : null;
        const observation = { summaryId, messageId, open, panelPresent: present > 0, busy, taskId: activeTask() };
        const serialized = JSON.stringify(observation);
        if (serialized !== lastObservation && evidence.reviewTransitions.length < 80) { evidence.reviewTransitions.push(observation); lastObservation = serialized; }
        if (!open) {
          assert.ok(++clicks <= 3 && ++sectionClickCount <= 24, 'review details repeatedly remounted; inspect owned view transitions');
          // Click this exact observed closed node; a detached snapshot cannot re-resolve into a new already-open section.
          await handle.click({ timeout: 2000 });
        } else {
          assert.equal(await summary.locator('..').getByRole('alert').count(), 0, 'review section reported an actual target/Native error');
          if (present && (!needsIdle || busy === 'false') && await handle.isVisible() && await panel().count()) return;
        }
      } catch (error) { if (!isDetached(error)) throw error; }
      finally { await details?.dispose(); await handle.dispose(); }
      await page.waitForTimeout(75);
    }
    throw new Error(`Actual owner review section ${summaryId} did not remain open/ready; inspect view and thread-read evidence`);
  };
  const openComparison = async () => {
    await ensureReviewSection('task-review-open-comparison', comparisonPanel, true);
    assert.equal(await comparisonPanel().getByTestId('task-comparison-error').count(), 0, 'comparison must not bypass a Native/broker rejection');
  };
  const refreshComparison = async () => {
    await openComparison();
    const button = await comparisonPanel().getByTestId('task-comparison-refresh').elementHandle();
    assert.ok(button, 'visible comparison refresh must exist');
    try { await button.click({ timeout: 2000 }); }
    catch (error) { if (!isDetached(error)) throw error; }
    finally { await button.dispose(); }
    // A returned transcript may replace the message DOM while the read resolves. Re-open only an observed closed section.
    await openComparison();
  };
  const row = label => comparisonPanel().getByTestId('task-comparison-candidate').filter({ has: page.getByText(label, { exact: true }) });
  const openTask = async taskId => {
    await closeReviewDialog();
    const knownThread = taskId === evidence.owner?.taskId ? evidence.owner.threadId
      : latestComparison?.candidates.find(candidate => candidate.binding.taskId === taskId)?.binding.threadId;
    assert.ok(knownThread, 'sidebar navigation must use a previously observed actual task/thread');
    const readOffset = evidence.threadReads.length;
    const item = page.getByTestId(`runtime-local-task-row-${taskId}`); await item.scrollIntoViewIfNeeded(); await item.click();
    await waitFor(() => activeTask() === taskId, 20000, 'explicit sidebar task navigation');
    await input().waitFor(); let stableSince = 0; let stableMessage = null;
    await waitFor(async () => {
      if (activeTask() !== taskId || evidence.threadReads.some(read => read.threadId === knownThread && read.status === 'pending')) { stableSince = 0; return false; }
      const article = taskId === evidence.owner.taskId ? ownerMessage() : page.getByTestId('message-assistant').last();
      const messageId = await article.count() ? await article.getAttribute('data-message-id', { timeout: 250 }).catch(() => null) : null;
      if (!messageId) { stableSince = 0; return false; }
      if (messageId !== stableMessage || !stableSince) { stableMessage = messageId; stableSince = Date.now(); }
      return Date.now() - stableSince >= 500;
    }, 20000, 'selected task transcript hydration and stable visible message identity', 75, context.abortSignal);
    assert.equal(evidence.threadReads.slice(readOffset).some(read => read.threadId === knownThread && read.status === 'rejected'), false, 'actual task transcript read was rejected');
    await assertConversationReviewAbsent();
    evidence.navigationEvents.push({ taskId, threadId: knownThread, messageId: stableMessage, threadReadCount: evidence.threadReads.length - readOffset });
  };
  const settle = async marker => {
    for (let count = 0; count < 8; count++) {
      budget();
      const state = await waitFor(async () => {
        if (await page.getByTestId('message-assistant').filter({ hasText: marker }).count()) return 'complete';
        if (await page.getByTestId('permission-approval-content').count()) return 'approval';
        return null;
      }, Math.min(45000, deadline - Date.now()), `ordinary Native tool turn ${marker}`, 100, context.abortSignal);
      if (state === 'complete') {
        const started = evidence.turnReceipts.filter(receipt => receipt.method === 'turn/started').at(-1);
        assert.ok(started?.threadId && started?.turnId, 'the actual Native turn-start identity must be observed');
        await waitFor(async () => evidence.turnReceipts.some(receipt => receipt.method === 'turn/completed' && receipt.threadId === started.threadId && receipt.turnId === started.turnId)
          && await page.getByTestId('pause-response-button').count() === 0 && await page.getByTestId('thinking-indicator').count() === 0,
          Math.min(30000, deadline - Date.now()), 'actual Native terminal receipt and stopped UI', 100, context.abortSignal);
        return;
      }
      assert.ok(++approvals <= 8, 'unexpected additional tool approvals exceeded budget');
      const card = page.getByTestId('request-user-input-card').filter({ has: page.getByTestId('permission-approval-content') }).first();
      assert.match(await card.innerText(), /alternative\.txt|task-delivery\/actions\.mjs/, 'approval must name only this owned fixture capability');
      await card.locator('[data-testid^="request-user-input-option-"]').filter({ hasText: /Allow once|仅允许这一次/ }).click();
      await card.waitFor({ state: 'detached' });
    }
    throw new Error('ordinary Native turn did not settle inside approval budget');
  };
  const send = async (prompt, { threadId = null, required = [], existingDraft = false } = {}) => {
    await closeReviewDialog();
    const expected = existingDraft ? normalizeComposerText(prompt) : await fillComposerText(page, prompt, { signal: context.abortSignal });
    const current = await readComposerText(page);
    const structure = await readComposerDiagnostics(page);
    const expectedDigest = composerTextDigest(expected);
    evidence.composerDocuments.push({ stage: evidence.stage, existingDraft, ...composerTextDifference(expected, current), structure });
    if (structure.serialized) assert.ok(structure.serialized.sha256 === expectedDigest.sha256 && structure.serialized.bytes === expectedDigest.bytes,
      'the actual controlled composer serialization differs from its complete checked draft; inspect owned digest evidence');
    assert.ok(current === expected, 'controlled composer must retain the complete checked draft before Send; inspect owned digest/structure evidence');
    assert.ok(pendingComposerSend === null, 'another explicit composer Send is still being observed');
    const observation = { actual: [] }; pendingComposerSend = observation;
    try {
      await page.getByTestId('send-message-button').click();
      const actual = await waitFor(() => observation.actual[0] ?? null, 20000, 'actual Native turn/start user text after explicit Send', 50, context.abortSignal);
      const checks = { stage: evidence.stage, threadId: actual.threadId, clientMessageId: actual.clientMessageId,
        expected: composerTextDigest(expected), actual: composerTextDigest(actual.text), exact: actual.text === expected,
        refs: required.map(({ name, text }) => ({ name, matched: actual.text.includes(text), ...composerTextDigest(text) })) };
      evidence.outboundChecks.push(checks);
      assert.equal(observation.actual.length, 1, 'one explicit Send must produce one Native turn/start');
      assert.ok(checks.exact, 'Native outbound user text differs from the full controlled document; inspect owned digest evidence');
      if (threadId) assert.equal(actual.threadId, threadId, 'Send must retain the selected actual recipient');
      assert.ok(checks.refs.every(reference => reference.matched), 'Native outbound text lost an existing draft or exact Native evidence reference');
    } finally { pendingComposerSend = null; }
  };
  const candidateReady = async (label, marker) => {
    for (let attempt = 0; attempt < 24; attempt++) {
      budget(); await refreshComparison();
      if (await row(label).getByTestId('task-comparison-result').filter({ hasText: marker }).count()) return;
      await page.waitForTimeout(250);
    }
    throw new Error(`Native candidate ${label} did not expose its completed result`);
  };
  const openDelivery = async () => {
    await ensureReviewSection('task-review-open-delivery', deliveryPanel);
    await deliveryPanel().getByTestId('task-delivery-prepare').waitFor();
  };
  const reconcileRetainedDelivery = async (expected, workspace, label) => {
    assert.match(expected.deliveryId, /^[a-f0-9]{64}$/, 'the original delivery must have a real Native identity');
    assert.match(expected.requestId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,
      'the original publication must have its acknowledged stable request ID');
    assert.match(expected.requestDraftSha256, /^[a-f0-9]{64}$/);
    for (const value of [expected.threadId, expected.comparisonId, expected.recipient?.taskId,
      expected.recipient?.threadId, expected.recipient?.deviceId, expected.source?.repository,
      expected.source?.branch, expected.source?.baseBranch]) assert.ok(typeof value === 'string' && value.length > 0);
    for (const name of ['headCommit', 'baseCommit']) assert.match(expected.source[name], /^[a-f0-9]{40,64}$/);
    for (const name of ['diffSha256', 'workingSha256']) assert.match(expected.source[name], /^[a-f0-9]{64}$/);
    assert.equal(expected.source.dirty, false);
    const identityMatches = () => {
      assert.match(latestDelivery?.deliveryId ?? '', /^[a-f0-9]{64}$/);
      assert.equal(latestDelivery.deliveryId, expected.deliveryId);
      assert.equal(latestDelivery.threadId, expected.threadId);
      assert.equal(latestDelivery.comparisonId, expected.comparisonId);
      assert.deepEqual(latestDelivery.recipient, expected.recipient);
      assert.equal(latestDelivery.request?.requestId, expected.requestId);
      assert.equal(latestDelivery.request?.draftSha256, expected.requestDraftSha256);
      assert.deepEqual(latestDelivery.source, expected.source);
    };
    await openDelivery();
    const requestsBefore = model.requests.length, publicationsBefore = loadForge(workspace).state.publicationRequests.length;
    const unknown = await deliveryPanel().getByTestId('task-delivery-current-unknown').isVisible();
    let recovery = 'existing-record';
    if (unknown) assert.equal(await deliveryPanel().getByTestId('task-delivery-prepare').isDisabled(), true,
      'an unknown restored request must be reconciled before another prepare');
    if (!(await deliveryPanel().getByTestId('task-delivery-refresh').count())) {
      // A source/response view may need to reopen its durable Native record.
      // Preparing here must recover the same identity and edited draft, never a new request.
      assert.equal(unknown, false, 'an unknown prepared record must expose its read action');
      assert.equal(await deliveryPanel().getByTestId('task-delivery-prepare').isEnabled(), true);
      assert.equal(latestComparison?.selectedThreadId, expected.recipient.threadId);
      const selected = latestComparison.candidates.find(candidate => candidate.binding.threadId === expected.recipient.threadId);
      assert.ok(selected?.binding.selection);
      assert.equal(selected.binding.branch, expected.source.branch);
      assert.equal(selected.git?.headCommit, expected.source.headCommit);
      const offset = evidence.deliveries.length;
      await deliveryPanel().getByTestId('task-delivery-prepare').click();
      await waitFor(async () => evidence.deliveries.length > offset
        && await deliveryPanel().getByTestId('task-delivery-title').isVisible(),
        20000, 'recover the exact durable delivery record before reconciliation', 75, context.abortSignal);
      identityMatches(); recovery = 'recovered-durable-record';
    }
    assert.equal(await deliveryPanel().getByTestId('task-delivery-queue-publication').isDisabled(), true,
      'an existing publication intent cannot be replayed');
    assert.equal(await deliveryPanel().getByTestId('task-delivery-title').inputValue(), 'Edited owned task delivery title');
    assert.equal(await deliveryPanel().getByTestId('task-delivery-body').inputValue(), 'Edited owned PR body; preserve exact B commit.');
    identityMatches();
    const readOffset = evidence.deliveries.length;
    await deliveryPanel().getByTestId('task-delivery-refresh').click();
    await waitFor(async () => evidence.deliveries.length > readOffset
      && await deliveryPanel().getByTestId('task-delivery-current-unknown').count() === 0
      && await deliveryPanel().getByRole('alert').count() === 0,
      20000, `read-only reconciliation of retained delivery ${label}`, 75, context.abortSignal);
    identityMatches();
    assert.equal(await deliveryPanel().getByTestId('task-delivery-title').inputValue(), 'Edited owned task delivery title');
    assert.equal(await deliveryPanel().getByTestId('task-delivery-body').inputValue(), 'Edited owned PR body; preserve exact B commit.');
    assert.equal(model.requests.length, requestsBefore, 'delivery reconciliation must not send a provider request');
    assert.equal(loadForge(workspace).state.publicationRequests.length, publicationsBefore,
      'delivery reconciliation must not repeat the publication');
    evidence.steps.push({ label, recovery, unknownBeforeRead: unknown, deliveryId: expected.deliveryId, requestId: expected.requestId,
      recipient: expected.recipient, headCommit: expected.source.headCommit, modelRequests: model.requests.length });
  };
  const snapshotCandidate = async (candidate, phase) => {
    if (!candidate || evidence.workspaceMetadata.length >= 16) return;
    const metadata = await inspectOwnedKcoder({ runRoot: context.stateDir, workspace: candidate.path });
    evidence.workspaceMetadata.push({ phase, label: candidate.binding.label, threadId: candidate.binding.threadId, modelRequests: model.requests.length, ...metadata });
  };


  try {
    evidence.stage = 'owner-original-dirty-source';
    if (workspaceHost === 'browser') {
      await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
      const token = page.locator('input[name="token"]');
      if (await token.count()) { await token.fill(gateway.authToken); await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]); }
    }
    await page.getByTestId('desktop-sidebar').waitFor();
    evidence.hostRuntime = await page.evaluate(() => ({ userAgent: navigator.userAgent, nativeBridge: typeof window.kcoderDesktopHost?.windowAction === 'function' }));
    if (workspaceHost === 'electron') {
      assert.match(evidence.hostRuntime.userAgent, /Electron\/\d+\.\d+\.\d+/); assert.equal(evidence.hostRuntime.nativeBridge, true);
      assert.notEqual(new URL(page.url()).pathname, '/login');
    }
    await context.writeArtifactJson('workspace-host.json', { host: workspaceHost, artifact: evidence.artifact, ...evidence.hostRuntime,
      ...(evidence.installedIdentity ? { installedIdentity: evidence.installedIdentity, nativeWitness: evidence.nativeWitness } : {}) });
    evidence.stage = 'select-owned-source-project';
    evidence.sourceProjectSelection = await selectOwnedSourceProject(page, workspace, evidence);
    evidence.stage = 'owner-original-dirty-source';
    await send(`${MARKERS.owner}: compare two implementations of the owned alternative file, keep existing source changes.`);
    await settle(MARKERS.ownerDone);
    const aTaskId = activeTask(); assert.ok(aTaskId); assert.equal(model.requests.length, 2);
    evidence.owner = { taskId: aTaskId, workspace, baseCommit, threadId: evidence.turnRequests[0]?.threadId ?? null };
    const ownerTurn = evidence.turnReceipts.find(receipt => receipt.method === 'turn/started' && receipt.threadId === evidence.owner.threadId);
    assert.ok(ownerTurn?.turnId, 'the selected review must retain the actual completed owner turn identity');
    evidence.owner.turnId = ownerTurn.turnId;
    await page.getByTestId('environment-info-button').click();
    const activeWorkspace = await page.getByTestId('environment-workspace-path-button').getAttribute('title');
    assert.equal(await realpath(activeWorkspace ?? ''), await realpath(workspace), 'A must use the explicitly selected dirty source, not a newly created Home chat');
    evidence.selectedOriginalWorkspace = activeWorkspace;
    await page.getByTestId('environment-info-button').click();
    await openReviewDialog();
    await review().getByTestId('native-review-evidence').waitFor();
    const ownerToolOutputs = await review().getByTestId('native-review-output').allTextContents();
    assert.equal(await review().getByTestId('native-review-failures').count(), 0, `A Native write failed: ${ownerToolOutputs.join(' | ')}`);
    assert.equal(await readFile(join(workspace, 'owner-result.txt'), 'utf8'), 'Owned original task result; existing dirty user file must survive.\n', 'the actual Native write must complete in A source before review');
    await closeReviewDialog(); await fillComposerText(page, A_DRAFT, { signal: context.abortSignal }); await openComparison();
    evidence.steps.push({ label: 'original-owner-result-and-unsent-dirty-source', modelRequests: model.requests.length });

    evidence.stage = 'ui-create-two-independent-running-alternatives';
    for (const [label, branch, prompt] of [['B', 'owned/alternative-b', MARKERS.b], ['C', 'owned/alternative-c', MARKERS.c]]) {
      const add = comparisonPanel().getByTestId('task-comparison-add');
      if ((await add.locator('..').getAttribute('open')) === null) await add.click();
      await comparisonPanel().getByTestId('task-comparison-label').fill(label);
      await comparisonPanel().getByTestId('task-comparison-branch').fill(branch);
      await comparisonPanel().getByTestId('task-comparison-approach').fill(prompt);
      await comparisonPanel().getByTestId('task-comparison-create').click();
      await waitFor(async () => (await comparisonPanel().getAttribute('aria-busy')) === 'false', 45000, 'UI creates and binds an actual candidate');
      assert.equal(await comparisonPanel().getByTestId('task-comparison-error').count(), 0);
      assert.equal(await input().innerText(), A_DRAFT);
      if (!(await row(label).count())) {
        // Reconcile through the visible refresh action; never recreate an unknown candidate.
        evidence.steps.push({ label: 'explicit-ui-refresh-after-candidate-creation', candidate: label });
        for (let attempt = 0; attempt < 12 && !(await row(label).count()); attempt++) {
          budget(); await refreshComparison(); await page.waitForTimeout(100);
        }
      }
      assert.equal(await row(label).count(), 1, 'candidate missing after visible refresh reconciliation; inspect the owned Native bind receipt and comparison projection');
      const createdCandidate = latestComparison?.candidates.find(candidate => candidate.binding.label === label);
      assert.ok(createdCandidate, 'the visible candidate must have a matching actual Native binding');
      await snapshotCandidate(createdCandidate, 'after-bind-before-open');
      await row(label).getByTestId('task-comparison-open-task').click();
      await waitFor(() => activeTask() === createdCandidate.binding.taskId, 20000, 'comparison opens its actual candidate task');
      await closeReviewDialog();
      await settle(label === 'B' ? MARKERS.bDone : MARKERS.cDone);
      await snapshotCandidate(createdCandidate, 'after-actual-tool-turn');
      await openTask(aTaskId);
      await candidateReady(label, label === 'B' ? MARKERS.bDone : MARKERS.cDone);
    }
    assert.equal(model.requests.length, 8);
    assert.ok(latestComparison && latestComparison.candidates.length === 2);
    assert.equal(latestComparison.ownerThreadId, evidence.owner.threadId, 'toolbar review must retain the original owner A');
    assert.equal(latestComparison.comparisonId, evidence.owner.turnId, 'comparison must remain bound to the actual completed owner turn');
    const b = latestComparison.candidates.find(candidate => candidate.binding.label === 'B');
    const c = latestComparison.candidates.find(candidate => candidate.binding.label === 'C');
    assert.ok(b && c); assert.notEqual(b.path, c.path); assert.notEqual(b.binding.threadId, c.binding.threadId);
    assert.equal(b.binding.baseCommit, baseCommit); assert.equal(c.binding.baseCommit, baseCommit);
    assert.equal(await readFile(join(b.path, 'alternative.txt'), 'utf8'), CONTENT.b);
    assert.equal(await readFile(join(c.path, 'alternative.txt'), 'utf8'), CONTENT.c);
    assert.ok(b.checks.some(check => check.exitCode === 7 && check.outcome === 'failed'));
    assert.ok(c.checks.some(check => check.exitCode === 0 && check.outcome === 'passed'));
    assert.ok(b.usage.inputTokens > 0 && b.usage.outputTokens > 0 && c.usage.usageSamples > 0);
    await row('B').getByTestId('task-comparison-check-outcome').filter({ hasText: /检查失败|Check failed|Failed/i }).waitFor();
    assert.match(await row('B').getByTestId('task-comparison-usage').innerText(), /tokens/);
    assert.match(await row('B').getByTestId('task-comparison-cost').innerText(), /未知|unknown/i);
    const native = windows ? await windowsFixture.processes(evidence.windowsHostReceipt)
      : await findOwnedExecutableProcesses({ pgid: context.processes.get(processOwnerLabel).pgid, executablePath: nativeBin });
    for (const process of native) {
      if (!windows) process.workspace = await realpath(await readlink(`/proc/${process.pid}/cwd`));
      assert.equal(process.sha256, evidence.nativeExecutable.sha256, 'all owned app-servers must run the pinned current Native image');
    }
    const aPath = await realpath(workspace); const bPath = await realpath(b.path); const cPath = await realpath(c.path);
    const aProcess = native.find(item => item.workspace === aPath);
    const bProcess = native.find(item => item.workspace === bPath);
    const cProcess = native.find(item => item.workspace === cPath);
    assert.ok(bProcess && cProcess && bProcess.pid !== cProcess.pid, 'B/C must execute in distinct actual app-server processes');
    assert.ok(aProcess && new Set([aProcess.pid, bProcess.pid, cProcess.pid]).size === 3, 'A/B/C must retain three independently bound current Native processes');
    evidence.candidates = { b, c }; evidence.nativeProcesses = native;
    Object.assign(evidence.owner, { threadId: latestComparison.ownerThreadId, comparisonId: latestComparison.comparisonId });
    evidence.steps.push({ label: 'two-real-worktrees-app-servers-native-checks-and-known-usage', modelRequests: model.requests.length });
    await row('B').scrollIntoViewIfNeeded(); await screenshot(page, context, '00-native-failure-vs-model-claim.png');
    assert.equal(await readFile(join(workspace, 'user-owned-dirty.txt'), 'utf8'), originalDirty);
    assert.equal(git(workspace, ['rev-parse', 'HEAD']), baseCommit);
    await openTask(b.binding.taskId); await fillComposerText(page, B_DRAFT, { signal: context.abortSignal });
    await openTask(aTaskId); assert.equal(await input().innerText(), A_DRAFT); await refreshComparison();
    evidence.selectionButtonLabel = (await row('B').getByTestId('task-comparison-select').innerText()).trim();
    assert.equal(evidence.selectionButtonLabel, '选为交付来源', 'the actual Chinese control must not expose the raw select translation key');
    await row('B').getByTestId('task-comparison-select').click(); await row('B').getByTestId('task-comparison-selected').waitFor();

    evidence.stage = 'prepare-edited-pr-without-sending';
    await openDelivery(); await deliveryPanel().getByTestId('task-delivery-prepare').click();
    await deliveryPanel().getByTestId('task-delivery-title').waitFor();
    assert.equal(latestDelivery.recipient.threadId, b.binding.threadId);
    assert.equal(latestDelivery.source.headCommit, b.git.headCommit);
    assert.equal(latestDelivery.source.dirty, false);
    await deliveryPanel().getByTestId('task-delivery-title').fill('Edited owned task delivery title');
    await deliveryPanel().getByTestId('task-delivery-body').fill('Edited owned PR body; preserve exact B commit.');
    const beforeQueue = model.requests.length;
    await deliveryPanel().getByTestId('task-delivery-queue-publication').click();
    await waitFor(() => activeTask() === b.binding.taskId, 20000, 'publication intent opens actual selected B task');
    await closeReviewDialog();
    const publicationReference = await waitFor(() => typeof latestDelivery?.request?.prompt === 'string' ? latestDelivery.request : null,
      20000, 'actual acknowledged Native publication reference', 50, context.abortSignal);
    await waitFor(async () => activeTask() === b.binding.taskId && await input().count() > 0
      && (await input().innerText()).includes(B_DRAFT) && (await input().innerText()).includes(publicationReference.prompt),
      20000, 'actual B controlled composer hydrates its old draft and complete Native publication intent', 75, context.abortSignal);
    const publicationDraft = await input().innerText();
    assert.ok(publicationDraft.includes(B_DRAFT) && publicationDraft.includes('Edited owned task delivery title'));
    assert.ok(publicationDraft.includes(b.git.headCommit));
    assert.ok(publicationReference?.prompt && publicationDraft.includes(publicationReference.prompt), 'B draft must include the complete acknowledged Native publication intent');
    assert.equal(model.requests.length, beforeQueue, 'prepare and queue do not send a model turn');
    assert.equal(loadForge(b.path).state.pullRequests.length, 0);
    const originalDelivery = { deliveryId: latestDelivery.deliveryId, threadId: latestDelivery.threadId,
      comparisonId: latestDelivery.comparisonId, recipient: { ...latestDelivery.recipient },
      requestId: publicationReference.requestId, requestDraftSha256: publicationReference.draftSha256,
      source: { ...latestDelivery.source } };
    evidence.steps.push({ label: 'editable-pr-intent-only-in-selected-b-draft', modelRequests: model.requests.length, requestId: latestDelivery.request?.requestId });
    await openTask(aTaskId); assert.equal(await input().innerText(), A_DRAFT);
    await openTask(b.binding.taskId); assert.ok(normalizeComposerText(await input().innerText()) === normalizeComposerText(publicationDraft), 'B publication draft must survive task navigation unchanged');
    await screenshot(page, context, '01-selected-b-preserved-publication-draft.png');

    evidence.stage = 'explicit-b-send-real-local-git-publication';
    await send(publicationDraft, { existingDraft: true, threadId: b.binding.threadId, required: [
      { name: 'preserved-B-draft', text: B_DRAFT }, { name: 'full-Native-publication-intent', text: publicationReference.prompt },
      { name: 'exact-source-commit', text: b.git.headCommit }, { name: 'stable-publication-request', text: publicationReference.requestId },
    ] }); await settle(MARKERS.published);
    assert.equal(model.requests.length, 10); assert.equal(remoteHead(b.path, loadForge(b.path).state, b.binding.branch), b.git.headCommit);
    assert.equal(loadForge(b.path).state.publicationRequests.length, 1);
    assert.equal(loadForge(b.path).state.publicationRequests[0].requestId, evidence.steps.find(step => step.label === 'editable-pr-intent-only-in-selected-b-draft').requestId);
    evidence.steps.push({ label: 'explicit-user-send-through-engine-local-push-and-fixture-pr', modelRequests: model.requests.length });
    await fillComposerText(page, B_FIX_DRAFT, { signal: context.abortSignal }); await openTask(aTaskId); await openComparison();
    await reconcileRetainedDelivery(originalDelivery, b.path, 'retained-publication-is-reconciled-before-reading-ci');
    await deliveryPanel().getByTestId('task-delivery-queue-failure').waitFor();
    assert.equal(latestDelivery.status.pushState, 'pushed'); assert.equal(latestDelivery.status.pullRequest.matchesRequest, true);
    assert.equal(latestDelivery.status.pullRequest.number, 1, 'the same-head/request wrong-base decoy must not be selected');
    assert.equal(latestDelivery.status.pullRequest.url, `https://github.com/${CANONICAL_REPOSITORY}/pull/1`, 'canonical repository casing must retain the intended PR identity');
    assert.equal(latestDelivery.status.ciState, 'failed'); assert.equal(latestDelivery.status.pullRequest.reviewState, 'REVIEW_REQUIRED');
    await deliveryPanel().getByTestId('task-delivery-queue-failure').click();
    await waitFor(() => activeTask() === b.binding.taskId, 20000, 'selected failed check routes to original B task');
    await closeReviewDialog();
    const failureReference = await waitFor(() => typeof latestFailure?.prompt === 'string' ? latestFailure : null,
      20000, 'actual acknowledged selected Native failure reference', 50, context.abortSignal);
    await waitFor(async () => activeTask() === b.binding.taskId && await input().count() > 0
      && (await input().innerText()).includes(B_FIX_DRAFT) && (await input().innerText()).includes(failureReference.prompt),
      20000, 'actual B controlled composer hydrates its old draft and complete selected failure context', 75, context.abortSignal);
    const feedback = await input().innerText();
    assert.ok(feedback.includes(B_FIX_DRAFT) && feedback.includes('SELECTED_FIXTURE_CI_FAILURE') && feedback.includes(b.git.headCommit));
    assert.ok(failureReference?.prompt && feedback.includes(failureReference.prompt), 'B draft must preserve the complete selected Native failure context');
    assert.equal(failureReference.recipient.threadId, b.binding.threadId); assert.equal(failureReference.headCommit, b.git.headCommit);
    assert.equal(model.requests.length, 10, 'CI feedback is an unsent draft');
    assert.ok(feedback.includes(latestDelivery.status.checks[0].checkId));
    evidence.steps.push({ label: 'selected-raw-failure-and-exact-commit-only-in-b-draft', modelRequests: model.requests.length });
    await openTask(aTaskId); assert.equal(await input().innerText(), A_DRAFT);
    setCheck(b.path, b.git.headCommit, 'success');
    await reconcileRetainedDelivery(originalDelivery, b.path, 'retained-original-request-keeps-source-identity-on-green-ci-read');
    await waitFor(() => latestDelivery?.status.ciState === 'passed', 20000, 'old commit green is explicitly observed before a fix');
    assert.equal(latestDelivery.source.headCommit, b.git.headCommit);
    await screenshot(page, context, '02-old-commit-ci-and-original-a-draft.png');

    evidence.stage = 'explicit-b-fix-new-commit-invalidates-old-green';
    await openTask(b.binding.taskId); assert.ok(normalizeComposerText(await input().innerText()) === normalizeComposerText(feedback), 'B CI feedback draft must survive task navigation unchanged');
    await send(feedback, { existingDraft: true, threadId: b.binding.threadId, required: [
      { name: 'preserved-B-fix-draft', text: B_FIX_DRAFT }, { name: 'full-Native-failure-context', text: failureReference.prompt },
      { name: 'exact-failed-commit', text: failureReference.headCommit }, { name: 'selected-check', text: failureReference.checkId },
    ] }); await settle(MARKERS.fixed);
    assert.equal(model.requests.length, 14); assert.equal(await readFile(join(b.path, 'alternative.txt'), 'utf8'), CONTENT.fixed);
    const fixedHead = git(b.path, ['rev-parse', 'HEAD']); assert.notEqual(fixedHead, b.git.headCommit);
    assert.equal(remoteHead(b.path, loadForge(b.path).state, b.binding.branch), b.git.headCommit, 'fix does not auto-publish');
    assert.ok(model.requests.slice(10).some(request => request.messages.some(message => message.role === 'tool' && message.tool_call_id === 'delivery-fix-read' && JSON.stringify(message.content).includes(CONTENT.b.trim()))));
    await openTask(aTaskId); await openDelivery(); await deliveryPanel().getByTestId('task-delivery-prepare').click();
    await waitFor(async () => await deliveryPanel().getByRole('alert').count() > 0 || latestDelivery?.source.headCommit === fixedHead, 20000, 'changed selected source is rejected or refreshed, never inherited green');
    assert.equal(await deliveryPanel().getByText(/已观察的检查通过|Observed checks passed/).count(), 0);
    await refreshComparison(); await row('B').getByTestId('task-comparison-select').click(); await row('B').getByTestId('task-comparison-selected').waitFor();
    const deliveryToggle = review().getByTestId('task-review-open-delivery');
    if ((await deliveryToggle.locator('..').getAttribute('open')) !== null) {
      await deliveryToggle.click(); await deliveryPanel().waitFor({ state: 'detached' });
    }
    await openDelivery(); await deliveryPanel().getByTestId('task-delivery-prepare').click();
    await waitFor(() => latestDelivery?.source.headCommit === fixedHead && latestDelivery?.status.ciState === 'unknown', 20000, 'new commit starts without old CI approval');
    assert.equal(latestDelivery.recipient.threadId, b.binding.threadId);
    await deliveryPanel().getByTestId('task-delivery-refresh').click();
    await waitFor(() => latestDelivery?.source.headCommit === fixedHead && latestDelivery?.status.ciState === 'none', 20000, 'real Native query does not attach old green checks to the new commit');
    assert.equal(latestDelivery.status.checks.length, 0); assert.equal(latestDelivery.status.pushState, 'notPushed');
    assert.equal(loadForge(b.path).state.checks[b.git.headCommit].conclusion, 'success');
    assert.equal(await input().innerText(), A_DRAFT); assert.equal(await readFile(join(c.path, 'alternative.txt'), 'utf8'), CONTENT.c);
    assert.equal(git(c.path, ['rev-parse', 'HEAD']), c.git.headCommit);
    assert.equal(await readFile(join(workspace, 'user-owned-dirty.txt'), 'utf8'), originalDirty);
    assert.equal(git(workspace, ['rev-parse', 'HEAD']), baseCommit); budget();
    evidence.fixedHead = fixedHead; evidence.modelRequests = model.requests.length; evidence.approvals = approvals;
    assert.equal(evidence.turnRequests.length, 5, 'only owner, two alternatives, explicit publication and explicit fix may start turns');
    assert.ok(evidence.turnRequests.every(request => typeof request.clientMessageId === 'string' && request.clientMessageId.length > 0));
    assert.equal(new Set(evidence.turnRequests.map(request => request.clientMessageId)).size, 5, 'each explicit turn has one stable request identity');
    evidence.steps.push({ label: 'complete-ui-native-selected-source-local-publication-and-ci-feedback', ownerTask: aTaskId, sourceTask: b.binding.taskId, peerTask: c.binding.taskId });
    assert.deepEqual(evidence.blockedExternalRequests, []); assert.deepEqual(evidence.diagnostics.http, []); assert.deepEqual(evidence.diagnostics.requests, []); assert.deepEqual(evidence.diagnostics.sockets, []);
    assert.deepEqual(evidence.diagnostics.console, [], 'unexpected browser console error in the coherent delivery flow');
    await screenshot(page, context, '03-new-commit-has-no-old-green.png'); evidence.stage = 'passed';
  } catch (error) { failure = error; evidence.failure = error.stack ?? String(error);
    for (const candidate of latestComparison?.candidates ?? []) await snapshotCandidate(candidate, 'failure').catch(metadataError => evidence.workspaceMetadata.push({ label: candidate.binding.label, error: metadataError.message }));
    evidence.composerFailureStructure = await readComposerDiagnostics(page).catch(error => ({ error: error.message }));
    evidence.failureView = { taskId: activeTask(), ownerMarkers: await ownerMessage().count(), reviewDialogs: await review().count(), comparisonPanels: await comparisonPanel().count(),
      comparisonOpen: await review().getByTestId('task-review-open-comparison').locator('..').getAttribute('open', { timeout: 500 }).catch(() => null) };
    evidence.ownerReview = (await review().count()) ? await review().innerText().catch(() => null) : null; evidence.nativeOutputs = await page.getByTestId('native-review-output').allTextContents().catch(() => []); await screenshot(page, context, `failure-${evidence.stage}.png`).catch(() => undefined); }
  finally {
    evidence.modelRequests = model.requests.length; evidence.lastComparison = latestComparison;
    await context.writeArtifactJson('task-comparison-delivery.json', evidence);
    await pinSources(context, true);
    if (windowsFixture) await windowsFixture.verifyPins();
    if (evidence.electronExecutable) assert.deepEqual(await hashExecutableFile(evidence.electronExecutable.path), evidence.electronExecutable, 'explicit Electron input must remain unchanged during the run');
  }
  if (failure) throw failure;
});

async function selectOwnedSourceProject(page, workspace, evidence) {
  const trigger = page.getByTestId('project-work-button').first();
  await trigger.waitFor(); await trigger.click();
  const menu = page.getByTestId('project-work-menu'); await menu.waitFor();
  const options = menu.getByTestId('project-options-list').locator('button[data-testid^="project-option-"]');
  await waitFor(async () => await options.count() > 0, 20000, 'actual Native startup workspace choices');
  assert.equal(await options.count(), 1, 'fresh owned target must expose exactly its single configured Native source project');
  const option = options.first();
  const selected = { testId: await option.getAttribute('data-testid'), label: (await option.innerText()).trim(), configuredWorkspace: workspace };
  assert.ok(selected.testId?.startsWith('project-option-'));
  await option.click(); await menu.waitFor({ state: 'hidden' });
  await page.getByTestId('execution-mode-button').click();
  await page.getByTestId('execution-mode-current-workspace-button').click();
  // Opening the real branch selector makes a fresh read through the selected workspace's Native channel.
  const before = evidence.gitObservations.length;
  await page.getByTestId('project-branch-button').click();
  await page.getByTestId('project-branch-menu').waitFor();
  await page.getByTestId('project-branch-option').filter({ hasText: /^main$/ }).waitFor();
  const observation = await waitFor(() => evidence.gitObservations.slice(before).find(item => item.commandKey === 'git_branch_list' && item.success),
    20000, 'selected workspace Native branch-list receipt before any model request');
  const actualWorkspace = observation.path ?? observation.workspace;
  assert.ok(actualWorkspace, 'Native workspace routing evidence must contain an explicit path or channel workspace');
  assert.equal(await realpath(actualWorkspace), await realpath(workspace), 'the selected Native source must be the owned fixture before A starts');
  assert.match(String(observation.stdout), /main/);
  await page.keyboard.press('Escape'); await page.getByTestId('project-branch-menu').waitFor({ state: 'hidden' });
  return { ...selected, nativeObservation: observation };
}

async function ownedCommand(context, label, command, args, cwd) {
  const child = context.spawnOwned(label, command, args, { cwd, env: context.isolatedEnvironment() });
  await waitFor(() => child.exitCode !== null, 15000, `owned setup ${label}`, 50, context.abortSignal);
  assert.equal(child.exitCode, 0, `owned setup command ${label} failed`);
}
async function screenshot(page, context, name) {
  const path = context.pathInCase(workspaceHost === 'electron' ? installedDirectory ? 'installed-electron' : 'source-electron' : 'system-chromium', 'task-comparison-delivery', name);
  await mkdir(dirname(path), { recursive: true }); await page.screenshot({ path, fullPage: true });
}
async function pinSources(context, final = false) {
  const inputs = ['forge.mjs', 'gh.mjs', 'actions.mjs', 'provider.mjs', 'inspect.mjs', 'windows.mjs', 'windows-launcher.c'].map(name => ({ name, path: join(sourceFixture, name) }));
  inputs.push({ name: 'harness/source-desktop.mjs', path: fileURLToPath(new URL('../../harness/source-desktop.mjs', import.meta.url)) });
  inputs.push({ name: 'harness/composer-input.mjs', path: fileURLToPath(new URL('../../harness/composer-input.mjs', import.meta.url)) });
  if (installedDirectory) {
    inputs.push({ name: 'harness/installed-desktop-identity.mjs', path: fileURLToPath(new URL('../../harness/installed-desktop-identity.mjs', import.meta.url)) });
    inputs.push({ name: 'scripts/release/artifact-manifest.mjs', path: resolve(repoRoot, 'scripts/release/artifact-manifest.mjs') });
  }
  const files = await Promise.all(inputs.map(async ({ name, path }) => ({ name,
    sha256: createHash('sha256').update(await readFile(path)).digest('hex') })));
  if (final) assert.deepEqual(files, JSON.parse(await readFile(context.pathInArtifacts('fixture-source-pins.json'), 'utf8')));
  else await context.writeArtifactJson('fixture-source-pins.json', files);
}
