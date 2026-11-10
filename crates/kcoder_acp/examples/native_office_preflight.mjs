// Fixture-only installation copy. Native Receiver independently verifies this evidence.
import assert from 'node:assert/strict';
import { cp, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { prepareNativeOfficeLaunch } from '../../../apps/kcoder-studio/src/integrations/office/resource-host.mjs';
const [observationPath, destination] = process.argv.slice(2);
assert.ok(observationPath && destination);
const observation = JSON.parse(await readFile(observationPath, 'utf8'));
const source = await prepareNativeOfficeLaunch({ componentRoot: observation.componentRoot,
  expectedManifestSha256: observation.manifestSha256, expectedMode: 'standalone_node' });
assert.deepEqual(source.runtime, observation.runtime);
await cp(source.componentRoot, destination, { recursive: true, errorOnExist: true, force: false });
const owned = await prepareNativeOfficeLaunch({ componentRoot: destination,
  expectedManifestSha256: observation.manifestSha256, expectedMode: 'standalone_node' });
assert.deepEqual(owned.runtime, source.runtime);
console.log(JSON.stringify({ ...owned, sourceManifestSha256: source.manifestSha256,
  preflightSourceSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex') }));
