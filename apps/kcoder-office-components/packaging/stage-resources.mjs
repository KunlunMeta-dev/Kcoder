// Build-time Office contribution: no downloads, npm scripts or runtime activation.
import { mkdir, mkdtemp, writeFile, rename, rm, lstat } from 'node:fs/promises';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import * as hostPath from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOfficePackageManifest } from '../src/package-manifest.mjs';
import { generatorIdentity } from '../src/identity.mjs';
import { acquireOfficeStageLock } from './stage-lock.mjs';
import { officeResourceManifestName, readResource, resourceError, resourceInventory, sha256, verifyOfficeResourceBundle } from '../../kcoder-studio/src/integrations/office/resource-verifier.mjs';
const sourceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repoRoot = resolve(sourceRoot, '../..');
const excluded = new Set(['test','tests','__tests__','__fixtures__','.github','.git','.bin','coverage','example','examples','benchmark','benchmarks','docs']);
const allowed = path => !path.split('/').some(part => excluded.has(part) || /^\.env(?:\.|$)/i.test(part)) && !/\.test\.[cm]?[jt]sx?$|\.(log|jsonl|node|dll|exe)$/i.test(path);
export function containsPath(root, candidate, paths = hostPath) {
  const child = paths.relative(root, candidate);
  return child === '' || (!paths.isAbsolute(child) && child.split(paths.sep)[0] !== '..');
}
export async function stageOfficeResources(options = {}) {
  const {destination}=options;
  if (typeof destination !== 'string' || !isAbsolute(destination)) throw resourceError('OFFICE_RESOURCE_INVALID');
  const output=resolve(destination);
  if (containsPath(sourceRoot, output)) throw resourceError('OFFICE_RESOURCE_INVALID');
  const lock=await acquireOfficeStageLock(output,{signal:options.signal});
  try{return await stageLocked({...options,stageGuard:lock.assertCurrent,cleanupGuard:lock.assertCleanupOwnership});}
  finally{await lock.release();}
}
async function stageLocked({ destination, replace = false, signal,stageGuard,cleanupGuard } = {}) {
  if (typeof destination !== 'string' || !isAbsolute(destination)) throw resourceError('OFFICE_RESOURCE_INVALID');
  const output = resolve(destination);
  if (containsPath(sourceRoot, output)) throw resourceError('OFFICE_RESOURCE_INVALID');
  await stageGuard();
  let previous;
  const info = await lstat(output).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (info) {
    if (!info.isDirectory() || info.isSymbolicLink() || !replace) throw resourceError('OFFICE_RESOURCE_STAGE_EXISTS');
    const oldBytes = await readResource(join(output, officeResourceManifestName)); await verifyOfficeResourceBundle(output, sha256(oldBytes), { signal }); previous = output;
  }
  await stageGuard();
  const work = await mkdtemp(join(dirname(output), '.office-resource-stage-')); const fresh = join(work, 'office'); let backup; let keepRecovery=false; let receipt;
  try {
    await mkdir(fresh);
    const packageManifest = await createOfficePackageManifest();
    for (const dependency of packageManifest.dependencies) {
      const installed = JSON.parse(await readResource(join(sourceRoot, dependency.path, 'package.json')));
      if (installed.version !== dependency.version) throw resourceError('OFFICE_DEPENDENCY_UNAVAILABLE');
    }
    for (const file of packageManifest.files.filter(file => allowed(file.path) || file.legal && !file.path.split('/').some(part=>['.git','__tests__','__fixtures__'].includes(part)))) {
      if (signal?.aborted) throw resourceError('OFFICE_CANCELLED');
      const bytes = await readResource(join(sourceRoot, file.path), 256 * 1024 * 1024);
      if (sha256(bytes) !== file.sha256 || bytes.length !== file.bytes) throw resourceError('OFFICE_RESOURCE_CHANGED');
      const target = join(fresh, 'components', file.path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { mode: 0o644, flag: 'wx' });
    }
    await mkdir(join(fresh, 'licenses'));
    await mkdir(join(fresh, 'licenses', 'kcoder-office')); await writeFile(join(fresh, 'licenses', 'kcoder-office', 'LICENSE.txt'), await readResource(join(repoRoot, 'LICENSE')), { flag: 'wx', mode: 0o644 });
    for(const [source,name] of [['saxes-LICENSE.txt','saxes'],['electron-fuses-LICENSE.txt','electron-fuses']]) {
      await mkdir(join(fresh,'licenses',name)); await writeFile(join(fresh,'licenses',name,'LICENSE.txt'),await readResource(join(sourceRoot,'packaging/legal',source)),{flag:'wx',mode:0o644});
    }
    await writeFile(join(fresh,'licenses','PROVENANCE.md'),await readResource(join(sourceRoot,'packaging/legal/PROVENANCE.md')),{flag:'wx',mode:0o644});
    const inventory = await resourceInventory(fresh, { signal });
    const manifest = { schemaVersion: 1, componentName: packageManifest.name, componentVersion: packageManifest.version, nodeMinimumMajor: 22,
      packageRoot: 'components', entry: 'components/src/cli.mjs', lockSha256: packageManifest.lockSha256, generator: await generatorIdentity(),
      dependencies: packageManifest.dependencies, files: inventory.files, totalBytes: inventory.totalBytes };
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n'); await writeFile(join(fresh, officeResourceManifestName), bytes, { flag: 'wx', mode: 0o644 });
    const manifestSha256 = sha256(bytes); await verifyOfficeResourceBundle(fresh, manifestSha256, { signal });
    await stageGuard();
    if (previous) { backup = join(work, 'previous'); await rename(previous, backup); }
    try { await rename(fresh, output); } catch (error) { if (backup) { try {await rename(backup, previous);} catch { keepRecovery=true; throw resourceError('OFFICE_RESOURCE_STAGE_RECOVERY_REQUIRED');} } throw error; }
    receipt = { root: output, manifestSha256, manifestPath: join(output, officeResourceManifestName), componentRoot: join(output, 'components'), fileCount: manifest.files.length, totalBytes: manifest.totalBytes, nodeMinimumMajor: 22, runtimeIncluded: false };
    return receipt;
  } finally {
    if (!keepRecovery) {
      // A replaced authority/parent cannot authorize cleanup through the old pathname.
      try{await cleanupGuard();}catch{throw resourceError('OFFICE_RESOURCE_STAGE_RECOVERY_REQUIRED');}
      try { await rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
      catch (error) {
        if (!receipt) throw error;
        // Publication already succeeded. Preserve the owned recovery directory
        // and report cleanup uncertainty without claiming staging failed.
        receipt.cleanup = { status: 'unconfirmed', recoveryRoot: work };
      }
    }
  }
}
