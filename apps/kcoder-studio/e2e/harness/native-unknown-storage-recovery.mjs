import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chown,chmod,lstat,readFile,readdir,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applicationFixture,startApplicationGateway } from './application-service.mjs';
import { saveNativeCodeWorkflow,sha256File } from './native-code-service.mjs';
import { startOAuthMcpFixture } from './oauth-mcp.mjs';
import { requireExecutable } from './run-context.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
async function roots(fixture){
 const result=[];
 for(const name of ['','workflow-library','mcp-oauth']){
  const path=join(fixture.profile,name),value=await lstat(path);assert.ok(value.isDirectory()&&!value.isSymbolicLink());assert.equal(value.uid,fixture.uid);assert.equal(value.mode&0o777,0o700);
  result.push({name,dev:String(value.dev),ino:String(value.ino),uid:value.uid,gid:value.gid,mode:value.mode&0o777});
 }
 return result;
}

/** Original native provider Unknown survives the supported workflow storage boundary. */
export async function verifyNativeUnknownStorageRecovery(context){
 const binary=await requireExecutable(process.env.KCODER_E2E_KCODER_BIN,'pinned ordinary Native for original Unknown storage recovery');
 assert.equal(await sha256File(binary),process.env.KCODER_E2E_KCODER_BIN_SHA256);
 const server={name:'owned_storage_unknown',pluginId:null},requestId='storage-unknown-'+context.seed,preResponse=[];let current;
 const issuer=await startOAuthMcpFixture(context,{manualApproval:true,resourceScopes:['probe:read'],accountSubjects:['U'],providerRevocation:{},beforeRevocationResponse:async()=>{
  const receipt=await current.rpc('mcp/providerRevocation',{action:'read',requestId,server});assert.equal(receipt.phase,'unknown');preResponse.push(receipt);
 }});
 const fixture=await applicationFixture(context,binary);
 const settings=JSON.parse(await readFile(fixture.settings,'utf8'));settings.mcp_servers=[{name:server.name,transport:'http',url:issuer.root+'/mcp',policy:{oauth_account:'storage_u'}}];
 await writeFile(fixture.settings,JSON.stringify(settings),{mode:0o600});const trusted=join(fixture.profile,'trusted-folders.json');await writeFile(trusted,JSON.stringify({trusted:[fixture.workspace],never:[]}),{mode:0o600});if(process.getuid()===0)await chown(trusted,fixture.uid,fixture.gid);
 const originalLabel='unknown-storage-original-owner';current=await startApplicationGateway(context,fixture,originalLabel);
 assert.equal(current.initialized.capabilities.experimental.mcpProviderRevocationV1,true,'The original Native provider operation must be wired and negotiated before any authorization');
 const source=await saveNativeCodeWorkflow(current,'OWNED_UNKNOWN_STORAGE_DEFINITION',1),definition=await current.rpc('workflow/read',{id:source.definitionId});
 assert.equal((await current.rpc('mcp/list',{})).servers.find(value=>value.name===server.name).authorization,'notAuthorized');
 const login=await current.rpc('gateway/mcp/login',{server});context.registerSecret(login.authorizationUrl);
 const approve=new URL(login.authorizationUrl);approve.pathname='/approve';approve.searchParams.set('subject','U');context.registerSecret(approve.href);
 await(await fetch(approve)).text();
 // The public MCP list is the original authorization receipt, with no model turn.
 const deadline=Date.now()+15000;let authorized=false;
 while(Date.now()<deadline){if((await current.rpc('mcp/list',{})).servers.find(value=>value.name===server.name)?.authorization==='authorized'){authorized=true;break;}await new Promise(resolve=>setTimeout(resolve,50));}
 assert.equal(authorized,true,'The owned issuer must complete the original Native OAuth flow');
 issuer.setProviderRevocationMode('U','lost-ack');
 const prepared=await current.rpc('mcp/providerRevocation',{action:'prepare',requestId,server});assert.equal(prepared.phase,'prepared');assert.ok(prepared.intentRef);
 const unknown=await current.rpc('mcp/providerRevocation',{action:'commit',requestId,server,intentRef:prepared.intentRef});assert.equal(unknown.phase,'unknown');assert.equal(unknown.reason,'outcomeUnconfirmed');assert.deepEqual(unknown.intentRef,prepared.intentRef);assert.equal(preResponse.length,1);
 assert.equal(issuer.providerRevocations.length,1);assert.equal(issuer.providerRevocations[0].effectApplied,true,'The provider effect occurred before its response transport was lost');
 const recordName='provider-revoke-'+digest(requestId)+'.json',record=join(fixture.profile,'mcp-oauth',recordName),recordInfo=await lstat(record),recordSha256=await sha256File(record);
 assert.ok(recordInfo.isFile()&&!recordInfo.isSymbolicLink()&&recordInfo.nlink===1);assert.equal(recordInfo.uid,fixture.uid);assert.equal(recordInfo.mode&0o777,0o600);
 await context.writeArtifactJson('original-native-authoritative-unknown.json',{requestId,prepared,unknown,preResponse,providerEffects:issuer.providerRevocations,recordSha256,modelRequests:fixture.modelRequests()});
 const originalRoots=await roots(fixture);await current.close();assert.equal(context.processes.get(originalLabel).stopped,true,'All original Gateway/Native process-group owners must exit before maintenance');
 const originalOwner={label:originalLabel,stopped:true,processGroup:context.processes.get(originalLabel).identity.pgid};
 current=await startApplicationGateway(context,fixture,'unknown-storage-maintenance');
 const reads=[];const observe=async()=>{
  const receipt=await current.rpc('mcp/providerRevocation',{action:'read',requestId,server});assert.deepEqual(receipt,unknown);reads.push(receipt);
  assert.equal(await sha256File(record),recordSha256);assert.deepEqual(await current.rpc('workflow/read',{id:source.definitionId}),definition);
  assert.deepEqual((await readdir(join(fixture.profile,'mcp-oauth'))).filter(name=>/^provider-revoke-[a-f0-9]{64}\.json$/.test(name)),[recordName]);
  assert.equal(issuer.providerRevocations.length,1);assert.equal(fixture.modelRequests(),0);return receipt;
 };
 await observe();const migrated=await current.rpc('workflow/storage/migrate',{confirm:true});assert.equal(migrated.backend,'immutable_objects');assert.ok(migrated.migrated);await observe();
 const backup=join(fixture.profile,'workflow-library',migrated.legacyBackup),backupSha256=await sha256File(backup),library=join(fixture.profile,'workflow-library');let denied;
 await chmod(library,0o000);
 try{await assert.rejects(current.rpc('workflow/storage/rollback',{confirm:true}),/workflow_storage: cannot open private library directory/);denied={code:'WORKFLOW_PRIVATE_DIRECTORY_DENIED'};assert.equal((await lstat(library)).mode&0o777,0o000);}finally{await chmod(library,0o700);}
 assert.equal((await current.rpc('workflow/storage/read')).backend,'immutable_objects');await observe();
 const rollback=await current.rpc('workflow/storage/rollback',{confirm:true});assert.deepEqual(rollback,{backend:'legacy_json',rolledBack:true});await observe();await current.close();
 current=await startApplicationGateway(context,fixture,'unknown-storage-cold-reader');await observe();assert.deepEqual(await roots(fixture),originalRoots);assert.equal(await sha256File(backup),backupSha256);assert.equal((await current.rpc('thread/list',{limit:10})).threads.length,0);
 const afterRecord=await lstat(record);assert.deepEqual([afterRecord.dev,afterRecord.ino,afterRecord.uid,afterRecord.gid,afterRecord.mode&0o777],[recordInfo.dev,recordInfo.ino,recordInfo.uid,recordInfo.gid,0o600]);assert.deepEqual(issuer.fixtureErrors,[]);await current.close();
 await context.writeArtifactJson('native-authoritative-unknown-storage-recovery.json',{nativeSha256:fixture.imageSha256,uid:fixture.uid,source,definition,requestId,prepared,unknown,preResponse,reads,providerEffects:issuer.providerRevocations,providerPosts:issuer.providerRevocations.length,originalOwner,originalRoots,recordSha256,protectedReceiptInodeUidModeUnchanged:true,migrated,denied,rollback,backupSha256,modelRequests:fixture.modelRequests(),newThreads:0,newProviderOperations:0,externalVendorCalls:0,scope:'Real provider effect and lost HTTP response produce the original Native authoritative Unknown. Existing workflow backup/migration/failure/rollback preserves it in the same profile; not a copied Connectivity database or final-package claim.'});
 return {authoritativeUnknownPreserved:true,originalProviderPosts:1,providerEffectApplied:true,originalIntentRevisionPreserved:true,protectedReceiptBytesAndIdentityPreserved:true,noNewOperationOrSend:true,modelRequests:0,newThreads:0,finalPackage:false};
}
