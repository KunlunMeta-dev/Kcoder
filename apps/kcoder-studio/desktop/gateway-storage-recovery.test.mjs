import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGateway } from './gateway-process.mjs';
import { createGatewayDeviceAuth } from '../src/gateway-device-auth.js';

test('Gateway retains paired devices and browser login across restart', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-gateway-storage-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const token = randomBytes(32).toString('hex');
  const auth = createGatewayDeviceAuth({ directory, identity: token });
  const device = await auth.pair('Isolated recovery fixture');
  const cookie = randomBytes(32).toString('hex');
  const persistence = await auth.browserSessions();
  await persistence.save(cookie, { browserAdmin: true, expiresAt: Date.now() + 3_600_000, allowedServerIds: ['local'] });
  const root = join(directory, 'mobile-device-auth');
  const key = await readFile(join(root, '.key'));
  const storedDevice = JSON.parse(await readFile(join(root, 'devices.json'), 'utf8')).devices.find(row => row.id === device.deviceId);
  const options = {
    // The override permits acceptance against an isolated copy of installed code.
    // The default exercises the current checkout under the normal desktop host.
    gatewayScript: process.env.KCODER_STUDIO_STORAGE_TEST_GATEWAY_SCRIPT || undefined,
    env: { KCODER_STUDIO_MOCK: '1', KCODER_STUDIO_SERVERS_STORE: join(directory, 'servers.json'),
      KCODER_STUDIO_DATA_DIR: directory, KCODER_STUDIO_RELAY_SECRET: '', KCODER_STUDIO_MOBILE_PAIRING_TOKEN: '',
      KCODER_STUDIO_SERVERS_FILE: '', KCODER_STUDIO_PUBLIC_URL: '', KCODER_RELAY_GATEWAY_TOKEN: '',
      KCODER_STUDIO_P2P: '0', KCODER_STUDIO_DESKTOP_PUBLIC_GATEWAY: '' },
    token, timeoutMs: 30_000,
  };
  let gateway;
  t.after(async () => { await gateway?.stop(); });
  for (let restart = 0; restart < 2; restart++) {
    gateway = await startGateway(options);
    const denied = await fetch(`${gateway.baseUrl}/api/servers`);
    assert.equal(denied.status, 401, 'recovery must not bypass authentication');
    const restored = await fetch(`${gateway.baseUrl}/api/servers`, { headers: { cookie: `kcoder_studio_session=${cookie}` } });
    assert.equal(restored.status, 200, 'the original browser login must survive recovery and restart');
    assert.deepEqual(await readFile(join(root, '.key')), key, 'the installation key must not change');
    const store = JSON.parse(await readFile(join(root, 'devices.json'), 'utf8'));
    assert.deepEqual(store.devices.find(row => row.id === device.deviceId), storedDevice, 'paired device authority must be preserved');
    assert.ok(store.browserSessions.some(row => row.idHash === createHash('sha256').update(cookie).digest('hex')));
    await gateway.stop();
    gateway = undefined;
  }
});
