import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveStoragePaths } from '../storage-paths.mjs';
import { classifyLegacyStorageEntries, observeLegacyRoot, previewLegacyLocations, readLegacyRootEntries } from './legacy-locations.mjs';
import { processTreeIdentity, signalProcessTree } from '../../e2e/harness/owned-process.mjs';

function selection(home,{platformConfig=join(home,'.config'),overrides={},record=null,development=false}={}){
  const context={version:1,home,platformConfig,overrides,record,consumer:'desktop',development};
  return {context,paths:resolveStoragePaths({...context,env:overrides})};
}
async function put(path,bytes='controlled fixture'){
  await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,bytes,{mode:0o600});
}
async function fixture(t,options){
  const home=await mkdtemp(join(tmpdir(),'kcoder-legacy-locations-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const selected=selection(home,options),native=selected.paths.dataRoot,source=selected.paths.desktopRoot;
  await put(join(native,'settings.json'),'original Native model configuration');
  await mkdir(source,{recursive:true,mode:0o700});
  return {home,selected,native,source};
}

test('shared userData is listed once and split by its actual owners while Native stays in place',async t=>{
  const f=await fixture(t),backup='settings.json.v2-'+'a'.repeat(64)+'.bak';
  for(const [path,bytes] of [['servers.json','original Gateway catalog'],['settings.json','original Gateway settings'],
    [backup,'original Gateway version backup'],['gateway-port','43123'],['Local State','original Chromium state'],
    ['.product-account-cookie-scope.json','original Cookie scope owner record'],
    ['Partitions/kcoder-studio-desktop/IndexedDB/unknown-outbox','original accepted delivery'],
    ['mobile-device-auth/.key','original Gateway installation key'],['channels/channels.sqlite3','original channel database'],
    ['skill-runtime/bin/node','original generated Gateway launcher'],
    ['Crashpad/client_id','original crash owner'],['Dictionaries/en-US.bdic','original dictionary']])await put(join(f.source,path),bytes);
  await put(join(f.source,'kcoder-storage-writers.lock'),'');
  const listed=[];
  const result=await previewLegacyLocations({selected:f.selected},{readRootEntries:async root=>{listed.push(root.path);return readLegacyRootEntries(root);}});
  assert.equal(result.state,'ready');assert.deepEqual(listed,[f.source]);assert.equal(result.sources.length,1);
  assert.deepEqual(result.sources[0].roles,['desktop','gateway']);
  const routes=new Map(result.sources[0].routes.map(route=>[route.relativePath,route]));
  assert.equal(routes.get('settings.json').destination,join(f.native,'studio/gateway/settings.json'));
  assert.equal(routes.get(backup).owner,'gateway');assert.equal(routes.get('.product-account-cookie-scope.json').owner,'gateway');
  assert.equal(routes.get('skill-runtime').owner,'gateway');assert.equal(routes.get('skill-runtime').recursive,true);
  assert.equal(routes.get('skill-runtime').destination,join(f.native,'studio/gateway/skill-runtime'));
  assert.equal(routes.get('gateway-port').destination,join(f.native,'studio/desktop/gateway-port'));
  assert.equal(routes.get('Partitions').disposition,'container');assert.equal(routes.get('Partitions').recursive,false);
  assert.equal(routes.get('Partitions/kcoder-studio-desktop').recursive,true);
  assert.equal(routes.get('kcoder-storage-writers.lock').disposition,'retainControl');
  assert.equal(routes.get('kcoder-storage-writers.lock').destination,null);
  assert.equal(result.nativeInPlace.path,f.native);assert.equal(result.nativeInPlace.disposition,'retain');
  assert.equal(result.nativeInPlace.exists,true);
  assert.equal(await readFile(join(f.native,'settings.json'),'utf8'),'original Native model configuration');
  assert.equal(await readFile(join(f.source,'settings.json'),'utf8'),'original Gateway settings');
  await assert.rejects(stat(join(f.native,'studio')),{code:'ENOENT'});
});

test('the exact retired skill-runtime namespace still rejects files and links',()=>{
  const selected=selection('/owned/home');
  for(const [relativePath,kind] of [['skill-runtime','file'],['skill-runtime','symlink']]){
    const result=classifyLegacyStorageEntries({selected,roots:[{path:selected.paths.gatewayRoot,identity:'original-gateway',entries:[{relativePath,kind}]}]});
    assert.equal(result.state,'blocked',relativePath);
    assert.equal(result.sources[0].routes.length,0,relativePath);
  }
});

test('two known roots claiming one Gateway destination block without selecting newer data',async t=>{
  const f=await fixture(t);
  // Model the registered Native Gateway and the older shared Electron userData
  // retained under the current account's Roaming profile.
  const selected=selection(f.home,{platformConfig:join(f.home,'AppData/Roaming')});
  const gateway=join(f.native,'studio-gateway-c4c16a0149c9061d'),desktop=selected.paths.desktopRoot;
  await put(join(gateway,'servers.json'),'registered Gateway catalog');
  await put(join(desktop,'servers.json'),'old Roaming Gateway catalog');
  await put(join(gateway,'channels','channels.sqlite3'),'registered Gateway channel state');
  await put(join(desktop,'channels','channels.sqlite3'),'old Roaming Gateway channel state');
  await put(join(desktop,'mobile-device-auth','device.key'),'old Gateway identity');
  await put(join(desktop,'relay','registration.json'),'old Relay registration');
  await put(join(desktop,'gateway-port'),'44123');
  await put(join(desktop,'Network','network-state'),'Electron network state');
  await put(join(desktop,'SharedStorage'),'Electron shared storage');
  await put(join(desktop,'shell-icons','cache'),'Electron shell icon state');
  const result=await previewLegacyLocations({selected,registeredSources:[{
    path:gateway,roles:['gateway'],registrationId:'current-installed-gateway'
  }]});
  assert.equal(result.state,'blocked');assert.equal(result.sources.length,3);
  assert.ok(result.blockers.some(row=>row.code==='LEGACY_DESTINATION_CONFLICT'&&row.relativePath==='servers.json'));
  const roaming=result.sources.find(source=>source.path===desktop);
  const routes=new Map(roaming.routes.map(route=>[route.relativePath,route]));
  for(const path of ['servers.json','channels','mobile-device-auth','relay'])assert.equal(routes.get(path).owner,'gateway',path);
  for(const path of ['gateway-port','Network','SharedStorage','shell-icons'])assert.equal(routes.get(path).owner,'desktop',path);
  assert.equal(await readFile(join(gateway,'servers.json'),'utf8'),'registered Gateway catalog');
  assert.equal(await readFile(join(gateway,'channels','channels.sqlite3'),'utf8'),'registered Gateway channel state');
  assert.equal(await readFile(join(desktop,'servers.json'),'utf8'),'old Roaming Gateway catalog');
  assert.equal(await readFile(join(desktop,'channels','channels.sqlite3'),'utf8'),'old Roaming Gateway channel state');
  assert.equal(await readFile(join(desktop,'mobile-device-auth','device.key'),'utf8'),'old Gateway identity');
  assert.equal(await readFile(join(desktop,'relay','registration.json'),'utf8'),'old Relay registration');
  assert.equal(await readFile(join(desktop,'Network','network-state'),'utf8'),'Electron network state');
  assert.equal(await readFile(join(desktop,'SharedStorage'),'utf8'),'Electron shared storage');
  assert.equal(await readFile(join(desktop,'shell-icons','cache'),'utf8'),'Electron shell icon state');
});

test('actual Electron default-session leaves belong only to Desktop with exact entry kinds',async t=>{
  const f=await fixture(t);
  const files=['Cookies','Cookies-journal','DevToolsActivePort','Network Persistent State','Preferences','SharedStorage','Trust Tokens','Trust Tokens-journal'];
  const directories=['Cache','Code Cache','Local Storage','Network','Shared Dictionary','blob_storage','shell-icons'];
  for(const name of files)await put(join(f.source,name),'original Electron SDK file');
  for(const name of directories)await put(join(f.source,name,'original-state'),'original Electron SDK state');
  const result=await previewLegacyLocations({selected:f.selected});
  assert.equal(result.state,'ready');
  for(const route of result.sources[0].routes){
    assert.equal(route.owner,'desktop');
    assert.equal(route.destination,join(f.native,'studio/desktop',route.relativePath));
    assert.equal(route.recursive,directories.includes(route.relativePath));
  }
  assert.equal(result.sources[0].routes.length,files.length+directories.length);
  for(const [relativePath,kind] of [['Cookies','directory'],['Cache','file'],['Local Storage','symlink']]){
    const blocked=classifyLegacyStorageEntries({selected:f.selected,roots:[{path:f.source,identity:'original-shared',entries:[{relativePath,kind}]}]});
    assert.equal(blocked.state,'blocked',relativePath);
    assert.equal(blocked.sources[0].routes.length,0,relativePath);
  }
  await assert.rejects(stat(join(f.native,'studio')),{code:'ENOENT'});
});

test('unknown entries, additional partitions and arbitrary backups stay in the Desktop namespace',async t=>{
  const f=await fixture(t);
  for(const path of ['settings.json.bak','settings.json.v3-'+'a'.repeat(64)+'.bak','notes/private.txt',
    'Partitions/kcoder-studio-remote/Cookies'])await put(join(f.source,path),'preserve original unknown bytes');
  const result=await previewLegacyLocations({selected:f.selected});
  assert.equal(result.state,'ready');
  assert.deepEqual(result.blockers,[]);
  for(const path of ['settings.json.bak','settings.json.v3-'+'a'.repeat(64)+'.bak','notes','Partitions/kcoder-studio-remote']){
    const route=result.sources[0].routes.find(row=>row.relativePath===path);
    assert.equal(route.owner,'desktop',path);
    assert.equal(route.destination,join(f.native,'studio/desktop',path));
    assert.equal(route.recursive,['notes','Partitions/kcoder-studio-remote'].includes(path));
  }
  assert.equal(await readFile(join(f.source,'notes/private.txt'),'utf8'),'preserve original unknown bytes');
});

test('valid unified records and explicit instances perform zero old-root IO',async()=>{
  const home=join(tmpdir(),'must-not-be-observed-legacy-home'),options=[
    {record:{version:1,revision:2,dataRoot:join(home,'Data'),cacheRoot:join(home,'Cache')}},
    {overrides:{KCODER_HOME:join(home,'explicit-native')}},
    {overrides:{KCODER_STUDIO_DATA_DIR:join(home,'explicit-gateway')}},
    {development:true},
  ];
  for(const option of options){
    const selected=selection(home,option),io={observeRoot:()=>{throw Error('old IO forbidden');},readRootEntries:()=>{throw Error('old listing forbidden');}};
    const result=await previewLegacyLocations({selected},io);
    assert.equal(result.state,option.record?'alreadyUnified':'externalInstance');assert.deepEqual(result.sources,[]);
    assert.equal(result.nativeInPlace.exists,null);
  }
});

test('physical aliases share one classification and cannot reassign the Native root',()=>{
  const home='/owned/home',selected=selection(home,{platformConfig:'/owned/AppData/Roaming'}),
    gateway='/owned/home/.config/kcoder-studio',desktop=selected.paths.desktopRoot;
  const entries=[{relativePath:'settings.json',kind:'file'},{relativePath:'gateway-port',kind:'file'}];
  const result=classifyLegacyStorageEntries({selected,roots:[
    {path:selected.paths.dataRoot,identity:'actual-native',entries:[]},
    {path:gateway,identity:'one-actual-root',entries},
    {path:desktop,identity:'one-actual-root',entries},
  ]});
  assert.equal(result.state,'ready');assert.equal(result.sources.length,1);assert.equal(result.sources[0].aliases.length,2);
  assert.equal(result.sources[0].routes.length,2);
  const aliasNative=classifyLegacyStorageEntries({selected,roots:[
    {path:selected.paths.dataRoot,identity:'same-native-root',entries:[]},
    {path:gateway,identity:'same-native-root',entries:[]},
  ]});
  assert.equal(aliasNative.state,'blocked');assert.equal(aliasNative.blockers[0].code,'LEGACY_SOURCE_ALIASES_NATIVE');
  assert.equal(aliasNative.sources[0].routes.length,0);
});

test('occupied final owner roots block domain merging and are preserved',async t=>{
  const f=await fixture(t);await put(join(f.source,'servers.json'),'original catalog');
  const destination=join(f.native,'studio/gateway/servers.json');await put(destination,'other existing catalog');
  const result=await previewLegacyLocations({selected:f.selected});
  assert.equal(result.state,'blocked');assert.ok(result.blockers.some(row=>row.code==='LEGACY_TARGET_OCCUPIED'));
  assert.equal(await readFile(destination,'utf8'),'other existing catalog');
});

test('links and unknown control payloads never become empty disposable files',async t=>{
  const f=await fixture(t);await put(join(f.source,'kcoder-storage-writers.lock'),'unknown persistent payload');
  await symlink(f.native,join(f.source,'mobile-device-auth'),process.platform==='win32'?'junction':'dir');
  const result=await previewLegacyLocations({selected:f.selected});
  assert.equal(result.state,'blocked');
  assert.ok(result.blockers.some(row=>row.code==='LEGACY_CONTROL_PAYLOAD_UNCONFIRMED'));
  assert.ok(result.blockers.some(row=>row.code==='LEGACY_ENTRY_LINK_UNSUPPORTED'&&row.relativePath==='mobile-device-auth'));
  assert.equal(await readFile(join(f.source,'kcoder-storage-writers.lock'),'utf8'),'unknown persistent payload');
});

test('registered legacy sources need explicit records and never absorb arbitrary directories',async t=>{
  const f=await fixture(t),registered=join(f.home,'registered-installation-state');
  await put(join(registered,'servers.json'),'registered original catalog');
  const result=await previewLegacyLocations({selected:f.selected,registeredSources:[{path:registered,roles:['gateway'],registrationId:'existing-installation-record'}]});
  assert.equal(result.state,'ready');
  assert.equal(result.sources.find(root=>root.path===registered).aliases[0].registrationIds[0],'existing-installation-record');
  await assert.rejects(previewLegacyLocations({selected:f.selected,registeredSources:[{path:registered,roles:['gateway']}]}),{code:'LEGACY_REGISTRATION_INVALID'});
  assert.throws(()=>classifyLegacyStorageEntries({selected:f.selected,roots:[{path:registered,identity:'unregistered',entries:[]}]}),{code:'LEGACY_SOURCE_NOT_DECLARED'});
});

test('source directory replacement reports changed identity without modifying either copy',async t=>{
  const f=await fixture(t);await put(join(f.source,'servers.json'),'original catalog');let changed=false;
  const result=await previewLegacyLocations({selected:f.selected},{observeRoot:observeLegacyRoot,readRootEntries:async root=>{
    if(root.path===f.source&&!changed){
      changed=true;await rename(f.source,f.source+'.retained');await mkdir(f.source,{mode:0o700});await put(join(f.source,'servers.json'),'replacement catalog');
    }
    return readLegacyRootEntries(root);
  }});
  assert.equal(result.state,'blocked');assert.ok(result.blockers.some(row=>row.code==='LEGACY_SOURCE_CHANGED'));
  assert.equal(await readFile(join(f.source+'.retained','servers.json'),'utf8'),'original catalog');
  assert.equal(await readFile(join(f.source,'servers.json'),'utf8'),'replacement catalog');
});

test('Windows metadata preserves Unicode paths and blocks case-colliding owner entries',()=>{
  const context={version:1,home:'C:\\Users\\阿丽',platformConfig:'C:\\Users\\阿丽\\AppData\\Roaming',overrides:{},record:null,consumer:'desktop',development:false};
  const selected={context,paths:resolveStoragePaths({...context,env:context.overrides,platform:'win32'})};
  const backups=classifyLegacyStorageEntries({selected,platform:'win32',roots:[{path:selected.paths.desktopRoot,identity:'observed-windows-root',entries:[
    {relativePath:'settings.json.20260928.bak',kind:'file'},
    {relativePath:'旧设置备份-20261111.json',kind:'file'},
    {relativePath:'未登记目录',kind:'directory'},
  ]}]});
  assert.equal(backups.state,'ready');
  assert.deepEqual(backups.blockers,[]);
  for(const route of backups.sources[0].routes){
    assert.equal(route.owner,'desktop');
    assert.equal(route.destination,selected.paths.dataRoot+'\\studio\\desktop\\'+route.relativePath);
  }
  const result=classifyLegacyStorageEntries({selected,platform:'win32',roots:[{path:selected.paths.desktopRoot,identity:'observed-windows-root',entries:[
    {relativePath:'SETTINGS.JSON',kind:'file',identity:'actual-first-file'},
    {relativePath:'settings.json',kind:'file',identity:'actual-other-file'},
  ]}]});
  assert.equal(result.state,'blocked');assert.ok(result.blockers.some(row=>row.code==='LEGACY_DESTINATION_CONFLICT'));
  assert.ok(result.sources[0].routes.every(route=>route.destination.includes('阿丽')));
});

test('full stopped metadata cannot hide a link inside an otherwise recognized namespace',()=>{
  const selected=selection('/owned/home');
  const result=classifyLegacyStorageEntries({selected,roots:[{path:selected.paths.gatewayRoot,identity:'source',entries:[
    {relativePath:'mobile-device-auth',kind:'directory'},
    {relativePath:'mobile-device-auth/.key',kind:'file'},
    {relativePath:'mobile-device-auth/outside',kind:'symlink'},
  ]}]});
  assert.equal(result.sources[0].routes.length,1);
  assert.equal(result.state,'blocked');assert.equal(result.blockers[0].relativePath,'mobile-device-auth/outside');
});

test('running preview retains only exact Desktop Singleton controls while stopped stays strict',()=>{
  const selected=selection('/owned/home'),names=['SingletonLock','SingletonSocket','SingletonCookie'];
  const roots=[{path:selected.paths.desktopRoot,identity:'shared-root',entries:names.map(relativePath=>({relativePath,kind:'symlink',identity:relativePath+'-id'}))}];
  const preview=classifyLegacyStorageEntries({selected,roots,phase:'preview'});
  assert.equal(preview.state,'ready');assert.equal(preview.sources[0].routes.length,3);
  for(const route of preview.sources[0].routes){
    assert.equal(route.owner,'desktop');assert.equal(route.disposition,'retainControl');assert.equal(route.destination,null);
    assert.equal(route.recursive,false);assert.equal(route.kind,'symlink');
  }
  for(const options of [{},{phase:'stopped'}]){
    const strict=classifyLegacyStorageEntries({selected,roots,...options});
    assert.equal(strict.state,'blocked');assert.equal(strict.sources[0].routes.length,0);
    assert.deepEqual(strict.blockers.map(row=>row.code),names.map(()=>'LEGACY_ENTRY_LINK_UNSUPPORTED'));
  }
  assert.equal(classifyLegacyStorageEntries({selected,roots:[{...roots[0],entries:[]}],phase:'stopped'}).state,'ready');
  assert.throws(()=>classifyLegacyStorageEntries({selected,phase:'copy'}),{code:'LEGACY_OBSERVATION_PHASE_INVALID'});
});

test('preview never absorbs arbitrary links, nested Singleton names or Gateway-only controls',()=>{
  const selected=selection('/owned/home',{platformConfig:'/owned/platform-config'});
  const result=classifyLegacyStorageEntries({selected,phase:'preview',roots:[
    {path:join(selected.context.home,'.config/kcoder-studio'),identity:'gateway-only',entries:[{relativePath:'SingletonLock',kind:'symlink'}]},
    {path:selected.paths.desktopRoot,identity:'desktop',entries:[{relativePath:'SingletonOther',kind:'symlink'},
      {relativePath:'Partitions',kind:'directory'},{relativePath:'Partitions/kcoder-studio-desktop',kind:'directory'},
      {relativePath:'Partitions/kcoder-studio-desktop/SingletonLock',kind:'symlink'}]},
  ]});
  assert.equal(result.state,'blocked');
  for(const relativePath of ['SingletonLock','SingletonOther','Partitions/kcoder-studio-desktop/SingletonLock'])
    assert.ok(result.blockers.some(row=>row.relativePath===relativePath&&row.code==='LEGACY_ENTRY_LINK_UNSUPPORTED'));
  assert.equal(result.sources.flatMap(root=>root.routes).some(route=>route.disposition==='retainControl'),false);
});

test('metadata observation forwards preview without following or removing Singleton links',async t=>{
  const f=await fixture(t),control=join(f.source,'SingletonLock'),target=join(f.home,'uncreated-sdk-control-target');
  await symlink(target,control,process.platform==='win32'?'junction':'dir');
  const before=await lstat(control,{bigint:true});
  const preview=await previewLegacyLocations({selected:f.selected,phase:'preview'});
  assert.equal(preview.state,'ready');assert.equal(preview.sources[0].routes[0].disposition,'retainControl');
  assert.equal((await lstat(control,{bigint:true})).ino,before.ino);
  await assert.rejects(lstat(target),{code:'ENOENT'});
  const stopped=await previewLegacyLocations({selected:f.selected,phase:'stopped'});
  assert.equal(stopped.state,'blocked');assert.equal(stopped.blockers[0].code,'LEGACY_ENTRY_LINK_UNSUPPORTED');
  assert.equal((await lstat(control,{bigint:true})).ino,before.ino);
});

async function treeMetadata(root){
  const facts=[];
  const visit=async(relativePath='')=>{
    const path=join(root,relativePath),info=await lstat(path,{bigint:true});
    facts.push({relativePath,dev:String(info.dev),ino:String(info.ino),size:String(info.size),
      mtime:String(info.mtimeNs),ctime:String(info.ctimeNs)});
    if(info.isDirectory()&&!info.isSymbolicLink())for(const name of (await readdir(path)).sort())await visit(join(relativePath,name));
  };
  await visit();return facts;
}

async function deadline(promise,label){
  let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),5000);})]);}
  finally{clearTimeout(timer);}
}

async function previewWorker(t,home,args=['--kcoder-storage-legacy-preview-v1']){
  const env={HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:join(home,'.config'),APPDATA:join(home,'AppData/Roaming')};
  for(const name of ['PATH','SystemRoot','WINDIR','TMPDIR','TEMP','TMP'])if(process.env[name])env[name]=process.env[name];
  const child=spawn(process.execPath,[fileURLToPath(new URL('./legacy-locations.mjs',import.meta.url)),...args],
    {env,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
  const identity=processTreeIdentity(child),closed=once(child,'close');
  child.stdin.on('error',()=>{});
  let stdout='',stderr='',outputLimit=false;
  child.stdout.on('data',chunk=>{
    if(Buffer.byteLength(stdout)+chunk.length>1024*1024){outputLimit=true;child.stdout.destroy();child.kill();return;}
    stdout+=chunk.toString('utf8');
  });
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString('utf8')).slice(-8192);});
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null){
      child.stdin.destroy();
      if(process.platform==='win32')child.kill();else await signalProcessTree(child,identity,'SIGKILL');
    }
    await deadline(closed,'owned legacy preview worker cleanup timed out');
  });
  return {child,async result(){
    const [code,signal]=await deadline(closed,'legacy preview worker timed out: '+stderr);
    assert.equal(outputLimit,false);return {code,signal,stdout,stderr};
  }};
}

test('fixed read-only worker observes actual Desktop selection without filesystem changes',async t=>{
  const home=await mkdtemp(join(tmpdir(),'kcoder-legacy-preview-worker-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const platformConfig=process.platform==='win32'?join(home,'AppData/Roaming'):process.platform==='darwin'?join(home,'Library/Application Support'):join(home,'.config');
  const selected=selection(home,{platformConfig});
  await put(join(selected.paths.dataRoot,'settings.json'),'Native settings are never read by preview');
  await put(join(selected.paths.dataRoot,'credentials.json'),'owned credential fixture');
  await put(join(selected.paths.desktopRoot,'gateway-port'),'43123');
  await put(join(selected.paths.desktopRoot,'account_credentials.json'),'metadata only');
  const before=await treeMetadata(home),worker=await previewWorker(t,home);
  worker.child.stdin.write(JSON.stringify({version:1,phase:'preview'})+'\n');
  const result=await worker.result();assert.equal(result.code,0,result.stderr);
  const lines=result.stdout.trim().split('\n');assert.equal(lines.length,1);
  const response=JSON.parse(lines[0]);assert.equal(response.version,1);assert.equal(response.manifest.state,'ready');
  assert.equal(response.manifest.nativeInPlace.path,selected.paths.dataRoot);
  assert.equal(response.manifest.sources[0].path,selected.paths.desktopRoot);
  assert.equal(response.manifest.sources[0].routes.find(route=>route.relativePath==='gateway-port').owner,'desktop');
  assert.deepEqual(await treeMetadata(home),before);
});

test('worker rejects arbitrary selection, extra frames and oversized input without creating roots',async t=>{
  const home=await mkdtemp(join(tmpdir(),'kcoder-legacy-preview-reject-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const before=await treeMetadata(home),valid=JSON.stringify({version:1,phase:'preview'})+'\n';
  for(const input of [JSON.stringify({version:1,phase:'preview',home:'/untrusted-root'})+'\n',valid+valid,valid+'partial', 'x'.repeat(1025)]){
    const worker=await previewWorker(t,home);worker.child.stdin.write(input);
    const result=await worker.result();assert.equal(result.code,1);assert.equal(result.stdout,'');
    assert.deepEqual(await treeMetadata(home),before);
  }
  const invalid=await previewWorker(t,home,[]),result=await invalid.result();
  assert.equal(result.code,1);assert.match(result.stderr,/LEGACY_PREVIEW_ARGUMENT_INVALID/);assert.equal(result.stdout,'');
});

test('worker closes on original parent EOF before or after a request and on cancellation',async t=>{
  const home=await mkdtemp(join(tmpdir(),'kcoder-legacy-preview-parent-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const before=await treeMetadata(home);
  for(const input of ['',JSON.stringify({version:1,phase:'preview'})+'\n']){
    const worker=await previewWorker(t,home);worker.child.stdin.end(input);
    const result=await worker.result();assert.equal(result.code,1,result.stderr);assert.equal(result.stdout,'');
    assert.match(result.stderr,/LEGACY_PREVIEW_PARENT_CLOSED/);
  }
  const worker=await previewWorker(t,home);await once(worker.child,'spawn');worker.child.kill('SIGTERM');
  const result=await worker.result();assert.notEqual(result.code,0);assert.equal(result.stdout,'');
  assert.deepEqual(await treeMetadata(home),before);
});

async function stagedNamespaceModule(t,descriptor){
  const root=await mkdtemp(join(tmpdir(),'kcoder-legacy-static-names-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,'src/migrations');await mkdir(source,{recursive:true});
  await writeFile(join(root,'package.json'),JSON.stringify({type:'module'}));
  for(const name of ['legacy-locations.mjs','../storage-paths.mjs','../bounded-jsonl-decoder.js','../bounded-receive-buffer.js'])
    await copyFile(new URL(name,import.meta.url),join(source,name));
  if(descriptor!==undefined)await writeFile(join(source,'legacy-owner-namespaces.json'),JSON.stringify(descriptor));
  return import(pathToFileURL(join(source,'legacy-locations.mjs')).href);
}

test('Node classification reads only its adjacent shared namespace declaration',async t=>{
  const descriptor=JSON.parse(await readFile(new URL('./legacy-owner-namespaces.json',import.meta.url),'utf8'));
  assert.equal(descriptor.version,1);
  const staged=await stagedNamespaceModule(t,{...descriptor,gatewayFiles:descriptor.gatewayFiles.filter(name=>name!=='settings.json')});
  const selected=selection('/owned/home'),roots=[{path:selected.paths.desktopRoot,identity:'shared-root',entries:[{relativePath:'settings.json',kind:'file'}]}];
  assert.equal(classifyLegacyStorageEntries({selected,roots}).state,'ready');
  const result=staged.classifyLegacyStorageEntries({selected,roots});
  assert.equal(result.state,'ready');assert.deepEqual(result.blockers,[]);
  assert.equal(result.sources[0].routes[0].owner,'desktop');
  assert.equal(classifyLegacyStorageEntries({selected,roots}).sources[0].routes[0].owner,'gateway');
});

test('missing, future or malformed bundled declarations fail without a fallback namespace table',async t=>{
  const descriptor=JSON.parse(await readFile(new URL('./legacy-owner-namespaces.json',import.meta.url),'utf8'));
  await assert.rejects(stagedNamespaceModule(t,undefined),{code:'ERR_MODULE_NOT_FOUND'});
  for(const changed of [
    {...descriptor,version:2}, {...descriptor,allow:true}, {...descriptor,controls:['../outside']},
    {...descriptor,desktopFiles:['gateway-port','gateway-port']}, {...descriptor,partition:'Partitions/../outside'},
    {...descriptor,gatewayBackupPattern:'^[invalid$'},
  ])await assert.rejects(stagedNamespaceModule(t,changed),{code:'LEGACY_OWNER_NAMESPACES_INVALID'});
});


test('standalone Gateway unknown payload stays with its source and keeps conflict checks',()=>{
  const selected=selection('/owned/home',{platformConfig:'/owned/Roaming'}),gateway=join(selected.context.home,'.config/kcoder-studio');
  const entries=[{relativePath:'arbitrary.backup',kind:'file'},{relativePath:'saved-data',kind:'directory'}];
  const roots=[{path:gateway,identity:'gateway-only',entries}];
  const result=classifyLegacyStorageEntries({selected,roots});
  assert.equal(result.state,'ready');
  for(const route of result.sources[0].routes){
    assert.equal(route.owner,'gateway');
    assert.equal(route.destination,join(selected.paths.dataRoot,'studio/gateway',route.relativePath));
  }
  const registeredSources=[{path:'/owned/other-gateway',roles:['gateway'],registrationId:'original-registration'}];
  const conflict=classifyLegacyStorageEntries({selected,registeredSources,roots:[...roots,{path:'/owned/other-gateway',identity:'another-root',entries}]});
  assert.equal(conflict.state,'blocked');
  assert.ok(conflict.blockers.some(row=>row.code==='LEGACY_DESTINATION_CONFLICT'));
});

test('ordinary Singleton control files still block stopped migration',()=>{
  const selected=selection('/owned/home');
  const roots=[{path:selected.paths.desktopRoot,identity:'desktop',entries:[{relativePath:'SingletonLock',kind:'file'}]}];
  const result=classifyLegacyStorageEntries({selected,roots});
  assert.equal(result.state,'blocked');
  assert.equal(result.blockers[0].code,'LEGACY_DESKTOP_CONTROL_PRESENT');
});
