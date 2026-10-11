import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { recordSubagentTestInputs } from '../../harness/subagent-model.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { appRoot, repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { startNativeGatewayTransport } from '../../fixtures/android/gateway-transport.mjs';

// Actual Android emulator/release APK. Fixed SSE asserts native input, resource and lifecycle
// protocol independently of model behavior. The SDK fixture exercises actual native IME
// composition events; it does not claim physical Gboard input or an iOS device.
await runE2E(import.meta.url, { testId: 'mobile-android-native-core-flow', tier: 'manual-live',
  modelPolicy: 'model-independent actual Android APK, native input/picker/keyboard/back/background/recovery',
  retainSuccessLogs: true }, async context => {
  const sdk = process.env.KCODER_E2E_ANDROID_SDK, jdk = process.env.KCODER_E2E_JAVA_HOME;
  const apk = process.env.KCODER_E2E_ANDROID_APK;
  if (!sdk || !jdk || !apk) throw Error('UNMET_PREREQUISITE: owned SDK, JDK and current release APK paths are required');
  const adb = await requireExecutable(resolve(sdk, 'platform-tools/adb'), 'Android adb');
  const emulator = await requireExecutable(resolve(sdk, 'emulator/emulator'), 'Android emulator');
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  await recordSubagentTestInputs(context, binary);
  const tools = resolve(sdk, 'build-tools/36.0.0'), androidJar = resolve(sdk, 'platforms/android-36/android.jar');
  const androidHome = context.pathInState('android-home'), avdHome = context.pathInState('avds');
  await mkdir(context.pathInState('home'), { recursive: true });
  await mkdir(androidHome, { recursive: true }); await mkdir(avdHome, { recursive: true });
  const reservations = [];
  const reserve = async even => {
    for (let attempt = 0; attempt < 20; attempt++) {
      let server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done));
      let port = server.address().port;
      if (even && port % 2) {
        await new Promise(done => server.close(done));
        server = createServer(); port++;
        const bound = await new Promise(done => { server.once('error', () => done(false)); server.listen(port, '127.0.0.1', () => done(true)); });
        if (!bound) continue;
      }
      const release = () => new Promise(done => server.close(done));
      reservations.push(release); context.addCleanup(`release Android port ${port}`, release);
      return { port, release };
    }
    throw Error('Unable to reserve even emulator console port');
  };
  const adbPort = await reserve(false), consolePort = await reserve(true), transportPort = await reserve(false);
  const env = context.isolatedEnvironment({ ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, ANDROID_USER_HOME: androidHome,
    ANDROID_AVD_HOME: avdHome, JAVA_HOME: jdk, ADB_SERVER_SOCKET: `tcp:127.0.0.1:${adbPort.port}`,
    ANDROID_ADB_SERVER_PORT: String(adbPort.port), PATH: `${resolve(jdk, 'bin')}:${process.env.PATH}` });
  let sequence = 0;
  const run = async (label, command, args, timeout = 60000) => {
    const name = `native-${++sequence}-${label}`, child = context.spawnOwned(name, command, args, { env });
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, timeout, name, 100, context.abortSignal);
    const output = await readFile(resolve(context.logsDir, `${name}.log`), 'utf8');
    assert.equal(child.exitCode, 0, `${name} failed: ${output.slice(-2000)}`); return output;
  };
  const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
  await run('acceleration', emulator, ['-accel-check']);
  const create = context.spawnOwned('native-avd-create', resolve(sdk, 'cmdline-tools/latest/bin/avdmanager'),
    ['create', 'avd', '-n', 'kcoder-owned', '-k', 'system-images;android-35;google_apis;x86_64', '-d', 'pixel_6'], { env, stdin: 'pipe' });
  create.stdin.end('no\n'); await waitFor(() => create.exitCode !== null, 60000, 'AVD create'); assert.equal(create.exitCode, 0);
  await adbPort.release();
  const adbServer = context.spawnOwned('native-adb-server', adb, ['-L', `tcp:${adbPort.port}`, 'nodaemon', 'server'], { env });
  context.registerPort('native-adb-server', adbPort.port);
  await consolePort.release(); await transportPort.release();
  const device = context.spawnOwned('native-emulator', emulator, ['-avd', 'kcoder-owned', '-no-window', '-no-audio', '-no-boot-anim',
    '-no-snapshot', '-gpu', 'swiftshader_indirect', '-ports', `${consolePort.port},${transportPort.port}`, '-memory', '3072'], { env });
  context.registerPort('native-emulator-console', consolePort.port); context.registerPort('native-emulator-adb', transportPort.port);
  const serial = `127.0.0.1:${transportPort.port}`;
  const deviceArgs = ['-s', serial];
  await waitFor(async () => {
    if (device.exitCode !== null || device.signalCode !== null || adbServer.exitCode !== null || adbServer.signalCode !== null) throw Error('Owned emulator/adb exited before boot');
    await run('connect-owned-device', adb, ['connect', serial]).catch(() => '');
    const output = await run('boot-check', adb, [...deviceArgs, 'shell', 'getprop', 'sys.boot_completed'], 15000).catch(() => '');
    return output.trim() === '1';
  }, 240000, 'actual Android boot', 2000, context.abortSignal);
  const keystore = context.pathInState('native-fixture.jks');
  await run('driver-key', resolve(jdk, 'bin/keytool'), ['-genkeypair', '-keystore', keystore, '-storepass', 'android', '-keypass', 'android', '-alias', 'owned', '-dname', 'CN=Owned E2E', '-keyalg', 'RSA', '-validity', '2']);
  const buildFixture = async (label, folder, sourceFiles, resourceFolder) => {
    const output = context.pathInState(label); await mkdir(resolve(output, 'classes'), { recursive: true }); await mkdir(resolve(output, 'dex'), { recursive: true });
    await run(`${label}-compile`, resolve(jdk, 'bin/javac'), ['--release', '11', '-cp', androidJar, '-d', resolve(output, 'classes'), ...sourceFiles.map(file => resolve(folder, file))]);
    const packageFolder = label === 'driver' ? 'dev/kcoder/e2e' : `dev/kcoder/e2e/${label}`;
    await run(`${label}-dex`, resolve(tools, 'd8'), ['--lib', androidJar, '--output', resolve(output, 'dex'), ...sourceFiles.map(file => resolve(output, 'classes', packageFolder, file.replace('.java', '.class')))]);
    const fixtureApk = resolve(output, `${label}.apk`);
    await run(`${label}-package`, resolve(tools, 'aapt'), ['package', '-f', '-M', resolve(folder, 'AndroidManifest.xml'), '-I', androidJar, '-F', fixtureApk, ...(resourceFolder ? ['-S', resolve(folder, resourceFolder)] : [])]);
    await cp(resolve(output, 'dex/classes.dex'), resolve(output, 'classes.dex'));
    const zip = context.spawnOwned(`native-${label}-zip`, '/usr/bin/zip', ['-q', fixtureApk, 'classes.dex'], { env, cwd: output });
    await waitFor(() => zip.exitCode !== null, 15000, `package ${label}`); assert.equal(zip.exitCode, 0);
    await run(`${label}-sign`, resolve(tools, 'apksigner'), ['sign', '--ks', keystore, '--ks-pass', 'pass:android', '--key-pass', 'pass:android', fixtureApk]);
    return fixtureApk;
  };
  const fixtureRoot = resolve(appRoot, 'e2e/fixtures/android');
  const driverApk = await buildFixture('driver', fixtureRoot, ['NativeInputDriver.java']);
  const imeApk = await buildFixture('ime', resolve(fixtureRoot, 'ime'), ['NativeTestIme.java', 'CompositionReceiver.java'], 'res');
  const saveApk = await buildFixture('share', resolve(fixtureRoot, 'share'), ['NativeSaveActivity.java']);
  await waitFor(async () => (await stat(apk).catch(() => null))?.size > 1000000, 900000, 'current owned release APK build', 1000, context.abortSignal);
  await run('install-apk', adb, [...deviceArgs, 'install', '-r', apk], 120000);
  await run('install-driver', adb, [...deviceArgs, 'install', driverApk]);
  await run('install-share-consumer', adb, [...deviceArgs, 'install', '--no-incremental', saveApk]);
  await run('install-ime', adb, [...deviceArgs, 'install', '--no-incremental', imeApk]);
  const imeId = await waitFor(async () => (await run('list-ime', adb, [...deviceArgs, 'shell', 'ime', 'list', '-a', '-s'])).split(/\r?\n/).find(value => value.startsWith('dev.kcoder.e2e.ime/')), 30000, 'owned IME discovery', 500, context.abortSignal).catch(async error => {
    await run('ime-failure-logcat', adb, [...deviceArgs, 'logcat', '-d', '-t', '300']);
    throw error;
  });
  await run('enable-ime', adb, [...deviceArgs, 'shell', 'ime', 'enable', imeId]);
  await run('select-ime', adb, [...deviceArgs, 'shell', 'ime', 'set', imeId]);
  const native = async (action, selector, value) => {
    const command = ['am', 'instrument', '-w', '-e', 'action', action, '-e', 'selector', selector,
      ...(value === undefined ? [] : ['-e', 'value', value]), 'dev.kcoder.e2e/dev.kcoder.e2e.NativeInputDriver'].map(shellQuote).join(' ');
    const output = await run(`ui-${action}`, adb, [...deviceArgs, 'shell', command]);
    assert.match(output, /result=PASS/, `Native UI action failed: ${output}`);
    return output;
  };
  const captureKeyboardLayout = async (label, visibility) => {
    const output = await native('keyboard-layout', 'message-input', visibility);
    const encoded = output.match(/INSTRUMENTATION_RESULT: layout=([^\r\n]+)/)?.[1];
    assert.ok(encoded, `Native keyboard layout evidence missing: ${output}`);
    const layout = JSON.parse(encoded);
    assert.equal(layout.imeVisible, visibility === 'visible');
    const remote = '/sdcard/kcoder-owned-keyboard.png';
    const screen = context.pathInState(`keyboard-${label}.png`);
    await run(`keyboard-${label}-screenshot`, adb, [...deviceArgs, 'shell', 'screencap', '-p', remote]);
    try {
      await run(`keyboard-${label}-pull`, adb, [...deviceArgs, 'pull', remote, screen]);
      await cp(screen, context.pathInArtifacts(`android-keyboard-${label}.png`));
      await context.writeArtifactJson(`android-keyboard-${label}.json`, { label, visibility, layout, screenshot: `android-keyboard-${label}.png` });
    } finally {
      await run(`keyboard-${label}-remove-screen`, adb, [...deviceArgs, 'shell', 'rm', '-f', remote]).catch(() => {});
    }
    return layout;
  };
  const assertKeyboardLayoutRestored = (baseline, current, label) => {
    for (const view of ['appWindow', 'input']) {
      assert.ok(Array.isArray(baseline[view]) && Array.isArray(current[view]), `${label}: ${view} bounds missing`);
      assert.equal(baseline[view].length, 4, `${label}: ${view} bounds missing`);
      for (let edge = 0; edge < 4; edge++) {
        assert.ok(Math.abs(baseline[view][edge] - current[view][edge]) <= 2,
          `${label}: ${view} bounds did not return to closed-keyboard baseline; baseline=${baseline[view]}, current=${current[view]}`);
      }
    }
  };
  let releaseLong = false;
  const fixture = await startApprovalModelFixture(context, { responseSteps: ({ requestNumber }) => requestNumber === 1 ? [{ delta: { role: 'assistant', content: 'NATIVE_SEED_READY' } }, { delta: {}, finishReason: 'stop' }] : requestNumber === 2 ? [
    { delta: { role: 'assistant', content: '原生长回复\n'.repeat(800) + 'NATIVE_LONG_REPLY' } },
    { ready: () => releaseLong, delta: {}, finishReason: 'stop' },
  ] : [{ delta: { role: 'assistant', content: 'NATIVE_RETURN_COMPLETE' } }, { delta: {}, finishReason: 'stop' }] });
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  await context.writeStateJson('config/settings.json', { active_provider: 'fixture', permission_mode: 'bypass', max_retries: 0,
    providers: { fixture: { api_format: 'openai_chat_completions', endpoint: fixture.baseUrl, default_model: 'fixture', authentication: { mode: 'none' }, no_proxy: true, max_output_tokens: 8192, context_window_tokens: 128000, output_headroom_tokens: 8192 } } });
  const transport = await startNativeGatewayTransport(context);
  const gateway = await startGateway(context, { workspace, kcoderBin: binary, env: { KCODER_CONFIG_DIR: context.pathInState('config'), KCODER_STUDIO_PUBLIC_ORIGINS: transport.baseUrl,
    NODE_OPTIONS: `--import ${resolve(fixtureRoot, 'attachment-observer.mjs')}`, KCODER_E2E_NATIVE_ATTACHMENT_SCHEMA: context.pathInArtifacts('native-attachment-schema.json') } });
  transport.setTarget(gateway);
  await run('reverse-gateway', adb, [...deviceArgs, 'reverse', `tcp:${transport.port}`, `tcp:${transport.port}`]);
  const packageName = 'dev.kcoder.studio.audit';
  await run('launch', adb, [...deviceArgs, 'shell', 'am', 'start', '-n', `${packageName}/.MainActivity`]);
  try {
    await native('click', 'welcome-direct-connection');
    await native('set', 'gateway-endpoint', transport.baseUrl);
    await native('click', 'gateway-connect');
    await native('click', 'new-workspace');
    await native('set', 'new-workspace-prompt', '中文输入第一行\n第二行 NATIVE_INITIAL');
    await native('assert', 'new-workspace-prompt', '中文输入第一行\n第二行 NATIVE_INITIAL');
    await native('click', 'create-workspace');
    await native('wait', 'NATIVE_SEED_READY');
    await native('set', 'message-input', '后台中文草稿');
    const keyboardBaseline = await captureKeyboardLayout('baseline-hidden', 'hidden');
    await native('click', 'message-input');
    await captureKeyboardLayout('open-first', 'visible');
    await native('keyboard-safe', 'message-input');
    await run('keyboard-hide-first', adb, [...deviceArgs, 'shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    const keyboardHiddenFirst = await captureKeyboardLayout('hidden-first', 'hidden');
    assertKeyboardLayoutRestored(keyboardBaseline, keyboardHiddenFirst, 'first keyboard hide');
    await native('click', 'message-input');
    await captureKeyboardLayout('open-second', 'visible');
    await native('keyboard-safe', 'message-input');
    await run('keyboard-hide-second', adb, [...deviceArgs, 'shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    const keyboardHiddenSecond = await captureKeyboardLayout('hidden-second', 'hidden');
    assertKeyboardLayoutRestored(keyboardBaseline, keyboardHiddenSecond, 'second keyboard hide after reopen');
    await native('click', 'message-input');
    const composition = await run('native-composition', adb, [...deviceArgs, 'shell', 'am', 'broadcast', '-n', 'dev.kcoder.e2e.ime/.CompositionReceiver', '--es', 'value', '中文组合']);
    assert.match(composition, /PASS_COMPOSITION_AND_ENTER/);
    await native('assert', 'message-input', '后台中文草稿中文组合\n');
    await native('keyboard-safe', 'message-input');
    assert.equal(fixture.requests.length, 1, 'native composition and Enter do not send a new request');
    await native('click', 'composer-attachment');
    await native('click', '拍照');
    await native('click', 'permission_deny_button');
    await native('wait', '需要相机权限才能拍照');
    await native('click', '拍照');
    await native('click', 'permission_allow_foreground_only_button');
    await waitFor(async () => /[Rr]esumedActivity[^\n]*(?:camera2|CameraActivity|com\.android\.camera)/i.test(await run('camera-ready', adb, [...deviceArgs, 'shell', 'dumpsys', 'activity', 'activities'])), 20000, 'native camera activity', 100, context.abortSignal);
    await run('camera-back', adb, [...deviceArgs, 'shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    await native('wait', '添加附件');
    await run('attachment-back', adb, [...deviceArgs, 'shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    await native('assert', 'message-input', '后台中文草稿中文组合\n');
    await native('click', 'composer-attachment');
    await native('click', '照片图库');
    await native('wait', 'Photos');
    await run('photos-back', adb, [...deviceArgs, 'shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    await native('wait', '添加附件');
    const localNote = context.pathInState('native-note.txt');
    await writeFile(localNote, 'NATIVE_ATTACHMENT_CONTENT 中文附件\n');
    await run('push-note', adb, [...deviceArgs, 'push', localNote, '/sdcard/Download/native-note.txt']);
    await native('click', '选择文件');
    await native('click', 'Show roots');
    await native('click', 'Downloads');
    await native('choose-file', 'native-note.txt');
    await native('wait', 'staged-attachment-native-note.txt');
    await native('click', 'staged-attachment-native-note.txt');
    await native('wait', 'native-note.txt');
    const activity = await run('native-share-state', adb, [...deviceArgs, 'shell', 'dumpsys', 'activity', 'activities']);
    assert.match(activity, /ChooserActivity|ResolverActivity/, 'native download opens the OS save/share boundary');
    await native('click', 'KCoder native save fixture');
    await native('wait', 'PASS_NATIVE_DOWNLOAD_CONTENT');
    await run('share-back', adb, [...deviceArgs, 'shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    await native('wait', 'message-input');
    await native('click', 'send-message');
    await native('wait', 'NATIVE_LONG_REPLY');
    assert.ok(JSON.stringify(fixture.requests[1]?.messages).includes('native-note.txt'), 'the actual native send preserves attachment metadata in the Provider request');
    await native('click', 'stop-turn');
    await waitFor(() => fixture.requestOutcomes[1]?.aborted, 15000, 'actual native interrupted transport');
    await native('set', 'message-input', '后台中文草稿中文组合\n');
    await run('background', adb, [...deviceArgs, 'shell', 'input', 'keyevent', 'KEYCODE_HOME']);
    await run('lock', adb, [...deviceArgs, 'shell', 'input', 'keyevent', 'KEYCODE_SLEEP']);
    await run('wake', adb, [...deviceArgs, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
    await run('unlock', adb, [...deviceArgs, 'shell', 'wm', 'dismiss-keyguard']);
    await run('return', adb, [...deviceArgs, 'shell', 'am', 'start', '-n', `${packageName}/.MainActivity`]);
    await native('assert', 'message-input', '后台中文草稿中文组合\n');
    assert.equal(fixture.requests.length, 2, 'background/return does not automatically resend');
    transport.setOnline(false);
    await native('wait', '连接已断开');
    await native('assert-readonly', 'message-input');
    await native('assert-readonly', 'send-message');
    transport.setOnline(true);
    await native('wait-editable', 'message-input');
    await native('assert', 'message-input', '后台中文草稿中文组合\n');
    assert.ok(transport.droppedConnections > 0);
    assert.equal(fixture.requests.length, 2, 'actual socket loss/reconnect does not resend the interrupted turn');
    await native('click', 'send-message');
    await native('wait', 'NATIVE_RETURN_COMPLETE');
    assert.equal(fixture.requests.length, 3, 'only the seed and two explicit native sends reach the fixture');
    await native('click', 'mobile-subagents-open');
    await native('wait', '暂无可查看的子代理');
    await native('click', '返回');
    await native('wait', 'message-input');
    const deviceInfo = await run('device-info', adb, [...deviceArgs, 'shell', 'getprop']);
    const screenshot = context.pathInState('native-screen.png');
    await run('screenshot', adb, [...deviceArgs, 'shell', 'screencap', '-p', '/sdcard/kcoder-owned-e2e.png']);
    await run('pull-screen', adb, [...deviceArgs, 'pull', '/sdcard/kcoder-owned-e2e.png', screenshot]);
    await cp(screenshot, context.pathInArtifacts('android-native-core.png'));
    await context.writeArtifactJson('android-native-device.json', { sdkImage: 'system-images;android-35;google_apis;x86_64',
      apk: { path: apk, sourceRevision: process.env.KCODER_E2E_ANDROID_APK_SOURCE_REVISION || null, bytes: (await stat(apk)).size, sha256: createHash('sha256').update(await readFile(apk)).digest('hex') },
      build: deviceInfo.match(/\[ro.build.fingerprint\]: \[(.+)\]/)?.[1], androidVersion: deviceInfo.match(/\[ro.build.version.release\]: \[(.+)\]/)?.[1],
      model: deviceInfo.match(/\[ro.product.model\]: \[(.+)\]/)?.[1], packageName, nativeExecution: true,
      chineseAccessibilityInput: true, chineseImeComposition: 'PASS native InputConnection setComposingText/finishComposingText/Enter; controlled SDK IME, no physical Gboard claim',
      keyboardIme: 'controlled SDK IME visibility and native bounds sampling; no physical Gboard claim',
      ios: 'NOT RUN: macOS simulator/device unavailable', screenshotReason: 'keyboard show-hide-reopen-hide baseline plus one representative actual native return-after-interrupt path' });
    return { actualAndroid: true, chineseUnicodeAndNewline: true, nativeImeCompositionAndEnter: true, keyboardShowHideReopenHide: true, keyboardBoundsRestoredWithinPx: 2, keyboardSnapshots: ['baseline-hidden', 'open-first', 'hidden-first', 'open-second', 'hidden-second'], longStreamingReply: true, nativeInterrupt: true, backgroundLockReturnDraft: true, nativeSocketLossRecovery: true, cameraPermissionDeniedThenGranted: true, photoPickerCancel: true, documentPickerUpload: true, nativeDownloadSavedBytes: true, systemBack: true, noAutomaticResend: true, ios: 'NOT RUN' };
  } catch (error) {
    const screen = context.pathInState('native-failure.png');
    await run('failure-screen', adb, [...deviceArgs, 'shell', 'screencap', '-p', '/sdcard/kcoder-owned-failure.png']).catch(() => {});
    await run('pull-failure', adb, [...deviceArgs, 'pull', '/sdcard/kcoder-owned-failure.png', screen]).catch(() => {});
    await cp(screen, context.pathInArtifacts('android-native-failure.png')).catch(() => {});
    await run('failure-tree', adb, [...deviceArgs, 'shell', 'uiautomator', 'dump', '/sdcard/kcoder-owned-failure.xml']).catch(() => {});
    await run('pull-tree', adb, [...deviceArgs, 'pull', '/sdcard/kcoder-owned-failure.xml', context.pathInArtifacts('android-native-failure.xml')]).catch(() => {});
    throw error;
  } finally { releaseLong = true; }
});
