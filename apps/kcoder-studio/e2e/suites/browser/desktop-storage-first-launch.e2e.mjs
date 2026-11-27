import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { startOwnedDisplay } from '../../harness/ai-verify-gateway.mjs';
import { createShortChromiumTemp } from '../../harness/short-chromium-temp.mjs';
import { startSourceDesktop } from '../../harness/source-desktop.mjs';
import { hashHistoryFile } from '../../harness/migration-large-history.mjs';
import { verifyWindowsInstallerMechanism } from '../../harness/windows-installer-lifecycle.mjs';
import { createStorageNativeInput, desktopStorageObservation, quitStorageDesktop,
  startStorageCliProbe, storageProcessGroupMembers, waitForStorageNativeWindow } from '../../harness/desktop-storage-operation.mjs';

const choice = process.env.KCODER_E2E_STORAGE_FIRST_CHOICE || 'defaults';
const windowsInstaller = process.env.KCODER_E2E_WINDOWS_STORAGE_INSTALLER;
const windowsVhdFixture = choice === 'cancel' ? undefined : process.env.KCODER_E2E_WINDOWS_STORAGE_VHD_FIXTURE;
assert.ok(['cancel', 'defaults', 'custom'].includes(choice));
process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'desktop-storage-first-launch-native-choice', tier: 'manual-live', variantId: windowsInstaller ? `windows-${choice}${windowsVhdFixture ? '-cross-volume' : ''}` : choice,
  modelPolicy: windowsInstaller ? 'actual NSIS under an owned normal-logon OS account; installed Electron native first choice and same-version replacement/cold read; no Provider or model' : 'model-independent actual Linux Electron main and native first-launch dialog; no model turns',
  cleanupTimeoutMs: windowsInstaller ? 120000 : undefined,
  retainSuccessLogs: true,
}, async context => {
  if (windowsInstaller) return verifyWindowsInstallerMechanism(context, {
    storageOnly: true, storageFirstChoice: choice, installer: windowsInstaller,
    target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET, node: process.env.KCODER_E2E_WINDOWS_NODE,
    probeSupervisor: process.env.KCODER_E2E_WINDOWS_UNINSTALL_PROBE_SUPERVISOR,
    expectedCommit: process.env.KCODER_E2E_WINDOWS_EXPECTED_COMMIT,
    expectedNativeCommit: process.env.KCODER_E2E_WINDOWS_EXPECTED_NATIVE_COMMIT,
    expectedCliSha256: process.env.KCODER_E2E_WINDOWS_EXPECTED_CLI_SHA256,
    expectedManifestSha256: process.env.KCODER_E2E_WINDOWS_EXPECTED_MANIFEST_SHA256,
    expectedHostSha256: process.env.KCODER_E2E_WINDOWS_EXPECTED_HOST_SHA256,
    expectedVersion: process.env.KCODER_E2E_WINDOWS_EXPECTED_VERSION,
    storageVhdFixture: windowsVhdFixture,
    storageVhdFixtureSha256: windowsVhdFixture ? process.env.KCODER_E2E_WINDOWS_STORAGE_VHD_FIXTURE_SHA256 : undefined,
  });
  assert.equal(process.platform, 'linux', 'UNMET_PREREQUISITE: actual Linux Electron and /proc required');
  assert.equal(process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX, '1', 'UNMET_PREREQUISITE: isolated VM opt-in required');
  for (const name of ['KCODER_E2E_KCODER_BIN_SHA256', 'KCODER_E2E_STORAGE_ADDON_SHA256'])
    assert.match(process.env[name] ?? '', /^[a-f0-9]{64}$/, `UNMET_PREREQUISITE: explicit frozen ${name} required`);
  const cli = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'frozen Native CLI');
  const addon = resolve(repoRoot, 'target/debug/libkcoder_native_storage.so');
  const inputs = ['apps/kcoder-studio/dev-server.mjs', 'apps/kcoder-studio/desktop/main.mjs', 'apps/kcoder-studio/desktop/storage-installation.mjs',
    'apps/kcoder-studio/src/skill-node-runtime.mjs', 'apps/kcoder-studio/src/local-mcp-presets.mjs',
    'apps/kcoder-studio/src/storage-operation-client.mjs', 'apps/kcoder-studio/src/storage-paths.mjs',
    'apps/kcoder-studio/src/migrations/windows-registered-sources.mjs'];
  const identities = async () => ({ cli, cliSha256: await hashHistoryFile(cli), addon, addonSha256: await hashHistoryFile(addon),
    inputs: Object.fromEntries(await Promise.all(inputs.map(async path => [path, await hashHistoryFile(resolve(repoRoot, path))]))) });
  const before = await identities();
  assert.equal(before.cliSha256, process.env.KCODER_E2E_KCODER_BIN_SHA256);
  assert.equal(before.addonSha256, process.env.KCODER_E2E_STORAGE_ADDON_SHA256);
  await context.writeArtifactJson('runtime-identities.json', before);
  const workspace = await materializeWorkspace(context, 'minimal', { instanceId: `first-launch-${choice}` });
  const home = context.pathInState('home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const defaultDataRoot = join(home, '.config/kcoder');
  const dataRoot = choice === 'custom' ? context.pathInState('Chosen Data') : defaultDataRoot;
  const cacheRoot = choice === 'custom' ? context.pathInState('Chosen Cache') : join(home, '.cache/kcoder');
  if (choice === 'custom') for (const root of [dataRoot, cacheRoot]) await mkdir(root, { mode: 0o700 });
  const location = join(home, '.config/kcoder-storage.json'), migrations = join(home, '.config/kcoder-storage-migrations');
  const display = await startOwnedDisplay(context), temporary = await createShortChromiumTemp(context);
  const xdotool = await requireExecutable('/usr/bin/xdotool', 'owned first-launch dialog input');
  const nativeInput = createStorageNativeInput(context, { display, xdotool, label: `first-launch-${choice}` });
  const captureNativeDialog = async name => {
    const ffmpeg = await requireExecutable('/usr/bin/ffmpeg', 'owned native dialog capture');
    const capture = context.spawnOwned(name, ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-f', 'x11grab', '-video_size', '1280x900', '-i', display.display,
        '-frames:v', '1', '-y', context.pathInArtifacts(`${name}.png`)],
      { env: context.isolatedEnvironment({ DISPLAY: display.display, XAUTHORITY: display.authority }) });
    await waitFor(() => capture.exitCode !== null, 5000, 'owned native dialog capture', 50, context.abortSignal);
  };
  const visibleWindow = async pattern => {
    try { return await nativeInput(['search', '--onlyvisible', '--name', pattern]); }
    catch (error) { if (error.nativeWindowNotFound === true) return null; throw error; }
  };
  const env = { KCODER_STUDIO_RENDERER_MODE: 'vite', XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'), KCODER_INCLUDE_BUNDLED_PROFILES: '0', KCODER_TRAINING_UPLOAD_URL: 'disabled-for-test',
    TMPDIR: temporary.path, TMP: temporary.path, TEMP: temporary.path };
  const label = `first-launch-${choice}`;
  const pending = startSourceDesktop(context, { label, kcoderBin: cli, usePersonalStorageSelection: true,
    ownedDisplay: display, workspace: workspace.path, env, startTimeoutMs: 120_000 })
    .then(desktop => ({ desktop }), error => ({ error }));
  const windows = (await nativeInput(['search', '--sync', '--onlyvisible', '--name', '^KCoder (storage folders|数据位置)$'])).split(/\s+/);
  assert.equal(windows.length, 1, 'only the owned display first-launch dialog may receive input');
  assert.match(windows[0], /^\d+$/);
  for (const path of [location, defaultDataRoot, migrations]) await assert.rejects(lstat(path), { code: 'ENOENT' });
  if (choice === 'custom') for (const root of [dataRoot, cacheRoot]) assert.deepEqual(await readdir(root), []);
  await context.writeArtifactJson('before-confirmation.json', { nativeTitle: await nativeInput(['getwindowname', windows[0]]),
    locationAbsent: true, defaultNativeAbsent: true, migrationAbsent: true, selectedRootsPrecreatedEmpty: choice === 'custom' });
  await nativeInput(['windowfocus', '--sync', windows[0]]);
  if (choice === 'custom') {
    for (const [index, root] of [[1, dataRoot], [2, cacheRoot]]) {
      await nativeInput(['key', '--clearmodifiers', ...Array(index).fill('Right'), 'Return']);
      let pickerPid;
      try {
        const pickerWindow = await waitForStorageNativeWindow(nativeInput, index === 1
          ? '^(Configuration and data folder|配置与数据目录)$' : '^(Temporary files and cache folder|临时与缓存目录)$', context.abortSignal);
        assert.match(pickerWindow, /^\d+$/);
        pickerPid = Number(await nativeInput(['getwindowpid', pickerWindow]));
        assert.ok(Number.isSafeInteger(pickerPid) && pickerPid > 1);
        const pickerOwnerBefore = await readFile(`/proc/${pickerPid}/stat`, 'utf8');
        const capturePickerStage = async stage => {
          await captureNativeDialog(`native-picker-${stage}-${index}`);
          const focusWindow = await nativeInput(['getwindowfocus']);
          await context.writeArtifactJson(`native-picker-${stage}-${index}.json`, {
            pickerWindow, pickerTitle: await nativeInput(['getwindowname', pickerWindow]).catch(() => null),
            focusWindow, focusTitle: await nativeInput(['getwindowname', focusWindow]).catch(() => null),
            originalHostExitCode: context.processes.get(label).child.exitCode,
            originalHostSignal: context.processes.get(label).child.signalCode,
            dialogChildPid: pickerPid, dialogChildBefore: pickerOwnerBefore,
            dialogChildAfter: await readFile(`/proc/${pickerPid}/stat`, 'utf8').catch(error => {
              if (error.code === 'ENOENT') return null;
              throw error;
            }),
          });
        };
        await nativeInput(['windowfocus', '--sync', pickerWindow]);
        await capturePickerStage('after-focus');
        await nativeInput(['key', '--clearmodifiers', 'ctrl+l']);
        await capturePickerStage('after-location-shortcut');
        await nativeInput(['type', '--clearmodifiers', '--delay', '10', root]);
        await capturePickerStage('after-type');
        await nativeInput(['key', '--clearmodifiers', 'Return']);
        await capturePickerStage('after-return');
        let choiceWindow = await visibleWindow('^KCoder (storage folders|数据位置)$');
        const remainingPicker = await visibleWindow(index === 1
          ? '^(Configuration and data folder|配置与数据目录)$' : '^(Temporary files and cache folder|临时与缓存目录)$');
        await context.writeArtifactJson(`native-picker-return-observation-${index}.json`, { choiceWindow, remainingPicker,
          originalHostExitCode: context.processes.get(label).child.exitCode, dialogChildPid: pickerPid,
          dialogChildBefore: pickerOwnerBefore,
          dialogChildAfter: await readFile(`/proc/${pickerPid}/stat`, 'utf8').catch(error => {
            if (error.code === 'ENOENT') return 'original process no longer exists; exit status unavailable after parent reap';
            throw error;
          }), originalHostLog: `logs/${label}.log`,
          dialogChildStdio: 'owned by the original execFile parent; not read from its pipes' });
        if (!choiceWindow) {
          assert.equal(remainingPicker, pickerWindow, 'only the original still-open picker may receive Open');
          assert.equal(Number(await nativeInput(['getwindowpid', pickerWindow])), pickerPid);
          assert.match(await nativeInput(['getwindowname', pickerWindow]), index === 1
            ? /^(Configuration and data folder|配置与数据目录)$/ : /^(Temporary files and cache folder|临时与缓存目录)$/);
          assert.equal(await nativeInput(['getwindowfocus']), pickerWindow);
          const geometry = await nativeInput(['getwindowgeometry', '--shell', pickerWindow]);
          const width = Number(geometry.match(/^WIDTH=(\d+)$/m)?.[1]);
          const height = Number(geometry.match(/^HEIGHT=(\d+)$/m)?.[1]);
          assert.ok(width >= 1000 && width <= 1280 && height >= 750 && height <= 900,
            'the visible Open button must retain the inspected owned picker layout');
          await capturePickerStage('before-open');
          await context.writeArtifactJson(`native-picker-open-target-${index}.json`, {
            pickerWindow, pickerPid, geometry, typedRoot: root, x: width - 55, y: height - 23,
            action: 'one click on the visible bottom-right Open button; never replay',
          });
          await nativeInput(['mousemove', '--window', pickerWindow, String(width - 55), String(height - 23),
            'click', '--clearmodifiers', '1']);
          await capturePickerStage('after-open');
          choiceWindow = await waitForStorageNativeWindow(nativeInput, '^KCoder (storage folders|数据位置)$', context.abortSignal);
        }
        assert.match(choiceWindow, /^\d+$/);
        await nativeInput(['windowfocus', '--sync', choiceWindow]);
      } catch (error) {
        // Preserve the actual owned dialog state before cleanup; do not replay input.
        const titles = [];
        try {
          const ids = await nativeInput(['search', '--onlyvisible', '--name', '.*']);
          for (const id of ids.split(/\s+/).filter(Boolean)) titles.push(await nativeInput(['getwindowname', id]));
          await captureNativeDialog('native-picker-failure');
        } catch (diagnosticError) { titles.push(`diagnostic: ${diagnosticError.message}`); }
        const owner = context.processes.get(label);
        const hostLog = await readFile(owner.logPath, 'utf8');
        await context.writeArtifactJson('native-picker-failure.json', { index, titles,
          originalHostExitCode: owner.child.exitCode, originalHostSignal: owner.child.signalCode,
          originalHostLogCodes: [...new Set(hostLog.match(/\b(?:STORAGE|CREDENTIAL_RELOCATION)_[A-Z0-9_]+\b/g) ?? [])],
          dialogChildPid: pickerPid ?? null,
          dialogChildLastObservedStat: pickerPid ? await readFile(`/proc/${pickerPid}/stat`, 'utf8').catch(error => {
            if (error.code === 'ENOENT') return null;
            throw error;
          }) : null,
          dialogChildExitStatus: 'owned by the original execFile parent; not observed from its pipes',
          locationCreated: Boolean(await lstat(location).catch(() => null)) });
        throw error;
      }
    }
    for (const path of [location, defaultDataRoot, migrations]) await assert.rejects(lstat(path), { code: 'ENOENT' });
  }
  await nativeInput(['key', '--clearmodifiers', choice === 'cancel' ? 'Escape' : 'Return']);
  const result = await pending;
  if (choice === 'cancel') {
    assert.ok(result.error, 'cancelled first launch must not reach a business page');
    const owner = context.processes.get(label);
    assert.equal(owner.child.exitCode, 0);
    await waitFor(async () => !(await storageProcessGroupMembers(owner.pgid, { includeHome: false })).length,
      15_000, 'cancelled first-launch parent and dialog both exit', 100, context.abortSignal);
    for (const path of [location, dataRoot, migrations, join(home, '.config/kcoder-studio')])
      await assert.rejects(lstat(path), { code: 'ENOENT' });
    await context.writeArtifactJson('first-launch-cancelled.json', { actualMain: true, actualNativeDialog: true,
      exitCode: owner.child.exitCode, locationAbsent: true, businessRootsAbsent: true, migrationAbsent: true });
  } else {
    if (result.error) throw result.error;
    const { desktop } = result;
    const turns = [];
    desktop.page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
      let frame; try { frame = JSON.parse(String(payload)); } catch { return; }
      if (frame.method === 'turn/start') turns.push(frame.method);
    }));
    await desktop.page.getByTestId('desktop-sidebar').waitFor({ timeout: 120_000 });
    const record = JSON.parse(await readFile(location, 'utf8'));
    assert.equal(record.dataRoot, dataRoot); assert.equal(record.cacheRoot, cacheRoot);
    assert.equal(record.revision, 1); assert.equal(record.operationId ?? null, null);
    await assert.rejects(lstat(join(migrations, 'current.json')), { code: 'ENOENT' });
    if (choice === 'custom') await assert.rejects(lstat(defaultDataRoot), { code: 'ENOENT' });
    const probe = await startStorageCliProbe(context, { label: 'first-launch-read-paths', cli,
      args: ['config', 'storage-paths'], home, env: context.isolatedEnvironment({ ...env, HOME: home, USERPROFILE: home }) }).finish();
    assert.equal(probe.exitCode, 0);
    const paths = JSON.parse(probe.stdout);
    assert.equal(paths.dataRoot, dataRoot); assert.equal(paths.cacheRoot, cacheRoot); assert.equal(paths.layout, 'unified');
    const skillLauncher = join(cacheRoot, 'gateway/skill-runtime/bin/node');
    const launcherInfo = await lstat(skillLauncher);
    assert.ok(launcherInfo.isFile() && !launcherInfo.isSymbolicLink());
    await assert.rejects(lstat(join(dataRoot, 'studio/gateway/skill-runtime')), { code: 'ENOENT' });
    const observation = await desktopStorageObservation(context, { desktop, display, xdotool, label: 'first-launch-ready' });
    const actualUserData = await observation.evaluateMain("process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron').app.getPath('userData')");
    assert.equal(actualUserData, join(dataRoot, 'studio/desktop'));
    await desktop.page.screenshot({ path: context.pathInArtifacts('first-launch-ready.png') });
    assert.equal(turns.length, 0);
    await context.writeArtifactJson(`first-launch-${choice}.json`, { actualMain: true, actualNativeDialog: true,
      record, paths, actualUserData, skillLauncher, persistentGatewaySkillRuntimeAbsent: true, observedTurnStarts: turns.length,
      quit: await quitStorageDesktop(context, { desktop, observation, home, label: 'Fresh first-launch desktop' }) });
  }
  assert.deepEqual(await identities(), before, 'first-launch acceptance must retain both frozen Native inputs');
  return { choice, actualMain: true, actualNativeDialog: true, observedTurnStarts: 0 };
});
