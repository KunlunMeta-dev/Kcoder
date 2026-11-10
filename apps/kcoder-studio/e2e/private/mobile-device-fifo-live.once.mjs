import assert from 'node:assert/strict';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { repoRoot, runE2E } from '../harness/run-context.mjs';

const base = 'https://49.234.36.54:8451/g/hmr-preview-20261014';
const pairingFile = '/tmp/kcoder-mobile-hmr-preview-20261014/gateway/mobile-one-click-login-url.txt';
if (process.env.KCODER_E2E_LIVE_FIFO_PAIR !== '1') throw new Error('Explicit live FIFO pairing gate required');
process.umask(0o077);

await runE2E(import.meta.url, {
  testId: 'mobile-device-fifo-live-once', tier: 'manual-live',
  modelPolicy: 'One authorized public pairing, read-only device/server checks, revoke only the probe grant; no model or thread actions',
}, async run => {
  const info = await lstat(pairingFile);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 &&
    info.uid === process.getuid() && (info.mode & 0o077) === 0 && info.size < 16384);
  const canonical = await realpath(pairingFile);
  assert.ok(!canonical.startsWith(repoRoot + '/'));
  const url = new URL((await readFile(pairingFile, 'utf8')).trim());
  assert.equal(url.origin + url.pathname, base + '/mobile/connect');
  assert.equal(url.searchParams.get('gateway'), base);
  const token = new URLSearchParams(url.hash.slice(1)).get('token');
  assert.ok(token && /^[A-Za-z0-9_-]{32,512}$/.test(token));
  run.registerSecret(token);
  run.registerSecret(encodeURIComponent(token));
  let accessToken, revocation;
  const report = { paired: false, pairingHttpStatus: null, devices: null, serverInventoryRead: false, cleanup: 'not-needed' };
  const revoke = () => revocation ??= (async () => {
    const response = await fetch(base + '/api/mobile/session', {
      method: 'DELETE', headers: { authorization: 'Bearer ' + accessToken }, signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 204, 'Probe grant revocation must be confirmed');
    report.cleanup = 'revoked';
  })();
  let requestDispatched = false, pairingRejected = false;
  run.addCleanup('reconcile and revoke only this live probe grant', async () => {
    if (accessToken) await revoke();
    else if (requestDispatched && !pairingRejected) throw new Error('Pairing receipt unknown; no pairing retry attempted');
  });
  let failure;
  try {
    requestDispatched = true;
    const response = await fetch(base + '/api/mobile/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, durableDeviceAuthorization: true, deviceLabel: 'FIFO acceptance probe (temporary)' }),
      signal: AbortSignal.timeout(10000),
    });
    report.pairingHttpStatus = response.status;
    if (!response.ok) {
      pairingRejected = [400, 401, 403, 415, 429].includes(response.status);
      assert.equal(response.status, 200, 'Public pairing should succeed');
    }
    const grant = await response.json();
    for (const name of ['accessToken', 'refreshToken', 'rpcToken']) {
      if (typeof grant[name] === 'string') run.registerSecret(grant[name]);
    }
    if (typeof grant.accessToken === 'string' && grant.accessToken.length >= 32) accessToken = grant.accessToken;
    assert.ok(accessToken, 'Pairing must return a usable probe grant');
    assert.equal(Object.hasOwn(grant, 'evictedDeviceIds'), false, 'Internal eviction metadata must not enter the grant');
    report.paired = true;
    const headers = { authorization: 'Bearer ' + accessToken };
    const devices = await fetch(base + '/api/mobile/devices', { headers, signal: AbortSignal.timeout(10000) });
    assert.equal(devices.status, 200);
    const rows = (await devices.json()).devices;
    assert.ok(Array.isArray(rows) && rows.length <= 32 && rows.some(row => row.id === grant.deviceId));
    report.devices = rows.length;
    const inventory = await fetch(base + '/api/servers', { headers, signal: AbortSignal.timeout(10000) });
    assert.equal(inventory.status, 200);
    await inventory.body?.cancel();
    report.serverInventoryRead = true;
  } catch (error) { failure = error; }
  finally {
    if (accessToken) await revoke();
    await run.writeArtifactJson('live-fifo-report.json', report);
  }
  if (failure) throw failure;
  console.log(JSON.stringify(report));
  return report;
});
