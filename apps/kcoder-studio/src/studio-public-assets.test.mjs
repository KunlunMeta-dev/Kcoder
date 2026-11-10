import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink, utimes, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createStudioPublicAssets, stageStudioPublicAssets, verifyStudioPublicAssets, readStudioPackageMetadata } from './studio-public-assets.js';

async function fixture(t) {
  const root=await mkdtemp(resolve(tmpdir(),'kcoder-public-code-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const resources=resolve(root,'resources'),webRoot=resolve(resources,'renderer-dist'),app=resolve(root,'app');
  await mkdir(resolve(webRoot,'assets'),{recursive:true});await mkdir(app);
  await writeFile(resolve(webRoot,'assets/entry-1234ABCD.js'),'export const value=1;');
  await writeFile(resolve(webRoot,'assets/theme-5678EFGH.css'),'body{color:CanvasText}');
  await writeFile(resolve(webRoot,'index.html'),'<meta name="kcoder-rpc-token" content="private">');
  await writeFile(resolve(webRoot,'runtime-config.js'),'private runtime configuration');
  await writeFile(resolve(webRoot,'assets/not-fingerprinted.js'),'not public');
  const pin=await stageStudioPublicAssets({webRoot});
  await writeFile(resolve(app,'package.json'),JSON.stringify({name:'fixture',nativeStudioPublicAssets:pin}));
  const host=createRequire(new URL('../package.json',import.meta.url)),builder=createRequire(host.resolve('electron-builder')),lib=createRequire(builder.resolve('app-builder-lib'));
  const repack=async value=>{await writeFile(resolve(app,'package.json'),JSON.stringify({name:'fixture',nativeStudioPublicAssets:value}));await lib('@electron/asar').createPackage(app,resolve(resources,'app.asar'));};
  await repack(pin);
  const route=createStudioPublicAssets({webRoot,resourcesRoot:resources});
  const call=async(path,{method='GET',headers={}}={})=>{
    const result={handled:false,status:null,headers:null,body:null};
    result.handled=await route({method,headers},{writeHead(status,value){result.status=status;result.headers=value;},end(body){result.body=body;}},path);
    return result;
  };
  return {root,resources,webRoot,pin,route,call,repack};
}

test('actual ASAR pin makes only exact compiled fingerprinted JS/CSS public without a session read',async t=>{
  const f=await fixture(t);assert.equal(await verifyStudioPublicAssets(f.webRoot,f.pin),2);
  assert.deepEqual((await readStudioPackageMetadata(resolve(f.resources,'app.asar'))).nativeStudioPublicAssets,f.pin);
  const js=await f.call('/assets/entry-1234ABCD.js');assert.equal(js.handled,true);assert.equal(js.status,200);assert.equal(js.body.toString(),'export const value=1;');
  assert.equal((await f.call('/assets/theme-5678EFGH.css')).status,200);
  const head=await f.call('/assets/entry-1234ABCD.js',{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.body,undefined);
  const cached=await f.call('/assets/entry-1234ABCD.js',{headers:{'if-none-match':js.headers.etag}});assert.equal(cached.status,304);
  for(const path of ['/','/index.html','/runtime-config.js','/api/servers','/attachments/x.js','/assets/not-fingerprinted.js','/assets/missing-1234ABCD.js','/assets/%2e%2e/index-1234ABCD.js','/widget-sandbox/x-1234ABCD.js'])assert.equal((await f.call(path)).handled,false,path);
  assert.equal((await f.call('/assets/entry-1234ABCD.js',{method:'POST'})).handled,false);
});

test('a captured release serves only retained verified bytes; a fresh route rejects tampered disk bytes',async t=>{
  const f=await fixture(t),path=resolve(f.webRoot,'assets/entry-1234ABCD.js');const first=await f.call('/assets/entry-1234ABCD.js');
  const old=await stat(path);await writeFile(path,'export const value=2;');await utimes(path,old.atime,old.mtime);
  const result=await f.call('/assets/entry-1234ABCD.js',{headers:{'if-none-match':first.headers.etag}});assert.equal(result.handled,true);assert.equal(result.status,304);
  assert.equal((await f.call('/assets/entry-1234ABCD.js')).body.toString(),first.body.toString());
  const cold=createStudioPublicAssets({webRoot:f.webRoot,resourcesRoot:f.resources});
  let status;await cold({method:'GET',headers:{}},{writeHead(value){status=value;},end(){}},'/assets/entry-1234ABCD.js');assert.equal(status,503);
});

test('a forged manifest cannot add private HTML and package pins cannot be supplied by a different web root',async t=>{
  const f=await fixture(t),manifest=resolve(f.webRoot,'studio-public-assets.json');const data=JSON.parse(await readFile(manifest,'utf8'));data.files[0].path='index.html';const bytes=Buffer.from(JSON.stringify(data));await writeFile(manifest,bytes);
  await f.repack({...f.pin,manifestSha256:createHash('sha256').update(bytes).digest('hex')});
  assert.equal((await f.call('/assets/entry-1234ABCD.js')).status,503);
  const alternate=createStudioPublicAssets({webRoot:f.root,resourcesRoot:f.resources});assert.equal(await alternate({method:'GET',headers:{}},{},'/assets/entry-1234ABCD.js'),false);
});

test('cached release bytes survive path replacement without loading a symlink target',async t=>{
  if(process.platform==='win32'){t.skip('requires the separately owned native symlink permission gate');return;}
  const f=await fixture(t),path=resolve(f.webRoot,'assets/entry-1234ABCD.js');await f.call('/assets/entry-1234ABCD.js');await rm(path);await writeFile(resolve(f.root,'outside.js'),'export const value=1;');await symlink(resolve(f.root,'outside.js'),path);
  assert.equal((await f.call('/assets/entry-1234ABCD.js')).body.toString(),'export const value=1;');
  const cold=createStudioPublicAssets({webRoot:f.webRoot,resourcesRoot:f.resources});
  let status;await cold({method:'HEAD',headers:{}},{writeHead(value){status=value;},end(){}},'/assets/entry-1234ABCD.js');assert.equal(status,503);
});


test('package metadata reads bounded ASAR ranges without touching unrelated archive payloads', async t => {
  const f = await fixture(t);
  await writeFile(resolve(f.root, 'app/unrelated.bin'), Buffer.alloc(4 * 1024 * 1024, 7));
  await f.repack(f.pin);
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { readStudioPackageMetadata } from ${JSON.stringify(new URL('./studio-public-assets.js', import.meta.url).href)};
    let readBytes = 0;
    const read = fs.readSync;
    fs.readFileSync = () => { throw new Error('Whole-archive reads are forbidden'); };
    fs.readSync = (...args) => { const count = read(...args); readBytes += count; return count; };
    syncBuiltinESMExports();
    const value = await readStudioPackageMetadata(process.argv[1]);
    process.stdout.write(JSON.stringify({value, readBytes}));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script,
    resolve(f.resources, 'app.asar')], { encoding: 'utf8', timeout: 10_000 }));
  assert.deepEqual(result.value.nativeStudioPublicAssets, f.pin);
  assert.ok(result.readBytes < 128 * 1024, 'unrelated archive bytes must not be read');
});
