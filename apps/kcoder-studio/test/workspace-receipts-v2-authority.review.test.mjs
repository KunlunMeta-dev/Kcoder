import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMobileDeviceAuth, mobileDeviceStoreIdentity } from '../src/mobile-device-auth.js';
import {
  PRIVATE_RETENTION_FIELD,
  captureRetentionAuthority,
  registerMobileDeviceGrantState,
  retentionTargetFingerprint,
} from '../src/retention-context.js';
import { createAccountLoginContexts } from '../src/account-login-context.js';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

async function privateStoreRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-workspace-receipts-v2-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function deviceAuth(directory) {
  return createMobileDeviceAuth({
    directory,
    identity: mobileDeviceStoreIdentity(''),
    accessTtlMs: 60_000,
    idleTtlMs: 600_000,
    absoluteTtlMs: 1_200_000,
    socketGraceMs: 30_000,
  });
}

function registerGrant(families, payload, targetId = 'target-a') {
  return registerMobileDeviceGrantState({ families, payload, allowedServerIds: [targetId] });
}

function localTarget(overrides = {}) {
  return {
    id: 'target-a',
    runtime: 'kcoder',
    transport: 'local',
    command: '/opt/kcoder',
    cwd: '/work/a',
    profile: 'default',
    settingsFile: '/config/settings.json',
    ...overrides,
  };
}

function captureAuthority({ registration, families, target, currentTarget, selection,
  currentSelection, workspacePath = '/work/a', contexts, authorizationOwner }) {
  return captureRetentionAuthority({
    includeWorkspaceAccount: true,
    session: registration.session,
    familyFor: deviceId => families.get(deviceId),
    target,
    currentTarget,
    workspacePath,
    brokerSelection: selection,
    currentBrokerSelection: currentSelection,
    accountIdentity: contexts ? () => contexts.identity(authorizationOwner, target.id) : undefined,
    accountGeneration: contexts ? () => contexts.generation(authorizationOwner, target.id) : undefined,
  });
}

function brokerFixture(t, { retentionParentV1 = true } = {}) {
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
    serverId: 'target-a',
    residentThreads: true,
    retentionParentV1,
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
    attach(retentionAuthority, authorizationOwner = 'review-device-owner') {
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
    async initialize(client, id) {
      const before = frames.length;
      broker.receive(client, JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: {} }));
      if (frames.length > before) {
        const request = frames.at(-1);
        assert.equal(request.method, 'initialize');
        // Fake raw capabilities exercise private broker dispatch gates only; V1 remains disabled in the client projection.
        child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id,
          result: { capabilities: { experimental: { residentThreads: true, workspaceOperationReceiptsV2: true,
            stagedAttachmentRetentionReceiptsV1: true } } } })}\n`);
        await tick();
      }
      assert.equal(client.initialized, true);
    },
    send(client, rawOrMessage) {
      const beforeFrames = frames.length;
      const beforeMessages = client.messages.length;
      broker.receive(client, typeof rawOrMessage === 'string' ? rawOrMessage : JSON.stringify(rawOrMessage));
      return {
        writes: frames.slice(beforeFrames),
        messages: client.messages.slice(beforeMessages),
      };
    },
    async reply(frame, result = { ok: true }) {
      child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result })}\n`);
      await tick();
    },
  };
}

function workspaceOpen(id, params = {}) {
  return { jsonrpc: '2.0', id, method: 'runtime.workspaces.openV2', params };
}

function receiptRead(id, params = {}) {
  return { jsonrpc: '2.0', id, method: 'runtime.workspaces.operation/readV2', params };
}

function assertRejectedWithoutUpstream(fixture, sent, expectedCode) {
  assert.equal(sent.writes.length, 0, 'rejected V2 request must not reach app-server stdio');
  assert.equal(sent.messages.length, 1);
  assert.equal(sent.messages[0].error?.code, expectedCode);
  assert.equal(Object.hasOwn(sent.messages[0], 'result'), false,
    'stale or mismatched authority must not degrade into a null receipt');
  assert.equal(fixture.broker.pending.size, 0);
  assert.equal(fixture.broker.pendingLoad.admitted, 0);
  assert.equal(fixture.broker.requestLoad.total.inFlight, 0);
}

test('V2 send injects the current Mobile/account/target scope; rotation and V1 remain isolated', async t => {
  const directory = await privateStoreRoot(t);
  const auth = deviceAuth(directory);
  const families = new Map();
  const grant = await auth.pair('V2 authority review');
  const registered = registerGrant(families, grant);
  const target = localTarget({ security: { identity: { mode: 'account' } } });
  const authorizationOwner = `mobile-device:${grant.deviceId}`;
  const principal = { principalId: randomUUID(), username: 'review-user', role: 'user' };
  const contexts = createAccountLoginContexts();
  contexts.publish(authorizationOwner, target.id, principal, {
    username: principal.username,
    password: 'review-only-placeholder',
  });
  const accountGeneration = contexts.generation(authorizationOwner, target.id);
  let currentTarget = target;
  let currentSelection = 'review-broker-target-a';
  const authority = captureAuthority({
    registration: registered,
    families,
    target,
    currentTarget: () => currentTarget,
    selection: currentSelection,
    currentSelection: () => currentSelection,
    contexts,
    authorizationOwner,
  });
  const fixture = brokerFixture(t);
  const client = fixture.attach(authority, authorizationOwner);
  await fixture.initialize(client, 'init-v2');
  assert.equal(client.messages.find(message => message.id === 'init-v2')?.result?.capabilities?.experimental
    ?.stagedAttachmentRetentionReceiptsV1, false,
  'the fake raw V1 bit does not enable staged retention for the public client');

  const params = {
    clientRequestId: 'review-intent-1',
    scopeId: 'review-scope-1',
    workspacePath: '/work/a',
    action: 'select',
  };
  const first = fixture.send(client, workspaceOpen('open-v2-1', params));
  assert.equal(first.writes.length, 1);
  const firstFrame = first.writes[0];
  assert.equal(firstFrame.method, 'runtime.workspaces.openV2');
  assert.deepEqual(firstFrame.params, params);
  assert.equal(Object.hasOwn(firstFrame.params, 'trustedContext'), false,
    'V2 uses its private envelope and leaves V1 trustedContext out of public params');
  for (const field of ['deviceId', 'workspaceAccount', 'workspaceTargetId']) {
    assert.equal(Object.hasOwn(firstFrame.params, field), false);
  }
  const firstEnvelope = firstFrame[PRIVATE_RETENTION_FIELD];
  assert.equal(firstEnvelope.version, 1);
  assert.equal(firstEnvelope.context.gatewayNamespaceId, grant.retentionNamespaceId);
  assert.equal(firstEnvelope.context.deviceId, grant.deviceId);
  assert.equal(firstEnvelope.context.authorizationGeneration, grant.authorizationGeneration);
  assert.equal(firstEnvelope.context.targetFingerprint,
    retentionTargetFingerprint(target, '/work/a', currentSelection));
  assert.deepEqual(firstEnvelope.context.principal,
    { kind: 'verifiedAccount', principalId: principal.principalId });
  assert.equal(firstEnvelope.workspaceTargetId, target.id,
    'workspace target is the registered Gateway target, not the Mobile device actor');
  assert.deepEqual(firstEnvelope.workspaceAccount, {
    role: 'user',
    authorizationGeneration: String(accountGeneration),
  });
  assert.notEqual(firstEnvelope.workspaceTargetId, firstEnvelope.context.deviceId);
  assert.equal(fixture.broker.pendingLoad.admitted, 1);
  assert.equal(fixture.broker.requestLoad.total.inFlight, 1);
  await fixture.reply(firstFrame);
  assert.equal(fixture.broker.pendingLoad.admitted, 0);
  assert.equal(fixture.broker.requestLoad.total.inFlight, 0);

  const refreshedGrant = await auth.refresh(grant.refreshToken, `v2-review-${randomUUID()}`);
  const refreshedRegistration = registerGrant(families, refreshedGrant);
  assert.strictEqual(refreshedRegistration.family, registered.family);
  assert.equal(refreshedGrant.deviceId, grant.deviceId);
  assert.equal(refreshedGrant.authorizationGeneration, grant.authorizationGeneration);
  assert.equal(refreshedGrant.retentionNamespaceId, grant.retentionNamespaceId);
  assert.equal(Boolean(grant.accessToken && refreshedGrant.accessToken && grant.accessToken !== refreshedGrant.accessToken), true,
    'fixture rotates access material without exposing it in assertions');
  const afterRotation = fixture.send(client, workspaceOpen('open-v2-2', {
    ...params,
    clientRequestId: 'review-intent-2',
    scopeId: 'review-scope-2',
  }));
  assert.equal(afterRotation.writes.length, 1);
  assert.deepEqual(afterRotation.writes[0][PRIVATE_RETENTION_FIELD], firstEnvelope,
    'ordinary access-token rotation preserves the same device/account/target authority tuple');
  await fixture.reply(afterRotation.writes[0]);

  const legacy = fixture.send(client, {
    jsonrpc: '2.0',
    id: 'legacy-read-1',
    method: 'attachment/retention/read',
    params: {
      selector: { by: 'clientRequestId', clientRequestId: 'r1.review-root.1.0123456789abcdef0123456789abcdef' },
      consumeAcks: [],
    },
  });
  assert.equal(legacy.writes.length, 1);
  assert.equal(legacy.writes[0].params.trustedContext.deviceId, grant.deviceId);
  assert.equal(legacy.writes[0].params.trustedContext.authorizationGeneration, grant.authorizationGeneration);
  assert.deepEqual(legacy.writes[0].params.trustedContext, firstEnvelope.context,
    'V1 trustedContext remains bound to the same verified device and account scope');
  assert.equal(legacy.writes[0][PRIVATE_RETENTION_FIELD].workspaceTargetId, target.id);
  assert.deepEqual(legacy.writes[0][PRIVATE_RETENTION_FIELD].workspaceAccount, firstEnvelope.workspaceAccount);
  assert.equal(Object.hasOwn(legacy.writes[0].params, 'workspaceTargetId'), false);
  assert.equal(Object.hasOwn(legacy.writes[0].params, 'workspaceAccount'), false,
    'private target/account attribution is never accepted through public V1 params');
  assert.equal(fixture.broker.pendingLoad.admitted, 1);
  await fixture.reply(legacy.writes[0]);
  assert.equal(fixture.broker.pendingLoad.admitted, 0);
  assert.equal(fixture.broker.requestLoad.total.inFlight, 0);
});

test('public V2 authority fields are rejected before stdio and the parent gate stays explicit', async t => {
  const directory = await privateStoreRoot(t);
  const families = new Map();
  const grant = await deviceAuth(directory).pair('V2 public input review');
  const registered = registerGrant(families, grant);
  const target = localTarget();
  const authority = captureAuthority({
    registration: registered,
    families,
    target,
    currentTarget: () => target,
    selection: 'review-broker-target-a',
    currentSelection: () => 'review-broker-target-a',
  });
  const fixture = brokerFixture(t);
  const client = fixture.attach(authority);
  await fixture.initialize(client, 'init-public-fields');

  const base = { clientRequestId: 'review-read', scopeId: 'review-scope' };
  const forgedFields = [
    ['deviceId', 'client-chosen-device'],
    ['workspaceTargetId', 'client-chosen-target'],
    ['workspaceAccount', { role: 'admin', authorizationGeneration: '9' }],
    ['trustedContext', { deviceId: 'client-chosen-device' }],
    [PRIVATE_RETENTION_FIELD, { version: 1, workspaceTargetId: 'client-chosen-target' }],
  ];
  let requestIndex = 0;
  for (const [field, value] of forgedFields) {
    const sent = fixture.send(client, receiptRead(`forged-${requestIndex++}`, { ...base, [field]: value }));
    assertRejectedWithoutUpstream(fixture, sent, -32602);
  }

  const disabledParent = brokerFixture(t, { retentionParentV1: false });
  const disabledClient = disabledParent.attach(authority);
  await disabledParent.initialize(disabledClient, 'init-parent-disabled');
  const disabled = disabledParent.send(disabledClient, receiptRead('parent-disabled', base));
  assertRejectedWithoutUpstream(disabledParent, disabled, -32001);
});

test('stale target, account generation, and revoked device fail closed without a null receipt', async t => {
  const directory = await privateStoreRoot(t);
  const auth = deviceAuth(directory);
  const families = new Map();
  const grant = await auth.pair('V2 stale scope review');
  const registered = registerGrant(families, grant);
  const target = localTarget({ security: { identity: { mode: 'account' } } });
  const authorizationOwner = `mobile-device:${grant.deviceId}`;
  const contexts = createAccountLoginContexts();
  const credential = { username: 'review-user', password: 'review-only-placeholder' };
  contexts.publish(authorizationOwner, target.id,
    { principalId: randomUUID(), username: credential.username, role: 'user' }, credential);
  let currentTarget = target;
  let currentSelection = 'review-broker-target-a';
  const makeAuthority = () => captureAuthority({
    registration: registered,
    families,
    target,
    currentTarget: () => currentTarget,
    selection: 'review-broker-target-a',
    currentSelection: () => currentSelection,
    contexts,
    authorizationOwner,
  });
  const fixture = brokerFixture(t);
  const targetClient = fixture.attach(makeAuthority(), authorizationOwner);
  await fixture.initialize(targetClient, 'init-stale-target');

  currentTarget = localTarget({
    ...target,
    command: '/opt/kcoder-reconfigured',
    security: target.security,
  });
  const targetMismatch = fixture.send(targetClient, receiptRead('stale-target', {
    clientRequestId: 'stale-target-intent', scopeId: 'old-target-scope',
  }));
  assertRejectedWithoutUpstream(fixture, targetMismatch, -32001);
  currentTarget = target;

  const accountClient = fixture.attach(makeAuthority(), authorizationOwner);
  await fixture.initialize(accountClient, 'init-stale-account');
  contexts.invalidate(authorizationOwner, target.id);
  const accountMismatch = fixture.send(accountClient, receiptRead('stale-account-generation', {
    clientRequestId: 'stale-account-intent', scopeId: 'old-account-scope',
  }));
  assertRejectedWithoutUpstream(fixture, accountMismatch, -32001);

  contexts.publish(authorizationOwner, target.id,
    { principalId: randomUUID(), username: credential.username, role: 'admin' }, credential);
  const revokedClient = fixture.attach(makeAuthority(), authorizationOwner);
  await fixture.initialize(revokedClient, 'init-revoked-device');
  await auth.revoke(grant.deviceId);
  const family = families.get(grant.deviceId);
  if (family?.timer) clearTimeout(family.timer);
  families.delete(grant.deviceId);
  contexts.invalidateOwner(authorizationOwner);
  await assert.rejects(
    auth.refresh(grant.refreshToken, `revoked-review-${randomUUID()}`),
    error => error.status === 401,
  );
  const revoked = fixture.send(revokedClient, receiptRead('revoked-device', {
    clientRequestId: 'revoked-device-intent', scopeId: 'revoked-scope',
  }));
  assertRejectedWithoutUpstream(fixture, revoked, -32001);
});
