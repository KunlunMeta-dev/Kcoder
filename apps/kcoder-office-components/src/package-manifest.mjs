import { createHash, randomUUID } from 'node:crypto';
import { open, readdir, lstat, rename, unlink, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const PACKAGE_ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const MAX_BYTES=256*1024*1024;
const MAX_FILES=20000;
const ENTRY='src/cli.mjs';
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const validSha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const validIdentity=value=>record(value)&&typeof value.name==='string'&&value.name.trim().length>0
 &&typeof value.version==='string'&&/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value.version);
const packageError=(code,cause)=>Object.assign(new Error(code,cause?{cause}:undefined),{code});
function portableRelative(value){
 if(typeof value!=='string'||!value||value.includes('\\')||value.includes(':')||isAbsolute(value)
  ||value.split('/').some(part=>!part||part==='.'||part==='..'||/[\x00-\x1f\x7f]/.test(part)))throw packageError('OFFICE_PACKAGE_MANIFEST_INVALID');
 return value;
}
const sameEntry=(left,right)=>(left.dev===right.dev||(process.platform==='win32'&&left.dev===0n))&&left.ino===right.ino;
const sameFile=(left,right)=>right.isFile()&&right.nlink===1n
 &&sameEntry(left,right)&&left.size===right.size&&left.mtimeNs===right.mtimeNs&&left.ctimeNs===right.ctimeNs;
async function readPackageFile(path,maximum=MAX_BYTES){
 const before=await lstat(path,{bigint:true});
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n)throw Error('OFFICE_PACKAGE_UNSAFE_ENTRY');
 if(before.size>BigInt(maximum))throw Error('OFFICE_PACKAGE_LIMIT');
 let handle;
 try{handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));}
 catch(cause){if(cause.code==='ELOOP')throw new Error('OFFICE_PACKAGE_UNSAFE_ENTRY',{cause});throw cause;}
 try{
  const actual=await handle.stat({bigint:true});
  if(!sameFile(before,actual))throw Error('OFFICE_PACKAGE_UNSAFE_ENTRY');
  const limit=Number(actual.size),chunks=[],buffer=Buffer.alloc(Math.min(64*1024,limit+1));let total=0;
  while(true){
   const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,limit-total+1),null);
   if(!bytesRead)break;
   total+=bytesRead;if(total>limit||total>maximum)throw packageError('OFFICE_PACKAGE_UNSAFE_ENTRY');
   chunks.push(Buffer.from(buffer.subarray(0,bytesRead)));
  }
  const after=await handle.stat({bigint:true});
  let named;try{named=await lstat(path,{bigint:true});}catch(cause){throw packageError('OFFICE_PACKAGE_UNSAFE_ENTRY',cause);}
  if(total!==limit||!sameFile(actual,after)||!sameFile(after,named))throw packageError('OFFICE_PACKAGE_UNSAFE_ENTRY');
  return Buffer.concat(chunks,total);
 }finally{await handle.close();}
}
/** Build contribution consumed by the host packager. No model-facing path API. */
export async function createOfficePackageManifest(root=PACKAGE_ROOT){
 root=resolve(root);
 const files=[];let totalBytes=0;
 async function collect(path){
  if(files.length>=MAX_FILES)throw Error('OFFICE_PACKAGE_LIMIT');
  const name=portableRelative(relative(root,path).split(sep).join('/'));const bytes=await readPackageFile(path,MAX_BYTES-totalBytes);totalBytes+=bytes.length;
  files.push({path:name,bytes:bytes.length,sha256:digest(bytes),legal:/\/(?:licen[cs]e|notice|copying)(?:\.|$)/i.test('/'+name)});
  return bytes;
 }
 // These bytes belong only to this inventory. The stager independently checks
 // every copied buffer and the sealed bundle before publication.
 const packageBytes=await collect(join(root,'package.json')),lockBytes=await collect(join(root,'package-lock.json'));
 let manifest,lock;try{manifest=JSON.parse(packageBytes);lock=JSON.parse(lockBytes);}catch(cause){throw packageError('OFFICE_PACKAGE_MANIFEST_INVALID',cause);}
 if(!validIdentity(manifest)||!record(lock)||(lock.packages!==undefined&&!record(lock.packages)))throw packageError('OFFICE_PACKAGE_MANIFEST_INVALID');
 async function walk(directory){
  const directoryMetadata=await lstat(directory);if(!directoryMetadata.isDirectory()||directoryMetadata.isSymbolicLink())throw Error('OFFICE_PACKAGE_UNSAFE_ENTRY');
  for(const entry of await readdir(directory,{withFileTypes:true})){
   if(entry.name==='.bin'||entry.name==='.package-lock.json')continue;
   const path=join(directory,entry.name);const metadata=await lstat(path);
   if(metadata.isSymbolicLink()||(!metadata.isFile()&&!metadata.isDirectory()))throw Error('OFFICE_PACKAGE_UNSAFE_ENTRY');
   if(metadata.isDirectory()){await walk(path);continue;}
   await collect(path);
  }
 }
 await walk(join(root,'src'));await walk(join(root,'node_modules'));
 await collect(join(root,'README.md'));
 for(const name of await readdir(root))if(/^(?:licen[cs]e|notice|copying)(?:\.|$)/i.test(name))await collect(join(root,name));
 files.sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0);
 if(!files.some(file=>file.path===ENTRY))throw packageError('OFFICE_PACKAGE_MANIFEST_INVALID');
 const dependencies=Object.entries(lock.packages??{}).filter(([path])=>path.startsWith('node_modules/')).map(([path,metadata])=>{
  portableRelative(path);if(!record(metadata)||typeof metadata.version!=='string'||!metadata.version)throw packageError('OFFICE_PACKAGE_MANIFEST_INVALID');
  return{path,version:metadata.version,integrity:metadata.integrity??null,license:metadata.license??'unconfirmed'};
 });
 const output={schemaVersion:1,name:manifest.name,version:manifest.version,nodeMinimumMajor:22,entry:ENTRY,lockSha256:digest(lockBytes),dependencies,files,totalBytes};
 return {...output,contentSha256:digest(JSON.stringify(output))};
}
export async function verifyOfficePackageManifest(manifest,root=PACKAGE_ROOT){
 if(!validIdentity(manifest)||manifest.schemaVersion!==1||manifest.nodeMinimumMajor!==22||manifest.entry!==ENTRY
  ||!validSha(manifest.lockSha256)||!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>MAX_FILES)throw packageError('OFFICE_PACKAGE_MANIFEST_INVALID');
 const names=new Set();let total=0;
 for(const entry of manifest.files){
  if(!record(entry))throw packageError('OFFICE_PACKAGE_MANIFEST_INVALID');portableRelative(entry.path);
  if(names.has(entry.path)||!validSha(entry.sha256)||!Number.isSafeInteger(entry.bytes)||entry.bytes<0||entry.bytes>MAX_BYTES-total)throw packageError('OFFICE_PACKAGE_MANIFEST_INVALID');
  names.add(entry.path);total+=entry.bytes;
 }
 if(!names.has(ENTRY)||total!==manifest.totalBytes)throw packageError('OFFICE_PACKAGE_MANIFEST_INVALID');
 const {contentSha256,...body}=manifest;if(digest(JSON.stringify(body))!==contentSha256)throw Error('OFFICE_PACKAGE_IDENTITY_MISMATCH');
 const actual=await createOfficePackageManifest(root);if(actual.contentSha256!==manifest.contentSha256)throw Error('OFFICE_PACKAGE_IDENTITY_MISMATCH');
 return{status:'verified',contentSha256:manifest.contentSha256,fileCount:manifest.files.length};
}
async function writeManifestOutput(path,bytes,files){
 const parent=await realpath(dirname(path)),target=join(parent,basename(path));
 const sourceRoot=await realpath(PACKAGE_ROOT),child=relative(sourceRoot,target),parts=child.split(sep);
 const leaf=process.platform==='win32'?parts[0].toLowerCase():parts[0];
 if(!isAbsolute(child)&&parts[0]!=='..'&&(
  ['src','node_modules'].includes(leaf)||parts.length===1&&(
   files.some(file=>!file.path.includes('/')&&(process.platform==='win32'?file.path.toLowerCase():file.path)===leaf)
   ||/^(?:licen[cs]e|notice|copying)(?:\.|$)/i.test(leaf))))throw packageError('OFFICE_PACKAGE_OUTPUT_CONFLICT');
 const directory=await lstat(parent,{bigint:true});
 if(!directory.isDirectory()||directory.isSymbolicLink())throw packageError('OFFICE_PACKAGE_UNSAFE_ENTRY');
 const previous=await lstat(target,{bigint:true}).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
 if(previous&&!previous.isFile()&&!previous.isSymbolicLink())throw packageError('OFFICE_PACKAGE_UNSAFE_ENTRY');
 const mode=previous?.isFile()?Number(previous.mode&0o777n):0o600;
 let parentHandle,handle,lease,temp,owned,failure,attempted=false,published=false;
 const assertParent=async()=>{
  const named=await lstat(parent,{bigint:true});
  if(!named.isDirectory()||named.isSymbolicLink()||!sameEntry(directory,named)
   ||parentHandle&&!sameEntry(directory,await parentHandle.stat({bigint:true})))throw packageError('OFFICE_PACKAGE_UNSAFE_ENTRY');
 };
 const cleanupFailure=cause=>{
  if(!failure)failure=Object.assign(packageError('OFFICE_PACKAGE_OUTPUT_CLEANUP_UNCONFIRMED',cause),{publication:published?'published':'not_attempted'});
  else Object.defineProperty(failure,'cleanupError',{value:cause,configurable:true});
  failure.cleanupUnconfirmed=true;
 };
 try{
  // Directory handles and directory sync are POSIX checks, not Windows ACL or
  // power-loss acceptance. The physical parent binding is checked on both paths.
  if(process.platform!=='win32')parentHandle=await open(parent,constants.O_RDONLY|(constants.O_DIRECTORY??0)|(constants.O_NOFOLLOW??0));
  await assertParent();
  temp=join(parent,`.office-manifest-${randomUUID()}.tmp`);
  handle=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),mode);
  owned=await handle.stat({bigint:true});
  if(!owned.isFile()||owned.nlink!==1n)throw packageError('OFFICE_PACKAGE_UNSAFE_ENTRY');
  if(process.platform!=='win32')await handle.chmod(mode);
  await handle.writeFile(bytes);await handle.sync();
  const complete=await handle.stat({bigint:true});
  if(!sameEntry(owned,complete)||!complete.isFile()||complete.nlink!==1n||complete.size!==BigInt(bytes.length)
   ||!sameFile(complete,await lstat(temp,{bigint:true})))throw packageError('OFFICE_PACKAGE_UNSAFE_ENTRY');
  // Keep this inode alive after closing the writer, so replacement cannot reuse
  // its inode number and acquire cleanup ownership through an old observation.
  lease=await open(temp,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
  if(!sameFile(complete,await lease.stat({bigint:true})))throw packageError('OFFICE_PACKAGE_UNSAFE_ENTRY');
  await handle.close();handle=null;
  await assertParent();
  if(!sameFile(complete,await lstat(temp,{bigint:true})))throw packageError('OFFICE_PACKAGE_UNSAFE_ENTRY');
  // Once rename is attempted, a lost receipt cannot establish nonpublication.
  // Preserve the candidate, never roll back or automatically replay the write.
  attempted=true;
  await rename(temp,target);published=true;
  await assertParent();if(parentHandle)await parentHandle.sync();
 }catch(cause){
  failure=attempted?Object.assign(packageError('OFFICE_PACKAGE_PUBLICATION_UNCONFIRMED',cause),{externalOutcome:'unknown'}):cause;
  if(attempted)Object.defineProperty(failure,'recoveryPath',{value:temp});
 }finally{
  if(temp&&owned&&!attempted)try{
   await assertParent();const named=await lstat(temp,{bigint:true}).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
   if(named){const held=await(lease??handle).stat({bigint:true});if(!sameEntry(owned,held)||!sameFile(held,named))throw packageError('OFFICE_PACKAGE_UNSAFE_ENTRY');await unlink(temp);}
  }catch(cause){cleanupFailure(cause);}
  if(handle)try{await handle.close();}catch(cause){cleanupFailure(cause);}
  if(lease)try{await lease.close();}catch(cause){cleanupFailure(cause);}
  if(parentHandle)try{await parentHandle.close();}catch(cause){cleanupFailure(cause);}
 }
 if(failure)throw failure;
}
if(process.argv[1]&&await realpath(process.argv[1]).catch(()=>null)===fileURLToPath(import.meta.url)){
 const [flag,path,...extra]=process.argv.slice(2);if(flag!=='--output'||!path||!isAbsolute(path)||extra.length)throw Error('Office package manifest requires --output ABSOLUTE_PATH');
 const manifest=await createOfficePackageManifest();await writeManifestOutput(path,JSON.stringify(manifest,null,2)+'\n',manifest.files);
}
