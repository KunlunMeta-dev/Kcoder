import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

const dedicated = ['approvalToolCallIdentityV1', 'disableUserElicitationV1', 'threadMcpServersV1', 'migrationSourceTransferPrivateCredentialBundlesV1', 'migrationSourceTransferPrivateCredentialSourceObservationV1'];
const initialize = (experimental = {}) => ({ protocolVersion: '2026-07-27',
  clientInfo: { name: 'dedicated-capability-fixture', version: '1' }, capabilities: { experimental } });

function fixture(options = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, residentThreads: true,
    maxMessageBytes: 1024 * 1024, serverId: 'dedicated-capability-fixture',
    adapter: { rawPassthrough: true, toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) }, ...options });
  const requests = []; let pending = '';
  child.stdin.on('data', chunk => {
    pending += chunk.toString('utf8');
    while (pending.includes('\n')) {
      const end = pending.indexOf('\n'); requests.push(JSON.parse(pending.slice(0, end))); pending = pending.slice(end + 1);
    }
  });
  const client = (options = {}) => {
    const value = { channel: 'runtime', authorizationOwner: 'same-workspace', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {}, ...options };
    broker.attach(value); return value;
  };
  const request = async (owner, id, method, params) => {
    broker.receive(owner, JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    await new Promise(resolve => setImmediate(resolve)); return requests.at(-1);
  };
  const emit = async message => {
    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    await new Promise(resolve => setImmediate(resolve));
  };
  const respond = (id, result) => emit({ id, result });
  return { broker, requests, client, request, respond, emit };
}

test('one client cannot enable native-only policies on a backend shared with peers', async () => {
  const f = fixture();
  try {
    const restricted = f.client(); const peer = f.client();
    for (const capability of dedicated) {
      await f.request(restricted, capability, 'initialize', initialize({ [capability]: true }));
      assert.equal(restricted.messages.at(-1).error.code, -32602);
      assert.equal(restricted.initialized, false);
      assert.equal(f.requests.length, 0, 'a rejected offer must never mutate the shared backend');
    }
    const upstream = await f.request(peer, 'peer', 'initialize', initialize(Object.fromEntries(dedicated.map(name => [name, false]))));
    for (const name of dedicated) assert.equal(Object.hasOwn(upstream.params.capabilities.experimental, name), false);
    await f.respond(upstream.id, { protocolVersion: '2026-07-27', capabilities: {
      approvals: true, questions: true, experimental: { residentThreads: true, ...Object.fromEntries(dedicated.map(name => [name, true])) },
    } });
    assert.equal(peer.initialized, true);
    assert.equal(peer.messages.at(-1).result.capabilities.questions, true);
    for (const name of dedicated) assert.equal(Object.hasOwn(peer.messages.at(-1).result.capabilities.experimental, name), false);
    await f.request(restricted, 'legacy-retry', 'initialize', initialize());
    assert.equal(restricted.initialized, true);
    for (const name of dedicated) assert.equal(Object.hasOwn(restricted.messages.at(-1).result.capabilities.experimental, name), false);
  } finally { f.broker.clearTransientState(); }
});

test('a legacy first client cannot leave later first-party inputs without Native interaction binding', async () => {
  for (const firstOffer of [{}, { interactionBindingV1: false }]) {
    const f = fixture();
    try {
      const legacy = f.client();
      const upstream = await f.request(legacy, 'legacy-first', 'initialize', initialize(firstOffer));
      assert.equal(upstream.params.capabilities.experimental.interactionBindingV1, true);
      await f.respond(upstream.id, { protocolVersion: '2026-07-27', capabilities: { experimental: {
        residentThreads: true, integrationScopeV1: true, taskSourcesV1: true, interactionBindingV1: true,
      } } });
      const current = f.client();
      await f.request(current, 'later-current', 'initialize', initialize({ taskSourcesV1: true, interactionBindingV1: true }));
      assert.equal(current.messages.at(-1).result.capabilities.experimental.interactionBindingV1, true);
      assert.equal(f.requests.filter(request => request.method === 'initialize').length, 1);
    } finally { f.broker.clearTransientState(); }
  }
});

test('private temporary MCP launch data is rejected before forwarding through a shared broker', async () => {
  const f = fixture();
  try {
    const owner = f.client();
    const upstream = await f.request(owner, 'init', 'initialize', initialize());
    await f.respond(upstream.id, { protocolVersion: '2026-07-27', capabilities: { experimental: { residentThreads: true, threadMcpServersV1: true } } });
    const before = f.requests.length;
    await f.request(owner, 'private', 'thread/start', { mcpServers: [{ name: 'host', command: '/private/command', env: { TOKEN: 'synthetic-private-value' } }] });
    assert.equal(owner.messages.at(-1).error.code, -32602);
    assert.equal(f.requests.length, before);
    assert.equal(JSON.stringify(owner.messages.at(-1)).includes('synthetic-private-value'), false);
    await f.request(owner, 'legacy', 'thread/start', { mcpServers: [] });
    assert.equal(f.requests.at(-1).method, 'thread/start');
  } finally { f.broker.clearTransientState(); }
});

test('shared native memory handlers require each client to negotiate its own integration capabilities', async () => {
  const f = fixture();
  try {
    const legacy = f.client();
    const upstream = await f.request(legacy, 'legacy-init', 'initialize', initialize());
    assert.equal(upstream.params.capabilities.experimental.integrationScopeV1, true);
    await f.respond(upstream.id, { protocolVersion: '2026-07-27', capabilities: { experimental: {
      residentThreads: true, integrationScopeV1: true, memoryReviewV1: true,
    } } });
    assert.equal(legacy.messages.at(-1).result.capabilities.experimental.integrationScopeV1, false);
    assert.equal(legacy.messages.at(-1).result.capabilities.experimental.memoryReviewV1, false);
    let before = f.requests.length;
    await f.request(legacy, 'legacy-scope', 'integrations/scope/read', {});
    assert.equal(f.requests.length, before);
    assert.ok(legacy.messages.at(-1).error);

    const current = f.client();
    await f.request(current, 'current-init', 'initialize', initialize({ integrationScopeV1: true, memoryReviewV1: true }));
    assert.equal(current.messages.at(-1).result.capabilities.experimental.memoryReviewV1, true);
    const request = await f.request(current, 'current-scope', 'integrations/scope/read', {});
    assert.equal(request.method, 'integrations/scope/read');
    await f.respond(request.id, { accountId:'native-account', targetId:'native-target', workspaceId:null,
      identityGeneration:'generation', targetRevision:'revision' });
    before = f.requests.length;
    await f.request(current, 'forged-selector', 'integrations/scope/read', { accountId:'SYNTHETIC_PRIVATE_VALUE' });
    assert.equal(f.requests.length, before);
    assert.ok(current.messages.at(-1).error);
    assert.equal(JSON.stringify(current.messages.at(-1)).includes('SYNTHETIC_PRIVATE_VALUE'), false);
  } finally { f.broker.clearTransientState(); }
});


test('SDK management preserves task opt-outs independently of normal shared runtime capabilities', async () => {
  for (const shared of [false, true]) {
    const f = fixture({ nativeManagementOnly: !shared });
    try {
      const client = f.client();
      const upstream = await f.request(client, 'control-init', 'initialize', initialize({
        gatewaySharedThreadsV1: shared, taskSourcesV1: false, threadRuntimeHandoffV1: false, connectivityV1: true,
      }));
      assert.equal(f.requests.length, 1);
      assert.equal(upstream.params.capabilities.experimental.taskSourcesV1, shared);
      assert.equal(upstream.params.capabilities.experimental.threadRuntimeHandoffV1, shared);
      assert.equal(upstream.params.capabilities.experimental.connectivityV1, true);
    } finally { f.broker.clearTransientState(); }
  }
});

test('SDK management requires a marked control transport and cannot execute task commands', async () => {
  const task = fixture();
  const sdk = fixture({ nativeManagementOnly: true });
  try {
    const taskClient = task.client();
    const first = await task.request(taskClient, 'task-init', 'initialize', initialize());
    await task.respond(first.id, { capabilities: { experimental: { residentThreads: true } } });
    const misplaced = task.client();
    const flags = { taskSourcesV1: false, threadRuntimeHandoffV1: false, connectivityV1: true };
    await task.request(misplaced, 'misplaced-sdk', 'initialize', initialize(flags));
    assert.equal(misplaced.messages.at(-1).error.code, -32602);
    assert.equal(task.requests.length, 1, 'An SDK client cannot reuse the task initialization cache');
    const sdkClient = sdk.client();
    const admin = await sdk.request(sdkClient, 'sdk-init', 'initialize', initialize(flags));
    await sdk.respond(admin.id, { capabilities: { experimental: { residentThreads: true, connectivityV1: true } } });
    await sdk.request(sdkClient, 'forbidden-task', 'thread/start', {});
    assert.equal(sdkClient.messages.at(-1).error.code, -32601);
    assert.equal(sdk.requests.length, 1, 'Task creation never reaches SDK management');
    assert.equal(taskClient.initialized, true, 'The original task client remains initialized');
  } finally { task.broker.clearTransientState(); sdk.broker.clearTransientState(); }
});

test('the channel owner shares its backend with a restricted management client', async () => {
  const f = fixture({ ownsChannelHost: true, residentThreads: undefined });
  try {
    const control = f.client({ nativeManagementOnly: true });
    const flags = { taskSourcesV1: false, threadRuntimeHandoffV1: false, connectivityV1: true, integrationScopeV1: true };
    const upstream = await f.request(control, 'control-init', 'initialize', initialize(flags));
    assert.equal(f.broker.acceptsClient, true, 'The original owner remains attachable during negotiation');
    assert.equal(upstream.params.capabilities.experimental.taskSourcesV1, true);
    assert.equal(upstream.params.capabilities.experimental.threadRuntimeHandoffV1, true);
    await f.respond(upstream.id, { capabilities: { experimental: { residentThreads: true,
      connectivityV1: true, integrationScopeV1: true, taskSourcesV1: true, threadRuntimeHandoffV1: true } } });
    assert.equal(control.initialized, true);
    assert.equal(control.messages.at(-1).result.capabilities.experimental.threadRuntimeHandoffV1, false);
    const peer = f.client();
    await f.request(peer, 'task-init', 'initialize', initialize({ threadRuntimeHandoffV1: true }));
    assert.equal(peer.initialized, true);
    assert.equal(peer.messages.at(-1).result.capabilities.experimental.threadRuntimeHandoffV1, true);
    assert.equal(f.requests.length, 1);

    const scope = await f.request(control, 'scope', 'integrations/scope/read', {});
    assert.equal(scope.method, 'integrations/scope/read');
    await f.respond(scope.id, { accountId: 'account', targetId: 'target', workspaceId: null,
      identityGeneration: 'identity', targetRevision: 'revision' });
    assert.equal(control.messages.at(-1).result.targetId, 'target');
    for (const method of ['thread/start', 'gateway/thread/attach', 'gateway/app-server/restart']) {
      await f.request(control, method, method, {});
      assert.equal(control.messages.at(-1).error.code, -32601);
    }
    const before = control.messages.length;
    await f.emit({ method: 'automation/runStarted', params: { threadId: 'task' } });
    assert.equal(peer.messages.at(-1).method, 'automation/runStarted');
    assert.equal(control.messages.length, before);
    assert.equal(f.requests.length, 2);
  } finally { f.broker.clearTransientState(); }
});
