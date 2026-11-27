import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { gatewayRequestCounts, observeGatewayRequests, createModelCatalogReadSampler, summarizeReadDomains } from './gateway-request-counts.mjs';

test('domain counters count wire requests once, preserve unknown traffic, and keep auth inspections separate', () => {
  const report = summarizeReadDomains([{ name: 'warm', status: 'passed',
    http: { 'GET /api/servers': 1, 'POST /api/servers/owned/account': 1, 'GET /api/channels': 1, 'GET /api/unknown': 2 },
    rpcRequests: { 'thread/list': 1, 'turn/start': 1, 'tools/catalog': 1, 'runtime.models.list': 1, 'unknown/method': 2 },
    rpc: { initialized: 100 }, notifications: { 'turn/completed': 100 },
    responses: { fetch: 100 }, reusedGatewayResponseHeaders: { fetch: 99 }, auth: { started: 4 },
    firstScreen: { kind: 'warm-navigation', composerEditableMs: 123 },
  }]);
  assert.deepEqual(report.totals.devices, { http: 1, rpc: 0 });
  assert.deepEqual(report.totals.authentication, { http: 1, rpc: 0 });
  assert.deepEqual(report.totals.sessions, { http: 0, rpc: 2 });
  assert.deepEqual(report.totals.tools, { http: 0, rpc: 1 });
  assert.deepEqual(report.totals.configuration, { http: 0, rpc: 1 });
  assert.deepEqual(report.totals.other, { http: 2, rpc: 2 });
  assert.equal(Object.values(report.totals).reduce((sum, row) => sum + row.http, 0), 5);
  assert.equal(Object.values(report.totals).reduce((sum, row) => sum + row.rpc, 0), 6);
  assert.equal(report.phases[0].browserSessionInspections, 4);
  assert.equal(report.phases[0].firstScreen.composerEditableMs, 123);
  assert.equal(report.rpcRequestsObserved, true);
  assert.equal(summarizeReadDomains([{ rpc: { initialized: 1 } }]).rpcRequestsObserved, false);
  assert.throws(() => summarizeReadDomains([{ rpcRequests: { 'thread/read': -1 } }]), /Invalid request counter/);
});

test('experience probes and uploads have their own domain without being labelled read-only', () => {
  const report = summarizeReadDomains([{ name: 'experience', http: {
    'GET /api/experience/conversations': 3, 'POST /api/experience/events': 2,
  } }]);
  assert.deepEqual(report.totals.experience, { http: 5, rpc: 0 });
  assert.deepEqual(report.totals.other, { http: 0, rpc: 0 });
});

test('auth call totals include coalesced callers and leave old phase evidence unobserved', () => {
  const report = summarizeReadDomains([
    { name: 'current', auth: { queued: 2, coalesced: 5, started: 2 } },
    { name: 'legacy', auth: { started: 2 } },
  ]);
  assert.equal(report.phases[0].browserSessionReadCalls, 7);
  assert.equal(report.phases[0].browserSessionCoalescedReads, 5);
  assert.equal(report.phases[1].browserSessionReadCalls, undefined);
  assert.equal(report.phases[1].browserSessionCoalescedReads, undefined);
});

test('catalog trace correlates scope across connections without retaining params in evidence', () => {
  const sample = createModelCatalogReadSampler();
  const original = { deviceId: 'private-device', workspacePath: '/private-workspace', taskId: 'private-task', includeHidden: false };
  const a = sample(original), b = sample({ ...original, token: 'private-secret' });
  assert.deepEqual(a, { scopeOrdinal: 1, explicitDevice: true, explicitWorkspace: true, explicitTask: true, threadBound: false });
  assert.deepEqual(b, a);
  const thread = sample({ ...original, threadId: 'private-thread' });
  assert.equal(thread.threadBound, true); assert.notEqual(thread.scopeOrdinal, a.scopeOrdinal);
  for (const change of [{ deviceId: 'next' }, { taskId: 'next' }, { workspacePath: '/next' }, { includeHidden: true }])
    assert.notEqual(sample({ ...original, ...change }).scopeOrdinal, a.scopeOrdinal);
  assert.equal(JSON.stringify([a, b, thread]).includes('private'), false);
});

test('catalog trace reports invalid identities and capacity overflow without merging scopes', () => {
  const sample = createModelCatalogReadSampler();
  for (const value of [null, false, []]) assert.equal(sample(value), undefined);
  for (const value of [123, [], {}, 'a'.repeat(4097)])
    assert.equal(sample({ taskId: value }), undefined);
  assert.equal(sample({ includeHidden: 'false' }), undefined);
  for (let i = 0; i < 128; i++) sample({ taskId: String(i) });
  assert.equal(sample({ taskId: '0' }).scopeOrdinal, 1);
  assert.equal(sample({ taskId: 'overflow' }), undefined);
});

function mockObservationPage() {
  const session = new EventEmitter();
  session.send = async () => {};
  session.detach = async () => {};
  return { session, page: { context: () => ({ newCDPSession: async () => session }) } };
}
const observeDirectory = async (context, page, origin, currentPhase) => (await observeGatewayRequests(context, page, origin, () => {
  const phase = currentPhase();
  return phase ? { ...gatewayRequestCounts(), ...phase } : phase;
})).directoryReads;

test('resource events and reused Gateway response headers are counted separately across reloads', async () => {
  const { page, session } = mockObservationPage(), cleanups = [];
  let phase = gatewayRequestCounts(); const cold = phase;
  const { validate } = await observeGatewayRequests({ addCleanup: (_, close) => cleanups.push(close) }, page, 'http://owned.test', () => phase);
  const id = '12345678-1234-1234-1234-123456789abc';
  const request = { requestId: 'owned-request', type: 'Script', request: { url: 'http://owned.test/assets/entry-1234ABCD.js?token=must-not-retain', method: 'GET' } };
  const response = { requestId: request.requestId, response: { headers: { 'X-Request-Id': id, 'Cache-Control': 'public, immutable' }, status: 200 } };
  session.emit('Network.requestWillBeSent', request);
  session.emit('Network.responseReceived', response); session.emit('Network.responseReceived', response);
  session.emit('Network.loadingFinished', { requestId: request.requestId });
  phase = gatewayRequestCounts();
  session.emit('Network.requestWillBeSent', request); session.emit('Network.responseReceived', response);
  assert.deepEqual(cold.resources, { script: 1 }); assert.deepEqual(cold.responses, { script: 2 });
  assert.deepEqual(cold.firstSeenGatewayResponses, { script: 1 }); assert.deepEqual(cold.reusedGatewayResponseHeaders, { script: 1 });
  assert.deepEqual(phase.firstSeenGatewayResponses, {}); assert.deepEqual(phase.reusedGatewayResponseHeaders, { script: 1 });
  const shared = { ...request, request: { ...request.request, url: 'http://owned.test/assets/workbench~index-1234ABCD.js?token=must-not-retain' } };
  session.emit('Network.requestWillBeSent', shared); session.emit('Network.responseReceived', response);
  assert.equal(phase.assets['/assets/workbench~index-1234ABCD.js'].responses, 1);
  assert.equal(JSON.stringify([cold, phase]).includes(id), false);
  assert.equal(JSON.stringify([cold, phase]).includes('token'), false);
  validate(); await cleanups.pop()(); assert.equal(session.listenerCount('Network.requestWillBeSent'), 0);
});

test('unknown response identity remains unknown, and cross-origin traffic is excluded', async () => {
  const { page, session } = mockObservationPage(), phase = gatewayRequestCounts();
  const { validate } = await observeGatewayRequests({ addCleanup() {} }, page, 'http://owned.test', () => phase);
  for (const origin of ['http://other.test', 'http://owned.test']) {
    session.emit('Network.requestWillBeSent', { requestId: origin, type: 'Fetch', request: { url: `${origin}/api/servers?private=value`, method: 'GET' } });
    session.emit('Network.responseReceived', { requestId: origin, response: { headers: {}, status: 401 } });
  }
  assert.deepEqual(phase.http, { 'GET /api/servers': 1 });
  assert.deepEqual(phase.missingGatewayResponseHeaders, { fetch: 1 });
  assert.deepEqual(phase.statuses, { 401: 1 }); validate();
});

test('directory initiators retain compiled source locations without credentials and detach their owned session', async () => {
  const session = new EventEmitter(), cleanups = [];
  let detached = false;
  session.send = async () => {}; session.detach = async () => { detached = true; };
  const page = { context: () => ({ newCDPSession: async () => session }) };
  const result = await observeDirectory({ addCleanup: (_, close) => cleanups.push(close) }, page,
    'http://owned.test', () => ({ name: 'startup' }));
  const frame = { url: 'http://owned.test/assets/gatewayRpc~workbench-1234ABCD.js?token=private', functionName: 'readGatewayServers', lineNumber: 4, columnNumber: 20 };
  session.emit('Network.requestWillBeSent', { requestId: 'private-id', request: { method: 'GET', url: 'http://owned.test/api/servers?token=private' },
    initiator: { stack: { callFrames: [frame, { ...frame, url: 'https://other.test/private/file.js' }] } } });
  session.emit('Network.responseReceived', { requestId: 'private-id', response: { status: 200, headers: { Cookie: 'private' } } });
  assert.equal(result.requests.length, 1); assert.equal(result.requests[0].status, 200);
  assert.deepEqual(result.requests[0].initiator, [{ source: '/assets/gatewayRpc~workbench-1234ABCD.js', functionName: 'readGatewayServers', line: 5, column: 21 }]);
  assert.equal(JSON.stringify(result).includes('private'), false);
  for (const url of ['https://other.test/api/servers', 'http://owned.test/api/servers/status'])
    session.emit('Network.requestWillBeSent', { request: { method: 'GET', url } });
  assert.equal(result.requests.length, 1);
  await cleanups.pop()(); assert.equal(detached, true); assert.equal(session.listenerCount('Network.requestWillBeSent'), 0);
});

test('directory initiator capacity is explicit rather than silently dropping observations', async () => {
  const session = new EventEmitter(); session.send = async () => {}; session.detach = async () => {};
  const result = await observeDirectory({ addCleanup() {} }, { context: () => ({ newCDPSession: async () => session }) },
    'http://owned.test', () => null);
  for (let i = 0; i < 129; i++) session.emit('Network.requestWillBeSent', {
    requestId: i, request: { method: 'GET', url: 'http://owned.test/api/servers' },
  });
  assert.equal(result.requests.length, 128); assert.equal(result.overflow, 1);
});

test('bounded directory stacks include callers beyond the shared transport wrappers', async () => {
  const session = new EventEmitter(); session.send = async () => {}; session.detach = async () => {};
  const result = await observeDirectory({ addCleanup() {} }, { context: () => ({ newCDPSession: async () => session }) },
    'http://owned.test', () => null);
  session.emit('Network.requestWillBeSent', { requestId: 'owned', request: { method: 'GET', url: 'http://owned.test/api/servers' },
    initiator: { stack: { callFrames: Array.from({ length: 20 }, (_, index) => ({
      url: 'http://owned.test/assets/runtime-1234ABCD.js', functionName: `caller${index}`, lineNumber: index, columnNumber: 0,
    })) } } });
  assert.equal(result.requests[0].initiator.length, 12);
  assert.equal(result.requests[0].initiator[11].functionName, 'caller11');
});


test('directory observer cleanup accepts an already closed page but preserves live detach failures', async () => {
  for (const closed of [true, false]) {
    const session = new EventEmitter(), cleanups = [];
    session.send = async () => {};
    session.detach = async () => { throw new Error('detach failed'); };
    const page = { isClosed: () => closed, context: () => ({ newCDPSession: async () => session }) };
    await observeDirectory({ addCleanup: (_, close) => cleanups.push(close) }, page,
      'http://owned.test', () => null);
    if (closed) await assert.doesNotReject(cleanups.pop()());
    else await assert.rejects(cleanups.pop()(), /detach failed/);
    assert.equal(session.listenerCount('Network.requestWillBeSent'), 0);
    assert.equal(session.listenerCount('Network.responseReceived'), 0);
  }
});

test('health observations retain document ownership and header/body cancellation across phases without private identities', async () => {
  const session = new EventEmitter(), cleanup = [];
  session.send = async () => {}; session.detach = async () => {};
  let phase = 'migration';
  const result = await observeDirectory({ addCleanup: (_, close) => cleanup.push(close) },
    { context: () => ({ newCDPSession: async () => session }), isClosed: () => false }, 'http://owned.test', () => ({ name: phase }));
  const request = (id, path, loaderId) => session.emit('Network.requestWillBeSent', {
    requestId: id, loaderId, request: { method: 'GET', url: `http://owned.test${path}?token=private` },
  });
  request('private-directory', '/api/servers', 'private-loader-before');
  request('private-health', '/api/servers/status', 'private-loader-before');
  session.emit('Network.responseReceived', { requestId: 'private-health', response: { status: 200 } });
  phase = 'tools';
  session.emit('Network.loadingFailed', { requestId: 'private-health', canceled: true, errorText: 'private' });
  session.emit('Network.loadingFinished', { requestId: 'private-directory' });
  request('private-current', '/api/servers/status', 'private-loader-after');
  session.emit('Network.responseReceived', { requestId: 'private-current', response: { status: 200 } });
  session.emit('Network.loadingFinished', { requestId: 'private-current' });
  assert.equal(result.requests[0].documentOrdinal, 1);
  assert.equal(result.requests[0].completedPhase, 'tools');
  assert.equal(result.healthRequests.length, 2);
  assert.deepEqual(result.healthRequests.map(row => [row.documentOrdinal, row.phase, row.status, row.outcome, row.completedPhase]),
    [[1, 'migration', 200, 'cancelled', 'tools'], [2, 'tools', 200, 'completed', 'tools']]);
  assert.equal(JSON.stringify(result).includes('private'), false);
  await cleanup.pop()();
  for (const name of ['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed'])
    assert.equal(session.listenerCount(name), 0);
});

test('health initiator capacity is bounded independently from the existing directory samples', async () => {
  const session = new EventEmitter(); session.send = async () => {}; session.detach = async () => {};
  const result = await observeDirectory({ addCleanup() {} },
    { context: () => ({ newCDPSession: async () => session }) }, 'http://owned.test', () => null);
  for (let i = 0; i < 129; i++) session.emit('Network.requestWillBeSent', {
    requestId: i, loaderId: `private-${i}`, request: { method: 'GET', url: 'http://owned.test/api/servers/status' },
  });
  assert.equal(result.healthRequests.length, 128);
  assert.equal(result.overflow, 1);
  assert.equal(result.requests.length, 0);
});

test('redirect responses and late completion preserve original owners without duplicate HTTP requests', async () => {
  const { page, session } = mockObservationPage();
  const first = { name: 'original', ...gatewayRequestCounts() };
  let phase = first;
  const { validate, directoryReads } = await observeGatewayRequests({ addCleanup() {} }, page, 'http://owned.test', () => phase);
  const request = url => session.emit('Network.requestWillBeSent', { requestId: 'private', type: 'Fetch',
    request: { method: 'GET', url }, ...(url.endsWith('/status') ? { redirectResponse: { status: 302, headers: {} } } : {}) });
  request('http://owned.test/api/servers');
  phase = { name: 'next', ...gatewayRequestCounts() };
  request('http://owned.test/api/servers/status');
  session.emit('Network.responseReceived', { requestId: 'private', response: { status: 200, headers: {} } });
  session.emit('Network.loadingFinished', { requestId: 'private' });
  session.emit('Network.responseReceived', { requestId: 'private', response: { status: 503, headers: {} } });
  assert.deepEqual(first.http, { 'GET /api/servers': 1 });
  assert.deepEqual(first.statuses, { 302: 1 });
  assert.deepEqual(phase.http, { 'GET /api/servers/status': 1 });
  assert.deepEqual(phase.statuses, { 200: 1 });
  assert.equal(directoryReads.requests[0].outcome, 'redirected');
  assert.equal(directoryReads.requests[0].phase, 'original');
  assert.equal(directoryReads.healthRequests[0].outcome, 'completed');
  validate();
});

test('network failure retires pending ownership and observation overflow fails validation', async () => {
  const { page, session } = mockObservationPage();
  const phase = { name: 'owned', ...gatewayRequestCounts() };
  const { validate } = await observeGatewayRequests({ addCleanup() {} }, page, 'http://owned.test', () => phase);
  const request = id => session.emit('Network.requestWillBeSent', { requestId: id, type: 'Fetch', request: { method: 'GET', url: 'http://owned.test/api/owned' } });
  request('failed');
  session.emit('Network.loadingFailed', { requestId: 'failed', canceled: true });
  session.emit('Network.responseReceived', { requestId: 'failed', response: { status: 200, headers: {} } });
  assert.deepEqual(phase.responses, {});
  for (let index = 0; index <= 32768; index++) request(index);
  assert.throws(validate, /pending observation capacity exceeded/);
});


test('expert scope, imported-memory, MCP and marketplace operations belong to target configuration', () => {
  const methods = { 'agentDefinitions/scope/read': 2, 'migration/memory/list': 2, 'mcp/list': 1, 'marketplace/list': 1 }
  const report = summarizeReadDomains([{ name: 'target-configuration', rpcRequests: methods }])
  assert.deepEqual(report.totals.configuration, { http: 0, rpc: 6 })
  assert.deepEqual(report.totals.other, { http: 0, rpc: 0 })
  assert.deepEqual(summarizeReadDomains([{ rpcRequests: { 'mcp/apps/read': 1, 'mcp/future-method': 1 } }]).totals.other,
    { http: 0, rpc: 2 })
})
