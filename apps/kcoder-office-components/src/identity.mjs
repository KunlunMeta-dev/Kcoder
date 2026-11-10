import { createHash } from 'node:crypto';
import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { OfficeError } from './errors.mjs';

const SOURCES = Object.freeze(['src/identity.mjs','src/generator.mjs','src/spec.mjs','src/worker.mjs',
  'src/index.mjs','src/archive.mjs','src/png.mjs','src/errors.mjs','package.json']);

async function componentBytes(relative) {
  const url = new URL('../' + relative, import.meta.url);
  const before = await lstat(url);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 2 * 1024 * 1024) throw new Error('component changed');
  const handle = await open(url, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.nlink !== 1 || actual.dev !== before.dev || actual.ino !== before.ino || actual.size !== before.size) throw new Error('component changed');
    const bytes = await handle.readFile();
    if (bytes.byteLength !== actual.size) throw new Error('component changed');
    return bytes;
  } finally { await handle.close(); }
}

export async function generatorIdentity() {
  try {
    const hash = createHash('sha256');
    let manifest;
    for (const source of SOURCES) {
      const bytes = await componentBytes(source);
      hash.update(source + '\0' + bytes.byteLength + '\0'); hash.update(bytes);
      if (source === 'package.json') manifest = JSON.parse(bytes.toString('utf8'));
    }
    if (manifest?.name !== '@kcoder/office-components' || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(manifest.version)) throw new Error('component changed');
    return { component: manifest.name, version: manifest.version, schemaRevision: 'office-generation/v1',
      implementationSha256: hash.digest('hex'), dependencyLockSha256: createHash('sha256').update(await componentBytes('package-lock.json')).digest('hex') };
  } catch { throw new OfficeError('OFFICE_COMPONENT_IDENTITY_UNAVAILABLE', 'office.componentUnavailable'); }
}
