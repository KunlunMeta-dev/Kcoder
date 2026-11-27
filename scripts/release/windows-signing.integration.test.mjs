import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadWindowsSigningConfiguration, runWithWindowsSigning, verifyWindowsSigningTool } from './windows-signing-config.mjs';

// Explicit opt-in: this signs only a generated probe, never a release or installed file.
const fixture = process.env.KCODER_WINDOWS_SIGNING_FIXTURE_TEST === '1';
const tool = fixture ? 'osslsigncode' : process.env.KCODER_WINDOWS_SIGNING_TEST_TOOL;
test('real PE signing through electron-builder rejects tampering, wrong passwords and untrusted roots', {
  skip: fixture && process.platform !== 'linux' ? 'Linux default signer acceptance'
    : !tool && 'Set KCODER_WINDOWS_SIGNING_FIXTURE_TEST=1 for a generated identity, or KCODER_WINDOWS_SIGNING_TEST_TOOL for configured identity',
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-authenticode-probe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = fixture ? join(directory, 'repository') : fileURLToPath(new URL('../..', import.meta.url));
  let signing;
  if (fixture) {
    await mkdir(root);
    const key = join(directory, 'fixture.key'), cert = join(directory, 'fixture.pem'), pfx = join(directory, 'fixture.pfx');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=KCoder isolated signing fixture', '-keyout', key, '-out', cert,
      '-addext', 'extendedKeyUsage=codeSigning'], { stdio: 'pipe' });
    execFileSync('openssl', ['pkcs12', '-export', '-inkey', key, '-in', cert, '-out', pfx,
      '-passout', 'pass:isolated-fixture-password'], { stdio: 'pipe' });
    await chmod(pfx, 0o600);
    signing = await loadWindowsSigningConfiguration(root, {
      KCODER_WINDOWS_CERTIFICATE_PATH: pfx, KCODER_WINDOWS_CERTIFICATE_PASSWORD: 'isolated-fixture-password',
    });
  } else signing = await loadWindowsSigningConfiguration(root);
  const input = join(directory, 'kcoder-studio.exe');
  execFileSync('x86_64-w64-mingw32-gcc', ['-x', 'c', '-o', input, '-'], {
    input: 'int main(void) { return 0; }\n', stdio: ['pipe', 'pipe', 'pipe'],
  });
  assert.equal(signing.enabled, true, 'This explicitly enabled probe requires configured signing');
  const keys = ['ELECTRON_BUILDER_OFFLINE', 'SIGNTOOL_PATH', 'ELECTRON_BUILDER_OSSL_SIGNCODE_PATH', 'USE_SYSTEM_SIGNCODE'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.ELECTRON_BUILDER_OFFLINE = 'true';
  if (fixture) {
    // Exercise the default Linux selection, without any explicit signer override.
    for (const key of keys.slice(1)) delete process.env[key];
  } else process.env.SIGNTOOL_PATH = tool;
  try {
    await verifyWindowsSigningTool(signing);
    await runWithWindowsSigning(signing, async configuration => {
      const require = createRequire(new URL('../../apps/kcoder-studio/package.json', import.meta.url));
      require('electron-builder');
      const builder = createRequire(require.resolve('electron-builder/package.json'));
      const { WindowsSignToolManager } = builder(resolve(dirname(builder.resolve('app-builder-lib')), 'codeSign/windowsSignToolManager.js'));
      const packager = {
        platformSpecificBuildOptions: configuration.win, config: { toolsets: configuration.toolsets },
        appInfo: { productName: 'KCoder Studio', type: 'module', computePackageUrl: async () => null },
        getCscPassword: () => process.env.WIN_CSC_KEY_PASSWORD,
        info: { getWorkspaceRoot: async () => root },
      };
      const manager = new WindowsSignToolManager(packager);
      assert.equal(await manager.signFile({ path: input, options: configuration.win }), true);
      const certificate = join(directory, 'verification-certificate.pem');
      execFileSync('openssl', ['pkcs12', '-in', signing.certificateFile, '-passin', 'env:WIN_CSC_KEY_PASSWORD',
        '-nokeys', '-clcerts', '-out', certificate], { stdio: ['ignore', 'pipe', 'pipe'] });
      // Trust only this verification command, without importing an OS trust root.
      execFileSync(tool, ['verify', '-in', input, '-CAfile', certificate], { stdio: ['ignore', 'pipe', 'pipe'] });
      assert.notEqual(spawnSync(tool, ['verify', '-in', input], { stdio: 'pipe' }).status, 0,
        'Self-signing must not be mistaken for public publisher trust');
      const signed = await readFile(input);
      await assert.rejects(runWithWindowsSigning({ ...signing, password: 'intentionally-invalid-probe-password' }, async invalid => {
        const invalidManager = new WindowsSignToolManager({ ...packager, platformSpecificBuildOptions: invalid.win });
        return invalidManager.signFile({ path: input, options: invalid.win });
      }), 'Wrong credentials must fail instead of silently falling back to an unsigned result');
      assert.deepEqual(await readFile(input), signed, 'A failed signing attempt must preserve the previous file');
      const bytes = await readFile(input), peOffset = bytes.readUInt32LE(60);
      assert.ok(bytes.readUInt32LE(peOffset + 24 + 112 + 4 * 8 + 4) > 0, 'PE has an Authenticode certificate table');
      const sectionTable = peOffset + 24 + bytes.readUInt16LE(peOffset + 20);
      const textOffset = bytes.readUInt32LE(sectionTable + 20);
      assert.ok(textOffset > 0 && textOffset < bytes.length);
      bytes[textOffset] ^= 1;
      const tampered = join(directory, 'tampered.exe');
      await writeFile(tampered, bytes);
      assert.notEqual(spawnSync(tool, ['verify', '-in', tampered, '-CAfile', certificate], { stdio: 'pipe' }).status, 0,
        'A valid signature must not conceal changed executable contents');
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
