import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink, utimes, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createServer, get } from 'node:http';
import { once } from 'node:events';
import { gunzipSync } from 'node:zlib';
import { createStudioPublicAssets, stageStudioPublicAssets, verifyStudioPublicAssets, readStudioPackageMetadata } from './studio-public-assets.js';

async function fixture(t, { source = 'export const value=1;' } = {}) {
  const root=await mkdtemp(resolve(tmpdir(),'kcoder-public-code-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const resources=resolve(root,'resources'),webRoot=resolve(resources,'renderer-dist'),app=resolve(root,'app');
  await mkdir(resolve(webRoot,'assets'),{recursive:true});await mkdir(app);
  await writeFile(resolve(webRoot,'assets/entry-1234ABCD.js'), source);
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

test('ASAR-pinned code compresses verified bytes with variant-safe cache validation', async t => {
  const source = `export const text=${JSON.stringify('owned packaged resource '.repeat(4000))};`;
  const f = await fixture(t, { source });
  const server = createServer((request, response) => {
    void f.route(request, response, new URL(request.url, 'http://localhost').pathname)
      .then(handled => { if (!handled) { response.writeHead(404); response.end(); } });
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const read = (headers, method = 'GET') => new Promise((resolve, reject) => {
    get(`http://127.0.0.1:${server.address().port}/assets/entry-1234ABCD.js`, { headers, method }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  const plain = await read({ 'accept-encoding': 'identity' });
  const gzip = await read({ 'accept-encoding': 'gzip' });
  assert.equal(gzip.headers['content-encoding'], 'gzip');
  assert.match(gzip.headers.vary, /Accept-Encoding/);
  assert.match(plain.headers.vary, /Accept-Encoding/);
  assert.deepEqual(gunzipSync(gzip.body), plain.body);
  assert.equal(plain.body.toString(), source);
  assert.ok(gzip.body.length < plain.body.length / 10);
  assert.match(gzip.headers.etag, /^W\//);
  assert.equal(gzip.headers.etag, plain.headers.etag);
  assert.match(gzip.headers['cache-control'], /immutable/);
  for (const validator of [gzip.headers.etag, `"older", ${gzip.headers.etag.slice(2)}`, '*']) {
    const cached = await read({ 'accept-encoding': 'gzip', 'if-none-match': validator });
    assert.equal(cached.status, 304); assert.equal(cached.body.length, 0);
    assert.equal(cached.headers['content-length'], undefined);
    assert.equal(cached.headers['content-encoding'], undefined);
  }
  const head = await read({ 'accept-encoding': 'gzip' }, 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.body.length, 0);
});

test('a captured release serves only retained verified bytes; a fresh route rejects tampered disk bytes',async t=>{
  const f=await fixture(t),path=resolve(f.webRoot,'assets/entry-1234ABCD.js');const first=await f.call('/assets/entry-1234ABCD.js');
  const old=await stat(path);await writeFile(path,'export const value=2;');await utimes(path,old.atime,old.mtime);
  const result=await f.call('/assets/entry-1234ABCD.js',{headers:{'if-none-match':first.headers.etag}});assert.equal(result.handled,true);assert.equal(result.status,304);
  assert.equal((await f.call('/assets/entry-1234ABCD.js')).body.toString(),first.body.toString());
  const cold=createStudioPublicAssets({webRoot:f.webRoot,resourcesRoot:f.resources});
  for (const validator of [undefined, '*', `"older", ${first.headers.etag}`]) {
    let status;await cold({method:'GET',headers:{'if-none-match':validator}},
      {writeHead(value){status=value;},end(){}},'/assets/entry-1234ABCD.js');assert.equal(status,503);
  }
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

test('compiled conditional GET and HEAD accept equivalent asset validators before sending bytes', async t => {
  const f = await fixture(t), first = await f.call('/assets/entry-1234ABCD.js');
  const etag = first.headers.etag, strong = etag.replace(/^W\//, '');
  for (const method of ['GET', 'HEAD']) for (const validator of [etag, strong,
    `"older", ${etag}`, ` W/"older" , ${strong} `, '*']) {
    const result = await f.call('/assets/entry-1234ABCD.js', { method, headers: { 'if-none-match': validator } });
    assert.equal(result.status, 304, `${method}: ${validator}`);
    assert.equal(result.body, undefined);
    assert.equal(result.headers.etag, etag);
    assert.equal(result.headers['content-length'], undefined);
    assert.match(result.headers['cache-control'], /immutable/);
  }
  for (const validator of ['"older"', `W/"prefix-${strong.slice(1)}`, undefined]) {
    const result = await f.call('/assets/entry-1234ABCD.js', { headers: { 'if-none-match': validator } });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, first.body);
  }
});

test('warm compiled GET, HEAD and 304 use held verified bytes with no filesystem operations', async t => {
  const f = await fixture(t, { source: `export const text=${JSON.stringify('warm verified code '.repeat(2000))};` });
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { createServer, get } from 'node:http';
    import { once } from 'node:events';
    import { gunzipSync } from 'node:zlib';
    import { createStudioPublicAssets } from ${JSON.stringify(new URL('./studio-public-assets.js', import.meta.url).href)};
    import { readResource } from ${JSON.stringify(new URL('./integrations/office/resource-verifier.mjs', import.meta.url).href)};
    const route = createStudioPublicAssets({webRoot:process.argv[1],resourcesRoot:process.argv[2]});
    const call = async (handler,path,method='GET',headers={}) => {
      const result={};result.handled=await handler({method,headers},{writeHead(status,headers){result.status=status;result.headers=headers;},end(body){result.body=body;}},path);return result;
    };
    const js='/assets/entry-1234ABCD.js',css='/assets/theme-5678EFGH.css';
    const first=await call(route,js);await call(route,css);
    let attempts=0;
    const forbidden=()=>{attempts++;throw new Error('WARM_FS_FORBIDDEN');};
    for(const name of ['openSync','lstatSync','readFileSync','realpathSync','statSync','readSync'])fs[name]=forbidden;
    for(const name of ['open','lstat','readFile','realpath','stat'])fs.promises[name]=forbidden;
    syncBuiltinESMExports();
    await assert.rejects(()=>readResource(process.argv[1]+js),/WARM_FS_FORBIDDEN/);
    assert.ok(attempts>0,'the real resource reader must reach the filesystem tripwire');attempts=0;
    for(let index=0;index<10;index++){
      assert.equal((await call(route,js)).body.toString(),first.body.toString());
      assert.equal((await call(route,css,'HEAD')).status,200);
      for(const tag of [first.headers.etag,'"old", '+first.headers.etag,first.headers.etag.slice(2),'*'])
        assert.equal((await call(route,js,'GET',{'if-none-match':tag})).status,304);
    }
    const server=createServer((request,response)=>void route(request,response,new URL(request.url,'http://localhost').pathname));
    server.listen(0,'127.0.0.1');await once(server,'listening');
    try {
      const compressed=await new Promise((resolve,reject)=>get('http://127.0.0.1:'+server.address().port+js,
        {headers:{'accept-encoding':'gzip'}},response=>{
          const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);
          response.on('end',()=>resolve({headers:response.headers,body:Buffer.concat(chunks)}));
        }).on('error',reject));
      assert.equal(compressed.headers['content-encoding'],'gzip');
      assert.deepEqual(gunzipSync(compressed.body),first.body);
    } finally {server.closeAllConnections();server.close();}
    const warmOperations=attempts;
    const cold=await call(createStudioPublicAssets({webRoot:process.argv[1],resourcesRoot:process.argv[2]}),js);
    assert.ok(attempts>warmOperations,'a cold route must still attempt the actual guard');
    process.stdout.write(JSON.stringify({warmOperations,coldStatus:cold.status}));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, f.webRoot, f.resources],
    { encoding: 'utf8', timeout: 10000 }));
  assert.deepEqual(result, { warmOperations: 0, coldStatus: 503 });
});
