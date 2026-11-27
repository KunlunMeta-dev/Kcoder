import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  const surfaces = { desktopWeb: true, terminal: false };
  assert.equal(await access.update({ expectedRevision: 1, surfaces }), 409);
  assert.equal(await access.update({ expectedRevision: 0, surfaces }), 200);
  assert.equal(sockets.terminal.destroyed, true);
  assert.equal(sockets.desktopWeb.destroyed, undefined);
  assert.equal(access.track('terminal', new EventEmitter()), false);
  assert.deepEqual((await loadGatewayPublicAccess(directory)).state, { revision: 1, surfaces });
  assert.equal(publicRequestSurface('/rpc', { deviceId: 'old' }, true), 'terminal');
  assert.equal(publicRequestSurface('/rpc', { deviceId: 'web', surface: 'mobileWeb' }, true), null);
});

test('a saved restriction on durable clients survives loading a legacy access policy', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-public-access-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  await writeFile(join(directory, 'public-access.json'), JSON.stringify({revision:9, surfaces:{desktopWeb:true,mobileWeb:true,mobileApp:false}}), {mode:0o600});
  const access = await loadGatewayPublicAccess(directory);
  assert.deepEqual(access.state, {revision:9, surfaces:{desktopWeb:true,terminal:false}});
  assert.equal(access.allows('terminal'), false);
});
