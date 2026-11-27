import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect } from '../../../renderer/node_modules/@playwright/test/index.mjs';
import { repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { startOwnedDisplay } from '../../harness/ai-verify-gateway.mjs';
import { createShortChromiumTemp } from '../../harness/short-chromium-temp.mjs';
import { startSourceDesktop } from '../../harness/source-desktop.mjs';
import { desktopStorageObservation, quitStorageDesktop } from '../../harness/desktop-storage-operation.mjs';
import { hashHistoryFile } from '../../harness/migration-large-history.mjs';
import { loadProductAccountCookieScopeRoot, productAccountCookieScope } from '../../../src/gateway-product-account.js';
import namespaces from '../../../src/migrations/legacy-owner-namespaces.json' with { type: 'json' };

const electronModule = "process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron')";
process.umask(0o077);

await runE2E(import.meta.url, {
  testId: 'desktop-legacy-shared-userdata-startup-migration', tier: 'manual-live', variantId: 'vite',
  modelPolicy: 'model-independent actual Linux Electron and original Native/Gateway; no Provider, credential or model turn fixture',
  retainSuccessLogs: true,
}, async context => {
  assert.equal(process.platform, 'linux', 'UNMET_PREREQUISITE: actual Linux Electron and /proc required');
  assert.equal(process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX, '1', 'UNMET_PREREQUISITE: explicit isolated VM opt-in required');
  assert.match(process.env.KCODER_E2E_KCODER_BIN_SHA256 ?? '', /^[a-f0-9]{64}$/,
    'UNMET_PREREQUISITE: pin the completed Legacy CLI build before this actual-host test');
  assert.match(process.env.KCODER_E2E_STORAGE_ADDON_SHA256 ?? '', /^[a-f0-9]{64}$/,
    'UNMET_PREREQUISITE: pin the Native storage addon before this actual-host test');
  const cli = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'Legacy Native CLI');
  const addon = resolve(repoRoot, 'target/debug/libkcoder_native_storage.so');
  const inputs = [
    'apps/kcoder-studio/e2e/suites/browser/desktop-storage-legacy-startup.e2e.mjs',
    'apps/kcoder-studio/e2e/harness/source-desktop.mjs',
    'apps/kcoder-studio/e2e/harness/desktop-storage-operation.mjs',
    'apps/kcoder-studio/desktop/main.mjs',
    'apps/kcoder-studio/desktop/storage-startup.mjs',
    'apps/kcoder-studio/desktop/gateway-process.mjs',
    'apps/kcoder-studio/dev-server.mjs',
    'apps/kcoder-studio/src/skill-node-runtime.mjs',
    'apps/kcoder-studio/src/local-mcp-presets.mjs',
    'apps/kcoder-studio/src/migrations/storage-startup.mjs',
    'apps/kcoder-studio/src/migrations/gateway-storage-domains.mjs',
    'apps/kcoder-studio/src/migrations/legacy-owner-namespaces.json',
    'apps/kcoder-studio/src/storage-operation-client.mjs',
    'apps/kcoder-studio/src/storage-paths.mjs',
    'apps/kcoder-studio/renderer/src/features/workbench/pendingInputStorage.ts',
  ];
  const runtimeIdentities = async () => ({ cli, cliSha256: await hashHistoryFile(cli),
    addon, addonSha256: await hashHistoryFile(addon),
    inputs: Object.fromEntries(await Promise.all(inputs.map(async path => [path, await hashHistoryFile(resolve(repoRoot, path))]))),
  });
  const beforeRuntime = await runtimeIdentities();
  assert.equal(beforeRuntime.cliSha256, process.env.KCODER_E2E_KCODER_BIN_SHA256);
  assert.equal(beforeRuntime.addonSha256, process.env.KCODER_E2E_STORAGE_ADDON_SHA256);
  await context.writeArtifactJson('runtime-identities.json', beforeRuntime);
  const xdotool = await requireExecutable('/usr/bin/xdotool', 'owned native Quit input');
  const workspace = await materializeWorkspace(context, 'minimal', { instanceId: 'legacy-shared-userdata' });
  const home = context.pathInState('home'), native = join(home, '.config/kcoder'), shared = join(home, '.config/kcoder-studio');
  const gateway = join(native, 'studio/gateway'), desktopRoot = join(native, 'studio/desktop');
  const locationPath = join(home, '.config/kcoder-storage.json');
  const migrationRoot = join(home, '.config/kcoder-storage-migrations');
  for (const path of [native, shared]) await mkdir(path, { recursive: true, mode: 0o700 });
  await context.writeStateJson('home/.config/kcoder/settings.json', { providers: {},
    integrations: { office: { enabled: false }, connectivity: { enabled: false }, services: { enabled: false } } });
  await context.writeStateJson('home/.config/kcoder-studio/settings.json', {});
  const catalog = [{ id: 'local', label: 'Legacy shared local catalog', runtime: 'kcoder', transport: 'local', workspace: workspace.path }];
  await context.writeStateJson('home/.config/kcoder-studio/servers.json', catalog);
  // Use the original canonical owner format, without creating an account or credential.
  await writeFile(join(shared, '.product-account-cookie-scope.json'), JSON.stringify({ version: 1, scopeRoot: shared }) + '\n', { flag: 'wx', mode: 0o600 });
  const identity = async path => {
    const info = await lstat(path, { bigint: true });
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'a storage root must remain the original real directory');
    return `unix:${info.dev}:${info.ino}`;
  };
  const originalNative = await identity(native), originalShared = await identity(shared);
  const nativeSettings = await readFile(join(native, 'settings.json'));
  const gatewaySettings = await readFile(join(shared, 'settings.json'));
  const scopeBytes = await readFile(join(shared, '.product-account-cookie-scope.json'));
  const scopeIssuer = 'https://legacy-scope.example.test';
  const originalCookieScope = productAccountCookieScope(await loadProductAccountCookieScopeRoot(shared), '/', scopeIssuer);
  await assert.rejects(lstat(locationPath), { code: 'ENOENT' });
  await assert.rejects(lstat(join(migrationRoot, 'current.json')), { code: 'ENOENT' });
  const display = await startOwnedDisplay(context), temporary = await createShortChromiumTemp(context);
  const common = { ownedDisplay: display, workspace: workspace.path, kcoderBin: cli, startTimeoutMs: 120_000,
    env: { KCODER_STUDIO_RENDERER_MODE: 'vite', KCODER_INCLUDE_BUNDLED_PROFILES: '0', KCODER_TRAINING_UPLOAD_URL: 'disabled-for-test',
      XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
      TMPDIR: temporary.path, TMP: temporary.path, TEMP: temporary.path } };
  const marker = `legacy-browser-${context.seed}`, draft = `legacy-unsent-draft-${context.seed}`, queued = `legacy-unsubmitted-queue-${context.seed}`;
  for (const value of [marker, draft, queued]) context.registerSecret(value);
  let phase = 'source-seed', originalPort, origin, recovery, operationId;
  const turnStarts = [];
  const observeTurns = page => page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    let frame; try { frame = JSON.parse(String(payload)); } catch { return; }
    if (frame.method === 'turn/start') turnStarts.push({ phase, method: frame.method });
  }));
  const openComposer = async page => {
    await page.getByTestId('desktop-sidebar').waitFor({ timeout: 120_000 });
    const project = page.getByTestId('project-item').filter({ hasText: catalog[0].label }).first();
    await project.waitFor({ timeout: 60_000 });
    await project.hover(); await project.getByTestId('project-new-conversation-button').click();
    await page.getByTestId('chat-message-input').waitFor({ timeout: 60_000 });
  };
  const readCatalog = page => page.evaluate(async () => {
    const response = await fetch('/api/servers');
    if (!response.ok) throw new Error(`Original Gateway catalog unavailable: ${response.status}`);
    return (await response.json()).servers.map(({ id, label }) => ({ id, label }));
  });
  const operation = async () => {
    const id = JSON.parse(await readFile(join(migrationRoot, 'current.json'), 'utf8'));
    operationId ??= id; assert.equal(id, operationId, 'ordinary startup must retain the original migration operation');
    return JSON.parse(await readFile(join(migrationRoot, id, 'receipt.json'), 'utf8'));
  };
  const assertNative = async () => {
    assert.equal(await identity(native), originalNative, 'Native must remain in place with its original directory identity');
    assert.deepEqual(await readFile(join(native, 'settings.json')), nativeSettings, 'Gateway settings must never replace Native settings');
  };
  const coldRead = async (host, label) => {
    observeTurns(host.page);
    await host.page.getByTestId('desktop-sidebar').waitFor({ timeout: 120_000 });
    assert.equal(new URL(host.page.url()).origin, origin, 'preserve the actual original Gateway origin and port');
    assert.deepEqual(await readCatalog(host.page), catalog.map(({ id, label }) => ({ id, label })));
    const cookies = await host.page.context().cookies(origin);
    for (const cookie of cookies) context.registerSecret(cookie.value);
    assert.equal(cookies.find(cookie => cookie.name === 'kcoder_legacy_owned')?.value, marker);
    assert.equal(await host.page.evaluate(() => localStorage.getItem('kcoder-owned-legacy-startup')), marker);
    await openComposer(host.page);
    await expect(host.page.getByTestId('chat-message-input')).toContainText(draft);
    const restored = await host.page.evaluate(async ({ recovery, queued, draft }) => {
      const codec = await import('/src/features/workbench/pendingInputStorage.ts');
      const rows = codec.readPendingInputs(recovery.ownerKey);
      const row = rows.find(value => value.id === recovery.queue.id);
      return { draft: codec.readComposerDraft(recovery.ownerKey) === draft,
        queue: Boolean(row && row.content === queued && row.status === 'queued' && row.ownerKey === recovery.queue.ownerKey
          && row.createdAt === recovery.queue.createdAt && row.clientMessageId === recovery.queue.clientMessageId),
        pendingCount: rows.length };
    }, { recovery, queued, draft });
    assert.deepEqual(restored, { draft: true, queue: true, pendingCount: 1 }, 'the original renderer codec must recover the same unsent identities');
    const observation = await desktopStorageObservation(context, { desktop: host, display, xdotool, label });
    const actualPaths = await observation.evaluateMain(`(() => { const { app } = ${electronModule}; return {
      userData: app.getPath('userData'), sessionData: app.getPath('sessionData') }; })()`);
    assert.deepEqual(actualPaths, { userData: desktopRoot, sessionData: desktopRoot });
    return { observation, restored, actualPaths };
  };
  try {
    const seed = await startSourceDesktop(context, { label: 'legacy-shared-seed', ...common, profile: native, desktopProfile: shared });
    observeTurns(seed.page);
    await seed.page.getByTestId('desktop-sidebar').waitFor({ timeout: 120_000 });
    origin = new URL(seed.page.url()).origin; context.registerPort('legacy-original-gateway', Number(new URL(origin).port));
    assert.deepEqual(await readCatalog(seed.page), catalog.map(({ id, label }) => ({ id, label })));
    await seed.page.evaluate(value => localStorage.setItem('kcoder-owned-legacy-startup', value), marker);
    await seed.page.context().addCookies([{ name: 'kcoder_legacy_owned', value: marker, url: origin,
      httpOnly: true, sameSite: 'Lax', expires: Math.floor(Date.now() / 1000) + 3600 }]);
    await openComposer(seed.page);
    await seed.page.getByTestId('chat-message-input').click(); await seed.page.keyboard.insertText(draft);
    recovery = await waitFor(() => seed.page.evaluate(async ({ draft, queued, id }) => {
      const { getRuntimeConfig } = await import('/src/config/runtime.ts');
      const codec = await import('/src/features/workbench/pendingInputStorage.ts');
      const prefix = `kcoder.composer-drafts.v1:${getRuntimeConfig().appBasePath}:`;
      const storageKey = Object.keys(localStorage).find(key => key.startsWith(prefix) && JSON.parse(localStorage.getItem(key) ?? 'null')?.content === draft);
      if (!storageKey) return null;
      const ownerKey = storageKey.slice(prefix.length);
      // This is an unsent profile fixture, never a turn or an execution receipt.
      const queue = { id, clientMessageId: id, ownerKey, content: queued, createdAt: new Date().toISOString(), status: 'queued' };
      codec.writePendingInputs(ownerKey, [queue], []);
      if (codec.readComposerDraft(ownerKey) !== draft || codec.readPendingInputs(ownerKey).length !== 1) return null;
      return { ownerKey, queue };
    }, { draft, queued, id: `legacy-queued-${context.seed}` }), 15_000, 'actual persisted renderer draft and unsent queue fixture', 100, context.abortSignal);
    const seedObservation = await desktopStorageObservation(context, { desktop: seed, display, xdotool, label: 'legacy-seed' });
    assert.equal(await seedObservation.evaluateMain(`${electronModule}.app.getPath('userData')`), shared);
    await assert.rejects(lstat(locationPath), { code: 'ENOENT' });
    await assertNative();
    phase = 'source-normal-quit';
    await context.writeArtifactJson('seed-normal-quit.json', await quitStorageDesktop(context, {
      desktop: seed, observation: seedObservation, home, label: 'Legacy seed',
    }));
    for (const name of namespaces.desktopControls) await assert.rejects(lstat(join(shared, name)), { code: 'ENOENT' });
    originalPort = await readFile(join(shared, 'gateway-port'));
    assert.equal(Number(originalPort.toString().trim()), Number(new URL(origin).port));
    const originalPartition = await identity(join(shared, namespaces.partition));
    const originalCatalog = await readFile(join(shared, 'servers.json'));
    await context.writeArtifactJson('legacy-source-layout.json', { native, shared, originalNative, originalShared, originalPartition,
      originalOrigin: origin, sourceTopLevel: (await readdir(shared)).sort(), locationRecordAbsent: true,
      queueSeed: 'original renderer pendingInputStorage codec; unsent, no execution authority', draftSeed: 'actual composer input',
      catalog: await readFile(join(shared, 'servers.json'), 'utf8').then(JSON.parse), observedTurnStarts: turnStarts.length });

    phase = 'default-startup-before-business';
    const migrated = await startSourceDesktop(context, { label: 'legacy-default-migrate', ...common, usePersonalStorageSelection: true });
    const completed = await operation();
    await context.writeArtifactJson('legacy-completed-operation.json', completed);
    assert.equal(completed.phase, 'verified'); assert.equal(completed.disposition, 'complete');
    assert.equal(completed.errorCode, undefined); assert.equal(completed.plan.original, null);
    assert.equal(completed.plan.from.layout, 'legacy');
    assert.deepEqual(completed.plan.components.map(({ domain, source, destination }) => ({ domain, source, destination })), [
      { domain: 'persistent-root', source: native, destination: native },
      { domain: 'gateway', source: shared, destination: gateway },
      { domain: 'desktop', source: shared, destination: desktopRoot },
    ]);
    assert.equal(completed.plan.components[0].sourceIdentity, originalNative);
    const selected = JSON.parse(await readFile(locationPath, 'utf8'));
    assert.equal(selected.version, 1); assert.equal(selected.revision, 1); assert.equal(selected.dataRoot, native);
    assert.equal(selected.operationId, operationId);
    await assertNative(); assert.equal(await identity(shared), originalShared); assert.equal(await identity(join(shared, namespaces.partition)), originalPartition);
    for (const [name, bytes] of [['settings.json', gatewaySettings], ['servers.json', originalCatalog], ['.product-account-cookie-scope.json', scopeBytes]]) {
      assert.deepEqual(await readFile(join(shared, name)), bytes, 'retain the original shared source bytes');
      assert.deepEqual(await readFile(join(gateway, name)), bytes, 'publish only Gateway bytes into its target component');
      await assert.rejects(lstat(join(desktopRoot, name)), { code: 'ENOENT' });
    }
    assert.deepEqual(await readFile(join(desktopRoot, 'gateway-port')), originalPort);
    await assert.rejects(lstat(join(gateway, 'gateway-port')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(gateway, 'Partitions')), { code: 'ENOENT' });
    assert.equal(await loadProductAccountCookieScopeRoot(gateway), shared);
    assert.equal(productAccountCookieScope(await loadProductAccountCookieScopeRoot(gateway), '/', scopeIssuer), originalCookieScope);
    phase = 'cold-migrated-profile-read';
    const firstRead = await coldRead(migrated, 'legacy-migrated');
    await context.writeArtifactJson('legacy-migrated-read.json', { origin, actualPaths: firstRead.actualPaths, ...firstRead.restored,
      nativeIdentityPreserved: true, nativeSettingsPreserved: true, sourceRetained: true, cookieScopePreserved: true, operationId });
    await context.writeArtifactJson('migrated-normal-quit.json', await quitStorageDesktop(context, {
      desktop: migrated, observation: firstRead.observation, home, label: 'Migrated Legacy desktop',
    }));

    phase = 'ordinary-startup-no-reimport';
    const committedLocation = await readFile(locationPath), committedReceipt = await readFile(join(migrationRoot, operationId, 'receipt.json'));
    const committedCurrent = await readFile(join(migrationRoot, 'current.json'));
    const changedOldCatalog = catalog.map(row => ({ ...row, label: 'Retained old catalog must not return' }));
    await writeFile(join(shared, 'servers.json'), JSON.stringify(changedOldCatalog) + '\n', { mode: 0o600 });
    await writeFile(join(shared, 'unknown-old-source-after-complete.txt'), 'Retained after Complete; ordinary startup must not import this tree.\n', { flag: 'wx', mode: 0o600 });
    const ordinary = await startSourceDesktop(context, { label: 'legacy-ordinary-cold', ...common, usePersonalStorageSelection: true });
    const secondRead = await coldRead(ordinary, 'legacy-ordinary');
    assert.deepEqual(await readFile(locationPath), committedLocation);
    assert.deepEqual(await readFile(join(migrationRoot, 'current.json')), committedCurrent);
    assert.deepEqual(await readFile(join(migrationRoot, operationId, 'receipt.json')), committedReceipt);
    assert.deepEqual(await readFile(join(gateway, 'servers.json')), originalCatalog);
    await assert.rejects(lstat(join(gateway, 'unknown-old-source-after-complete.txt')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(desktopRoot, 'unknown-old-source-after-complete.txt')), { code: 'ENOENT' });
    await assertNative(); assert.equal(await identity(shared), originalShared);
    assert.equal(turnStarts.length, 0, 'draft and queued fixture recovery must never start a model turn');
    await context.writeArtifactJson('ordinary-normal-quit.json', await quitStorageDesktop(context, {
      desktop: ordinary, observation: secondRead.observation, home, label: 'Ordinary cold desktop',
    }));
    const afterRuntime = await runtimeIdentities();
    await context.writeArtifactJson('runtime-identities-after.json', afterRuntime);
    assert.deepEqual(afterRuntime, beforeRuntime, 'the actual-host run must keep the frozen runtime and source inputs');
    await context.writeArtifactJson('legacy-startup-acceptance.json', { operationId, phase: 'verified', disposition: 'complete',
      actualLinuxElectron: true, nativeInPlace: true, nativeSettingsPreserved: true, splitGatewayDesktop: true,
      retainedSharedSource: true, originPreserved: true, persistentCookieRecovered: true, localStorageRecovered: true,
      actualComposerDraftRecovered: true, originalCodecQueuedInputRecovered: true, noRepeatedOldTreeImport: true,
      observedTurnStarts: turnStarts.length, normalQuitCount: 3, ordinaryRead: secondRead.restored });
    return { operationId, actualLinuxElectron: true, nativeInPlace: true, splitGatewayDesktop: true,
      originalOrigin: origin, persistentCookieRecovered: true, localStorageRecovered: true,
      composerDraftRecovered: true, queuedInputCodecRecovered: true, noRepeatedOldTreeImport: true, observedTurnStarts: 0 };
  } catch (error) {
    const checks = await Promise.allSettled([assertNative(), identity(shared).then(value => assert.equal(value, originalShared)),
      readFile(join(shared, 'settings.json')).then(value => assert.deepEqual(value, gatewaySettings)),
      readFile(join(shared, '.product-account-cookie-scope.json')).then(value => assert.deepEqual(value, scopeBytes))]);
    await context.writeArtifactJson('legacy-startup-failure.json', { phase, operationId: operationId ?? null,
      message: String(error.message), independentSourceChecks: checks.map((value, index) => ({
        name: ['native-in-place-and-settings', 'shared-root-identity', 'shared-settings-retained', 'shared-cookie-scope-retained'][index],
        passed: value.status === 'fulfilled', ...(value.status === 'rejected' ? { message: String(value.reason?.message ?? value.reason) } : {}),
      })), operation: await operation().catch(() => null), observedTurnStarts: turnStarts.length });
    throw error;
  }
});
