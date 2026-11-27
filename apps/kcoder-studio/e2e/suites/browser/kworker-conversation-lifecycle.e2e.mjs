import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

// Keep control files created by this owned test process private.
process.umask(0o077);
const homeOnly = process.env.KCODER_E2E_HOME_COMPOSER_ONLY === '1';

const prompts = [
  'KWORKER_LIFECYCLE_FIRST: return a short acknowledgement.',
  'KWORKER_LIFECYCLE_FOLLOWUP: continue the same conversation with a short acknowledgement.',
  'KWORKER_LIFECYCLE_CANCEL: begin a response that will be stopped in the browser.',
  'KWORKER_LIFECYCLE_AFTER_CANCEL: answer this as a new turn in the same conversation.',
];
const promptMarkers = prompts.map(prompt => prompt.match(/KWORKER_LIFECYCLE_[A-Z_]+/)?.[0] ?? '');
const replies = [
  'KWORKER_LIFECYCLE_FIRST_COMPLETE',
  'KWORKER_LIFECYCLE_FOLLOWUP_COMPLETE',
  null,
  'KWORKER_LIFECYCLE_AFTER_CANCEL_COMPLETE',
];
const projectSetupPrompt = 'KWORKER_B01B05_PROJECT_SETUP: return a short acknowledgement.';
const projectSetupMarker = 'KWORKER_B01B05_PROJECT_SETUP';
const newChatPrompt = 'KWORKER_B01B05_NEW_CHAT: return a short acknowledgement.';
const newChatMarker = 'KWORKER_B01B05_NEW_CHAT';
const projectSetupReply = 'KWORKER_B01B05_PROJECT_SETUP_COMPLETE';
const newChatReply = 'KWORKER_B01B05_NEW_CHAT_COMPLETE';
const expectedProviderPromptMarkers = [...promptMarkers, projectSetupMarker, newChatMarker];
const partialReply = 'KWORKER_LIFECYCLE_CANCEL_HELD_PARTIAL';
const lateReply = 'KWORKER_LIFECYCLE_CANCEL_LATE_AFTER_CANCEL';
const syntheticMarkers = [...new Set([
  ...expectedProviderPromptMarkers,
  ...replies.filter(Boolean),
  projectSetupReply,
  newChatReply,
  partialReply,
  lateReply,
])];

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: homeOnly ? 'home-composer-without-storage-hint' : 'kworker-no-project-single-thread-four-turn-cancel-lifecycle',
  tier: 'full-integration',
  modelPolicy: homeOnly ? 'Real browser and owned Gateway; checks the home composer in both work modes without starting a model turn.' :
    'real browser, owned Gateway and source CLI with a loopback scripted Provider; proves explicit KWorker selection, same-thread continuation and cancellation protocol/UI lifecycle only, not model quality',
  retainSuccessEvidence: true,
}, async context => {
  assert.ok(process.env.KCODER_E2E_KCODER_BIN, 'KCODER_E2E_KCODER_BIN must pin the supplied source-bound CLI');
  assert.ok(process.env.KCODER_E2E_KCODER_BIN_SHA256, 'KCODER_E2E_KCODER_BIN_SHA256 must pin the supplied source-bound CLI bytes');
  const binary = await requireExecutable(resolve(process.env.KCODER_E2E_KCODER_BIN), 'supplied source-bound KCoder CLI');
  const binarySha256 = await sha256File(binary);
  assert.equal(binarySha256, process.env.KCODER_E2E_KCODER_BIN_SHA256, 'the source-bound CLI must match its supplied SHA-256 pin');

  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'kworker-conversation-lifecycle' });
  const scratchBase = process.env.KCODER_E2E_NATIVE_SERVICE_SCRATCH_BASE;
  const privateScratch = scratchBase
    ? await context.createOwnedScratchDirectory('kworker-lifecycle', {
      baseDirectory: scratchBase,
      requiredBytes: 512n * 1024n * 1024n,
    })
    : null;
  const privateHome = privateScratch
    ? context.pathInScratch(privateScratch, 'home')
    : context.pathInState('private-home');
  const privateTemp = privateScratch
    ? context.pathInScratch(privateScratch, 'tmp')
    : context.pathInState('tmp');
  await mkdir(privateHome, { recursive: true, mode: 0o700 });
  await mkdir(privateTemp, { recursive: true, mode: 0o700 });
  const providerPromptMarkers = [];
  const providerRequestMetadata = [];
  const providerErrors = [];
  let fourthPromptObserved = false;
  const model = await startApprovalModelFixture(context, {
    responseSteps: ({ body, requestNumber }) => {
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const latestUser = [...messages].reverse().find(message => message?.role === 'user');
      const userText = textContent(latestUser?.content);
      const promptMarker = expectedProviderPromptMarkers.find(marker => marker && userText.includes(marker)) ?? null;
      const systemText = messages
        .filter(message => message?.role === 'system')
        .map(message => textContent(message?.content))
        .join('\n')
        .toLowerCase();
      const serializedMessages = JSON.stringify(messages);
      providerPromptMarkers.push(promptMarker);
      providerRequestMetadata.push({
        requestNumber,
        latestUserMarker: promptMarker,
        toolsCount: Array.isArray(body.tools) ? body.tools.length : null,
        maxTokens: body.max_tokens ?? body.max_output_tokens ?? null,
        messageRoleCounts: messages.reduce((counts, message) => {
          const role = typeof message?.role === 'string' ? message.role : 'unknown';
          counts[role] = (counts[role] ?? 0) + 1;
          return counts;
        }, {}),
        systemMessageCount: messages.filter(message => message?.role === 'system').length,
        systemSignals: {
          compact: /\bcompact(?:ion|ed|ing)?\b/.test(systemText),
          summary: /\bsummar(?:y|ies|ized|ization)\b/.test(systemText),
          memory: /\bmemory\b/.test(systemText),
        },
        messageSignals: {
          compactionSchema: body.response_format?.json_schema?.name === 'kcoder_compaction_summary',
          summaryTag: /<summary>|kcoder_compaction_summary/i.test(serializedMessages),
          memoryTag: /\bmemory\b/i.test(serializedMessages),
        },
      });
      if (requestNumber === 4 && promptMarker === promptMarkers[3]) fourthPromptObserved = true;
      if (requestNumber > expectedProviderPromptMarkers.length || promptMarker !== expectedProviderPromptMarkers[requestNumber - 1]) {
        providerErrors.push({ requestNumber, promptMarker });
        return [{ delta: { role: 'assistant', content: 'KWORKER_LIFECYCLE_UNEXPECTED_PROVIDER_REQUEST' }, finishReason: 'stop' }];
      }
      if (requestNumber === 3) {
        return [
          { delta: { role: 'assistant', content: partialReply } },
          { ready: () => fourthPromptObserved, delta: { role: 'assistant', content: lateReply } },
          { ready: () => fourthPromptObserved, delta: {}, finishReason: 'stop' },
        ];
      }
      if (requestNumber === 5) {
        return [{ delta: { role: 'assistant', content: projectSetupReply }, finishReason: 'stop' }];
      }
      if (requestNumber === 6) {
        return [{ delta: { role: 'assistant', content: newChatReply }, finishReason: 'stop' }];
      }
      return [{ delta: { role: 'assistant', content: replies[requestNumber - 1] }, finishReason: 'stop' }];
    },
  });

  const settings = {
    active_provider: 'kworker-lifecycle-fixture',
    max_retries: 0,
    session_memory: { enabled: false },
    providers: {
      'kworker-lifecycle-fixture': {
        api_format: 'openai_chat_completions',
        authentication: { mode: 'none' },
        endpoint: model.baseUrl,
        default_model: 'kworker-lifecycle-fixture',
        context_window_tokens: 262144,
        max_output_tokens: 256,
        output_headroom_tokens: 256,
        request_timeout_secs: 60,
        no_proxy: true,
        discover_models: false,
      },
    },
  };
  await writeFile(resolve(privateHome, 'settings.json'), JSON.stringify(settings), { mode: 0o600 });
  const serversFile = await context.writeStateJson('servers.json', [{
    id: 'local',
    label: 'KWorker conversation lifecycle fixture',
    transport: 'local',
    command: binary,
    workspace,
  }]);
  const gateway = await startGateway(context, {
    workspace,
    serversFile,
    kcoderBin: binary,
    auth: true,
    startTimeoutMs: 180_000,
    env: {
      HOME: privateHome,
      USERPROFILE: privateHome,
      KCODER_HOME: privateHome,
      KCODER_CONFIG_DIR: privateHome,
      TMPDIR: privateTemp,
      TMP: privateTemp,
      TEMP: privateTemp,
    },
  });
  const browser = await startChromium(context, { label: 'kworker-conversation-lifecycle' });
  const page = await browser.newPage({ viewport: { width: 1360, height: 920 } });
  const wire = { threadStarts: [], turnStarts: [], interrupts: [], threadReads: [], terminals: [], protocolEvents: [] };
  const browserErrors = [];
  let acceptancePhase = 'b22-four-turn-lifecycle';
  const wait = (predicate, label, timeoutMs = 30_000) => waitFor(predicate, timeoutMs, label, 40, context.abortSignal);
  const assertSingleAssistantArticle = async (marker, label) => {
    const matchingArticles = page.getByTestId('message-assistant').filter({ hasText: marker });
    const matchingVisibleArticles = page.locator('[data-testid="message-assistant"]:visible').filter({ hasText: marker });
    const articleCount = await matchingArticles.count();
    const visibleArticleCount = await matchingVisibleArticles.count();
    assert.equal(articleCount, 1, `${label}: expected one assistant article for ${marker}, got ${articleCount}`);
    assert.equal(visibleArticleCount, 1, `${label}: expected one visible assistant article for ${marker}, got ${visibleArticleCount}`);
    return { marker, articleCount, visibleArticleCount };
  };
  const recordProtocolEvent = (direction, method, frame, request = null) => {
    if (wire.protocolEvents.length >= 256) return;
    const payload = direction === 'sent' ? frame.params ?? {} : direction === 'received' ? frame.result ?? {} : frame.params ?? {};
    const turn = payload.turn ?? {};
    wire.protocolEvents.push({
      order: wire.protocolEvents.length + 1,
      direction,
      method,
      ...(request?.requestId != null ? { requestId: request.requestId } : frame.id != null ? { requestId: frame.id } : {}),
      threadId: payload.threadId ?? payload.thread?.id ?? turn.threadId ?? request?.threadId ?? null,
      turnId: payload.turnId ?? turn.id ?? request?.turnId ?? null,
      status: turn.status ?? payload.status ?? (method === 'turn/interrupted' ? 'interrupted' : method === 'turn/failed' ? 'failed' : null),
      markerHits: markersIn(payload),
    });
  };

  page.on('pageerror', error => browserErrors.push(context.redactText(error.message)));
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(context.redactText(message.text().slice(0, 1000)));
  });
  page.on('websocket', socket => {
    const pending = new Map();
    socket.on('framesent', event => {
      try {
        const frame = JSON.parse(String(event.payload));
        if (frame.id == null) return;
        let request;
        if (frame.method === 'thread/start') {
          request = {
            method: frame.method,
            requestId: frame.id,
            requestedStudioWorkMode: frame.params?.studioWorkMode ?? null,
            requestedCwd: frame.params?.cwd ?? null,
            requestedWorkspacePath: frame.params?.workspacePath ?? null,
            threadId: null,
            studioWorkMode: null,
            receivedCwd: null,
            errorCode: null,
          };
          wire.threadStarts.push(request);
        } else if (frame.method === 'turn/start') {
          request = {
            method: frame.method,
            requestId: frame.id,
            threadId: frame.params?.threadId ?? null,
            promptMarker: expectedProviderPromptMarkers.find(marker => marker && textContent(frame.params?.input).includes(marker)) ?? null,
            requestedCwd: frame.params?.cwd ?? null,
            requestedWorkspacePath: frame.params?.workspacePath ?? null,
            studioWorkMode: frame.params?.clientPresentation?.studioWorkMode ?? null,
            turnId: null,
            errorCode: null,
          };
          wire.turnStarts.push(request);
        } else if (frame.method === 'turn/interrupt') {
          request = { method: frame.method, requestId: frame.id, threadId: frame.params?.threadId ?? null, turnId: frame.params?.turnId ?? null, interrupted: null, errorCode: null };
          wire.interrupts.push(request);
        } else if (frame.method === 'thread/read' || frame.method === 'thread/read/indexed') {
          request = {
            method: frame.method,
            requestId: frame.id,
            threadId: frame.params?.threadId ?? null,
            threadStatus: null,
            requestPage: {
              limit: frame.params?.limit ?? null,
              beforeCursorKind: cursorKind(frame.params?.beforeCursor),
            },
            segment: null,
            messages: [],
            errorCode: null,
          };
          wire.threadReads.push(request);
        }
        if (request) {
          pending.set(frame.id, request);
          recordProtocolEvent('sent', request.method, frame, request);
        }
      } catch {}
    });
    socket.on('framereceived', event => {
      try {
        const frame = JSON.parse(String(event.payload));
        if (frame.id != null) {
          const request = pending.get(frame.id);
          if (request) {
            pending.delete(frame.id);
            request.errorCode = frame.error?.code ?? null;
            if (request.method === 'thread/start') {
              request.threadId = frame.result?.thread?.id ?? null;
              request.studioWorkMode = frame.result?.thread?.studioWorkMode ?? null;
              request.threadStatus = frame.result?.thread?.status ?? null;
              request.receivedCwd = frame.result?.thread?.cwd ?? frame.result?.thread?.workspacePath ?? null;
            }
            if (request.method === 'turn/start') request.turnId = frame.result?.turn?.id ?? frame.result?.turnId ?? null;
            if (request.method === 'turn/interrupt') request.interrupted = frame.result?.interrupted === true;
            if (request.method === 'thread/read' || request.method === 'thread/read/indexed') {
              const thread = frame.result?.thread ?? {};
              const messages = frame.result?.messages ?? thread.messages ?? [];
              request.threadId = thread.id ?? request.threadId;
              request.threadStatus = thread.status ?? frame.result?.threadStatus ?? frame.result?.status ?? null;
              request.segment = {
                rangeStart: frame.result?.rangeStart ?? null,
                rangeEnd: frame.result?.rangeEnd ?? null,
                hasMoreBefore: frame.result?.hasMoreBefore ?? null,
                beforeCursorKind: cursorKind(frame.result?.beforeCursor),
                transcriptSnapshotStatus: frame.result?.transcriptSnapshotV1?.status ?? null,
                transcriptSnapshotUnavailableCode: frame.result?.transcriptSnapshotV1?.code ?? null,
                transcriptObservationPresent: frame.result?.transcriptObservationV1 != null,
              };
              request.messages = Array.isArray(messages) ? messages.map(message => ({
                id: message?.id ?? null,
                role: message?.role ?? null,
                turnId: message?.turnId ?? null,
                attemptId: message?.attemptId ?? null,
                continuedByAttemptId: message?.continuedByAttemptId ?? null,
                status: message?.status ?? message?.runtimeStatus ?? null,
                markerHits: markersIn(message?.content ?? message?.blocks ?? message?.items ?? message),
              })) : [];
            }
            recordProtocolEvent('received', request.method, frame, request);
          }
        }
        if (['turn/completed', 'turn/failed', 'turn/interrupted'].includes(frame.method)) {
          const params = frame.params ?? {};
          const turn = params.turn ?? {};
          wire.terminals.push({
            method: frame.method,
            threadId: params.threadId ?? params.thread?.id ?? turn.threadId ?? null,
            turnId: params.turnId ?? turn.id ?? null,
            status: turn.status ?? params.status ?? (frame.method === 'turn/interrupted' ? 'interrupted' : frame.method === 'turn/failed' ? 'failed' : null),
          });
        }
        if (['thread/started', 'turn/started', 'turn/completed', 'turn/failed', 'turn/interrupted', 'item/started', 'item/delta', 'item/completed'].includes(frame.method)) {
          recordProtocolEvent('notification', frame.method, frame);
        }
      } catch {}
    });
  });

  try {
    await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
    const tokenInput = page.locator('input[name="token"]');
    await tokenInput.waitFor({ state: 'visible', timeout: 30_000 });
    await tokenInput.fill(gateway.authToken);
    await Promise.all([
      page.waitForURL(url => !url.pathname.startsWith('/login'), { timeout: 30_000 }),
      page.locator('button[type="submit"]').click(),
    ]);
    await page.getByTestId('desktop-sidebar').waitFor({ state: 'visible', timeout: 30_000 });
    const initialUrl = new URL(page.url());
    assert.equal(initialUrl.pathname, '/', 'the flow must start from the homepage');
    assert.equal([...initialUrl.searchParams.keys()].some(key => /project/i.test(key)), false, 'the homepage must have no selected project');
    const composer = page.getByTestId('chat-message-input');
    await composer.waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('project-work-button').first().waitFor({ state: 'visible', timeout: 15_000 });
    assert.equal(await page.getByTestId('standalone-storage-hint').count(), 0);
    assert.equal(await page.getByTestId('message-user').count(), 0, 'the initial homepage must not restore a prior conversation');
    assert.equal(await page.getByTestId('message-assistant').count(), 0, 'the initial homepage must not restore prior assistant content');
    assert.equal(wire.threadStarts.length, 0, 'opening the projectless homepage must not create a thread');

    const worker = page.getByTestId('studio-work-mode-switcher').first().getByRole('button', { name: 'KWorker', exact: true });
    await worker.waitFor({ state: 'visible', timeout: 30_000 });
    await worker.click();
    await wait(async () => await worker.getAttribute('aria-pressed') === 'true', 'explicit KWorker selection');
    await page.getByTestId('project-chat-composer').waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId('project-work-button').first().waitFor({ state: 'visible', timeout: 15_000 });
    assert.equal(await page.getByTestId('standalone-storage-hint').count(), 0);
    if (homeOnly) return { homeComposerVisible: true, modes: ['kcoder', 'kworker'], storageHintVisible: false };

    for (let index = 0; index < 2; index++) {
      await composer.fill(prompts[index]);
      await wait(() => page.getByTestId('send-message-button').isEnabled(), `composer enabled for turn ${index + 1}`);
      await page.getByTestId('send-message-button').click();
      await page.getByTestId('message-user').filter({ hasText: promptMarkers[index] }).waitFor({ state: 'visible', timeout: 30_000 });
      const replyArticles = page.getByTestId('message-assistant').filter({ hasText: replies[index] });
      await replyArticles.waitFor({ state: 'visible', timeout: 30_000 });
      await assertSingleAssistantArticle(replies[index], `completed turn ${index + 1}`);
      const start = await wait(() => {
        const request = wire.turnStarts[index];
        return request?.turnId ? request : null;
      }, `turn ${index + 1} accepted by the source CLI`);
      await wait(() => wire.terminals.find(event => event.threadId === start.threadId && event.turnId === start.turnId && event.status === 'completed'), `turn ${index + 1} terminal completion`);
    }

    await composer.fill(prompts[2]);
    await wait(() => page.getByTestId('send-message-button').isEnabled(), 'composer enabled for held turn');
    await page.getByTestId('send-message-button').click();
    await page.getByTestId('message-user').filter({ hasText: promptMarkers[2] }).waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('message-assistant').filter({ hasText: partialReply }).waitFor({ state: 'visible', timeout: 30_000 });
    await assertSingleAssistantArticle(partialReply, 'held third turn before cancellation');
    const thirdTurn = await wait(() => {
      const request = wire.turnStarts[2];
      return request?.turnId ? request : null;
    }, 'held third turn accepted by the source CLI');
    const cancelButton = page.getByTestId('pause-response-button');
    await cancelButton.waitFor({ state: 'visible', timeout: 15_000 });
    await cancelButton.click();
    await wait(() => wire.terminals.find(event => event.threadId === thirdTurn.threadId && event.turnId === thirdTurn.turnId && event.status === 'interrupted'), 'third turn authoritative interrupted receipt');
    await cancelButton.waitFor({ state: 'detached', timeout: 15_000 });
    const thirdProviderOutcome = await wait(() => model.requestOutcomes[2]?.aborted ? model.requestOutcomes[2] : null, 'third Provider stream abort after cancellation');

    await composer.fill(prompts[3]);
    await wait(() => page.getByTestId('send-message-button').isEnabled(), 'composer enabled for post-cancel turn');
    await page.getByTestId('send-message-button').click();
    await page.getByTestId('message-user').filter({ hasText: promptMarkers[3] }).waitFor({ state: 'visible', timeout: 30_000 });
    const fourthReplyArticles = page.getByTestId('message-assistant').filter({ hasText: replies[3] });
    await fourthReplyArticles.waitFor({ state: 'visible', timeout: 30_000 });
    const fourthTurn = await wait(() => {
      const request = wire.turnStarts[3];
      return request?.turnId ? request : null;
    }, 'fourth turn accepted by the source CLI');
    await wait(() => wire.terminals.find(event => event.threadId === fourthTurn.threadId && event.turnId === fourthTurn.turnId && event.status === 'completed'), 'fourth turn terminal completion');
    await wait(() => model.requestOutcomes[3]?.closed ? model.requestOutcomes[3] : null, 'fourth Provider response closed');
    const finalAssistantArticleCounts = [];
    for (const marker of [...replies.filter(Boolean), partialReply]) {
      finalAssistantArticleCounts.push(
        await assertSingleAssistantArticle(marker, 'completed history/live prefix reconciliation'),
      );
    }

    const createdThread = wire.threadStarts[0];
    assert.equal(wire.threadStarts.length, 1, 'all four turns must share one created conversation');
    assert.equal(createdThread.requestedStudioWorkMode, 'kworker', 'the new conversation must be created in KWorker mode');
    assert.equal(createdThread.studioWorkMode, 'kworker', 'the created thread receipt must persist KWorker mode');
    assert.ok(createdThread.threadId, 'thread/start must return the created thread identity');
    assert.equal(wire.turnStarts.length, 4, 'each prompt must start exactly one turn');
    assert.deepEqual(wire.turnStarts.map(turn => turn.promptMarker), promptMarkers, 'the four browser prompts must map to the four turn/start calls in order');
    assert.ok(wire.turnStarts.every(turn => turn.threadId === createdThread.threadId), 'all turn/start calls must reuse the first thread');
    assert.ok(wire.turnStarts.every(turn => turn.studioWorkMode === 'kworker'), 'every turn must carry KWorker presentation mode');
    assert.ok(wire.turnStarts.every(turn => turn.errorCode === null), 'no turn/start request may be rejected');
    assert.equal(wire.interrupts.length, 1, 'only the held third turn must be interrupted');
    assert.deepEqual({ threadId: wire.interrupts[0].threadId, turnId: wire.interrupts[0].turnId, interrupted: wire.interrupts[0].interrupted }, {
      threadId: createdThread.threadId, turnId: thirdTurn.turnId, interrupted: true,
    });
    assert.deepEqual(wire.turnStarts.map(turn => wire.terminals.find(event => event.threadId === turn.threadId && event.turnId === turn.turnId)?.status), [
      'completed', 'completed', 'interrupted', 'completed',
    ], 'the same conversation must complete, continue, stop the held turn, then complete the fourth turn');
    assert.deepEqual(providerPromptMarkers, promptMarkers, 'Provider requests must carry the same four unique prompts in order');
    assert.equal(new Set(providerPromptMarkers).size, 4, 'Provider must receive four unique prompts');
    assert.equal(model.requests.length, 4, 'the browser lifecycle must make exactly four Provider requests');
    assert.equal(thirdProviderOutcome.aborted, true);
    assert.equal(model.requestOutcomes[3]?.aborted, false, 'the completed fourth Provider response must not be aborted');
    assert.equal(fourthPromptObserved, true);
    assert.deepEqual(providerErrors, [], 'the scripted Provider must observe only the expected prompt sequence');
    assert.equal(await page.getByTestId('message-assistant').filter({ hasText: lateReply }).count(), 0, 'a cancelled Provider response must never append its gated late chunk');
    assert.deepEqual(browserErrors, [], 'the browser must not report page or console errors');

    const b22ThreadCount = wire.threadStarts.length;
    const b22TurnCount = wire.turnStarts.length;
    const b22ProviderRequestCount = model.requests.length;
    await page.screenshot({ path: context.pathInArtifacts('kworker-four-turn-lifecycle.png'), fullPage: true });
    await context.writeArtifactJson('kworker-four-turn-lifecycle.json', {
      cliSha256: binarySha256,
      homepageHadNoSelectedProject: true,
      explicitWorkMode: 'kworker',
      threadId: createdThread.threadId,
      turnIds: wire.turnStarts.map(turn => turn.turnId),
      turnStatuses: ['completed', 'completed', 'interrupted', 'completed'],
      providerPromptMarkers,
      providerRequestMetadata,
      assistantArticleCountsAfterHistoryLiveMerge: finalAssistantArticleCounts,
      providerRequestCount: model.requests.length,
      thirdProviderRequestAborted: thirdProviderOutcome.aborted,
      oneThreadAcrossFourTurns: true,
    });

    acceptancePhase = 'b01-existing-conversation-to-new-blank-page';
    const assertBlankNewChat = async label => {
      await page.getByTestId('desktop-empty-composer-frame').waitFor({ state: 'visible', timeout: 30_000 });
      await composer.waitFor({ state: 'visible', timeout: 30_000 });
      assert.equal(await composer.isEditable(), true, `${label}: the new composer must be editable`);
      const composerText = await composer.evaluate(element => {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value;
        return element.textContent ?? '';
      });
      assert.equal(composerText, '', `${label}: the new composer must be blank`);
      assert.equal(await page.locator('[data-testid="message-user"]:visible').count(), 0, `${label}: no old user messages may be visible`);
      assert.equal(await page.locator('[data-testid="message-assistant"]:visible').count(), 0, `${label}: no old assistant messages may be visible`);
    };
    const primaryNewChatButton = page.getByTestId('new-chat-button');
    await primaryNewChatButton.click();
    await assertBlankNewChat('new page from the original conversation');
    assert.equal(wire.threadStarts.length, b22ThreadCount, 'opening a blank page from the original conversation must not create another thread');
    assert.equal(wire.turnStarts.length, b22TurnCount, 'opening a blank page must not start a turn');
    assert.equal(model.requests.length, b22ProviderRequestCount, 'opening a blank page must not call the Provider');

    const chatSection = page.getByTestId('runtime-chat-section');
    const chatSectionToggle = chatSection.getByTestId('runtime-chat-section-toggle');
    if (await chatSectionToggle.getAttribute('aria-expanded') !== 'true') await chatSectionToggle.click();
    const originalThreadRow = chatSection
      .locator('[data-testid^="runtime-local-task-row-"]')
      .filter({ hasText: promptMarkers[0] });
    await originalThreadRow.waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(await originalThreadRow.count(), 1, 'the original conversation must remain in the sidebar after new chat');
    const originalThreadRowTestId = await originalThreadRow.getAttribute('data-testid');
    const threadReadsBeforeReopen = wire.threadReads.length;
    await originalThreadRow.click();
    await page.getByTestId('message-user').filter({ hasText: promptMarkers[3] }).waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('message-assistant').filter({ hasText: replies[3] }).waitFor({ state: 'visible', timeout: 30_000 });
    const reopenedHistoryRead = await wait(
      () => wire.threadReads.slice(threadReadsBeforeReopen).find(request =>
        request.threadId === createdThread.threadId &&
        request.errorCode === null &&
        request.messages.some(message => message.role === 'user' && message.markerHits.includes(promptMarkers[0])) &&
        request.messages.some(message => message.role === 'assistant' && message.markerHits.includes(replies[0])),
      ),
      'reopening the original thread reads its first user and assistant messages',
    );
    assert.equal(wire.threadStarts.length, b22ThreadCount, 'reopening the retained conversation must reuse it without creating a thread');
    assert.equal(wire.turnStarts.length, b22TurnCount, 'reopening history must not start a turn');
    assert.equal(model.requests.length, b22ProviderRequestCount, 'reopening history must not call the Provider');
    await primaryNewChatButton.click();
    await assertBlankNewChat('second blank page after reopening the original conversation');

    acceptancePhase = 'b02-owned-runtime-project-association';
    const projectName = 'B01B05 Owned Runtime Project';
    const projectWorkButton = page.getByTestId('project-work-button').first();
    await projectWorkButton.click();
    await page.getByTestId('add-local-project-option').click();
    await page.getByTestId('standalone-folder-project-dialog').waitFor({ state: 'visible', timeout: 30_000 });
    const folderPathInput = page.getByTestId('device-folder-path-input');
    await folderPathInput.waitFor({ state: 'visible', timeout: 30_000 });
    await folderPathInput.fill(workspace);
    await folderPathInput.press('Enter');
    const folderConfirm = page.getByTestId('confirm-device-folder-picker-button');
    await wait(() => folderConfirm.isEnabled(), 'owned workspace path selected in the UI');
    await folderConfirm.click();
    await page.getByTestId('local-project-create-dialog').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('local-project-create-name-input').fill(projectName);
    await page.getByTestId('confirm-local-project-create-button').click();
    await page.getByTestId('local-project-create-dialog').waitFor({ state: 'detached', timeout: 30_000 });
    await wait(
      async () => (await page.getByTestId('project-work-button').first().getAttribute('aria-label')) === projectName,
      'the owned runtime project becomes the selected project',
    );
    await assertBlankNewChat('blank page after creating an owned runtime project');
    assert.equal(await page.getByTestId('studio-work-mode-switcher').first().getByRole('button', { name: 'KWorker', exact: true }).getAttribute('aria-pressed'), 'true', 'KWorker mode should remain selected for the project conversation');

    await composer.fill(projectSetupPrompt);
    await wait(() => page.getByTestId('send-message-button').isEnabled(), 'project-scoped composer enabled');
    await page.getByTestId('send-message-button').click();
    await page.getByTestId('message-user').filter({ hasText: projectSetupMarker }).waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('message-assistant').filter({ hasText: projectSetupReply }).waitFor({ state: 'visible', timeout: 30_000 });
    const projectThread = await wait(() => wire.threadStarts[1]?.threadId ? wire.threadStarts[1] : null, 'project conversation accepted by the source CLI');
    const projectTurn = await wait(() => wire.turnStarts.find(turn => turn.promptMarker === projectSetupMarker && turn.turnId), 'project conversation turn accepted');
    await wait(() => wire.terminals.find(event => event.threadId === projectTurn.threadId && event.turnId === projectTurn.turnId && event.status === 'completed'), 'project conversation terminal completion');
    await wait(() => model.requestOutcomes[4]?.closed ? model.requestOutcomes[4] : null, 'project conversation Provider response closed');
    assert.equal(projectThread.requestedCwd ?? projectThread.receivedCwd, workspace, 'the project conversation must start in the selected owned workspace');
    assert.equal(projectThread.requestedStudioWorkMode, 'kworker', 'the project thread must keep the selected KWorker mode');

    acceptancePhase = 'b01-new-page-from-project-conversation';
    const beforeProjectNewChat = {
      threads: wire.threadStarts.length,
      turns: wire.turnStarts.length,
      providerRequests: model.requests.length,
    };
    await primaryNewChatButton.click();
    await assertBlankNewChat('new page from the project conversation');
    assert.equal(await projectWorkButton.getAttribute('aria-label'), projectName, 'the new page starts with its explicitly selected project context');
    assert.equal(wire.threadStarts.length, beforeProjectNewChat.threads, 'new chat from the project conversation must not create a thread');
    assert.equal(wire.turnStarts.length, beforeProjectNewChat.turns, 'new chat from the project conversation must not start a turn');
    assert.equal(model.requests.length, beforeProjectNewChat.providerRequests, 'new chat from the project conversation must not call the Provider');

    acceptancePhase = 'b02-explicit-no-project-selection';
    await projectWorkButton.click();
    await page.getByTestId('no-project-option').click();
    await wait(
      async () => (await page.getByTestId('project-work-button').first().getAttribute('aria-label')) === '请选择项目',
      'explicit no-project selection clears the prior project',
    );
    await page.getByTestId('project-chat-composer').waitFor({ state: 'visible', timeout: 15_000 });
    assert.equal(await page.getByTestId('standalone-storage-hint').count(), 0);
    assert.equal(new URL(page.url()).pathname, '/', 'the cleared page stays on the workbench home route');
    assert.equal([...new URL(page.url()).searchParams.keys()].some(key => /project/i.test(key)), false, 'the cleared page route has no project query');
    assert.equal(await page.getByTestId('message-user').count(), 0, 'the new page remains without the prior conversation messages');
    assert.equal(await page.getByTestId('message-assistant').count(), 0, 'the new page remains without the prior assistant history');

    acceptancePhase = 'b03-empty-input-send-gate';
    const beforeEmptySend = {
      threads: wire.threadStarts.length,
      turns: wire.turnStarts.length,
      providerRequests: model.requests.length,
    };
    assert.equal(await composer.getAttribute('placeholder'), '随心输入', 'an empty new conversation shows the normal new-chat placeholder');
    assert.equal(await page.getByTestId('send-message-button').isEnabled(), false, 'empty input must disable send');
    assert.equal(wire.threadStarts.length, beforeEmptySend.threads, 'empty input must not create a thread');
    assert.equal(wire.turnStarts.length, beforeEmptySend.turns, 'empty input must not start a turn');
    assert.equal(model.requests.length, beforeEmptySend.providerRequests, 'empty input must not call the Provider');

    acceptancePhase = 'b04-work-mode-title-placeholder-and-examples';
    const modeSwitcher = page.getByTestId('studio-work-mode-switcher').first();
    const coderButton = modeSwitcher.getByRole('button', { name: 'KCoder', exact: true });
    const workerButton = modeSwitcher.getByRole('button', { name: 'KWorker', exact: true });
    const emptyTitle = page.getByTestId('desktop-empty-hero-column').getByRole('heading');
    await coderButton.click();
    await wait(async () => await coderButton.getAttribute('aria-pressed') === 'true', 'KCoder selection');
    await wait(async () => (await emptyTitle.innerText()).trim() === '我们该做什么？', 'KCoder blank-page title');
    await page.getByTestId('task-suggestion-category-explore').waitFor({ state: 'visible', timeout: 15_000 });
    assert.equal(await page.getByTestId('task-suggestion-category-documents').count(), 0, 'KCoder mode must not display KWorker examples');
    assert.equal(await composer.getAttribute('placeholder'), '随心输入', 'KCoder blank-page placeholder');
    await workerButton.click();
    await wait(async () => await workerButton.getAttribute('aria-pressed') === 'true', 'KWorker selection on the new page');
    await wait(async () => (await emptyTitle.innerText()).trim() === '今天有什么工作需要帮忙？', 'KWorker blank-page title');
    await page.getByTestId('task-suggestion-category-documents').waitFor({ state: 'visible', timeout: 15_000 });
    assert.equal(await page.getByTestId('task-suggestion-category-explore').count(), 0, 'KWorker mode must not display KCoder examples');
    assert.equal(await composer.getAttribute('placeholder'), '随心输入', 'KWorker blank-page placeholder');
    assert.equal(wire.threadStarts.length, beforeEmptySend.threads, 'changing work mode on an empty page must not create a thread');
    assert.equal(wire.turnStarts.length, beforeEmptySend.turns, 'changing work mode on an empty page must not start a turn');
    assert.equal(model.requests.length, beforeEmptySend.providerRequests, 'changing work mode on an empty page must not call the Provider');

    acceptancePhase = 'b05-editable-minimal-message-and-single-send';
    const beforeMinimalSend = {
      threads: wire.threadStarts.length,
      turns: wire.turnStarts.length,
      providerRequests: model.requests.length,
    };
    assert.equal(await composer.isEditable(), true, 'the new-page input must be editable');
    await composer.fill(newChatPrompt);
    const editableDraft = await composer.evaluate(element => element.value ?? element.textContent ?? '');
    assert.equal(editableDraft, newChatPrompt, 'the minimal message remains editable before sending');
    await wait(() => page.getByTestId('send-message-button').isEnabled(), 'minimal message enables send');
    assert.equal(wire.threadStarts.length, beforeMinimalSend.threads, 'editing text alone must not create a thread');
    assert.equal(wire.turnStarts.length, beforeMinimalSend.turns, 'editing text alone must not start a turn');
    assert.equal(model.requests.length, beforeMinimalSend.providerRequests, 'editing text alone must not call the Provider');
    await page.getByTestId('send-message-button').click();
    await page.getByTestId('message-user').filter({ hasText: newChatMarker }).waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('message-assistant').filter({ hasText: newChatReply }).waitFor({ state: 'visible', timeout: 30_000 });
    const newChatThread = await wait(() => wire.threadStarts[2]?.threadId ? wire.threadStarts[2] : null, 'new projectless conversation accepted by the source CLI');
    const newChatTurn = await wait(() => wire.turnStarts.find(turn => turn.promptMarker === newChatMarker && turn.turnId), 'minimal new-chat turn accepted');
    await wait(() => wire.terminals.find(event => event.threadId === newChatTurn.threadId && event.turnId === newChatTurn.turnId && event.status === 'completed'), 'minimal new-chat terminal completion');
    await wait(() => model.requestOutcomes[5]?.closed ? model.requestOutcomes[5] : null, 'minimal new-chat Provider response closed');
    await assertSingleAssistantArticle(newChatReply, 'minimal new-chat response');
    assert.notEqual(newChatThread.requestedCwd ?? newChatThread.receivedCwd, workspace, 'after explicit no-project selection the new thread must not reuse the project workspace');
    assert.equal(newChatThread.requestedStudioWorkMode, 'kworker', 'the minimal new-chat thread must carry the selected KWorker mode');
    assert.equal(wire.threadStarts.length, beforeMinimalSend.threads + 1, 'the minimal accepted message must create exactly one thread');
    assert.equal(wire.turnStarts.length, beforeMinimalSend.turns + 1, 'the minimal accepted message must start exactly one turn');
    assert.equal(model.requests.length, beforeMinimalSend.providerRequests + 1, 'the minimal accepted message must call the Provider exactly once');
    assert.equal(wire.threadStarts.length, 3, 'the B22 thread, project thread, and accepted new chat are the only three threads');
    assert.equal(wire.turnStarts.length, 6, 'the four B22 turns plus project and minimal new-chat turns are the only six turns');
    assert.deepEqual(providerPromptMarkers, expectedProviderPromptMarkers, 'all Provider requests map to the four B22 turns and two explicit acceptance messages');
    assert.deepEqual(providerErrors, [], 'the scripted Provider must observe only the expected prompt sequence');
    assert.deepEqual(browserErrors, [], 'the browser must not report page or console errors during B01-B05');

    const b01b05Evidence = {
      projectName,
      projectWorkspacePath: workspace,
      originalThreadRowTestId,
      originalThreadId: createdThread.threadId,
      originalThreadReopenedHistoryRead: reopenedHistoryRead,
      projectThreadId: projectThread.threadId,
      projectThreadCwd: projectThread.requestedCwd ?? projectThread.receivedCwd,
      projectlessNewThreadId: newChatThread.threadId,
      projectlessNewThreadCwd: newChatThread.requestedCwd ?? newChatThread.receivedCwd,
      projectAssociationCreatedThroughUi: true,
      explicitNoProjectSelection: true,
      oldConversationRecoveredWithOriginalMessages: true,
      emptySendDisabledWithoutThreadTurnOrProviderRequest: true,
      workModes: {
        kcoder: { title: '我们该做什么？', exampleCategory: 'explore', placeholder: '随心输入' },
        kworker: { title: '今天有什么工作需要帮忙？', exampleCategory: 'documents', placeholder: '随心输入' },
      },
      minimalMessageEditable: true,
      minimalMessageCreatedExactlyOneThreadTurnAndProviderRequest: true,
      threadStarts: wire.threadStarts,
      turnStarts: wire.turnStarts,
      providerPromptMarkers,
      providerRequestCount: model.requests.length,
    };
    await page.screenshot({ path: context.pathInArtifacts('new-chat-entry-b01-b05.png'), fullPage: true });
    await context.writeArtifactJson('new-chat-entry-b01-b05.json', b01b05Evidence);

    return {
      workMode: 'kworker',
      oneThreadAcrossFourTurns: true,
      turnStatuses: ['completed', 'completed', 'interrupted', 'completed'],
      assistantArticleCountsAfterHistoryLiveMerge: finalAssistantArticleCounts,
      providerRequestCount: model.requests.length,
      b01b05: {
        projectAssociationCreatedThroughUi: true,
        explicitNoProjectSelection: true,
        oldConversationRecoveredWithOriginalMessages: true,
        emptySendDisabledWithoutRequest: true,
        workModeTitlesExamplesPlaceholders: true,
        editableMinimalMessageSentExactlyOnce: true,
      },
    };
  } catch (error) {
    await context.writeArtifactJson('kworker-four-turn-lifecycle-failure.json', {
      acceptancePhase,
      error: context.redactText(error.message),
      wire,
      providerPromptMarkers,
      providerRequestMetadata,
      providerRequestCount: model.requests.length,
      providerErrors,
      browserErrors,
      currentUrl: new URL(page.url()).pathname,
    });
    if (acceptancePhase !== 'b22-four-turn-lifecycle') {
      await context.writeArtifactJson('new-chat-entry-b01-b05-failure.json', {
        acceptancePhase,
        error: context.redactText(error.message),
        wire,
        providerPromptMarkers,
        providerRequestMetadata,
        providerRequestCount: model.requests.length,
        providerErrors,
        browserErrors,
        currentUrl: new URL(page.url()).pathname,
      });
    }
    await page.screenshot({ path: context.pathInArtifacts('kworker-four-turn-lifecycle-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await page.close();
  }
});

function textContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textContent).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  if (value.content !== undefined) return textContent(value.content);
  return '';
}

function markersIn(value) {
  return syntheticMarkers.filter(marker => containsText(value, marker));
}

function cursorKind(value) {
  if (value == null) return 'none';
  if (typeof value !== 'string') return 'non-string';
  return value.startsWith('tp1:') ? 'indexed-tp1' : 'opaque-other';
}

function containsText(value, marker) {
  if (typeof value === 'string') return value.includes(marker);
  if (Array.isArray(value)) return value.some(item => containsText(item, marker));
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(item => containsText(item, marker));
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
