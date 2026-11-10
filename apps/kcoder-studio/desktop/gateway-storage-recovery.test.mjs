import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGateway } from './gateway-process.mjs';
import { createMobileDeviceAuth } from '../src/mobile-device-auth.js';

const windows = { skip: process.platform !== 'win32' && 'Requires actual Windows ACL inheritance', timeout: 60_000 };
const psQuote = value => `'${value.replaceAll("'", "''")}'`;

test('Windows Gateway recovers inherited storage permissions and retains paired devices and browser login across restart', windows, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-gateway-storage-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const token = randomBytes(32).toString('hex');
  const auth = createMobileDeviceAuth({ directory, identity: token });
  const device = await auth.pair('Isolated recovery fixture');
  const cookie = randomBytes(32).toString('hex');
  const persistence = await auth.browserSessions();
  await persistence.save(cookie, { browserAdmin: true, expiresAt: Date.now() + 3_600_000, allowedServerIds: ['local'] });
  const root = join(directory, 'mobile-device-auth');
  const key = await readFile(join(root, '.key'));
  const storedDevice = JSON.parse(await readFile(join(root, 'devices.json'), 'utf8')).devices.find(row => row.id === device.deviceId);
  // Recreate an owned legacy store that inherited a broad parent grant. Synthetic
  // credentials remain in this fixture; no personal profile or service is used.
  const source = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$me=[Security.Principal.WindowsIdentity]::GetCurrent().User;` +
    `& icacls.exe ${psQuote(directory)} /grant '*S-1-1-0:(OI)(CI)(R)' | Out-Null;if($LASTEXITCODE){throw 'fixture parent grant failed'};` +
    `$items=@(${[root, join(root, '.key'), join(root, 'devices.json')].map(psQuote).join(',')});` +
    `foreach($p in $items){& icacls.exe $p /setowner ('*'+$me.Value) | Out-Null;if($LASTEXITCODE){throw 'fixture owner failed'};` +
    `$a=Get-Acl -LiteralPath $p;$a.SetAccessRuleProtection($false,$true);Set-Acl -LiteralPath $p -AclObject $a};`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'pipe' });
  const options = {
    // The override permits acceptance against an isolated copy of installed code.
    // The default exercises the current checkout under the normal desktop host.
    gatewayScript: process.env.KCODER_STUDIO_STORAGE_TEST_GATEWAY_SCRIPT || undefined,
    env: { KCODER_STUDIO_MOCK: '1', KCODER_STUDIO_SERVERS_STORE: join(directory, 'servers.json'),
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
