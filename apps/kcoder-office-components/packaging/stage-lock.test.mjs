// Actual owned Node processes and SQLite locks; no platform or runtime capability claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile,writeFile,readdir,rename,copyFile,symlink,link,unlink,lstat,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { acquireOfficeStageLock } from './stage-lock.mjs';

const moduleUrl=new URL('./stage-lock.mjs',import.meta.url).href;
const driver=`
import fs from 'node:fs/promises';
import { readFileSync,writeFileSync,renameSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const [target,mode]=process.argv.slice(1),keep=setInterval(()=>{},1000);
const pause=phase=>{process.send({state:'paused',phase});return new Promise(()=>{});};
if(['empty-db','partial-template'].includes(mode)){
 const original=fs.open;
 fs.open=async(path,...args)=>{
  const handle=await original(path,...args);
  if(mode==='empty-db'&&String(path).endsWith('/authority.sqlite')&&args[0]==='wx+')return {stat:()=>pause('empty-db'),close:()=>handle.close()};
  if(mode==='partial-template'&&/notice-[a-f0-9]+\\.json$/.test(path))return {
   stat:options=>handle.stat(options),sync:()=>handle.sync(),close:()=>handle.close(),
   writeFile:async text=>{await handle.writeFile(String(text).slice(0,24));return pause('partial-template');},
  };
  return handle;
 };syncBuiltinESMExports();
}
if(['before-link','after-link'].includes(mode)){
 const original=fs.link;fs.link=async(from,to)=>{if(mode==='before-link')return pause('before-link');await original(from,to);return pause('after-link');};syncBuiltinESMExports();
}
let openedDifferent=false;
try{
 let loaded;
 if(mode==='aba'||mode==='release-failure'){
  const source=await fs.readFile(new URL(${JSON.stringify(moduleUrl)}),'utf8');
  const needle=mode==='aba'?'db=new DatabaseSync(database);':'db.close();';if(!source.includes(needle))throw Error('Owned fault injection no longer matches the helper');
  globalThis.ownedTestOpenDatabase=(path,Native)=>{
   const bytes=readFileSync(path),copy=Buffer.from(bytes);copy.writeUInt32BE(123456,60);
   renameSync(path,path+'.owned-original');writeFileSync(path,copy,{mode:0o600,flag:'wx'});
   const actual=new Native(path);openedDifferent=actual.prepare('PRAGMA user_version').get().user_version===123456;
   actual.exec('PRAGMA user_version=1');
   renameSync(path,path+'.owned-copy');renameSync(path+'.owned-original',path);return actual;
  };
  loaded=await import('data:text/javascript;base64,'+Buffer.from(source.replace(needle,mode==='aba'?'db=globalThis.ownedTestOpenDatabase(database,DatabaseSync);':'throw new Error("owned close failure");')).toString('base64'));
 }else loaded=await import(${JSON.stringify(moduleUrl)});
 const {acquireOfficeStageLock}=loaded;
 const lease=await acquireOfficeStageLock(target);
 if(mode==='vm'){
  const vm=await import('node:vm'),source=await fs.readFile(new URL(${JSON.stringify(moduleUrl)}),'utf8'),context=vm.createContext({});
  const copy=new vm.SourceTextModule(source,{context});
  await copy.link(async name=>{const namespace=await import(name);return new vm.SyntheticModule(Object.keys(namespace),function(){for(const key of Object.keys(namespace))this.setExport(key,namespace[key]);},{context});});
  await copy.evaluate();let code;try{await copy.namespace.acquireOfficeStageLock(target);}catch(error){code=error.code;}
  process.send({state:'vm-rejected',code});
 }else process.send({state:'held',...(mode==='aba'?{openedDifferent}:{})});
 process.on('message',async message=>{
  if(message==='check'){try{await lease.assertCurrent();process.send({state:'valid'});}catch(error){process.send({state:'invalid',code:error.code});}return;}
  if(mode==='release-failure'){
   const codes=[];for(let i=0;i<2;i++)try{await lease.release();codes.push('unexpected');}catch(error){codes.push(error.code);}
   let reacquire;try{await acquireOfficeStageLock(target);reacquire='unexpected';}catch(error){reacquire=error.code;}
   process.send({state:'release-failed',codes,reacquire});return;
  }
  await lease.release();clearInterval(keep);process.disconnect();
 });
}catch(error){process.send({state:'rejected',code:error.code,...(mode==='aba'?{openedDifferent}:{})});clearInterval(keep);process.disconnect();}
`;

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'owned-office-mutex-')),children=[];
 t.after(async()=>{for(const child of children){if(child.process.exitCode===null&&child.process.signalCode===null)child.process.kill('SIGKILL');await child.closed;}await rm(root,{recursive:true,force:true});});
 const target=join(root,'office'),directory=join(root,'.office.office-stage.v1'),database=join(directory,'authority.sqlite'),notice=join(root,'.office.office-stage.lock');
 async function start(mode='hold'){
  const child=spawn(process.execPath,[...(mode==='vm'?['--experimental-vm-modules']:[]),'--input-type=module','-e',driver,target,mode],{env:{LANG:'C.UTF-8'},stdio:['ignore','ignore','pipe','ipc']});
  child.stderr.resume();const closed=once(child,'close');const item={process:child,closed};children.push(item);let timer;
  item.message=await Promise.race([once(child,'message').then(([value])=>value),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned SQLite mutex child timed out')),5000);})]).finally(()=>clearTimeout(timer));
  return item;
 }
 async function stop(child){child.process.send('release');await child.closed;}
 async function kill(child){
  assert.equal(child.process.kill('SIGKILL'),true);const result=await child.closed;
  if(process.platform!=='win32')assert.equal(result[1],'SIGKILL');
  else assert.ok(child.process.exitCode!==null||child.process.signalCode!==null);
 }
 return {root,target,directory,database,notice,start,stop,kill};
}

test('the build mutex excludes peer processes, retains legacy exclusion and recovers from SIGKILL',async t=>{
 const f=await fixture(t),owner=await f.start();assert.equal(owner.message.state,'held');
 const peer=await f.start();assert.deepEqual(peer.message,{state:'rejected',code:'OFFICE_RESOURCE_STAGE_BUSY'});
 const bytes=await readFile(f.notice);assert.equal(JSON.parse(bytes).protocol,'kcoder-office-stage-v1');
 await f.kill(owner);const successor=await f.start();assert.equal(successor.message.state,'held');await f.stop(successor);
 assert.deepEqual(await readFile(f.notice),bytes);assert.equal((await lstat(f.notice)).nlink,2);
 await assert.rejects(writeFile(f.notice,'legacy',{flag:'wx'}),{code:'EEXIST'});
});

test('every initialization interruption leaves either no notice or a complete recoverable notice',async t=>{
 for(const mode of ['empty-db','partial-template','before-link','after-link']){
  await t.test(mode,async t=>{
   const f=await fixture(t),initial=await f.start(mode);assert.equal(initial.message.state,'paused');
   const found=await lstat(f.notice).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
   assert.equal(Boolean(found),mode==='after-link');if(found)assert.equal(JSON.parse(await readFile(f.notice,'utf8')).protocol,'kcoder-office-stage-v1');
   const peer=mode==='empty-db'?null:await f.start();if(peer)assert.equal(peer.message.state,'rejected');
   await f.kill(initial);const recovered=await f.start();assert.equal(recovered.message.state,'held');await f.stop(recovered);
  });
 }
});

test('unknown legacy files and unexpected symlink or hardlink authorities are never reclaimed',async t=>{
 const f=await fixture(t);await writeFile(f.notice,'unidentified legacy owner');
 const blocked=await f.start();assert.deepEqual(blocked.message,{state:'rejected',code:'OFFICE_RESOURCE_STAGE_BUSY'});
 assert.equal(await readFile(f.notice,'utf8'),'unidentified legacy owner');assert.deepEqual(await readdir(f.root),['.office.office-stage.lock']);
 await unlink(f.notice);const owner=await f.start();await f.stop(owner);
 const original=await readFile(f.database);await rename(f.database,f.database+'.owned-original');
 const victim=join(f.root,'owned-victim');await writeFile(victim,'must remain unchanged');
 await symlink(victim,f.database);const symlinked=await f.start();assert.equal(symlinked.message.code,'OFFICE_RESOURCE_UNSAFE');assert.equal(await readFile(victim,'utf8'),'must remain unchanged');await unlink(f.database);
 await link(f.database+'.owned-original',f.database);const hardlinked=await f.start();assert.equal(hardlinked.message.code,'OFFICE_RESOURCE_UNSAFE');assert.deepEqual(await readFile(f.database),original);
});

test('a replaced database inode cannot admit a successor or leave the old owner valid',async t=>{
 const f=await fixture(t),owner=await f.start();assert.equal(owner.message.state,'held');
 await rename(f.database,f.database+'.owned-original');await copyFile(f.database+'.owned-original',f.database);await import('node:fs/promises').then(fs=>fs.chmod(f.database,0o600));
 const peer=await f.start();assert.equal(peer.message.code,'OFFICE_RESOURCE_UNSAFE');
 const checked=once(owner.process,'message');owner.process.send('check');assert.deepEqual((await checked)[0],{state:'invalid',code:'OFFICE_RESOURCE_UNSAFE'});
 await f.kill(owner);assert.ok(await lstat(f.database));assert.ok(await lstat(f.database+'.owned-original'));
});

test('an open-time ABA copy using a real SQLite read cannot be admitted',async t=>{
 const f=await fixture(t),original=await f.start();await f.stop(original);
 const before=await readFile(f.database),candidate=await f.start('aba');assert.equal(candidate.message.openedDifferent,true);assert.equal(candidate.message.state,'rejected');
 assert.deepEqual(await readFile(f.database),before);
 const actual=await f.start();assert.equal(actual.message.state,'held');await f.stop(actual);
});

test('notice aliases, sidecars and the authority directory reject foreign link substitutions',async t=>{
 await t.test('extra notice hardlink',async t=>{
  const f=await fixture(t),owner=await f.start();await f.stop(owner);
  const peerAlias=join(f.root,'owned-extra-link');await link(f.notice,peerAlias);
  const rejected=await f.start();assert.equal(rejected.message.code,'OFFICE_RESOURCE_UNSAFE');assert.equal((await lstat(peerAlias)).nlink,3);
 });
 await t.test('replaced notice inode',async t=>{
  const f=await fixture(t),owner=await f.start();await f.stop(owner);
  const preserved=await readFile(f.notice);await rename(f.notice,f.notice+'.owned-original');await copyFile(f.notice+'.owned-original',f.notice);
  const rejected=await f.start();assert.equal(rejected.message.code,'OFFICE_RESOURCE_UNSAFE');assert.deepEqual(await readFile(f.notice),preserved);
 });
 await t.test('journal symlink',async t=>{
  const f=await fixture(t),owner=await f.start();await f.stop(owner);
  const victim=join(f.root,'owned-sidecar-victim');await writeFile(victim,'unchanged');await symlink(victim,f.database+'-journal');
  const rejected=await f.start();assert.equal(rejected.message.code,'OFFICE_RESOURCE_UNSAFE');assert.equal(await readFile(victim,'utf8'),'unchanged');
 });
 await t.test('directory symlink',async t=>{
  const f=await fixture(t),victim=join(f.root,'owned-victim-directory');await mkdir(victim,{mode:0o700});await symlink(victim,f.directory,'dir');
  const rejected=await f.start();assert.equal(rejected.message.code,'OFFICE_RESOURCE_UNSAFE');assert.deepEqual(await readdir(victim),[]);
 });
});

test('main-thread realms and workers fail before opening an extra SQLite fd',async t=>{
 const f=await fixture(t),lease=await acquireOfficeStageLock(f.target);
 try{
  await assert.rejects(acquireOfficeStageLock(f.target),{code:'OFFICE_RESOURCE_STAGE_BUSY'});
  const secondModule=await import(moduleUrl+'?owned-module-copy');
  await assert.rejects(secondModule.acquireOfficeStageLock(f.target),{code:'OFFICE_RESOURCE_STAGE_BUSY'});
  const worker=new Worker(`const {parentPort}=require('node:worker_threads');import(${JSON.stringify(moduleUrl)}).then(m=>m.acquireOfficeStageLock(${JSON.stringify(f.target)})).then(()=>parentPort.postMessage({code:'unexpected'}),error=>parentPort.postMessage({code:error.code}));`,{eval:true});
  try{assert.deepEqual((await once(worker,'message'))[0],{code:'OFFICE_RESOURCE_BUILD_REALM_UNAVAILABLE'});}finally{await worker.terminate();}
  const peer=await f.start();assert.equal(peer.message.code,'OFFICE_RESOURCE_STAGE_BUSY');await lease.assertCurrent();
 }finally{await lease.release();}
 const realmOwner=await f.start('vm');assert.deepEqual(realmOwner.message,{state:'vm-rejected',code:'OFFICE_RESOURCE_BUILD_REALM_UNAVAILABLE'});
 const peer=await f.start();assert.equal(peer.message.code,'OFFICE_RESOURCE_STAGE_BUSY');await f.stop(realmOwner);
});

test('release uncertainty remains sticky and never fabricates a subsequent successful release',async t=>{
 const f=await fixture(t),owner=await f.start('release-failure');assert.equal(owner.message.state,'held');
 const observation=once(owner.process,'message');owner.process.send('release');
 assert.deepEqual((await observation)[0],{state:'release-failed',codes:['OFFICE_RESOURCE_LOCK_RELEASE_UNCONFIRMED','OFFICE_RESOURCE_LOCK_RELEASE_UNCONFIRMED'],reacquire:'OFFICE_RESOURCE_LOCK_RELEASE_UNCONFIRMED'});
 const peer=await f.start();assert.equal(peer.message.code,'OFFICE_RESOURCE_STAGE_BUSY');
 await f.kill(owner);const recovered=await f.start();assert.equal(recovered.message.state,'held');await f.stop(recovered);
});

test('concurrent release callers join one confirmed cleanup',async t=>{
 const f=await fixture(t),lease=await acquireOfficeStageLock(f.target);
 await Promise.all([lease.release(),lease.release(),lease.release()]);
 const next=await f.start();assert.equal(next.message.state,'held');await f.stop(next);
});

test('an unidentified fd waits for all SQLite owners and drains before a fresh in-process acquisition',async t=>{
 const f=await fixture(t),other=join(f.root,'other'),otherDb=join(f.root,'.other.office-stage.v1','authority.sqlite');
 const lease=await acquireOfficeStageLock(f.target),original=fs.open;let closed=false,otherOpens=0,unblock,started;
 const pendingClose=new Promise(resolve=>{unblock=resolve;}),closeStarted=new Promise(resolve=>{started=resolve;});
 const mocked=t.mock.method(fs,'open',async(path,...args)=>{
  const handle=await original(path,...args);if(path!==otherDb)return handle;otherOpens++;
  return {stat:async()=>{throw Object.assign(Error('owned stat failure'),{code:'EIO'});},close:async()=>{started();await pendingClose;closed=true;await handle.close();}};
 });syncBuiltinESMExports();let releasing;
 try{
  await assert.rejects(acquireOfficeStageLock(other),{code:'EIO'});assert.equal(closed,false);
  releasing=lease.release();await closeStarted;
  await assert.rejects(acquireOfficeStageLock(other),{code:'OFFICE_RESOURCE_STAGE_BUSY'});assert.equal(otherOpens,1);
  unblock();await releasing;assert.equal(closed,true);
 }finally{unblock();await (releasing??lease.release());mocked.mock.restore();syncBuiltinESMExports();}
 const next=await acquireOfficeStageLock(other);await next.release();
});
