import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { observeNavigationSockets } from './navigation-socket-diagnostics.mjs';

const cancel = 'WebSocket is closed before the connection is established.';
const url = 'ws://127.0.0.1:32111/rpc?token=private-test-token&server=local&workspace=%2Fowned%2Fworkspace';

async function fixture() {
  const session = new EventEmitter();
  let loaderId = 'document-A';
  session.send = async method => method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main', loaderId } } } : {};
  session.detach = async () => {};
  const page = { context: () => ({ newCDPSession: async () => session }), reload: async () => {} };
  const observer = await observeNavigationSockets(page, { gatewayBaseUrl: 'http://127.0.0.1:32111', workspacePath: '/owned/workspace' });
  session.emit('Runtime.executionContextCreated', { context: { id: 7, auxData: { isDefault: true, frameId: 'main' } } });
  const created = (requestId = 'owned', value = url) => session.emit('Network.webSocketCreated', { requestId, url: value });
  const error = (requestId = 'owned', errorMessage = cancel) => session.emit('Network.webSocketFrameError', { requestId, errorMessage });
  const navigate = () => { loaderId = 'document-B'; session.emit('Page.frameNavigated', { frame: { id: 'main', loaderId } }); };
  const lifecycle = (kind, ipcBridgeAvailable, executionContextId = 7) => session.emit('Runtime.bindingCalled', {
    name: '__kcoderE2eNavigationLifecycle', executionContextId,
    payload: JSON.stringify({ kind, ipcBridgeAvailable, at: 100, timeOrigin: 1 }),
  });
  const capture = (active = true, context = 7) => lifecycle('beforeunload-capture', active, context);
  const retire = (active = false) => lifecycle('beforeunload-after-bootstrap-listeners', active);
  return { session, page, observer, created, error, navigate, capture, retire };
}

test('only an owned old-document CONNECTING socket in the explicit reload snapshot is expected', async () => {
  const f = await fixture();
  f.created();
  f.page.reload = async () => { f.capture(); f.retire(); f.navigate(); f.error(); };
  await f.observer.reload();
  assert.equal(f.observer.errors.length, 1);
  assert.equal(f.observer.errors[0].disposition, 'expected-owned-reload-teardown');
  assert.equal(f.observer.errors[0].socketDocumentEpoch, 0);
  assert.equal(f.observer.errors[0].currentDocumentEpoch, 1);
  assert.equal(f.observer.snapshot().navigations[0].status, 'completed');
  assert.equal(JSON.stringify(f.observer.snapshot()).includes('private-test-token'), false);
});

test('new document, OPEN, unknown, late-created, wrong route, changed reason and non-navigation errors stay unexpected', async () => {
  for (const scenario of ['new-document', 'open', 'handshake-error', 'frame-sent', 'unknown', 'late-created', 'wrong-workspace', 'wrong-target', 'wrong-channel', 'different-reason', 'not-navigation', 'after-reload', 'already-closed', 'missing-capture', 'missing-retire', 'missing-commit', 'already-retired', 'unproven-retire', 'unknown-context']) {
    const f = await fixture();
    if (scenario !== 'unknown' && scenario !== 'late-created') f.created('owned',
      scenario === 'wrong-workspace' ? url.replace('%2Fowned%2Fworkspace', '%2Fother') :
      scenario === 'wrong-target' ? url.replace('server=local', 'server=peer') :
      scenario === 'wrong-channel' ? `${url}&channel=browser` : url);
    if (scenario === 'open' || scenario === 'handshake-error') f.session.emit('Network.webSocketHandshakeResponseReceived', { requestId: 'owned', response: { status: scenario === 'open' ? 101 : 403 } });
    if (scenario === 'frame-sent') f.session.emit('Network.webSocketFrameSent', { requestId: 'owned' });
    if (scenario === 'already-closed') f.session.emit('Network.webSocketClosed', { requestId: 'owned' });
    f.page.reload = async () => {
      if (scenario !== 'missing-capture') f.capture(scenario !== 'already-retired', scenario === 'unknown-context' ? 99 : 7);
      if (scenario === 'late-created') f.created();
      if (scenario === 'new-document') { f.retire(); f.navigate(); f.created(); }
      if (scenario !== 'not-navigation' && scenario !== 'after-reload') f.error('owned', scenario === 'different-reason' ? 'Connection refused' : cancel);
      if (scenario !== 'missing-retire' && scenario !== 'new-document') f.retire(scenario === 'unproven-retire');
      if (scenario !== 'missing-commit') f.navigate();
    };
    if (scenario !== 'not-navigation') await f.observer.reload();
    if (scenario === 'not-navigation' || scenario === 'after-reload') f.error();
    assert.equal(f.observer.errors.length, 1, scenario);
    assert.equal(f.observer.errors[0].disposition, 'unexpected', scenario);
  }
});

test('live old-document creation before the actual capture is ordered even in the same wall-clock millisecond', async context => {
  context.mock.method(Date, 'now', () => 100);
  const f = await fixture();
  f.page.reload = async () => { f.created(); f.capture(); f.retire(); f.error(); f.navigate(); };
  await f.observer.reload();
  const snapshot = f.observer.snapshot(), reload = snapshot.navigations[0];
  assert.deepEqual(reload.pendingSocketIds, []);
  assert.deepEqual(reload.unloadCapture.pendingSocketIds, ['socket-1']);
  assert.equal(snapshot.sockets[0].createdAt, snapshot.lifecycle[0].at);
  assert.ok(snapshot.sockets[0].createdOrdinal < reload.unloadCapture.ordinal);
  assert.equal(f.observer.errors[0].disposition, 'expected-owned-reload-teardown');
});

test('a failed explicit navigation remains failed and never retries the page', async () => {
  const f = await fixture();
  let reloads = 0;
  f.created();
  f.page.reload = async () => { reloads++; f.capture(); f.retire(); f.error(); throw new Error('navigation failed'); };
  await assert.rejects(f.observer.reload(), /navigation failed/);
  assert.equal(reloads, 1);
  assert.equal(f.observer.snapshot().navigations[0].status, 'failed');
  assert.equal(f.observer.errors.length, 1);
  assert.equal(f.observer.errors[0].disposition, 'unexpected');
});

test('passive initiators redact URL credentials and lifecycle events require a real execution-context owner', async () => {
  const f = await fixture();
  f.session.emit('Network.webSocketCreated', { requestId: 'stack', url, initiator: { stack: { callFrames: [
    { functionName: 'connectAndInitialize', url: 'http://127.0.0.1:32111/assets/client.js?token=private-test-token', lineNumber: 5, columnNumber: 9 },
  ] } } });
  f.session.emit('Runtime.executionContextCreated', { context: { id: 7, auxData: { isDefault: true, frameId: 'main' } } });
  const payload = JSON.stringify({ kind: 'beforeunload-capture', at: 100, timeOrigin: 1, ipcBridgeAvailable: true });
  f.session.emit('Runtime.bindingCalled', { name: '__kcoderE2eNavigationLifecycle', executionContextId: 7, payload });
  f.session.emit('Runtime.bindingCalled', { name: '__kcoderE2eNavigationLifecycle', executionContextId: 99, payload });
  const snapshot = f.observer.snapshot();
  assert.equal(snapshot.lifecycle[0].epoch, 0);
  assert.equal(snapshot.lifecycle[1].epoch, null);
  assert.deepEqual(snapshot.sockets[0].initiator, [{ functionName: 'connectAndInitialize', source: '/assets/client.js', line: 6, column: 10 }]);
  assert.equal(JSON.stringify(snapshot).includes('private-test-token'), false);
  f.error('stack');
  assert.equal(f.observer.errors[0].disposition, 'unexpected');
});


test('modern ordinary runtime observation routes are recognized without broadening unknown query fields', async () => {
  for (const value of ['none', '170e8a76-03af-463a-a72c-1f3bbb492a80', 'invalid', 'none&extra=1']) {
    const f = await fixture(); f.created('modern', `${url}&channelObserver=${value}`);
    assert.equal(f.observer.snapshot().sockets[0].route.matches,
      ['none', '170e8a76-03af-463a-a72c-1f3bbb492a80'].includes(value), value);
    assert.equal(JSON.stringify(f.observer.snapshot()).includes('private-test-token'), false);
    await f.observer.stop();
  }
});

test('late CDP frame delivery retains its actual send time and original document across navigation', async () => {
  const f = await fixture(); f.created();
  f.session.emit('Page.lifecycleEvent', {name: 'init', frameId: 'main', loaderId: 'document-A', timestamp: 10});
  f.session.emit('Page.lifecycleEvent', {name: 'init', frameId: 'main', loaderId: 'document-B', timestamp: 20});
  f.navigate();
  for (const timestamp of [19, 21]) f.session.emit('Network.webSocketFrameSent', {requestId:'owned', timestamp,
    response:{payloadData:JSON.stringify({id:1,method:'runtime.models.list',params:{workspacePath:'/private/path',token:'private-test-token'}})}});
  const snapshot = f.observer.snapshot(), socket = snapshot.sockets[0];
  assert.equal(snapshot.documents[1].startedAtMonotonic, 20);
  assert.equal(socket.documentEpoch, 0);
  assert.deepEqual(socket.sentReads.map(row => row.sentAtMonotonic), [19, 21]);
  assert.ok(socket.sentReads[0].ordinal > snapshot.documents[1].ordinal,
    'delivery order is deliberately different from physical timestamp order');
  assert.equal(JSON.stringify(snapshot).includes('/private/path'), false);
  assert.equal(JSON.stringify(snapshot).includes('private-test-token'), false);
  await f.observer.stop();
});

test('read timing is bounded and omits payloads, arbitrary commands and unrelated methods', async () => {
  const f = await fixture(); f.created();
  for (let i=0;i<129;i++) f.session.emit('Network.webSocketFrameSent', {requestId:'owned',timestamp:i,
    response:{payloadData:JSON.stringify({id:1,method:'device/execute',params:{command_key:'git_branch',text:'private-test-token'}})}});
  f.session.emit('Network.webSocketFrameSent', {requestId:'owned',timestamp:130,
    response:{payloadData:JSON.stringify({id:2,method:'device/execute',params:{command_key:'private-test-token'}})}});
  f.session.emit('Network.webSocketFrameSent', {requestId:'owned',timestamp:131,
    response:{payloadData:JSON.stringify({id:3,method:'turn/start',params:{text:'private-test-token'}})}});
  const snapshot=f.observer.snapshot();
  assert.equal(snapshot.sockets[0].sentReads.length,128);
  assert.equal(snapshot.overflow,1);
  assert.equal(JSON.stringify(snapshot).includes('private-test-token'),false);
  await f.observer.stop();
});
