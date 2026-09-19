import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const studioRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

// The Gateway lives outside app.asar. Stage only portable production packages;
// native optional SSH accelerators must never cross operating-system builds.
export async function stageGatewayDependencies({ sourceRoot = studioRoot, destination } = {}) {
  const output = resolve(destination ?? resolve(sourceRoot, '../../target/packages/kcoder-studio/gateway-dependencies/node_modules'));
  if (basename(output) !== 'node_modules' || dirname(output) === dirname(sourceRoot)) {
    throw new Error('Gateway dependencies require a dedicated node_modules staging directory');
  }
  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(join(dirname(output), '.ssh-dependencies-'));
  const fresh = join(staging, 'node_modules');
  await mkdir(fresh);
  const visited = new Map();
  async function copyDependency(name, fromRoot) {
    const require = createRequire(join(fromRoot, 'package.json'));
    const packageFile = await realpath(require.resolve(`${name}/package.json`));
    const source = dirname(packageFile);
    const metadata = JSON.parse(await readFile(packageFile, 'utf8'));
    if (visited.has(name)) {
      if (visited.get(name) !== metadata.version) throw new Error(`Gateway dependency version conflict: ${name}`);
      return;
    }
    visited.set(name, metadata.version);
    await cp(source, join(fresh, name), {
      recursive: true,
      filter: path => {
        const relative = path.slice(source.length).split(sep).filter(Boolean);
        return !relative.some(part => ['node_modules', 'build', 'test', 'tests', '.git'].includes(part)) && !path.endsWith('.node');
      },
    });
    for (const dependency of Object.keys(metadata.dependencies ?? {})) await copyDependency(dependency, source);
  }
  let previous = false;
  let restoreFailed = false;
  try {
    for (const dependency of ['ssh2', 'jsonc-parser']) await copyDependency(dependency, sourceRoot);
    try { await rename(output, join(staging, 'previous')); previous = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(fresh, output); }
    catch (error) {
      if (previous) {
        try { await rename(join(staging, 'previous'), output); }
        catch { restoreFailed = true; throw new Error(`Gateway dependency staging failed; previous files preserved in ${staging}`); }
      }
      throw error;
    }
    return { output, packages: Object.fromEntries(visited) };
  } finally {
    // This unique temporary directory contains only packaging artifacts. Never
    // remove its backup if restoring the previous stage failed.
    if (!restoreFailed) await rm(staging, { recursive: true, force: true });
  }
}

export default async function beforePack() { await stageGatewayDependencies(); }
