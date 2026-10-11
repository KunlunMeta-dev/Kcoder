import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
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
import {
  appServerEnvironment,
  launchSpec,
  PRIVATE_RETENTION_PARENT_ENV_V1,
  workspaceReceiptParentAttempt,
} from '../src/server-config.js';
import { authenticatedAccountProcess } from '../src/account-process.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const rotation = suffix => `retention-review-${suffix}`;

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-retention-authority-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function deviceAuth(directory, authToken = '') {
  return createMobileDeviceAuth({
    directory,
    identity: mobileDeviceStoreIdentity(authToken),
    accessTtlMs: 60_000,
    idleTtlMs: 600_000,
    absoluteTtlMs: 1_200_000,
    socketGraceMs: 30_000,
  });
}

function registerGrant(families, payload) {
  return registerMobileDeviceGrantState({
    families,
    payload,
    allowedServerIds: ['target-a', 'target-b'],
  });
}

function localTarget(overrides = {}) {
  return {
    id: 'target-a',
    label: 'Local target',
    runtime: 'kcoder',
    transport: 'local',
    command: '/opt/kcoder',
    cwd: '/work/a',
    profile: 'default',
    settingsFile: '/config/settings.json',
    ...overrides,
  };
}

function authorityFor({ session, families, target, currentTarget, selection, currentSelection,
  workspacePath = '/work/a', accountIdentity, accountGeneration, includeWorkspaceAccount = true }) {
  return captureRetentionAuthority({
    session,
    familyFor: deviceId => families.get(deviceId),
    target,
    currentTarget,
    brokerSelection: selection,
    currentBrokerSelection: currentSelection,
    workspacePath,
    accountIdentity,
    accountGeneration,
    includeWorkspaceAccount,
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
    attach(retentionAuthority, authorizationOwner = 'device-owner') {
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
    async initialize(client, id, experimental = { residentThreads: true, stagedAttachmentRetentionReceiptsV1: true }) {
      const before = frames.length;
      broker.receive(client, JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize',
        params: { capabilities: { experimental } } }));
      if (frames.length > before) {
        const request = frames.at(-1);
        assert.equal(request.method, 'initialize');
        child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id,
          result: { capabilities: { experimental } } })}\n`);
        await tick();
      }
      assert.equal(client.initialized, true);
    },
    send(client, rawOrMessage) {
      const before = frames.length;
      broker.receive(client, typeof rawOrMessage === 'string' ? rawOrMessage : JSON.stringify(rawOrMessage));
      return { writes: frames.slice(before), lastMessage: client.messages.at(-1) };
    },
    async reply(frame, result = { ok: true }) {
      child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result })}\n`);
      await tick();
    },
  };
}

const operationId = 'r1.review-root.1.0123456789abcdef0123456789abcdef';
const stageRef = (index, path = `/staged/review-${index}`) => ({
  rootNamespace: 'review-root', epoch: 1, ownerId: 'review-owner',
  entryId: `stage-${index}`, revision: 1, path,
});
const reserveParams = stageRefs => ({ clientRequestId: operationId, threadId: 'review-thread', stageRefs });

function retentionRead(id, params = { selector: { by: 'clientRequestId', clientRequestId: operationId } }) {
  return { jsonrpc: '2.0', id, method: 'attachment/retention/read', params };
}

test('no-auth restart keeps the real device family while tokens rotate; installation keys separate namespaces', async t => {
  const directory = await temporaryRoot(t);
  const firstGatewayToken = randomUUID();
  const firstIdentity = mobileDeviceStoreIdentity('');
  const firstAuth = deviceAuth(directory);
  const paired = await firstAuth.pair('no-auth review device');
  const families = new Map();
  const registeredPair = registerGrant(families, paired);

  assert.equal(registeredPair.session.deviceId, paired.deviceId);
  assert.equal(registeredPair.session.authorizationGeneration, paired.authorizationGeneration);
  assert.equal(registeredPair.family.authorizationGeneration, paired.authorizationGeneration);
  assert.equal(Object.hasOwn(registeredPair.publicPayload, 'retentionNamespaceId'), false);
  assert.equal(Object.hasOwn(registeredPair.publicPayload, 'stableLoginOwner'), false);

  const liveRefresh = await firstAuth.refresh(paired.refreshToken, rotation('live-0001'));
  const registeredLiveRefresh = registerGrant(families, liveRefresh);
  assert.strictEqual(registeredLiveRefresh.family, registeredPair.family);
  assert.equal(liveRefresh.deviceId, paired.deviceId);
  assert.equal(liveRefresh.authorizationGeneration, paired.authorizationGeneration);
  assert.equal(liveRefresh.retentionNamespaceId, paired.retentionNamespaceId);
  assert.notEqual(liveRefresh.accessToken, paired.accessToken);
  assert.notEqual(liveRefresh.refreshToken, paired.refreshToken);

  const restartedGatewayToken = randomUUID();
  assert.notEqual(restartedGatewayToken, firstGatewayToken);
  assert.equal(mobileDeviceStoreIdentity(''), firstIdentity);
  const restartedAuth = deviceAuth(directory);
  const refreshed = await restartedAuth.refresh(liveRefresh.refreshToken, rotation('restart-0001'));
  const postRestartFamilies = new Map();
  const registeredRefresh = registerGrant(postRestartFamilies, refreshed);

  assert.equal(refreshed.deviceId, paired.deviceId);
  assert.equal(refreshed.authorizationGeneration, paired.authorizationGeneration);
  assert.equal(refreshed.retentionNamespaceId, paired.retentionNamespaceId);
  assert.notEqual(refreshed.accessToken, liveRefresh.accessToken);
  assert.notEqual(refreshed.refreshToken, liveRefresh.refreshToken);
  assert.notStrictEqual(registeredRefresh.family, registeredPair.family, 'a process restart creates a new in-memory family from the durable grant');
  assert.equal(registeredRefresh.session.authorizationGeneration, registeredPair.session.authorizationGeneration);

  const secondDevice = await restartedAuth.pair('second family');
  const registeredSecond = registerGrant(postRestartFamilies, secondDevice);
  assert.equal(secondDevice.retentionNamespaceId, paired.retentionNamespaceId);
  assert.notEqual(registeredSecond.session.deviceId, registeredPair.session.deviceId);
  assert.notEqual(registeredSecond.session.authorizationGeneration, registeredPair.session.authorizationGeneration);

  const otherDirectory = await temporaryRoot(t);
  const otherInstallation = await deviceAuth(otherDirectory).pair('other installation');
  assert.notEqual(otherInstallation.retentionNamespaceId, paired.retentionNamespaceId);
});

test('auth configuration rotation and the no-auth sentinel collision revoke old devices without changing namespace', async t => {
  const authDirectory = await temporaryRoot(t);
  const configuredA = await deviceAuth(authDirectory, 'gateway-config-token-a').pair('configured family');
  const configuredB = await deviceAuth(authDirectory, 'gateway-config-token-b').pair('after config rotation');
  assert.equal(configuredB.retentionNamespaceId, configuredA.retentionNamespaceId);
  assert.notEqual(configuredB.deviceId, configuredA.deviceId);
  assert.notEqual(configuredB.authorizationGeneration, configuredA.authorizationGeneration);
  await assert.rejects(
    deviceAuth(authDirectory, 'gateway-config-token-b').refresh(configuredA.refreshToken, rotation('old-auth-token-0001')),
    error => error.status === 401,
  );

  const collisionDirectory = await temporaryRoot(t);
  const noAuthIdentity = mobileDeviceStoreIdentity('');
  const sentinel = 'kcoder.mobile-device-auth.no-auth.v1';
  assert.notEqual(noAuthIdentity, mobileDeviceStoreIdentity(sentinel));
  assert.throws(() => mobileDeviceStoreIdentity('\0not-an-environment-token'));
  const noAuthGrant = await deviceAuth(collisionDirectory).pair('before mode change');
  const sentinelAuth = deviceAuth(collisionDirectory, sentinel);
  const afterModeChange = await sentinelAuth.pair('after mode change');
  assert.equal(afterModeChange.retentionNamespaceId, noAuthGrant.retentionNamespaceId);
  assert.notEqual(afterModeChange.deviceId, noAuthGrant.deviceId);
  await assert.rejects(
    sentinelAuth.refresh(noAuthGrant.refreshToken, rotation('mode-change-0001')),
    error => error.status === 401,
  );
});

test('actual grant registration feeds each cached-broker frame its own current device and target scope', async t => {
  const directory = await temporaryRoot(t);
  const auth = deviceAuth(directory);
  const families = new Map();
  const grantA = await auth.pair('family A');
  const registeredA = registerGrant(families, grantA);
  let currentTarget = localTarget();
  let currentSelection = 'broker-selection-a';
  const makeAuthority = (registration, target = currentTarget, selection = currentSelection) => authorityFor({
    session: registration.session,
    families,
    target,
    currentTarget: () => currentTarget,
    selection,
    currentSelection: () => currentSelection,
    workspacePath: '/work/a',
  });

  const f = brokerFixture(t);
  const clientA = f.attach(makeAuthority(registeredA));
  await f.initialize(clientA, 1);
  const first = f.send(clientA, retentionRead(2));
  assert.equal(first.writes.length, 1);
  assert.equal(first.writes[0].method, 'attachment/retention/read');
  const firstContext = first.writes[0].params.trustedContext;
  assert.equal(firstContext.gatewayNamespaceId, grantA.retentionNamespaceId);
  assert.equal(firstContext.deviceId, grantA.deviceId);
  assert.equal(firstContext.authorizationGeneration, grantA.authorizationGeneration);
  assert.equal(firstContext.targetFingerprint, retentionTargetFingerprint(currentTarget, '/work/a', 'broker-selection-a'));
  assert.deepEqual(firstContext.principal, { kind: 'localOs' });
  assert.deepEqual(first.writes[0][PRIVATE_RETENTION_FIELD], { version: 1, context: firstContext, workspaceTargetId: currentTarget.id });
  await f.reply(first.writes[0]);

  const refreshedGrantA = await auth.refresh(grantA.refreshToken, rotation('broker-refresh-01'));
  const refreshedA = registerGrant(families, refreshedGrantA);
  assert.strictEqual(refreshedA.family, registeredA.family);
  const afterRotation = f.send(clientA, retentionRead(3));
  assert.equal(afterRotation.writes.length, 1);
  assert.deepEqual(afterRotation.writes[0].params.trustedContext, firstContext);
  await f.reply(afterRotation.writes[0]);

  const grantB = await auth.pair('family B');
  const registeredB = registerGrant(families, grantB);
  const clientB = f.attach(makeAuthority(registeredB), 'device-B-owner');
  const countBeforeCachedInitialize = f.frames.length;
  await f.initialize(clientB, 10);
  assert.equal(f.frames.length, countBeforeCachedInitialize, 'second device shares only the initialized broker response');
  const second = f.send(clientB, retentionRead(11));
  assert.equal(second.writes.length, 1);
  const secondContext = second.writes[0].params.trustedContext;
  assert.equal(secondContext.gatewayNamespaceId, firstContext.gatewayNamespaceId);
  assert.notEqual(secondContext.deviceId, firstContext.deviceId);
  assert.notEqual(secondContext.authorizationGeneration, firstContext.authorizationGeneration);
  assert.equal(secondContext.targetFingerprint, firstContext.targetFingerprint);
  await f.reply(second.writes[0]);

  const oldFamilyStillOwnsOnlyItsScope = f.send(clientA, retentionRead(12));
  assert.equal(oldFamilyStillOwnsOnlyItsScope.writes.length, 1);
  assert.deepEqual(oldFamilyStillOwnsOnlyItsScope.writes[0].params.trustedContext, firstContext);
  await f.reply(oldFamilyStillOwnsOnlyItsScope.writes[0]);

  currentTarget = localTarget({ command: '/opt/kcoder-reconfigured' });
  currentSelection = 'broker-selection-after-target-change';
  const stale = f.send(clientA, retentionRead(13));
  assert.equal(stale.writes.length, 0);
  assert.equal(stale.lastMessage.error.code, -32001);

  const newTargetAuthority = makeAuthority(registeredB, currentTarget, currentSelection);
  const clientAfterTargetChange = f.attach(newTargetAuthority, 'device-B-owner-new-target');
  const countBeforeTargetInitialize = f.frames.length;
  await f.initialize(clientAfterTargetChange, 20);
  assert.equal(f.frames.length, countBeforeTargetInitialize);
  const targetBound = f.send(clientAfterTargetChange, retentionRead(21));
  assert.equal(targetBound.writes.length, 1);
  assert.notEqual(targetBound.writes[0].params.trustedContext.targetFingerprint, firstContext.targetFingerprint);
});

test('account principal and role changes invalidate a captured broker authority', async t => {
  const directory = await temporaryRoot(t);
  const families = new Map();
  const registered = registerGrant(families, await deviceAuth(directory).pair('account family'));
  const contexts = createAccountLoginContexts();
  const owner = 'verified-account-owner';
  const target = localTarget({ security: { identity: { mode: 'account' } } });
  const firstPrincipal = { principalId: 'ab87c7c1-34bd-4fb0-a309-11f086d08d09', username: 'alice', role: 'user' };
  const credential = { username: 'alice', password: 'private-review-password' };
  contexts.publish(owner, target.id, firstPrincipal, credential);
  let currentTarget = target;
  let currentSelection = 'account-broker-a';
  const makeAuthority = () => authorityFor({
    session: registered.session,
    families,
    target,
    currentTarget: () => currentTarget,
    selection: 'account-broker-a',
    currentSelection: () => currentSelection,
    workspacePath: '/work/a',
    accountIdentity: () => contexts.identity(owner, target.id),
    accountGeneration: () => contexts.generation(owner, target.id),
  });
  const f = brokerFixture(t);
  const firstClient = f.attach(makeAuthority(), owner);
  await f.initialize(firstClient, 1);
  const first = f.send(firstClient, retentionRead(2));
  assert.equal(first.writes.length, 1);
  assert.deepEqual(first.writes[0].params.trustedContext.principal,
    { kind: 'verifiedAccount', principalId: firstPrincipal.principalId });
  await f.reply(first.writes[0]);

  contexts.publish(owner, target.id, { ...firstPrincipal, role: 'admin' }, credential);
  const roleStale = f.send(firstClient, retentionRead(3));
  assert.equal(roleStale.writes.length, 0);
  assert.equal(roleStale.lastMessage.error.code, -32001);

  const afterRoleClient = f.attach(makeAuthority(), owner);
  const countBeforeInitialize = f.frames.length;
  await f.initialize(afterRoleClient, 4);
  assert.equal(f.frames.length, countBeforeInitialize);
  const afterRole = f.send(afterRoleClient, retentionRead(5));
  assert.equal(afterRole.writes.length, 1);
  await f.reply(afterRole.writes[0]);

  const secondPrincipal = { principalId: 'bc98d8d2-45ce-40b1-a40b-221f19e19e1a', username: 'alice', role: 'admin' };
  contexts.publish(owner, target.id, secondPrincipal, credential);
  const principalStale = f.send(afterRoleClient, retentionRead(6));
  assert.equal(principalStale.writes.length, 0);
  assert.equal(principalStale.lastMessage.error.code, -32001);

  const currentPrincipalClient = f.attach(makeAuthority(), owner);
  await f.initialize(currentPrincipalClient, 7);
  const currentPrincipal = f.send(currentPrincipalClient, retentionRead(8));
  assert.equal(currentPrincipal.writes.length, 1);
  assert.deepEqual(currentPrincipal.writes[0].params.trustedContext.principal,
    { kind: 'verifiedAccount', principalId: secondPrincipal.principalId });
});

test('workspace receipt capability is projected for the first response, waiters, and cached initialize', async t => {
  const f = brokerFixture(t);
  const authorized = f.attach(() => ({ workspaceTargetId: 'target-a' }));
  f.broker.receive(authorized, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
  const backendInitialize = f.frames.at(-1);
  assert.equal(backendInitialize.method, 'initialize');

  const missingAuthority = f.attach(() => null);
  f.broker.receive(missingAuthority, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }));
  assert.equal(f.frames.length, 1, 'the second initialize waits on the same child response');
  await f.reply(backendInitialize, { capabilities: { experimental: {
    residentThreads: true,
    workspaceOperationReceiptsV2: true,
    stagedAttachmentRetentionReceiptsV1: true,
  } } });

  const receiptCapability = client => client.messages.find(message => message.id === (client === authorized ? 1 : 2))
    ?.result?.capabilities?.experimental;
  assert.equal(receiptCapability(authorized).workspaceOperationReceiptsV2, true);
  assert.equal(receiptCapability(authorized).stagedAttachmentRetentionReceiptsV1, false);
  assert.equal(receiptCapability(missingAuthority).workspaceOperationReceiptsV2, false);
  assert.equal(receiptCapability(missingAuthority).stagedAttachmentRetentionReceiptsV1, false);

  const cachedAuthorized = f.attach(() => ({ workspaceTargetId: 'target-a' }));
  const frameCount = f.frames.length;
  await f.initialize(cachedAuthorized, 3);
  assert.equal(f.frames.length, frameCount, 'cached initialize does not start another child request');
  const cachedCapabilities = cachedAuthorized.messages.find(message => message.id === 3)
    ?.result?.capabilities?.experimental;
  assert.equal(cachedCapabilities.workspaceOperationReceiptsV2, true);
  assert.equal(cachedCapabilities.stagedAttachmentRetentionReceiptsV1, false);
});

test('parent-disabled Gateway rejects V2 workspace calls before any child write', async t => {
  const f = brokerFixture(t, { retentionParentV1: false });
  const client = f.attach(() => ({ workspaceTargetId: 'target-a' }));
  await f.initialize(client, 1, {
    residentThreads: true,
    workspaceOperationReceiptsV2: true,
    stagedAttachmentRetentionReceiptsV1: true,
  });
  const capabilities = client.messages.find(message => message.id === 1)
    ?.result?.capabilities?.experimental;
  assert.equal(capabilities.workspaceOperationReceiptsV2, false);
  assert.equal(capabilities.stagedAttachmentRetentionReceiptsV1, false);

  const before = f.frames.length;
  const attempt = f.send(client, {
    jsonrpc: '2.0', id: 2, method: 'runtime.workspaces.operation/scopeV2', params: {},
  });
  assert.equal(f.frames.length, before);
  assert.equal(attempt.writes.length, 0);
  assert.equal(attempt.lastMessage.error.code, -32001);
});

test('backend V2 capability off blocks V2 writes but leaves ordinary V1 retention forwarding available', async t => {
  const directory = await temporaryRoot(t);
  const families = new Map();
  const registered = registerGrant(families, await deviceAuth(directory).pair('backend capability off'));
  const target = localTarget();
  const authority = authorityFor({
    session: registered.session,
    families,
    target,
    currentTarget: () => target,
    selection: 'backend-capability-off-broker',
    currentSelection: () => 'backend-capability-off-broker',
    workspacePath: '/work/a',
    includeWorkspaceAccount: true,
  });
  const f = brokerFixture(t, { retentionParentV1: true });
  const client = f.attach(authority);
  await f.initialize(client, 1, {
    residentThreads: true,
    workspaceOperationReceiptsV2: false,
    stagedAttachmentRetentionReceiptsV1: true,
  });
  const capabilities = client.messages.find(message => message.id === 1)
    ?.result?.capabilities?.experimental;
  assert.equal(capabilities.workspaceOperationReceiptsV2, false);

  const before = f.frames.length;
  const workspaceAttempt = f.send(client, {
    jsonrpc: '2.0', id: 2, method: 'runtime.workspaces.operation/scopeV2', params: {},
  });
  assert.equal(f.frames.length, before);
  assert.equal(workspaceAttempt.writes.length, 0);
  assert.equal(workspaceAttempt.lastMessage.error.code, -32001);

  const legacyRead = f.send(client, retentionRead(3));
  assert.equal(legacyRead.writes.length, 1, 'legacy V1 forwarding is independent from the V2 capability bit');
  assert.equal(legacyRead.writes[0].method, 'attachment/retention/read');
  assert.equal(legacyRead.writes[0].params.trustedContext.deviceId, registered.session.deviceId);
  assert.deepEqual(legacyRead.writes[0].params.trustedContext.principal, { kind: 'localOs' });
  assert.deepEqual(legacyRead.writes[0].kcoderPrivateRetention.context,
    legacyRead.writes[0].params.trustedContext);
  await f.reply(legacyRead.writes[0]);
});

test('external private fields are rejected before stdio, while the authorized batch bound is 32', async t => {
  const directory = await temporaryRoot(t);
  const families = new Map();
  const registered = registerGrant(families, await deviceAuth(directory).pair('extension review'));
  const target = localTarget();
  const authority = authorityFor({
    session: registered.session,
    families,
    target,
    currentTarget: () => target,
    selection: 'extension-broker',
    currentSelection: () => 'extension-broker',
    workspacePath: '/work/a',
  });

  const legacy = brokerFixture(t, { retentionParentV1: false });
  const legacyClient = legacy.attach(authority);
  await legacy.initialize(legacyClient, 1);
  const unavailable = legacy.send(legacyClient, retentionRead(2));
  assert.equal(unavailable.writes.length, 0);
  assert.equal(unavailable.lastMessage.error.code, -32001);

  const f = brokerFixture(t);
  const client = f.attach(authority);
  await f.initialize(client, 10);
  const reservedObject = f.send(client, {
    jsonrpc: '2.0', id: 11, method: 'attachment/retention/read',
    params: { nested: [{ [PRIVATE_RETENTION_FIELD]: { version: 1 } }] },
  });
  assert.equal(reservedObject.writes.length, 0);
  assert.equal(reservedObject.lastMessage.error.code, -32602);

  const duplicateRaw = '{"jsonrpc":"2.0","id":12,"method":"attachment/retention/read","params":{"trustedContext":{"untrusted":true},"trustedContext":{"second":true}}}';
  const duplicate = f.send(client, duplicateRaw);
  assert.equal(duplicate.writes.length, 0);
  assert.equal(duplicate.lastMessage.error.code, -32602);

  const escapedRaw = String.raw`{"jsonrpc":"2.0","id":13,"method":"attachment/retention/read","params":{"\u0074rustedContext":{}}}`;
  const escaped = f.send(client, escapedRaw);
  assert.equal(escaped.writes.length, 0);
  assert.equal(escaped.lastMessage.error.code, -32602);

  const ordinaryString = f.send(client, {
    jsonrpc: '2.0', id: 14, method: 'attachment/retention/reserve',
    params: reserveParams([stageRef(0, 'trustedContext and kcoderPrivateRetention are text, not fields')]),
  });
  assert.equal(ordinaryString.writes.length, 1);
  await f.reply(ordinaryString.writes[0]);

  const legalBatch = f.send(client, {
    jsonrpc: '2.0', id: 15, method: 'attachment/retention/reserve',
    params: reserveParams(Array.from({ length: 32 }, (_, index) => stageRef(index))),
  });
  assert.equal(legalBatch.writes.length, 1);
  assert.equal(legalBatch.writes[0].params.stageRefs.length, 32);
  await f.reply(legalBatch.writes[0]);

  const oversizedBatch = f.send(client, {
    jsonrpc: '2.0', id: 16, method: 'attachment/retention/reserve',
    params: reserveParams(Array.from({ length: 33 }, (_, index) => stageRef(index))),
  });
  assert.equal(oversizedBatch.writes.length, 0);
  assert.equal(oversizedBatch.lastMessage.error.code, -32602);
});

function processFixture() {
  const child = new EventEmitter();
  const writes = [];
  child.stdin = new Writable({ write(chunk, _encoding, callback) { writes.push(Buffer.from(chunk)); callback(); } });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; };
  return { child, writes };
}

test('legacy launch stays parent-disabled; only explicit internal account startup carries the strict marker', async t => {
  const local = localTarget();
  const localDefault = launchSpec(local, { platform: 'linux' });
  assert.equal(localDefault.args.includes('--retention-parent-v1'), false);
  assert.equal(localDefault.env, undefined);

  const ssh = { id: 'target-b', runtime: 'kcoder', transport: 'ssh', host: 'build.example', command: 'kcoder' };
  assert.equal(launchSpec(ssh, { platform: 'linux' }).args.includes('--retention-parent-v1'), false);
  const explicitLocal = launchSpec(local, { platform: 'linux', retentionParentV1: true });
  assert.deepEqual(explicitLocal.args.slice(-2), ['--retention-parent-v1', 'local-os']);
  const accountTarget = { ...ssh, security: { identity: { mode: 'account' } } };
  assert.equal(launchSpec(accountTarget, { platform: 'linux', retentionParentV1: true }).args.includes('--retention-parent-v1'), false);
  const accountTargetForAttempt = { ...ssh, security: { identity: { mode: 'kcoder-account', username: 'alice' } } };
  assert.equal(workspaceReceiptParentAttempt(local, 'linux'), true);
  assert.equal(workspaceReceiptParentAttempt(local, 'darwin'), false);
  assert.equal(workspaceReceiptParentAttempt(ssh, 'linux'), false);
  assert.equal(workspaceReceiptParentAttempt(accountTargetForAttempt, 'linux'), true);

  const scrubbed = appServerEnvironment({ PATH: '/bin', [PRIVATE_RETENTION_PARENT_ENV_V1]: 'ambient', KCODER_STUDIO_SECRET: 'private' }, {
    [PRIVATE_RETENTION_PARENT_ENV_V1.toLowerCase()]: 'case-variant',
  });
  assert.deepEqual(scrubbed, { PATH: '/bin' });
  const internal = appServerEnvironment({ PATH: '/bin', [PRIVATE_RETENTION_PARENT_ENV_V1]: 'ambient' }, {}, 'localOs');
  const inheritedParent = internal[PRIVATE_RETENTION_PARENT_ENV_V1];
  assert.equal(inheritedParent.startsWith('v1.'), true);
  assert.deepEqual(JSON.parse(Buffer.from(inheritedParent.slice(3), 'base64url').toString('utf8')),
    { version: 1, mode: 'localOs' });
  assert.throws(() => appServerEnvironment({ PATH: '/bin' }, {}, 'verifiedAccount'));

  const defaultProcess = processFixture();
  const defaultProxy = authenticatedAccountProcess(defaultProcess.child,
    { username: 'alice', password: 'private-review-password', workspace: '/srv/project' });
  t.after(() => { defaultProcess.child.emit('close', 0, null); defaultProcess.child.stdout.destroy(); defaultProcess.child.stderr.destroy(); });
  const defaultHandshake = JSON.parse(defaultProcess.writes[0].toString('utf8'));
  assert.equal(Object.hasOwn(defaultHandshake, 'retentionParentV1'), false);
  defaultProcess.child.stdout.write(`${JSON.stringify({ protocol: 'kcoder-account-v1', authenticated: true,
    username: 'alice', principalId: 'ab87c7c1-34bd-4fb0-a309-11f086d08d09', uid: 2001, role: 'user' })}\n`);
  await tick();

  const accountProcess = processFixture();
  let authenticatedIdentity;
  let invalidOutput = '';
  const accountProxy = authenticatedAccountProcess(accountProcess.child,
    { username: 'alice', password: 'private-review-password', workspace: '/srv/project' }, {
      retentionParentV1: true,
      onAuthenticated: identity => { authenticatedIdentity = identity; },
    });
  t.after(() => { accountProcess.child.emit('close', 0, null); accountProcess.child.stdout.destroy(); accountProcess.child.stderr.destroy(); });
  accountProxy.stdout.on('data', chunk => { invalidOutput += chunk.toString('utf8'); });
  const accountHandshake = JSON.parse(accountProcess.writes[0].toString('utf8'));
  assert.equal(accountHandshake.retentionParentV1, true);
  assert.equal(accountHandshake.username, 'alice');
  assert.equal(accountHandshake.workspace, '/srv/project');
  assert.throws(() => authenticatedAccountProcess(processFixture().child,
    { username: 'alice', password: 'private-review-password' }, { retentionParentV1: 'true' }));

  accountProxy.on('error', () => {});
  accountProcess.child.stdout.write(`${JSON.stringify({ protocol: 'kcoder-account-v1', authenticated: true,
    username: 'alice', principalId: 'ab87c7c1-34bd-4fb0-a309-11f086d08d09', uid: 0, role: 'root' })}\n{"jsonrpc":"2.0","id":1,"result":{}}\n`);
  await tick();
  assert.equal(accountProcess.child.killed, true);
  assert.equal(authenticatedIdentity, undefined);
  assert.equal(invalidOutput, '');

  const validAccountProcess = processFixture();
  let validIdentity;
  const validProxy = authenticatedAccountProcess(validAccountProcess.child,
    { username: 'alice', password: 'private-review-password' }, {
      retentionParentV1: true,
      onAuthenticated: identity => { validIdentity = identity; },
    });
  t.after(() => { validAccountProcess.child.emit('close', 0, null); validAccountProcess.child.stdout.destroy(); validAccountProcess.child.stderr.destroy(); });
  validProxy.on('error', () => {});
  validAccountProcess.child.stdout.write(`${JSON.stringify({ protocol: 'kcoder-account-v1', authenticated: true,
    username: 'alice', principalId: 'bc98d8d2-45ce-40b1-a40b-221f19e19e1a', uid: 2001, role: 'admin' })}\n`);
  await tick();
  assert.deepEqual(validIdentity, { principalId: 'bc98d8d2-45ce-40b1-a40b-221f19e19e1a', username: 'alice', role: 'admin' });
});


const retainedUploadIds = () => ({
  ownerRequest: { clientOwnerRequestId: 'o1.root.1.0123456789abcdef0123456789abcdef', immutableParameters: { purpose: 'upload' } },
  clientUploadId: 'u1.root.1.0123456789abcdef0123456789abcdef',
});
async function retainedUploadAuthority(t) {
  const directory = await temporaryRoot(t); const families = new Map();
  const registered = registerGrant(families, await deviceAuth(directory).pair('typed upload fixture'));
  const target = localTarget();
  const authority = authorityFor({ session: registered.session, families, target, currentTarget: () => target,
    selection: 'upload-broker', currentSelection: () => 'upload-broker' });
  return { authority, registered };
}
test('typed retained uploads inject current private scope for all six methods and fence late replies', async t => {
  const { authority, registered } = await retainedUploadAuthority(t); const f = brokerFixture(t);
  const client = f.attach(authority); await f.initialize(client, 1);
  assert.equal(client.messages.find(message => message.id === 1)?.result.capabilities.experimental.stagedAttachmentRetentionReceiptsV1, false);
  const digest = '00'.repeat(32); const content = { filename: 'input.txt', size: 1, contentSha256: digest };
  const methods = [['start', content], ['save', { ...content, contentBase64: 'YQ==' }], ['read', {}],
    ['chunk', { offset: 0, length: 1, chunkSha256: digest, contentBase64: 'YQ==' }], ['finish', {}], ['cancel', {}]];
  for (let i = 0; i < methods.length; i += 1) {
    const [phase, fields] = methods[i]; const id = 10 + i;
    const forwarded = f.send(client, { jsonrpc: '2.0', id, method: `attachment/retention/upload/${phase}`,
      params: { ...retainedUploadIds(), ...fields } });
    assert.equal(forwarded.writes.length, 1, phase);
    const frame = forwarded.writes[0];
    assert.equal(frame[PRIVATE_RETENTION_FIELD].workspaceTargetId, 'target-a');
    assert.equal(frame.params.trustedContext.deviceId, registered.session.deviceId);
    assert.equal(frame.params.trustedContext.authorizationGeneration, registered.session.authorizationGeneration);
    assert.deepEqual(frame.params.trustedContext, frame[PRIVATE_RETENTION_FIELD].context);
    await f.reply(frame, { phase });
    assert.deepEqual(client.messages.at(-1).result, { phase });
  }
  const held = f.send(client, { jsonrpc: '2.0', id: 20, method: 'attachment/retention/upload/read', params: retainedUploadIds() });
  assert.equal(held.writes.length, 1);
  registered.family.authorizationGeneration = 'revoked-generation';
  await f.reply(held.writes[0], { state: 'sealed', stageRef: { entryId: 'must-not-forward' } });
  assert.equal(client.messages.at(-1).error.code, -32001);
  assert.equal(Object.hasOwn(client.messages.at(-1), 'result'), false);
});
test('typed retained uploads reject forged duplicate and notification inputs without child writes', async t => {
  const { authority } = await retainedUploadAuthority(t); const f = brokerFixture(t); const client = f.attach(authority);
  await f.initialize(client, 1);
  const request = { jsonrpc: '2.0', id: 2, method: 'attachment/retention/upload/read', params: retainedUploadIds() };
  assert.equal(f.send(client, { ...request, params: { ...request.params, trustedContext: {} } }).writes.length, 0);
  const raw = JSON.stringify(request).replace('"clientUploadId":', '"clientUploadId":"forged", "clientUploadId":');
  assert.equal(f.send(client, raw).writes.length, 0);
  assert.equal(client.messages.at(-1).error.code, -32602);
  const { id, ...notification } = request;
  assert.equal(f.send(client, notification).writes.length, 0);
});
test('typed retained uploads stay unavailable when raw backend capability is false', async t => {
  const { authority } = await retainedUploadAuthority(t); const f = brokerFixture(t); const client = f.attach(authority);
  await f.initialize(client, 1, { residentThreads: true, stagedAttachmentRetentionReceiptsV1: false });
  const refused = f.send(client, { jsonrpc: '2.0', id: 2, method: 'attachment/retention/upload/read', params: retainedUploadIds() });
  assert.equal(refused.writes.length, 0);
  assert.ok(refused.lastMessage.error);
});


// Uses the existing actual grant/capture/Broker fixture, not a mirrored response gate.
for (const changeTargetBeforeReply of [false, true]) {
  test(`scoped retained wrapper ${changeTargetBeforeReply ? 'rejects changed authority' : 'preserves complete result'}`, async t => {
    const directory = await temporaryRoot(t);
    const families = new Map();
    const grant = await deviceAuth(directory).pair('scoped wrapper');
    const registration = registerGrant(families, grant);
    const captured = localTarget(); let target = captured;
    const authority = authorityFor({ session: registration.session, families,
      target: captured, currentTarget: () => target, selection: 'wrapper-selection',
      currentSelection: () => 'wrapper-selection', workspacePath: '/work/a' });
    const f = brokerFixture(t); const client = f.attach(authority);
    await f.initialize(client, 'scoped-init');
    const sent = f.send(client, retentionRead('scoped-read'));
    assert.equal(sent.writes.length, 1);
    assert.equal(sent.writes[0][PRIVATE_RETENTION_FIELD].workspaceTargetId, captured.id);
    const result = { scopeId: 'a'.repeat(64), result: { receipt: null } };
    if (changeTargetBeforeReply) target = { ...captured, command: '/opt/other-kcoder' };
    await f.reply(sent.writes[0], result);
    const response = client.messages.find(message => message.id === 'scoped-read');
    assert.ok(response);
    if (changeTargetBeforeReply) {
      assert.equal(response.error?.code, -32001); assert.equal('result' in response, false);
    } else {
      assert.deepEqual(response.result, result);
      assert.equal(response.error, undefined);
    }
  });
}
