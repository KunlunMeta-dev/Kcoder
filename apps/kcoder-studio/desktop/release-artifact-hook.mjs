import { resolve } from 'node:path';
import { lstat } from 'node:fs/promises';
import { materializeShellIcon } from './desktop-icons.mjs';
import { macApplicationPath, writeMacReleaseManifest } from './mac-artifact-layout.mjs';
import { inventory, writeManifest } from '../../../scripts/release/artifact-manifest.mjs';
import { verifyDesktopEntryClosure, verifyGatewayEntryClosure } from '../../../scripts/release/desktop-entry-closure.mjs';
import { readStudioPackageMetadata, verifyStudioPublicAssets } from '../src/studio-public-assets.js';
import { verifyNativeConnectivityBundle } from '../src/integrations/connectivity/resource-host.mjs';

export async function stageInstallerHelpers(context) {
  if (context.electronPlatformName !== 'win32') return;
  for (const target of context.targets ?? []) {
    if (!['nsis', 'nsis-web', 'portable'].includes(target.name)) continue;
    // electron-builder copies/signs elevate.exe immediately before NSIS archiving.
    // Use that target's cached helper now, so the final payload is inventoried
    // and the later archive step cannot append an unrecorded executable.
    const helper = target.packageHelper?.elevateHelper;
    if (typeof helper?.copy !== 'function') throw new Error('Unsupported NSIS helper staging contract');
    await helper.copy(context.appOutDir, target);
  }
}

export async function stageWindowsShellIcon(context) {
  if (context.electronPlatformName !== 'win32') return;
  const resources = resolve(context.appOutDir, 'resources');
  const shell = resolve(resources, 'shell');
  const source = resolve(shell, 'icon.ico');
  try {
    for (const path of [resources, shell]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe Windows shell resource directory');
    }
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe Windows shell icon');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  // Shortcut repair uses this versioned name to invalidate Windows' icon cache.
  // Stage it before inventory so installation adds no unrecorded resource.
  materializeShellIcon(shell, source);
}

export async function verifyPackagedNativeBundles(resources) {
  const metadata = await readStudioPackageMetadata(resolve(resources, 'app.asar'));
  if (metadata.nativeStudioPublicAssets) await verifyStudioPublicAssets(resolve(resources, 'renderer-dist'), metadata.nativeStudioPublicAssets);
  if (metadata.nativeConnectivityResources) await verifyNativeConnectivityBundle(resolve(resources, 'kcoder-channel-host'), metadata.nativeConnectivityResources.manifestSha256);
}

export default async function releaseArtifactHook(context, options = {}) {
  const mac = context.electronPlatformName === 'darwin';
  if (!mac && !['linux', 'win32'].includes(context.electronPlatformName)) throw new Error('Release manifest hook requires an audited platform layout');
  await stageInstallerHelpers(context);
  await stageWindowsShellIcon(context);
  const resources = mac ? resolve(macApplicationPath(context), 'Contents/Resources') : resolve(context.appOutDir, 'resources');
  verifyDesktopEntryClosure(resolve(resources, 'app.asar'));
  if (context.packager.appInfo.id !== 'dev.kcoder.studio.remote') verifyGatewayEntryClosure(resources);
  await verifyPackagedNativeBundles(resources);
  if (mac) return writeMacReleaseManifest(context, options);
  // Audit the complete app, including ASAR entries. The resource inventory excludes
  // the host executable because Electron Builder may edit/sign it after this hook.
  await inventory(context.appOutDir);
  const manifest = await writeManifest(resources, {
    ...(options.identity ? { identity: options.identity } : {}),
    kind: context.packager.appInfo.id === 'dev.kcoder.studio.remote' ? 'studio-remote' : 'studio-desktop',
    platform: context.electronPlatformName,
    hostRuntime: { kind: "electron", version: context.packager.info.framework.version, inventoryBoundary: "resources; signed host executable is covered by final artifact checksum" },
  });
  return manifest;
}
