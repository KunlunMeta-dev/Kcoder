import { resolve } from 'node:path';
import { inventory, writeManifest } from '../../../scripts/release/artifact-manifest.mjs';

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

export default async function releaseArtifactHook(context) {
  if (!['linux', 'win32'].includes(context.electronPlatformName)) throw new Error('Release manifest hook requires an audited platform layout');
  await stageInstallerHelpers(context);
  // Audit the complete app, including ASAR entries. The resource inventory excludes
  // the host executable because Electron Builder may edit/sign it after this hook.
  await inventory(context.appOutDir);
  const manifest = await writeManifest(resolve(context.appOutDir, 'resources'), {
    kind: context.packager.appInfo.id === 'dev.kcoder.studio.remote' ? 'studio-remote' : 'studio-desktop',
    platform: context.electronPlatformName,
    hostRuntime: { kind: "electron", version: context.packager.info.framework.version, inventoryBoundary: "resources; signed host executable is covered by final artifact checksum" },
  });
  return manifest;
}
