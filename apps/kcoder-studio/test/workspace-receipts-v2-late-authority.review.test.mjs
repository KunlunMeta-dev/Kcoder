import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import {
  captureRetentionAuthority,
  registerMobileDeviceGrantState,
} from '../src/retention-context.js';
import { createAccountLoginContexts } from '../src/account-login-context.js';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

function brokerFixture(t) {
  const child = new EventEmitter();
  const frames = [];
  let buffered = '';
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      buffered += chunk.toString('utf8');
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line) frames.push(JSON.parse(line));
      }
      callback();
    },
  });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({
    child,
    adapter: {
      rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }),
    },
    maxMessageBytes: 1024 * 1024,
    serverId: 'late-authority-target',
    residentThreads: true,
    retentionParentV1: true,
  });
  t.after(() => {
    broker.clearTransientState();
    child.emit('close', 0, null);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  });

  return {
    broker,
    child,
    frames,
    attach(retentionAuthority, authorizationOwner) {
      const client = {
        channel: 'runtime',
        authorizationOwner,
        retentionAuthority,
        messages: [],
        send(message) { this.messages.push(message); return true; },
        pause() {},
        resume() {},
        close() {},
      };
      broker.attach(client);
      return client;
    },
    async initialize(client) {
      const before = frames.length;
      broker.receive(client, JSON.stringify({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: {} }));
      assert.equal(frames.length, before + 1);
      const request = frames.at(-1);
      assert.equal(request.method, 'initialize');
      child.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: { capabilities: { experimental: { residentThreads: true, workspaceOperationReceiptsV2: true } } },
      })}\n`);
      await tick();
      assert.equal(client.initialized, true);
    },
    send(client, message) {
      const frameCount = frames.length;
      const messageCount = client.messages.length;
      broker.receive(client, JSON.stringify(message));
      return {
        writes: frames.slice(frameCount),
        messages: client.messages.slice(messageCount),
      };
    },
    async reply(request, result) {
      child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
      await tick();
    },
  };
}

function accountAuthorityFixture() {
  const deviceId = `review-device-${randomUUID()}`;
  const authorizationGeneration = `review-generation-${randomUUID()}`;
  const families = new Map();
  const now = Date.now();
  const registration = registerMobileDeviceGrantState({
    families,
    payload: {
      deviceId,
      authorizationGeneration,
      retentionNamespaceId: `review-namespace-${randomUUID()}`,
      wsLeaseExpiresAt: now + 60_000,
      expiresAt: now + 60_000,
    },
    allowedServerIds: ['late-authority-target'],
  });
  const target = {
    id: 'late-authority-target',
    runtime: 'kcoder',
    transport: 'local',
    command: '/opt/kcoder',
    cwd: '/work/late-authority',
    profile: 'default',
    settingsFile: '/config/settings.json',
    security: { identity: { mode: 'account' } },
  };
  const selection = 'late-authority-broker-selection';
  const authorizationOwner = `mobile-device:${deviceId}`;
  const contexts = createAccountLoginContexts();
  const principal = { principalId: `principal-${randomUUID()}`, username: 'review-user', role: 'user' };
  const credential = { username: principal.username, password: 'fixture-only-not-a-secret' };
  contexts.publish(authorizationOwner, target.id, principal, credential);
  const accountGeneration = contexts.generation(authorizationOwner, target.id);
  const retentionAuthority = captureRetentionAuthority({
    includeWorkspaceAccount: true,
    session: registration.session,
    familyFor: id => families.get(id),
    target,
    currentTarget: () => target,
    brokerSelection: selection,
    currentBrokerSelection: () => selection,
    workspacePath: target.cwd,
    accountIdentity: () => contexts.identity(authorizationOwner, target.id),
    accountGeneration: () => contexts.generation(authorizationOwner, target.id),
  });
  assert.ok(retentionAuthority(), 'the initial authenticated account authority must be available');
  return { contexts, target, principal, credential, authorizationOwner, accountGeneration, retentionAuthority };
}

async function initializedRuntime(t) {
  const authority = accountAuthorityFixture();
  const fixture = brokerFixture(t);
  const client = fixture.attach(authority.retentionAuthority, authority.authorizationOwner);
  await fixture.initialize(client);
  return { ...authority, fixture, client };
}

test('late V2 scope response is withheld after role-only publish while the old reply is held', async t => {
  const state = await initializedRuntime(t);
  const sent = state.fixture.send(state.client, {
    jsonrpc: '2.0',
    id: 'scope-role-change',
    method: 'runtime.workspaces.operation/scopeV2',
    params: {},
  });
  assert.equal(sent.writes.length, 1);
  const request = sent.writes[0];
  assert.ok(request.kcoderPrivateRetention, 'Gateway must inject its private V2 authority before stdio');
  assert.equal(request.kcoderPrivateRetention.workspaceAccount.role, 'user');
  state.contexts.publish(state.authorizationOwner, state.target.id,
    { ...state.principal, role: 'admin' }, state.credential);
  assert.equal(state.contexts.generation(state.authorizationOwner, state.target.id), state.accountGeneration,
    'role-only publication changes the account scope without changing login generation');
  assert.equal(state.contexts.identity(state.authorizationOwner, state.target.id).principalId,
    state.principal.principalId);
  assert.equal(state.contexts.identity(state.authorizationOwner, state.target.id).role, 'admin');
  assert.equal(state.retentionAuthority(), null,
    'the captured authority callback must reject the old role after publication');

  await state.fixture.reply(request, {
    scope: { version: 2, rootId: 'root-under-old-role', scopeId: 'scope-under-old-role' },
  });
  const response = state.client.messages.at(-1);
  assert.equal(response.id, 'scope-role-change');
  assert.equal(response.error?.code, -32001,
    'the Gateway must turn the held old-scope result into the fixed unknown-authority error');
  assert.equal(Object.hasOwn(response, 'result'), false,
    'the old ready scope must not be forwarded after role-only publication');
});

test('late V2 mutation ready result is withheld after principal publish while the old reply is held', async t => {
  const state = await initializedRuntime(t);
  const sent = state.fixture.send(state.client, {
    jsonrpc: '2.0',
    id: 'mutation-principal-change',
    method: 'runtime.workspaces.openV2',
    params: {
      clientRequestId: 'intent-under-old-principal',
      scopeId: 'scope-under-old-principal',
      workspacePath: '/work/created-under-old-principal',
      action: 'create',
      label: 'Old principal result',
    },
  });
  assert.equal(sent.writes.length, 1);
  const request = sent.writes[0];
  assert.ok(request.kcoderPrivateRetention, 'Gateway must inject its private V2 authority before stdio');
  assert.equal(request.kcoderPrivateRetention.workspaceAccount.authorizationGeneration,
    String(state.accountGeneration));

  const replacement = {
    principalId: `replacement-${randomUUID()}`,
    username: state.principal.username,
    role: state.principal.role,
  };
  state.contexts.publish(state.authorizationOwner, state.target.id, replacement, state.credential);
  assert.equal(state.contexts.generation(state.authorizationOwner, state.target.id), state.accountGeneration + 1);
  assert.equal(state.retentionAuthority(), null,
    'the captured authority callback must reject a principal replacement');

  await state.fixture.reply(request, {
    scope: { version: 2, rootId: 'root-under-old-principal', scopeId: 'scope-under-old-principal' },
    receipt: {
      clientRequestId: 'intent-under-old-principal',
      method: 'runtime.workspaces.openV2',
      paramsDigest: 'a'.repeat(64),
      status: 'ready',
      workspacePath: '/work/created-under-old-principal',
    },
    result: { workspacePath: '/work/created-under-old-principal', deviceId: state.target.id },
  });
  const response = state.client.messages.at(-1);
  assert.equal(response.id, 'mutation-principal-change');
  assert.equal(response.error?.code, -32001,
    'the Gateway must withhold an old-principal mutation completion as unknown');
  assert.equal(Object.hasOwn(response, 'result'), false,
    'a ready mutation receipt from the previous principal must not be forwarded');
});

test('unchanged V2 authority still forwards the held scope response', async t => {
  const state = await initializedRuntime(t);
  const sent = state.fixture.send(state.client, {
    jsonrpc: '2.0',
    id: 'scope-unchanged',
    method: 'runtime.workspaces.operation/scopeV2',
    params: {},
  });
  assert.equal(sent.writes.length, 1);
  const result = {
    scope: { version: 2, rootId: 'stable-root', scopeId: 'stable-scope' },
  };
  await state.fixture.reply(sent.writes[0], result);
  const response = state.client.messages.at(-1);
  assert.equal(response.id, 'scope-unchanged');
  assert.deepEqual(response.result, result);
  assert.equal(response.error, undefined);
});
