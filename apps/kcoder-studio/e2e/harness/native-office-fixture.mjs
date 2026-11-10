import assert from 'node:assert/strict';
import { chmod, chown, lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { nativeCodeFixture } from './native-code-service.mjs';
import { stageOfficeResources } from '../../../kcoder-office-components/packaging/stage-resources.mjs';
import { nativeOfficeSpawnEnvironment, prepareNativeOfficeLaunch } from '../../src/integrations/office/resource-host.mjs';

/** Reuse the ordinary native owner with the production Office stage and launcher. */
export async function nativeOfficeFixture(context, binary, account, providerEndpoint) {
  const scratch = await context.createOwnedScratchDirectory('native-office-request-owner', {
    baseDirectory: '/tmp', ownedWorkerTraversal: true, requireCleanupConfirmation: true,
  });
  const fixture = await nativeCodeFixture(context, binary, { scratch, account });
  const componentRoot = resolve(fixture.root, 'original-office-component');
  const stage = await stageOfficeResources({ destination: componentRoot });
  const own = async path => {
    const info = await lstat(path);
    assert.equal(info.isSymbolicLink(), false);
    assert.ok(info.isDirectory() || (info.isFile() && info.nlink === 1));
    if (process.getuid() === 0) await chown(path, fixture.uid, fixture.gid);
    await chmod(path, info.isDirectory() ? 0o700 : 0o600);
    if (info.isDirectory()) for (const name of await readdir(path)) await own(resolve(path, name));
  };
  await own(componentRoot);
  const launch = await prepareNativeOfficeLaunch({ componentRoot, expectedManifestSha256: stage.manifestSha256 });
  Object.assign(fixture.env, nativeOfficeSpawnEnvironment(launch));
  const settings = JSON.parse(await readFile(fixture.settings, 'utf8'));
  settings.tools = { profile: 'full' };
  settings.integrations.office = { enabled: false };
  settings.providers['owned-code'].endpoint = providerEndpoint;
  settings.providers['owned-code'].default_model = 'office-request-only-protocol';
  settings.providers['owned-code'].max_output_tokens = 512;
  await writeFile(fixture.settings, JSON.stringify(settings), { mode: 0o600 });
  const serversFile = resolve(fixture.profile, 'office-request-servers.json');
  await writeFile(serversFile, JSON.stringify([{ id: 'local', label: 'Owned ordinary Office', runtime: 'kcoder', transport: 'local', command: fixture.binary, workspace: fixture.workspace }]), { mode: 0o600 });
  if (process.getuid() === 0) await chown(serversFile, fixture.uid, fixture.gid);
  await context.writeArtifactJson('native-office-request-inputs.json', {
    nativeSha256: fixture.imageSha256, actualUid: fixture.uid,
    officeManifestSha256: stage.manifestSha256, nodeSha256: launch.runtime.sha256,
    resourceSource: 'stageOfficeResources + actual private UID ownership + prepareNativeOfficeLaunch',
    settingsInitiallyDisabled: true, connectivityConfigured: false,
  });
  return { ...fixture, serversFile };
}
