import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { startGateway } from '../harness/gateway.mjs';
import { startApprovalModelFixture } from '../harness/approval-model.mjs';
import { openRpc, closeRpcAndWait, gatewayRpcUrl } from '../harness/rpc.mjs';
import { hashExecutableFile, findOwnedExecutableProcesses } from '../harness/owned-executable-provenance.mjs';
import { runE2E, waitFor } from '../harness/run-context.mjs';

const accessTtlMs = 8_000, socketGraceMs = 1_500, refreshLeadMs = 1_500;
const binary = resolve(process.env.KCODER_E2E_KCODER_BIN || '');
const expectedSha = process.env.KCODER_E2E_EXPECTED_KCODER_SHA256;
await runE2E(import.meta.url, {
  testId: 'actual-active-provider-stream-durable-auth-renewal', tier: 'full-integration',
  modelPolicy: 'loopback deterministic HTTP SSE; actual Gateway/Rust active turn and PTY; excludes external model, Goal, Cron and automation ownership',
  retainSuccessLogs: true, cleanupTimeoutMs: 15_000,
}, async context => {
  assert.ok(process.env.KCODER_E2E_KCODER_BIN);
  assert.match(expectedSha || '', /^[a-f0-9]{64}$/);
  const executable = await hashExecutableFile(binary);
  assert.equal(executable.sha256, expectedSha);
  const evidence = { accessTtlMs, socketGraceMs, binarySha256: expectedSha, renewals: [], cases: [],
    scope: 'actual Rust SSE/PTY continuity and expiry/revoke cancellation; deterministic loopback Provider; no Goal/Cron/automation claim' };
  let failure;
  try {
    const workspace = context.pathInState('workspace'), config = context.pathInState('config');
    await Promise.all([mkdir(workspace, { recursive: true }), mkdir(config, { recursive: true })]);
    const released = new Set();
    const model = await startApprovalModelFixture(context, {
      responseSteps: ({ requestNumber }) => [
        { delta: { role: 'assistant', content: `STREAM_ACTIVE_${requestNumber}` } },
        { ready: () => released.has(requestNumber), delta: { content: '_COMPLETED' } },
        { finishReason: 'stop' },
      ],
    });
    assert.equal(new URL(model.baseUrl).hostname, '127.0.0.1');
    const credential = randomUUID(); context.registerSecret(credential);
    await context.writeStateJson('config/settings.json', {});
    await context.writeStateJson('config/credentials.json', { fixture: { type: 'api', key: credential } });
    const settingsFile = await context.writeStateJson('settings.json', {
      active_provider: 'fixture', providers: { fixture: { api_format: 'openai_chat_completions',
        endpoint: model.baseUrl, default_model: 'loopback-stream-fixture', context_window_tokens: 128000,
        output_headroom_tokens: 8192, max_output_tokens: 256, request_timeout_secs: 90, no_proxy: true, extra_body: {} } },
    });
    const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', runtime: 'kcoder',
      label: 'owned stream renewal', transport: 'local', command: binary, workspace, settingsFile }]);
    const serversStore = context.pathInState('gateway/servers-store.json');
    const gateway = await startGateway(context, { auth: true, workspace, serversFile, serversStore, kcoderBin: binary,
      env: { KCODER_CONFIG_DIR: config, KCODER_STUDIO_MOCK: '0', KCODER_STUDIO_WEB_ROOT: '',
        KCODER_STUDIO_MOBILE_ACCESS_TTL_MS: String(accessTtlMs), KCODER_STUDIO_MOBILE_SOCKET_GRACE_MS: String(socketGraceMs) } });
    const deviceStore = resolve(dirname(serversStore), 'mobile-device-auth/devices.json');
    const http = async (path, { body, grant, method = body === undefined ? 'GET' : 'POST' } = {}) => {
      const response = await fetch(`${gateway.baseUrl}${path}`, { method, signal: AbortSignal.timeout(5_000),
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(grant ? { authorization: `Bearer ${grant.accessToken}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      const payload = response.status === 204 ? null : await response.json();
      for (const field of ['accessToken', 'refreshToken', 'rpcToken']) if (payload?.[field]) context.registerSecret(payload[field]);
      return { status: response.status, payload };
    };
    const pair = async label => {
      const reply = await http('/api/mobile/session', { body: { token: gateway.authToken, durableDeviceAuthorization: true, deviceLabel: label } });
      assert.equal(reply.status, 200); assert.equal(reply.payload.capabilities.mobileRefreshV1, true);
      return reply.payload;
    };
    const refresh = async grant => {
      const rotationId = randomUUID();
      const reply = await http('/api/mobile/session/refresh', { body: { refreshToken: grant.refreshToken, deviceId: grant.deviceId, rotationId } });
      assert.equal(reply.status, 200);
      const next = reply.payload;
      assert.equal(next.deviceId, grant.deviceId); assert.equal(next.authorizationGeneration, grant.authorizationGeneration);
      assert.notEqual(next.accessToken, grant.accessToken); assert.notEqual(next.refreshToken, grant.refreshToken);
      const raw = await readFile(deviceStore, 'utf8');
      const stored = JSON.parse(raw).devices.find(row => row.id === grant.deviceId);
      assert.equal(stored.lastRotationId, rotationId); assert.equal(stored.accessExpiresAt, next.expiresAt);
      for (const token of [grant.accessToken, next.accessToken, grant.refreshToken, next.refreshToken]) assert.equal(raw.includes(token), false);
      return next;
    };
    const connect = async (grant, label) => {
      const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', grant.rpcToken), { headers: { authorization: `Bearer ${grant.accessToken}` } });
      context.addCleanup(`close ${label} RPC`, () => closeRpcAndWait(rpc, label));
      const initialized = await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: label, version: '1' } });
      assert.equal(initialized.serverInfo.name, 'kcoder-app-server');
      return rpc;
    };
    let starts = 0;
    const start = async (rpc, label) => {
      const thread = await rpc.request('thread/start', {}), threadId = thread.thread.id, clientMessageId = randomUUID();
      const requestNumber = model.requests.length + 1;
      starts += 1;
      const accepted = await rpc.request('turn/start', { threadId, clientMessageId, input: [{ type: 'text', text: label }] });
      const turnId = accepted.turn.id;
      await rpc.waitFor(message => message.method === 'item/delta' && message.params?.threadId === threadId &&
        message.params?.turnId === turnId && message.params?.delta?.text?.includes(`STREAM_ACTIVE_${requestNumber}`), 20_000, 'real Engine SSE output');
      assert.equal(model.requests.length, requestNumber);
      assert.equal(model.requestOutcomes[requestNumber - 1].aborted, false);
      return { threadId, turnId, clientMessageId, requestNumber, activeAt: Date.now() };
    };
    const receipt = async (rpc, turn) => (await rpc.request('turn/receipt/read', { threadId: turn.threadId, clientMessageId: turn.clientMessageId })).receipt;
    const terminal = (rpc, turn) => rpc.messages().filter(message => message.method === 'turn/completed' && message.params?.turnId === turn.turnId);
    const closed = rpc => waitFor(() => rpc.socket.readyState === rpc.socket.constructor.CLOSED, 12_000, 'authorization socket closure', 25, context.abortSignal);
    const interrupted = async (rpc, turn) => waitFor(async () => {
      const value = await receipt(rpc, turn); return value?.status === 'interrupted' ? value : null;
    }, 12_000, 'durable Interrupted receipt', 50, context.abortSignal);
    const ptyMarker = async (rpc, sessionId, label) => {
      const marker = `PTY_${label}`, path = resolve(workspace, `${label}.txt`);
      await rpc.request('terminal/write', { session_id: sessionId, data: `printf '%s\\n' '${marker}'; printf '%s' '${marker}' > '${path}'\n` });
      await waitFor(async () => (await readFile(path, 'utf8').catch(() => '')) === marker, 5_000, 'real PTY command execution', 25, context.abortSignal);
      await rpc.waitFor(message => message.method === 'terminal/output' && message.params?.session_id === sessionId &&
        (message.params?.data || '').includes(marker), 5_000, 'real PTY output');
    };

    let grant = await pair('active-stream');
    const rpc = await connect(grant, 'active-stream'), socket = rpc.socket;
    const pty = await rpc.request('terminal/start', { cwd: workspace });
    await ptyMarker(rpc, pty.session_id, 'before-renewal');
    const turn = await start(rpc, 'hold one actual Provider stream across token rotations');
    const initialExpiry = grant.expiresAt, initialLease = grant.wsLeaseExpiresAt;
    assert.ok(turn.activeAt < initialExpiry);
    for (let index = 0; index < 4; index += 1) {
      const prior = grant;
      await waitFor(() => Date.now() >= prior.expiresAt - refreshLeadMs, accessTtlMs + 2_000, 'server-issued refresh window', 25, context.abortSignal);
      grant = await refresh(prior);
      assert.ok(grant.expiresAt > prior.expiresAt);
      assert.equal((await http('/api/servers', { grant: prior })).status, 401, 'old access cannot authorize new HTTP requests');
      assert.equal(rpc.socket, socket); assert.equal(socket.readyState, socket.constructor.OPEN);
      assert.equal((await receipt(rpc, turn)).status, 'running');
      assert.equal(terminal(rpc, turn).length, 0); assert.equal(model.requests.length, 1);
      assert.equal(model.requestOutcomes[0].aborted, false);
      await ptyMarker(rpc, pty.session_id, `rotation-${index + 1}`);
      evidence.renewals.push({ index: index + 1, observedAt: Date.now(), priorExpiresAt: prior.expiresAt, expiresAt: grant.expiresAt, wsLeaseExpiresAt: grant.wsLeaseExpiresAt });
    }
    await waitFor(() => Date.now() > Math.max(initialLease, turn.activeAt + 3 * accessTtlMs), accessTtlMs, 'active stream beyond initial lease and three access TTLs', 25, context.abortSignal);
    assert.equal(terminal(rpc, turn).length, 0); assert.equal(model.requestOutcomes[0].aborted, false);
    assert.ok(Date.now() > initialLease); assert.ok(Date.now() - turn.activeAt > 3 * accessTtlMs);
    released.add(turn.requestNumber);
    const completion = await rpc.waitFor(message => message.method === 'turn/completed' && message.params?.turnId === turn.turnId, 15_000, 'same held turn completion');
    assert.equal(completion.params.turn.status, 'completed'); assert.equal(terminal(rpc, turn).length, 1);
    assert.equal((await receipt(rpc, turn)).status, 'completed'); assert.equal(model.requests.length, 1);
    assert.equal(model.requestOutcomes[0].aborted, false);
    evidence.cases.push({ name: 'active-stream-four-natural-rotations', result: 'PASS', ...turn, initialExpiry, initialLease, completedAt: Date.now(), providerRequests: 1, sameSocket: true, ptyInputOutput: true });

    const observerGrant = await pair('observer');
    const expiringGrant = await pair('natural-lease-expiry');
    const expiringRpc = await connect(expiringGrant, 'natural-lease-expiry');
    const expiring = await start(expiringRpc, 'hold until actual family socket lease expires');
    await closed(expiringRpc);
    assert.ok(Date.now() >= expiringGrant.wsLeaseExpiresAt);
    assert.equal((await http('/api/servers', { grant: expiringGrant })).status, 401);
    await waitFor(() => model.requestOutcomes[expiring.requestNumber - 1].aborted, 5_000, 'expired SSE cancellation', 25, context.abortSignal);
    // Persistent refresh authority survives a short access/socket lease expiry.
    // It authorizes a new connection, never replays the interrupted turn.
    const recoveredGrant = await refresh(expiringGrant);
    const recovered = await connect(recoveredGrant, 'expired-device-recovered');
    const expiryReceipt = await interrupted(recovered, expiring);
    assert.equal((await receipt(recovered, expiring)).status, 'interrupted');
    assert.equal(model.requests.length, 2);
    evidence.cases.push({ name: 'natural-access-and-socket-lease-expiry', result: 'PASS', ...expiring, leaseExpiresAt: expiringGrant.wsLeaseExpiresAt, receipt: expiryReceipt.status, refreshRecoveredWithoutDispatch: true });

    let administrator = observerGrant;
    if (Date.now() >= administrator.expiresAt - 1_000) administrator = await refresh(administrator);
    const revokedGrant = await pair('durably-revoked');
    const revokedRpc = await connect(revokedGrant, 'durably-revoked');
    const revoked = await start(revokedRpc, 'hold until durable explicit revocation');
    const revokedAt = Date.now();
    assert.ok(revokedAt < revokedGrant.wsLeaseExpiresAt);
    assert.equal((await http(`/api/mobile/devices/${revokedGrant.deviceId}`, { method: 'DELETE', grant: administrator })).status, 204);
    await closed(revokedRpc);
    await waitFor(() => model.requestOutcomes[revoked.requestNumber - 1].aborted, 5_000, 'revoked SSE cancellation', 25, context.abortSignal);
    const revokedReceipt = await interrupted(recovered, revoked);
    assert.equal((await http('/api/mobile/session/refresh', { body: { refreshToken: revokedGrant.refreshToken, rotationId: randomUUID() } })).status, 401);
    assert.equal((await http('/api/servers', { grant: revokedGrant })).status, 401);
    assert.equal(model.requests.length, 3); assert.equal(starts, 3);
    evidence.cases.push({ name: 'durable-device-revocation', result: 'PASS', ...revoked, revokedBeforeLeaseExpiry: revokedAt < revokedGrant.wsLeaseExpiresAt, receipt: revokedReceipt.status });
    assert.equal((await hashExecutableFile(binary)).sha256, expectedSha);
    const processes = await findOwnedExecutableProcesses({ pgid: gateway.child.pid, executablePath: executable.path });
    assert.ok(processes.some(item => item.sha256 === expectedSha));
    evidence.processes = processes.map(({ pid, sha256 }) => ({ pid, sha256 }));
    evidence.providerRequests = model.requests.length; evidence.explicitTurnStarts = starts;
    evidence.result = 'PASS';
    return { actualGatewayRust: true, binarySha256: expectedSha, fourNaturalRotations: true, activeStreamCompleted: true,
      naturalExpiryAndRevokeInterrupted: true, providerRequests: 3, explicitTurnStarts: 3, realPtyInputOutput: true,
      externalModelGoalCronAutomationExcluded: true };
  } catch (error) { failure = error; evidence.result = 'FAIL'; evidence.error = context.redactText(error.message); throw error; }
  finally { try { await context.writeArtifactJson('active-stream-auth-renewal.json', evidence); }
    catch (error) { if (!failure) throw error; } }
});
