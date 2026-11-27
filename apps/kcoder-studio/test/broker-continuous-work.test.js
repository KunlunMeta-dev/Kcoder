import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { captureNativeRemoteSourceClient } from '../src/remotes/source-client-owner.mjs';
import { knownValues } from '../shared/generated/validator.mjs';

const cap = 'continuousWorkV1';
const readCap = 'continuousWorkReadV1';
const partialCap = 'continuousWorkPartialListV1';
const noEphemeral = 'continuousWorkNoEphemeralV1';
const inputCap = 'continuousWorkInputV1';
const controlCap = 'continuousWorkControlV1';
const init = offer => ({ protocolVersion: '2026-07-27', clientInfo: { name: 'continuous-work-test', version: '1' },
  capabilities: { experimental: offer === undefined ? {} : { [cap]: offer } } });
const initialized = (supported, safe = supported) => ({ protocolVersion: '2026-07-27',
  capabilities: { experimental: { residentThreads: true, ...(supported ? { [cap]: true } : {}),
    ...(safe ? { [noEphemeral]: true } : {}) } } });
const work = { workId: 'work-1', threadId: 'thread-1', phase: 'running', revision: 2,
  requirementsRevision: 1, freshness: 'current', title: 'Example' };
const submit = { threadId: 'thread-1', workId: 'work-1', inputId: 'input-1', requestId: 'request-1',
  expectedRevision: 2, text: 'Continue the work' };

test('Gateway capability names follow the generated Rust wire contract', async () => {
  assert.deepEqual(knownValues.ContinuousWorkCapability, [cap, readCap, partialCap, noEphemeral, inputCap, controlCap]);
  const f = fixture();
  try {
    const owner = f.client('read-only');
    const params = init(false);
    params.capabilities.experimental[readCap] = true;
    const upstream = await f.request(owner, 'init', 'initialize', params);
    const backend = initialized(false, false);
    backend.capabilities.experimental[readCap] = true;
    await f.respond(upstream.id, { result: backend });
    assert.equal(owner.messages.at(-1).result.capabilities.experimental[readCap], true);
    const read = await f.request(owner, 'read', 'work/read', { workId: 'work-1' });
    await f.respond(read.id, { result: { work, presence: 'present' } });
    assert.equal(owner.messages.at(-1).result.work.workId, 'work-1');
    assert.equal(await f.request(owner, 'control', 'work/control', { ...submit, action: 'stop', target: { kind: 'work' } }), null);
    assert.equal(owner.messages.at(-1).error.code, -32601);
  } finally { f.broker.clearTransientState(); }
});

function fixture(transport = 'local') {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, residentThreads: true, targetTransport: transport,
    remotePlatform: transport === 'ssh' ? 'linux' : undefined, maxMessageBytes: 2 * 1024 * 1024,
    serverId: 'continuous-work-test', adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  const requests = []; let buffer = '';
  child.stdin.on('data', chunk => {
    buffer += chunk.toString('utf8');
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'); requests.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1);
    }
  });
  const client = owner => {
    let active = true;
    const value = { channel: 'runtime', authorizationOwner: owner, messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(value);
    const target = { id: 'fixture-target', runtime: 'kcoder', transport };
    value.nativeRemoteSourceOwner = captureNativeRemoteSourceClient({ client: value, broker, sourceTarget: target,
      authorizationOwner: owner, session: { allowedServerIds: new Set([target.id]) }, verifySession: () => active,
      getTarget: id => id === target.id ? target : null, targetSignature: candidate => JSON.stringify(candidate),
      accountIdentity: () => null, accountGeneration: () => 1 });
    value.revoke = () => { active = false; };
    return value;
  };
  const request = async (owner, id, method, params) => {
    const before = requests.length;
    broker.receive(owner, JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }));
    await new Promise(resolve => setImmediate(resolve));
    return requests.length > before ? requests.at(-1) : null;
  };
  const respond = async (id, payload) => {
    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...payload })}\n`);
    await new Promise(resolve => setImmediate(resolve));
  };
  const notify = async (params) => {
    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'work/changed', params })}\n`);
    await new Promise(resolve => setImmediate(resolve));
  };
  return { broker, requests, client, request, respond, notify };
}

for (const transport of ['local', 'ssh']) {
  test(`${transport}: old target does not receive work RPCs and does not acquire a fake capability`, async () => {
    const f = fixture(transport);
    try {
      const owner = f.client('owner');
      const upstream = await f.request(owner, 'init', 'initialize', init(true));
      assert.equal(upstream.params.capabilities.experimental[cap], true);
      assert.equal(upstream.params.capabilities.experimental[noEphemeral], true);
      await f.respond(upstream.id, { result: initialized(false) });
      assert.equal(Object.hasOwn(owner.messages.at(-1).result.capabilities.experimental, cap), false);
      assert.equal(await f.request(owner, 'list', 'work/list', {}), null);
      assert.equal(owner.messages.at(-1).error.code, -32601);
      const count = f.requests.length;
      await f.request(owner, undefined, 'work/control', { ...submit, action: 'stop', target: { kind: 'work' } });
      assert.equal(f.requests.length, count, 'id-less operations cannot be forwarded');
    } finally { f.broker.clearTransientState(); }
  });
}

test('a target without the no-ephemeral-binding guarantee cannot expose continuous work', async () => {
  const f = fixture();
  try {
    const owner = f.client('owner');
    const upstream = await f.request(owner, 'init', 'initialize', init(true));
    await f.respond(upstream.id, { result: initialized(true, false) });
    assert.equal(owner.messages.at(-1).result.capabilities.experimental[cap], false);
    assert.equal(await f.request(owner, 'list', 'work/list', {}), null);
    assert.equal(owner.messages.at(-1).error.code, -32601);
  } finally { f.broker.clearTransientState(); }
});

test('negotiation and change observations stay per client and disappear on detach', async () => {
  const f = fixture();
  try {
    const reader = f.client('owner-a'), peer = f.client('owner-b'), legacy = f.client('owner-c');
    const readerInit = init(true);
    readerInit.capabilities.experimental[readCap] = true;
    readerInit.capabilities.experimental[partialCap] = true;
    const upstream = await f.request(reader, 'reader-init', 'initialize', readerInit);
    const backend = initialized(true);
    backend.capabilities.experimental[readCap] = true;
    backend.capabilities.experimental[partialCap] = true;
    await f.respond(upstream.id, { result: backend });
    await f.request(peer, 'peer-init', 'initialize', init(true));
    await f.request(legacy, 'legacy-init', 'initialize', init(false));
    assert.equal(reader.messages.at(-1).result.capabilities.experimental[cap], true);
    assert.equal(Object.hasOwn(reader.messages.at(-1).result.capabilities.experimental, noEphemeral), false);
    assert.equal(peer.messages.at(-1).result.capabilities.experimental[cap], true);
    assert.equal(legacy.messages.at(-1).result.capabilities.experimental[cap], false);
    assert.equal(await f.request(legacy, 'legacy-list', 'work/list', {}), null);
    assert.equal(legacy.messages.at(-1).error.code, -32601);

    const list = await f.request(reader, 'list', 'work/list', { allowPartial: true });
    await f.respond(list.id, { result: { items: [{ ...work, privateClaim: 'private', result: {
      resultId: 'r', ready: true, artifactRefs: [], secret: 'private',
    } }], partial: true, privateIndex: 'private' } });
    const projected = reader.messages.at(-1).result;
    assert.equal(projected.partial, true);
    assert.equal(projected.privateIndex, undefined);
    assert.equal(projected.items[0].privateClaim, undefined);
    assert.equal(projected.items[0].result.secret, undefined);
    assert.equal(await f.request(peer, 'peer-opt-in', 'work/list', { allowPartial: true }), null);
    assert.equal(peer.messages.at(-1).error.code, -32602);
    const oldList = await f.request(peer, 'peer-partial', 'work/list', {});
    await f.respond(oldList.id, { result: { items: [work], partial: true } });
    assert.equal(peer.messages.at(-1).error.code, -32603);
    const beforeReader = reader.messages.length, beforePeer = peer.messages.length;
    await f.notify({ workId: 'work-1', revision: 3, eventId: 'event-1', secret: 'private' });
    assert.equal(reader.messages.length, beforeReader + 1);
    assert.deepEqual(reader.messages.at(-1).params, { workId: 'work-1', revision: 3, eventId: 'event-1' });
    assert.equal(peer.messages.length, beforePeer, 'unobserved peer must not receive another client event');
    const read = await f.request(peer, 'read', 'work/read', { workId: 'work-1' });
    await f.respond(read.id, { result: { work } });
    const peerBefore = peer.messages.length;
    await f.notify({ workId: 'work-1', revision: 4, eventId: 'event-2' });
    assert.equal(peer.messages.length, peerBefore + 1);
    f.broker.detach(reader);
    const replacement = f.client('owner-a');
    await f.request(replacement, 'reinit', 'initialize', init(true));
    const replacementBefore = replacement.messages.length;
    await f.notify({ workId: 'work-1', revision: 5, eventId: 'event-3' });
    assert.equal(replacement.messages.length, replacementBefore, 'detached observation must not transfer to a new connection');
  } finally { f.broker.clearTransientState(); }
});

test('an observation is registered only when its response was actually queued', async () => {
  const f = fixture();
  try {
    const owner = f.client('owner-a');
    const upstream = await f.request(owner, 'init', 'initialize', init(true));
    await f.respond(upstream.id, { result: initialized(true) });
    owner.sendWithQueueStatus = () => ({ queued: false, writable: false });
    const undelivered = await f.request(owner, 'unwritable', 'work/read', { workId: 'work-1' });
    await f.respond(undelivered.id, { result: { work } });
    const before = owner.messages.length;
    await f.notify({ workId: 'work-1', revision: 3, eventId: 'event-1' });
    assert.equal(owner.messages.length, before, 'unwritable socket was never given the observation');
    owner.sendWithQueueStatus = message => {
      owner.messages.push(message);
      return { queued: true, writable: false };
    };
    const buffered = await f.request(owner, 'backpressure', 'work/read', { workId: 'work-1' });
    await f.respond(buffered.id, { result: { work } });
    const afterBuffered = owner.messages.length;
    await f.notify({ workId: 'work-1', revision: 4, eventId: 'event-2' });
    assert.equal(owner.messages.length, afterBuffered + 1, 'queued response remains observable under backpressure');
  } finally { f.broker.clearTransientState(); }
});

test('read presence distinguishes proven absence, unreadability, and legacy unknown', async () => {
  const f = fixture();
  try {
    const owner = f.client('owner-a');
    const upstream = await f.request(owner, 'init', 'initialize', init(true));
    await f.respond(upstream.id, { result: initialized(true) });
    for (const presence of ['confirmed_absent', 'unreadable', 'unknown', 'future_observation']) {
      const request = await f.request(owner, presence, 'work/read', { workId: 'work-1' });
      await f.respond(request.id, { result: { work: null, presence } });
      assert.equal(owner.messages.at(-1).result.presence, presence);
    }
    const legacy = await f.request(owner, 'legacy', 'work/read', { workId: 'work-1' });
    await f.respond(legacy.id, { result: { work: null } });
    assert.equal(owner.messages.at(-1).result.presence, undefined);
    const bad = await f.request(owner, 'contradiction', 'work/read', { workId: 'work-1' });
    await f.respond(bad.id, { result: { work: null, presence: 'present' } });
    assert.equal(owner.messages.at(-1).error.code, -32603);
  } finally { f.broker.clearTransientState(); }
});

test('only the owner can submit and receipts cannot be misattributed or replayed with another identity', async () => {
  const f = fixture();
  try {
    const owner = f.client('owner-a'), peer = f.client('owner-b');
    const upstream = await f.request(owner, 'init', 'initialize', init(true));
    await f.respond(upstream.id, { result: initialized(true) });
    await f.request(peer, 'peer-init', 'initialize', init(true));
    f.broker.threadOwners.set('thread-1', owner);
    assert.equal(await f.request(peer, 'peer-submit', 'work/input/submit', submit), null);
    assert.equal(peer.messages.at(-1).error.code, -32023);
    assert.equal(await f.request(owner, 'forged', 'work/input/submit', { ...submit, authority: 'forged' }), null);
    assert.equal(owner.messages.at(-1).error.code, -32602);
    const staleWorkflow = { threadId: 'thread-1', workId: 'work-1', requestId: 'control-1', expectedRevision: 2,
      action: 'cancel_run', target: { kind: 'workflow', threadId: 'thread-1', runId: 'run-1', revision: 0, resumeCount: 0 } };
    assert.equal(await f.request(owner, 'workflow-zero', 'work/control', staleWorkflow), null);
    assert.equal(owner.messages.at(-1).error.code, -32602);
    const retention = { references: [{ retentionId: `r1.root.1.${'a'.repeat(32)}`, expectedRevision: 1, entryIds: ['entry'] }],
      attachments: [{ entryId: 'entry', filename: 'a.txt', mimeType: 'text/plain' }] };
    assert.equal(await f.request(owner, 'attachment', 'work/input/submit', { ...submit, retention }), null);
    assert.equal(owner.messages.at(-1).error.code, -32601);

    const accepted = await f.request(owner, 'submit', 'work/input/submit', submit);
    assert.equal(accepted.params.inputId, submit.inputId);
    assert.equal(accepted.params.requestId, submit.requestId);
    await f.respond(accepted.id, { result: { receipt: { threadId: 'thread-1', workId: 'work-1', inputId: 'input-1',
      requestId: 'request-1', sequence: 1, state: 'queued', privatePayload: 'private' } } });
    assert.equal(owner.messages.at(-1).result.receipt.state, 'queued');
    assert.equal(owner.messages.at(-1).result.receipt.privatePayload, undefined);
    const retry = await f.request(owner, 'retry', 'work/input/submit', submit);
    assert.equal(retry.params.requestId, 'request-1');
    await f.respond(retry.id, { result: { receipt: { threadId: 'thread-1', workId: 'work-1', inputId: 'input-1',
      requestId: 'different-request', sequence: 1, state: 'applied' } } });
    assert.equal(owner.messages.at(-1).error.code, -32034);
    const missing = await f.request(owner, 'missing', 'work/input/submit', submit);
    await f.respond(missing.id, { result: { receipt: null } });
    assert.equal(owner.messages.at(-1).error.code, -32034, 'submission without acceptance receipt is unknown');
    const fabricated = await f.request(owner, 'fabricated', 'work/input/submit', submit);
    await f.respond(fabricated.id, { result: { receipt: { threadId: 'thread-1', workId: 'work-1', inputId: 'input-1',
      requestId: 'request-1', sequence: 1, state: 'accepted', interaction: { attemptId: 'attempt-1', selector: {
        serverId: 'server-1', threadId: 'thread-1', turnId: 'turn-1', requestId: 1,
        appServerEpoch: 'epoch-1', kind: 'question', questionId: 'question-1',
      } } } } });
    assert.equal(owner.messages.at(-1).error.code, -32034, 'the backend may not introduce a question association');
  } finally { f.broker.clearTransientState(); }
});

test('ephemeral works never cross their owning client through list, read or events', async () => {
  const f = fixture();
  try {
    const owner = f.client('owner-a'), peer = f.client('owner-b');
    const upstream = await f.request(owner, 'init', 'initialize', init(true));
    await f.respond(upstream.id, { result: initialized(true) });
    await f.request(peer, 'peer-init', 'initialize', init(true));
    const ephemeral = { ...work, workId: 'private-work', threadId: 'private-thread', title: 'private-title' };
    f.broker.ephemeralThreadOwners.set('private-thread', owner);
    const list = await f.request(peer, 'peer-list', 'work/list', {});
    await f.respond(list.id, { result: { items: [work, ephemeral] } });
    assert.deepEqual(peer.messages.at(-1).result.items.map(item => item.workId), ['work-1']);
    const read = await f.request(peer, 'peer-read', 'work/read', { workId: 'private-work' });
    await f.respond(read.id, { result: { work: ephemeral } });
    assert.equal(peer.messages.at(-1).result.work, null);
    const before = peer.messages.length;
    await f.notify({ workId: 'private-work', revision: 3, eventId: 'event' });
    assert.equal(peer.messages.length, before);
    const ownRead = await f.request(owner, 'own-read', 'work/read', { workId: 'private-work' });
    await f.respond(ownRead.id, { result: { work: ephemeral } });
    assert.equal(owner.messages.at(-1).result.work, null, 'temporary work is not exposed even to its thread owner');
    const ownerBefore = owner.messages.length;
    f.broker.ephemeralThreadOwners.set('private-thread', peer);
    await f.notify({ workId: 'private-work', revision: 4, eventId: 'changed-owner' });
    assert.equal(owner.messages.length, ownerBefore, 'changed ephemeral ownership revokes previous observation');
    f.broker.detach(peer);
    const late = await f.request(owner, 'after-detach', 'work/read', { workId: 'private-work' });
    await f.respond(late.id, { result: { work: ephemeral } });
    assert.equal(owner.messages.at(-1).result.work, null, 'dispose still pending cannot unprotect an ephemeral work');
  } finally { f.broker.clearTransientState(); }
});

test('successful exact dispose releases retirement capacity across repeated temporary sessions', async () => {
  const f = fixture();
  try {
    const owner = f.client('owner-a');
    const upstream = await f.request(owner, 'init', 'initialize', init(true));
    await f.respond(upstream.id, { result: initialized(true) });
    const guard = initialized(true).capabilities.experimental;
    for (let i = 0; i < 4100; i += 1) {
      const id = `temporary-${i}`;
      const retirement = f.broker.continuousWork.retireEphemeral(id);
      assert.ok(retirement, 'confirmed cleanup should not exhaust the bounded fence set');
      f.broker.continuousWork.settleEphemeral(id, retirement,
        { result: { threadId: id, disposed: true } }, guard, f.broker.ephemeralThreadOwners);
    }
    assert.ok(await f.request(owner, 'list', 'work/list', {}), 'normal use remains available after repeated cleanup');
  } finally { f.broker.clearTransientState(); }
});

test('late dispose cannot clear a newer owner retirement and uncertain results keep isolation', async () => {
  const f = fixture();
  try {
    const first = f.client('owner-a'), peer = f.client('peer');
    const upstream = await f.request(first, 'init', 'initialize', init(true));
    await f.respond(upstream.id, { result: initialized(true) });
    await f.request(peer, 'peer-init', 'initialize', init(true));
    f.broker.ephemeralThreadOwners.set('reused-thread', first);
    f.broker.detach(first);
    const oldDispose = f.requests.at(-1);
    assert.equal(oldDispose.method, 'thread/dispose');
    const second = f.client('owner-b');
    await f.request(second, 'second-init', 'initialize', init(true));
    f.broker.continuousWork.noteEphemeralOwner('reused-thread');
    f.broker.ephemeralThreadOwners.set('reused-thread', second);
    f.broker.detach(second);
    const newDispose = f.requests.at(-1);
    await f.respond(oldDispose.id, { result: { threadId: 'reused-thread', disposed: true } });
    const read = await f.request(peer, 'read', 'work/read', { workId: 'private-work' });
    await f.respond(read.id, { result: { work: { ...work, workId: 'private-work', threadId: 'reused-thread' } } });
    assert.equal(peer.messages.at(-1).result.work, null, 'old success must not release a newer fence');
    await f.respond(newDispose.id, { result: { threadId: 'reused-thread', disposed: false } });
    const again = await f.request(peer, 'again', 'work/read', { workId: 'private-work' });
    await f.respond(again.id, { result: { work: { ...work, workId: 'private-work', threadId: 'reused-thread' } } });
    assert.equal(peer.messages.at(-1).result.work, null, 'unconfirmed dispose must retain the fence');
  } finally { f.broker.clearTransientState(); }
});

test('revoked target authority or changed thread owner cannot publish a late mutation receipt', async () => {
  for (const revoke of ['session', 'thread']) {
    const f = fixture();
    try {
      const owner = f.client('owner-a'), peer = f.client('owner-b');
      const upstream = await f.request(owner, 'init', 'initialize', init(true));
      await f.respond(upstream.id, { result: initialized(true) });
      await f.request(peer, 'peer-init', 'initialize', init(true));
      f.broker.threadOwners.set('thread-1', owner);
      const request = await f.request(owner, 'submit', 'work/input/submit', submit);
      if (revoke === 'session') owner.revoke(); else f.broker.threadOwners.set('thread-1', peer);
      await f.respond(request.id, { result: { receipt: { threadId: 'thread-1', workId: 'work-1', inputId: 'input-1',
        requestId: 'request-1', sequence: 1, state: 'accepted' } } });
      assert.equal(owner.messages.at(-1).error.code, -32034);
    } finally { f.broker.clearTransientState(); }
  }
});

test('native errors preserve confirmed rejection or unknown outcome without exposing diagnostics', async () => {
  const f = fixture();
  try {
    const owner = f.client('owner-a');
    const upstream = await f.request(owner, 'init', 'initialize', init(true));
    await f.respond(upstream.id, { result: initialized(true) });
    f.broker.threadOwners.set('thread-1', owner);
    for (const [method, params, nativeCode, expectedCode] of [
      ['work/input/submit', submit, -32602, -32602],
      ['work/input/submit', submit, -32034, -32034],
      ['work/input/submit', submit, -32099, -32034],
      ['work/input/submit', submit, -32032, -32034],
      ['work/input/submit', submit, -32033, -32034],
      ['work/input/submit', submit, -32043, -32034],
      ['work/control', { threadId: 'thread-1', workId: 'work-1', requestId: 'control-1', expectedRevision: 2,
        action: 'stop', target: { kind: 'work' } }, -32023, -32034],
      ['work/read', { workId: 'work-1' }, -32001, -32001],
      ['work/read', { workId: 'work-1' }, -32099, -32603],
    ]) {
      const request = await f.request(owner, 'error', method, params);
      await f.respond(request.id, { error: { code: nativeCode, message: `/private/path ${'secret'.repeat(1000)}`,
        data: { token: 'credential', payload: 'private' } } });
      const actual = owner.messages.at(-1);
      assert.equal(actual.error.code, expectedCode);
      assert.ok(actual.error.message.length < 160);
      assert.equal(Object.hasOwn(actual.error, 'data'), false);
      assert.doesNotMatch(JSON.stringify(actual), /private|secret|credential/);
    }
  } finally { f.broker.clearTransientState(); }
});

test('mutation capabilities need their own name plus the negotiated read projection', async () => {
  const clientParams = () => {
    const params = init(false);
    params.capabilities.experimental[readCap] = true;
    params.capabilities.experimental[inputCap] = true;
    params.capabilities.experimental[controlCap] = true;
    return params;
  };
  // A target that declares the mutation names without the read projection the
  // client needs for a work revision must not gain them.
  const denied = fixture();
  try {
    const owner = denied.client('owner-a');
    const upstream = await denied.request(owner, 'init', 'initialize', clientParams());
    const backend = initialized(false, false);
    backend.capabilities.experimental[inputCap] = true;
    backend.capabilities.experimental[controlCap] = true;
    await denied.respond(upstream.id, { result: backend });
    const projected = owner.messages.at(-1).result.capabilities.experimental;
    // Present-but-false is the Gateway's projection of "not negotiated".
    assert.equal(projected[inputCap], false);
    assert.equal(projected[controlCap], false);
    assert.equal(await denied.request(owner, 'input', 'work/input/submit', submit), null);
    assert.equal(owner.messages.at(-1).error.code, -32601);
  } finally { denied.broker.clearTransientState(); }

  const granted = fixture();
  try {
    const owner = granted.client('owner-b');
    const upstream = await granted.request(owner, 'init', 'initialize', clientParams());
    const backend = initialized(false, false);
    backend.capabilities.experimental[readCap] = true;
    backend.capabilities.experimental[inputCap] = true;
    backend.capabilities.experimental[controlCap] = true;
    await granted.respond(upstream.id, { result: backend });
    const accepted = owner.messages.at(-1).result.capabilities.experimental;
    assert.equal(accepted[readCap], true);
    assert.equal(accepted[inputCap], true);
    assert.equal(accepted[controlCap], true);
  } finally { granted.broker.clearTransientState(); }
});

test('the read-only capability cannot submit input or control a work', async () => {
  const readOnly = fixture();
  try {
    const reader = readOnly.client('owner-read');
    const readerParams = init(false);
    readerParams.capabilities.experimental[readCap] = true;
    const upstream = await readOnly.request(reader, 'init', 'initialize', readerParams);
    const backend = initialized(false, false);
    backend.capabilities.experimental[readCap] = true;
    await readOnly.respond(upstream.id, { result: backend });
    readOnly.broker.threadOwners.set('thread-1', reader);
    const before = readOnly.requests.length;
    assert.equal(await readOnly.request(reader, 'read-only-input', 'work/input/submit', submit), null);
    assert.equal(reader.messages.at(-1).error.code, -32601);
    assert.equal(await readOnly.request(reader, 'read-only-control', 'work/control',
      { ...submit, action: 'stop', target: { kind: 'work' } }), null);
    assert.equal(reader.messages.at(-1).error.code, -32601);
    assert.equal(readOnly.requests.length, before, 'unnegotiated mutations never reach the target');
    const read = await readOnly.request(reader, 'read-only-read', 'work/read', { workId: 'work-1' });
    assert.equal(read.method, 'work/read', 'read stays available under its own capability');
  } finally { readOnly.broker.clearTransientState(); }

  // A client that negotiates the mutation name may write, but only because the
  // target declares it too; the revision still comes from the read projection.
  const writerFixture = fixture();
  try {
    const writer = writerFixture.client('owner-write');
    const writerParams = init(false);
    writerParams.capabilities.experimental[readCap] = true;
    writerParams.capabilities.experimental[inputCap] = true;
    const upstream = await writerFixture.request(writer, 'init', 'initialize', writerParams);
    const backend = initialized(false, false);
    backend.capabilities.experimental[readCap] = true;
    backend.capabilities.experimental[inputCap] = true;
    await writerFixture.respond(upstream.id, { result: backend });
    writerFixture.broker.threadOwners.set('thread-1', writer);
    const forwarded = await writerFixture.request(writer, 'input', 'work/input/submit', submit);
    assert.deepEqual(forwarded.params, submit);
    await writerFixture.respond(forwarded.id, { result: { receipt: { threadId: 'thread-1', workId: 'work-1',
      inputId: 'input-1', requestId: 'request-1', sequence: 1, state: 'queued' } } });
    assert.equal(writer.messages.at(-1).result.receipt.state, 'queued');
  } finally { writerFixture.broker.clearTransientState(); }
});
