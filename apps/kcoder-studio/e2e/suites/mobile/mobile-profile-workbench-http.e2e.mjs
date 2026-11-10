import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runE2E, repoRoot, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { exportMobileWeb } from '../../harness/mobile-web-export.mjs';
import { archiveMobileWebExport, inspectMobileWebExportSourceIdentity, restoreMobileWebExportArchive, verifyMobileWebExportUnchanged } from '../../harness/mobile-web-export-archive.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { exerciseResourceBudgetUi, installBudgetReceiptFault } from '../browser/migration-resource-budget.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

process.umask(0o077);
await runE2E(import.meta.url, { testId: 'mobile-ordinary-http-profile-workbench', tier: 'full-integration', modelPolicy: 'model-independent actual Mobile Web/ordinary insecure HTTP/real Gateway and fixed Native budget flow, two owned Gateway profiles; no real model turn', retainSuccessLogs: true }, async context => {
  const host = Object.values(networkInterfaces()).flat().find(entry => entry && entry.family === 'IPv4' && !entry.internal)?.address;
  assert.ok(host, 'UNMET_PREREQUISITE: non-loopback HTTP interface');
  const selectedMobileRoot = resolve(process.env.KCODER_E2E_MOBILE_SOURCE_ROOT || resolve(repoRoot, 'apps/kcoder-studio/mobile'));
  const sourceRoots = [
    { name: 'mobile', path: selectedMobileRoot, destination: 'apps/kcoder-studio/mobile' },
    { name: 'studio-shared', path: resolve(selectedMobileRoot, '../shared'), destination: 'apps/kcoder-studio/shared' },
  ];
  const sourceIdentity = await inspectMobileWebExportSourceIdentity({ sourceRoots });
  const archivePath = process.env.KCODER_E2E_MOBILE_WEB_EXPORT_ARCHIVE;
  const archiveSha256 = process.env.KCODER_E2E_MOBILE_WEB_EXPORT_ARCHIVE_SHA256;
  assert.equal(!!archivePath, !!archiveSha256, 'restoring a Mobile bundle requires its exact SHA-256');
  const mobile = archivePath ? await restoreMobileWebExportArchive(context, { archivePath, expectedArchiveSha256: archiveSha256, sourceIdentity })
    : await exportMobileWeb(context, { mobileRoot: selectedMobileRoot, sourceRoots, dependencyRoot: resolve(repoRoot, 'apps/kcoder-studio/mobile/node_modules'), label: 'profile-http-mobile-export', outputName: 'profile-http-mobile-web', timeoutMs: 10 * 60_000 });
  const archived = archivePath ? { path: mobile.archivePath, sha256: mobile.archiveSha256, bundleSha256: mobile.bundleSha256 }
    : await archiveMobileWebExport(context, { exportResult: mobile, sourceIdentity });
  await context.writeArtifactJson('mobile-build-archive.json', { ...archived, sourceTreeSha256: sourceIdentity.sourceTreeSha256 });
  const originalBinary = process.env.KCODER_E2E_KCODER_BIN, expectedBinarySha256 = process.env.KCODER_E2E_KCODER_BIN_SHA256;
  assert.ok(originalBinary && /^[a-f0-9]{64}$/.test(expectedBinarySha256 ?? ''), 'UNMET_PREREQUISITE: explicit Native binary and its SHA-256');
  const binary = context.pathInState('bin/kcoder'); await mkdir(resolve(binary, '..'), { recursive: true, mode: 0o700 }); await copyFile(originalBinary, binary); await chmod(binary, 0o700);
  const binarySha256 = sha(await readFile(binary));
  assert.equal(binarySha256, expectedBinarySha256, 'caller-pinned Native binary identity');
  const model = await startApprovalModelFixture(context, { responseSteps: () => [{ delta: { role: 'assistant', content: 'UNEXPECTED_MODEL_CALL' }, finishReason: 'stop' }] });
  const original = { credential_store: 'file', active_provider: 'fixture', providers: { fixture: { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl, default_model: 'fixture', context_window_tokens: 128000, output_headroom_tokens: 1024, max_output_tokens: 1024, discover_models: false, no_proxy: true } } };
  const workspace = (await materializeWorkspace(context, 'minimal')).path;
  const settings = [], gateways = [], sources = [];
  for (const [index, target] of ['migration-target', 'peer-target'].entries()) {
    const profile = context.pathInState(`native-${index}`), sourceHome = context.pathInState(`source-home-${index}`), source = resolve(sourceHome, '.claude');
    for (const path of [profile, sourceHome, source]) { await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700); }
    await writeFile(resolve(profile, 'settings.json'), JSON.stringify(original), { mode: 0o600 });
    settings.push({ profile, sha256: sha(await readFile(resolve(profile, 'settings.json'))) }); sources.push(source);
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    const launcher = context.pathInState(`launcher-${index}`);
    await writeFile(launcher, `#!/bin/sh\nexport KCODER_CONFIG_DIR=${quote(profile)}\nexport HOME=${quote(sourceHome)}\nexport CLAUDE_CONFIG_DIR=${quote(source)}\nexport CODEX_HOME=${quote(resolve(sourceHome, '.codex'))}\nexec ${quote(binary)} "$@"\n`, { mode: 0o700 });
    const serversFile = await context.writeStateJson(`servers-${index}.json`, [target, `secondary-${index}`].map(id => ({ id, label: id, transport: 'local', command: launcher, workspace })));
    // Independent Gateways must not rotate each other's device and browser authorization store.
    const serversStore = context.pathInState(`gateway-${index}/servers-store.json`);
    await mkdir(resolve(serversStore, '..'), { recursive: true, mode: 0o700 });
    const gateway = await startGateway(context, { label: `profile-http-gateway-${index}`, host: '0.0.0.0', allowedHosts: `127.0.0.1,localhost,${host}`, auth: true, workspace, kcoderBin: binary, serversFile, serversStore,
      env: { KCODER_STUDIO_WEB_ROOT: mobile.path, ...(index ? { KCODER_STUDIO_MOBILE_WEB_ORIGINS: `http://${host}:${gateways[0].port}` } : {}) } });
    gateways.push(gateway);
  }
  const origin = `http://${host}:${gateways[0].port}`, secondOrigin = `http://${host}:${gateways[1].port}`;
  const browser = await startChromium(context, { label: 'profile-http-workbench-browser' });
  const page = await browser.newPersistentPage(); await page.setViewportSize({ width: 430, height: 900 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const budgetTransport = await installBudgetReceiptFault(page);
  const profiles = () => page.evaluate(() => { const raw = localStorage.getItem('kcoder-studio-mobile.gateway-profiles.v2'); const index = raw ? JSON.parse(raw) : { profiles: [] }; return { activeId: index.activeId, profiles: index.profiles.map(row => ({ id: row.id, baseUrl: row.baseUrl, authMode: row.authMode })) }; });
  const selectTarget = async (current, target) => { await current.getByTestId('settings-runtime-target-selector').waitFor({ timeout: 30000 }); await current.getByTestId('settings-runtime-target-selector').click(); await current.getByTestId(`settings-runtime-target-option-${target}`).click(); await current.getByTestId('migration-workbench').waitFor({ timeout: 30000 }); };
  let peerPage, phase = 'pair-first-profile';
  try {
    await page.goto(origin); await page.locator('input[name="token"]').fill(gateways[0].authToken); await page.locator('button[type="submit"]').click();
    assert.deepEqual(await page.evaluate(() => ({ secure: isSecureContext, locks: typeof navigator.locks })), { secure: false, locks: 'undefined' });
    await page.getByTestId('welcome-direct-connection').click(); await page.getByTestId('gateway-token').fill(gateways[0].authToken); await page.getByTestId('gateway-connect').click(); await page.getByTestId('new-workspace').waitFor({ timeout: 30000 });
    const firstId = (await profiles()).profiles.find(row => row.baseUrl === origin)?.id; assert.ok(firstId);
    assert.equal((await profiles()).profiles[0].authMode, 'device');
    await page.goto(`${origin}/settings-connections`); await page.getByTestId('settings-add-gateway').click(); await page.getByTestId('welcome-direct-connection').click();
    await page.getByTestId('gateway-endpoint').fill(secondOrigin); await page.getByTestId('gateway-token').fill(gateways[1].authToken); await page.getByTestId('gateway-connect').click(); await page.getByTestId('new-workspace').waitFor({ timeout: 30000 });
    const secondId = (await profiles()).profiles.find(row => row.baseUrl === secondOrigin)?.id; assert.ok(secondId); assert.notEqual(firstId, secondId);
    assert.equal((await profiles()).profiles.length, 2);
    phase = 'peer-second-profile'; peerPage = await browser.newPersistentPage(); await peerPage.setViewportSize({ width: 430, height: 900 }); await peerPage.goto(`${origin}/settings-section?section=migration_results`); await selectTarget(peerPage, 'peer-target');
    await page.goto(`${origin}/settings-connections`); await page.getByTestId(`settings-gateway-${firstId}`).click(); await waitFor(async () => (await profiles()).activeId === firstId, 15000, 'explicit first profile activation persisted');
    await page.goto(`${origin}/settings-section?section=migration_results`); await selectTarget(page, 'migration-target');
    phase = 'original-budget-roundtrip';
    const roundtrip = await exerciseResourceBudgetUi({ context, page, gateway: gateways[0], profile: settings[0].profile, workspace, sourceRoot: sources[0], model, transport: budgetTransport, mobile: true, httpMetadataAuthority: true, onAcceptedUnknown: async ({ jobId, requestId }) => {
      phase = 'switch-during-accepted-unknown';
      await page.goto(`${origin}/settings-connections`); await page.getByTestId(`settings-gateway-${secondId}`).click();
      await waitFor(async () => (await profiles()).activeId === secondId, 15000, 'second profile explicitly selected during unknown receipt');
      await page.goto(`${origin}/settings-section?section=migration_results`); await selectTarget(page, 'peer-target');
      await page.getByTestId('migration-tab-records').click(); await page.getByText('No saved tasks or records.', { exact: true }).waitFor();
      assert.equal(await page.getByTestId(`migration-batch-record-${jobId}`).count(), 0);
      assert.equal(budgetTransport.requests.filter(row => row.method === 'migration/batch/resources/increase').length, 1, 'switching profiles cannot retry the original unknown mutation');
      await context.writeArtifactJson('profile-switch-during-unknown.json', { originalJobId: jobId, originalRequestId: requestId, secondProfileCannotSeeOriginal: true, increaseCount: 1, automaticRetry: false });
      await page.goto(`${origin}/settings-connections`); await page.getByTestId(`settings-gateway-${firstId}`).click();
      await waitFor(async () => (await profiles()).activeId === firstId, 15000, 'original profile explicitly restored');
      await page.goto(`${origin}/settings-section?section=migration_results`); await selectTarget(page, 'migration-target');
      phase = 'original-receipt-recovery-after-profile-switch';
    } });
    assert.equal(roundtrip.originalOfflineUndo, true); assert.equal(budgetTransport.requests.filter(row => row.method === 'migration/batch/resources/increase').length, 1);
    await peerPage.getByTestId('migration-tab-records').click(); await peerPage.getByTestId('migration-records-refresh').waitFor(); await peerPage.getByText('No saved tasks or records.', { exact: true }).waitFor();
    assert.equal(await peerPage.getByTestId(`migration-batch-record-${budgetTransport.dropped.jobId}`).count(), 0, 'peer profile cannot display another Native profile job');
    // Removing A only revokes that saved Gateway grant; B remains available in its own page.
    phase = 'remove-first-profile';
    await page.goto(`${origin}/settings-connections`); page.once('dialog', dialog => dialog.accept()); await page.getByTestId(`remove-profile-${firstId}`).click();
    await waitFor(async () => !(await profiles()).profiles.some(row => row.id === firstId), 15000, 'explicit original Gateway profile removal');
    const retained = await profiles(); assert.deepEqual(retained.profiles.map(row => row.id), [secondId]);
    await peerPage.reload(); await selectTarget(peerPage, 'peer-target'); await peerPage.getByTestId('migration-tab-records').click(); await peerPage.getByTestId('migration-records-refresh').waitFor(); await peerPage.getByText('No saved tasks or records.', { exact: true }).waitFor();
    await page.reload(); await page.getByTestId(`settings-gateway-${secondId}`).waitFor(); assert.equal(await page.getByTestId(`settings-gateway-${firstId}`).count(), 0);
    for (const value of settings) assert.equal(sha(await readFile(resolve(value.profile, 'settings.json'))), value.sha256);
    assert.equal(model.requests.length, 0); assert.deepEqual(errors, []); await verifyMobileWebExportUnchanged(mobile);
    await context.writeArtifactJson('profile-http-workbench.json', { passed: true, ordinaryNonLoopbackHTTP: true, secureContext: false, WebLocksAbsent: true, gatewayProfiles: 2, bothDeviceAuthenticated: true, explicitProfileSwitch: true, peerPageProfilePreserved: true, peerCannotSeeOriginalJob: true, removedOnlyOriginalProfile: true, persistedReopenRetainsPeerOnly: true, budgetIncreaseCount: 1, lostAcceptedReceiptReconciled: true, switchedDuringAcceptedUnknown: true, separateResumeAndUndo: true, settingsUnchanged: true, binarySha256, sourceTreeSha256: sourceIdentity.sourceTreeSha256, bundleSha256: archived.bundleSha256, modelRequests: 0, boundary: 'Mobile Web and two owned Gateway authorization profiles; not Android/iOS or two physical OS accounts. Fixed Native baseline does not claim new private credential capabilities.' });
    return { actualGatewayProfiles: 2, ordinaryHTTP: true, budgetOriginalIDRecovered: true, modelRequests: 0 };
  } catch (error) { await page.screenshot({ path: context.pathInArtifacts('profile-http-failure.png'), fullPage: true }).catch(() => {}); await context.writeArtifactJson('profile-http-checkpoint.json', { phase, profiles: await profiles().catch(() => null), budgetTransport, errors, peerBody: peerPage ? (await peerPage.locator('body').innerText().catch(() => '')).slice(0,4096) : null, mainBody: (await page.locator('body').innerText().catch(() => '')).slice(0,4096) }); throw error; }
});
