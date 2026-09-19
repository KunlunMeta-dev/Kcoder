import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareChrome } from '../../../scripts/release/prepare-chrome.mjs';
import { stageGatewayDependencies } from './stage-gateway-dependencies.mjs';

const repository = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

export async function stageDesktopResources(context, {
  stageDependencies = stageGatewayDependencies, prepareBrowser = prepareChrome, env = process.env,
} = {}) {
  await stageDependencies();
  // Remote-only packages execute the browser on their Gateway, not on the client.
  if (context?.packager?.appInfo?.id === 'dev.kcoder.studio.remote') return;
  const platform = context?.electronPlatformName ?? process.platform;
  if (!['linux', 'win32'].includes(platform)) return;
  // Electron Builder's Arch.x64 is 1. Cross-host Windows builds still stage win64.
  if (context?.arch !== undefined && context.arch !== 1) throw new Error('Bundled Chrome requires an x64 desktop target');
  const target = platform === 'win32' ? 'win64' : 'linux64';
  return prepareBrowser({
    platform: target,
    destination: resolve(repository, `target/packages/kcoder-studio/${platform === 'win32' ? 'windows' : 'linux'}-input/bin/chrome`),
    ...(env.KCODER_CHROME_CACHE ? { cache: env.KCODER_CHROME_CACHE } : {}),
    ...(env[`KCODER_CHROME_ARCHIVE_${target.toUpperCase()}`] ? { archive: env[`KCODER_CHROME_ARCHIVE_${target.toUpperCase()}`] } : {}),
  });
}

export default stageDesktopResources;
