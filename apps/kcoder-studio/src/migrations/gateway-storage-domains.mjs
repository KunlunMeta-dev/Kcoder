import { lstat, realpath } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, toNamespacedPath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadGatewayRelayRuntime, readRelayPrivateText } from '../gateway-relay-instance.js';
import { verifyGatewayDeviceAuthRelocation, verifyGatewayDeviceAuthRelocationSource } from '../gateway-device-auth.js';
import { PRODUCT_ACCOUNT_COOKIE_SCOPE_FILE, prepareProductAccountCookieScopeSource,
  verifyProductAccountCookieScopeRelocation } from '../gateway-product-account.js';
import { resolveStorageRuntimeResources, storageChannelHostModuleUrl } from '../storage-runtime-resources.mjs';
import { runOfflineOwnerChild } from './offline-owner-child.mjs';

export { verifyGatewayDeviceAuthRelocation };

const failure=code=>Object.assign(Error(code),{code});
// libuv returns ordinary Disk/UNC paths from realpath on Windows even when the
// caller supplied an extended namespace. Preserve that namespace for I/O.
const canonicalMatches=(actual,expected)=>actual===expected||process.platform==='win32'&&toNamespacedPath(actual)===expected;
async function loadChannelHostModule(path){
  const applicationRoot=fileURLToPath(new URL('../..',import.meta.url));
  const resources=await resolveStorageRuntimeResources({moduleUrl:import.meta.url,applicationRoot});
  return import(storageChannelHostModuleUrl(resources.channelHostRoot,path));
}
function child(root,name){
  if(typeof name!=='string'||!name||isAbsolute(name)||name.includes('\0'))throw failure('GATEWAY_RELOCATION_INVALID_PATH');
  const path=resolve(root,name),local=relative(root,path);
  if(local==='..'||local.startsWith('..'+(process.platform==='win32'?'\\':'/'))||!local)throw failure('GATEWAY_RELOCATION_INVALID_PATH');
  return path;
}
async function canonicalParent(path){
  let parent=dirname(path);
  while(true){
    try{
      const info=await lstat(parent);
      if(!info.isDirectory()||info.isSymbolicLink()||!canonicalMatches(await realpath(parent),parent))throw failure('GATEWAY_RELOCATION_IDENTITY_CHANGED');
      return;
    }catch(error){if(error.code!=='ENOENT')throw error;}
    const previous=parent;parent=dirname(parent);if(previous===parent)throw failure('GATEWAY_RELOCATION_INVALID_PATH');
  }
}

/** Only the offline executor calls this port. Its persisted plan contains
 * paths/origin, never the Gateway secret. Identity preparation stays in Relay's
 * existing owner and deliberately performs no registration or network request. */
export async function prepareGatewayRelayStorage({source,finalTarget,operationId,validateOffline,relayUrl,
  sourceIdentityFile='relay/client-identity.json',targetIdentityFile=sourceIdentityFile,
  gatewaySecretFile='desktop-relay/gateway-secret',sharedIdentityFile,resourcesPath,loadRuntime,observeStorageEntry,phase='relocate'}={}){
  if(typeof source!=='string'||resolve(source)!==source||typeof finalTarget!=='string'||resolve(finalTarget)!==finalTarget||source===finalTarget||
    typeof operationId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)||typeof validateOffline!=='function'||
    !['prepareSource','relocate','verify'].includes(phase))throw failure('GATEWAY_RELOCATION_AUTHORITY_REQUIRED');
  const facts=Object.freeze({domain:'gateway-relay',source,finalTarget,operationId});
  if(await validateOffline(facts)===false)throw failure('GATEWAY_RELOCATION_AUTHORITY_REQUIRED');
  if(!canonicalMatches(await realpath(source),source)||phase!=='prepareSource'&&!canonicalMatches(await realpath(finalTarget),finalTarget))throw failure('GATEWAY_RELOCATION_IDENTITY_CHANGED');
  const originalIdentity=child(source,sourceIdentityFile),identityFile=child(finalTarget,targetIdentityFile),
    sourceSecret=child(source,gatewaySecretFile),targetSecret=child(finalTarget,gatewaySecretFile);
  const shared=sharedIdentityFile===undefined?{}:{sharedIdentityFile:child(finalTarget,sharedIdentityFile),
    sourceSharedIdentityFile:child(source,sharedIdentityFile)};
  await canonicalParent(originalIdentity);await canonicalParent(sourceSecret);
  const original=await readRelayPrivateText(sourceSecret);
  if(original===null)throw failure('GATEWAY_RELOCATION_SECRET_MISMATCH');
  if(phase!=='prepareSource'){
    await canonicalParent(identityFile);await canonicalParent(targetSecret);
    if(original!==await readRelayPrivateText(targetSecret))throw failure('GATEWAY_RELOCATION_SECRET_MISMATCH');
  }
  const runtime=await loadGatewayRelayRuntime(resourcesPath,loadRuntime);
  if(runtime.OFFLINE_IDENTITY_RELOCATION_VERSION!==1)throw failure('GATEWAY_RELOCATION_RUNTIME_UPDATE_REQUIRED');
  if(phase==='prepareSource'){
    const value=await runtime.prepareInstanceIdentityFile({identityFile:originalIdentity,relayUrl,gatewaySecret:original.trim(),
      relocation:{operationId,phase,validateOffline,observeMetadata:observeStorageEntry,...(sharedIdentityFile===undefined?{}:{sharedIdentityFile:shared.sourceSharedIdentityFile})}});
    if(await validateOffline(observeStorageEntry ? {...facts,sourceProof:{...facts,...value}} : facts)===false)throw failure('GATEWAY_RELOCATION_AUTHORITY_REQUIRED');
    if(await readRelayPrivateText(sourceSecret)!==original)throw failure('GATEWAY_RELOCATION_SECRET_MISMATCH');
    return {...facts,...value};
  }
  if(phase==='verify'){
    if(typeof runtime.verifyInstanceIdentityRelocation!=='function')throw failure('GATEWAY_RELOCATION_RUNTIME_UPDATE_REQUIRED');
    await runtime.verifyInstanceIdentityRelocation({identityFile,legacyIdentityFile:originalIdentity,relayUrl,gatewaySecret:original.trim(),operationId,validateOffline,...shared});
  }else await runtime.prepareInstanceIdentityFile({identityFile,legacyIdentityFile:originalIdentity,relayUrl,gatewaySecret:original.trim(),
    relocation:{operationId,phase,validateOffline,...shared}});
  if(await validateOffline(facts)===false)throw failure('GATEWAY_RELOCATION_AUTHORITY_REQUIRED');
  if(await readRelayPrivateText(sourceSecret)!==original||await readRelayPrivateText(targetSecret)!==original)throw failure('GATEWAY_RELOCATION_SECRET_MISMATCH');
  const state=await runtime.readClientIdentityState({identityFile});
  if(!state)throw failure('GATEWAY_RELOCATION_IDENTITY_MISSING');
  return {...facts,identityFile,...state};
}

const domains=Object.freeze({mobile:'gateway-device-pairing',channels:'gateway-channels',sealed:'native-application-store',relay:'gateway-relay',
  productAccountCookieScope:'gateway-product-account-cookie-scope'});
const fields=Object.freeze({
  mobile:[],channels:['sourceReadDirectory','targetReadDirectory'],sealed:['namespaceId','initializationId','maxMetadataBytes'],productAccountCookieScope:[],
  relay:['relayUrl','sourceIdentityFile','targetIdentityFile','gatewaySecretFile','sharedIdentityFile'],
});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const absolute=value=>typeof value==='string'&&isAbsolute(value)&&resolve(value)===value&&!value.includes('\0');
function entries(payload){
  if(!object(payload)||Object.keys(payload).some(key=>!['version','phase','domains'].includes(key))||payload.version!==1||
    !['prepareSource','relocate','verify'].includes(payload.phase)||
    !Array.isArray(payload.domains)||payload.domains.length>128)throw failure('GATEWAY_OFFLINE_PAYLOAD_INVALID');
  const seen=new Set();
  for(const entry of payload.domains){
    if(!object(entry)||!Object.hasOwn(domains,entry.kind)||Object.keys(entry).some(key=>!['kind','source','finalTarget',...fields[entry.kind]].includes(key))||
      !absolute(entry.source)||!absolute(entry.finalTarget)||entry.source===entry.finalTarget)throw failure('GATEWAY_OFFLINE_PAYLOAD_INVALID');
    const key=JSON.stringify([entry.kind,entry.source,entry.finalTarget,
      ...(entry.kind==='relay'?[entry.sourceIdentityFile??'relay/client-identity.json']:[])]);
    if(seen.has(key))throw failure('GATEWAY_OFFLINE_PAYLOAD_INVALID');seen.add(key);
    if(entry.kind==='channels'){
      for(const field of ['sourceReadDirectory','targetReadDirectory'])if(entry[field]!==undefined&&
        (!absolute(entry[field])||entry[field]===entry.source||entry[field]===entry.finalTarget))throw failure('GATEWAY_OFFLINE_PAYLOAD_INVALID');
      if(payload.phase==='prepareSource'&&entry.targetReadDirectory!==undefined||
        entry.sourceReadDirectory!==undefined&&entry.sourceReadDirectory===entry.targetReadDirectory)throw failure('GATEWAY_OFFLINE_PAYLOAD_INVALID');
    }
    if(entry.kind==='sealed'&&(![entry.namespaceId,entry.initializationId].every(value=>typeof value==='string'&&value.length>0&&value.length<=256)||
      entry.maxMetadataBytes!==undefined&&(!Number.isSafeInteger(entry.maxMetadataBytes)||entry.maxMetadataBytes<64*1024||entry.maxMetadataBytes>1024*1024*1024)))throw failure('GATEWAY_OFFLINE_PAYLOAD_INVALID');
    if(entry.kind==='relay'){
      let url;try{url=new URL(entry.relayUrl);}catch{throw failure('GATEWAY_OFFLINE_PAYLOAD_INVALID');}
      if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.origin!==entry.relayUrl)
        throw failure('GATEWAY_OFFLINE_PAYLOAD_INVALID');
      for(const field of ['sourceIdentityFile','targetIdentityFile','gatewaySecretFile','sharedIdentityFile'])if(entry[field]!==undefined)child(entry.source,entry[field]);
      if(entry.sharedIdentityFile!==undefined&&!payload.domains.slice(0,payload.domains.indexOf(entry)).some(canonical=>canonical.kind==='relay'&&
        canonical.source===entry.source&&canonical.finalTarget===entry.finalTarget&&canonical.relayUrl===entry.relayUrl&&canonical.sharedIdentityFile===undefined&&
        (canonical.sourceIdentityFile??'relay/client-identity.json')===entry.sharedIdentityFile))throw failure('GATEWAY_OFFLINE_PAYLOAD_INVALID');
    }
  }
  return payload.domains;
}
async function present(path){return lstat(path).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});}
async function existingDirectory(path){
  const info=await present(path);if(!info)return false;
  if(!info.isDirectory()||info.isSymbolicLink()||!canonicalMatches(await realpath(path),path))throw failure('GATEWAY_OFFLINE_STORAGE_UNSAFE');
  return true;
}
async function hasOwnerData(entry,root){
  if(entry.kind==='productAccountCookieScope'){
    if(!await existingDirectory(root))return false;
    if(root===entry.source)return true;
    const record=await present(join(root,PRODUCT_ACCOUNT_COOKIE_SCOPE_FILE));
    return Boolean(record);
  }
  if(entry.kind==='relay'){
    const name=root===entry.source?(entry.sourceIdentityFile??'relay/client-identity.json'):
      (entry.targetIdentityFile??entry.sourceIdentityFile??'relay/client-identity.json');
    const file=child(root,name);
    await canonicalParent(file);
    return Boolean(await present(file)||await present(file+'.state-v2'));
  }
  const directory=entry.kind==='mobile'?join(root,'mobile-device-auth'):root;
  const bound=entry.kind==='sealed'?await present(directory+'.binding.json'):null;
  if(!await existingDirectory(directory)){
    if(bound)throw failure('GATEWAY_OFFLINE_STORE_INCOMPLETE');
    return false;
  }
  const names=entry.kind==='mobile'?['devices.json','.key']:entry.kind==='channels'?['channels.sqlite3']:
    ['connectivity.sqlite3','connectivity.lock','connectivity.ready.json'];
  const found=await Promise.all(names.map(name=>present(join(directory,name))));
  if(!found.some(Boolean)&&!bound)return false;
  if(found.some(value=>!value)||entry.kind==='sealed'&&!bound)throw failure('GATEWAY_OFFLINE_STORE_INCOMPLETE');
  return true;
}

/** Dispatch contains no stop verdict. Every owner callback synchronously asks
 * the live parent again; sealed leases require the parent's original Native
 * relocation object in addition to the instance fence. */
export async function dispatchGatewayStorageDomains(payload,context){
  const selected=entries(payload);
  if(!context||typeof context.operationId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(context.operationId)||typeof context.validateOffline!=='function')
    throw failure('GATEWAY_RELOCATION_AUTHORITY_REQUIRED');
  const {operationId}=context,result=[];
  const fresh=facts=>{
    if(context.validateOffline(facts)!==true)throw failure('STORAGE_OFFLINE_PARENT_REJECTED');
    return true;
  };
  for(const entry of selected){
    const facts=Object.freeze({domain:domains[entry.kind],operationId,source:entry.source,finalTarget:entry.finalTarget});
    fresh(facts);
    const sourcePresent=await hasOwnerData(entry,entry.source),targetPresent=payload.phase!=='prepareSource'?await hasOwnerData(entry,entry.finalTarget):false;
    fresh(facts);
    if(!sourcePresent){
      if(targetPresent)throw failure('GATEWAY_OFFLINE_SOURCE_MISSING');
      result.push({kind:entry.kind,source:entry.source,finalTarget:entry.finalTarget,state:'absent'});continue;
    }
    if(payload.phase==='prepareSource'){
      let value;
      if(entry.kind==='relay')value=await prepareGatewayRelayStorage({...entry,operationId,validateOffline:fresh,observeStorageEntry:context.observeStorageEntry,phase:payload.phase});
      else if(entry.kind==='productAccountCookieScope')value=await prepareProductAccountCookieScopeSource({...facts,validateOffline:fresh});
      else if(entry.kind==='mobile')await verifyGatewayDeviceAuthRelocationSource({...facts,validateOffline:fresh});
      else if(entry.kind==='channels'){
        const {verifyChannelStoreRelocationSource}=await loadChannelHostModule('channels/store-relocation.mjs');
        fresh(facts);verifyChannelStoreRelocationSource({...facts,sourceReadDirectory:entry.sourceReadDirectory,validateOffline:fresh});
      }
      else if(entry.kind==='sealed'){
        const sourceFacts=Object.freeze({...facts,purpose:'nativeStoreSource',namespaceId:entry.namespaceId,initializationId:entry.initializationId});
        try{fresh(sourceFacts);}catch(error){
          if(error.code==='STORAGE_OFFLINE_PARENT_REJECTED')throw failure('CONNECTIVITY_RELOCATION_SOURCE_PROOF_REQUIRED');throw error;
        }
        const {openStoreFiles}=await loadChannelHostModule('applications/store-bootstrap.mjs');
        const nativeWindowsProof=path=>fresh({...sourceFacts,purpose:'nativeStorePrivatePath',path});
        const store=openStoreFiles(entry.source,{expectedNamespaceId:entry.namespaceId,maxMetadataBytes:entry.maxMetadataBytes,nativeWindowsProof});
        try{
          if(store.binding.initializationId!==entry.initializationId)throw failure('STORE_RELOCATION_INITIALIZATION_MISMATCH');
          store.verify();fresh(sourceFacts);
          value={namespaceId:store.binding.namespaceId,initializationId:store.binding.initializationId};
        }finally{store.close();}
      }
      fresh(facts);
      result.push({kind:entry.kind,source:entry.source,finalTarget:entry.finalTarget,state:value?'prepared':'observed',...(value?{value}:{})});continue;
    }
    if(entry.kind!=='relay'&&!targetPresent)throw failure('GATEWAY_OFFLINE_STORE_INCOMPLETE');
    let value;
    if(entry.kind==='mobile')value=await verifyGatewayDeviceAuthRelocation({...facts,identity:null,validateOffline:fresh});
    else if(entry.kind==='channels'){
      const {verifyChannelStoreRelocation}=await loadChannelHostModule('channels/store-relocation.mjs');
      fresh(facts);value=verifyChannelStoreRelocation({...facts,sourceReadDirectory:entry.sourceReadDirectory,
        targetReadDirectory:entry.targetReadDirectory,validateOffline:fresh});
    }else if(entry.kind==='sealed'){
      const {relocateStoreFiles,verifyStoreRelocation}=await loadChannelHostModule('applications/store-bootstrap.mjs');
      const leaseFacts=Object.freeze({...facts,purpose:'nativeStoreLease',namespaceId:entry.namespaceId,initializationId:entry.initializationId});
      fresh(leaseFacts);
      const nativeWindowsProof=path=>fresh({...leaseFacts,purpose:'nativeStorePrivatePath',path});
      value=(payload.phase==='verify'?verifyStoreRelocation:relocateStoreFiles)({...facts,expectedNamespaceId:entry.namespaceId,expectedInitializationId:entry.initializationId,
        maxMetadataBytes:entry.maxMetadataBytes,validateOffline:fresh,assertExclusiveLease:()=>fresh(leaseFacts),nativeWindowsProof});
    }else if(entry.kind==='productAccountCookieScope'){
      value=await verifyProductAccountCookieScopeRelocation({...facts,validateOffline:fresh});
    }else value=await prepareGatewayRelayStorage({...entry,operationId,validateOffline:fresh,phase:payload.phase});
    fresh(facts);
    result.push({kind:entry.kind,source:entry.source,finalTarget:entry.finalTarget,state:'prepared',value});
  }
  return {version:1,phase:payload.phase,operationId,domains:result};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    if(process.argv.length!==2)throw failure('GATEWAY_OFFLINE_PAYLOAD_INVALID');
    await runOfflineOwnerChild({run:dispatchGatewayStorageDomains});
    process.exit(0);
  }catch(error){
    const code=typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{0,95}$/.test(error.code)?error.code:'GATEWAY_OFFLINE_OWNER_FAILED';
    writeSync(2,code+'\n');process.exit(1);
  }
}
