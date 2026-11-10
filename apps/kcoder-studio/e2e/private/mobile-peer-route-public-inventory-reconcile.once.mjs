#!/usr/bin/env node
import assert from 'node:assert/strict';
import { runE2E, waitFor, isolatedEnvironment } from '../harness/run-context.mjs';

process.umask(0o077);

const [publicRoot, browserRunId] = process.argv.slice(2);
const PUBLIC_OWNER_HOST = 'vps_first';
if (!/^\/tmp\/kcoder-e2e-peer-route-\d{14}-[a-f0-9]{12}-public$/.test(publicRoot || '') ||
    !/^\d{8}-\d{6}\.\d{3}Z$/.test(browserRunId || '')) {
  throw new Error('read-only inventory reconcile requires the exact owned public root and browser run ID');
}

const remoteInventoryScript = `
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readRemoteOwnerConfig } from './apps/kcoder-studio/e2e/private/mobile-peer-route-owner-helpers.mjs';

const safeResult = value => process.stdout.write(JSON.stringify(value) + '\\n');
const fail = (category, statuses = {}) => { safeResult({ schemaVersion: 1, status: category, ...statuses }); process.exitCode = 2; };
try {
  const root = process.argv[1];
  const rootMatch = root.match(/^\\/tmp\\/kcoder-e2e-(peer-route-\\d{14}-[a-f0-9]{12})-public$/);
  if (!rootMatch) throw new Error('invalid-owned-root');
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid() || (rootStat.mode & 0o777) !== 0o700) {
    throw new Error('invalid-root-identity');
  }
  const config = await readRemoteOwnerConfig(root);
  if (config.role !== 'public' || config.runId !== rootMatch[1]) throw new Error('owner-config-mismatch');
  const receiptPath = join(root, 'private', 'ready.json');
  const receiptStat = await lstat(receiptPath);
  if (!receiptStat.isFile() || receiptStat.isSymbolicLink() || receiptStat.nlink !== 1 ||
      receiptStat.uid !== process.getuid() || (receiptStat.mode & 0o777) !== 0o600) throw new Error('invalid-ready-receipt');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  const gatewayBaseUrl = receipt?.safe?.gatewayBaseUrl;
  if (receipt?.safe?.status !== 'ready' || receipt?.safe?.role !== 'public' || receipt?.safe?.root !== root ||
      typeof gatewayBaseUrl !== 'string' || !/^http:\\/\\/127\\.0\\.0\\.1:\\d+$/.test(gatewayBaseUrl)) {
    throw new Error('gateway-ready-receipt-mismatch');
  }
  const loginUrl = new URL('/login', gatewayBaseUrl);
  loginUrl.searchParams.set('token', config.gatewayAuthToken);
  loginUrl.searchParams.set('returnTo', '/');
  const login = await fetch(loginUrl, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
  if (login.status !== 303) { fail('admin-login-rejected', { adminLoginStatus: login.status }); process.exit(0); }
  const cookie = (login.headers.get('set-cookie') || '').split(';', 1)[0];
  if (!/^kcoder_studio_session=[A-Za-z0-9_-]{32,128}$/.test(cookie)) throw new Error('invalid-admin-session');
  const inventory = await fetch(new URL('/api/mobile/pairing', gatewayBaseUrl), {
    cache: 'no-store', headers: { cookie }, signal: AbortSignal.timeout(8000),
  });
  if (inventory.status !== 200) { fail('inventory-read-rejected', { adminLoginStatus: login.status, inventoryStatus: inventory.status }); process.exit(0); }
  const body = await inventory.json();
  if (!Array.isArray(body?.devices)) throw new Error('invalid-inventory-payload');
  safeResult({ schemaVersion: 1, status: 'inventory-read', adminLoginStatus: login.status,
    inventoryStatus: inventory.status, deviceCount: body.devices.length, deviceIdentityPresent: body.devices.length > 0 });
} catch {
  fail('owned-inventory-read-failed');
}
`;

await runE2E(import.meta.url, {
  testId: 'mobile-peer-route-public-inventory-reconcile',
  tier: 'full-integration',
  modelPolicy: 'read-only device inventory on the exact RunContext-owned public fixture Gateway; no pairing or deletion',
  retainSuccessEvidence: true,
  retainSuccessLogs: true,
  cleanupTimeoutMs: 20_000,
  bodyAbortTimeoutMs: 5_000,
}, async (context, _signal) => {
  const runtimeNode = `${publicRoot}/package/runtime/node`;
  const remoteCommand = `cd '${publicRoot}/package' && exec '${runtimeNode}' --max-old-space-size=16 --input-type=module -e '${remoteInventoryScript.replaceAll("'", "'\\''")}' '${publicRoot}'`;
  const child = context.spawnOwned('public-owned-device-inventory-read', '/usr/bin/ssh', [
    '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', PUBLIC_OWNER_HOST, remoteCommand,
  ], {
    cwd: process.cwd(),
    env: isolatedEnvironment({}, ['SSH_AUTH_SOCK'], {
      HOME: process.env.HOME || '/home/hyf',
      USERPROFILE: process.env.HOME || '/home/hyf',
    }),
  });
  let stdout = '';
  child.stdout?.on('data', chunk => {
    stdout += chunk.toString('utf8');
    if (Buffer.byteLength(stdout) > 4096) void context.stopOwned('public-owned-device-inventory-read');
  });
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 20_000,
    'read-only public fixture inventory over owned SSH', 25, context.abortSignal);
  assert.equal(child.exitCode, 0, 'read-only public fixture inventory SSH command must complete');
  assert.ok(Buffer.byteLength(stdout) <= 4096, 'inventory response must be bounded and redacted');
  let remoteResult;
  try { remoteResult = JSON.parse(stdout.trim()); }
  catch { throw new Error('read-only public inventory returned no safe JSON result'); }
  assert.equal(remoteResult.schemaVersion, 1);
  const receipt = {
    schemaVersion: 1,
    status: remoteResult.status,
    browserRunId,
    gatewayOwnerRunId: publicRoot.match(/peer-route-(\d{14}-[a-f0-9]{12})-public$/)?.[1] ?? null,
    observedAt: new Date().toISOString(),
    adminLoginStatus: remoteResult.adminLoginStatus ?? null,
    inventoryStatus: remoteResult.inventoryStatus ?? null,
    deviceCount: Number.isSafeInteger(remoteResult.deviceCount) ? remoteResult.deviceCount : null,
    deviceIdentityPresent: typeof remoteResult.deviceIdentityPresent === 'boolean' ? remoteResult.deviceIdentityPresent : null,
    action: 'GET inventory only; no pairing, DELETE, or revoke request',
  };
  await context.writeArtifactJson('public-device-inventory-reconcile.json', receipt);
  return receipt;
});
