// Fixture-only installation copy. Native Receiver independently verifies this evidence.
import assert from 'node:assert/strict';
import { cp, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { prepareNativeOfficeLaunch } from '../../../apps/kcoder-studio/src/integrations/office/resource-host.mjs';
const [observationPath, destination] = process.argv.slice(2);
if (process.argv.length !== 4 || !observationPath || !destination) {
  throw new Error('Usage: node native_office_preflight.mjs OBSERVATION_JSON ABSOLUTE_DESTINATION');
}
if (!isAbsolute(destination)) throw new Error('Office preflight requires an absolute destination');
const observation = JSON.parse(await readFile(observationPath, 'utf8'));
if (!observation || typeof observation !== 'object' || Array.isArray(observation)
  || typeof observation.componentRoot !== 'string' || !isAbsolute(observation.componentRoot)
  || typeof observation.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(observation.manifestSha256)
  || !observation.runtime || typeof observation.runtime !== 'object' || Array.isArray(observation.runtime)) {
  throw new Error('OFFICE_PREFLIGHT_INVALID_OBSERVATION');
}
const source = await prepareNativeOfficeLaunch({ componentRoot: observation.componentRoot,
  expectedManifestSha256: observation.manifestSha256, expectedMode: 'standalone_node' });
assert.deepEqual(source.runtime, observation.runtime);
await cp(source.componentRoot, destination, { recursive: true, errorOnExist: true, force: false });
const owned = await prepareNativeOfficeLaunch({ componentRoot: destination,
  expectedManifestSha256: observation.manifestSha256, expectedMode: 'standalone_node' });
assert.deepEqual(owned.runtime, source.runtime);
console.log(JSON.stringify({ ...owned, sourceManifestSha256: source.manifestSha256,
  preflightSourceSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex') }));
