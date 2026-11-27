import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { generateKeyPairSync } from 'node:crypto';
import { WorkspaceAppServerBroker } from './workspace-app-server-broker.js';
import { createAccountLoginContexts } from './account-login-context.js';
import { captureNativeRemoteSourceClient } from './remotes/source-client-owner.mjs';
import { createAgentMessageRouter } from './agent-message-router.js';
import { createAgentMessageClientDispatcher, initializeAgentMessageEndpoint } from './agent-message-router-gateway.js';
import { createAgentMessageRouterBackchannel, PEER_ROUTER_HOST_METHOD } from './agent-message-router-backchannel.js';
import { ROUTER_METHODS, ROUTER_CAPABILITY, ROUTER_PRIVATE_FIELD, ROUTER_PURPOSE } from './agent-message-router-private.js';
import { projectAgentMessageResponse } from './broker-agent-messages.js';
import { AGENT_MESSAGE_METHODS, AGENT_MESSAGE_DISCOVERY_SEARCH_CAPABILITY as SEARCH,
  validAgentMessageTargetQuery, validAgentMessageRequest } from '../shared/agentMessageMethods.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const copy = value => structuredClone(value);
const row = (id, extra = {}) => ({ threadId: id, title: '项目 Needle', status: 'running', presence: 'resident', allowedModes: [], ...extra });
const page = (targets = [], nextCursor) => ({ coverage: 'workspace_history', completeness: nextCursor ? 'indexing' : 'complete',
  observedAtMs: Date.now(), targets, ...(nextCursor ? { nextCursor } : {}) });

// In-memory Native protocol endpoints exercise the real broker/owner/router;
// this fixture neither starts an OS process nor supplies production authority.
async function fixture(t, { search = true } = {}) {
  function endpoint(alias) {
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
    const target = { id: alias, runtime: 'kcoder', transport: 'local', cwd: '/isolated/' + alias };
    const key = generateKeyPairSync('ed25519');
    const identity = { targetId: 'canonical-' + alias, workspaceId: 'workspace-' + alias, principal: { kind: 'localOs' },
      publicKey: [...key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)], identityEpoch: 'epoch-' + alias };
    const requests = [], hooks = {};
    let reverse;
    const broker = new WorkspaceAppServerBroker({ child, serverId: alias, targetTransport: 'local', residentThreads: true,
      retentionParentV1: true, maxMessageBytes: 1024 * 1024,
      nativeRemoteHostBackchannel: { receiveBackend: message => reverse?.receiveBackend(message) ?? false, close: () => reverse?.close() },
      adapter: { rawPassthrough: true, toUpstream: message => ({ upstream: [message], client: [] }),
        fromUpstream: message => ({ upstream: [], client: [message] }) } });
    broker.agentMessageTargetSignature = JSON.stringify(target);
    child.stdin.on('data', bytes => {
      for (const line of bytes.toString().trim().split('\n')) {
        const request = JSON.parse(line); requests.push(copy(request));
        if (!request.method) continue;
        void Promise.resolve().then(async () => {
          if (request.method === 'initialize') return { protocolVersion: '2026-07-27', cwd: target.cwd,
            capabilities: { experimental: { residentThreads: true, [ROUTER_CAPABILITY]: true,
              crossSessionDiscoveryV1: true, crossSessionMessagesV1: true, peerAgentMessagesV1: true, [SEARCH]: search } } };
          if (request.method === ROUTER_METHODS.identity) { hooks.identity?.(); return identity; }
          if (request.method === ROUTER_METHODS.targets) {
            assert.equal(request[ROUTER_PRIVATE_FIELD].purpose, ROUTER_PURPOSE);
            assert.deepEqual(request[ROUTER_PRIVATE_FIELD].destination, identity);
            const result = await (hooks.targets ? hooks.targets(request.params) : page());
            return search && !hooks.omitAddresses ? { ...result, targets: result.targets.map(target => ({ ...target,
              address: target.address ?? { targetId: identity.targetId, workspaceId: identity.workspaceId, threadId: target.threadId } })) } : result;
          }
          assert.fail('Discovery must not dispatch a send or another Native operation');
        }).then(result => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n'),
        () => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
          error: { code: -32034, message: 'Bounded search fixture failure', ...(hooks.errorData ? { data: hooks.errorData } : {}) } }) + '\n'));
      }
    });
    t.after(() => { broker.clearTransientState(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });
    return { child, broker, target, identity, hooks, requests, descriptor: { broker, serverId: alias, workspacePath: target.cwd },
      installReverse(value) { reverse = value; }, targetRequests: () => requests.filter(request => request.method === ROUTER_METHODS.targets) };
  }
  const a = endpoint('a'), b = endpoint('b'), c = endpoint('c'), all = [a, b, c];
  const targets = new Map(all.map(e => [e.target.id, e.target]));
  const session = { allowedServerIds: new Set(targets.keys()) }, loginContexts = createAccountLoginContexts();
  let active = true;
  const verifySession = () => active, getTarget = id => targets.get(id), targetSignature = JSON.stringify;
  for (const e of all) await initializeAgentMessageEndpoint(e.broker);
  const client = { channel: 'runtime', authorizationOwner: 'search-fixture-owner', messages: [],
    send(message) { this.messages.push(copy(message)); return true; }, pause() {}, resume() {}, close() {} };
  a.broker.attach(client);
  client.nativeRemoteSourceOwner = captureNativeRemoteSourceClient({ client, broker: a.broker, sourceTarget: a.target,
    authorizationOwner: client.authorizationOwner, session, verifySession, getTarget, targetSignature,
    accountIdentity: loginContexts.identity, accountGeneration: loginContexts.generation });
  a.broker.receive(client, JSON.stringify({ jsonrpc: '2.0', id: 'initialize-client', method: 'initialize', params: {
    protocolVersion: '2026-07-27', clientInfo: { name: 'owned-search-unit', version: '1' },
    capabilities: { experimental: { crossSessionDiscoveryV1: true, crossSessionMessagesV1: true, peerAgentMessagesV1: true, [SEARCH]: true } },
  } }));
  a.broker.threadOwners.set('source-thread', client);
  const router = createAgentMessageRouter({ getTarget, targetSignature, loginContexts,
    listEndpointCandidates: async () => ({ entries: all.map(e => e.descriptor), completeness: 'complete' }) });
  const source = await router.captureClient({ broker: a.broker, client, session, verifySession,
    sourceThreadId: 'source-thread', workspacePath: a.target.cwd });
  const dispatcher = createAgentMessageClientDispatcher({ router, broker: a.broker, client, session, verifySession, workspacePath: a.target.cwd });
  return { a, b, c, all, router, source, client, session, targets, loginContexts, dispatcher, revoke() { active = false; } };
}

function reverseFixture(f) {
  const active = { owner: f.client, turnId: 'actual-turn', attemptId: 'actual-attempt' };
  f.a.broker.activeTurns.set('source-thread', active); f.client.routeAgentMessage = f.dispatcher;
  const backchannel = createAgentMessageRouterBackchannel({ child: f.a.child, serverId: 'a', getBroker: () => f.a.broker,
    getRouter: () => f.router, assertSourceOwner: ({ child, serverId }) => {
      assert.equal(child, f.a.child); assert.equal(serverId, 'a'); assert.equal(f.a.broker.closed, false);
    }, reply: message => f.a.broker.safeWriteMessage(message) });
  f.a.installReverse(backchannel);
  return { async request(payload, sequence = 1) {
    const id = 'peer-router-search-unit-' + sequence;
    f.a.child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, method: PEER_ROUTER_HOST_METHOD,
      params: { kind: 'targets', sourceAttempt: { threadId: 'source-thread', turnId: active.turnId, attemptId: active.attemptId }, payload } }) + '\n');
    for (let i = 0; i < 500; i++) {
      const reply = f.a.requests.find(frame => frame.id === id && !frame.method);
      if (reply) return reply;
      await tick();
    }
    assert.fail('Original Native search frame did not settle');
  } };
}

test('flat discovery selectors retain Unicode and reject malformed limits/status/scope input', () => {
  assert.equal(validAgentMessageTargetQuery({ title: '项目 Α', query: 'needle', targetId: 'canonical-b', status: 'waiting_for_answer', presence: 'not_resident', allowedMode: 'enqueue_only', limit: 256 }), true);
  for (const input of [{ limit: 0 }, { limit: 257 }, { limit: 1.5 }, { limit: '20' }, { status: 'active' }, { presence: 'online' }, { allowedMode: 'broadcast' },
    { title: ' ' }, { query: '\u0085' }, { title: '界'.repeat(86) }, { targetId: 'x\n' }, { filters: { title: 'x' } }, { source: 'other' }])
    assert.equal(validAgentMessageTargetQuery(input), false, JSON.stringify(input));
  assert.equal(validAgentMessageRequest(AGENT_MESSAGE_METHODS.targets, { sourceThreadId: 'source-thread', title: '项目', limit: 20 }), true);
});

test('actual public dispatcher forwards combined search and returns more than ten matching rows', async t => {
  const f = await fixture(t);
  const query = { title: '项目', query: 'Needle', targetId: f.b.identity.targetId, status: 'running', presence: 'resident', limit: 25 };
  f.b.hooks.targets = params => { assert.deepEqual(params, { sourceThreadId: 'source-thread', ...query }); return page(Array.from({ length: 25 }, (_, i) => row('match-' + i))); };
  await f.dispatcher({ jsonrpc: '2.0', id: 'combined-search', method: AGENT_MESSAGE_METHODS.targets,
    params: { sourceThreadId: 'source-thread', ...query } });
  const reply = f.client.messages.find(message => message.id === 'combined-search');
  assert.equal(reply?.result?.targets.length, 25, JSON.stringify(reply));
  assert.ok(reply.result.targets.every(target => target.address.targetId === f.b.identity.targetId));
  assert.equal(f.a.targetRequests().length + f.c.targetRequests().length, 0);
});

test('owned Native backchannel passes flat search to the original authenticated source', async t => {
  const f = await fixture(t), reverse = reverseFixture(f);
  const query = { title: '项目', targetId: f.b.identity.targetId, limit: 15 };
  f.b.hooks.targets = params => { assert.deepEqual(params, { sourceThreadId: 'source-thread', ...query }); return page(Array.from({ length: 15 }, (_, i) => row('native-' + i))); };
  const reply = await reverse.request(query);
  assert.equal(reply.result?.targets.length, 15, JSON.stringify(reply));
});

test('cursor inherits fixed selectors and permits a new limit without consuming rejected filter changes', async t => {
  const f = await fixture(t), query = { title: '项目', targetId: f.b.identity.targetId, limit: 12 };
  let calls = 0;
  f.b.hooks.targets = params => {
    calls++;
    if (calls === 1) { assert.equal(params.title, '项目'); return page(Array.from({ length: 12 }, (_, i) => row('first-' + i)), 'native-page-2'); }
    assert.equal(params.title, undefined); assert.equal(params.targetId, undefined); assert.equal(params.limit, 21);
    if (calls === 2) { assert.equal(params.cursor, 'native-page-2'); return page(Array.from({ length: 21 }, (_, i) => row('second-' + i)), 'native-page-3'); }
    assert.equal(params.cursor, 'native-page-3'); return page([row('last')]);
  };
  const first = await f.router.targets(f.source, query);
  await assert.rejects(f.router.targets(f.source, { cursor: first.nextCursor, title: 'changed' }), /CURSOR_FILTER_MISMATCH/);
  assert.equal(calls, 1);
  const second = await f.router.targets(f.source, { cursor: first.nextCursor, limit: 21 });
  assert.equal(second.targets.length, 21);
  const third = await f.router.targets(f.source, { cursor: second.nextCursor });
  assert.equal(third.targets.length, 1); assert.equal(third.nextCursor, undefined);
});

test('a live search cursor is rejected when any authorized target login generation changes', async t => {
  const f = await fixture(t); let calls = 0;
  f.b.hooks.targets = params => {
    calls++;
    assert.equal(params.title, '项目');
    return page([row('first-' + calls)], calls === 1 ? 'login-generation-next' : undefined);
  };
  const first = await f.router.targets(f.source, { title: '项目', targetId: f.b.identity.targetId });
  assert.equal(first.targets.length, 1);
  assert.ok(first.nextCursor);
  f.loginContexts.invalidate(f.client.authorizationOwner, f.b.target.id);
  await assert.rejects(f.router.targets(f.source, { cursor: first.nextCursor }), /AGENT_MESSAGES_CURSOR_INVALID/);
  assert.equal(calls, 1, 'stale login-generation cursor must not read another Native page');
});

test('search skips multiple empty Native pages and other targets before returning matching metadata', async t => {
  const f = await fixture(t); let bCalls = 0;
  f.b.hooks.targets = params => {
    bCalls++;
    if (bCalls === 1) { assert.equal(params.title, '项目'); return page([], 'empty-native-continuation'); }
    assert.equal(params.cursor, 'empty-native-continuation'); return page();
  };
  f.c.hooks.targets = params => { assert.equal(params.title, '项目'); return page([row('found-on-c')]); };
  const result = await f.router.targets(f.source, { title: '项目', limit: 30 });
  assert.equal(result.targets[0].threadId, 'found-on-c'); assert.equal(result.nextCursor, undefined);
  assert.equal(bCalls, 2); assert.equal(result.completeness, 'complete');
});

test('legacy default uses unchanged V1 payload while advanced requests explicitly reject missing capability', async t => {
  const f = await fixture(t, { search: false });
  f.b.hooks.targets = params => { assert.deepEqual(params, { sourceThreadId: 'source-thread' }); return page([row('legacy-row')]); };
  const first = await f.router.targets(f.source, { limit: 10 });
  assert.deepEqual(first.targets, []); assert.ok(first.nextCursor);
  const result = await f.router.targets(f.source, { cursor: first.nextCursor });
  assert.equal(result.targets.length, 1);
  await assert.rejects(f.router.targets(f.source, { title: '项目' }), error => error.code === -32601 && /SEARCH_UNSUPPORTED/.test(error.message));
});

test('missing authorized endpoint is partial; current source revocation remains a hard refusal', async t => {
  const f = await fixture(t); f.targets.delete('b');
  f.c.hooks.targets = () => page([row('visible-c')]);
  const result = await f.router.targets(f.source, { title: '项目' });
  assert.equal(result.completeness, 'partial'); assert.ok(result.issueCount >= 1);
  assert.equal(f.b.targetRequests().length, 0);
  f.c.hooks.targets = () => { f.revoke(); return page([row('must-not-return')]); };
  await assert.rejects(f.router.targets(f.source, { targetId: f.c.identity.targetId, title: '项目' }));
});

test('256 small Native rows with authoritative addresses fit one requested page', async t => {
  const f = await fixture(t); let nativeLimit;
  f.b.hooks.targets = params => { nativeLimit = params.limit; return page(Array.from({ length: 256 }, (_, i) => row('small-' + i))); };
  const result = await f.router.targets(f.source, { targetId: f.b.identity.targetId, limit: 256 });
  assert.equal(nativeLimit, 256); assert.equal(result.targets.length, 256); assert.equal(result.nextCursor, undefined);
  assert.equal(f.b.targetRequests().length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 112 * 1024);
});

test('byte-bounded Native pages retain every row and keep the requested 256 capacity', async t => {
  const f = await fixture(t); let offset = 0;
  f.b.hooks.targets = params => {
    assert.equal(params.limit, 256);
    const count = Math.min(100, 256 - offset);
    const targets = Array.from({ length: count }, (_, i) => row('large-' + (offset + i), { title: '界'.repeat(200) }));
    offset += count; return page(targets, offset < 256 ? 'native-offset-' + offset : undefined);
  };
  const all = []; let cursor;
  do {
    const result = await f.router.targets(f.source, cursor ? { cursor } : { targetId: f.b.identity.targetId, limit: 256 });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 112 * 1024);
    all.push(...result.targets); cursor = result.nextCursor;
  } while (cursor);
  assert.equal(all.length, 256); assert.equal(new Set(all.map(target => target.threadId)).size, 256);
  assert.equal(f.b.targetRequests().length, 3);
});

test('Native response count beyond the effective request limit is rejected', async t => {
  const f = await fixture(t);
  f.b.hooks.targets = params => page(Array.from({ length: params.limit + 1 }, (_, i) => row('overflow-' + i)));
  await assert.rejects(f.router.targets(f.source, { targetId: f.b.identity.targetId, limit: 20 }), /INVALID_DISCOVERY_RESPONSE/);
});

test('direct Native response projection accepts negotiated larger and inherited pages', async t => {
  const f = await fixture(t);
  const value = page(Array.from({ length: 25 }, (_, i) => row('direct-' + i)));
  for (const query of [{ limit: 25 }, { cursor: 'inherited-native-limit' }]) {
    const ticket = { client: f.client, authorizationOwner: f.client.authorizationOwner, method: AGENT_MESSAGE_METHODS.targets,
      source: 'source-thread', params: { sourceThreadId: 'source-thread', ...query } };
    const result = projectAgentMessageResponse(f.a.broker, { agentMessageTicket: ticket, clientId: 'direct' }, { id: 'private', result: value });
    assert.equal(result.result?.targets.length, 25, JSON.stringify(result));
  }
});


test('allowedMode is pushed into Native and remains fixed while cursor limits change', async t => {
  const f = await fixture(t); let calls = 0;
  f.b.hooks.targets = params => {
    calls++;
    const item = row('mode-' + calls, { allowedModes: ['enqueue_only'] });
    if (calls === 1) { assert.equal(params.allowedMode, 'enqueue_only'); return page([item], 'mode-page-2'); }
    assert.equal(params.allowedMode, undefined); assert.equal(params.limit, 22); return page([item]);
  };
  const result = await f.router.targets(f.source, { targetId: f.b.identity.targetId, allowedMode: 'enqueue_only', limit: 12 });
  await assert.rejects(f.router.targets(f.source, { cursor: result.nextCursor, allowedMode: 'wake_if_idle' }), /CURSOR_FILTER_MISMATCH/);
  assert.equal(calls, 1);
  const next = await f.router.targets(f.source, { cursor: result.nextCursor, limit: 22 });
  assert.deepEqual(next.targets[0].allowedModes, ['enqueue_only']);
});

test('read-only Source metadata cannot match allowedMode and ordinary rows expose no message grant', async t => {
  const f = await fixture(t); f.client.crossSessionMessagesV1 = false; f.client.peerAgentMessagesV1 = false;
  f.b.hooks.targets = () => page([row('not-sendable', { allowedModes: ['enqueue_only', 'wake_if_idle'] })]);
  const filtered = await f.router.targets(f.source, { targetId: f.b.identity.targetId, allowedMode: 'enqueue_only' });
  assert.deepEqual(filtered.targets, []); assert.equal(f.b.targetRequests().length, 0);
  const ordinary = await f.router.targets(f.source, { targetId: f.b.identity.targetId });
  assert.equal(ordinary.targets.length, 1); assert.deepEqual(ordinary.targets[0].allowedModes, []);
});

test('Native search capability is rechecked after the actual endpoint refresh', async t => {
  const f = await fixture(t); let identities = 0;
  f.b.hooks.identity = () => { if (++identities === 2) f.b.broker.initializeResponse.result.capabilities.experimental[SEARCH] = false; };
  await assert.rejects(f.router.targets(f.source, { targetId: f.b.identity.targetId, title: '项目' }), /SEARCH_UNSUPPORTED/);
  assert.equal(f.b.targetRequests().length, 0);
});

test('a mixed-version directory returns matches from capable targets and identifies incomplete coverage', async t => {
  const f = await fixture(t);
  f.b.hooks.identity = () => { f.b.broker.initializeResponse.result.capabilities.experimental[SEARCH] = false; };
  f.c.hooks.targets = () => page([row('available-on-c')]);
  const result = await f.router.targets(f.source, { title: '项目' });
  assert.deepEqual(result.targets.map(item => item.threadId), ['available-on-c']);
  assert.equal(result.completeness, 'partial');
  assert.equal(result.issueCount, 1);
  assert.equal(f.b.targetRequests().length, 0);
  await assert.rejects(f.router.targets(f.source, { targetId: f.b.identity.targetId, title: '项目' }), /SEARCH_UNSUPPORTED/);
});

test('new search capability cannot return rows without the Native authoritative address', async t => {
  const f = await fixture(t); f.b.hooks.omitAddresses = true;
  f.b.hooks.targets = () => page([row('missing-address')]);
  await assert.rejects(f.router.targets(f.source, { targetId: f.b.identity.targetId, limit: 20 }), /INVALID_DISCOVERY_RESPONSE/);
});

test('backchannel exposes only finite read-only cursor/filter reasons without payload text', async t => {
  const f = await fixture(t), reverse = reverseFixture(f);
  f.b.hooks.targets = params => params.cursor ? page([row('last')]) : page([row('first')], 'reason-page-2');
  const first = await reverse.request({ targetId: f.b.identity.targetId, title: 'private-search-text' });
  assert.ok(first.result?.nextCursor, JSON.stringify(first));
  const changed = await reverse.request({ cursor: first.result.nextCursor, title: 'changed-private-text' }, 2);
  assert.deepEqual(changed.error.data, { reason: 'cursor_filter_mismatch' });
  assert.equal(JSON.stringify(changed).includes('private'), false);
  const invalid = await reverse.request({ cursor: 'not-a-current-cursor' }, 3);
  assert.deepEqual(invalid.error.data, { reason: 'cursor_invalid' });
  const continued = await reverse.request({ cursor: first.result.nextCursor, limit: 22 }, 4);
  assert.equal(continued.result.targets[0].threadId, 'last');
});

test('backchannel preserves the closed missing-search-capability reason', async t => {
  const f = await fixture(t, { search: false }), reverse = reverseFixture(f);
  const reply = await reverse.request({ title: 'private-title', limit: 20 });
  assert.equal(reply.error.code, -32601); assert.deepEqual(reply.error.data, { reason: 'search_unsupported' });
  assert.equal(JSON.stringify(reply).includes('private-title'), false);
});

test('direct Native cursor metadata preserves allowedMode for a later read-only Source projection', async t => {
  const f = await fixture(t);
  const ticket = query => ({ client: f.client, authorizationOwner: f.client.authorizationOwner, method: AGENT_MESSAGE_METHODS.targets,
    source: 'source-thread', params: { sourceThreadId: 'source-thread', ...query } });
  const value = page([row('direct-mode', { allowedModes: ['enqueue_only'] })], 'native-mode-next');
  const first = projectAgentMessageResponse(f.a.broker, { agentMessageTicket: ticket({ allowedMode: 'enqueue_only' }), clientId: 'first' }, { id: 'private', result: value });
  assert.equal(first.result.targets.length, 1);
  f.client.crossSessionMessagesV1 = false; f.client.peerAgentMessagesV1 = false;
  const next = projectAgentMessageResponse(f.a.broker, { agentMessageTicket: ticket({ cursor: 'native-mode-next' }), clientId: 'next' }, { id: 'private', result: value });
  assert.deepEqual(next.result.targets, []); assert.equal(next.result.nextCursor, undefined);
});

test('direct Native query metadata preserves ordinary read-only pagination and fails closed for unknown filtered cursors', async t => {
  const f = await fixture(t); f.client.crossSessionMessagesV1 = false; f.client.peerAgentMessagesV1 = false;
  const ticket = query => ({ client: f.client, authorizationOwner: f.client.authorizationOwner, method: AGENT_MESSAGE_METHODS.targets,
    source: 'source-thread', params: { sourceThreadId: 'source-thread', ...query } });
  const response = page([row('readonly-view', { allowedModes: ['enqueue_only'] })], 'readonly-known');
  const project = query => projectAgentMessageResponse(f.a.broker, { agentMessageTicket: ticket(query), clientId: 'read' }, { id: 'native', result: response });
  const first = project({}); assert.equal(first.result.targets.length, 1); assert.deepEqual(first.result.targets[0].allowedModes, []);
  const known = project({ cursor: 'readonly-known' }); assert.equal(known.result.targets.length, 1);
  const unknown = project({ cursor: 'unbound-filter-context' }); assert.match(unknown.error.message, /CURSOR_INVALID/);
});

test('direct Native cursor query metadata cannot cross the original source thread binding', async t => {
  const f = await fixture(t);
  const ticket = (source, query) => ({ client: f.client, authorizationOwner: f.client.authorizationOwner, method: AGENT_MESSAGE_METHODS.targets,
    source, params: { sourceThreadId: source, ...query } });
  const response = page([row('source-bound-row', { allowedModes: ['enqueue_only'] })], 'source-bound-cursor');
  const first = projectAgentMessageResponse(f.a.broker, { agentMessageTicket: ticket('source-thread', { allowedMode: 'enqueue_only' }), clientId: 'first' }, { id: 'native', result: response });
  assert.equal(first.result.targets.length, 1);
  f.a.broker.threadOwners.set('other-owned-thread', f.client);
  f.client.crossSessionMessagesV1 = false; f.client.peerAgentMessagesV1 = false;
  const crossed = projectAgentMessageResponse(f.a.broker, { agentMessageTicket: ticket('other-owned-thread', { cursor: 'source-bound-cursor' }), clientId: 'cross' }, { id: 'native', result: response });
  assert.match(crossed.error.message, /CURSOR_INVALID/);
});


test('Native read error projection retains only the closed reason through the actual backchannel', async t => {
  const f = await fixture(t), reverse = reverseFixture(f);
  f.b.hooks.errorData = { reason: 'cursor_invalid', rawPath: '/private-fixture-location', payload: 'must-not-escape' };
  f.b.hooks.targets = () => { throw new Error('Native raw error is not a public diagnostic'); };
  const reply = await reverse.request({ targetId: f.b.identity.targetId, title: 'private-needle' });
  assert.deepEqual(reply.error.data, { reason: 'cursor_invalid' });
  assert.equal(JSON.stringify(reply).includes('private-fixture'), false);
  assert.equal(JSON.stringify(reply).includes('must-not-escape'), false);
  assert.equal(JSON.stringify(reply).includes('private-needle'), false);
});

test('unknown Native filter context never becomes known merely by reading another page', async t => {
  const f = await fixture(t);
  const ticket = cursor => ({ client: f.client, authorizationOwner: f.client.authorizationOwner, method: AGENT_MESSAGE_METHODS.targets,
    source: 'source-thread', params: { sourceThreadId: 'source-thread', cursor } });
  const response = page([row('unknown-original-filter', { allowedModes: ['enqueue_only'] })], 'unknown-native-next');
  const first = projectAgentMessageResponse(f.a.broker, { agentMessageTicket: ticket('original-not-observed'), clientId: 'first' }, { id: 'native', result: response });
  assert.equal(first.result.targets.length, 1);
  f.client.crossSessionMessagesV1 = false; f.client.peerAgentMessagesV1 = false;
  const next = projectAgentMessageResponse(f.a.broker, { agentMessageTicket: ticket('unknown-native-next'), clientId: 'next' }, { id: 'native', result: response });
  assert.match(next.error?.message ?? '', /CURSOR_INVALID/);
});

test('default V1 pagination stays unchanged even when the backend advertises search and omits row addresses', async t => {
  const f = await fixture(t); f.b.hooks.omitAddresses = true;
  f.b.hooks.targets = params => { assert.deepEqual(params, { sourceThreadId: 'source-thread' }); return page([row('valid-v1-no-address')]); };
  const first = await f.router.targets(f.source);
  assert.deepEqual(first.targets, []); assert.ok(first.nextCursor);
  assert.deepEqual(f.a.targetRequests()[0].params, { sourceThreadId: 'source-thread' });
  const second = await f.router.targets(f.source, { cursor: first.nextCursor, limit: 10 });
  assert.equal(second.targets[0].threadId, 'valid-v1-no-address');
  assert.equal(second.targets[0].address.targetId, f.b.identity.targetId);
});

test('a V1 cursor can opt into a larger capacity and later lower it to ten without losing the Native limit update', async t => {
  const f = await fixture(t); let calls = 0;
  f.b.hooks.targets = params => {
    calls++;
    if (calls === 1) { assert.equal(params.limit, 20); return page([row('upgraded')], 'upgraded-native-next'); }
    assert.equal(params.cursor, 'upgraded-native-next'); assert.equal(params.limit, 10); return page([row('lowered')]);
  };
  const first = await f.router.targets(f.source);
  const upgraded = await f.router.targets(f.source, { cursor: first.nextCursor, limit: 20 });
  assert.equal(upgraded.targets[0].threadId, 'upgraded');
  const lowered = await f.router.targets(f.source, { cursor: upgraded.nextCursor, limit: 10 });
  assert.equal(lowered.targets[0].threadId, 'lowered');
});
