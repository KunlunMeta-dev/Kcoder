import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareMacPdf } from '../../../scripts/release/prepare-mac-pdf.mjs';
import { preparePdf } from '../../../scripts/release/prepare-pdf.mjs';
import { prepareChrome } from '../../../scripts/release/prepare-chrome.mjs';
import { stageGatewayDependencies } from './stage-gateway-dependencies.mjs';

const repository = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

async function buildMobileWeb() {
  const mobile = resolve(repository, 'apps/kcoder-studio/mobile');
  for (const script of ['build-terminal-webview.mjs', 'export-gateway-web.mjs']) {
    await new Promise((accept, reject) => {
      const child = spawn(process.execPath, [resolve(mobile, 'scripts', script)], { cwd: mobile, stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? accept() : reject(new Error(`Mobile Web staging failed (${signal ?? code})`)));
    });
  }
}

export async function stageDesktopResources(context, {
  stageDependencies = stageGatewayDependencies, prepareBrowser = prepareChrome, preparePdfReader = preparePdf, prepareMacPdfReader = prepareMacPdf, prepareMobileWeb = buildMobileWeb, env = process.env,
} = {}) {
  await stageDependencies();
  // Remote-only packages execute the browser on their Gateway, not on the client.
  if (context?.packager?.appInfo?.id === 'dev.kcoder.studio.remote') return;
  const platform = context?.electronPlatformName ?? process.platform;
  if (platform === 'darwin') {
    if (context?.arch !== undefined && context.arch !== 1) throw new Error('Bundled macOS resources require an Intel x64 desktop target');
    await prepareMobileWeb();
    const browser = await prepareBrowser({
      platform: 'mac-x64',
      destination: resolve(repository, 'target/packages/kcoder-studio/macos-input/bin/chrome'),
      ...(env.KCODER_CHROME_CACHE ? { cache: env.KCODER_CHROME_CACHE } : {}),
      ...(env.KCODER_CHROME_ARCHIVE_MAC_X64 ? { archive: env.KCODER_CHROME_ARCHIVE_MAC_X64 } : {}),
    });
    await prepareMacPdfReader({
      destination: resolve(repository, 'target/packages/kcoder-studio/macos-input/bin/pdf'),
      ...(env.KCODER_PDF_CACHE ? { cache: env.KCODER_PDF_CACHE } : {}),
      ...(env.KCODER_PDF_ARCHIVE_DIR ? { archiveDirectory: env.KCODER_PDF_ARCHIVE_DIR } : {}),
    });
    return browser;
  }
  if (!['linux', 'win32'].includes(platform)) return;
  // Electron Builder's Arch.x64 is 1. Cross-host Windows builds still stage win64.
  if (context?.arch !== undefined && context.arch !== 1) throw new Error('Bundled Chrome requires an x64 desktop target');
  await prepareMobileWeb();
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
