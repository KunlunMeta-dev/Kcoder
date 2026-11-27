import { stageConnectivityResources } from '../../kcoder-channel-host/packaging/stage-resources.mjs';
import { stageStudioPublicAssets } from '../src/studio-public-assets.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareMacPdf } from '../../../scripts/release/prepare-mac-pdf.mjs';
import { preparePdf } from '../../../scripts/release/prepare-pdf.mjs';
import { prepareChrome } from '../../../scripts/release/prepare-chrome.mjs';
import { prepareLarkCli as prepareLarkCliRelease } from '../../../scripts/release/prepare-lark-cli.mjs';
import { normalizeElectronArch, stageGatewayDependencies } from './stage-gateway-dependencies.mjs';
import { stageSkillRuntimeDependencies } from './stage-skill-runtime-dependencies.mjs';
import { prepareSearxng } from '../../../scripts/release/prepare-searxng.mjs';
import { macTarget } from '../../../scripts/release/mac-target.mjs';
import { prepareMacComputerUse } from '../../../scripts/release/prepare-mac-computer-use.mjs';
import { desktopRelayBuildDefaults } from './relay-build-defaults.mjs';
import { stageStorageNativeAddon } from './storage-native-resources.mjs';

const repository = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

export async function stageDesktopResources(context, {
  stageDependencies = stageGatewayDependencies, stageNativeStorage = stageStorageNativeAddon, stageSkillRuntime = stageSkillRuntimeDependencies, prepareBrowser = prepareChrome, prepareSearch = prepareSearxng, preparePdfReader = preparePdf, prepareMacPdfReader = prepareMacPdf, prepareMacDesktop = prepareMacComputerUse, prepareConnectivity = stageConnectivityResources, prepareStudioAssets = stageStudioPublicAssets, prepareLarkCli = prepareLarkCliRelease, env = process.env,
} = {}) {
  await stageDependencies({ targetPlatform: context?.electronPlatformName ?? process.platform,
    targetArch: normalizeElectronArch(context?.arch, 'unknown') });
  // Remote-only packages execute the browser on their Gateway, not on the client.
  if (context?.packager?.appInfo?.id === 'dev.kcoder.studio.remote') return;
  // Pure-JavaScript skill packages for the local app-server (resources/skill-runtime).
  const skillRuntime = await stageSkillRuntime();
  if (skillRuntime?.packages) console.log(`Skill runtime staged: ${Object.entries(skillRuntime.packages).map(([name, version]) => `${name}@${version}`).join(', ')}`);
  if (context?.packager?.config) {
    const pin = await prepareStudioAssets({ webRoot: resolve(repository, 'apps/kcoder-studio/renderer/dist') });
    context.packager.config.extraMetadata = { ...context.packager.config.extraMetadata, nativeStudioPublicAssets: pin,
      ...desktopRelayBuildDefaults(env, resolve(repository, '.env')) };
  }
  const platform = context?.electronPlatformName ?? process.platform;
  if (!['darwin', 'linux', 'win32'].includes(platform)) return;
  if (platform !== 'darwin' && context?.arch !== undefined && context.arch !== 1) throw new Error('Bundled Chrome requires an x64 desktop target');
  await stageNativeStorage(context, { env });
  const connectivity = await prepareConnectivity({ destination: resolve(repository, `target/packages/kcoder-studio/${platform === 'darwin' ? macTarget(normalizeElectronArch(context?.arch)).stage : platform === 'win32' ? 'windows-input' : 'linux-input'}/channel`), replace: true });
  if (context?.packager?.config) {
    if (!connectivity || !/^[a-f0-9]{64}$/.test(connectivity.manifestSha256) || connectivity.nodeMinimumMajor !== 22) throw new Error('CHANNEL_RESOURCE_STAGE_RECEIPT_INVALID');
    // electron-builder creates the package.json transformer after beforePack.
    // Pin the actual stage receipt inside the app.asar metadata, not in the bundle itself.
    context.packager.config.extraMetadata = { ...context.packager.config.extraMetadata,
      nativeConnectivityResources: { schemaVersion: 1, resourceDirectory: 'kcoder-channel-host', manifestSha256: connectivity.manifestSha256, nodeMinimumMajor: 22 } };
  }
  // Official lark-cli for Feishu skills on local targets (resources/lark-cli).
  const larkCliOptions = {
    ...(env.KCODER_LARK_CLI_CACHE ? { cache: env.KCODER_LARK_CLI_CACHE } : {}),
    ...(env.KCODER_LARK_CLI_ARCHIVE_DIR ? { archiveDirectory: env.KCODER_LARK_CLI_ARCHIVE_DIR } : {}),
  };
  if (platform === 'darwin') {
    const target = macTarget(normalizeElectronArch(context?.arch));
    const inputRoot = resolve(repository, 'target/packages/kcoder-studio', target.stage);
    await prepareMacDesktop({ arch: target.arch, destination: resolve(inputRoot, 'computer-use') });
    const archive = env[`KCODER_CHROME_ARCHIVE_${target.platform.toUpperCase().replaceAll('-', '_')}`];
    await prepareSearch({ platform: target.platform, destination: resolve(inputRoot, 'searxng'), env });
    await prepareLarkCli({ platform: target.platform, destination: resolve(inputRoot, 'lark-cli'), ...larkCliOptions });
    const browser = await prepareBrowser({
      platform: target.platform,
      destination: resolve(inputRoot, 'bin/chrome'),
      ...(env.KCODER_CHROME_CACHE ? { cache: env.KCODER_CHROME_CACHE } : {}),
      ...(archive ? { archive } : {}),
    });
    await prepareMacPdfReader({
      arch: target.arch,
      destination: resolve(inputRoot, 'bin/pdf'),
      ...(env.KCODER_PDF_CACHE ? { cache: env.KCODER_PDF_CACHE } : {}),
      ...(env.KCODER_PDF_ARCHIVE_DIR ? { archiveDirectory: env.KCODER_PDF_ARCHIVE_DIR } : {}),
    });
    return browser;
  }
  await prepareSearch({ platform: platform === 'win32' ? 'win-x64' : 'linux-x64', destination: resolve(repository, `target/packages/kcoder-studio/${platform === 'win32' ? 'windows' : 'linux'}-input/searxng`), env });
  await prepareLarkCli({ platform: platform === 'win32' ? 'win-x64' : 'linux-x64', destination: resolve(repository, `target/packages/kcoder-studio/${platform === 'win32' ? 'windows' : 'linux'}-input/lark-cli`), ...larkCliOptions });
  const target = platform === 'win32' ? 'win64' : 'linux64';
  const browser = await prepareBrowser({
    platform: target,
    destination: resolve(repository, `target/packages/kcoder-studio/${platform === 'win32' ? 'windows' : 'linux'}-input/bin/chrome`),
    ...(env.KCODER_CHROME_CACHE ? { cache: env.KCODER_CHROME_CACHE } : {}),
    ...(env[`KCODER_CHROME_ARCHIVE_${target.toUpperCase()}`] ? { archive: env[`KCODER_CHROME_ARCHIVE_${target.toUpperCase()}`] } : {}),
  });
  if (platform === 'win32') {
    await preparePdfReader({
      destination: resolve(repository, 'target/packages/kcoder-studio/windows-input/bin/pdf'),
      ...(env.KCODER_PDF_CACHE ? { cache: env.KCODER_PDF_CACHE } : {}),
      ...(env.KCODER_PDF_ARCHIVE_DIR ? { archiveDirectory: env.KCODER_PDF_ARCHIVE_DIR } : {}),
    });
  }
  return browser;
}

export default stageDesktopResources;
