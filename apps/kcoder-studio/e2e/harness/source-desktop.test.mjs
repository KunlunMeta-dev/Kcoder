import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { startSourceDesktop, windowsDesktopTemporaryDirectory } from './source-desktop.mjs';

function fixture({ failConnect = false } = {}) {
  const calls = [], cleanup = [];
  const child = { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null };
  const page = { url: () => 'http://127.0.0.1:32111/',
    waitForLoadState: async state => { calls.push(['load-state', state]); } };
  const context = {
    pathInState: name => `/owned/state/${name}`,
    isolatedEnvironment: env => env,
    spawnOwned(label, binary, args, options) {
      calls.push(['spawn', label, binary, args, options]);
      queueMicrotask(() => child.stderr.emit('data', 'DevTools listening on ws://127.0.0.1:32112/devtools/browser/owned\n'));
      return child;
    },
    registerPort: (label, port) => calls.push(['port', label, port]),
    addCleanup: (label, action) => cleanup.push([label, action]),
    writeArtifactJson: async (name, value) => { calls.push(['artifact', name, value]); },
    stopOwned: async label => { calls.push(['stop', label]); },
  };
  const dependencies = {
    platform: 'linux', noSandbox: true, executable: async path => path,
    inspectTargets: async () => [],
    connect: async () => {
      if (failConnect) throw new Error('fixture connection failure');
      return { contexts: () => [{ pages: () => [page] }], close: async () => { calls.push(['disconnect']); } };
    },
  };
  return { context, dependencies, calls, cleanup };
}
const options = { label: 'gallery', profile: '/owned/state/profile', servers: '/owned/state/servers.json', workspace: '/owned/state/workspace' };

test('Windows temporary directories fit Native Git aliases at the observed installed run depth', () => {
  const state = 'D:\\kcoder-ar-107c53075-8b50ad7d\\source\\target\\test\\apps\\kcoder-studio\\e2e\\suites\\browser\\workspace-file-read-refresh.e2e.mjs\\20261027-084640.789Z\\state';
  const context = { pathInState: name => `${state}\\${name}` };
  const directory = windowsDesktopTemporaryDirectory(context, 'workspace-file-read-electron');
  assert.ok(Buffer.byteLength(`${state}\\workspace-file-read-electron-temporary\\kg-${'a'.repeat(32)}\\g`) > 219);
  assert.ok(Buffer.byteLength(`${directory}\\kg-${'a'.repeat(32)}\\g`) <= 219);
  assert.ok(directory.startsWith(`${state}\\`));
  assert.equal(windowsDesktopTemporaryDirectory(context, 'workspace-file-read-electron'), directory);
  assert.notEqual(windowsDesktopTemporaryDirectory(context, 'comparison-electron'), directory);
  assert.throws(() => windowsDesktopTemporaryDirectory({ pathInState: name => `${state}\\${'深'.repeat(20)}\\${name}` }, 'desktop'), /shorter checkout path/);
});

test('pinned packaged Windows Native captures and reads a real long-path mutation', {
  skip: process.platform !== 'win32' || !process.env.KCODER_E2E_STATE_NATIVE_BIN,
}, async () => {
  const { mkdir, readFile, readdir } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { runE2E } = await import('./run-context.mjs');
  const { hashExecutableFile } = await import('./owned-executable-provenance.mjs');
  const { waitForStdioChildClose } = await import('./app-server-stdio.mjs');
  const { startApprovalModelFixture } = await import('./approval-model.mjs');
  await runE2E(import.meta.url, {
    testId: 'windows-packaged-native-short-temp-long-workspace', tier: 'full-integration', retainSuccessLogs: true,
    modelPolicy: 'deterministic local tool/protocol fixture; pinned packaged Native snapshot/diff; no model-quality claim',
  }, async context => {
    const binary = await hashExecutableFile(process.env.KCODER_E2E_STATE_NATIVE_BIN);
    assert.match(process.env.KCODER_E2E_STATE_NATIVE_SHA256 ?? '', /^[a-f0-9]{64}$/);
    assert.equal(binary.sha256, process.env.KCODER_E2E_STATE_NATIVE_SHA256);
    const workspace = context.pathInState('workspaces/workspace-file-read');
    const profileName = 'review-config';
    const profile = context.pathInState(profileName);
    const temporary = windowsDesktopTemporaryDirectory(context, 'native-git-regression');
    for (const path of [workspace, profile, temporary]) await mkdir(path, { recursive: true });
    let snapshotObservation = null, snapshotObservationError = null;
    const model = await startApprovalModelFixture(context, { responseSteps: ({ requestNumber }) => {
      if (requestNumber === 1) return [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'owned-write', type: 'function', function: {
        name: 'write', arguments: JSON.stringify({ file_path: 'result.txt', content: 'Owned Native long-path result\n' }),
      } }] }, finishReason: 'tool_calls' }];
      // The repository exists until turn finalization. Hold the terminal fixture
      // response while observing it; successful cleanup must not falsify coverage.
      void readdir(context.stateDir, { recursive: true }).then(paths => {
        snapshotObservation = { longestSnapshotPathBytes: Math.max(0, ...paths
          .filter(path => path.includes('snapshot-repository-'))
          .map(path => Buffer.byteLength(resolve(context.stateDir, path)))) };
      }).catch(error => { snapshotObservationError = error; snapshotObservation = { longestSnapshotPathBytes: 0 }; });
      return [{ ready: () => snapshotObservation !== null,
        delta: { role: 'assistant', content: 'OWNED_CAPTURE_COMPLETE' }, finishReason: 'stop' }];
    },
    });
    await context.writeStateJson(`${profileName}/credentials.json`, { 'snapshot-fixture': { type: 'api', key: 'owned-local-fixture' } });
    const settingsPath = await context.writeStateJson(`${profileName}/settings.json`, {
      integrations: { office: { enabled: true } },
      permission_mode: 'accept_edits', permission_rules: [{ tool: 'write', input_pattern: 'file_path=result.txt', action: 'allow' }],
      active_provider: 'snapshot-fixture', providers: { 'snapshot-fixture': {
        api_format: 'openai_chat_completions', endpoint: model.baseUrl, default_model: 'snapshot-fixture',
        context_window_tokens: 128000, output_headroom_tokens: 8192, max_output_tokens: 8192,
        request_timeout_secs: 30, no_proxy: true, extra_body: {},
      } },
    });
    const originalSettings = await readFile(settingsPath);
    // The owned Node worker and its Native child inherit the supervisor's Job.
    // The supervisor stdin remains its control channel, separate from Native JSONL.
    const child = context.spawnOwned('packaged-native-snapshot', process.execPath, [
      fileURLToPath(new URL('windows-short-temp-native.mjs', import.meta.url)), binary.path, workspace,
      context.pathInState('capture.json'),
    ], {
      cwd: context.stateDir, env: context.isolatedEnvironment({
        KCODER_CONFIG_DIR: profile, TEMP: temporary, TMP: temporary, TMPDIR: temporary,
      }),
    });
    const closed = await waitForStdioChildClose(child, 90000);
    assert.equal(closed.code, 0, 'inspect packaged-native-snapshot.log for the actual Native failure');
    assert.deepEqual(await readFile(settingsPath), originalSettings, 'startup must preserve the existing Office configuration');
    const result = JSON.parse(await readFile(context.pathInState('capture.json'), 'utf8'));
    await context.writeArtifactJson('packaged-native-capture.json', { binary: { path: binary.path, sha256: binary.sha256 }, temporary, workspace,
      existingOfficeConfiguration: { enabled: true, unchanged: true }, ...result, ...snapshotObservation });
    assert.equal(result.realNativeSnapshot, true);
    assert.equal(result.realDiffReadable, true);
    assert.equal(snapshotObservationError, null);
    assert.ok(snapshotObservation?.longestSnapshotPathBytes > 219, 'exercise actual private snapshot Git path aliases');
    assert.equal(model.requests.length, 2);
    return { ...result, providerRequests: model.requests.length };
  });
});

test('source host owns its process, private profile and dynamic CDP; repeated cleanup is safe', async () => {
  const value = fixture();
  const desktop = await startSourceDesktop(value.context, options, value.dependencies);
  const spawn = value.calls.find(call => call[0] === 'spawn');
  assert.equal(spawn[4].env.KCODER_CONFIG_DIR, '/owned/state/profile');
  assert.equal(spawn[4].env.KCODER_STUDIO_DESKTOP_USER_DATA_DIR, '/owned/state/gallery-profile');
  assert.ok(spawn[3].includes('--remote-debugging-port=0'));
  assert.ok(spawn[3].includes('--no-sandbox'), 'Linux retains its explicit isolated-root opt-in');
  assert.deepEqual(value.calls.find(call => call[0] === 'port'), ['port', 'gallery-cdp', 32112]);
  await desktop.stop(); await desktop.stop();
  for (const [, action] of value.cleanup) await action();
  assert.equal(value.calls.filter(call => call[0] === 'stop').length, 1);
  assert.equal(value.calls.filter(call => call[0] === 'disconnect').length, 1);
});

test('source host requires a supported display and explicit no-sandbox prerequisites before spawning', async () => {
  const value = fixture();
  await assert.rejects(startSourceDesktop(value.context, options, { ...value.dependencies, noSandbox: false }), /UNMET_PREREQUISITE/);
  await assert.rejects(startSourceDesktop(value.context, options, { ...value.dependencies, platform: 'darwin' }), /UNMET_PREREQUISITE/);
  assert.equal(value.calls.length, 0);
});

test('Windows host uses only its owned wrapper, protected profile/temp and required window receipt', async () => {
  const value = fixture();
  const previous = process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN;
  process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN = 'C:\\owned\\supervisor.exe';
  let closed = false;
  const receipt = { owner: 'fixture-owner', nativeWindow: { hwnd: '0x123', visible: true } };
  const prepareWindows = async (_context, input) => {
    value.calls.push(['prepare-windows', input]);
    return { command: 'C:\\Windows\\powershell.exe', args: ['private-wrapper'], options: { env: input.env },
      ready: async child => { value.calls.push(['window-receipt', child]); return receipt; },
      close: async () => { if (closed) return; closed = true; value.calls.push(['release-desktop']); await value.context.stopOwned(input.label); },
    };
  };
  try {
    const desktop = await startSourceDesktop(value.context, { ...options, env: {
      APPDATA: 'C:\\personal', LOCALAPPDATA: 'C:\\personal', TEMP: 'C:\\personal', TMP: 'C:\\personal', TMPDIR: 'C:\\personal',
    } }, { ...value.dependencies, platform: 'win32', noSandbox: false, prepareWindows });
    const input = value.calls.find(call => call[0] === 'prepare-windows')[1];
    assert.equal(input.args.includes('--no-sandbox'), false, 'Windows must use the normal Chromium sandbox');
    assert.equal(input.args.includes('--disable-gpu-sandbox'), false);
    assert.equal(input.args.includes('--disable-gpu'), true);
    for (const [key, expected] of Object.entries({ APPDATA: 'gallery-appdata', LOCALAPPDATA: 'gallery-local-appdata' }))
      assert.equal(input.env[key], `/owned/state/${expected}`);
    for (const key of ['TEMP', 'TMP', 'TMPDIR']) assert.equal(input.env[key], windowsDesktopTemporaryDirectory(value.context, options.label));
    assert.equal(value.calls.find(call => call[0] === 'spawn')[2], 'C:\\Windows\\powershell.exe');
    assert.equal(desktop.hostReceipt, receipt);
    await desktop.stop();
    for (const [, action] of [...value.cleanup].reverse()) await action();
    assert.equal(value.calls.filter(call => call[0] === 'release-desktop').length, 1);
    assert.equal(value.calls.filter(call => call[0] === 'stop').length, 1);
    assert.equal(value.calls.filter(call => call[0] === 'disconnect').length, 1);
  } finally {
    if (previous === undefined) delete process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN;
    else process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN = previous;
  }
});

test('Windows wrapper or receipt failures never fall back to an unowned display', async () => {
  const previous = process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN;
  try {
    delete process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN;
    const absent = fixture();
    await assert.rejects(startSourceDesktop(absent.context, options, { ...absent.dependencies, platform: 'win32', noSandbox: false }), /explicit Windows process supervisor/);
    assert.equal(absent.calls.length, 0);
    await assert.rejects(startSourceDesktop(absent.context, options, { ...absent.dependencies, platform: 'win32', noSandbox: true }), /normal Chromium sandbox/);
    assert.equal(absent.calls.length, 0, 'Windows sandbox opt-out must fail before spawning');
    process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN = 'C:\\owned\\supervisor.exe';
    const failed = fixture();
    await assert.rejects(startSourceDesktop(failed.context, options, { ...failed.dependencies, platform: 'win32', noSandbox: false,
      prepareWindows: async () => { throw new Error('private station unavailable'); },
    }), /private station unavailable/);
    assert.equal(failed.calls.length, 0);
    const invalid = fixture();
    await assert.rejects(startSourceDesktop(invalid.context, options, { ...invalid.dependencies, platform: 'win32', noSandbox: false,
      prepareWindows: async () => ({ command: 'private-wrapper', args: [], options: {},
        ready: async () => { throw new Error('window owner mismatch'); },
        close: async () => invalid.context.stopOwned('gallery'),
      }),
    }), /window owner mismatch/);
    for (const [, action] of [...invalid.cleanup].reverse()) await action();
    assert.equal(invalid.calls.filter(call => call[0] === 'spawn').length, 1);
    assert.equal(invalid.calls.filter(call => call[0] === 'stop').length, 1);
    assert.deepEqual(invalid.calls.find(call => call[0] === 'artifact'),
      ['artifact', 'gallery-startup-targets.json', { targets: [], pages: [] }]);
    assert.equal(invalid.calls.filter(call => call[0] === 'disconnect').length, 1);
  } finally {
    if (previous === undefined) delete process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN;
    else process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN = previous;
  }
});


test('optional fixture environment passes PATH/TMPDIR but cannot replace owned host fields', async () => {
  const value = fixture();
  const desktop = await startSourceDesktop(value.context, { ...options, kcoderBin: '/owned/state/bin/kcoder', rendererRoot: '/owned/state/dist', env: {
    PATH: '/owned/state/fixture-bin:/usr/bin', TMPDIR: '/owned/state/tmp', HOME: '/unowned/home', USERPROFILE: '/unowned/profile',
    ELECTRON_RUN_AS_NODE: '1', KCODER_CONFIG_DIR: '/unowned/config', KCODER_STUDIO_SERVERS_FILE: '/unowned/servers',
    KCODER_STUDIO_WORKSPACE: '/unowned/workspace', KCODER_STUDIO_KCODER_BIN: '/unowned/bin',
    KCODER_STUDIO_DESKTOP_USER_DATA_DIR: '/unowned/user-data', KCODER_STUDIO_WEB_ROOT: '/unowned/dist',
  } }, value.dependencies);
  const env = value.calls.find(call => call[0] === 'spawn')[4].env;
  assert.equal(env.PATH, '/owned/state/fixture-bin:/usr/bin'); assert.equal(env.TMPDIR, '/owned/state/tmp');
  assert.equal(env.HOME, '/owned/state/home'); assert.equal(env.USERPROFILE, '/owned/state/home'); assert.equal(env.ELECTRON_RUN_AS_NODE, '');
  assert.equal(env.KCODER_CONFIG_DIR, options.profile); assert.equal(env.KCODER_STUDIO_SERVERS_FILE, options.servers);
  assert.equal(env.KCODER_STUDIO_WORKSPACE, options.workspace); assert.equal(env.KCODER_STUDIO_KCODER_BIN, '/owned/state/bin/kcoder');
  assert.equal(env.KCODER_STUDIO_DESKTOP_USER_DATA_DIR, '/owned/state/gallery-profile'); assert.equal(env.KCODER_STUDIO_WEB_ROOT, '/owned/state/dist');
  await desktop.stop();
});

test('actual installed host launches its exe with packaged resources and no source main or Native override', async () => {
  const value = fixture(); const previous = process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN;
  process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN = 'C:\\owned\\supervisor.exe';
  const identity = { root: 'D:\\installed', hostPath: 'D:\\installed\\kcoder-studio.exe', nativePath: 'D:\\installed\\resources\\bin\\kcoder.exe' };
  let launch;
  try {
    const desktop = await startSourceDesktop(value.context, { ...options, servers: undefined,
      installedDirectory: identity.root, installedIdentity: { manifestSha256: 'a'.repeat(64), hostSha256: 'b'.repeat(64) },
    }, { ...value.dependencies, platform: 'win32', noSandbox: false,
      prepareInstalled: async (_context, input) => { assert.equal(input.directory, identity.root); return identity; },
      prepareWindows: async (_context, input) => { launch = input; return {
        command: 'owned-wrapper', args: [], options: {}, ready: async () => ({}), close: async () => {},
      }; },
    });
    assert.equal(launch.electron, identity.hostPath);
    assert.equal(launch.cwd, identity.root);
    assert.equal(launch.args.some(argument => argument.endsWith('main.mjs')), false);
    assert.equal(launch.args.includes('--no-sandbox'), false);
    for (const key of ['KCODER_STUDIO_KCODER_BIN', 'KCODER_STUDIO_WEB_ROOT', 'KCODER_STUDIO_GATEWAY_SCRIPT']) assert.equal(launch.env[key], undefined);
    assert.equal(launch.env.KCODER_CONFIG_DIR, options.profile);
    assert.equal(desktop.installedIdentity, identity);
    assert.equal(desktop.nativeWitness, null);
    await desktop.stop();
  } finally { if (previous === undefined) delete process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN; else process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN = previous; }
});

test('installed source overrides fail before allocation; only a verified explicit Native witness is admitted', async () => {
  const previous = process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN;
  process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN = 'C:\\owned\\supervisor.exe';
  try {
    for (const patch of [{ kcoderBin: 'C:\\source\\kcoder.exe' }, { rendererRoot: 'C:\\source\\dist' },
      { servers: 'C:\\source\\servers.json' }, { env: { KCODER_STUDIO_WEB_ROOT: 'C:\\source' } },
      { env: { KCODER_STUDIO_KCODER_BIN: 'C:\\source\\kcoder.exe' } },
      { env: { KCODER_STUDIO_SERVERS: '[source]' } }, { env: { KCODER_STUDIO_GATEWAY_SCRIPT: 'C:\\source' } }]) {
      const value = fixture();
      await assert.rejects(startSourceDesktop(value.context, { ...options, servers: undefined, installedDirectory: 'D:\\installed', ...patch },
        { ...value.dependencies, platform: 'win32', noSandbox: false }), /cannot/);
      assert.equal(value.calls.length, 0);
    }
    const value = fixture(); let launch, verified = false;
    const witness = { path: '/owned/state/fixed-native-witness.exe' };
    const desktop = await startSourceDesktop(value.context, { ...options, servers: undefined, installedDirectory: 'D:\\installed', nativeWitness: witness },
      { ...value.dependencies, platform: 'win32', noSandbox: false,
        prepareInstalled: async () => ({ root: 'D:\\installed', hostPath: 'D:\\installed\\kcoder-studio.exe' }),
        verifyWitness: async (_context, _installed, requested) => { assert.equal(requested, witness); verified = true; return witness; },
        prepareWindows: async (_context, input) => { launch = input; return { command: 'owned-wrapper', args: [], options: {}, ready: async () => ({}), close: async () => {} }; },
      });
    assert.equal(verified, true);
    assert.equal(launch.env.KCODER_STUDIO_KCODER_BIN, witness.path);
    assert.equal(launch.env.KCODER_STUDIO_WEB_ROOT, undefined);
    assert.equal(desktop.nativeWitness, witness);
    await desktop.stop();
  } finally { if (previous === undefined) delete process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN; else process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN = previous; }
});

test('automatic LIFO cleanup awaits its owned host exit before closing the CDP client', async () => {
  const value = fixture(), order = [];
  let hostEnded = false;
  value.context.stopOwned = async label => {
    assert.equal(label, options.label); order.push('host-stop');
    await Promise.resolve(); hostEnded = true; order.push('host-ended');
  };
  value.dependencies.connect = async () => ({
    contexts: () => [{ pages: () => [{ url: () => 'http://127.0.0.1:32111/' }] }],
    close: async () => { order.push('cdp-close'); assert.equal(hostEnded, true, 'CDP closure depends on the original owned host ending'); },
  });
  const desktop = await startSourceDesktop(value.context, options, value.dependencies);
  for (const [, action] of [...value.cleanup].reverse()) await action();
  await desktop.stop();
  assert.deepEqual(order, ['host-stop', 'host-ended', 'cdp-close']);
});

test('an owned-host stop failure still attempts CDP closure and remains failed on repeated cleanup', async () => {
  const value = fixture(), failure = new Error('owned host exit unconfirmed'), order = [];
  value.context.stopOwned = async () => { order.push('host-stop'); throw failure; };
  value.dependencies.connect = async () => ({
    contexts: () => [{ pages: () => [{ url: () => 'http://127.0.0.1:32111/' }] }],
    close: async () => { order.push('cdp-close'); },
  });
  const desktop = await startSourceDesktop(value.context, options, value.dependencies);
  await assert.rejects(desktop.stop(), error => error === failure);
  await assert.rejects(value.cleanup.at(-1)[1](), error => error === failure);
  assert.deepEqual(order, ['host-stop', 'cdp-close']);
});

test('CDP close errors remain visible and are not retried or turned into successful cleanup', async () => {
  const value = fixture(), failure = new Error('owned CDP close unconfirmed');
  let attempts = 0;
  value.dependencies.connect = async () => ({
    contexts: () => [{ pages: () => [{ url: () => 'http://127.0.0.1:32111/' }] }],
    close: async () => { attempts++; throw failure; },
  });
  const desktop = await startSourceDesktop(value.context, options, value.dependencies);
  await assert.rejects(desktop.stop(), error => error === failure);
  await assert.rejects(value.cleanup.at(-1)[1](), error => error === failure);
  assert.equal(attempts, 1);
  assert.equal(value.calls.filter(call => call[0] === 'stop').length, 1);
});

test('owned-host and CDP cleanup failures are both retained in their original order', async () => {
  const value = fixture(), hostFailure = new Error('owned host stop failed'), cdpFailure = new Error('CDP disconnect failed');
  const order = [];
  value.context.stopOwned = async () => { order.push('host-stop'); throw hostFailure; };
  value.dependencies.connect = async () => ({
    contexts: () => [{ pages: () => [{ url: () => 'http://127.0.0.1:32111/' }] }],
    close: async () => { order.push('cdp-close'); throw cdpFailure; },
  });
  const desktop = await startSourceDesktop(value.context, options, value.dependencies);
  for (const action of [() => desktop.stop(), value.cleanup.at(-1)[1]]) {
    await assert.rejects(action(), error => error instanceof AggregateError && error.errors.length === 2 && error.errors[0] === hostFailure && error.errors[1] === cdpFailure);
  }
  assert.deepEqual(order, ['host-stop', 'cdp-close']);
});
