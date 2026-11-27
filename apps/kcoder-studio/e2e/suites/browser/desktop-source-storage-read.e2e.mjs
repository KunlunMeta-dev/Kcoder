import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { runE2E, requireExecutable } from '../../harness/run-context.mjs';
import { startSourceDesktop } from '../../harness/source-desktop.mjs';
import { hashHistoryFile } from '../../harness/migration-large-history.mjs';
import { rpcClient } from '../../harness/windows-storage-relocation.mjs';

await runE2E(import.meta.url, {
  testId: 'windows-source-desktop-migrated-storage-read', tier: 'manual-live',
  modelPolicy: 'Real source Electron/Gateway/Native against an explicitly owned migrated copy; training mode, no model turns.',
  retainSuccessEvidence: true,
  evidenceReason: 'Record actual Win32 host ownership and client readback separately from writable migration and installer acceptance.',
}, async context => {
  assert.equal(process.platform, 'win32', 'UNMET_PREREQUISITE: actual Windows required');
  const ownerRoot = process.env.KCODER_E2E_STORAGE_COPY_OWNER_ROOT;
  const profile = process.env.KCODER_E2E_STORAGE_COPY_DATA;
  assert.ok(ownerRoot && profile && isAbsolute(ownerRoot) && isAbsolute(profile));
  const marker = JSON.parse((await readFile(join(ownerRoot, '.owner.json'), 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(marker.owner, process.env.KCODER_E2E_STORAGE_COPY_OWNER);
  const inside = relative(resolve(ownerRoot), resolve(profile));
  assert.ok(inside && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
  const cli = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'explicit Debug CLI');
  const expected = process.env.KCODER_E2E_KCODER_BIN_SHA256;
  assert.match(expected ?? '', /^[a-f0-9]{64}$/);
  assert.equal(await hashHistoryFile(cli), expected);
  const identityFile = join(profile, '.profile-identity.json');
  const originalIdentity = await readFile(identityFile);
  const settingsFile = join(profile, 'settings.json');
  const originalSettings = await readFile(settingsFile);
  const registerStrings = value => {
    if (typeof value === 'string' && value.length >= 8) context.registerSecret(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(registerStrings);
  };
  registerStrings(JSON.parse(originalSettings.toString('utf8')));
  registerStrings(JSON.parse(await readFile(join(profile, 'credentials.json'), 'utf8')));
  for (const line of (await readFile(join(profile, '.env'), 'utf8')).split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*?)\s*$/);
    if (match) registerStrings(match[1].replace(/^(['"])(.*)\1$/, '$2'));
  }
  const workspace = process.env.KCODER_E2E_STORAGE_COPY_PROJECT;
  assert.ok(workspace && isAbsolute(workspace), 'Explicit original project cwd required; no project is created');
  const desktop = await startSourceDesktop(context, { label: 'storage-source-desktop', profile,
    workspace, kcoderBin: cli, startTimeoutMs: 300_000,
    env: { KCODER_TRAINING_MODE: 'true', KCODER_TRAINING_UPLOAD_URL: 'disabled-for-test',
      KCODER_INCLUDE_BUNDLED_PROFILES: '0', KCODER_STUDIO_RENDERER_MODE: 'static',
      KCODER_STUDIO_DATA_DIR: join(profile, 'studio/gateway'),
      KCODER_STUDIO_SERVERS: JSON.stringify([{ id: 'local', label: 'Owned Windows Debug', transport: 'local', command: cli, workspace }]),
    } });
  const { page } = desktop;
  const turnStarts = [];
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    try { if (JSON.parse(String(payload)).method === 'turn/start') turnStarts.push('turn/start'); } catch {}
  }));
  await page.getByTestId('desktop-sidebar').waitFor({ timeout: 120_000 });
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/settings/storage`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('storage-locations-readonly').waitFor({ timeout: 60_000 });
  const displayedRoot = await page.getByTestId('storage-location-path-dataRoot').innerText();
  assert.ok(displayedRoot.includes(profile));
  // The original authenticated Gateway RPC is supplementary to the real client;
  // private model names, credentials and transcript contents are never exported.
  const evaluate = async (_client, expression) => page.evaluate(expression);
  const rpc = await rpcClient({ renderer: null, evaluate });
  context.addCleanup('close owned storage read RPC', () => page.evaluate(() => window.__kcoderOwnedStorageRpc?.close()).catch(() => {}));
  const models = await rpc('runtime.providers.list', {});
  assert.ok(models.profiles.length > 0);
  const history = await rpc('thread/list', { limit: 20 });
  assert.ok(history.threads.length > 0, 'The original project must retain readable history');
  const transcript = await rpc('thread/read', { threadId: history.threads[0].id, limit: 10 });
  assert.ok(transcript.messages.length > 0);
  await page.screenshot({ path: context.pathInArtifacts('source-storage-readonly.png') });
  const counts = { configuredModelCount: models.profiles.length, originalProjectThreadCount: history.threads.length,
    transcriptMessageCount: transcript.messages.length };
  assert.equal(turnStarts.length, 0);
  await page.evaluate(() => window.__kcoderOwnedStorageRpc.close());
  await desktop.stop();
  assert.deepEqual(await readFile(settingsFile), originalSettings);
  assert.deepEqual(await readFile(identityFile), originalIdentity);
  return { ...counts, cliSha256: expected, sourceOnly: true, actualWindowsHost: desktop.hostReceipt,
    readOnlyExternalProfile: true, writableMigrationAccepted: false, installedPackageAccepted: false,
    modelTurns: 0, modelConfigurationAndLogicalIdentityUnchanged: true };
});
