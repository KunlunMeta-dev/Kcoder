import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runE2E, repoRoot } from '../../../harness/run-context.mjs';
import { exportMobileWeb } from '../../../harness/mobile-web-export.mjs';

const base = resolve(repoRoot, 'target/private-phone-ux-implementation/gateway-hosted-mobile-web-20261009');
const freeze = resolve(base, 'deploy-source-freeze-02');
const source = resolve(freeze, 'source');
const portable = resolve(base, 'deployment-web-export-02');
const deps = resolve(repoRoot, 'target/private-phone-ux-implementation/mobile-dependency-input-pinned');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const expectedManifest = '5fe3a4990676f58be4a9df6c7040ca5ae898de0f81ad0795f72d255d3efc3973';
assert.deepEqual(process.argv.slice(2), ['--execute']);
assert.equal(process.version, 'v22.17.0');
assert.equal(sha(await readFile(process.execPath)), '8071ae0fca095a272ad698a90c7061801a86fb6392ddb81e922b68a91a4374b9');
assert.equal(sha(await readFile(resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/mobile-web-export.mjs'))), 'a40e87a8a117e09027dbc000622057204d9441a7506ba7f54524364131f63a2e');
assert.equal(sha(await readFile(resolve(deps, '.package-lock.json'))), '67c2d1c16857f0ed0f6d2ecb3dcf753f26a268b0f1675c1553018e37e9d231a3');
const manifestBytes = await readFile(resolve(freeze, 'manifest.json'));
assert.equal(sha(manifestBytes), expectedManifest);
const manifest = JSON.parse(manifestBytes);
async function verifySources() {
  for (const row of manifest.files) {
    const path = resolve(source, row.path);
    const info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink());
    const bytes = await readFile(path);
    assert.equal(bytes.length, row.size);
    assert.equal(sha(bytes), row.sha256, row.path);
  }
}
await verifySources();
await assert.rejects(lstat(portable), { code: 'ENOENT' });
await runE2E(import.meta.url, {
  id: 'gateway-hosted-mobile-web-deployment-export-02',
  modelPolicy: 'Real Expo deployment export only; no Gateway/Browser/SSH/provider. Same artifact has a replaceable official Expo baseUrl.',
}, async context => {
  // Reuse the exact existing copy/hash/terminal/dependency/cleanup lifecycle.
  // Only the precise exporter child runs the real product wrapper instead of
  // Expo directly. Both retain the same owned output path and process group.
  const spawnOwned = context.spawnOwned.bind(context);
  const launches = [];
  context.spawnOwned = (label, command, args, options) => {
    if (label === 'gateway-hosted-deployment-expo') {
      assert.equal(command, process.execPath);
      assert.equal(args[0].endsWith('/node_modules/expo/bin/cli'), true);
      const outputIndex = args.indexOf('--output-dir');
      assert.ok(outputIndex > 0 && args[outputIndex + 1].startsWith(context.stateDir + '/'));
      const mobile = options.cwd;
      args = [resolve(mobile, 'scripts/export-gateway-web.mjs'), '--output-dir', args[outputIndex + 1]];
    }
    launches.push({ label, command, args, cwd: options?.cwd });
    const child = spawnOwned(label, command, args, options);
    console.log(JSON.stringify({ phase: label, pid: child.pid, runRoot: context.runRoot }));
    return child;
  };
  let exported;
  try {
    exported = await exportMobileWeb(context, {
      mobileRoot: resolve(source, 'apps/kcoder-studio/mobile'),
      sourceRoots: [
        { name: 'mobile', path: resolve(source, 'apps/kcoder-studio/mobile'), destination: 'apps/kcoder-studio/mobile' },
        { name: 'studio-shared', path: resolve(source, 'apps/kcoder-studio/shared'), destination: 'apps/kcoder-studio/shared' },
      ],
      dependencyRoot: deps, label: 'gateway-hosted-deployment', outputName: 'deployment-web', timeoutMs: 180000,
    });
  } finally {
    context.spawnOwned = spawnOwned;
    await context.writeArtifactJson('actual-launches.json', launches);
  }
  const exportManifest = JSON.parse(await readFile(exported.bundleManifestPath));
  assert.equal(exportManifest.status, 'complete');
  assert.equal(exportManifest.dependencyProvenance.sourceTreeSha256Before, 'd91f89f1237d2139ef31ee75565230105014536dc5c9a8c34bf436d0bcc7340c');
  assert.equal(exportManifest.dependencyProvenance.sourceUnchanged, true);
  const wrapper = JSON.parse(await readFile(resolve(exported.path, 'kcoder-mobile-web.json')));
  assert.equal(wrapper.version, 1);
  assert.equal(wrapper.baseToken, '/__kcoder_mobile_mount_v1__');
  assert.ok(wrapper.files.some(row => row.replacements > 0));
  await mkdir(portable, { recursive: false, mode: 0o700 });
  const copied = [];
  for (const row of exported.bundleFiles) {
    const input = resolve(exported.path, row.path);
    const output = resolve(portable, row.path);
    assert.ok(input.startsWith(exported.path + '/') && output.startsWith(portable + '/'));
    const bytes = await readFile(input);
    assert.equal(sha(bytes), row.sha256);
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await copyFile(input, output);
    await chmod(output, 0o444);
    assert.equal(sha(await readFile(output)), row.sha256);
    copied.push(row);
  }
  assert.equal(sha(JSON.stringify(copied)), exported.bundleSha256);
  const routesBytes = await readFile(resolve(portable, '_expo/.routes.json'));
  const routes = JSON.parse(routesBytes);
  assert.ok(Object.keys(routes).every(key => ['headers', 'redirects'].includes(key)));
  assert.ok(Object.values(routes).every(value => Array.isArray(value)));
  await context.writeArtifactJson('expo-route-metadata.json', { sha256: sha(routesBytes), value: routes });
  // Complete owned typecheck source closure; no dependency installs or live writes.
  const ownedStudio = context.pathInState('mobile-build-source', 'apps', 'kcoder-studio');
  const closurePins = [];
  async function copySourceClosure(from, to, prefix = '') {
    await mkdir(to, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink());
      if (entry.isDirectory()) { await copySourceClosure(resolve(from, entry.name), resolve(to, entry.name), prefix + entry.name + '/'); continue; }
      assert.ok(entry.isFile());
      const bytes = await readFile(resolve(from, entry.name));
      await copyFile(resolve(from, entry.name), resolve(to, entry.name));
      closurePins.push({ path: 'apps/kcoder-studio/src/' + prefix + entry.name, sha256: sha(bytes), size: bytes.length });
    }
  }
  await copySourceClosure(resolve(repoRoot, 'apps/kcoder-studio/src'), resolve(ownedStudio, 'src'));
  await context.writeArtifactJson('typecheck-source-closure.json', closurePins);
  const typecheckArgv = [resolve(ownedStudio, 'mobile/node_modules/typescript/bin/tsc'), '--noEmit'];
  const typecheck = context.spawnOwned('mobile-typecheck', process.execPath, typecheckArgv, {
    cwd: resolve(ownedStudio, 'mobile'), env: context.isolatedEnvironment({ CI: '1' }),
  });
  console.log(JSON.stringify({ phase: 'mobile-typecheck', pid: typecheck.pid, runRoot: context.runRoot }));
  const typecheckExit = await new Promise((accept, reject) => {
    const deadline = setTimeout(() => reject(new Error('Owned typecheck deadline exceeded')), 120000);
    typecheck.once('error', error => { clearTimeout(deadline); reject(error); });
    typecheck.once('close', (code, signal) => { clearTimeout(deadline); accept({ code, signal }); });
  });
  await context.writeArtifactJson('typecheck-result.json', { argv: [process.execPath, ...typecheckArgv], ...typecheckExit });
  await verifySources();
  const result = { status: 'PASS_REAL_EXPO_EXPORT_NOT_BROWSER', inputManifestSha256: expectedManifest, inputFiles: manifest.fileCount,
    output: portable, bundleSha256: exported.bundleSha256, fileCount: copied.length,
    wrapperManifestSha256: sha(await readFile(resolve(portable, 'kcoder-mobile-web.json'))),
    dependencySourceUnchanged: true, sourceUnchanged: true, typecheck: typecheckExit,
    exportManifestPath: exported.bundleManifestPath, launches };
  await context.writeArtifactJson('deployment-export-result.json', result);
  assert.equal(typecheckExit.code, 0, 'Owned Mobile typecheck failed; real Expo export artifact retained independently');
  return result;
});
