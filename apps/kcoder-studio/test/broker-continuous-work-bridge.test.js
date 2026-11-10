import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { createWorkspaceAppServerBridge } from '../src/workspace-app-server-bridge.mjs';

const capability = 'continuousWorkV1';
const noEphemeral = 'continuousWorkNoEphemeralV1';
const init = offer => ({ protocolVersion: '2026-07-27', clientInfo: { name: 'owned-bridge-test', version: '1' },
  capabilities: { experimental: offer ? { [capability]: true } : {} } });
const targetCapabilities = enabled => ({ protocolVersion: '2026-07-27', capabilities: { experimental: {
  residentThreads: true, ...(enabled ? { [capability]: true, [noEphemeral]: true } : {}),
} } });
const submit = { threadId: 'owned-thread', workId: 'work-1', inputId: 'input-1', requestId: 'request-1',
  expectedRevision: 2, text: 'continue the original work' };
const work = { workId: 'work-1', threadId: 'owned-thread', phase: 'running', revision: 2,
  requirementsRevision: 1, freshness: 'current', title: 'owned task' };

// Exercise the actual socket bridge and broker together; the target app-server
// is a controlled JSONL peer, not evidence that product work RPCs are enabled.
function fixture({ isolatedAccount = true } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, residentThreads: true, targetTransport: 'local',
    maxMessageBytes: 2 * 1024 * 1024, serverId: 'owned-target', adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  const upstream = []; let pending = '';
  child.stdin.on('data', chunk => {
    pending += chunk.toString('utf8');
    while (pending.includes('\n')) {
      const end = pending.indexOf('\n'); upstream.push(JSON.parse(pending.slice(0, end))); pending = pending.slice(end + 1);
    }
  });
  const socket = new EventEmitter();
  Object.assign(socket, { writable: true, destroyed: false, frames: [],
    write(raw) { this.frames.push(JSON.parse(String(raw))); return true; },
    pause() {}, resume() {}, isPaused: () => false,
    end() { this.writable = false; }, destroy() { this.destroyed = true; } });
  const target = { id: 'owned-target', runtime: 'kcoder', transport: 'local',
    ...(isolatedAccount ? { security: { mode: 'account' } } : {}) };
  const targets = new Map([[target.id, target]]);
  const session = { allowedServerIds: new Set([target.id]) };
  const auth = { active: true, generation: 1, principal: 'original-account' };
  const bridge = createWorkspaceAppServerBridge({ captureRetentionAuthority: () => null,
    mobileDeviceFamilies: new Map(), serversById: targets, workspaceBrokerKey: () => 'owned-broker',
    loginContexts: { identity: () => isolatedAccount ? { principalId: auth.principal } : null,
      generation: () => auth.generation }, mcpCallbacks: { create() {} }, maxMessageBytes: 2 * 1024 * 1024,
    frame: value => value, decodeFrames: value => ({ rest: Buffer.alloc(0), controls: [], messages: [value.toString()] }),
    WebSocketLivenessLease: class { start() {} stop() {} pong() {} }, scheduleWorkspaceBrokerIdle() {},
    serverHealthSignature: JSON.stringify, verifySession: (id, value) => id === 'owned-session' && value === session && auth.active,
  });
  bridge(socket, target, 'runtime', { broker, key: 'owned-broker' }, Buffer.alloc(0),
    'https://owned.invalid', 'owned-login', session, '/owned-workspace', 'owned-session');
  const client = [...broker.clients][0];
  const request = async (id, method, params) => {
    const before = upstream.length;
    socket.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params })));
    await new Promise(resolve => setImmediate(resolve));
    return upstream.length > before ? upstream.at(-1) : null;
  };
  const respond = async (id, result) => {
    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
    await new Promise(resolve => setImmediate(resolve));
  };
  const notify = async params => {
    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'work/changed', params })}\n`);
    await new Promise(resolve => setImmediate(resolve));
  };
  return { broker, child, socket, client, target, targets, session, auth, upstream, request, respond, notify,
    close() { socket.emit('close'); broker.clearTransientState(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); } };
}

async function initialize(f, offer = true, supported = true) {
  const request = await f.request('init', 'initialize', init(offer));
  await f.respond(request.id, targetCapabilities(supported));
}

async function start(f, id = 'owned-thread') {
  const request = await f.request('start', 'thread/start', {});
  await f.respond(request.id, { thread: { id } });
}

test('real bridge keeps ordinary sessions available when optional integrations are absent', async () => {
  const f = fixture({ isolatedAccount: false });
  try {
    // The target peer advertises no work capability, as the current product does.
    await initialize(f, false, false);
    assert.equal(Object.hasOwn(f.socket.frames.at(-1).result.capabilities.experimental, capability), false);
    await start(f);
    assert.equal(f.broker.threadOwners.get('owned-thread'), f.client);
    const turn = await f.request('turn', 'turn/start', { threadId: 'owned-thread', input: [{ type: 'text', text: 'hello' }] });
    assert.equal(turn.method, 'turn/start');
    await f.respond(turn.id, { turn: { id: 'turn-1', threadId: 'owned-thread' } });
    assert.equal(f.socket.frames.at(-1).result.turn.id, 'turn-1');
    assert.equal(await f.request('work', 'work/list', {}), null);
    assert.equal(f.socket.frames.at(-1).error.code, -32601);
  } finally { f.close(); }
});

test('real bridge uses authenticated socket ownership without requiring an integration module', async () => {
  const f = fixture({ isolatedAccount: false });
  try {
    // Only the controlled peer advertises the draft capability in this test.
    // No integrations or Office service is supplied to the real bridge.
    await initialize(f);
    assert.equal(f.socket.frames.at(-1).result.capabilities.experimental[capability], true);
    const list = await f.request('list', 'work/list', {});
    assert.equal(list.method, 'work/list');
    await f.respond(list.id, { items: [work] });
    assert.deepEqual(f.socket.frames.at(-1).result.items, [work]);
  } finally { f.close(); }
});

test('a forged native socket witness cannot authorize Work but does not block an ordinary session', async () => {
  const f = fixture({ isolatedAccount: false });
  try {
    await initialize(f);
    f.client.nativeRemoteSourceOwner = { verify() {} };
    assert.equal(await f.request('work', 'work/list', {}), null);
    assert.equal(f.socket.frames.at(-1).error.code, -32001);
    await start(f);
    assert.equal(f.broker.threadOwners.get('owned-thread'), f.client);
  } finally { f.close(); }
});

for (const change of ['session', 'target', 'account', 'generation', 'target-access']) {
  test(`real bridge rejects work after ${change} identity is revoked`, async () => {
    const f = fixture();
    try {
      await initialize(f);
      if (change === 'session') f.auth.active = false;
      if (change === 'target') f.targets.set(f.target.id, { ...f.target, command: 'replaced-target' });
      if (change === 'account') f.auth.principal = 'replacement-account';
      if (change === 'generation') f.auth.generation++;
      if (change === 'target-access') f.session.allowedServerIds.delete(f.target.id);
      assert.equal(await f.request('work', 'work/list', {}), null);
      assert.equal(f.socket.frames.at(-1).error.code, -32001);
    } finally { f.close(); }
  });
  test(`real bridge does not publish a late mutation receipt after ${change} revocation`, async () => {
    const f = fixture();
    try {
      await initialize(f);
      await start(f);
      const accepted = await f.request('submit', 'work/input/submit', submit);
      if (change === 'session') f.auth.active = false;
      if (change === 'target') f.targets.set(f.target.id, { ...f.target, command: 'replaced-target' });
      if (change === 'account') f.auth.principal = 'replacement-account';
      if (change === 'generation') f.auth.generation++;
      if (change === 'target-access') f.session.allowedServerIds.delete(f.target.id);
      await f.respond(accepted.id, { receipt: { threadId: 'owned-thread', workId: 'work-1', inputId: 'input-1',
        requestId: 'request-1', sequence: 1, state: 'accepted' } });
      assert.equal(f.socket.frames.at(-1).error?.code, -32034);
    } finally { f.close(); }
  });
}

test('real bridge never forwards a work input for its own temporary thread', async () => {
  const f = fixture();
  try {
    await initialize(f);
    await start(f);
    const fork = await f.request('fork', 'thread/fork', { threadId: 'owned-thread', ephemeral: true });
    await f.respond(fork.id, { thread: { id: 'temporary-thread' }, ephemeral: true });
    assert.equal(f.broker.ephemeralThreadOwners.get('temporary-thread'), f.client);
    assert.equal(await f.request('submit', 'work/input/submit', { ...submit, threadId: 'temporary-thread' }), null);
    assert.equal(f.socket.frames.at(-1).error.code, -32023);
  } finally { f.close(); }
});

test('a temporary thread cannot expose work to its owner even if a target violates its promise', async () => {
  const f = fixture();
  try {
    await initialize(f);
    await start(f);
    const fork = await f.request('fork', 'thread/fork', { threadId: 'owned-thread', ephemeral: true });
    await f.respond(fork.id, { thread: { id: 'temporary-thread' }, ephemeral: true });
    const read = await f.request('read', 'work/read', { workId: 'work-1' });
    await f.respond(read.id, { work: { ...work, threadId: 'temporary-thread' } });
    assert.equal(f.socket.frames.at(-1).result.work, null);
    const before = f.socket.frames.length;
    await f.notify({ workId: 'work-1', revision: 3, eventId: 'event-1' });
    assert.equal(f.socket.frames.length, before);
  } finally { f.close(); }
});

test('a late work receipt becomes unknown if the owned thread becomes temporary', async () => {
  const f = fixture();
  try {
    await initialize(f);
    await start(f);
    const accepted = await f.request('submit', 'work/input/submit', submit);
    const fork = await f.request('fork', 'thread/fork', { threadId: 'owned-thread', ephemeral: true });
    await f.respond(fork.id, { thread: { id: 'owned-thread' }, ephemeral: true });
    await f.respond(accepted.id, { receipt: { threadId: 'owned-thread', workId: 'work-1', inputId: 'input-1',
      requestId: 'request-1', sequence: 1, state: 'accepted' } });
    assert.equal(f.socket.frames.at(-1).error?.code, -32034);
  } finally { f.close(); }
});

test('cross-thread control needs the current client to own a non-temporary target thread', async () => {
  const f = fixture();
  try {
    await initialize(f);
    await start(f);
    const control = { threadId: 'owned-thread', workId: 'work-1', requestId: 'control-1', expectedRevision: 2,
      action: 'cancel_run', target: { kind: 'turn', threadId: 'other-thread', turnId: 'turn-2', attemptId: 'attempt-2' } };
    assert.equal(await f.request('foreign', 'work/control', control), null);
    assert.equal(f.socket.frames.at(-1).error.code, -32023);
    // This is only a Gateway ownership check. A future target must still prove
    // that both original threads belong to this work and that control is authorized.
    f.broker.threadOwners.set('other-thread', f.client);
    const forwarded = await f.request('owned', 'work/control', control);
    assert.equal(forwarded.method, 'work/control');
  } finally { f.close(); }
});

for (const change of ['owner', 'temporary']) {
  test(`cross-thread control receipt becomes unknown when target ${change} changes`, async () => {
    const f = fixture();
    try {
      await initialize(f);
      await start(f);
      f.broker.threadOwners.set('other-thread', f.client);
      const control = { threadId: 'owned-thread', workId: 'work-1', requestId: 'control-1', expectedRevision: 2,
        action: 'cancel_run', target: { kind: 'turn', threadId: 'other-thread', turnId: 'turn-2', attemptId: 'attempt-2' } };
      const forwarded = await f.request('control', 'work/control', control);
      if (change === 'owner') f.broker.threadOwners.set('other-thread', {});
      else f.broker.ephemeralThreadOwners.set('other-thread', f.client);
      await f.respond(forwarded.id, { workId: 'work-1', requestId: 'control-1', action: 'cancel_run',
        target: control.target, revision: 3, controlEpoch: 1, state: 'accepted' });
      assert.equal(f.socket.frames.at(-1).error?.code, -32034);
    } finally { f.close(); }
  });
}

test('delivery requirement remains an observation and conflicting result shapes are rejected', async () => {
  const f = fixture();
  try {
    await initialize(f);
    const base = { resultId: 'result-1', ready: true, artifactRefs: [] };
    for (const [label, result] of [
      ['legacy', base],
      ['null', { ...base, deliveryRequirement: null }],
      ['not-required', { ...base, deliveryRequirement: 'not_required' }],
      ['not-required-null-state', { ...base, deliveryRequirement: 'not_required', requiredDeliveryState: null }],
      ['required', { ...base, deliveryRequirement: 'required' }],
      ['required-unknown-state', { ...base, deliveryRequirement: 'required', requiredDeliveryState: 'future_state' }],
      ['unknown', { ...base, deliveryRequirement: 'unknown' }],
      ['future', { ...base, deliveryRequirement: 'future_delivery' }],
      ['empty-future', { ...base, deliveryRequirement: '' }],
      ['control-future', { ...base, deliveryRequirement: 'future\nlabel' }],
      ['bounded-future', { ...base, deliveryRequirement: `${'界'.repeat(85)}x` }],
    ]) {
      const request = await f.request(label, 'work/read', { workId: 'work-1' });
      await f.respond(request.id, { work: { ...work, result } });
      assert.deepEqual(f.socket.frames.at(-1).result.work.result, result, label);
    }
    for (const [label, value] of [
      ['conflict', { ...base, deliveryRequirement: 'not_required', requiredDeliveryState: 'confirmed' }],
      ['oversized', { ...base, deliveryRequirement: 'x'.repeat(257) }],
      ['wrong-type', { ...base, deliveryRequirement: 1 }],
    ]) {
      const request = await f.request(label, 'work/read', { workId: 'work-1' });
      await f.respond(request.id, { work: { ...work, result: value } });
      assert.equal(f.socket.frames.at(-1).error.code, -32603, label);
    }
  } finally { f.close(); }
});

test('invalid Work view identities, revisions and bounded text are not projected', async () => {
  const f = fixture();
  try {
    await initialize(f);
    const invalid = [
      { ...work, workId: 'bad/id' },
      { ...work, threadId: ' thread ' },
      { ...work, revision: 0 },
      { ...work, requirementsRevision: 0 },
      { ...work, title: '界'.repeat(171) },
      { ...work, title: 'line\nbreak' },
      { ...work, waiting: { kind: 'user', reference: '' } },
      { ...work, result: { resultId: ' bad ', ready: true, artifactRefs: [] } },
      { ...work, result: { resultId: 'result-1', ready: true, artifactRefs: Array(257).fill('artifact') } },
      { ...work, result: { resultId: 'result-1', ready: true, artifactRefs: [''] } },
    ];
    for (const [index, value] of invalid.entries()) {
      const request = await f.request(`invalid-${index}`, 'work/list', {});
      await f.respond(request.id, { items: [value] });
      assert.equal(f.socket.frames.at(-1).error?.code, -32603, `invalid view ${index}`);
    }
  } finally { f.close(); }
});

test('Work list rejects duplicate identities and invalid cursors but keeps future observations readable', async () => {
  const f = fixture();
  try {
    await initialize(f);
    for (const [label, result] of [
      ['duplicate', { items: [work, { ...work, threadId: 'other-thread' }] }],
      ['empty-cursor', { items: [], nextCursor: '' }],
      ['long-cursor', { items: [], nextCursor: 'x'.repeat(2049) }],
      ['control-cursor', { items: [], nextCursor: 'cursor\ninvalid' }],
    ]) {
      const request = await f.request(label, 'work/list', {});
      await f.respond(request.id, result);
      assert.equal(f.socket.frames.at(-1).error?.code, -32603, label);
    }
    const legacy = { ...work, phase: 'completed', freshness: 'future_freshness',
      waiting: { kind: 'user', reference: 'question-1' } };
    const future = { ...work, workId: 'work-2', phase: 'future_phase', freshness: 'future_freshness' };
    const request = await f.request('future', 'work/list', {});
    await f.respond(request.id, { items: [legacy, future] });
    assert.deepEqual(f.socket.frames.at(-1).result.items, [legacy, future]);
  } finally { f.close(); }
});

test('Work read applies the same shape checks and preserves boundary-sized titles', async () => {
  const f = fixture();
  try {
    await initialize(f);
    for (const [label, value] of [
      ['zero-revision', { ...work, revision: 0 }],
      ['zero-requirements', { ...work, requirementsRevision: 0 }],
      ['invalid-wait', { ...work, waiting: { kind: 'event', reference: '\u0000' } }],
      ['invalid-result', { ...work, result: { resultId: '', ready: true, artifactRefs: [] } }],
    ]) {
      const request = await f.request(label, 'work/read', { workId: 'work-1' });
      await f.respond(request.id, { work: value });
      assert.equal(f.socket.frames.at(-1).error?.code, -32603, label);
    }
    const valid = { ...work, title: `${'界'.repeat(170)}aa`,
      result: { resultId: 'result-1', ready: false, artifactRefs: Array(256).fill('artifact') } };
    const request = await f.request('boundary', 'work/read', { workId: 'work-1' });
    await f.respond(request.id, { work: valid });
    assert.deepEqual(f.socket.frames.at(-1).result.work, valid);
  } finally { f.close(); }
});
