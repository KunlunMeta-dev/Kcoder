// Test-only SELECT projection of this run's existing logical resource leases.
import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
assert.ok(['linux','darwin'].includes(process.platform));
const [profile,rawScope,rawTurn]=process.argv.slice(2),scope=JSON.parse(rawScope),uid=process.getuid();
assert.ok(uid>0&&profile.startsWith('/'));
const hash=value=>createHash('sha256').update(value).digest('hex');
const owner={accountId:scope.accountId,targetId:scope.targetId,workspaceId:scope.workspaceId,organizationId:scope.organizationId??null};
const namespace='integration-'+hash(JSON.stringify(['native-domain-v1',owner,'connectivity']));
const directory=resolve(profile,namespace,'data'),path=resolve(directory,'connectivity.sqlite3');
for(const name of [profile,resolve(profile,namespace),directory]){const info=await lstat(name);assert.ok(info.isDirectory()&&!info.isSymbolicLink()&&info.uid===uid&&(info.mode&0o777)===0o700);}
const original=await lstat(path,{bigint:true});assert.ok(original.isFile()&&!original.isSymbolicLink()&&original.uid===BigInt(uid)&&original.nlink===1n&&(original.mode&0o777n)===0o600n);
for(const suffix of ['-wal','-shm']){try{const info=await lstat(path+suffix);assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.uid===uid&&info.nlink===1);}catch(error){if(error.code!=='ENOENT')throw error;}}
const url=pathToFileURL(path);url.searchParams.set('mode','ro');const db=new DatabaseSync(url.href,{readOnly:true});
let result;try{
 db.exec('PRAGMA query_only=ON');
 const query=rawTurn?JSON.parse(rawTurn):null;
 if(query?.kind==='taskFlow'){
  assert.match(query.connectionId,/^[a-zA-Z0-9_-]{1,128}$/);
  const rows=db.prepare('SELECT id,native_id,state,result_json FROM inbox WHERE channel_id=? ORDER BY received_at DESC LIMIT 8').all(query.connectionId);
  const safe=value=>{
   if(!value||typeof value!=='object')return {};
   return Object.fromEntries(Object.entries(value).flatMap(([key,entry])=>
    ['reasonCode','code','state','status','phase','threadId','turnId'].includes(key)&&typeof entry==='string'&&/^[a-zA-Z0-9_.:-]{1,128}$/.test(entry)
     ?[[key,entry]]:entry&&typeof entry==='object'&&!Array.isArray(entry)?[[key,safe(entry)]]:[]));
  };
  result={readOnly:true,inbox:rows.map(row=>({id:row.id,nativeOperationId:row.native_id,state:row.state,result:safe(row.result_json?JSON.parse(row.result_json):null)}))};
 }else if(query?.kind==='unboundInput'){
  const {connectionId}=query;
  assert.match(connectionId,/^[a-zA-Z0-9_-]{1,128}$/);
  const rows=db.prepare(`SELECT id,state,json_extract(result_json,'$.threadId') AS thread_id
    FROM inbox WHERE channel_id=? AND json_extract(event_json,'$.sourceMessageId')=? LIMIT 2`)
    .all(connectionId,`bound-message-${connectionId}-warm`);
  assert.equal(rows.length,1,'Expected one durable input after unbind');
  const [input]=rows;
  const resultDeliveries=db.prepare(`SELECT COUNT(*) AS total FROM outbox
    WHERE json_extract(payload_json,'$.channelPublication.ingressId')=?
    AND json_extract(payload_json,'$.channelPublication.phase')='terminal'`).get(input.id).total;
  const clientMirrors=db.prepare(`SELECT COUNT(*) AS total FROM outbox
    WHERE json_extract(payload_json,'$.destination.channelId')=? AND
    json_type(payload_json,'$.taskPublication')='object'`).get(connectionId).total;
  result={readOnly:true,state:input.state,hasTask:input.thread_id!=null,resultDeliveries,clientMirrors};
 }else if(query){
  const {connectionId,threadId,turnId}=query;
  for(const value of [connectionId,threadId,turnId])assert.match(value,/^[a-zA-Z0-9_-]{1,128}$/);
  const rows=db.prepare(`SELECT id,native_id,received_at,json_extract(event_json,'$.occurredAtMs') AS fixture_ingress_at
    FROM inbox WHERE channel_id=? AND state='completed' AND json_extract(result_json,'$.threadId')=?
    AND json_extract(result_json,'$.turnId')=? LIMIT 2`).all(connectionId,threadId,turnId);
  assert.equal(rows.length,1,'Expected one original completed input');
  const [input]=rows;
  assert.match(input.id,/^ingress_[0-9a-f]{64}$/);
  assert.match(input.native_id,/^native_[0-9a-f]{64}$/);
  const deliveries=db.prepare(`SELECT id,created_at FROM outbox WHERE state='accepted' AND
    json_extract(payload_json,'$.channelPublication.ingressId')=? AND
    json_extract(payload_json,'$.channelPublication.phase')='terminal' LIMIT 2`).all(input.id);
  assert.equal(deliveries.length,1,'Expected one original terminal delivery');
  const [delivery]=deliveries;
  assert.match(delivery.id,/^delivery_[0-9a-f]{64}$/);
  result={readOnly:true,fixtureIngressAtMs:input.fixture_ingress_at,inboxAtMs:input.received_at,
    outboxAtMs:delivery.created_at,deliveryId:delivery.id,ingressId:input.id,nativeOperationId:input.native_id};
 }else{
 const rows=db.prepare('SELECT resource,owner,generation,expires_at FROM leases ORDER BY resource LIMIT 65').all();assert.ok(rows.length<=64);
 const observedNowMs=Date.now();result={observedNowMs,readOnly:true,logicalRows:rows.map(row=>{
  assert.ok(typeof row.resource==='string'&&typeof row.owner==='string'&&Number.isSafeInteger(row.generation)&&Number.isSafeInteger(row.expires_at));
  return{resourceHash:hash(row.resource),ownerHash:hash(row.owner),generation:row.generation,expiresAtMs:row.expires_at,unexpiredAtObservation:row.expires_at>observedNowMs};
 })};
 }
}finally{db.close();}
const current=await lstat(path,{bigint:true});assert.equal(current.dev,original.dev);assert.equal(current.ino,original.ino);assert.equal(current.uid,original.uid);
process.stdout.write(JSON.stringify(result)+'\n');
