// Build-time Office contribution: no downloads, npm scripts or runtime activation.
import { mkdir, mkdtemp, writeFile, rename, rm, lstat, open, unlink } from 'node:fs/promises';
import { resolve, dirname, join, basename, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOfficePackageManifest } from '../src/package-manifest.mjs';
import { generatorIdentity } from '../src/identity.mjs';
import { officeResourceManifestName, readResource, resourceError, resourceInventory, sha256, verifyOfficeResourceBundle } from '../../kcoder-studio/src/integrations/office/resource-verifier.mjs';
const sourceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repoRoot = resolve(sourceRoot, '../..');
const excluded = new Set(['test','tests','__tests__','__fixtures__','.github','.git','.bin','coverage','example','examples','benchmark','benchmarks','docs']);
const allowed = path => !path.split('/').some(part => excluded.has(part) || /^\.env(?:\.|$)/i.test(part)) && !/\.test\.[cm]?[jt]sx?$|\.(log|jsonl|node|dll|exe)$/i.test(path);
export async function stageOfficeResources(options = {}) {
  const {destination}=options;
  if (typeof destination !== 'string' || !isAbsolute(destination)) throw resourceError('OFFICE_RESOURCE_INVALID');
  const output=resolve(destination);
  if (output===sourceRoot || !relative(sourceRoot,output).startsWith('..')) throw resourceError('OFFICE_RESOURCE_INVALID');
  await mkdir(dirname(output),{recursive:true});
  const lockPath=join(dirname(output),'.'+basename(output)+'.office-stage.lock');
  let lock;
  try { lock=await open(lockPath,'wx',0o600); } catch(error) { if(error.code==='EEXIST') throw resourceError('OFFICE_RESOURCE_STAGE_BUSY'); throw error; }
  const identity=await lock.stat({bigint:true});
  try { return await stageLocked(options); }
  finally {
    const current=await lstat(lockPath,{bigint:true}).catch(()=>null);
    if(current?.dev===identity.dev && current?.ino===identity.ino && !current.isSymbolicLink()) await unlink(lockPath);
    await lock.close();
  }
}
async function stageLocked({ destination, replace = false, signal } = {}) {
  if (typeof destination !== 'string' || !isAbsolute(destination)) throw resourceError('OFFICE_RESOURCE_INVALID');
  const output = resolve(destination);
  if (output === sourceRoot || output.startsWith(sourceRoot + '/')) throw resourceError('OFFICE_RESOURCE_INVALID');
  await mkdir(dirname(output), { recursive: true });
  let previous;
  try {
    const info = await lstat(output); if (!info.isDirectory() || info.isSymbolicLink() || !replace) throw resourceError('OFFICE_RESOURCE_STAGE_EXISTS');
    const oldBytes = await readResource(join(output, officeResourceManifestName)); await verifyOfficeResourceBundle(output, sha256(oldBytes), { signal }); previous = output;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const work = await mkdtemp(join(dirname(output), '.office-resource-stage-')); const fresh = join(work, 'office'); let backup; let keepRecovery=false;
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
    if (previous) { backup = join(work, 'previous'); await rename(previous, backup); }
    try { await rename(fresh, output); } catch (error) { if (backup) { try {await rename(backup, previous);} catch { keepRecovery=true; throw resourceError('OFFICE_RESOURCE_STAGE_RECOVERY_REQUIRED');} } throw error; }
    if (backup) await rm(backup, { recursive: true });
    return { root: output, manifestSha256, manifestPath: join(output, officeResourceManifestName), componentRoot: join(output, 'components'), fileCount: manifest.files.length, totalBytes: manifest.totalBytes, nodeMinimumMajor: 22, runtimeIncluded: false };
  } finally { if(!keepRecovery) await rm(work, { recursive: true, force: true }); }
}
