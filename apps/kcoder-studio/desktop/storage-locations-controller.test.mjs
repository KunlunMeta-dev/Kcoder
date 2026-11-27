import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { join } from 'node:path';
import { registerStorageLocations } from './storage-locations-controller.mjs';

const PREFIX = 'kcoder:storage-locations:';
const LOCAL = 'http://127.0.0.1:3210';
const REMOTE = 'https://remote.example.invalid';

function fixture({ development = false, externallyConfigured = false, channelScope = '', handlers = new Map() } = {}) {
  const contents = { mainFrame: { url: `${LOCAL}/settings` } };
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => false,
  });
  const calls = { paths: 0, status: 0, originalStatus: [], preview: [], handoff: [], handoffOptions: [], dialogs: [], confirms: [], stops: [], cleanupPreview: [], cleanupConfirm: [] };
  const selected = {
    context: { development },
    paths: {
      dataRoot: join(process.cwd(), 'owned-data'),
      cacheRoot: join(process.cwd(), 'owned-cache'),
      externallyConfigured,
    },
  };
  let showDialog = async () => ({ canceled: true, filePaths: [] });
  let previewOperation = async input => ({ ...input, frozen: true });
  let handoffOperation = async plan => ({ operationId: plan.operationId, state: 'ready' });
  let confirmOperation = async () => true;
  let cleanupConfirmation = async input => ({ ...input, entries: [] });
  let readStatus = async operationId => operationId ? { plan: { operationId } } : null;
  const client = {
    paths: async () => { calls.paths++; return selected.paths; },
    status: async operationId => { calls.status++; if (operationId) calls.originalStatus.push(operationId); return readStatus(operationId); },
    preview: async input => { calls.preview.push(input); return previewOperation(input); },
    handoff: async (plan, options) => {
      calls.handoff.push(plan);
      calls.handoffOptions.push(options);
      return handoffOperation(plan, options);
    },
    cleanupPreview: async input => { calls.cleanupPreview.push(input); return { ...input, confirmation: 'c'.repeat(64), pending: false, entries: [] }; },
    cleanupConfirm: async input => { calls.cleanupConfirm.push(input); return cleanupConfirmation(input); },
  };
  const dispose = registerStorageLocations({
    ipcMain: {
      handle: (name, handler) => handlers.set(name, handler),
      removeHandler: name => handlers.delete(name),
    },
    dialog: {
      showOpenDialog: async (...args) => {
        calls.dialogs.push(args);
        return showDialog(...args);
      },
    },
    window,
    getGatewayOrigin: () => LOCAL,
    selected,
    client,
    confirmStop: async plan => { calls.confirms.push(plan); return confirmOperation(plan); },
    stopInstance: plan => calls.stops.push(plan),
    channelScope,
  });
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const invoke = (name, payload, suppliedEvent = event) =>
    handlers.get(`${PREFIX}${name}${channelScope ? `:${channelScope}` : ''}`)(suppliedEvent, payload);
  return {
    handlers, contents, window, event, invoke, calls, selected,
    setDialog: fn => { showDialog = fn; },
    setPreview: fn => { previewOperation = fn; },
    setHandoff: fn => { handoffOperation = fn; },
    setConfirm: fn => { confirmOperation = fn; },
    setStatus: fn => { readStatus = fn; },
    setCleanupConfirm: fn => { cleanupConfirmation = fn; },
    dispose,
  };
}

const request = () => ({ dataRoot: join(process.cwd(), 'owned-data'), cacheRoot: join(process.cwd(), 'owned-cache') });

test('secondary window channels preserve frame ownership and independent disposal', async t => {
  const handlers = new Map();
  const primary = fixture({ handlers });
  const secondary = fixture({ handlers, channelScope: 'owned-window' });
  t.after(primary.dispose); t.after(secondary.dispose);
  assert.equal((await secondary.invoke('read')).paths, secondary.selected.paths);
  await assert.rejects(secondary.invoke('read', undefined, primary.event), { code: 'STORAGE_LOCAL_HOST_REQUIRED' });
  await assert.rejects(primary.invoke('read', undefined, secondary.event), { code: 'STORAGE_LOCAL_HOST_REQUIRED' });
  primary.dispose();
  assert.equal(handlers.has(`${PREFIX}read`), false);
  assert.equal((await secondary.invoke('read')).paths, secondary.selected.paths);
  secondary.window.emit('closed');
  assert.equal(handlers.size, 0);
});

test('only the trusted local main frame can invoke storage location handlers', async t => {
  const f = fixture();
  t.after(f.dispose);
  const result = await f.invoke('read');
  assert.equal(result.readOnly, false);
  assert.equal(result.paths, f.selected.paths);
  assert.deepEqual([f.calls.paths, f.calls.status], [1, 1]);

  const foreignSender = { ...f.event, sender: {} };
  const childFrame = { ...f.event, senderFrame: { url: `${LOCAL}/settings` } };
  for (const event of [foreignSender, childFrame]) {
    await assert.rejects(f.invoke('pick', { kind: 'data' }, event), { code: 'STORAGE_LOCAL_HOST_REQUIRED' });
  }
  await assert.rejects(f.invoke('retry', { operationId: 'original-deferred' }, foreignSender), {
    code: 'STORAGE_LOCAL_HOST_REQUIRED',
  });
  f.contents.mainFrame.url = `${REMOTE}/settings`;
  await assert.rejects(f.invoke('preview', request()), { code: 'STORAGE_LOCAL_HOST_REQUIRED' });
  assert.equal(f.calls.dialogs.length, 0);
  assert.equal(f.calls.preview.length, 0);
  assert.equal(f.calls.handoff.length, 0);
  assert.equal(f.calls.originalStatus.length, 0);
});

test('external or development storage profiles are read-only', async t => {
  for (const options of [{ externallyConfigured: true }, { development: true }]) {
    const f = fixture(options);
    t.after(f.dispose);
    assert.equal((await f.invoke('read')).readOnly, true);
    await assert.rejects(f.invoke('pick', { kind: 'cache' }), { code: 'STORAGE_EXTERNAL_INSTANCE_READ_ONLY' });
    await assert.rejects(f.invoke('preview', request()), { code: 'STORAGE_EXTERNAL_INSTANCE_READ_ONLY' });
    await assert.rejects(f.invoke('migrate', { operationId: 'not-previewed' }), {
      code: 'STORAGE_EXTERNAL_INSTANCE_READ_ONLY',
    });
    await assert.rejects(f.invoke('retry', { operationId: 'original-deferred' }), {
      code: 'STORAGE_EXTERNAL_INSTANCE_READ_ONLY',
    });
    assert.equal(f.calls.dialogs.length, 0);
    assert.equal(f.calls.preview.length, 0);
    assert.equal(f.calls.handoff.length, 0);
    assert.equal(f.calls.stops.length, 0);
    assert.equal(f.calls.originalStatus.length, 0);
    await assert.rejects(f.invoke('cleanupPreview', { operationId: 'original-complete' }), { code: 'STORAGE_EXTERNAL_INSTANCE_READ_ONLY' });
    await assert.rejects(f.invoke('cleanupConfirm', { operationId: 'original-complete', confirmation: 'c'.repeat(64) }), { code: 'STORAGE_EXTERNAL_INSTANCE_READ_ONLY' });
    assert.equal(f.calls.cleanupPreview.length, 0);
    assert.equal(f.calls.cleanupConfirm.length, 0);
  }
});

test('cleanup requires the trusted frame and exact original preview token without stopping the instance', async t => {
  const f = fixture();
  t.after(f.dispose);
  const operationId = 'original-complete';
  const input = { operationId, confirmation: 'c'.repeat(64) };
  await assert.rejects(f.invoke('cleanupConfirm', input), { code: 'STORAGE_SOURCE_CLEANUP_PREVIEW_CHANGED' });
  const preview = await f.invoke('cleanupPreview', { operationId });
  assert.equal(preview.operationId, operationId);
  await assert.rejects(f.invoke('cleanupConfirm', { ...input, operationId: 'another-operation' }), { code: 'STORAGE_SOURCE_CLEANUP_PREVIEW_CHANGED' });
  await assert.rejects(f.invoke('cleanupConfirm', { ...input, confirmation: 'd'.repeat(64) }), { code: 'STORAGE_SOURCE_CLEANUP_PREVIEW_CHANGED' });
  await assert.rejects(f.invoke('cleanupPreview', { operationId, root: '/arbitrary' }), { code: 'STORAGE_OPERATION_INVALID' });
  await assert.rejects(f.invoke('cleanupConfirm', input, { ...f.event, senderFrame: { url: `${LOCAL}/settings` } }), { code: 'STORAGE_LOCAL_HOST_REQUIRED' });
  assert.equal(f.calls.cleanupConfirm.length, 0);
  const result = await f.invoke('cleanupConfirm', input);
  assert.equal(result.operationId, operationId);
  assert.deepEqual(f.calls.cleanupConfirm, [input]);
  assert.equal(f.calls.stops.length, 0);
  assert.equal(f.calls.handoff.length, 0);
  assert.equal(f.calls.confirms.length, 0);
});

test('an uncertain cleanup reply requires a new original preview and exposes only original receipt reads', async t => {
  const f = fixture();
  t.after(f.dispose);
  const operationId = 'original-complete';
  const preview = await f.invoke('cleanupPreview', { operationId });
  f.setCleanupConfirm(async () => { throw new Error('lost native cleanup reply'); });
  const input = { operationId, confirmation: preview.confirmation };
  await assert.rejects(f.invoke('cleanupConfirm', input), /lost native cleanup reply/);
  await assert.rejects(f.invoke('cleanupConfirm', input), { code: 'STORAGE_SOURCE_CLEANUP_PREVIEW_CHANGED' });
  assert.equal(f.calls.cleanupConfirm.length, 1);
  assert.deepEqual(await f.invoke('cleanupStatus', { operationId }), { plan: { operationId } });
  assert.deepEqual(f.calls.originalStatus, [operationId]);
  f.contents.mainFrame.url = `${REMOTE}/settings`;
  await assert.rejects(f.invoke('cleanupStatus', { operationId }), { code: 'STORAGE_LOCAL_HOST_REQUIRED' });
  assert.deepEqual(f.calls.originalStatus, [operationId]);
});

test('a cleanup reply without bounded entries remains unknown and cannot be replayed', async t => {
  const f = fixture();
  t.after(f.dispose);
  const operationId = 'original-complete';
  const preview = await f.invoke('cleanupPreview', { operationId });
  f.setCleanupConfirm(async input => ({ ...input }));
  const input = { operationId, confirmation: preview.confirmation };
  await assert.rejects(f.invoke('cleanupConfirm', input), { code: 'STORAGE_SOURCE_CLEANUP_UNKNOWN' });
  await assert.rejects(f.invoke('cleanupConfirm', input), { code: 'STORAGE_SOURCE_CLEANUP_PREVIEW_CHANGED' });
  assert.equal(f.calls.cleanupConfirm.length, 1);
});

test('picker cancellation returns no path and late native results are discarded after navigation', async t => {
  const f = fixture();
  t.after(f.dispose);
  f.setDialog(async () => ({ canceled: true, filePaths: ['/ignored'] }));
  assert.equal(await f.invoke('pick', { kind: 'data' }), null);
  assert.equal(f.calls.dialogs.length, 1);

  let resolveDialog;
  f.setDialog(() => new Promise(resolve => { resolveDialog = resolve; }));
  const pending = f.invoke('pick', { kind: 'cache' });
  await new Promise(resolve => setImmediate(resolve));
  f.contents.mainFrame.url = `${REMOTE}/settings`;
  resolveDialog({ canceled: false, filePaths: [join(process.cwd(), 'selected-cache')] });
  await assert.rejects(pending, { code: 'STORAGE_LOCAL_HOST_REQUIRED' });
  assert.equal(f.calls.dialogs.length, 2);
});

test('stale previews expire and migration requires confirmation for that exact operation id', async t => {
  const f = fixture();
  t.after(f.dispose);
  const pendingPreviews = [];
  f.setPreview(input => new Promise(resolve => pendingPreviews.push({ input, resolve })));
  const older = f.invoke('preview', request());
  await new Promise(resolve => setImmediate(resolve));
  const newer = f.invoke('preview', request());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pendingPreviews.length, 2);

  const currentPlan = { ...pendingPreviews[1].input, frozen: true };
  pendingPreviews[1].resolve(currentPlan);
  assert.equal(await newer, currentPlan);
  pendingPreviews[0].resolve({ ...pendingPreviews[0].input, frozen: true });
  await assert.rejects(older, { code: 'STORAGE_PREVIEW_CHANGED' });

  await assert.rejects(f.invoke('migrate', { operationId: pendingPreviews[0].input.operationId }), {
    code: 'STORAGE_PREVIEW_CHANGED',
  });
  const result = await f.invoke('migrate', { operationId: currentPlan.operationId });
  assert.deepEqual(result, { operationId: currentPlan.operationId, state: 'ready' });
  assert.equal(f.calls.confirms.length, 1);
  assert.equal(f.calls.handoff.length, 1);
  assert.equal(f.calls.handoff[0], currentPlan);
  assert.equal(f.calls.stops.length, 1);
  assert.equal(f.calls.stops[0], currentPlan);
});

test('cancelled confirmation never starts the one-shot helper or stops the instance', async t => {
  const f = fixture();
  t.after(f.dispose);
  f.setConfirm(async () => false);
  const plan = await f.invoke('preview', request());
  const ready = await f.invoke('migrate', { operationId: plan.operationId });
  assert.deepEqual(ready, { operationId: plan.operationId, state: 'cancelled' });
  assert.equal(f.calls.confirms.length, 1);
  assert.equal(f.calls.handoff.length, 0);
  assert.equal(f.calls.stops.length, 0);
});

test('stop happens only after matching readiness and an unknown reply is not completion', async t => {
  const f = fixture();
  t.after(f.dispose);
  const plan = await f.invoke('preview', request());
  let resolveHandoff;
  f.setHandoff(() => new Promise(resolve => { resolveHandoff = resolve; }));
  const pending = f.invoke('migrate', { operationId: plan.operationId });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.handoff.length, 1);
  assert.equal(f.calls.stops.length, 0);
  resolveHandoff({ operationId: plan.operationId, state: 'ready' });
  const ready = await pending;
  assert.deepEqual(ready, { operationId: plan.operationId, state: 'ready' });
  assert.equal(ready.state, 'ready');
  assert.equal(f.calls.stops.length, 1);

  const unknown = fixture();
  t.after(unknown.dispose);
  const unknownPlan = await unknown.invoke('preview', request());
  unknown.setHandoff(async () => ({ operationId: unknownPlan.operationId, state: 'complete' }));
  await assert.rejects(unknown.invoke('migrate', { operationId: unknownPlan.operationId }), {
    code: 'STORAGE_HANDOFF_UNCONFIRMED',
  });
  assert.equal(unknown.calls.stops.length, 0);
});

function deferredReceipt(operationId, overrides = {}) {
  const plan = {
    version: 1,
    operationId,
    original: { version: 1, revision: 4, dataRoot: '/old/data', cacheRoot: '/old/cache' },
    from: { layout: 'legacy', dataRoot: '/old/data', cacheRoot: '/old/cache', gatewayRoot: '/old/gateway', desktopRoot: '/old/desktop' },
    target: { version: 1, revision: 5, dataRoot: '/new/data', cacheRoot: '/new/cache', operationId },
    components: [{ domain: 'persistent-root', source: '/old/data', destination: '/new/data', sourceIdentity: 'source-id' }],
    targetBindings: [],
    launchIntent: 'desktop',
  };
  return { plan, phase: 'stopping', disposition: 'deferred', ownerReceipts: {}, errorCode: 'STORAGE_STOP_TIMEOUT', ...overrides };
}

test('reading Deferred state never retries; explicit retry rechecks and hands off the same original plan and id', async t => {
  const f = fixture();
  t.after(f.dispose);
  const operationId = 'original-deferred-operation';
  const receipt = deferredReceipt(operationId);
  f.setStatus(async id => id ? structuredClone(receipt) : receipt);

  const snapshot = await f.invoke('read');
  assert.equal(snapshot.operation.disposition, 'deferred');
  assert.equal(f.calls.handoff.length, 0);
  assert.equal(f.calls.originalStatus.length, 0);

  const result = await f.invoke('retry', { operationId });
  assert.deepEqual(result, { operationId, state: 'ready' });
  assert.deepEqual(f.calls.originalStatus, [operationId, operationId]);
  assert.deepEqual(f.calls.confirms, [receipt.plan]);
  assert.deepEqual(f.calls.handoff, [receipt.plan]);
  assert.deepEqual(f.calls.handoffOptions, [{ retry: true }]);
  assert.deepEqual(f.calls.stops, [receipt.plan]);
});

test('retry refuses an Active operation and a Deferred receipt that changes during host confirmation', async t => {
  const active = fixture();
  t.after(active.dispose);
  const operationId = 'original-active-operation';
  active.setStatus(async id => id ? deferredReceipt(operationId, { disposition: 'active' }) : null);
  await assert.rejects(active.invoke('retry', { operationId }));
  assert.deepEqual(active.calls.originalStatus, [operationId]);
  assert.equal(active.calls.confirms.length, 0);
  assert.equal(active.calls.handoff.length, 0);
  assert.equal(active.calls.stops.length, 0);

  const changed = fixture();
  t.after(changed.dispose);
  const original = deferredReceipt('original-deferred-operation');
  let reads = 0;
  changed.setStatus(async id => {
    if (!id) return null;
    reads++;
    return reads === 1 ? structuredClone(original) : deferredReceipt(original.plan.operationId, {
      phase: 'committed',
      plan: { ...original.plan, target: { ...original.plan.target, dataRoot: '/changed/target' } },
    });
  });
  await assert.rejects(changed.invoke('retry', { operationId: original.plan.operationId }));
  assert.deepEqual(changed.calls.originalStatus, [original.plan.operationId, original.plan.operationId]);
  assert.equal(changed.calls.confirms.length, 1);
  assert.equal(changed.calls.handoff.length, 0);
  assert.equal(changed.calls.stops.length, 0);
});

test('retry requires the original payload and host confirmation; cancellation never starts the retry worker', async t => {
  const f = fixture();
  t.after(f.dispose);
  const receipt = deferredReceipt('original-deferred-operation');
  f.setStatus(async id => id ? structuredClone(receipt) : null);
  f.setConfirm(async () => false);

  await assert.rejects(f.invoke('retry', { operationId: receipt.plan.operationId, plan: receipt.plan }));
  assert.equal(f.calls.originalStatus.length, 0);
  const result = await f.invoke('retry', { operationId: receipt.plan.operationId });
  assert.deepEqual(result, { operationId: receipt.plan.operationId, state: 'cancelled' });
  assert.deepEqual(f.calls.originalStatus, [receipt.plan.operationId]);
  assert.equal(f.calls.confirms.length, 1);
  assert.equal(f.calls.handoff.length, 0);
  assert.equal(f.calls.stops.length, 0);
});
