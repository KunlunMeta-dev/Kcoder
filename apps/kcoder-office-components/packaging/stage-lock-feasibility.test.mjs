// Owned subprocess probes for build-only SQLite locking; no application database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile,writeFile,lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { stageOfficeResources } from './stage-resources.mjs';

const probe=`
import { DatabaseSync } from 'node:sqlite';
import { openSync,closeSync,readFileSync,statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const [path,mode]=process.argv.slice(1);let db,guard;
try{
 guard=openSync(path,'a+',0o600);db=new DatabaseSync(path);
 db.exec('PRAGMA busy_timeout=0;PRAGMA locking_mode=EXCLUSIVE;PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL');
 db.exec('BEGIN EXCLUSIVE;CREATE TABLE IF NOT EXISTS probe(nonce TEXT);DELETE FROM probe');
 const nonce=randomBytes(32).toString('hex');db.prepare('INSERT INTO probe VALUES(?)').run(nonce);
 if(mode==='uncommitted'){
  db.exec('PRAGMA cache_size=1');for(let i=0;i<8;i++)db.prepare('INSERT INTO probe VALUES(?)').run('x'.repeat(16000));
  process.send({state:'uncommitted',journalBytes:statSync(path+'-journal').size});
 }else{
  db.exec('COMMIT');
  const bytes=readFileSync(guard);if(!bytes.includes(Buffer.from(nonce)))throw Error('challenge failed');
  process.send({state:'held',mode:db.prepare('PRAGMA locking_mode').get().locking_mode});
 }
 process.on('message',()=>{try{db.close();}finally{closeSync(guard);}process.exit(0);});
}catch(error){try{db?.close();}finally{if(guard!==undefined)closeSync(guard);}process.send({state:'rejected',code:error.code,message:error.message});process.exitCode=0;}
`;

const ownedChildren=new WeakMap();
async function ownedRoot(t){
 const root=await mkdtemp(join(tmpdir(),'owned-office-lock-')),children=[];ownedChildren.set(t,children);
 t.after(async()=>{for(const entry of children){if(entry.process.exitCode===null&&entry.process.signalCode===null)entry.process.kill('SIGKILL');await entry.closed;}await rm(root,{recursive:true,force:true});});
 return root;
}
async function child(t,script,args){
 const processChild=spawn(process.execPath,['--input-type=module','-e',script,...args],{env:{LANG:'C.UTF-8'},stdio:['ignore','ignore','pipe','ipc']});
 processChild.stderr.resume();const closed=once(processChild,'close');
 ownedChildren.get(t).push({process:processChild,closed});
 let timer;
 const message=await Promise.race([once(processChild,'message').then(([value])=>value),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned lock probe timed out')),5000);})]).finally(()=>clearTimeout(timer));
 return {process:processChild,closed,message};
}

test('SQLite EXCLUSIVE mode retains a kernel peer lock across COMMIT and releases it on SIGKILL',async t=>{
 const root=await ownedRoot(t),path=join(root,'authority.sqlite');
 const first=await child(t,probe,[path,'held']);assert.deepEqual(first.message,{state:'held',mode:'exclusive'});
 const peer=await child(t,probe,[path,'held']);assert.equal(peer.message.state,'rejected');assert.match(peer.message.message,/locked/);
 first.process.kill('SIGKILL');await first.closed;
 const recovered=await child(t,probe,[path,'held']);assert.equal(recovered.message.state,'held');
 recovered.process.send('close');await recovered.closed;
});

test('SQLite rolls back an interrupted owned initialization transaction without unlinking its journal',async t=>{
 const root=await ownedRoot(t),path=join(root,'authority.sqlite');
 const original=await child(t,probe,[path,'held']);original.process.send('close');await original.closed;
 const writing=await child(t,probe,[path,'uncommitted']);assert.equal(writing.message.state,'uncommitted');assert.ok(writing.message.journalBytes>0);
 writing.process.kill('SIGKILL');await writing.closed;
 const recovered=await child(t,probe,[path,'held']);assert.equal(recovered.message.state,'held');recovered.process.send('close');await recovered.closed;
});

test('the original Office stager can recover after its owned lock holder is killed',async t=>{
 const root=await ownedRoot(t),destination=join(root,'office'),notice=join(root,'.office.office-stage.lock');
 const module=new URL('./stage-resources.mjs',import.meta.url).href;
 const script=`import {stageOfficeResources} from ${JSON.stringify(module)};await stageOfficeResources({destination:process.argv[1]}).catch(()=>{});`;
 const processChild=spawn(process.execPath,['--input-type=module','-e',script,destination],{env:{LANG:'C.UTF-8'},stdio:'ignore'});
 const closed=once(processChild,'close');ownedChildren.get(t).push({process:processChild,closed});
 const deadline=Date.now()+5000;
 while(!await lstat(notice).catch(error=>{if(error.code==='ENOENT')return null;throw error;})){if(Date.now()>deadline)throw Error('Owned stager did not publish a lock notice');await delay(5);}
 processChild.kill('SIGKILL');await closed;
 const receipt=await stageOfficeResources({destination});assert.equal(receipt.root,destination);
});
