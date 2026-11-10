import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import test from 'node:test';
import { verifyPackagedNativeBundles } from './release-artifact-hook.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
  const root=await mkdtemp(resolve(tmpdir(),'kcoder-payload-integrity-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const component=resolve(root,'kcoder-channel-host'),source=resolve(root,'app');await mkdir(source);await mkdir(component);
  const entries={'package.json':'{}','package-lock.json':'{}','src/applications/stdio.mjs':'export {};','licenses/LICENSE.txt':'License','node_modules/.package-lock.json':'{}','node_modules/sdk/index.js':'export const sdk=1;'};
  const files=[];
  for(const [path,text] of Object.entries(entries)){
    await mkdir(dirname(resolve(component,path)),{recursive:true});await writeFile(resolve(component,path),text);files.push({path,bytes:Buffer.byteLength(text),sha256:sha(text)});
  }
  const manifest=JSON.stringify({schemaVersion:1,name:'@kunlunmeta/kcoder-channel-host',version:'0.1.0',nodeMinimumMajor:22,entry:'src/applications/stdio.mjs',lockSha256:sha('{}'),files,totalBytes:files.reduce((n,f)=>n+f.bytes,0)});
  await writeFile(resolve(component,'channel-resource-manifest.json'),manifest);
  await writeFile(resolve(source,'package.json'),JSON.stringify({nativeConnectivityResources:{schemaVersion:1,resourceDirectory:'kcoder-channel-host',manifestSha256:sha(manifest),nodeMinimumMajor:22}}));
  const host=createRequire(new URL('../package.json',import.meta.url)),builder=createRequire(host.resolve('electron-builder')),lib=createRequire(builder.resolve('app-builder-lib'));
  await lib('@electron/asar').createPackage(source,resolve(root,'app.asar'));
  return {root,component};
}
test('actual copied payload is checked against actual ASAR component pin before installer creation',async t=>{
  const f=await fixture(t);await verifyPackagedNativeBundles(f.root);
});
test('a staging manifest cannot conceal SDK node_modules omitted from the final payload',async t=>{
  const f=await fixture(t);await rm(resolve(f.component,'node_modules'),{recursive:true});
  await assert.rejects(verifyPackagedNativeBundles(f.root),error=>error.code==='CHANNEL_RESOURCE_IDENTITY_CHANGED');
});
