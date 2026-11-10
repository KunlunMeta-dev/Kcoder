import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, utimes } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createRequire } from 'node:module';
import { assertPublicPath, inventory, writeManifest, verifyManifest, releaseIdentity, npmManifest, manifestName, cargoPackageVersion } from './artifact-manifest.mjs';
const fixture = async t => { const root=await mkdtemp(resolve(tmpdir(),'kcoder-release-audit-'));t.after(()=>rm(root,{recursive:true,force:true}));return root; };

test('release identity reads preserve the index stat cache', async t => {
  const root = await fixture(t);
  const files = [
    'Cargo.toml', 'crates/kcoder_cli/Cargo.toml',
    'crates/kcoder_app_protocol/src/lib.rs',
    'crates/kcoder_cli/src/app_server/connection_state.rs',
    'crates/kcoder_cli/src/internal/host_transport/metadata/capabilities.rs',
    'crates/kcoder_cli/src/internal/host_transport/metadata/negotiation.rs',
    'apps/kcoder-studio/package.json', 'apps/kcoder-studio/mobile/package.json',
  ];
  for (const file of files) {
    const path = resolve(root, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, await readFile(new URL('../../' + file, import.meta.url)));
  }
  const git = args => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'user.name', 'Fixture']);
  git(['add', '.']);
  git(['commit', '-m', 'initial']);
  const index = resolve(root, '.git/index');
  const original = await readFile(index);
  const changedTime = new Date(Date.now() + 2_000);
  await utimes(resolve(root, 'Cargo.toml'), changedTime, changedTime);
  const identity = await releaseIdentity(root);
  assert.equal(identity.packagingSource.commit, git(['rev-parse', 'HEAD']));
  assert.equal(identity.packagingSource.dirty, false);
  assert.deepEqual(await readFile(index), original);
});

test('CLI version follows its package declaration and explicit workspace inheritance', () => {
  const workspace = '[workspace.package]\nversion = "0.1.0"\n[workspace.dependencies]\nother = { version = "9.0.0" }';
  assert.equal(cargoPackageVersion('[package]\nversion = "0.6.0"\n[dependencies]\nversion = "8.0.0"', workspace), '0.6.0');
  assert.equal(cargoPackageVersion('[package]\nversion.workspace = true', workspace), '0.1.0');
  assert.equal(cargoPackageVersion('[package]\nversion = { workspace = true }', workspace), '0.1.0');
  assert.throws(() => cargoPackageVersion('[package]\nname = "cli"\n[dependencies]\nversion = "8.0.0"', workspace), /Cannot resolve/);
  assert.throws(() => cargoPackageVersion('[package]\nversion.workspace = true', '[package]\nversion = "8.0.0"'), /Cannot resolve/);
});

test('manifest binds actual file bytes, rejects tampering and unexpected files',async t=>{
  const root=await fixture(t);await mkdir(resolve(root,'bin'));await writeFile(resolve(root,'bin/kcoder'),'fixture executable');
  const manifest=await writeManifest(root,{kind:'fixture',platform:'fixture',identity:{versions:{cli:'1',studio:'2',mobile:'3'},packagingSource:{commit:'a'.repeat(40),dirty:false}}});
  assert.deepEqual(manifest.versions,{cli:'1',studio:'2',mobile:'3'});
  assert.equal(manifest.resources[0].bytes,18);assert.equal(manifest.resources[0].sha256.length,64);
  await verifyManifest(root);
  await assert.rejects(verifyManifest(root,{expectedCommit:'b'.repeat(40)}),/different source commit/);
  await writeFile(resolve(root,'bin/kcoder'),'changed');await assert.rejects(verifyManifest(root),/do not match/);
  await writeFile(resolve(root,'settings.json'),'{}');await assert.rejects(verifyManifest(root),/forbidden/);
});
test('forbidden paths cover installed examples, private settings and debug artifacts',()=>{
  for(const path of ['skills/example-skill/SKILL.md','commands/example-command.md','settings.json','.env','nested/.env.local','credentials.json','logs/debug.log','trace.jsonl','a.test.js','src/__tests__/helper.js','src/__fixtures__/data.json','.ssh/id_ed25519'])assert.throws(()=>assertPublicPath(path),/forbidden/);
  assert.doesNotThrow(()=>assertPublicPath('skills/kcoder-settings/SKILL.md'));
  assert.doesNotThrow(()=>assertPublicPath('settings.schema.jsonc'));
});
test('secret scanning crosses stream chunks without echoing the matched value',async t=>{
  const root=await fixture(t);const key='sk-'+'x'.repeat(40);await writeFile(resolve(root,'asset.js'),' '.repeat(65534)+key);
  await assert.rejects(inventory(root),error=>error.message.includes('credential material')&&!error.message.includes(key));
});
test('ASAR inner entries and symbolic links cannot bypass the same gate',async t=>{
  const root=await fixture(t);await writeFile(resolve(root,'app.asar'),'fixture');
  await assert.rejects(inventory(root,{inspectAsar:async()=>['desktop/main.mjs','private/settings.json']}),/forbidden/);
  await symlink(resolve(root,'app.asar'),resolve(root,'alias'));await assert.rejects(inventory(root,{inspectAsar:async()=>[]}),/symbolic link/);
});
test('source identity records the shared product version, CLI version and declared capabilities',async()=>{
  const result=await releaseIdentity();assert.match(result.packagingSource.commit,/^[a-f0-9]{40}$/);
  assert.ok(result.protocol.sourceDeclaredCapabilities.includes('residentThreads'));
  assert.ok(result.protocol.sourceDeclaredCapabilities.includes('modelSelectionModeV1'));
  assert.ok(result.protocol.contract.some(entry=>entry.path==='../kcoder_cli/src/app_server/connection_state.rs'));
  assert.ok(result.protocol.contract.some(entry=>entry.path==='../kcoder_cli/src/internal/host_transport/metadata/capabilities.rs'));
  assert.ok(result.protocol.contract.some(entry=>entry.path==='../kcoder_cli/src/internal/host_transport/metadata/negotiation.rs'));
  assert.ok(result.protocol.sourceDeclaredCapabilities.includes('retryModelConfigurationV1'));
  assert.match(result.protocol.note,/not runtime negotiation/);
  for(const version of Object.values(result.versions))assert.match(version,/^\d+\.\d+\.\d+/);
  assert.equal(result.versions.studio,result.versions.mobile);
});

test('real ASAR headers cannot conceal a private configuration resource',async t=>{
  const root=await fixture(t);const app=resolve(root,'app');const output=resolve(root,'output');await mkdir(app);await mkdir(output);
  await writeFile(resolve(app,'credentials.json'),'{}');
  const require=createRequire(new URL('../../apps/kcoder-studio/package.json',import.meta.url));
  const builder=createRequire(require.resolve('electron-builder'));const library=createRequire(builder.resolve('app-builder-lib'));
  await library('@electron/asar').createPackage(app,resolve(output,'app.asar'));
  await assert.rejects(inventory(output),/credentials.json/);
});
test('npm inventory uses the real file allowlist without executing prepack recursively',async t=>{
  const root=await fixture(t);await mkdir(resolve(root,'dist'));
  await writeFile(resolve(root,'dist/index.html'),'fixture renderer');
  await writeFile(resolve(root,'package.json'),JSON.stringify({name:'release-fixture',version:'0.0.0',private:true,files:['dist',manifestName],scripts:{prepack:'exit 99'}}));
  await npmManifest(root,'mobile-web');
  const manifest=JSON.parse(await readFile(resolve(root,manifestName),'utf8'));
  assert.deepEqual(manifest.resources.map(item=>item.path),['dist/index.html','package.json']);
  await writeFile(resolve(root,'dist/settings.json'),'{}');
  await assert.rejects(npmManifest(root,'mobile-web'),/forbidden/);
});

test('ordinary long task slugs are not API key prefixes',async t=>{
  const root=await fixture(t);await writeFile(resolve(root,'style.css'),'.task-'+ 'x'.repeat(45));
  assert.equal((await inventory(root)).length,1);
});
