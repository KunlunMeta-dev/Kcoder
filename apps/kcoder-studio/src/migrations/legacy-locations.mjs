import { constants, writeSync } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { posix, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BoundedJsonlDecoder } from '../bounded-jsonl-decoder.js';
import { loadStorageContext, resolveStoragePaths } from '../storage-paths.mjs';
import namespaces from './legacy-owner-namespaces.json' with { type: 'json' };

export const LEGACY_SOURCE_MANIFEST_VERSION=1;
const MAX_ROOTS=32,MAX_ENTRIES=2048;
const failure=code=>Object.assign(Error(code),{code});
const pathsFor=platform=>platform==='win32'?win32:posix;
const pathKey=(value,platform)=>platform==='win32'?value.toLowerCase():value;
const identity=info=>JSON.stringify({dev:String(info.dev),ino:String(info.ino)});

// Node and Native share routing rules for known names. Other ordinary entries
// stay with their source role; the declaration is not a filename allowlist.
const namespaceLists=['gatewayFiles','gatewayDirectories','desktopFiles','desktopDirectories','controls','desktopControls'];
const leaf=value=>typeof value==='string'&&value.length>0&&value.length<=255&&!/[\\/\0\r\n]/.test(value)&&value!=='.'&&value!=='..';
if(!namespaces||typeof namespaces!=='object'||Array.isArray(namespaces)||namespaces.version!==1||
  Object.keys(namespaces).length!==namespaceLists.length+3||
  !namespaceLists.every(key=>Array.isArray(namespaces[key])&&namespaces[key].length>0&&namespaces[key].length<=64&&
    namespaces[key].every(leaf)&&new Set(namespaces[key]).size===namespaces[key].length)||
  typeof namespaces.partition!=='string'||namespaces.partition.split('/').length!==2||!namespaces.partition.split('/').every(leaf)||
  typeof namespaces.gatewayBackupPattern!=='string'||namespaces.gatewayBackupPattern.length>256||
  !namespaces.gatewayBackupPattern.startsWith('^')||!namespaces.gatewayBackupPattern.endsWith('$'))
  throw failure('LEGACY_OWNER_NAMESPACES_INVALID');
let gatewayBackupPattern;try{gatewayBackupPattern=new RegExp(namespaces.gatewayBackupPattern);}
catch{throw failure('LEGACY_OWNER_NAMESPACES_INVALID');}
// settings.json here belongs to Studio, never to the Native settings owner.
const gatewayFiles=new Set(namespaces.gatewayFiles),gatewayDirectories=new Set(namespaces.gatewayDirectories);
const desktopFiles=new Set(namespaces.desktopFiles),desktopDirectories=new Set(namespaces.desktopDirectories);
const controls=new Set(namespaces.controls),desktopControls=new Set(namespaces.desktopControls);
const desktopPartition=namespaces.partition,partitionContainer=desktopPartition.split('/')[0];
const PREVIEW_ENTRY='--kcoder-storage-legacy-preview-v1',REQUEST_LIMIT=1024,RESPONSE_LIMIT=1024*1024;

function observationPhase(phase){
  if(!['preview','stopped'].includes(phase))throw failure('LEGACY_OBSERVATION_PHASE_INVALID');
}

function selectedFacts(selected,platform){
  if(!selected?.context||selected.context.version!==1||!selected.paths)throw failure('LEGACY_SELECTION_INVALID');
  const context=selected.context,resolved=resolveStoragePaths({...context,env:context.overrides,platform});
  for(const name of ['dataRoot','gatewayRoot','desktopRoot','layout','externallyConfigured'])
    if(selected.paths[name]!==resolved[name])throw failure('LEGACY_SELECTION_CHANGED');
  return {context,paths:resolved};
}
function baseManifest(paths){return {version:1,state:paths.externallyConfigured?'externalInstance':paths.layout==='unified'?'alreadyUnified':'ready',
  nativeInPlace:{path:paths.dataRoot,identity:null,exists:null,disposition:'retain'},sources:[],blockers:[]};}
function absolute(value,paths){
  if(typeof value!=='string'||!paths.isAbsolute(value)||paths.normalize(value)!==value||/[\0\r\n]/.test(value))throw failure('LEGACY_SOURCE_PATH_INVALID');
  return value;
}
function candidates(context,paths,registeredSources,platform){
  if(!Array.isArray(registeredSources)||registeredSources.length>MAX_ROOTS)throw failure('LEGACY_REGISTRATION_INVALID');
  const p=pathsFor(platform),declared=[
    {path:p.join(context.home,'.config','kcoder-studio'),roles:['gateway']},
    {path:paths.desktopRoot,roles:['gateway','desktop']},
  ];
  for(const source of registeredSources){
    if(!source||Object.keys(source).some(key=>!['path','roles','registrationId'].includes(key))||
      typeof source.registrationId!=='string'||!source.registrationId||source.registrationId.length>256||/[\0\r\n]/.test(source.registrationId)||
      !Array.isArray(source.roles)||!source.roles.length||source.roles.some(role=>!['gateway','desktop'].includes(role))||new Set(source.roles).size!==source.roles.length)
      throw failure('LEGACY_REGISTRATION_INVALID');
    declared.push({...source,path:absolute(source.path,p)});
  }
  return declared;
}
function normalizedEntries(entries){
  if(!Array.isArray(entries)||entries.length>MAX_ENTRIES)throw failure('LEGACY_MANIFEST_INVALID');
  const seen=new Set();
  for(const entry of entries){
    const value=entry?.relativePath;
    if(typeof value!=='string'||!value||/[\\\0\r\n]/.test(value)||value.startsWith('/')||value.split('/').some(part=>!part||part==='.'||part==='..')||
      !['file','directory','symlink','other'].includes(entry.kind)||seen.has(value))throw failure('LEGACY_MANIFEST_INVALID');
    seen.add(value);
  }
  return [...entries].sort((a,b)=>a.relativePath.split('/').length-b.relativePath.split('/').length||a.relativePath.localeCompare(b.relativePath));
}
function ownerOf(relativePath,platform){
  const canonical=value=>pathKey(value,platform),top=relativePath.split('/')[0],key=canonical(top);
  const includes=(set,value)=>[...set].some(name=>canonical(name)===value);
  if(relativePath===top){
    if(includes(controls,key))return {owner:'storage-control',expected:'file',disposition:'retainControl',recursive:false};
    if(includes(gatewayFiles,key)||gatewayBackupPattern.test(top))return {owner:'gateway',expected:'file'};
    if(includes(gatewayDirectories,key))return {owner:'gateway',expected:'directory',recursive:true};
    if(includes(desktopFiles,key))return {owner:'desktop',expected:'file'};
    if(includes(desktopDirectories,key))return {owner:'desktop',expected:'directory',recursive:true};
    if(key===canonical(partitionContainer))return {owner:'desktop',expected:'directory',disposition:'container',recursive:false};
  }
  if(canonical(relativePath)===canonical(desktopPartition))return {owner:'desktop',expected:'directory',recursive:true};
  // Descendants are routed only through an already-recognized namespace root.
  // A known filename below an unknown directory is not a new ownership claim.
  return null;
}

/** Pure preview classification. Identity strings are observations, not grants;
 * the stopped executor must reopen and verify the actual source inventory. */
export function classifyLegacyStorageEntries({selected,registeredSources=[],roots=[],platform=process.platform,phase='stopped'}={}){
  observationPhase(phase);
  const {context,paths}=selectedFacts(selected,platform),manifest=baseManifest(paths);
  if(manifest.state!=='ready')return manifest;
  if(!Array.isArray(roots)||roots.length>MAX_ROOTS+5)throw failure('LEGACY_MANIFEST_INVALID');
  const p=pathsFor(platform),declared=candidates(context,paths,registeredSources,platform),byPath=new Map();
  for(const candidate of declared){
    const previous=byPath.get(candidate.path)??{path:candidate.path,roles:[],registrationIds:[]};
    previous.roles=[...new Set([...previous.roles,...candidate.roles])].sort();
    if(candidate.registrationId)previous.registrationIds.push(candidate.registrationId);
    byPath.set(candidate.path,previous);
  }
  const destinations={gateway:p.join(paths.dataRoot,'studio','gateway'),desktop:p.join(paths.dataRoot,'studio','desktop')};
  const allowedPaths=new Set([...byPath.keys(),paths.dataRoot,...Object.values(destinations)]);
  const native=roots.find(root=>root?.path===paths.dataRoot||Array.isArray(root?.aliases)&&root.aliases.includes(paths.dataRoot));
  if(native)manifest.nativeInPlace={path:paths.dataRoot,identity:native.identity,exists:true,disposition:'retain'};
  const groups=new Map(),targetFacts=new Map();
  for(const root of roots){
    if(!root||typeof root!=='object')throw failure('LEGACY_MANIFEST_INVALID');
    absolute(root.path,p);
    if(typeof root.identity!=='string'||!root.identity||root.identity.length>2048||
      root.aliases!==undefined&&(!Array.isArray(root.aliases)||root.aliases.length>MAX_ROOTS+5))throw failure('LEGACY_MANIFEST_INVALID');
    for(const name of [root.path,...(root.aliases??[])])if(!allowedPaths.has(absolute(name,p)))throw failure('LEGACY_SOURCE_NOT_DECLARED');
    for(const owner of ['gateway','desktop'])if(root.path===destinations[owner]||root.aliases?.includes(destinations[owner]))targetFacts.set(owner,{...root,path:destinations[owner]});
    const names=[root.path,...(root.aliases??[])],aliases=names.flatMap(name=>byPath.has(name)?[byPath.get(name)]:[]);
    if(!aliases.length){
      if(root.path!==paths.dataRoot&&!Object.values(destinations).includes(root.path))throw failure('LEGACY_SOURCE_NOT_DECLARED');
      continue;
    }
    const previous=groups.get(root.identity);
    if(previous){
      const key=values=>JSON.stringify(normalizedEntries(values).map(value=>[value.relativePath,value.kind,value.size??null,value.identity??null]));
      if(key(previous.entries)!==key(root.entries))
        manifest.blockers.push({code:'LEGACY_SOURCE_CHANGED',path:root.path,conflictsWith:previous.path});
      previous.aliases.push(...aliases);continue;
    }
    groups.set(root.identity,{path:root.path,identity:root.identity,aliases,entries:normalizedEntries(root.entries)});
  }
  const occupied=new Map();
  for(const group of groups.values()){
    group.aliases=[...new Map(group.aliases.map(alias=>[alias.path,alias])).values()];
    const roles=[...new Set(group.aliases.flatMap(alias=>alias.roles))].sort();
    const source={path:group.path,identity:group.identity,aliases:group.aliases,roles,routes:[]};manifest.sources.push(source);
    if(native&&group.identity===native.identity){
      manifest.blockers.push({code:'LEGACY_SOURCE_ALIASES_NATIVE',path:group.path,conflictsWith:paths.dataRoot});continue;
    }
    for(const entry of group.entries){
      const block=(code,extra={})=>manifest.blockers.push({code,path:group.path,relativePath:entry.relativePath,...extra});
      // This is only a running-SDK observation. Stopped classification still
      // rejects every remaining Singleton leaf; it never authorizes omission.
      if(phase==='preview'&&roles.includes('desktop')&&
        [...desktopControls].some(name=>pathKey(name,platform)===pathKey(entry.relativePath,platform))){
        source.routes.push({owner:'desktop',relativePath:entry.relativePath,kind:entry.kind,recursive:false,
          disposition:'retainControl',destination:null,...(entry.identity?{sourceIdentity:entry.identity}:{})});continue;
      }
      if(entry.kind==='symlink'||entry.kind==='other'){block('LEGACY_ENTRY_LINK_UNSUPPORTED');continue;}
      const ancestor=source.routes.find(route=>route.recursive&&pathKey(entry.relativePath,platform).startsWith(pathKey(route.relativePath,platform)+'/'));
      if(ancestor)continue;
      if([...desktopControls].some(name=>pathKey(name,platform)===pathKey(entry.relativePath,platform))){
        block('LEGACY_DESKTOP_CONTROL_PRESENT');continue;
      }
      const rule=ownerOf(entry.relativePath,platform)??{
        owner:roles.includes('desktop')?'desktop':'gateway',expected:entry.kind,recursive:entry.kind==='directory',
      };
      if(entry.kind!==rule.expected){block('LEGACY_ENTRY_KIND_MISMATCH',{owner:rule.owner});continue;}
      if(rule.owner==='storage-control'){
        if(entry.size!==0&&entry.size!=='0'){block('LEGACY_CONTROL_PAYLOAD_UNCONFIRMED');continue;}
        source.routes.push({owner:rule.owner,relativePath:entry.relativePath,kind:entry.kind,recursive:false,disposition:'retainControl',destination:null});continue;
      }
      if(!roles.includes(rule.owner)){block('LEGACY_ENTRY_OWNER_NOT_DECLARED',{owner:rule.owner});continue;}
      const destination=p.join(destinations[rule.owner],...entry.relativePath.split('/')),
        disposition=targetFacts.get(rule.owner)?.identity===group.identity?'inPlace':rule.disposition??'copy';
      const key=pathKey(destination,platform),previous=occupied.get(key);
      if(previous&&(previous.identity!==group.identity||previous.relativePath!==entry.relativePath)){block('LEGACY_DESTINATION_CONFLICT',{owner:rule.owner,conflictsWith:previous.path});}
      else occupied.set(key,{path:group.path,identity:group.identity,relativePath:entry.relativePath});
      source.routes.push({owner:rule.owner,relativePath:entry.relativePath,kind:entry.kind,recursive:rule.recursive===true,disposition,destination,
        ...(entry.identity?{sourceIdentity:entry.identity}:{})});
    }
  }
  for(const [owner,target] of targetFacts){
    if(target.identity===native?.identity){manifest.blockers.push({code:'LEGACY_TARGET_ALIASES_NATIVE',path:target.path});continue;}
    const entries=normalizedEntries(target.entries);
    if(entries.length&&!manifest.sources.some(source=>source.identity===target.identity&&source.roles.includes(owner)))
      manifest.blockers.push({code:'LEGACY_TARGET_OCCUPIED',path:target.path,owner});
  }
  if(manifest.blockers.length)manifest.state='blocked';
  return manifest;
}

export async function observeLegacyRoot(path){
  let named;try{named=await lstat(path,{bigint:true});}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(!named.isDirectory()||named.isSymbolicLink())throw failure('LEGACY_SOURCE_NOT_DIRECTORY');
  const handle=await open(path,constants.O_RDONLY|(constants.O_DIRECTORY??0)|(constants.O_NOFOLLOW??0));
  try{
    const actual=await handle.stat({bigint:true});
    if(identity(actual)!==identity(named))throw failure('LEGACY_SOURCE_CHANGED');
    return {path,identity:identity(actual),
      async verify(){if(identity(await lstat(path,{bigint:true}))!==identity(await handle.stat({bigint:true})))throw failure('LEGACY_SOURCE_CHANGED');},
      close:()=>handle.close()};
  }catch(error){await handle.close();throw error;}
}
export async function readLegacyRootEntries(root){
  const entries=[];
  const list=async(directory,prefix='')=>{
    const reader=await opendir(directory);
    for await(const item of reader){
      if(entries.length>=MAX_ENTRIES)throw failure('LEGACY_SOURCE_ENTRY_LIMIT');
      const path=posix.join(prefix,item.name),info=await lstat(pathsFor(process.platform).join(directory,item.name),{bigint:true});
      const kind=info.isSymbolicLink()?'symlink':info.isDirectory()?'directory':info.isFile()?'file':'other';
      entries.push({relativePath:path,kind,size:String(info.size),identity:identity(info)});
    }
  };
  await list(root.path);
  const partition=entries.find(entry=>pathKey(entry.relativePath,process.platform)===pathKey(partitionContainer,process.platform)&&entry.kind==='directory');
  if(partition)await list(pathsFor(process.platform).join(root.path,partition.relativePath),partition.relativePath);
  await root.verify();return entries;
}

/** Read only fixed current-account roots and explicitly registered sources.
 * Each physical root is listed once, even when Gateway/Electron share it. */
export async function previewLegacyLocations({selected,registeredSources=[],platform=process.platform,phase='stopped'}={},io={}){
  observationPhase(phase);
  const {context,paths}=selectedFacts(selected,platform),initial=baseManifest(paths);
  if(initial.state!=='ready')return initial;
  if(platform!==process.platform)throw failure('LEGACY_PLATFORM_UNAVAILABLE');
  const declared=candidates(context,paths,registeredSources,platform),p=pathsFor(platform),
    targets=[p.join(paths.dataRoot,'studio','gateway'),p.join(paths.dataRoot,'studio','desktop')],
    names=[...new Set([paths.dataRoot,...declared.map(candidate=>candidate.path),...targets])],held=[],groups=new Map(),roots=[],blockers=[];
  const observe=io.observeRoot??observeLegacyRoot,list=io.readRootEntries??readLegacyRootEntries;
  let nativeAbsent=false;
  try{
    for(const path of names){
      let root;try{root=await observe(path);}catch(error){blockers.push({code:error.code?.startsWith('LEGACY_')?error.code:'LEGACY_SOURCE_UNAVAILABLE',path,reason:error.code??'unavailable'});continue;}
      if(!root){if(path===paths.dataRoot)nativeAbsent=true;continue;}held.push(root);
      const previous=groups.get(root.identity);
      if(previous){previous.aliases.push(path);continue;}
      const fact={path,identity:root.identity,aliases:[],entries:[]};groups.set(root.identity,fact);roots.push(fact);
    }
    const native=roots.find(root=>root.path===paths.dataRoot||root.aliases.includes(paths.dataRoot));
    for(const root of roots){
      // Native stays at its original root; do not inspect its credentials,
      // projects, sessions or unknown files to classify another owner's data.
      if(root.identity===native?.identity)continue;
      try{root.entries=await list(held.find(value=>value.identity===root.identity));}
      catch(error){blockers.push({code:error.code?.startsWith('LEGACY_')?error.code:'LEGACY_SOURCE_UNAVAILABLE',path:root.path,reason:error.code??'unavailable'});}
    }
    for(const root of held)try{await root.verify();}catch(error){blockers.push({code:'LEGACY_SOURCE_CHANGED',path:root.path,reason:error.code??'unavailable'});}
    const manifest=classifyLegacyStorageEntries({selected,registeredSources,roots,platform,phase});
    if(nativeAbsent)manifest.nativeInPlace.exists=false;
    manifest.blockers.push(...blockers);if(manifest.blockers.length)manifest.state='blocked';return manifest;
  }finally{
    const closed=await Promise.allSettled(held.map(root=>root.close()));
    if(closed.some(result=>result.status==='rejected'))throw failure('LEGACY_SOURCE_CLOSE_UNCONFIRMED');
  }
}

function exitPreviewFailure(error){
  const code=typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{0,95}$/.test(error.code)?error.code:'LEGACY_PREVIEW_FAILED';
  writeSync(2,code+'\n');process.exit(1);
}

async function runPreviewEntry(){
  if(process.argv.length!==3||process.argv[2]!==PREVIEW_ENTRY)throw failure('LEGACY_PREVIEW_ARGUMENT_INVALID');
  const decoder=new BoundedJsonlDecoder(REQUEST_LIMIT);
  let received=false,bytes=0;
  process.stdin.once('end',()=>exitPreviewFailure(failure('LEGACY_PREVIEW_PARENT_CLOSED')));
  process.stdin.once('error',exitPreviewFailure);
  process.stdout.once('error',exitPreviewFailure);
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>exitPreviewFailure(failure('LEGACY_PREVIEW_CANCELLED')));
  const request=await new Promise(accept=>process.stdin.on('data',chunk=>{
    try{
      if(received)throw failure('LEGACY_PREVIEW_EXTRA_FRAME');
      bytes+=chunk.length;if(bytes>REQUEST_LIMIT)throw failure('LEGACY_PREVIEW_REQUEST_TOO_LARGE');
      const {lines,dropped}=decoder.push(chunk);
      if(dropped.length)throw failure('LEGACY_PREVIEW_REQUEST_TOO_LARGE');
      if(lines.length>1||lines.length===1&&chunk.indexOf(10)!==chunk.length-1)throw failure('LEGACY_PREVIEW_EXTRA_FRAME');
      if(!lines.length)return;
      let value;try{value=JSON.parse(lines[0]);}catch{throw failure('LEGACY_PREVIEW_REQUEST_INVALID');}
      if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2||value.version!==1||
        !Object.hasOwn(value,'phase'))throw failure('LEGACY_PREVIEW_REQUEST_INVALID');
      observationPhase(value.phase);received=true;accept(value);
    }catch(error){exitPreviewFailure(error);}
  }));
  const selected=await loadStorageContext({consumer:'desktop'});
  const manifest=await previewLegacyLocations({selected,phase:request.phase});
  // Drain already-delivered parent EOF/extra input before publishing an answer.
  await new Promise(setImmediate);
  const response=JSON.stringify({version:1,manifest})+'\n';
  if(Buffer.byteLength(response)>RESPONSE_LIMIT)throw failure('LEGACY_PREVIEW_RESPONSE_TOO_LARGE');
  await new Promise((done,reject)=>process.stdout.write(response,error=>error?reject(error):done()));
  process.exit(0);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{await runPreviewEntry();}catch(error){exitPreviewFailure(error);}
}
