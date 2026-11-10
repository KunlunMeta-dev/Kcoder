import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readlink, realpath, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { repoRoot, runE2E } from '../harness/run-context.mjs';
import { HeaderWebSocket } from './header-websocket-ws-diagnostic.mjs';

process.umask(0o077);

const gatewayHost = '127.0.0.1';
const gatewayPort = 58613;
const gatewayPid = Number(process.env.KCODER_E2E_ASYNC_GATEWAY_PID);
const taskId = 'kcoder:expert-preview:NssAk';
const threadId = 'NssAk';
const deviceId = 'expert-preview';
const targetTitle = '用你的ask工具随便问几个问题';
const expectedNativeExe = resolve(repoRoot,
  process.env.KCODER_E2E_ASYNC_EXPECTED_NATIVE_EXE ??
  'target/preview/channel-host-lifecycle-20261102/kcoder-app-server-host-v30-normal-20261102');
const requestTimeoutMs = 240_000;
const startedHr = process.hrtime.bigint();
const elapsedMs = () => Number(process.hrtime.bigint() - startedHr) / 1_000_000;
const round = value => Math.round(value * 10) / 10;
const authTokenValue = raw => {
  const entry = raw.split('\0').find(value => value.startsWith('KCODER_STUDIO_AUTH_TOKEN='));
  return entry?.slice('KCODER_STUDIO_AUTH_TOKEN='.length) || null;
};
const safeErrorCode = value => Number.isInteger(value) ? value : null;

function procStatFields(value) {
  const close = value.lastIndexOf(')');
  assert.ok(close >= 0);
  return value.slice(close + 2).trim().split(/\s+/);
}

async function gatewaySnapshot() {
  const root = '/proc/' + gatewayPid;
  const metadata = await stat(root);
  const command = (await readFile(root + '/cmdline', 'utf8')).split('\0').filter(Boolean);
  const cwd = await realpath(root + '/cwd');
  const env = await readFile(root + '/environ', 'utf8');
  const fields = procStatFields(await readFile(root + '/stat', 'utf8'));
  assert.equal(metadata.uid, process.getuid());
  assert.equal(cwd, repoRoot);
  assert.ok(command.some(value => value.endsWith('/apps/kcoder-studio/dev-server.mjs')));
  const token = authTokenValue(env);
  assert.ok(token);
  const children = (await readFile(root + '/task/' + gatewayPid + '/children', 'utf8'))
    .trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isSafeInteger);
  return {
    uid: metadata.uid,
    cwd,
    processStartTicks: fields[19] ?? null,
    directChildPids: children,
    token,
  };
}

async function nativeSnapshot(expectedPid = null) {
  const gateway = await stat('/proc/' + gatewayPid);
  assert.equal(gateway.uid, process.getuid());
  const children = (await readFile('/proc/' + gatewayPid + '/task/' + gatewayPid + '/children', 'utf8'))
    .trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isSafeInteger);
  const candidates = [];
  for (const pid of children) {
    try {
      const executable = await readlink('/proc/' + pid + '/exe');
      if (resolve(executable.replace(/ \(deleted\)$/, '')) === expectedNativeExe)
        candidates.push({ pid, executable });
    } catch { /* A concurrently exiting child is excluded from this snapshot. */ }
  }
  assert.equal(candidates.length, 1, 'Expected exactly one direct Native app-server child matching the configured executable.');
  const selected = candidates[0];
  const pid = selected.pid;
  if (expectedPid !== null) assert.equal(pid, expectedPid, 'Native app-server PID changed during the probe.');
  const procPath = '/proc/' + pid;
  const metadata = await stat(procPath);
  assert.equal(metadata.uid, process.getuid());
  const exeMetadata = await stat(procPath + '/exe');
  const fields = procStatFields(await readFile(procPath + '/stat', 'utf8'));
  const io = Object.fromEntries((await readFile(procPath + '/io', 'utf8'))
    .trim().split('\n').map(line => {
      const split = line.indexOf(':');
      return [line.slice(0, split), Number(line.slice(split + 1).trim())];
    }));
  return {
    pid,
    parentPid: Number(fields[1]),
    startTicks: fields[19] ?? null,
    executable: basename(selected.executable.replace(/ \(deleted\)$/, '')),
    executablePath: selected.executable.replace(/ \(deleted\)$/, ''),
    executableInode: Number(exeMetadata.ino),
    executableDevice: Number(exeMetadata.dev),
    executableSizeBytes: Number(exeMetadata.size),
    userCpuTicks: Number(fields[11]),
    systemCpuTicks: Number(fields[12]),
    rcharBytes: io.rchar,
    readBytes: io.read_bytes,
    readSyscalls: io.syscr,
  };
}

function deltaSamples(before, after) {
  assert.equal(after.pid, before.pid);
  assert.equal(after.startTicks, before.startTicks);
  assert.equal(after.executableInode, before.executableInode);
  assert.equal(after.executableSizeBytes, before.executableSizeBytes);
  return {
    rcharBytes: after.rcharBytes - before.rcharBytes,
    readBytes: after.readBytes - before.readBytes,
    readSyscalls: after.readSyscalls - before.readSyscalls,
    userCpuTicks: after.userCpuTicks - before.userCpuTicks,
    systemCpuTicks: after.systemCpuTicks - before.systemCpuTicks,
  };
}

function questionFingerprint(rows) {
  const descriptors = rows.map(question => ({
    questionId: typeof question?.questionId === 'string' ? question.questionId : '',
    status: typeof question?.status === 'string' ? question.status : '',
    revision: Number.isSafeInteger(question?.revision) ? question.revision : null,
  })).sort((left, right) => left.questionId.localeCompare(right.questionId));
  return createHash('sha256').update(JSON.stringify(descriptors)).digest('hex');
}

async function previousQuestionEvidence() {
  const publicPath = resolve(repoRoot,
    'target/test/apps/kcoder-studio/e2e/private/async-question-load-latency.once.mjs/20261103-015256.600Z/artifacts/async-question-load-latency.final.json');
  const repeatedReadPath = resolve(repoRoot,
    'target/test/apps/kcoder-studio/e2e/private/async-question-original-core-readonly.once.mjs/20261102-160019.841Z/artifacts/deployed-question-read.json');
  const publicJson = JSON.parse(await readFile(publicPath, 'utf8'));
  const publicRows = (publicJson.rpcEvents ?? []).filter(event =>
    event.method === 'asyncQuestion/list' && event.direction === 'received' &&
    event.taskId === taskId && event.threadId === threadId && event.ok === true);
  assert.ok(publicRows.length > 0, 'Recent sanitized task status evidence is required before asyncQuestion/list.');
  assert.ok(publicRows.every(event => {
    const statuses = event.questionStatuses ?? {};
    return Object.keys(statuses).length === 1 && statuses.context_applied === event.questionCount;
  }), 'Skip asyncQuestion/list unless the latest observed task state is context_applied only.');

  const repeatedJson = JSON.parse(await readFile(repeatedReadPath, 'utf8'));
  const priorReceipts = (repeatedJson.receipts ?? []).filter(receipt =>
    receipt.threadId === threadId && receipt.resultThreadId === threadId &&
    !receipt.error && Array.isArray(receipt.questions));
  const priorFingerprints = priorReceipts.map(receipt => questionFingerprint(receipt.questions));
  const unique = [...new Set(priorFingerprints)];
  return {
    recentStatePreflight: {
      run: '20261103-015256.600Z',
      matchingSuccessfulListReads: publicRows.length,
      latestObservedStatuses: publicRows.at(-1).questionStatuses,
      asyncQuestionListAllowed: true,
    },
    repeatedReceiptEvidence: {
      run: '20261102-160019.841Z',
      successfulReceiptCount: priorReceipts.length,
      distinctQuestionIdentityProjectionHashes: unique.length,
      repeatedFingerprintSha256: unique.length === 1 ? unique[0] : null,
      repeatedFingerprintCount: unique.length === 1 ? priorFingerprints.length : 0,
      fingerprintScope: 'SHA-256 of sorted questionId/status/revision tuples only; no prompt, answer or user text.',
    },
  };
}

function summarizeResult(method, message) {
  if (message.error) return { ok: false, errorCode: safeErrorCode(message.error.code) };
  const result = message.result ?? {};
  if (method === 'initialize') {
    const experimental = result.capabilities?.experimental ?? {};
    return {
      ok: true,
      protocolVersion: typeof result.protocolVersion === 'string' ? result.protocolVersion : null,
      serverName: typeof result.serverInfo?.name === 'string' ? result.serverInfo.name : null,
      serverVersion: typeof result.serverInfo?.version === 'string' ? result.serverInfo.version : null,
      asyncUserQuestionsV1: experimental.asyncUserQuestionsV1 === true,
      gatewaySharedThreadsV1: experimental.gatewaySharedThreadsV1 === true,
    };
  }
  if (method === 'thread/list') {
    const threads = Array.isArray(result.threads) ? result.threads : [];
    const matches = threads.filter(thread => thread?.title === targetTitle).map(thread => ({
      threadId: typeof thread.id === 'string' ? thread.id : null,
      status: typeof thread.status === 'string' ? thread.status : null,
      createdAt: typeof thread.createdAt === 'string' ? thread.createdAt : null,
      updatedAt: typeof thread.updatedAt === 'string' ? thread.updatedAt : null,
    }));
    const target = threads.find(thread => thread?.id === threadId);
    const ids = threads.map(thread => thread?.id).filter(value => typeof value === 'string');
    return {
      ok: true,
      threadCount: threads.length,
      hasNextPage: typeof result.nextCursor === 'string' && result.nextCursor.length > 0,
      completeness: typeof result.completeness === 'string' ? result.completeness : null,
      issueCount: Number.isSafeInteger(result.issueCount) ? result.issueCount : null,
      duplicateThreadIdCount: ids.length - new Set(ids).size,
      targetThread: target ? {
        threadId,
        status: typeof target.status === 'string' ? target.status : null,
        createdAt: typeof target.createdAt === 'string' ? target.createdAt : null,
        updatedAt: typeof target.updatedAt === 'string' ? target.updatedAt : null,
        titleMatched: target.title === targetTitle,
      } : null,
      exactTitleMatches: matches,
    };
  }
  if (method === 'thread/resume') {
    const thread = result.thread ?? {};
    const page = result.history?.page;
    return {
      ok: true,
      threadId: typeof thread.id === 'string' ? thread.id : null,
      threadIdMatched: thread.id === threadId,
      titleMatched: thread.title === targetTitle,
      status: typeof thread.status === 'string' ? thread.status : null,
      createdAt: typeof thread.createdAt === 'string' ? thread.createdAt : null,
      updatedAt: typeof thread.updatedAt === 'string' ? thread.updatedAt : null,
      mainTurn: typeof thread.runSummary?.mainTurn === 'string' ? thread.runSummary.mainTurn : null,
      historyStatus: typeof result.history?.status === 'string' ? result.history.status : null,
      historyPageItemCount: Array.isArray(page?.items) ? page.items.length : null,
    };
  }
  if (method === 'asyncQuestion/list') {
    const rows = Array.isArray(result.questions) ? result.questions : [];
    const statusCounts = {};
    for (const row of rows) {
      const key = typeof row?.status === 'string' ? row.status : 'unknown';
      statusCounts[key] = (statusCounts[key] ?? 0) + 1;
    }
    const itemCount = rows.reduce((count, row) =>
      count + (Array.isArray(row?.questions) ? row.questions.length : 0), 0);
    return {
      ok: true,
      resultThreadIdMatched: result.threadId === threadId,
      questionCount: rows.length,
      questionItemCount: itemCount,
      questionStatuses: statusCounts,
      questionSetFingerprintSha256: questionFingerprint(rows),
      reconciliationCandidateCount: rows.filter(row =>
        ['queued', 'delivery_unknown'].includes(row?.status)).length,
    };
  }
  return { ok: true };
}

await runE2E(import.meta.url, {
  testId: 'async-question-native-rpc-rchar-readonly',
  tier: 'manual-live',
  modelPolicy: 'One authorized Gateway login and one read-only Native RPC sequence for the existing task; no answers, turns, platform messages or model calls.',
}, async context => {
  assert.ok(Number.isSafeInteger(gatewayPid) && gatewayPid > 1);
  const initialGateway = await gatewaySnapshot();
  context.registerSecret(initialGateway.token);
  const token = initialGateway.token;
  const evidence = {
    task: { deviceId, taskId, threadId },
    gateway: {
      pid: gatewayPid,
      uid: initialGateway.uid,
      cwd: initialGateway.cwd,
      processStartTicks: initialGateway.processStartTicks,
      listenAddress: gatewayHost + ':' + gatewayPort,
      tokenReadFromGatewayProcEnviron: true,
    },
    targetBinary: null,
    login: { status: null, elapsedMs: null, ownedSessionCreated: false, logoutStatus: null },
    websocket: { opened: false, closeCompleted: false },
    rpcCalls: [],
    nativeSamples: [],
    priorQuestionEvidence: null,
    guardrails: {
      sentRpcMethods: [],
      taskStateChangingMethods: 0,
      modelCalls: 0,
      platformSends: 0,
      tokenStored: false,
      userTextStored: false,
      asyncQuestionReconciliationWriteObserved: false,
      asyncQuestionListSkippedForStateBoundary: false,
    },
  };
  let cookie = null;
  let websocket = null;
  let requestId = 0;
  let pending = null;
  let loginLogoutDone = false;
  let websocketCloseDone = false;
  const cleanupSocket = async () => {
    if (websocketCloseDone) return;
    websocketCloseDone = true;
    try {
      if (!websocket) return;
      if (websocket.readyState === HeaderWebSocket.CLOSED) {
        evidence.websocket.closeCompleted = true;
        return;
      }
      await new Promise(resolvePromise => {
        const timeout = setTimeout(() => resolvePromise(), 1500);
        websocket.addEventListener('close', () => {
          clearTimeout(timeout);
          resolvePromise();
        }, { once: true });
        if (websocket.readyState < HeaderWebSocket.CLOSING) websocket.close();
      });
      evidence.websocket.closeCompleted = websocket.readyState === HeaderWebSocket.CLOSED;
    } catch { evidence.websocket.closeCompleted = false; }
  };
  const cleanupLogin = async () => {
    if (loginLogoutDone || !cookie) return;
    loginLogoutDone = true;
    try {
      const response = await fetch('http://' + gatewayHost + ':' + gatewayPort + '/logout', {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie, origin: 'http://' + gatewayHost + ':' + gatewayPort },
      });
      evidence.login.logoutStatus = response.status;
      await response.arrayBuffer();
    } catch { evidence.login.logoutStatus = null; }
  };

  context.addCleanup('write final sanitized Native RPC evidence', async () => {
    evidence.guardrails.taskStateChangingMethods = evidence.guardrails.sentRpcMethods
      .filter(method => !['initialize', 'thread/list', 'thread/resume', 'asyncQuestion/list'].includes(method)).length;
    await context.writeArtifactJsonInternal('native-rpc-rchar-final.json', evidence);
  });

  const nativeBeforeInitialization = await nativeSnapshot();
  assert.equal(nativeBeforeInitialization.parentPid, gatewayPid);
  assert.equal(nativeBeforeInitialization.executablePath, expectedNativeExe);
  evidence.targetBinary = {
    expectedNativeImagePathMatched: true,
    pid: nativeBeforeInitialization.pid,
    parentPid: nativeBeforeInitialization.parentPid,
    startTicks: nativeBeforeInitialization.startTicks,
    executable: nativeBeforeInitialization.executable,
    executablePath: nativeBeforeInitialization.executablePath,
    inode: nativeBeforeInitialization.executableInode,
    device: nativeBeforeInitialization.executableDevice,
    sizeBytes: nativeBeforeInitialization.executableSizeBytes,
  };
  evidence.nativeSamples.push({ label: 'before-initialize', atMs: round(elapsedMs()), ...nativeBeforeInitialization });

  const loginStartedAt = elapsedMs();
  let loginResponse;
  try {
    loginResponse = await fetch('http://' + gatewayHost + ':' + gatewayPort + '/login', {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://' + gatewayHost + ':' + gatewayPort,
      },
      body: new URLSearchParams({ token, returnTo: '/' }).toString(),
    });
  } catch {
    throw new Error('Loopback Gateway login request failed.');
  }
  evidence.login.status = loginResponse.status;
  evidence.login.elapsedMs = round(elapsedMs() - loginStartedAt);
  assert.equal(loginResponse.status, 303, 'Gateway login did not return the expected redirect status.');
  const setCookie = loginResponse.headers.get('set-cookie');
  assert.ok(setCookie);
  cookie = setCookie.split(';', 1)[0];
  context.registerSecret(cookie);
  assert.match(cookie, /^kcoder_studio_session=[A-Za-z0-9%-]{16,256}$/);
  evidence.login.ownedSessionCreated = true;
  context.addCleanup('revoke this RunContext-owned Gateway login session', cleanupLogin);
  await loginResponse.arrayBuffer();

  const wsUrl = new URL('ws://' + gatewayHost + ':' + gatewayPort + '/rpc');
  wsUrl.searchParams.set('token', 'cookie-auth');
  wsUrl.searchParams.set('server', deviceId);
  wsUrl.searchParams.set('channel', 'runtime');
  websocket = new HeaderWebSocket(wsUrl, {
    Origin: 'http://' + gatewayHost + ':' + gatewayPort,
    Cookie: cookie,
  });
  context.addCleanup('close owned Native RPC WebSocket', cleanupSocket);
  websocket.addEventListener('error', () => {
    if (pending) pending.reject(new Error('WebSocket transport error.'));
  });
  websocket.addEventListener('close', () => {
    if (pending) pending.reject(new Error('WebSocket closed while an RPC was pending.'));
  });
  websocket.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (!pending || String(message?.id) !== String(pending.id)) return;
    const current = pending;
    pending = null;
    clearTimeout(current.timeout);
    current.resolve({
      receivedAtMs: round(elapsedMs()),
      response: summarizeResult(current.method, message),
    });
  });
  await new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket open timed out.')), 20_000);
    websocket.addEventListener('open', () => {
      clearTimeout(timeout);
      resolvePromise();
    }, { once: true });
    websocket.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('WebSocket open failed.'));
    }, { once: true });
  });
  evidence.websocket.opened = true;

  const sample = async label => {
    const value = await nativeSnapshot(nativeBeforeInitialization.pid);
    evidence.nativeSamples.push({ label, atMs: round(elapsedMs()), ...value });
    return value;
  };
  const callRpc = async (method, params, evidenceName) => {
    const before = await sample(evidenceName + '-before');
    const id = ++requestId;
    const sentAtMs = round(elapsedMs());
    evidence.guardrails.sentRpcMethods.push(method);
    const received = await new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        if (pending?.id === id) pending = null;
        reject(new Error('RPC request timed out.'));
      }, requestTimeoutMs);
      pending = { id, method, timeout, resolve: resolvePromise, reject };
      try {
        websocket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch {
        clearTimeout(timeout);
        pending = null;
        reject(new Error('RPC request could not be sent.'));
      }
    });
    const after = await sample(evidenceName + '-after');
    const record = {
      method,
      taskIdentity: taskId,
      threadIdentity: method === 'thread/list' ? null : threadId,
      sentAtMs,
      receivedAtMs: received.receivedAtMs,
      durationMs: round(received.receivedAtMs - sentAtMs),
      response: received.response,
      nativeIoCpuDelta: deltaSamples(before, after),
    };
    evidence.rpcCalls.push(record);
    await context.writeArtifactJson(
      'rpc-' + String(evidence.rpcCalls.length).padStart(2, '0') + '-' + evidenceName + '.json',
      record,
    );
    console.log(JSON.stringify({
      rpc: method,
      durationMs: record.durationMs,
      response: record.response,
      nativeIoCpuDelta: record.nativeIoCpuDelta,
    }));
    return record;
  };

  const initialize = await callRpc('initialize', {
    protocolVersion: '2026-07-27',
    clientInfo: { name: 'kcoder-e2e-readonly-rchar-probe', version: '1' },
    capabilities: { experimental: {
      asyncUserQuestionsV1: true,
      gatewaySharedThreadsV1: true,
      threadRunSummaryV1: true,
      threadTranscriptSnapshotV1: true,
      threadTranscriptObservationV1: true,
      threadStreamContextV1: true,
    } },
  }, 'initialize');
  assert.equal(initialize.response.ok, true);
  assert.equal(initialize.response.protocolVersion, '2026-07-27');

  websocket.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }));

  const threadList = await callRpc('thread/list', { limit: 100 }, 'thread-list');
  assert.equal(threadList.response.ok, true);

  const resumed = await callRpc('thread/resume', { threadId }, 'thread-resume');
  assert.equal(resumed.response.ok, true);
  assert.equal(resumed.response.threadIdMatched, true, 'Native did not resume the requested original thread.');

  const prior = await previousQuestionEvidence();
  evidence.priorQuestionEvidence = prior;
  const supportsAsyncQuestions = initialize.response.asyncUserQuestionsV1 === true;
  const preflightSafe = prior.recentStatePreflight.asyncQuestionListAllowed === true;
  if (!supportsAsyncQuestions || !preflightSafe) {
    evidence.guardrails.asyncQuestionListSkippedForStateBoundary = true;
    evidence.rpcCalls.push({
      method: 'asyncQuestion/list',
      taskIdentity: taskId,
      threadIdentity: threadId,
      skipped: true,
      skipReason: !supportsAsyncQuestions ? 'asyncUserQuestionsV1_not_negotiated' : 'recent_state_not_context_applied_only',
    });
  } else {
    const questionList = await callRpc('asyncQuestion/list',
      { threadId, includeTerminal: true }, 'async-question-list');
    if (questionList.response.ok) {
      const statusCounts = questionList.response.questionStatuses ?? {};
      evidence.guardrails.asyncQuestionReconciliationWriteObserved =
        Object.keys(statusCounts).some(status => status === 'queued' || status === 'delivery_unknown');
      const repeatedEvidence = evidence.priorQuestionEvidence.repeatedReceiptEvidence;
      const priorFingerprint = repeatedEvidence.repeatedFingerprintSha256;
      const currentFingerprint = questionList.response.questionSetFingerprintSha256;
      repeatedEvidence.currentFingerprintSha256 = currentFingerprint;
      repeatedEvidence.currentMatchesPriorFingerprint =
        Boolean(priorFingerprint && currentFingerprint === priorFingerprint);
    }
  }

  const finalNative = await sample('after-last-rpc');
  const firstSample = evidence.nativeSamples[0];
  evidence.targetBinary.stableIdentityThroughProbe =
    finalNative.pid === firstSample.pid &&
    finalNative.startTicks === firstSample.startTicks &&
    finalNative.executableInode === firstSample.executableInode &&
    finalNative.executableSizeBytes === firstSample.executableSizeBytes;
  evidence.targetBinary.wholeProbeNativeIoCpuDelta = deltaSamples(firstSample, finalNative);
  return {
    taskId,
    nativePid: finalNative.pid,
    rpcCount: evidence.rpcCalls.filter(call => !call.skipped).length,
    threadListCount: threadList.response.threadCount,
    exactTitleMatchCount: threadList.response.exactTitleMatches.length,
    asyncQuestionListStatus: evidence.rpcCalls.at(-1)?.response?.questionStatuses ?? null,
    modelCalls: 0,
  };
});
