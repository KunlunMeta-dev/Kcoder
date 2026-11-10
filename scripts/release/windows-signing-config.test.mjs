import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { loadWindowsSigningConfiguration, runWithWindowsSigning, verifyWindowsSigningTool } from './windows-signing-config.mjs';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'kcoder-windows-signing-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'repository'), certificate = join(base, 'release.pfx'), passwords = join(base, 'signing.env');
  await mkdir(root);
  await writeFile(certificate, 'opaque-private-pfx', { mode: 0o600 });
  await writeFile(passwords, 'KCODER_WINDOWS_CERTIFICATE_PASSWORD=fixture-password\nUNRELATED_SECRET=not-imported', { mode: 0o600 });
  await writeFile(join(root, '.env'), `KCODER_WINDOWS_CERTIFICATE_PATH=${certificate}\nKCODER_WINDOWS_SIGNING_ENV_FILE=${passwords}\nKCODER_STUDIO_AUTH_TOKEN=unrelated\n`);
  return { base, root, certificate, passwords };
}

test('repository paths load a private signing identity without importing repository passwords or changing process state', async t => {
  const f = await fixture(t), source = { PATH: '/usr/bin' };
  await writeFile(join(f.root, '.env'), `KCODER_WINDOWS_CERTIFICATE_PATH=${f.certificate}\nKCODER_WINDOWS_SIGNING_ENV_FILE=${f.passwords}\nKCODER_WINDOWS_CERTIFICATE_PASSWORD=must-ignore\n`);
  const signing = await loadWindowsSigningConfiguration(f.root, source);
  assert.deepEqual(signing, { enabled: true, certificateFile: f.certificate, password: 'fixture-password' });
  assert.deepEqual(source, { PATH: '/usr/bin' });
});

test('explicit process values override repository paths and do not read the operator password file', async t => {
  const f = await fixture(t), certificate = join(f.base, 'process.p12');
  await writeFile(certificate, 'another-private-pfx', { mode: 0o600 });
  const signing = await loadWindowsSigningConfiguration(f.root, {
    KCODER_WINDOWS_CERTIFICATE_PATH: certificate,
    KCODER_WINDOWS_CERTIFICATE_PASSWORD: 'process-password',
    KCODER_WINDOWS_SIGNING_ENV_FILE: '/does-not-exist/operator.env',
  });
  assert.equal(signing.certificateFile, certificate);
  assert.equal(signing.password, 'process-password');
});

test('missing configuration warns and explicitly disables ambient certificate discovery', async t => {
  const f = await fixture(t);
  await rm(join(f.root, '.env'));
  const signing = await loadWindowsSigningConfiguration(f.root, {});
  assert.equal(signing.enabled, false);
  const warnings = [];
  t.mock.method(console, 'warn', message => warnings.push(message));
  const result = await runWithWindowsSigning(signing, options => {
    assert.deepEqual(options, { toolsets: { winCodeSign: '1.1.0' }, forceCodeSigning: false, win: { signExecutable: false } });
    return 'unsigned-build';
  });
  assert.equal(result, 'unsigned-build');
  assert.match(warnings.join('\n'), /UNSIGNED/);
});

test('partial or invalid signing configuration fails instead of silently producing an unsigned installer', async t => {
  const f = await fixture(t);
  await assert.rejects(loadWindowsSigningConfiguration(f.root, { KCODER_WINDOWS_CERTIFICATE_PATH: '' }), /partially configured/);
  await assert.rejects(loadWindowsSigningConfiguration(f.root, { KCODER_WINDOWS_CERTIFICATE_PATH: '/not-found.pfx' }), { code: 'ENOENT' });
  await assert.rejects(loadWindowsSigningConfiguration(f.root, { KCODER_WINDOWS_CERTIFICATE_PATH: '/not-a-pfx.txt' }), /\.pfx/);
  await writeFile(f.passwords, 'UNRELATED_SECRET=ignored', { mode: 0o600 });
  await assert.rejects(loadWindowsSigningConfiguration(f.root, {}), /requires KCODER_WINDOWS_CERTIFICATE_PASSWORD/);
});

test('credentials must be outside the repository and private; linked credentials are rejected', async t => {
  const f = await fixture(t);
  const load = overrides => loadWindowsSigningConfiguration(f.root, overrides);
  if (process.platform !== 'win32') {
    await chmod(f.passwords, 0o644);
    await assert.rejects(load({}), /mode 600/);
    await chmod(f.passwords, 0o600);
    await chmod(f.certificate, 0o644);
    await assert.rejects(load({}), /mode 600/);
    await chmod(f.certificate, 0o600);
    const symbolic = join(f.base, 'linked.pfx');
    await symlink(f.certificate, symbolic);
    await assert.rejects(load({ KCODER_WINDOWS_CERTIFICATE_PATH: symbolic }), /symbolic links/);
  }
  const repoSecret = join(f.root, 'release.pfx');
  await writeFile(repoSecret, 'private', { mode: 0o600 });
  await assert.rejects(load({ KCODER_WINDOWS_CERTIFICATE_PATH: repoSecret }), /outside the repository/);
  const hard = join(f.base, 'hard.pfx');
  await link(f.certificate, hard);
  await assert.rejects(load({}), /regular files/);
});

test('Linux preflight rejects missing, old and OpenSSL 1.1 tools before packaging', {
  skip: process.platform === 'win32' && 'POSIX executable fixture',
}, async t => {
  const f = await fixture(t), signing = { enabled: true }, source = { PATH: f.base };
  await assert.rejects(verifyWindowsSigningTool(signing, source, 'linux'), /install it before packaging/);
  const tool = join(f.base, 'osslsigncode');
  for (const [version, openssl, valid] of [['2.8', '3.0.13', true], ['2.7', '3.0.13', false], ['2.8', '1.1.1', false]]) {
    await writeFile(tool, `#!/bin/sh\nprintf 'osslsigncode ${version}, using:\\nOpenSSL ${openssl}\\n'\n`, { mode: 0o700 });
    const check = verifyWindowsSigningTool(signing, source, 'linux');
    if (valid) await check;
    else await assert.rejects(check, /requires osslsigncode >= 2.8 built with OpenSSL >= 3/);
  }
});

test('signer preflight preserves unsigned, other-host and explicit-tool selection', async () => {
  const source = { PATH: '/not-a-tool-directory' };
  await verifyWindowsSigningTool({ enabled: false }, source, 'linux');
  for (const platform of ['win32', 'darwin']) await verifyWindowsSigningTool({ enabled: true }, source, platform);
  for (const key of ['SIGNTOOL_PATH', 'ELECTRON_BUILDER_OSSL_SIGNCODE_PATH']) {
    await verifyWindowsSigningTool({ enabled: true }, { ...source, [key]: '/operator-selected-tool' }, 'linux');
  }
});

for (const fail of [false, true]) {
  test(`signing keeps passwords out of builder configuration and restores the environment after ${fail ? 'failure' : 'success'}`, async t => {
    const f = await fixture(t), signing = await loadWindowsSigningConfiguration(f.root, {});
    t.mock.method(console, 'info', () => {});
    const previous = process.env.WIN_CSC_KEY_PASSWORD;
    const previousSystemTool = process.env.USE_SYSTEM_OSSLSIGNCODE;
    process.env.WIN_CSC_KEY_PASSWORD = 'previous-signing-scope';
    process.env.USE_SYSTEM_OSSLSIGNCODE = 'false';
    try {
      const run = runWithWindowsSigning(signing, async options => {
        assert.equal(process.env.WIN_CSC_KEY_PASSWORD, signing.password);
        assert.equal(process.env.USE_SYSTEM_OSSLSIGNCODE, process.platform === 'linux' ? 'true' : 'false');
        assert.equal(options.forceCodeSigning, true);
        assert.deepEqual(options.toolsets, { winCodeSign: '1.1.0' });
        assert.equal(options.win.signExecutable, true);
        assert.equal(options.win.signtoolOptions.certificateFile, f.certificate);
        assert.deepEqual(options.win.signtoolOptions.signingHashAlgorithms, ['sha256']);
        assert.ok(!JSON.stringify(options).includes(signing.password));
        if (fail) throw new Error('fixture-signing-failed');
        return 'signed-build';
      });
      if (fail) await assert.rejects(run, /fixture-signing-failed/);
      else assert.equal(await run, 'signed-build');
      assert.equal(process.env.WIN_CSC_KEY_PASSWORD, 'previous-signing-scope');
      assert.equal(process.env.USE_SYSTEM_OSSLSIGNCODE, 'false');
    } finally {
      if (previous === undefined) delete process.env.WIN_CSC_KEY_PASSWORD;
      else process.env.WIN_CSC_KEY_PASSWORD = previous;
      if (previousSystemTool === undefined) delete process.env.USE_SYSTEM_OSSLSIGNCODE;
      else process.env.USE_SYSTEM_OSSLSIGNCODE = previousSystemTool;
    }
  });
}

test('electron-builder selects the host and NSIS outputs without selecting sealed resources', async t => {
  const f = await fixture(t), signing = await loadWindowsSigningConfiguration(f.root, {});
  t.mock.method(console, 'info', () => {});
  const require = createRequire(new URL('../../apps/kcoder-studio/package.json', import.meta.url));
  require('electron-builder');
  const builder = createRequire(require.resolve('electron-builder/package.json'));
  const { WinPackager } = builder(resolve(dirname(builder.resolve('app-builder-lib')), 'winPackager.js'));
  const { wincodesignChecksums } = builder(resolve(dirname(builder.resolve('app-builder-lib')), 'toolsets/windows.js'));
  const metadata = JSON.parse(await readFile(new URL('../../apps/kcoder-studio/package.json', import.meta.url), 'utf8'));
  await runWithWindowsSigning(signing, options => {
    assert.ok(wincodesignChecksums[options.toolsets.winCodeSign]?.['win-codesign-linux-amd64.zip']);
    assert.ok(wincodesignChecksums[options.toolsets.winCodeSign]?.['win-codesign-windows-x64.zip']);
    const packager = { platformSpecificBuildOptions: options.win };
    const shouldSign = (file, fallback) => WinPackager.prototype.shouldSignFile.call(packager, file, fallback);
    assert.equal(shouldSign(`${metadata.build.executableName}.exe`, true), true);
    assert.equal(shouldSign(`KCoder-Studio-Setup-${metadata.version}-win-x64.exe`, true), true);
    assert.equal(shouldSign(`KCoder-Studio-Setup-${metadata.version}-win-x64.__uninstaller.exe`, true), true);
    for (const file of ['resources/bin/kcoder.exe', 'resources/bin/kcoder-process-supervisor.exe',
      'resources/bin/chrome/chrome.exe', 'resources/kcoder-channel-host/node.exe', 'elevate.exe']) {
      assert.equal(shouldSign(file, true), false, file);
    }
  });
});
