import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadGatewayPublicAccess, publicRequestSurface } from './gateway-public-access.js';

test('closing one public surface disconnects only that surface and survives restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-public-access-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const access = await loadGatewayPublicAccess(directory);
  const sockets = Object.fromEntries(Object.keys(access.state.surfaces).map(surface => {
    const socket = new EventEmitter();
    socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
    assert.equal(access.track(surface, socket), true);
    return [surface, socket];
  }));
  const surfaces = { desktopWeb: true, mobileWeb: true, mobileApp: false };
  assert.equal(await access.update({ expectedRevision: 1, surfaces }), 409);
  assert.equal(await access.update({ expectedRevision: 0, surfaces }), 200);
  assert.equal(sockets.mobileApp.destroyed, true);
  assert.equal(sockets.mobileWeb.destroyed, undefined);
  assert.equal(sockets.desktopWeb.destroyed, undefined);
  assert.equal(access.track('mobileApp', new EventEmitter()), false);
  assert.deepEqual((await loadGatewayPublicAccess(directory)).state, { revision: 1, surfaces });
  assert.equal(publicRequestSurface('/rpc', { deviceId: 'old' }, true), 'mobileApp');
  assert.equal(publicRequestSurface('/rpc', { deviceId: 'web', surface: 'mobileWeb' }, true), 'mobileWeb');
});
