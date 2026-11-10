import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const studio = 'apps/kcoder-studio';
const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const versionFiles = [
  ['package.json', [['version']]],
  ['renderer/package.json', [['version']]],
  ['desktop/gateway-package.json', [['version']]],
  ['mobile/package.json', [['version']]],
  ['mobile/package-lock.json', [['version'], ['packages', '', 'version']]],
  ['mobile/app.json', [['expo', 'version']]],
];

async function versionSources(root) {
  const sources = await Promise.all(versionFiles.map(async ([file, fields]) => {
    const path = resolve(root, studio, file);
    const source = await readFile(path, 'utf8');
    const document = JSON.parse(source);
    const entries = fields.map(keys => {
      const parent = keys.slice(0, -1).reduce((value, key) => value?.[key], document);
      const key = keys.at(-1);
      if (typeof parent?.[key] !== 'string') throw new Error(`Missing client version in ${studio}/${file} (${keys.join('.')})`);
      return { parent, key, label: `${studio}/${file} (${keys.join('.')})` };
    });
    return { path, source, document, entries };
  }));
  const version = sources[0].document.version;
  if (!semver.test(version)) throw new Error(`Invalid Studio product version in ${studio}/package.json`);
  return { version, sources };
}

export async function checkClientVersion(root = repository) {
  const { version, sources } = await versionSources(root);
  const mismatch = sources.flatMap(({ entries }) => entries)
    .filter(({ parent, key }) => parent[key] !== version);
  if (mismatch.length) {
    throw new Error(`Studio product version is ${version}. Run node scripts/release/client-version.mjs --sync to update: ${mismatch.map(entry => entry.label).join(', ')}`);
  }
  return version;
}

export async function syncClientVersion(root = repository) {
  const { version, sources } = await versionSources(root);
  const canonical = sources[0];
  for (const { path, source, document, entries } of sources.slice(1)) {
    if (entries.every(({ parent, key }) => parent[key] === version)) continue;
    for (const { parent, key } of entries) parent[key] = version;
    const pending = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(pending, `${JSON.stringify(document, null, 2)}\n`, {
        flag: 'wx', mode: (await stat(path)).mode & 0o777,
      });
      if (await readFile(canonical.path, 'utf8') !== canonical.source || await readFile(path, 'utf8') !== source) {
        throw new Error('Client version files changed during synchronization. Check the diff and run --sync again.');
      }
      await rename(pending, path);
    } finally {
      await rm(pending, { force: true });
    }
  }
  return checkClientVersion(root);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode = '--check', ...rest] = process.argv.slice(2);
    if (rest.length || !['--check', '--sync'].includes(mode)) throw new Error('Usage: node scripts/release/client-version.mjs [--check|--sync]');
    console.log(await (mode === '--sync' ? syncClientVersion() : checkClientVersion()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
