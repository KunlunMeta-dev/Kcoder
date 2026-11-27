import test from 'node:test';
import assert from 'node:assert/strict';
import { mayReloadColdStaticPage } from './task-workspace-static-reload.mjs';
test('only one owned static network GET failure before every RPC/action admits a document reread', () => {
  const original = { origin: 'http://127.0.0.1:12345', failures: [{ url: 'http://127.0.0.1:12345/assets/module.js', method: 'GET', error: 'net::ERR_NETWORK_CHANGED' }], rpcCount: 0, userActions: 0, reloads: 0 };
  assert.equal(mayReloadColdStaticPage(original), true);
  for (const patch of [{ rpcCount: 1 }, { userActions: 1 }, { reloads: 1 }, { failures: [] },
    { failures: [{ ...original.failures[0], method: 'POST' }] },
    { failures: [{ ...original.failures[0], url: 'http://foreign/assets/module.js' }] },
    { failures: [{ ...original.failures[0], error: 'net::ERR_CONNECTION_REFUSED' }] }])
    assert.equal(mayReloadColdStaticPage({ ...original, ...patch }), false);
});
