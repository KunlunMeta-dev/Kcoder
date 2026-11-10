import assert from 'node:assert/strict';
import { chmod,lstat,readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startApprovalModelFixture } from './approval-model.mjs';
import { nativeCodeFixture,pollNative,saveNativeCodeWorkflow,serviceRequest,sha256File,startNativeCodeManager,startNativeCodeUi } from './native-code-service.mjs';

async function originalRoots(fixture){
 const result=[];
 for(const path of [fixture.profile,fixture.workspace,join(fixture.profile,'workflow-library'),join(fixture.profile,'workflow-runs')]){
  const value=await lstat(path);assert.ok(value.isDirectory()&&!value.isSymbolicLink());assert.equal(value.uid,fixture.uid);assert.equal(value.mode&0o777,0o700);
  result.push({path,dev:String(value.dev),ino:String(value.ino),uid:value.uid,gid:value.gid,mode:value.mode&0o777});
 }
 return result;
}

/** Existing storage migration/rollback, with original Runtime/history left in place. */
export async function verifyNativeCodeStorageRecovery(context,binary){
 assert.equal(await sha256File(binary),process.env.KCODER_E2E_KCODER_BIN_SHA256,'The ordinary Native image must match its explicit pin');
 const scratch=await context.createOwnedScratchDirectory('rel-storage-native-owner',{baseDirectory:'/tmp',ownedWorkerTraversal:true,requireCleanupConfirmation:true});
 const fixture=await nativeCodeFixture(context,binary,{scratch});
 const model=await startApprovalModelFixture(context,{textOnly:true});
 const settings=JSON.parse(await readFile(fixture.settings,'utf8'));settings.providers['owned-code'].endpoint=model.baseUrl;
 await writeFile(fixture.settings,JSON.stringify(settings),{mode:0o600});
 const ui=await startNativeCodeUi(context,fixture,'storage-original-ui');
 const source=await saveNativeCodeWorkflow(ui,'OWNED_STORAGE_RECOVERY_RESULT',1);
 const manager=await startNativeCodeManager(context,fixture,'storage-original-manager');
 const prepared=await ui.rpc('integrations/services/code/prepare',serviceRequest(ui.scope,{purpose:'native_saved_code_service',explicitBackgroundConsent:true,expiresInMs:300000,codeWorkflow:source},{operationId:'storage-prepare-'+context.seed}));
 const startOperation='storage-start-'+context.seed;
 const started=await ui.rpc('integrations/services/code/start',serviceRequest(ui.scope,{leaseId:prepared.intent.leaseId},{operationId:startOperation,expectedRevision:prepared.revision}));
 assert.equal(started.ready.modelCalls,0);const owner=await manager.attach(prepared.intent.leaseId);assert.equal(owner.alive,true);
 const reference={threadId:started.ready.acceptance.threadId,taskId:started.ready.acceptance.taskId};
 await pollNative(async()=>{const value=await ui.rpc('integrations/runtime/readTaskState',{requestId:'storage-wait-original',scope:ui.scope,reference});assert.ok(!['failed','cancelled','outcome_unknown'].includes(value.state));return value.state==='completed'?value:null;},'the original pure Code result');
 const taskObservations=[];
 const observe=async client=>{
  const task=await client.rpc('integrations/runtime/readTaskState',{requestId:'storage-read-original',scope:client.scope,reference});
  taskObservations.push(task);
  const run=await client.rpc('workflow/runs/read',{runId:reference.taskId});
  const definition=await client.rpc('workflow/read',{id:source.definitionId});
  const operation=await client.rpc('integrations/operation/read',serviceRequest(client.scope,{operationId:startOperation}));
  const listed=await client.rpc('workflow/runs/list',{definitionId:source.definitionId,limit:32});
  assert.equal(task.state,'completed');assert.equal(run.status,'completed');assert.equal(listed.total,1);assert.equal(operation.status,'completed');
  // Observation clocks/envelopes are not the original persisted receipt.
  const {observedAtMs,...persistedTask}=task;
  return {task:persistedTask,run,definition,operation:operation.result.receipt};
 };
 const beforeStop=await observe(ui);await ui.close();const retired=await manager.close();
 assert.equal(retired.managerAlive,false);assert.ok(retired.workers.length===1&&retired.workers.every(worker=>!worker.alive));
 const roots=await originalRoots(fixture);
 const maintenance=await startNativeCodeUi(context,fixture,'storage-maintenance-ui');assert.deepEqual(maintenance.scope,ui.scope);
 // Freeze the CAS revision only after all original business writers exit.
 const original=await observe(maintenance);assert.ok(original.task.revision>=beforeStop.task.revision);
 assert.deepEqual(original.run,beforeStop.run);assert.deepEqual(original.definition,beforeStop.definition);assert.deepEqual(original.operation,beforeStop.operation);
 const before=await maintenance.rpc('workflow/storage/read');assert.equal(before.backend,'legacy_json');
 const unconfirmed=await maintenance.client.request('workflow/storage/migrate',{confirm:false});assert.ok(unconfirmed.error);
 assert.deepEqual(await maintenance.rpc('workflow/storage/read'),before);
 const migrated=await maintenance.rpc('workflow/storage/migrate',{confirm:true});assert.equal(migrated.backend,'immutable_objects');assert.ok(migrated.migrated);assert.match(migrated.legacyBackup,/^library\.pre-objects-[a-f0-9-]+\.json$/);
 const backup=join(fixture.profile,'workflow-library',migrated.legacyBackup),backupInfo=await lstat(backup),backupSha256=await sha256File(backup);
 assert.ok(backupInfo.isFile()&&!backupInfo.isSymbolicLink()&&backupInfo.nlink===1);assert.equal(backupInfo.uid,fixture.uid);assert.equal(backupInfo.mode&0o777,0o600);
 assert.deepEqual(await observe(maintenance),original);
 // Inject only a directory-mode fault after every original business worker exits.
 const library=join(fixture.profile,'workflow-library');let denied;
 await chmod(library,0o000);
 try{
  denied=await maintenance.client.request('workflow/storage/rollback',{confirm:true});assert.ok(denied.error,'Wrong private permissions must reject rollback');
  assert.equal((await lstat(library)).mode&0o777,0o000,'The actual denied directory must not be repaired by rollback');
 }finally{await chmod(library,0o700);}
 assert.equal((await maintenance.rpc('workflow/storage/read')).backend,'immutable_objects');
 assert.deepEqual(await observe(maintenance),original);assert.equal(await sha256File(backup),backupSha256);
 const rollback=await maintenance.rpc('workflow/storage/rollback',{confirm:true});assert.deepEqual(rollback,{backend:'legacy_json',rolledBack:true});
 assert.deepEqual(await observe(maintenance),original);assert.equal((await maintenance.rpc('workflow/storage/read')).backend,'legacy_json');
 await maintenance.close();
 const cold=await startNativeCodeUi(context,fixture,'storage-cold-read-ui');assert.deepEqual(cold.scope,ui.scope);assert.deepEqual(await observe(cold),original);
 const foreign=await cold.client.request('integrations/runtime/readTaskState',{requestId:'storage-foreign-owner',scope:{...cold.scope,accountId:'foreign-account-never-authority'},reference});assert.ok(foreign.error,'A caller-selected account cannot read the original task');
 assert.deepEqual(await observe(cold),original);assert.deepEqual(await originalRoots(fixture),roots);assert.equal(await sha256File(backup),backupSha256);assert.equal(model.requests.length,0);
 await cold.close();
 await context.writeArtifactJson('native-multistore-storage-recovery.json',{nativeSha256:fixture.imageSha256,uid:fixture.uid,source,reference,startOperation,beforeStop,original,taskObservations,owner,retired,roots,migrated,backupSha256,permissionDenied:{code:denied.error.code,message:denied.error.message},rollback,foreignOwnerDenied:true,originalRuntimeAndHistoryUnchanged:true,originalPrivateRootsUnchanged:true,originalBackupRetained:true,newRuns:0,modelRequests:model.requests.length,platformCalls:0,scope:'Existing workflow library backup/migration/rollback with original Native Runtime, service operation and workflow-run history preserved in the same profile. No whole-profile/Connectivity database restore, unknown-business receipt, final package or Windows claim.'});
 return {originalRuntimeAndHistoryUnchanged:true,actualWorkflowBackupAndRollback:true,failedRollbackPreservedOriginal:true,foreignOwnerDenied:true,privateRootsUnchanged:true,modelRequests:0,newRuns:0,finalPackage:false};
}
