import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runIntegration, requireExecutable } from '../e2e/harness/run-context.mjs';
import { AppServerStdioClient, waitForStdioChildClose } from '../e2e/harness/app-server-stdio.mjs';
import { hashHistoryFile } from '../e2e/harness/migration-large-history.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// Keep Native JSONL off the supervisor's reserved control stdin. The enclosing
// RunContext Job owns this worker and its non-detached Native child together.
if (process.argv[2] === '--owned-worker') {
  assert.equal(process.platform, 'win32');
  const [input, receipt] = process.argv.slice(3);
  assert.ok(isAbsolute(input) && isAbsolute(receipt));
  const { cli, workspace } = JSON.parse(await readFile(input, 'utf8'));
  assert.ok(isAbsolute(cli) && isAbsolute(workspace));
  const child = spawn(cli, ['--cwd', workspace, '--tool-profile', 'none', 'app-server', '--training-mode'], {
    cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env,
  });
  child.stderr.pipe(process.stderr);
  const rpc = new AppServerStdioClient('migrated-copy-native', child, { defaultTimeoutMs: 30_000 });
  try {
    const request = async (method, params) => {
      const frame = await rpc.request(method, params);
      assert.equal(frame.error, undefined, `Native ${method} must succeed; private response is not exported`);
      return frame.result;
    };
    await request('initialize', { protocolVersion: '2026-07-27',
      clientInfo: { name: 'owned-storage-copy-read', version: '1' } });
    const providers = await request('runtime.providers.list', {});
    assert.ok(Array.isArray(providers.profiles));
    assert.ok(providers.profiles.length > 0, 'The selected acceptance copy must retain its configured models');
    const history = await request('thread/list', { limit: 10 });
    assert.ok(Array.isArray(history.threads));
    assert.notEqual(history.completeness, 'partial');
    assert.ok(rpc.methodsSent.every(method => ['initialize', 'runtime.providers.list', 'thread/list'].includes(method)));
    await writeFile(receipt, JSON.stringify({ configuredModelCount: providers.profiles.length,
      listedThreadCount: history.threads.length, historyCompleteness: history.completeness ?? null,
      modelTurns: 0, rpcMethods: rpc.methodsSent }), { flag: 'wx', mode: 0o600 });
  } finally {
    child.stdin.end();
    try {
      assert.equal((await waitForStdioChildClose(child, 15_000, 'owned migrated-copy app-server')).code, 0);
    } finally { rpc.closeReader(); }
  }
} else await runIntegration(import.meta.url, {
  testId: 'storage-migrated-copy-native-read', tier: 'manual-live',
  modelPolicy: 'Read an explicitly owned migrated copy with the real Native app-server; training mode, no turns, no Gateway or desktop.',
  retainSuccessEvidence: true,
  evidenceReason: 'Keep the exact candidate identity, read results and owned process cleanup separate from desktop acceptance.',
}, async context => {
  assert.equal(process.platform, 'win32', 'UNMET_PREREQUISITE: actual Windows required');
  const root = resolve(process.env.KCODER_E2E_STORAGE_COPY_OWNER_ROOT ?? '');
  const owner = process.env.KCODER_E2E_STORAGE_COPY_OWNER;
  assert.match(owner ?? '', /^[a-f0-9-]{36}$/);
  const marker = JSON.parse((await readFile(join(root, '.owner.json'), 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(marker.owner, owner);
  const profile = process.env.KCODER_E2E_STORAGE_COPY_DATA;
  assert.ok(profile && isAbsolute(profile));
  const inside = relative(root, resolve(profile));
  assert.ok(inside && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
  const entry = await lstat(profile);
  assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
  assert.equal((await realpath(profile)).toLowerCase(), resolve(profile).toLowerCase());
  const registerStrings = value => {
    if (typeof value === 'string' && value.length >= 8) context.registerSecret(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(registerStrings);
  };
  for (const name of ['settings.json', 'credentials.json']) {
    registerStrings(JSON.parse(await readFile(join(profile, name), 'utf8')));
  }
  for (const line of (await readFile(join(profile, '.env'), 'utf8')).split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*?)\s*$/);
    if (match) registerStrings(match[1].replace(/^(['"])(.*)\1$/, '$2'));
  }
  const cli = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'explicit Debug Native CLI');
  const expectedSha256 = process.env.KCODER_E2E_KCODER_BIN_SHA256;
  assert.match(expectedSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(await hashHistoryFile(cli), expectedSha256);
  const leaves = ['settings.json', 'credentials.json', '.env', '.profile-identity.json'];
  const snapshot = async () => Object.fromEntries(await Promise.all(leaves.map(async name =>
    [name, hash(await readFile(join(profile, name)))])));
  const before = await snapshot();
  const workspace = context.pathInState('workspace'), temporary = context.pathInState('tmp');
  await mkdir(workspace); await mkdir(temporary);
  const label = 'migrated-copy-native';
  const input = await context.writeStateJson('native-read-input.json', { cli, workspace });
  const receipt = context.pathInState('native-read-result.json');
  const child = context.spawnOwned(label, process.execPath,
    [fileURLToPath(import.meta.url), '--owned-worker', input, receipt], {
      cwd: workspace, env: context.isolatedEnvironment({
        KCODER_CONFIG_DIR: profile, KCODER_INCLUDE_BUNDLED_PROFILES: '0',
        KCODER_TRAINING_UPLOAD_URL: 'disabled-for-test', TEMP: temporary, TMP: temporary, TMPDIR: temporary,
      }),
    });
  const closed = await waitForStdioChildClose(child, 90_000, 'owned migrated-copy worker');
  assert.equal(closed.code, 0);
  await context.stopOwned(label);
  const result = JSON.parse(await readFile(receipt, 'utf8'));
  assert.deepEqual(await snapshot(), before, 'Model settings, credentials, environment and logical identity must remain byte-identical');
  return { sourceOnly: true, guiAcceptance: false, cliSha256: expectedSha256,
    ...result, persistentConfigurationBytesUnchanged: true, normalChildExit: closed.code };
});
