import assert from 'node:assert/strict';
import { chown, chmod, lstat, readdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './run-context.mjs';
import { stageNativeConnectivityResources } from '../../../kcoder-channel-host/scripts/stage-native-resources.mjs';
import { prepareNativeConnectivityLaunch } from '../../src/integrations/connectivity/resource-host.mjs';

// Stage the original application host, without channel SDK or transport substitutions.
export async function stageApplicationComponent(context, fixture, {
  sourceRoot = repoRoot, componentName = 'declared-application-component',
  artifactName = 'application-component',
} = {}) {
  assert.match(componentName, /^[a-z][a-z0-9-]{1,80}$/);
  assert.match(artifactName, /^[a-z][a-z0-9-]{1,80}$/);
  sourceRoot = resolve(sourceRoot);
  const component = resolve(fixture.root, componentName);
  const stage = sourceRoot === repoRoot ? stageNativeConnectivityResources
    : (await import(pathToFileURL(resolve(sourceRoot, 'apps/kcoder-channel-host/scripts/stage-native-resources.mjs')).href)).stageNativeConnectivityResources;
  const launch = await stage({ output: component, nodeProgram: process.execPath });
  await ownNativeFixtureTree(fixture, component);
  const approved = await prepareNativeConnectivityLaunch({ componentRoot: component, expectedManifestSha256: launch.manifestSha256 });
  fixture.nodeImageSha256 = approved.nodeSha256;
  fixture.env.KCODER_NATIVE_CONNECTIVITY_BINDING_V1 = Buffer.from(JSON.stringify(approved)).toString('base64url');
  await context.writeArtifactJson(artifactName + '.json', { originalApplicationHost: true, manifestSha256: launch.manifestSha256 });
  return approved;
}

export async function ownNativeFixtureTree(fixture,path) {
    assert.ok(resolve(path).startsWith(resolve(fixture.root) + sep), 'Native fixture staging must stay inside its owned root');
    const info = await lstat(path); assert.equal(info.isSymbolicLink(), false);
    await chmod(path, info.isDirectory() ? 0o700 : 0o600);
    if (process.getuid() === 0) await chown(path, fixture.uid, fixture.gid);
    if (info.isDirectory()) for (const name of await readdir(path)) await ownNativeFixtureTree(fixture,resolve(path,name));
  }
