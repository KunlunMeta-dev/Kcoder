import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { applicationFixture } from '../../harness/application-service.mjs';
import { sha256File, startNativeCodeGateway } from '../../harness/native-code-service.mjs';
import { waitForStdioChildClose } from '../../harness/app-server-stdio.mjs';
import { originalSystemdCarrier, originalUserUnit, registerOriginalCarrierCleanup } from '../../harness/native-systemd-carrier.mjs';
import { collectTaskUiDiagnostics } from '../../harness/native-task-ui-diagnostics.mjs';
import { requireExecutable, runE2E } from '../../harness/run-context.mjs';

process.umask(0o077);

const execFileAsync = promisify(execFile);
const DIAGNOSTIC_RPC_TIMEOUT_MS = 30_000;
const PRODUCT_RPC_BUDGET_MS = 5_000;
const PRODUCT_CARD_READY_BUDGET_MS = 10_000;
const EXPECTED_QUESTION_TEXT = [
  'Which export format should the report use?',
  'Who should receive the report?',
  'How long should the report be retained?',
];
const QUESTION_INPUT = {
  questions: [
    { question: EXPECTED_QUESTION_TEXT[0], header: 'Export', options: [
      { label: 'CSV', description: 'Keeps the export easy to inspect.' },
      { label: 'JSON', description: 'Preserves nested fields.' },
    ], multi_select: false },
    { question: EXPECTED_QUESTION_TEXT[1], header: 'Audience', options: [
      { label: 'Team', description: 'Shares the report with the project team.' },
      { label: 'Private', description: 'Keeps the report in this workspace.' },
    ], multi_select: false },
    { question: EXPECTED_QUESTION_TEXT[2], header: 'Retention', options: [
      { label: '30 days', description: 'Removes the report after one month.' },
      { label: 'Keep', description: 'Retains the report until manually removed.' },
    ], multi_select: false },
  ],
};
const PINNED_GATEWAY_PATHS = [
  'apps/kcoder-studio/dev-server.mjs',
  'apps/kcoder-studio/package.json',
  'apps/kcoder-studio/pnpm-lock.yaml',
  'apps/kcoder-studio/src/broker-async-questions.js',
  'apps/kcoder-studio/src/broker-shared-threads.js',
];

await runE2E(import.meta.url, {
  testId: 'async-question-load-native-protocol',
  tier: 'full-integration',
  modelPolicy: 'Model-independent local provider fixture registers one real pending async question with three items; no external model or account.',
  processSignalTimeoutMs: 45_000,
}, async context => {
  const evidence = {
    budgetsMs: { diagnosticRpcTimeout: DIAGNOSTIC_RPC_TIMEOUT_MS, individualProductRpc: PRODUCT_RPC_BUDGET_MS,
      sequentialCardReady: PRODUCT_CARD_READY_BUDGET_MS },
    phase: 'candidate-identity',
    samples: [],
    thresholdViolations: [],
    questionStableAcrossReads: false,
  };
  let failure;
  let fixture;
  let app;
  let model;
  let processRoots = [];
  const recordFailure = error => {
    failure = { phase: evidence.phase, name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 2000) };
  };

  try {
    assert.equal(process.platform, 'linux', 'The normal Native candidate fixture currently requires Linux.');
    const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'normal Native candidate');
    const expectedBinarySha256 = process.env.KCODER_E2E_KCODER_BIN_SHA256;
    assert.match(expectedBinarySha256 ?? '', /^[a-f0-9]{64}$/, 'Set the expected candidate SHA-256 explicitly.');
    const binarySha256 = await sha256File(binary);
    assert.equal(binarySha256, expectedBinarySha256, 'The selected Native candidate must match its pinned digest.');

    const sourceManifestPath = process.env.KCODER_E2E_NATIVE_SOURCE_MANIFEST;
    const normalManifestPath = process.env.KCODER_E2E_NATIVE_NORMAL_MANIFEST;
    assert.ok(sourceManifestPath && normalManifestPath, 'Set both candidate provenance manifests.');
    const sourceManifest = JSON.parse(await readFile(resolve(sourceManifestPath), 'utf8'));
    const normalManifest = JSON.parse(await readFile(resolve(normalManifestPath), 'utf8'));
    assert.equal(normalManifest.sha256, binarySha256);
    assert.equal(resolve(normalManifest.path), resolve(binary));
    assert.equal(sourceManifest.sourceTree, normalManifest.sourceTree);
    assert.match(sourceManifest.sourceTree, /^[a-f0-9]{40}$/);
    const sourceRoot = resolve(sourceManifest.sourceRoot);
    const sourceRootInfo = await lstat(sourceRoot);
    assert.ok(sourceRootInfo.isDirectory() && !sourceRootInfo.isSymbolicLink(), 'Candidate sourceRoot must be a real directory.');
    evidence.candidate = { binarySha256, sourceTree: sourceManifest.sourceTree, sourceRoot,
      normalManifest: resolve(normalManifestPath), sourceManifest: resolve(sourceManifestPath) };

    evidence.phase = 'native-fixture-and-source-staging';
    const fixtureStart = performance.now();
    const candidateGatewaySource = await materializeCandidateGatewaySource(context, sourceRoot, sourceManifest.sourceTree);
    evidence.candidateGatewaySource = candidateGatewaySource.evidence;
    const previousSourceRoot = process.env.KCODER_E2E_NATIVE_CHANNEL_SOURCE_ROOT;
    process.env.KCODER_E2E_NATIVE_CHANNEL_SOURCE_ROOT = candidateGatewaySource.root;
    try {
      fixture = await applicationFixture(context, binary);
    } finally {
      if (previousSourceRoot === undefined) delete process.env.KCODER_E2E_NATIVE_CHANNEL_SOURCE_ROOT;
      else process.env.KCODER_E2E_NATIVE_CHANNEL_SOURCE_ROOT = previousSourceRoot;
    }
    evidence.fixtureSetupMs = Math.round(performance.now() - fixtureStart);
    const runtimeDirectory = `/run/user/${fixture.uid}`;
    const runtimeInfo = await lstat(runtimeDirectory);
    assert.ok(runtimeInfo.isDirectory() && !runtimeInfo.isSymbolicLink() && runtimeInfo.uid === fixture.uid,
      'Use only this fixture UID’s actual systemd user runtime.');
    const busSocket = await lstat(resolve(runtimeDirectory, 'bus'));
    assert.ok(busSocket.isSocket() && busSocket.uid === fixture.uid, 'Use only this fixture UID’s real user bus socket.');
    fixture.env.XDG_RUNTIME_DIR = runtimeDirectory;
    fixture.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtimeDirectory}/bus`;
    const managerReply = await execFileAsync('/usr/bin/systemctl', ['--user', 'show', '--property=Version'],
      { env: fixture.env, encoding: 'utf8', timeout: 5_000, maxBuffer: 4_096 });
    const managerVersion = managerReply.stdout.match(/^Version=(.+)$/m)?.[1];
    assert.match(managerVersion ?? '', /^\d[\w.+-]*$/, 'The current UID user manager must answer a bounded read-only probe.');
    evidence.userBus = { runtimeDirectory, socketUid: busSocket.uid, managerVersion };

    registerOriginalCarrierCleanup(context, fixture, `async-question-load-${context.seed}`);

    const stagedPins = JSON.parse(await readFile(context.pathInArtifacts('scoped-gateway-source-pins.json'), 'utf8'));
    const treeResult = await execFileAsync('git', ['-C', sourceRoot, 'ls-tree', '-rz', '-r', sourceManifest.sourceTree,
      '--', 'apps/kcoder-studio'], { encoding: null, maxBuffer: 64 * 1024 * 1024 });
    const treeBlobs = new Map(treeResult.stdout.toString('utf8').split('\0').filter(Boolean).map(record => {
      const separator = record.indexOf('\t');
      const [mode, type, oid] = record.slice(0, separator).split(' ');
      return [record.slice(separator + 1), { mode, type, oid }];
    }).filter(([, value]) => value.type === 'blob'));
    const verifiedGatewayPins = [];
    const verifiedManifestPins = [];
    const untrackedGatewayPins = [];
    for (const pin of stagedPins) {
      assert.match(pin.path, /^apps\/kcoder-studio\//);
      const stagedRelative = pin.path.slice('apps/kcoder-studio/'.length);
      const stagedPath = resolve(fixture.gatewayRoot, stagedRelative);
      const bytes = await readFile(stagedPath);
      const stagedSha256 = createHash('sha256').update(bytes).digest('hex');
      assert.equal(stagedSha256, pin.sha256, `The staged Gateway copy changed after pinning: ${pin.path}`);
      const expectedBlob = treeBlobs.get(pin.path);
      if (!expectedBlob) {
        const expectedSourceSha256 = sourceManifest.pins?.[pin.path];
        if (expectedSourceSha256) {
          assert.equal(stagedSha256, expectedSourceSha256,
            `The Gateway file outside sourceTree must match its explicit source manifest pin: ${pin.path}`);
          verifiedManifestPins.push({ path: pin.path, sha256: stagedSha256 });
          continue;
        }
        assert.ok(pin.path.startsWith('apps/kcoder-studio/renderer/dist/'),
          `Untracked Gateway source must be pinned or rejected: ${pin.path}`);
        untrackedGatewayPins.push({ path: pin.path, sha256: stagedSha256,
          source: 'generated renderer/dist copied from manifest sourceRoot; outside sourceTree and excluded from RPC-source proof' });
        continue;
      }
      const actualBlob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      assert.equal(actualBlob, expectedBlob.oid, `Gateway snapshot differs from the candidate sourceTree: ${pin.path}`);
      verifiedGatewayPins.push({ path: pin.path, sha256: stagedSha256, gitBlob: actualBlob });
    }
    for (const requiredPath of PINNED_GATEWAY_PATHS) {
      assert.ok(verifiedGatewayPins.some(pin => pin.path === requiredPath),
        `The staged Gateway must be authenticated against sourceTree for ${requiredPath}`);
    }
    evidence.gatewaySnapshot = { stagedRoot: fixture.gatewayRoot, gitTree: sourceManifest.sourceTree,
      verifiedTrackedFiles: verifiedGatewayPins.length, verifiedManifestPinnedFiles: verifiedManifestPins,
      verifiedRequiredFiles: PINNED_GATEWAY_PATHS,
      generatedOrUntrackedFiles: untrackedGatewayPins };

    evidence.phase = 'local-question-provider-configuration';
    model = await startApprovalModelFixture(context, {
      responseSteps: ({ body }) => {
        const hasToolResult = (body.messages ?? []).some(message => message?.role === 'tool');
        if (!hasToolResult) return [
          { delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'async-question-load-fixture-call', type: 'function',
            function: { name: 'AskUserQuestionAsync', arguments: JSON.stringify(QUESTION_INPUT) } }] } },
          { finishReason: 'tool_calls' },
        ];
        return [
          { delta: { role: 'assistant', content: 'The fixture registered the questions and continued.' } },
          { finishReason: 'stop' },
        ];
      },
    });

    const settings = JSON.parse(await readFile(fixture.settings, 'utf8'));
    settings.permission_mode = 'ask';
    settings.allowed_tools = ['AskUserQuestionAsync'];
    evidence.toolAuthorization = { permissionMode: 'ask', allowedTools: ['AskUserQuestionAsync'],
      boundary: 'Only the synthetic question-registration tool is explicitly allowed; other tools remain under ask.' };
    settings.tools = { ...settings.tools, profile: 'full' };
    settings.max_retries = 0;
    settings.providers['owned-code'].endpoint = model.baseUrl;
    settings.providers['owned-code'].default_model = 'async-question-load-fixture';
    settings.providers['owned-code'].max_output_tokens = 256;
    settings.providers['owned-code'].output_headroom_tokens = 1024;
    await writeFile(fixture.settings, JSON.stringify(settings), { mode: 0o600 });

    evidence.phase = 'gateway-initialize';
    const gatewayStartedAt = performance.now();
    const rendererCapabilitySource = await candidateRendererCapabilities(
      sourceRoot, sourceManifest.sourceTree, fixture.gatewayRoot);
    const requestedCapabilities = {
      ...rendererCapabilitySource.experimental,
      asyncUserQuestionsV1: true,
      connectivityV1: true,
      connectivityCredentialInputV1: true,
      nativeChannelServicesV1: true,
      integrationOperationReceiptsV1: true,
      taskSourcesV1: true,
      threadRuntimeHandoffV1: true,
      interactionBindingV1: true,
      turnSubmissionV1: true,
      threadCreationReceiptsV1: true,
    };
    const offeredCapabilityNames = Object.keys(requestedCapabilities).sort();
    evidence.rendererCapabilitySource = rendererCapabilitySource.evidence;
    evidence.fixtureOnlyCapabilities = ['threadCreationReceiptsV1'];
    evidence.requestedCapabilities = offeredCapabilityNames;
    app = await startNativeCodeGateway(context, fixture, 'async-question-load-native', {
      experimental: requestedCapabilities,
    });
    evidence.gatewayStartupAndInitializeMs = Math.round(performance.now() - gatewayStartedAt);
    const acceptedCapabilityNames = offeredCapabilityNames.filter(name =>
      app.initialized.capabilities?.experimental?.[name] === true);
    evidence.gatewayOwnState = {
      processId: app.gateway.child.pid,
      initialized: Boolean(app.initialized),
      protocolVersion: app.initialized.protocolVersion,
      scopeReadCompleted: Boolean(app.scope),
      threadResume: app.initialized.capabilities?.threadResume === true,
      offeredExperimentalCapabilityNames: offeredCapabilityNames,
      acceptedExperimentalCapabilityNames: acceptedCapabilityNames,
      unacceptedExperimentalCapabilityNames: offeredCapabilityNames.filter(name =>
        !acceptedCapabilityNames.includes(name)),
    };
    evidence.negotiatedCapabilities = {
      threadResume: app.initialized.capabilities?.threadResume === true,
      acceptedExperimentalCapabilityNames: acceptedCapabilityNames,
    };
    for (const name of ['asyncUserQuestionsV1', 'taskSourcesV1', 'threadRuntimeHandoffV1', 'interactionBindingV1']) {
      assert.equal(app.initialized.capabilities?.experimental?.[name], true,
        `The measured client must negotiate ${name}.`);
    }

    evidence.phase = 'question-task-registration';
    const request = async (method, params) => {
      const identifiers = Object.fromEntries(['clientMessageId', 'clientRequestId', 'threadId', 'turnId']
        .filter(key => typeof params?.[key] === 'string').map(key => [key, params[key]]));
      const trace = { method, identifiers, status: 'pending' };
      const startedAt = performance.now();
      evidence.lastRequestMethod = method;
      evidence.lastRequest = trace;
      try {
        const result = await app.client.request(method, params, DIAGNOSTIC_RPC_TIMEOUT_MS);
        trace.status = 'resolved';
        return result;
      } catch (error) {
        trace.status = 'failed';
        trace.error = { name: error?.name ?? 'Error', code: error?.code ?? null,
          message: String(error?.message ?? error).slice(0, 500) };
        throw error;
      } finally {
        trace.elapsedMs = Math.round(performance.now() - startedAt);
        evidence.rpcTrace ??= [];
        evidence.rpcTrace.push({ ...trace });
      }
    };
    const startedThreads = [];
    for (let index = 0; index < 3; index += 1) {
      const result = await request('thread/start', { clientRequestId: `async-question-load-${context.seed}-${index}` });
      assert.ok(result.thread?.id, `thread/start ${index} must return an owned task`);
      startedThreads.push(result.thread.id);
      evidence.taskIds = [...startedThreads];
    }
    const targetThreadId = startedThreads[0];
    evidence.targetThreadId = targetThreadId;
    const turn = await request('turn/start', {
      clientMessageId: `async-question-load-message-${context.seed}`,
      threadId: targetThreadId,
      input: [{ type: 'text', text: 'Prepare the report and ask the three fixed questions.' }],
      asyncUserQuestions: true,
    });
    assert.ok(turn.turn?.id, 'turn/start must return the registered task turn');
    evidence.turnId = turn.turn.id;
    const completion = await app.client.waitFor(message => message.method === 'turn/completed'
      && message.params?.threadId === targetThreadId
      && (message.params?.turnId === turn.turn.id || message.params?.turn?.id === turn.turn.id),
    DIAGNOSTIC_RPC_TIMEOUT_MS, 'the deterministic question registration turn to complete');
    assert.ok(['completed', 'complete'].includes(completion.params?.turn?.status ?? completion.params?.status),
      `The model-independent registration turn must complete: ${JSON.stringify(completion.params)}`);
    assert.equal(model.requests.length, 2, 'The fixture should produce one tool call followed by one continuation.');
    assert.ok(model.requests[0].tools?.some(tool => tool.function?.name === 'AskUserQuestionAsync'),
      'The provider request must include the async question tool.');
    assert.ok(model.requests[1].messages?.some(message => message.role === 'tool'),
      'The continuation must receive the ordinary tool result.');
    evidence.providerRequests = model.requests.length;
    evidence.providerBoundary = 'Fixed local protocol fixture; no claim about real-model behavior.';

    evidence.phase = 'native-process-identification-after-question-registration';
    processRoots = [app.gateway.child.pid];
    const gatewayProcessTree = await sampleProcessIo(processRoots, fixture.uid);
    assert.ok(gatewayProcessTree.some(process => process.pid === app.gateway.child.pid),
      'The owned Gateway process must be present in the same-UID /proc sample.');
    const gatewayProcessDetails = await Promise.all(gatewayProcessTree.map(async process => ({
      ...process, executable: await procExe(process.pid).catch(() => null),
    })));
    const candidateNativeProcesses = gatewayProcessDetails.filter(process => process.executable
      && resolve(process.executable) === resolve(fixture.binary));
    assert.ok(candidateNativeProcesses.length > 0,
      'The real candidate Native app-server process must be observed under the owned Gateway before timing reads.');
    const carrierDirectories = (await readdir(fixture.profile))
      .filter(name => /^native-channel-carrier-[a-f0-9]{64}$/.test(name));
    if (carrierDirectories.length > 0) {
      const carrier = await originalSystemdCarrier(fixture);
      const unit = await originalUserUnit(context, fixture, carrier, 'show', `async-question-load-owner-${context.seed}`);
      const managerPid = Number(unit.MainPID);
      if (Number.isSafeInteger(managerPid) && managerPid > 0) processRoots.push(managerPid);
      evidence.nativeCarrier = { unit: carrier.unit, activeState: unit.ActiveState,
        managerPid: Number.isSafeInteger(managerPid) && managerPid > 0 ? managerPid : null,
        managerStartTicks: Number.isSafeInteger(managerPid) && managerPid > 0 ? await procStartTicks(managerPid) : null,
        executable: Number.isSafeInteger(managerPid) && managerPid > 0 ? await procExe(managerPid) : null,
        processShape: 'A profile-owned user-systemd carrier existed after the owned question turn; systemd and Gateway roots are sampled independently.',
        candidateNativeProcessPids: candidateNativeProcesses.map(process => process.pid) };
    } else {
      evidence.nativeCarrier = { unit: null, activeState: 'not-created', managerPid: null,
        processShape: 'No separate profile-owned Native systemd carrier exists after question registration. This run uses the ordinary Gateway-spawned local app-server path, not a separately hosted Core/Main peer path.',
        gatewayPid: app.gateway.child.pid, gatewayStartTicks: (gatewayProcessTree.find(process => process.pid === app.gateway.child.pid)).startTicks,
        candidateNativeProcesses: candidateNativeProcesses.map(({ pid, startTicks, comm, executable }) => ({ pid, startTicks, comm, executable })) };
    }

    evidence.phase = 'question-record-direct-read-before-resume';
    const measureRpc = async (name, method, params) => {
      const beforeIo = await sampleProcessIo(processRoots, fixture.uid);
      const startedAt = performance.now();
      try {
        const result = await request(method, params);
        const elapsedMs = Math.round(performance.now() - startedAt);
        const afterIo = await sampleProcessIo(processRoots, fixture.uid);
        const sample = { name, method, elapsedMs, io: ioDelta(beforeIo, afterIo) };
        evidence.samples.push(sample);
        return { result, sample };
      } catch (error) {
        const elapsedMs = Math.round(performance.now() - startedAt);
        const afterIo = await sampleProcessIo(processRoots, fixture.uid);
        evidence.samples.push({ name, method, elapsedMs, io: ioDelta(beforeIo, afterIo),
          error: String(error?.message ?? error).slice(0, 1000) });
        throw error;
      }
    };

    const validatePendingQuestion = (questions, label) => {
      assert.equal(questions.length, 1, `${label} must return exactly the fixture pending question.`);
      const question = questions[0];
      assert.equal(question.threadId, targetThreadId);
      assert.equal(question.status, 'pending');
      assert.equal(question.questions?.length, 3, `${label} must return all three question items.`);
      assert.deepEqual(question.questions.map(item => item.question), EXPECTED_QUESTION_TEXT);
      assert.ok(question.questionId && question.sourceTurnId === turn.turn.id);
      return question;
    };

    const registeredList = await measureRpc('registration-question-list-before-resume', 'asyncQuestion/list', {
      threadId: targetThreadId, includeTerminal: true,
    });
    const registeredQuestion = validatePendingQuestion(registeredList.result.questions ?? 'invalid',
      'Direct asyncQuestion/list before any thread/resume');
    const acceptedToolReceipt = (model.requests[1].messages ?? []).some(message => {
      if (message?.role !== 'tool' || typeof message.content !== 'string') return false;
      try { return JSON.parse(message.content)?.accepted === true; } catch { return false; }
    });
    assert.equal(acceptedToolReceipt, true,
      'The fixed provider continuation must receive the durable accepted=true registration receipt.');
    evidence.questionToolReceipt = { accepted: true, boundary: 'Registration receipt only; no answer or authorization.' };
    evidence.question = { questionId: registeredQuestion.questionId, status: registeredQuestion.status,
      sourceTurnId: registeredQuestion.sourceTurnId, itemCount: registeredQuestion.questions.length,
      itemTexts: registeredQuestion.questions.map(item => item.question) };
    evidence.registeredQuestionBeforeResume = true;

    const readCardSequence = async label => {
      const sequenceStartedAt = performance.now();
      const sequence = { label, status: 'pending', steps: [] };
      evidence.cardSequences ??= [];
      evidence.cardSequences.push(sequence);
      try {
        sequence.currentStep = 'thread/list';
        const threadList = await measureRpc(`${label}-thread-list`, 'thread/list', {});
        sequence.steps.push(threadList.sample.name);
        const members = (threadList.result.threads ?? []).map(thread => thread.id).sort();
        assert.deepEqual(members, [...startedThreads].sort(), `${label} must discover exactly the three fixture tasks.`);
        sequence.currentStep = 'thread/resume';
        const resumed = await measureRpc(`${label}-thread-resume`, 'thread/resume', { threadId: targetThreadId });
        sequence.steps.push(resumed.sample.name);
        assert.equal(resumed.result.thread?.id, targetThreadId);
        sequence.currentStep = 'asyncQuestion/list';
        const listed = await measureRpc(`${label}-async-question-list`, 'asyncQuestion/list', {
          threadId: targetThreadId, includeTerminal: true,
        });
        sequence.steps.push(listed.sample.name);
        sequence.elapsedMs = Math.round(performance.now() - sequenceStartedAt);
        sequence.status = 'resolved';
        delete sequence.currentStep;
        return { questions: listed.result.questions ?? [], sequence };
      } catch (error) {
        sequence.elapsedMs = Math.round(performance.now() - sequenceStartedAt);
        sequence.status = 'failed';
        sequence.failedStep = sequence.currentStep;
        sequence.error = { name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 500) };
        delete sequence.currentStep;
        throw error;
      }
    };

    const readTranscriptProjection = async label => {
      try {
        const { result } = await measureRpc(label, 'thread/read', { threadId: targetThreadId, limit: 50 });
        const messages = (result.messages ?? []).map(message => ({
          id: message.id, clientMessageId: message.clientMessageId ?? null, turnId: message.turnId ?? null,
          role: message.role, status: message.status ?? null,
          contentSha256: createHash('sha256').update(String(message.content ?? '')).digest('hex'),
        }));
        const projection = { threadId: result.thread?.id ?? null, messageCount: messages.length,
          messageIds: messages.map(message => message.id), turnIds: [...new Set(messages.map(message => message.turnId).filter(Boolean))],
          transcriptSha256: createHash('sha256').update(JSON.stringify(messages)).digest('hex') };
        evidence.transcriptProjections ??= {};
        evidence.transcriptProjections[label] = projection;
        return projection;
      } catch (error) {
        evidence.transcriptProjections ??= {};
        evidence.transcriptProjections[label] = { available: false,
          error: String(error?.message ?? error).slice(0, 500) };
        return null;
      }
    };

    evidence.phase = 'same-client-card-read';
    let sameClientFirst;
    let sameClientError;
    try {
      sameClientFirst = await readCardSequence('same-client-first-read-warm-native');
      const firstQuestion = validatePendingQuestion(sameClientFirst.questions, 'Same-client sequence');
      assert.equal(firstQuestion.questionId, registeredQuestion.questionId);
      assert.deepEqual(sameClientFirst.questions, registeredList.result.questions);
      evidence.sameClientCardRead = { status: 'resolved', elapsedMs: sameClientFirst.sequence.elapsedMs };
      for (let index = 0; index < 3; index += 1) {
        const warm = await readCardSequence(`same-client-warm-${index + 1}`);
        assert.deepEqual(warm.questions, sameClientFirst.questions,
          'Repeated task resume/list must preserve the same pending-question identity and data.');
      }
      evidence.questionStableAcrossSameClientReads = true;
    } catch (error) {
      sameClientError = error;
      evidence.sameClientCardRead = { status: 'failed',
        method: evidence.lastRequestMethod ?? null,
        message: String(error?.message ?? error).slice(0, 500) };
    }
    const creatorTranscript = await readTranscriptProjection('creator-thread-read-after-same-client-sequence');

    const creatorGatewayPid = app.gateway.child.pid;
    const ownerManagerPid = evidence.nativeCarrier?.managerPid ?? null;
    const ownerManagerStartTicks = evidence.nativeCarrier?.managerStartTicks ?? null;
    evidence.phase = 'creator-gateway-close';
    await app.close();
    app = null;
    evidence.creatorGatewayClosed = { processId: creatorGatewayPid, clientClosed: true };
    if (ownerManagerPid) {
      const carrier = await originalSystemdCarrier(fixture);
      const unit = await originalUserUnit(context, fixture, carrier, 'show',
        `async-question-load-after-creator-close-${context.seed}`);
      const currentManagerPid = Number(unit.MainPID);
      const currentStartTicks = Number.isSafeInteger(currentManagerPid) && currentManagerPid > 0
        ? await procStartTicks(currentManagerPid) : null;
      evidence.nativeCarrierAfterCreatorClose = { activeState: unit.ActiveState,
        managerPid: Number.isSafeInteger(currentManagerPid) && currentManagerPid > 0 ? currentManagerPid : null,
        managerStartTicks: currentStartTicks,
        sameManagerProcess: currentManagerPid === ownerManagerPid && currentStartTicks === ownerManagerStartTicks };
      assert.equal(evidence.nativeCarrierAfterCreatorClose.sameManagerProcess, true,
        'Closing the creator Gateway must leave this run-owned Native carrier alive for the fresh viewer.');
    }

    evidence.phase = 'fresh-viewer-gateway-initialize';
    const viewerStartedAt = performance.now();
    app = await startNativeCodeGateway(context, fixture, 'async-question-load-native-viewer', {
      experimental: requestedCapabilities,
    });
    evidence.freshViewerStartupAndInitializeMs = Math.round(performance.now() - viewerStartedAt);
    const viewerAcceptedCapabilities = offeredCapabilityNames.filter(name =>
      app.initialized.capabilities?.experimental?.[name] === true);
    evidence.freshViewerGatewayOwnState = {
      processId: app.gateway.child.pid,
      initialized: Boolean(app.initialized),
      protocolVersion: app.initialized.protocolVersion,
      scopeReadCompleted: Boolean(app.scope),
      threadResume: app.initialized.capabilities?.threadResume === true,
      offeredExperimentalCapabilityNames: offeredCapabilityNames,
      acceptedExperimentalCapabilityNames: viewerAcceptedCapabilities,
      unacceptedExperimentalCapabilityNames: offeredCapabilityNames.filter(name =>
        !viewerAcceptedCapabilities.includes(name)),
    };
    for (const name of ['asyncUserQuestionsV1', 'taskSourcesV1', 'threadRuntimeHandoffV1', 'interactionBindingV1']) {
      assert.equal(app.initialized.capabilities?.experimental?.[name], true,
        `The fresh viewer must negotiate ${name}.`);
    }
    processRoots = [app.gateway.child.pid, ...(ownerManagerPid ? [ownerManagerPid] : [])];
    const viewerProcessTree = await sampleProcessIo(processRoots, fixture.uid);
    const viewerProcessDetails = await Promise.all(viewerProcessTree.map(async process => ({
      ...process, executable: await procExe(process.pid).catch(() => null),
    })));
    const viewerNativeProcesses = viewerProcessDetails.filter(process => process.executable
      && resolve(process.executable) === resolve(fixture.binary));
    evidence.freshViewerProcessShape = {
      gatewayPid: app.gateway.child.pid,
      candidateNativeProcesses: viewerNativeProcesses.map(({ pid, startTicks, executable }) => ({ pid, startTicks, executable })),
      sameNativeProcessAsCreator: viewerNativeProcesses.some(process =>
        evidence.nativeCarrier?.candidateNativeProcessPids?.includes(process.pid)),
    };

    evidence.phase = 'fresh-viewer-card-read';
    let freshViewerSequence;
    let freshViewerError;
    try {
      freshViewerSequence = await readCardSequence('fresh-viewer-first-read-warm-native');
      const freshQuestion = validatePendingQuestion(freshViewerSequence.questions, 'Fresh-viewer sequence');
      assert.equal(freshQuestion.questionId, registeredQuestion.questionId);
      assert.deepEqual(freshViewerSequence.questions, registeredList.result.questions,
        'Fresh viewer must read the same pending question identity and item data.');
      evidence.freshViewerCardRead = { status: 'resolved', elapsedMs: freshViewerSequence.sequence.elapsedMs };
    } catch (error) {
      freshViewerError = error;
      evidence.freshViewerCardRead = { status: 'failed',
        method: evidence.lastRequestMethod ?? null,
        message: String(error?.message ?? error).slice(0, 500) };
    }
    const viewerTranscript = await readTranscriptProjection('fresh-viewer-thread-read-after-sequence');
    evidence.transcriptStableAcrossViewer = Boolean(creatorTranscript && viewerTranscript
      && creatorTranscript.threadId === viewerTranscript.threadId
      && creatorTranscript.transcriptSha256 === viewerTranscript.transcriptSha256);
    if (creatorTranscript && viewerTranscript) {
      assert.equal(evidence.transcriptStableAcrossViewer, true,
        'Fresh viewer must observe the same persisted transcript IDs and content digests.');
    }
    evidence.providerRequestsBeforeViewer = 2;
    evidence.providerRequestsAfterViewer = model.requests.length;
    assert.equal(model.requests.length, 2, 'Fresh reads must not invoke the provider again.');

    const productRpcSamples = evidence.samples.filter(sample => sample.method === 'thread/list'
      || sample.method === 'thread/resume' || sample.method === 'asyncQuestion/list');
    evidence.thresholdViolations = [
      ...productRpcSamples.filter(sample => sample.elapsedMs >= PRODUCT_RPC_BUDGET_MS)
        .map(sample => ({ kind: 'rpc', name: sample.name, elapsedMs: sample.elapsedMs, budgetMs: PRODUCT_RPC_BUDGET_MS })),
      ...(evidence.cardSequences ?? []).filter(sequence => sequence.elapsedMs >= PRODUCT_CARD_READY_BUDGET_MS)
        .map(sequence => ({ kind: 'card-ready-sequence', name: sequence.label,
          elapsedMs: sequence.elapsedMs, budgetMs: PRODUCT_CARD_READY_BUDGET_MS })),
    ];
    evidence.performanceBudgetsEvaluated = true;
    evidence.phase = 'card-sequence-outcome-assertions';
    if (sameClientError) throw sameClientError;
    if (freshViewerError) throw freshViewerError;

    evidence.phase = 'performance-budget-assertions';
    assert.deepEqual(evidence.thresholdViolations, [],
      'A question card should resolve within 10s and each directory/resume/question RPC within 5s; retain actual timings on failure.');
    assert.equal(fixture.modelRequests(), 0, 'No native channel/model request is part of this protocol fixture.');
  } catch (error) {
    recordFailure(error);
    if (app) {
      const log = await readFile(resolve(context.logsDir, 'async-question-load-native.log'), 'utf8').catch(() => '');
      evidence.nativeTaskUiTransportEvents = log.split('\n').flatMap(line => {
        const start = line.indexOf('{');
        if (start < 0) return [];
        try {
          const event = JSON.parse(line.slice(start));
          if (event.event !== 'native_task_ui_transport_failed'
            || typeof event.stage !== 'string' || !Array.isArray(event.reasonSha256)
            || event.reasonSha256.length > 6
            || !event.reasonSha256.every(value => /^[a-f0-9]{64}$/.test(value))) return [];
          return [{ event: event.event, stage: event.stage, reasonSha256: event.reasonSha256 }];
        } catch { return []; }
      });
    }
    if (fixture) {
      try {
        const carrierDirectories = (await readdir(fixture.profile))
          .filter(name => /^native-channel-carrier-[a-f0-9]{64}$/.test(name));
        if (carrierDirectories.length === 1) {
          const carrier = await originalSystemdCarrier(fixture);
          const unit = await originalUserUnit(context, fixture, carrier, 'show',
            `async-question-load-failure-owner-${context.seed}`);
          const managerPid = Number(unit.MainPID);
          evidence.nativeCarrierAtFailure = { unit: carrier.unit, activeState: unit.ActiveState,
            managerPid: Number.isSafeInteger(managerPid) && managerPid > 0 ? managerPid : null,
            managerStartTicks: Number.isSafeInteger(managerPid) && managerPid > 0 ? await procStartTicks(managerPid) : null,
            executable: Number.isSafeInteger(managerPid) && managerPid > 0 ? await procExe(managerPid) : null };
          const diagnostics = await collectTaskUiDiagnostics(context, fixture, carrier);
          evidence.nativeTaskUiDiagnosticsSummary = {
            coreEventCount: diagnostics.core.length, clientEventCount: diagnostics.client.length,
          };
        } else {
          evidence.nativeCarrierAtFailure = { available: false,
            profileCarrierCount: carrierDirectories.length };
        }
      } catch (diagnosticError) {
        evidence.nativeTaskUiDiagnosticsSummary = { available: false,
          error: String(diagnosticError?.message ?? diagnosticError).slice(0, 500) };
      }
    }
    throw error;
  } finally {
    evidence.providerRequests = model?.requests.length ?? null;
    evidence.providerRequestOutcomes = model?.requestOutcomes?.map(({ requestNumber, closed, aborted }) =>
      ({ requestNumber, closed, aborted })) ?? [];
    evidence.failure = failure ?? null;
    evidence.fixtureBoundary = 'applicationFixture + startNativeCodeGateway; Gateway source comes from an owned git-archive of the candidate sourceTree. Existing sourceRoot node_modules is reused only after lock/package equality; generated renderer/dist is separately marked and excluded from RPC-source claims. The measured first-read and warm reads use the same client and already-running Native task after registration, not a cold process or pre-existing public task.';
    evidence.rcharBoundary = 'Per-process /proc rchar is process I/O accounting and includes all reads; it does not identify bytes hashed or attribute them solely to the image cache.';
    await context.writeArtifactJson('async-question-native-rpc-latency.json', evidence);
  }
});

async function procStartTicks(pid) {
  const line = await readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = line.slice(line.lastIndexOf(')') + 2).trim().split(/\s+/);
  return fields[19];
}

async function candidateRendererCapabilities(sourceRoot, sourceTree, gatewayRoot) {
  const rendererPath = 'apps/kcoder-studio/renderer/src/kcoder/gatewayRpc.ts';
  const rendererSourceBytes = (await execFileAsync('git', ['-C', sourceRoot, 'show', `${sourceTree}:${rendererPath}`], {
    encoding: null, maxBuffer: 4 * 1024 * 1024,
  })).stdout;
  const rendererSource = rendererSourceBytes.toString('utf8');
  const shared = await import(pathToFileURL(resolve(gatewayRoot, 'shared/integrationControlMethods.mjs')).href);
  const handoff = await import(pathToFileURL(resolve(gatewayRoot, 'shared/threadRuntimeHandoff.mjs')).href);
  const literalCapabilities = [
    'acpInboundV1', 'studioWorkModesV1', 'agentDefinitionsV1', 'agentTurnConfigurationV1',
    'asyncUserQuestionsV1', 'webSearchStatusV1', 'webSearchProbeV1', 'workflowCollaborationV1',
    'agentExactRunV1', 'agentExactControlV1', 'agentExactContinuationV1', 'migrationHistoryWorkerStateClientV1',
    'inlineWidgetsV1', 'mcpAppsV1', 'browserAttachments', 'terminalSessions', 'workspaceFiles',
    'turnFileCaptureV1', 'turnReviewEvidenceV1', 'taskComparisonV1', 'taskDeliveryV1',
    'workspaceBinaryRevisionV1', 'toolPathPreviewV1', 'threadStreamContextV1', 'computerUseRecoveryV1',
    'computerUseSessionAuthorizationV1', 'threadRunSummaryV1', 'interactionBindingV1', 'interactionStatusReadV1',
    'turnSubmissionV1', 'turnRetryOperationV1', 'retryModelConfigurationV1',
  ];
  for (const name of literalCapabilities) {
    assert.ok(rendererSource.includes(`${name}:`), `The candidate Renderer must advertise ${name}.`);
  }
  assert.match(rendererSource, /gatewaySharedThreadsV1:\s*this\.channel === 'runtime'/);
  assert.match(rendererSource, /isolatedWidgetsV1:\s*isolatedWidgets/);
  assert.match(rendererSource, /mcpAppsV1:\s*isolatedWidgets\s*&&\s*nativeMcpAppBridgeAvailable\(\)/);
  assert.match(rendererSource, /\[THREAD_RUNTIME_HANDOFF_CAPABILITY\]:\s*true/);
  assert.ok(Array.isArray(shared.INTEGRATION_CONTROL_CAPABILITIES));
  assert.equal(typeof handoff.THREAD_RUNTIME_HANDOFF_CAPABILITY, 'string');
  const experimental = {
    ...Object.fromEntries(shared.INTEGRATION_CONTROL_CAPABILITIES.map(name => [name, true])),
    ...Object.fromEntries(literalCapabilities.filter(name => name !== 'mcpAppsV1').map(name => [name, true])),
    gatewaySharedThreadsV1: true,
    isolatedWidgetsV1: false,
    mcpAppsV1: false,
    [handoff.THREAD_RUNTIME_HANDOFF_CAPABILITY]: true,
  };
  return { experimental, evidence: {
    sourceTree, sourcePath: rendererPath,
    sourceSha256: createHash('sha256').update(rendererSourceBytes).digest('hex'),
    integrationControlCapabilityCount: shared.INTEGRATION_CONTROL_CAPABILITIES.length,
    rendererLiteralCapabilities: literalCapabilities,
    runtimeChannel: true,
    isolatedWidgetsV1: false,
    mcpAppsV1: false,
    boundary: 'Names are read from the exact candidate integration-control module and checked against its git-tree Renderer initializer; widget bridge flags are false for this non-desktop RPC fixture.',
  } };
}

async function materializeCandidateGatewaySource(context, sourceRoot, sourceTree) {
  assert.match(sourceTree, /^[a-f0-9]{40}$/);
  const root = context.pathInState('candidate-gateway-source');
  const archive = context.pathInState('candidate-gateway-source.tar');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const archivePaths = ['LICENSE', 'apps/kcoder-studio/dev-server.mjs', 'apps/kcoder-studio/package.json',
    'apps/kcoder-studio/pnpm-lock.yaml', 'apps/kcoder-studio/src', 'apps/kcoder-studio/shared',
    'apps/kcoder-channel-host/package.json', 'apps/kcoder-channel-host/package-lock.json',
    'apps/kcoder-channel-host/scripts/stage-native-resources.mjs', 'apps/kcoder-channel-host/src'];
  const publicPath = await execFileAsync('git', ['-C', sourceRoot, 'ls-tree', sourceTree, '--', 'apps/kcoder-studio/public'],
    { encoding: 'utf8', maxBuffer: 4_096 });
  if (publicPath.stdout.trim()) archivePaths.push('apps/kcoder-studio/public');
  await runOwnedCommand(context, `candidate-tree-archive-${context.seed}`, 'git', [
    '-C', sourceRoot, 'archive', '--format=tar', `--output=${archive}`, sourceTree, ...archivePaths,
  ]);
  await runOwnedCommand(context, `candidate-tree-extract-${context.seed}`, 'tar', ['-xf', archive, '-C', root]);
  await rm(archive);

  const studioRoot = resolve(root, 'apps/kcoder-studio');
  const sourceStudioRoot = resolve(sourceRoot, 'apps/kcoder-studio');
  const candidateNodeModules = resolve(studioRoot, 'node_modules');
  const nodeModulesSource = await realpath(resolve(sourceStudioRoot, 'node_modules'));
  const nodeModulesInfo = await lstat(nodeModulesSource);
  assert.ok(nodeModulesInfo.isDirectory() && !nodeModulesInfo.isSymbolicLink(), 'SourceRoot package dependencies must be a real directory.');
  await symlink(nodeModulesSource, candidateNodeModules, 'dir');

  const packageFields = ['package.json', 'pnpm-lock.yaml'];
  const packageSha256 = {};
  for (const name of packageFields) {
    const candidateHash = await sha256File(resolve(studioRoot, name));
    const installedSourceHash = await sha256File(resolve(sourceStudioRoot, name));
    assert.equal(installedSourceHash, candidateHash,
      `Reused node_modules is only allowed when sourceRoot ${name} matches the candidate sourceTree.`);
    packageSha256[name] = candidateHash;
  }

  const channelRoot = resolve(root, 'apps/kcoder-channel-host');
  const sourceChannelRoot = resolve(sourceRoot, 'apps/kcoder-channel-host');
  const channelNodeModulesSource = await realpath(resolve(sourceChannelRoot, 'node_modules'));
  const channelNodeModulesInfo = await lstat(channelNodeModulesSource);
  assert.ok(channelNodeModulesInfo.isDirectory() && !channelNodeModulesInfo.isSymbolicLink(),
    'Channel resource dependencies must resolve to a real directory.');
  await symlink(channelNodeModulesSource, resolve(channelRoot, 'node_modules'), 'dir');
  const channelPackageSha256 = {};
  for (const name of ['package.json', 'package-lock.json']) {
    const candidateHash = await sha256File(resolve(channelRoot, name));
    const installedSourceHash = await sha256File(resolve(sourceChannelRoot, name));
    assert.equal(installedSourceHash, candidateHash,
      `Reused channel-host node_modules is only allowed when sourceRoot ${name} matches the candidate sourceTree.`);
    channelPackageSha256[name] = candidateHash;
  }

  const rendererDist = resolve(studioRoot, 'renderer/dist');
  let rendererDistSource = 'candidate sourceTree';
  try {
    const info = await lstat(rendererDist);
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const sourceDist = resolve(sourceStudioRoot, 'renderer/dist');
    const sourceInfo = await lstat(sourceDist);
    assert.ok(sourceInfo.isDirectory() && !sourceInfo.isSymbolicLink(), 'The independently sourced renderer build must be a real directory.');
    await mkdir(dirname(rendererDist), { recursive: true, mode: 0o700 });
    await cp(sourceDist, rendererDist, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    rendererDistSource = 'generated build copied from manifest sourceRoot; not sourceTree-authenticated';
  }
  return { root, evidence: { root, sourceTree, gitArchivePaths: archivePaths,
    studioDependencies: { packageSha256, nodeModulesSource },
    channelHostDependencies: { packageSha256: channelPackageSha256, nodeModulesSource: channelNodeModulesSource },
    rootLicenseSha256: await sha256File(resolve(root, 'LICENSE')), rendererDistSource } };
}

async function runOwnedCommand(context, label, command, args) {
  const child = context.spawnOwned(label, command, args, { cwd: context.stateDir });
  try {
    const exit = await waitForStdioChildClose(child, 120_000, label);
    assert.equal(exit.code, 0, `${label} must exit successfully (code=${exit.code}, signal=${exit.signal}).`);
  } finally {
    await context.stopOwned(label);
  }
}

async function procExe(pid) {
  return (await import('node:fs/promises')).readlink(`/proc/${pid}/exe`);
}

async function sampleProcessIo(roots, expectedUid) {
  const found = new Map();
  const visit = async pid => {
    if (found.has(pid)) return;
    try {
      const [status, statLine, ioText, childrenText] = await Promise.all([
        readFile(`/proc/${pid}/status`, 'utf8'),
        readFile(`/proc/${pid}/stat`, 'utf8'),
        readFile(`/proc/${pid}/io`, 'utf8'),
        readFile(`/proc/${pid}/task/${pid}/children`, 'utf8').catch(() => ''),
      ]);
      const uid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1]);
      if (uid !== expectedUid) return;
      const fields = statLine.slice(statLine.lastIndexOf(')') + 2).trim().split(/\s+/);
      const startTicks = fields[19];
      const comm = statLine.slice(statLine.indexOf('(') + 1, statLine.lastIndexOf(')'));
      const values = Object.fromEntries(ioText.trim().split('\n').map(line => {
        const [key, value] = line.split(':');
        return [key, Number(value.trim())];
      }));
      const identity = `${pid}:${startTicks}`;
      found.set(pid, { identity, pid, startTicks, comm,
        rchar: values.rchar, readBytes: values.read_bytes, syscr: values.syscr });
      for (const child of childrenText.trim().split(/\s+/).filter(Boolean)) await visit(Number(child));
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'ESRCH'].includes(error.code)) throw error;
    }
  };
  for (const pid of roots) await visit(pid);
  return [...found.values()].sort((a, b) => a.pid - b.pid);
}

function ioDelta(before, after) {
  const old = new Map(before.map(process => [process.identity, process]));
  const same = after.map(process => ({ process, previous: old.get(process.identity) }));
  const known = same.filter(row => row.previous);
  return {
    sampledProcessesBefore: before.length,
    sampledProcessesAfter: after.length,
    rcharDeltaKnownProcesses: known.reduce((sum, row) => sum + row.process.rchar - row.previous.rchar, 0),
    readBytesDeltaKnownProcesses: known.reduce((sum, row) => sum + row.process.readBytes - row.previous.readBytes, 0),
    syscrDeltaKnownProcesses: known.reduce((sum, row) => sum + row.process.syscr - row.previous.syscr, 0),
    newProcessIdentities: same.filter(row => !row.previous).map(row => ({ pid: row.process.pid, comm: row.process.comm })),
    disappearedProcessCount: before.filter(process => !after.some(row => row.identity === process.identity)).length,
  };
}
