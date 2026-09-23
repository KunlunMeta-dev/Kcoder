import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createRequire } from 'node:module';
import { assertPublicPath, inventory, writeManifest, verifyManifest, releaseIdentity, npmManifest, manifestName } from './artifact-manifest.mjs';
const fixture = async t => { const root=await mkdtemp(resolve(tmpdir(),'kcoder-release-audit-'));t.after(()=>rm(root,{recursive:true,force:true}));return root; };

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
test('source identity records independent versions and declared capabilities rather than claiming negotiation',async()=>{
  const result=await releaseIdentity();assert.match(result.packagingSource.commit,/^[a-f0-9]{40}$/);
  assert.ok(result.protocol.sourceDeclaredCapabilities.includes('residentThreads'));
  assert.ok(result.protocol.sourceDeclaredCapabilities.includes('retryModelConfigurationV1'));
  assert.match(result.protocol.note,/not runtime negotiation/);
  for(const version of Object.values(result.versions))assert.match(version,/^\d+\.\d+\.\d+/);
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
