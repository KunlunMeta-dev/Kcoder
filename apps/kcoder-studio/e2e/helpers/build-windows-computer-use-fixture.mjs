// Build an unpacked development app for authorized Windows UI testing. This does
// not mark the desktop component release-ready or publish an installer.
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { build, Platform, Arch } from 'electron-builder';
import { assertWindowsX64Executable, windowsPackConfig } from '../../desktop/build-windows.mjs';
import { stageGatewayDependencies } from '../../desktop/stage-gateway-dependencies.mjs';
import releaseArtifactHook from '../../desktop/release-artifact-hook.mjs';
import { stageComputerUseRuntime } from '../../../../scripts/release/stage-computer-use.mjs';
import { assertRendererBuildFresh } from '../harness/renderer-build.mjs';
import { appRoot, repoRoot } from '../harness/run-context.mjs';

await assertRendererBuildFresh();
const output = resolve(process.argv[2] || '');
const installer = process.argv[3] === '--installer';
const executableName = installer ? 'kcoder-studio-cu-verification' : 'kcoder-studio';
if (process.argv[3] && !installer) throw new Error('Unknown fixture build mode');
if (!process.argv[2]) throw new Error('An explicit new fixture output directory is required');
await mkdir(output, { recursive: false });
const source = resolve(repoRoot, `target/x86_64-pc-windows-gnu/${installer ? 'release' : 'debug'}/kcoder.exe`);
await assertWindowsX64Executable(source);
async function sha256(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
const cliSha256 = await sha256(source);
const frozenCli = resolve(output, 'input/kcoder.exe');
await mkdir(resolve(output, 'input'));
await copyFile(source, frozenCli);
if (await sha256(frozenCli) !== cliSha256) throw new Error('CLI changed while freezing build input');
const packageJson = (await import('../../package.json', { with: { type: 'json' } })).default;
// Keep the ordinary release inputs unchanged. Override only their two explicit
// resource sources in the in-memory Electron Builder configuration.
// This UI fixture reuses already-staged browser/PDF dependencies. Building those
// unrelated components again is not part of the Computer Use UI assertion.
const config = { ...packageJson.build, ...windowsPackConfig(async () => {
  await stageGatewayDependencies();
  await assertWindowsX64Executable(resolve(repoRoot, 'target/packages/kcoder-studio/windows-input/bin/pdf/pdftotext.exe'));
}, undefined, {}) };
config.directories = { output };
// Explicit data-only base: package.json arrays must not merge duplicate CLI
// sources into concurrent copies of the same output executable.
const baseConfig = resolve(output, 'fixture-base.json');
await writeFile(baseConfig, JSON.stringify({ extends: null }));
config.extends = baseConfig;
if (installer) {
  if (!process.env.KCODER_E2E_COMPUTER_USE_RUNTIME || !process.env.KCODER_E2E_COMPUTER_USE_SHA256)
    throw new Error('Installer fixture requires an explicit component and inventory pin');
  // Separate Windows registration from the user's installed Studio. The same
  // NSIS/resource hooks are used, but this artifact must never be published.
  config.appId = 'dev.kcoder.studio.computer-use-verification.isolated';
  config.extraMetadata = { ...packageJson.build.extraMetadata, name: executableName };
  config.productName = 'KCoder Studio Computer Use Verification';
  config.executableName = executableName;
  config.nsis = { ...packageJson.build.nsis, runAfterFinish: false,
    createDesktopShortcut: false, createStartMenuShortcut: false };
  config.afterPack = async context => {
    await stageComputerUseRuntime({ source: resolve(process.env.KCODER_E2E_COMPUTER_USE_RUNTIME),
      destination: resolve(context.appOutDir, 'resources/computer-use'),
      expectedHash: process.env.KCODER_E2E_COMPUTER_USE_SHA256, allowPrototype: true });
    await releaseArtifactHook(context);
  };
}
config.win = {
  ...packageJson.build.win,
  ...(installer ? { artifactName: 'KCoder-Computer-Use-Verification-${version}-${arch}.${ext}' } : {}),
  extraResources: packageJson.build.win.extraResources.map(entry => entry.to === 'bin/kcoder.exe'
    ? { ...entry, from: frozenCli }
    : entry),
};
const afterPack = config.afterPack;
config.afterPack = async context => {
  if (installer && (context.packager.appInfo.id !== config.appId || context.packager.appInfo.name !== executableName
      || context.packager.appInfo.productFilename !== executableName)) throw new Error('Verification application identity is not isolated');
  if (await sha256(resolve(context.appOutDir, 'resources/bin/kcoder.exe')) !== cliSha256)
    throw new Error('Packaged CLI differs from frozen input');
  await afterPack(context);
};
await build({ projectDir: appRoot, targets: Platform.WINDOWS.createTarget([installer ? 'nsis' : 'dir'], Arch.x64),
  publish: 'never', config });
await assertWindowsX64Executable(resolve(output, `win-unpacked/${executableName}.exe`));
let installerSha256 = null;
if (installer) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(resolve(output, `KCoder-Computer-Use-Verification-${packageJson.version}-x64.exe`))) hash.update(bytes);
  installerSha256 = hash.digest('hex');
}
await writeFile(resolve(output, 'fixture-build.json'), JSON.stringify({
  developmentOnly: true, runtimeStagedSeparately: !installer,
  executableName, installerSha256, cliSha256, appId: config.appId, packageName: config.extraMetadata?.name,
  cli: source, executable: resolve(output, `win-unpacked/${executableName}.exe`),
}, null, 2));
console.log(JSON.stringify({ output }));
