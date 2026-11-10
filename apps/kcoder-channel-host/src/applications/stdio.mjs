import {pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
import {existsSync} from 'node:fs';
import {ConnectivityStore} from './store.mjs';
import {ApplicationService} from './service.mjs';
import {ChannelError,publicError,requireValue} from '../errors.mjs';
import {createStoreFiles} from './store-bootstrap.mjs';
import {connectivitySettings} from './settings.mjs';
import {installationFacts} from '../installation.mjs';
import {digest} from '../validation.mjs';
import {createReadinessVerifiers} from './readiness-probe.mjs';
import {recordApplicationStartupFailure} from './startup-diagnostics.mjs';
import {PrivateParentPeer} from './private-peer.mjs';
export {PrivateParentPeer};

export async function runApplicationHost({root,storeMode,initializationId,input=process.stdin,output=process.stdout}) {
 requireValue(typeof root==='string'&&root.length>0,'PRIVATE_STORE_ROOT_REQUIRED');
 requireValue(storeMode===undefined||['create','open_existing'].includes(storeMode),'STORE_MODE_INVALID');
 if(storeMode==='create')requireValue(typeof initializationId==='string'&&initializationId.length>0,'STORE_INITIALIZATION_ID_REQUIRED');
 for(const level of ['log','info','warn','error','debug'])console[level]=()=>process.stderr.write('APPLICATION_HOST_DIAGNOSTIC_'+level.toUpperCase()+'\n');
 const peer=new PrivateParentPeer(input,output,{controlMethods:['connectivity.installationFacts','connectivity.resolveApplicationResources','connectivity.resolveApplicationConfiguration']});
 const ports={call:(port,method,request)=>peer.call('private.integration.call',{port,method,request},request.timeoutMs)};
 let store,service,storeLease,leaseTimer,bootstrapStage='CONFIGURATION';
 const run=peer.run();run.catch(()=>{});
 try {
  const configuration=await peer.call('private.host.configuration',{});
  const settings=connectivitySettings(configuration);
  const privateRoot=resolve(root);
  storeLease=await peer.call('private.store.acquireLease',{path:privateRoot,pid:process.pid,storeMode:storeMode??null,initializationId:initializationId??null});
  requireValue(typeof storeLease?.leaseId==='string'&&typeof storeLease.namespaceId==='string'&&storeLease.namespaceId.length>0&&Number.isFinite(storeLease.expiresAt)&&storeLease.expiresAt>Date.now(),'NATIVE_STORE_LEASE_REQUIRED');
  const expectedNamespaceId=storeLease.namespaceId;
  requireValue(['create','open_existing'].includes(storeLease.storeMode)&&typeof storeLease.initializationId==='string'&&['initializing','reconciling'].includes(storeLease.stage),'NATIVE_BOOTSTRAP_STATE_REQUIRED');
  requireValue(storeMode===undefined||storeMode===storeLease.storeMode,'STORE_BOOTSTRAP_MODE_MISMATCH');
  storeMode=storeLease.storeMode;initializationId=storeLease.initializationId;
  const assertExclusiveLease=()=>!peer.closed&&storeLease.stage==='ready'&&storeLease.expiresAt>Date.now();
  const assertInitializationLease=()=>!peer.closed&&storeLease.stage==='initializing'&&storeLease.expiresAt>Date.now();
  leaseTimer=setInterval(()=>{peer.call('private.store.renewLease',{leaseId:storeLease.leaseId}).then(value=>{requireValue(value?.leaseId===storeLease.leaseId&&value.namespaceId===expectedNamespaceId&&value.expiresAt>Date.now(),'NATIVE_STORE_LEASE_REQUIRED');storeLease=value;}).catch(()=>{storeLease.expiresAt=0;});},10000);leaseTimer.unref?.();
  const windowsProofs=new Set(),nativeWindowsProof=path=>windowsProofs.has(resolve(path));
  const verifyWindows=async path=>{if(process.platform==='win32')requireValue((await peer.call('private.store.verify',{path:resolve(path)}))?.verified===true,'NATIVE_PRIVATE_DIRECTORY_REQUIRED');windowsProofs.add(resolve(path));};
  bootstrapStage='PRIVATE_ROOT';await verifyWindows(privateRoot);
  bootstrapStage='CREATE_STORE';
  if(storeMode==='create')createStoreFiles(privateRoot,{initializationId,namespaceId:expectedNamespaceId,nativeWindowsProof,assertExclusiveLease:assertInitializationLease,maxMetadataBytes:settings.maxMetadataBytes});
  bootstrapStage='VERIFY_FILES';
  for(const path of [privateRoot+'.binding.json',...['connectivity.sqlite3','connectivity.lock','connectivity.ready.json'].map(name=>join(privateRoot,name))])await verifyWindows(path);
  for(const suffix of ['-wal','-shm','-journal']){const path=join(privateRoot,'connectivity.sqlite3')+suffix;if(existsSync(path))await verifyWindows(path);}
  if(process.platform==='win32'){
   // The read-only SQLite open can itself create WAL coordination files. Only
   // the original Native initialization/reconciliation owner prepares them;
   // each real file then gets its own private handle proof before Node opens it.
   bootstrapStage='PREPARE_COORDINATION';
   requireValue((await peer.call('private.store.prepareSidecars',{leaseId:storeLease.leaseId}))?.prepared===true,'NATIVE_SQLITE_COORDINATION_UNCONFIRMED');
   for(const suffix of ['-wal','-shm'])await verifyWindows(join(privateRoot,'connectivity.sqlite3')+suffix);
  }
  bootstrapStage='OPEN_STORE';
  store=ConnectivityStore.open(privateRoot,{nativeWindowsProof,assertExclusiveLease,expectedNamespaceId,maxMetadataBytes:settings.maxMetadataBytes});
  // Reading the schema can lazily create SQLite's coordination files. Freeze
  // their actual native handles before the original creation commit seals them.
  for(const suffix of ['-wal','-shm','-journal']){const path=join(privateRoot,'connectivity.sqlite3')+suffix;if(existsSync(path))await verifyWindows(path);}
  bootstrapStage='COMMIT_READY';
  const ready=await peer.call('private.store.commitReady',{leaseId:storeLease.leaseId,namespaceId:expectedNamespaceId,initializationId,bindingHash:digest(store.storage.binding)});
  requireValue(ready?.leaseId===storeLease.leaseId&&ready.namespaceId===expectedNamespaceId&&ready.stage==='ready'&&ready.expiresAt>Date.now(),'NATIVE_STORE_READY_UNCONFIRMED');storeLease=ready;
  // SQLite may create volatile sidecars only when its first writer opens.
  // The native startup commit prepares private files first; this read-only
  // callback observes their original handles before recovery/business writes.
  for(const suffix of ['-wal','-shm','-journal']){const path=join(privateRoot,'connectivity.sqlite3')+suffix;if(existsSync(path))await verifyWindows(path);}

  bootstrapStage='SERVICE';
  const applications=Object.fromEntries(['read','listSources','setEnabled','authorize','cancelAuthorization','disconnect','listResources'].map(method=>[method,(scope,connection,...args)=>peer.call('private.applications.call',{scope,method,connection,args})]));
  service=new ApplicationService({store,ports,applications,settings,verifiers:createReadinessVerifiers((method,params)=>peer.call(method,params)),inventory:scope=>peer.call('private.connectivity.inventory',{scope})});
  peer.handler=async(method,params)=>{
   if(method==='connectivity.call')return service.call(params?.port,params?.method,params?.request);
   if(method==='connectivity.installationFacts')return installationFacts();
   if(method==='connectivity.resolveApplicationResources')return service.resolveApplicationResources(params.scope,params.connectionId,params.resourceRefs);
   if(method==='connectivity.resolveApplicationConfiguration')return service.resolveApplicationConfiguration(params.scope,params.connectionId);
   if(method==='connectivity.close'){await service.close();return {closed:true};}
   throw new ChannelError('METHOD_UNSUPPORTED');
  };
  bootstrapStage='READY';await peer.call('private.host.ready',{contractVersion:'parallel-v1',pid:process.pid});
  await run;
 } catch(error) {
  await recordApplicationStartupFailure(error,{stage:bootstrapStage});
  process.stderr.write('APPLICATION_BOOTSTRAP_'+bootstrapStage+'_FAILED\n');throw error;
 } finally {
  try {clearInterval(leaseTimer);await service?.close();store?.close();if(storeLease)await peer.call('private.store.releaseLease',{leaseId:storeLease.leaseId}).catch(()=>{});}
  finally {peer.close();await run.catch(()=>{});}
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const index=process.argv.indexOf('--root'),root=index>=0?process.argv[index+1]:null;
 const create=process.argv.includes('--create-store'),initializationIndex=process.argv.indexOf('--initialization-id'),initializationId=initializationIndex>=0?process.argv[initializationIndex+1]:undefined;
 runApplicationHost({root,storeMode:create?'create':undefined,initializationId}).catch(error=>{process.stderr.write(publicError(error).code+'\n');process.exitCode=1;});
}
