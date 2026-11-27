import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join, posix, resolve, win32 } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const MAX_IDENTITY_BYTES = 4096;
const CREDENTIAL = /^[A-Za-z0-9._~-]{32,512}$/;
const GATEWAY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const IDENTITY_KEYS = new Set([
  'version', 'relayOrigin', 'gatewaySecretHash', 'enrollmentToken', 'id', 'secret',
]);
export const OFFLINE_IDENTITY_RELOCATION_VERSION = 1;

export const LEGACY_DEFAULT_IDENTITY_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../target/kcoder-relay/client-identity.json',
);
export function defaultIdentityFile({ env=process.env, home=homedir(), platform=process.platform }={}) {
  const paths=platform==='win32'?win32:posix;
  const absolute=value=>typeof value==='string'&&paths.isAbsolute(value)&&
    (platform!=='win32'||paths.parse(value).root.length>1);
  // Default state roots must not depend on the current directory or Windows drive.
  const configured=platform==='win32'?[env.LOCALAPPDATA,env.APPDATA]:platform==='darwin'?[]:[env.XDG_STATE_HOME];
  let base=configured.find(absolute);
  if(!base){
    if(!absolute(home))throw new Error('Relay identity home directory must be absolute');
    base=platform==='win32'?paths.join(home,'AppData','Local'):
      platform==='darwin'?paths.join(home,'Library','Application Support'):paths.join(home,'.local','state');
  }
  return paths.join(base,'kcoder-relay','client-identity.json');
}
export const DEFAULT_IDENTITY_FILE=defaultIdentityFile();

export function resolveIdentityFile(env = process.env, stateDirectory) {
  const configured = env.KCODER_RELAY_IDENTITY_FILE;
  return resolve(configured || (stateDirectory ? resolve(stateDirectory, 'relay', 'client-identity.json') : DEFAULT_IDENTITY_FILE));
}

/** Presence chooses the startup mode only; every use still reads the authority. */
export async function clientIdentityPresent(identityFile=DEFAULT_IDENTITY_FILE){
  if(await readClientIdentityState({identityFile}))return true;
  return resolve(identityFile)===DEFAULT_IDENTITY_FILE&&Boolean(await maybeStat(LEGACY_DEFAULT_IDENTITY_FILE)||await maybeStat(LEGACY_DEFAULT_IDENTITY_FILE+STATE_SUFFIX));
}

async function identityDirectory(directory, create = false) {
  if (create) await mkdir(directory, { recursive: true });
  const entry = await lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (entry && (!entry.isDirectory() || entry.isSymbolicLink()))
    throw new Error('Relay identity path must be an ordinary directory');
}

/** Adopt the old path only at startup, after the instance's previous owner has stopped. */
export async function prepareInstanceIdentityFile({ stateDirectory, identityFile: destinationFile, legacyIdentityFile, relayUrl, gatewaySecret,requireEpochAtDestination=false,preserveSource=false,relocation }) {
  if(relocation!==undefined){
    if(relocation?.phase==='prepareSource')return prepareOfflineIdentitySource({identityFile:destinationFile,relayUrl,gatewaySecret,relocation});
    if(relocation?.phase!==undefined&&relocation.phase!=='relocate')throw recovery();
    if(relocation?.sharedIdentityFile!==undefined)return offlineSharedIdentityRelocation({identityFile:destinationFile,legacyIdentityFile,relayUrl,gatewaySecret,relocation},true);
    return prepareOfflineIdentityRelocation({stateDirectory,identityFile:destinationFile,legacyIdentityFile,relayUrl,gatewaySecret,relocation});
  }
  if(typeof preserveSource!=='boolean')throw recovery();
  if (legacyIdentityFile !== undefined && (typeof legacyIdentityFile !== 'string' || !legacyIdentityFile.trim()))
    throw new Error('Invalid legacy client identity path');
  if(destinationFile!==undefined&&typeof destinationFile!=='string')throw new Error('Invalid destination client identity path');
  const identityFile = destinationFile===undefined?resolveIdentityFile({}, stateDirectory):resolve(destinationFile);
  const directory = dirname(identityFile);
  await identityDirectory(directory);
  const origin = normalizeRelayOrigin(relayUrl);
  const tokenHash = pairingHash(gatewaySecret);
  const current = await readRecord(identityFile);
  if (current) validateBinding(current, origin, tokenHash);
  if (legacyIdentityFile === undefined) return identityFile;
  const legacyPath = resolve(legacyIdentityFile);
  if (legacyPath === identityFile) return identityFile;
  // realpath identifies the same directory entry through parent aliases; two
  // distinct hard links must still finish their interrupted relocation below.
  if (current) {
    const legacyCanonical = await realpath(legacyPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    const destinationCanonical=await realpath(identityFile).catch(error=>{if(error.code!=='ENOENT')throw error;});
    if (legacyCanonical && legacyCanonical === destinationCanonical) return identityFile;
  }
  let sourceAuthority=await loadAuthority(legacyPath),previousSnapshot;
  if(sourceAuthority?.reference.role==='relocated-source')previousSnapshot=await relocationSeed(sourceAuthority);
  else if(!sourceAuthority){
    try{previousSnapshot=await readLegacySnapshot(legacyPath);}
    catch(error){sourceAuthority=await loadAuthority(legacyPath);if(!sourceAuthority)throw error;
      if(sourceAuthority.reference.role==='relocated-source')previousSnapshot=await relocationSeed(sourceAuthority);}
  }
  const previous = sourceAuthority?await readRecord(legacyPath):previousSnapshot?.record;
  if (!previous) return identityFile;
  validateBinding(previous, origin, tokenHash);
  if (current && !isDeepStrictEqual(previous, current)) throw new Error('Conflicting legacy and current Relay identities; stop the instance and reconcile them before starting');

  // A cold reopen can encounter the same epoch through different historical
  // alias roles. Keep the existing references rather than republish their roles.
  if(current&&sourceAuthority){
    const destination=await loadActiveAuthority(identityFile),source=await loadActiveAuthority(legacyPath);
    if(destination&&source&&destination.root===source.root&&destination.hash===source.hash&&
      destination.reference.generation===source.reference.generation&&
      destination.reference.dev===source.reference.dev&&destination.reference.ino===source.reference.ino)return identityFile;
  }

  await identityDirectory(directory, true);
  if(sourceAuthority&&sourceAuthority.reference.role!=='relocated-source'){
    if(requireEpochAtDestination&&dirname(sourceAuthority.root)!==directory)throw recovery();
    const destinationAuthority=await publishReference(identityFile,{...sourceAuthority.reference,role:'relocated-target'});
    if(destinationAuthority.reference.epoch!==sourceAuthority.reference.epoch)throw recovery();
    // New-format aliases share the one immutable generation; do not copy its
    // authority or delete another alias's projection.
    return identityFile;
  }
  sourceAuthority??=await initializeAuthority(legacyPath,previous,previousSnapshot.bytes,
    {epochParent:directory,role:'relocated-source',seedStat:previousSnapshot.stat});
  if(sourceAuthority.reference.role!=='relocated-source'||!isDeepStrictEqual(plainRecord(previous),
    plainRecord(await readRecord(legacyPath))))throw recovery();
  const destinationAuthority=await publishReference(identityFile,{...sourceAuthority.reference,role:'relocated-target'});
  if(destinationAuthority.reference.epoch!==sourceAuthority.reference.epoch)throw recovery();
  const currentEntry=await maybeStat(identityFile);
  if (!currentEntry) {
    try {
      // Publish without replacing a competing identity; retain the original bytes and inode.
      await link(legacyPath, identityFile);
    } catch (error) {
      if(error.code==='EXDEV'){
        // The authority already lives at the destination. Publish only its
        // secret-free marker and retain the original cross-volume seed.
        try{await link(join(sourceAuthority.root,'marker.json'),identityFile);}catch(cause){if(cause.code!=='EEXIST')throw cause;}
        await syncDirectory(directory);await validatePointer(destinationAuthority);return identityFile;
      }
      if (!['EEXIST', 'ENOENT'].includes(error.code) ||
          !isDeepStrictEqual(previous, await readRecord(identityFile))) throw error;
    }
  }
  // A crash between publication and unlink leaves two matching files and can resume safely.
  const published=await readLegacySnapshot(identityFile);
  if(!published||!isDeepStrictEqual(plainRecord(published.record),plainRecord(previousSnapshot.record)))throw recovery();
  if(!currentEntry&&!sameFile(published.stat,previousSnapshot.stat))throw recovery();
  await syncDirectory(dirname(identityFile));
  const remaining=preserveSource?null:await maybeStat(legacyPath);
  if(remaining){
    try{
      const actual=await lstat(legacyPath,{bigint:true});
      if(!await namedFileMatches(legacyPath,actual,previousSnapshot.stat))throw recovery();
      await unlink(legacyPath);
    }catch(error){
      // The destination already proves the original epoch and seed. A peer
      // adopting that same seed may finish its unlink between these reads.
      if(error.code!=='ENOENT')throw error;
    }
  }
  await syncDirectory(dirname(legacyPath));
  return identityFile;
}

export function normalizeRelayOrigin(relayUrl) {
  if (typeof relayUrl !== 'string' || relayUrl.length === 0) throw new Error('Configure KCODER_RELAY_PUBLIC_URL');
  let parsed;
  try { parsed = new URL(relayUrl); }
  catch { throw new Error('Invalid relay URL'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Relay URL must be an HTTP(S) URL without credentials, query, or fragment');
  }
  return parsed.origin;
}

function validCredential(value) {
  return typeof value === 'string' && CREDENTIAL.test(value);
}

function pairingHash(gatewaySecret) {
  if (!validCredential(gatewaySecret)) throw new Error('Gateway internal secret must be 32 to 512 URL-safe characters');
  return createHash('sha256').update(gatewaySecret, 'utf8').digest('hex');
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some(key => !expected.has(key))) throw new Error(`Invalid ${label} schema`);
}

function validateRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Client identity must be a JSON object');
  const keys = Object.keys(value);
  if (keys.some(key => !IDENTITY_KEYS.has(key))) throw new Error('Client identity contains unknown fields');
  const hasEnrollment = Object.hasOwn(value, 'enrollmentToken');
  const hasId = Object.hasOwn(value, 'id');
  const hasSecret = Object.hasOwn(value, 'secret');
  if (hasId !== hasSecret || hasEnrollment === hasId) throw new Error('Client identity has an invalid state');
  const expected = hasEnrollment
    ? new Set(['version', 'relayOrigin', 'gatewaySecretHash', 'enrollmentToken'])
    : new Set(['version', 'relayOrigin', 'gatewaySecretHash', 'id', 'secret']);
  exactKeys(value, expected, 'client identity');
  if (value.version !== 1) throw new Error('Unsupported client identity version');
  let storedOrigin;
  try { storedOrigin = normalizeRelayOrigin(value.relayOrigin); }
  catch { throw new Error('Invalid client identity relay origin'); }
  if (storedOrigin !== value.relayOrigin) {
    throw new Error('Invalid client identity relay origin');
  }
  if (typeof value.gatewaySecretHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.gatewaySecretHash)) {
    throw new Error('Invalid client identity internal secret hash');
  }
  if (hasEnrollment) {
    if (!validCredential(value.enrollmentToken)) throw new Error('Invalid client identity enrollment token');
    return { status: 'pending', ...value };
  }
  if (typeof value.id !== 'string' || !GATEWAY_ID.test(value.id) || !validCredential(value.secret)) {
    throw new Error('Invalid registered client identity');
  }
  return { status: 'registered', ...value };
}

async function readLegacySnapshot(identityFile, requireSingleLink = false) {
  const path = resolve(identityFile || DEFAULT_IDENTITY_FILE);
  let handle,observed=false;
  try {
    await identityDirectory(dirname(path));
    const entry = await lstat(path,{bigint:true});
    observed=true;
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Client identity must be a regular file');
    const noFollow = constants.O_NOFOLLOW || 0;
    handle = await open(path, constants.O_RDONLY | noFollow | (constants.O_NONBLOCK || 0));
    const stat = await handle.stat({bigint:true});
    if (!stat.isFile() || !sameNamedFile(entry,stat))
      throw new Error('Client identity file changed while opening');
    if (requireSingleLink && stat.nlink !== 1n) throw new Error('Client identity must not have multiple hard links');
    if (stat.size > BigInt(MAX_IDENTITY_BYTES)) throw new Error(`Client identity exceeds ${MAX_IDENTITY_BYTES} bytes`);
    const buffer = Buffer.alloc(MAX_IDENTITY_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_IDENTITY_BYTES) throw new Error(`Client identity exceeds ${MAX_IDENTITY_BYTES} bytes`);
    const after = await lstat(path,{bigint:true});
    const heldAfter = await handle.stat({bigint:true});
    if (!sameFile(stat,heldAfter) || !await namedFileMatches(path,after,heldAfter) ||
        heldAfter.size !== stat.size || heldAfter.mtimeNs !== stat.mtimeNs ||
        BigInt(length) !== stat.size)
      throw new Error('Client identity file changed while reading');
    let parsed;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))); }
    catch { throw new Error('Client identity is not valid UTF-8 JSON'); }
    return {record:validateRecord(parsed),bytes:buffer.subarray(0,length),stat};
  } catch (error) {
    if (error.code === 'ENOENT'&&!observed) return undefined;
    if (error.code === 'ENOENT') throw recovery();
    throw error;
  } finally {
    await handle?.close();
  }
}

const STATE_SUFFIX='.state-v2',MAX_ENTRY_BYTES=8192,MAX_GENERATION_DEPTH=3;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const identityError=(code,message)=>Object.assign(new Error(message),{code});
const commitUnconfirmed=cause=>Object.assign(new Error('Relay identity publication requires reconciliation',{cause}),
  {code:'RELAY_IDENTITY_COMMIT_UNCONFIRMED',externalOutcome:'unknown'});
const filesystemError=error=>typeof error?.code==='string'&&/^E[A-Z0-9]+$/.test(error.code);
const recovery=()=>identityError('RELAY_IDENTITY_RECOVERY_REQUIRED','Relay identity requires reconciliation; preserve its original generation');
const revoked=()=>identityError('RELAY_IDENTITY_REVOKED','Relay identity generation has been revoked');
const plainRecord=value=>Object.fromEntries(Object.entries(value).filter(([key])=>IDENTITY_KEYS.has(key)));
const sameFile=(a,b)=>a?.dev===b?.dev&&a?.ino===b?.ino;
const fileReadFlags=constants.O_RDONLY|(constants.O_NOFOLLOW||0)|(constants.O_NONBLOCK||0);
// Windows path metadata can omit the volume; handle metadata supplies it. File
// indices must stay BigInt throughout both observations.
const sameNamedFile=(named,held)=>named?.isFile()&&!named.isSymbolicLink()&&named.ino===held?.ino&&
  (named.dev===held.dev||process.platform==='win32'&&named.dev===0n);
async function namedFileMatches(path,named,held){
  if(!sameNamedFile(named,held))return false;
  if(process.platform!=='win32')return true;
  const current=await open(path,fileReadFlags);
  try{const actual=await current.stat({bigint:true});return actual.isFile()&&sameFile(actual,held);}
  finally{await current.close();}
}
async function maybeStat(path){return lstat(path,{bigint:true}).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});}
async function readStateBytes(path,{singleLink=true,maximum=MAX_ENTRY_BYTES}={}){
  await identityDirectory(dirname(path));
  const before=await lstat(path,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||singleLink&&before.nlink!==1n||before.size>BigInt(maximum))throw recovery();
  const file=await open(path,fileReadFlags);
  try{
    const held=await file.stat({bigint:true});
    if(!held.isFile()||!sameNamedFile(before,held)||held.size!==before.size||singleLink&&held.nlink!==1n)throw recovery();
    const bytes=Buffer.alloc(maximum+1);let size=0;
    while(size<bytes.length){const part=await file.read(bytes,size,bytes.length-size,size);if(!part.bytesRead)break;size+=part.bytesRead;}
    const after=await file.stat({bigint:true}),entry=await lstat(path,{bigint:true});
    if(size>maximum||BigInt(size)!==held.size||!sameFile(held,after)||!await namedFileMatches(path,entry,after)||after.size!==held.size||
      after.mtimeNs!==held.mtimeNs||after.ctimeNs!==held.ctimeNs)throw recovery();
    return {bytes:bytes.subarray(0,size),stat:held};
  }finally{await file.close();}
}
function decodeEntry(bytes){
  let entry;try{entry=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw recovery();}
  exactKeys(entry,new Set(['schemaVersion','generation','previous','state','record','seedSha256','seedIdentity']),'Relay identity entry');
  if(entry.schemaVersion!==2||!/^[a-f0-9]{64}$/.test(entry.generation)||entry.previous!==null&&!/^[a-f0-9]{64}$/.test(entry.previous)||
      entry.seedSha256!==null&&!/^[a-f0-9]{64}$/.test(entry.seedSha256)||!['pending','registered','revoked'].includes(entry.state))throw recovery();
  if(entry.seedIdentity!==null&&(!entry.seedIdentity||Object.keys(entry.seedIdentity).sort().join(',')!=='dev,ino'||
    !/^\d+$/.test(entry.seedIdentity.dev)||!/^[1-9]\d*$/.test(entry.seedIdentity.ino)))throw recovery();
  if(entry.record===null){if(entry.state!=='revoked'||entry.previous!==null)throw recovery();}
  else {const record=validateRecord(entry.record);if(entry.state!=='revoked'&&record.status!==entry.state)throw recovery();}
  return entry;
}
async function relocationSeed(authority){
  const initial=decodeEntry((await readStateBytes(join(authority.root,'entry.json'))).bytes);
  const seed=await readStateBytes(join(authority.root,'legacy-seed.json'),{maximum:MAX_IDENTITY_BYTES});
  if(!initial.seedIdentity||digest(seed.bytes)!==initial.seedSha256)throw recovery();
  return {record:validateRecord(JSON.parse(seed.bytes)),bytes:seed.bytes,
    stat:{dev:BigInt(initial.seedIdentity.dev),ino:BigInt(initial.seedIdentity.ino)}};
}
async function loadAuthority(identityFile){
  const path=resolve(identityFile),referencePath=path+STATE_SUFFIX;
  await identityDirectory(dirname(path));
  if(!await maybeStat(referencePath))return null;
  await identityDirectory(referencePath);
  const referenceBytes=await readStateBytes(join(referencePath,'reference.json'));
  let reference;try{reference=JSON.parse(referenceBytes.bytes);}catch{throw recovery();}
  exactKeys(reference,new Set(['schemaVersion','generation','epoch','initialHash','dev','ino','role']),'Relay identity reference');
  if(reference.schemaVersion!==2||!/^[a-f0-9]{64}$/.test(reference.generation)||
    !/^[a-f0-9]{64}$/.test(reference.initialHash)||!['canonical','relocated-source','relocated-target'].includes(reference.role)||
    typeof reference.epoch!=='string'||resolve(reference.epoch)!==reference.epoch||
    basename(reference.epoch)!=='.relay-identity-generation-'+reference.generation)throw recovery();
  const root=reference.epoch;await identityDirectory(dirname(root));await identityDirectory(root);
  const rootInfo=await lstat(root,{bigint:true});
  if(String(rootInfo.dev)!==reference.dev||String(rootInfo.ino)!==reference.ino)throw recovery();
  let directory=root,previous=null,generation,seedSha256,ancestor;
  for(let depth=0;depth<MAX_GENERATION_DEPTH;depth++){
    await identityDirectory(directory);
    const value=await readStateBytes(join(directory,'entry.json')),entry=decodeEntry(value.bytes),hash=digest(value.bytes);
    if(depth===0&&(hash!==reference.initialHash||entry.generation!==reference.generation))throw recovery();
    if(entry.previous!==previous||generation!==undefined&&entry.generation!==generation||
      seedSha256!==undefined&&entry.seedSha256!==seedSha256)throw recovery();
    if(ancestor){
      if(ancestor.state==='revoked'||entry.state!=='revoked'&&!(ancestor.state==='pending'&&entry.state==='registered'))throw recovery();
      if(entry.record===null||entry.record.relayOrigin!==ancestor.record?.relayOrigin||entry.record.gatewaySecretHash!==ancestor.record?.gatewaySecretHash)throw recovery();
      if(entry.state==='revoked'&&!isDeepStrictEqual(entry.record,ancestor.record))throw recovery();
    }
    generation=entry.generation;seedSha256=entry.seedSha256;
    const next=join(directory,'next'),nextInfo=await maybeStat(next);
    if(!nextInfo)return {path,root,directory,entry,hash,depth,reference,referencePath};
    if(depth===MAX_GENERATION_DEPTH-1||!nextInfo.isDirectory()||nextInfo.isSymbolicLink())throw recovery();
    previous=hash;ancestor=entry;directory=next;
  }
  throw recovery();
}
async function validatePointer(authority){
  const {path,root,entry}=authority,info=await maybeStat(path);
  if(!info)return;
  if(!info.isFile()||info.isSymbolicLink())throw new Error('Client identity must be a regular file');
  const value=await readStateBytes(path,{singleLink:false,maximum:MAX_IDENTITY_BYTES});
  let pointer;try{pointer=JSON.parse(value.bytes);}catch{throw recovery();}
  if(pointer.version===2){
    exactKeys(pointer,new Set(['version','generation']),'Relay identity marker');
    if(pointer.generation!==entry.generation)throw recovery();
    const marker=await readStateBytes(join(root,'marker.json'),{singleLink:false});
    const pending=await maybeStat(join(root,'.marker-publish'));
    const links=2n+(pending&&await namedFileMatches(join(root,'.marker-publish'),pending,marker.stat)?1n:0n);
    if(!sameFile(value.stat,marker.stat)||value.stat.nlink!==links||!value.bytes.equals(marker.bytes))throw recovery();
  }else if(entry.seedSha256!==digest(value.bytes)&&!isDeepStrictEqual(plainRecord(validateRecord(pointer)),entry.record))throw recovery();
}
async function loadActiveAuthority(identityFile){
  let authority=await loadAuthority(identityFile);
  for(let attempt=0;authority&&attempt<MAX_GENERATION_DEPTH;attempt++){
    if(authority.entry.state==='revoked')throw revoked();
    await validatePointer(authority);
    // Pointer I/O can outlive a committed deny. Recheck the same epoch before granting use.
    const current=await loadAuthority(identityFile);
    if(!current||!isDeepStrictEqual(current.reference,authority.reference))throw recovery();
    if(current.hash===authority.hash)return current;
    if(current.depth<=authority.depth)throw recovery();
    authority=current;
  }
  if(authority)throw recovery();
  return null;
}
async function readActiveState(identityFile,requireSingleLink=false){
  const path=identityFile||DEFAULT_IDENTITY_FILE;
  let authority=await loadActiveAuthority(path);
  if(authority)return {authority};
  const legacy=await readLegacySnapshot(path,requireSingleLink);
  // A legacy snapshot is not permission to ignore a generation published during that read.
  authority=await loadActiveAuthority(path);
  return {authority,legacy};
}
async function readRecord(identityFile,requireSingleLink=false){
  const {authority,legacy}=await readActiveState(identityFile,requireSingleLink);
  return authority?validateRecord(authority.entry.record):legacy?.record;
}
async function writeIdentityFile(path,bytes){
  const file=await open(path,'wx');
  try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
}
async function createCandidateDirectory(prefix){
  for(let attempt=0;attempt<8;attempt++){
    const candidate=process.platform==='win32'
      ?win32.toNamespacedPath(prefix+randomBytes(12).toString('hex'))
      :prefix+randomBytes(12).toString('hex');
    try{await mkdir(candidate);return candidate;}
    catch(error){if(error.code!=='EEXIST')throw error;}
  }
  throw recovery();
}
async function publishEntry(target,entry,{seedBytes,root=false,reference=false}={}){
  const parent=dirname(target);await identityDirectory(parent,true);
  if(await maybeStat(target))return false;
  const bytes=Buffer.from(JSON.stringify(entry)+'\n');if(bytes.length>MAX_ENTRY_BYTES)throw recovery();
  const prefix=join(parent,'.relay-identity-candidate-');
  const candidate=await createCandidateDirectory(prefix),owned=await lstat(candidate,{bigint:true});let published=false;
  try{
    await writeIdentityFile(join(candidate,reference?'reference.json':'entry.json'),bytes);
    if(root){
      await writeIdentityFile(join(candidate,'marker.json'),Buffer.from(JSON.stringify({version:2,generation:entry.generation})+'\n'));
      if(seedBytes)await writeIdentityFile(join(candidate,'legacy-seed.json'),seedBytes);
    }
    await syncDirectory(candidate);
    if(await maybeStat(target))return false;
    try{await rename(candidate,target);published=true;}
    catch(error){if(!['EEXIST','ENOTEMPTY','EPERM','ENOTDIR'].includes(error.code)||!await maybeStat(target))throw error;return false;}
    try{await syncDirectory(parent);}catch(error){throw commitUnconfirmed(error);}
    return true;
  }finally{
    if(!published){
      const remaining=await maybeStat(candidate);
      if(remaining&&sameFile(remaining,owned)&&remaining.isDirectory()&&!remaining.isSymbolicLink())
        await rm(candidate,{recursive:true,force:true}).catch(()=>{});
    }
  }
}
async function publishReference(path,reference){
  const published=await publishEntry(path+STATE_SUFFIX,reference,{reference:true});
  try{const authority=await loadAuthority(path);if(!authority)throw recovery();return authority;}
  catch(error){if(published&&filesystemError(error))throw commitUnconfirmed(error);throw error;}
}
async function initializeAuthority(path,record,seedBytes,{epochParent=dirname(path),role='canonical',seedStat}={}){
  const existing=await loadAuthority(path);if(existing)return existing;
  await identityDirectory(epochParent,true);
  const entry={schemaVersion:2,generation:randomBytes(32).toString('hex'),previous:null,
    state:record?.status??'revoked',record:record?plainRecord(record):null,seedSha256:seedBytes?digest(seedBytes):null,
    seedIdentity:seedStat?{dev:String(seedStat.dev),ino:String(seedStat.ino)}:null};
  const epoch=join(epochParent,'.relay-identity-generation-'+entry.generation);
  await publishEntry(epoch,entry,{seedBytes,root:true});
  const info=await lstat(epoch,{bigint:true}),initial=await readStateBytes(join(epoch,'entry.json'));
  // The epoch is complete before any alias can reference it. Unreferenced epochs
  // are retained after uncertain publication; they are never scanned for adoption.
  return publishReference(path,{schemaVersion:2,generation:entry.generation,epoch,initialHash:digest(initial.bytes),
    dev:String(info.dev),ino:String(info.ino),role});
}
async function authorityForMutation(path,initial){
  let authority=await loadAuthority(path);if(authority)return authority;
  let seed;
  try{seed=await readLegacySnapshot(path);}catch(error){authority=await loadAuthority(path);if(authority)return authority;throw error;}
  authority=await loadAuthority(path);if(authority)return authority;
  return initializeAuthority(path,seed?.record??initial(),seed?.bytes,{seedStat:seed?.stat});
}
async function ensureMarker(authority){
  if(authority.reference.role!=='canonical')return;
  const {path,root}=authority;
  const current=await maybeStat(path);
  if(current){
    await validatePointer(authority);
    if(JSON.parse((await readStateBytes(path,{singleLink:false,maximum:MAX_IDENTITY_BYTES})).bytes).version===2)return;
  }
  const marker=join(root,'marker.json'),pending=join(root,'.marker-publish');
  try{
  if(!current){
    try{await link(marker,path);}catch(error){if(error.code!=='EEXIST')throw error;}
  }else{
    try{await link(marker,pending);}catch(error){if(error.code!=='EEXIST')throw error;}
    const source=await readStateBytes(marker,{singleLink:false}),alias=await readStateBytes(pending,{singleLink:false});
    if(!sameFile(source.stat,alias.stat)||!source.bytes.equals(alias.bytes))throw recovery();
    try{await rename(pending,path);}catch(error){if(error.code!=='ENOENT')throw error;}
    const left=await maybeStat(pending),now=await maybeStat(path);
    if(left){if(!await namedFileMatches(pending,left,source.stat)||!await namedFileMatches(path,now,source.stat))throw recovery();await unlink(pending).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  }
  await syncDirectory(dirname(path));
  await validatePointer(authority);
  }catch(error){if(filesystemError(error))throw commitUnconfirmed(error);throw error;}
}
async function appendDecision(authority,state,record){
  if(authority.entry.state==='revoked')throw revoked();
  const entry={...authority.entry,previous:authority.hash,state,record:plainRecord(record)};
  const published=await publishEntry(join(authority.directory,'next'),entry);
  try{return await loadAuthority(authority.path);}
  catch(error){if(published&&filesystemError(error))throw commitUnconfirmed(error);throw error;}
}

/** Private phase projection for Gateway management; never exposes credentials. */
export async function readClientIdentityState({identityFile=DEFAULT_IDENTITY_FILE}={}){
  const authority=await loadAuthority(identityFile);
  if(authority){
    if(authority.entry.state!=='revoked')await validatePointer(authority);
    return {status:authority.entry.state,relayOrigin:authority.entry.record?.relayOrigin??null,
      ...(authority.entry.state==='registered'?{id:authority.entry.record.id}:{})};
  }
  const record=await readLegacySnapshot(identityFile);
  return record?{status:record.record.status,relayOrigin:record.record.relayOrigin,...(record.record.id?{id:record.record.id}:{})}:null;
}

/** Bounded read-only fingerprint for an install transaction, including revocation. */
export async function readClientIdentitySnapshot({identityFile=DEFAULT_IDENTITY_FILE}={}){
  const {authority,legacy}=await readActiveState(identityFile,true);
  if(authority){
    return Buffer.from(JSON.stringify({version:2,generation:authority.entry.generation,decision:authority.hash})+'\n');
  }
  if(!legacy)throw recovery();
  return legacy.bytes;
}

/** Commit an irreversible local deny anchor; this never deletes another writer's path. */
export async function revokeClientIdentity({identityFile=DEFAULT_IDENTITY_FILE}={}){
  const path=resolve(identityFile);let authority=await loadAuthority(path);
  if(!authority)authority=await authorityForMutation(path,()=>null);
  for(let attempt=0;attempt<MAX_GENERATION_DEPTH;attempt++){
    if(authority.entry.state==='revoked'){
      try{await ensureMarker(authority);}
      catch(error){if(filesystemError(error))throw commitUnconfirmed(error);throw error;}
      return {status:'revoked'};
    }
    authority=await appendDecision(authority,'revoked',authority.entry.record);
  }
  throw recovery();
}

async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function offlineIdentitySnapshot(path){
  const authority=await loadAuthority(path);
  if(!authority){
    const legacy=await readLegacySnapshot(path);if(!legacy)throw recovery();
    return {record:legacy.record};
  }
  await validatePointer(authority);
  const record=authority.entry.record?validateRecord(authority.entry.record):null;
  return {authority,record,key:{kind:'generation',generation:authority.entry.generation,decision:authority.hash,
    sourceEpoch:authority.root,dev:authority.reference.dev,ino:authority.reference.ino}};
}

/** A previous move's bounded receipt is historical provenance, never authority.
 * Validate it against this current generation before excluding its exact owner
 * directory from a later stopped copy. No earlier source is opened. */
async function offlineSourceTransferReceipt(identityFile,authority,files){
  const directory=identityFile+'.relocation-v1';
  if(!await maybeStat(directory))return null;
  await identityDirectory(directory);
  if((await readdir(directory)).sort().join(',')!=='reference.json')throw recovery();
  let value;
  try{
    value=JSON.parse((await readStateBytes(join(directory,'reference.json'))).bytes);
    exactKeys(value,new Set(['version','domain','source','finalTarget','operationId','sourceIdentity']),'Relay transfer receipt');
    exactKeys(value.sourceIdentity,new Set(['kind','generation','decision','sourceEpoch','dev','ino']),'Relay transfer source');
  }catch{throw recovery();}
  const source=value.sourceIdentity;
  if(value.version!==1||value.domain!=='gateway-relay-identity'||value.finalTarget!==identityFile||
    typeof value.source!=='string'||resolve(value.source)!==value.source||value.source===identityFile||
    typeof value.operationId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value.operationId)||
    source.kind!=='generation'||source.generation!==authority.entry.generation||
    typeof source.sourceEpoch!=='string'||resolve(source.sourceEpoch)!==source.sourceEpoch||
    basename(source.sourceEpoch)!=='.relay-identity-generation-'+source.generation||
    typeof source.dev!=='string'||!/^\d+$/.test(source.dev)||
    typeof source.ino!=='string'||!/^[1-9]\d*$/.test(source.ino)||
    !files.some(file=>file.name.endsWith('entry.json')&&digest(file.bytes)===source.decision))throw recovery();
  return {directory,value};
}

/** Settle only an observed source before the executor captures its inventory.
 * The ordinary owner may adopt a legacy seed, but a missing seed can never
 * invoke the normal new-install enrollment branch. */
async function prepareOfflineIdentitySource({identityFile,relayUrl,gatewaySecret,relocation}){
  const {operationId,validateOffline,sharedIdentityFile,observeMetadata}=relocation??{};
  if(typeof identityFile!=='string'||resolve(identityFile)!==identityFile||typeof operationId!=='string'||
    !/^[A-Za-z0-9_-]{1,128}$/.test(operationId)||typeof validateOffline!=='function')throw recovery();
  const facts=Object.freeze({domain:'gateway-relay-identity-source',source:identityFile,finalTarget:identityFile,operationId});
  const authority=async()=>{if(await validateOffline(facts)===false)throw recovery();};
  await authority();
  const original=await offlineIdentitySnapshot(identityFile);
  if(original.record)validateBinding(original.record,normalizeRelayOrigin(relayUrl),pairingHash(gatewaySecret));
  const record=original.authority?original.authority.entry.record:plainRecord(original.record),
    state=original.authority?original.authority.entry.state:original.record.status;
  await authority();
  const owner=original.authority??await authorityForMutation(identityFile,()=>{throw recovery();});
  if(owner.entry.state!==state||!isDeepStrictEqual(owner.entry.record,record))throw recovery();
  await authority();await ensureMarker(owner);
  const settled=await offlineIdentitySnapshot(identityFile);
  if(!settled.authority)throw recovery();
  if(sharedIdentityFile!==undefined){
    if(typeof sharedIdentityFile!=='string'||resolve(sharedIdentityFile)!==sharedIdentityFile||sharedIdentityFile===identityFile)throw recovery();
    if(await validateOffline({domain:'gateway-relay-identity-source',source:sharedIdentityFile,finalTarget:sharedIdentityFile,operationId})===false)throw recovery();
    if(!isDeepStrictEqual((await offlineIdentitySnapshot(sharedIdentityFile)).key,settled.key))throw recovery();
  }
  if((await readdir(identityFile+STATE_SUFFIX)).sort().join(',')!=='reference.json')throw recovery();
  const files=await epochFiles(settled.authority.root);
  const transfer=await offlineSourceTransferReceipt(identityFile,settled.authority,files);
  const paths={projection:await maybeStat(identityFile)?identityFile:null,
    referenceDirectory:identityFile+STATE_SUFFIX,epochDirectory:settled.authority.root,
    ...(transfer?{transferReceiptDirectory:transfer.directory,
      transferReceiptFile:join(transfer.directory,'reference.json')}:{})},identities={},held=[];
  let primaryFailure;
  try{
    for(const [kind,path] of Object.entries(paths)){
      if(path===null){identities[kind]=null;continue;}
      const directory=!['projection','transferReceiptFile'].includes(kind),named=await lstat(path,{bigint:true});
      if(observeMetadata!==undefined){
        if(typeof observeMetadata!=='function'||named.isSymbolicLink()||(directory?!named.isDirectory():!named.isFile()))throw recovery();
        identities[kind]=observeMetadata(path,directory?'directory':'file');
        continue;
      }
      const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0)|(directory?(constants.O_DIRECTORY||0):0));held.push({path,file});
      const actual=await file.stat({bigint:true});
      if(named.isSymbolicLink()||!sameFile(named,actual)||(directory?!actual.isDirectory():!actual.isFile()))throw recovery();
      identities[kind]={dev:String(actual.dev),ino:String(actual.ino)};
    }
    if(observeMetadata===undefined&&(identities.epochDirectory.dev!==settled.authority.reference.dev||identities.epochDirectory.ino!==settled.authority.reference.ino))throw recovery();
    await authority();
    const current=await offlineIdentitySnapshot(identityFile);
    if(!isDeepStrictEqual(current.key,settled.key)||current.authority.entry.state!==state||!isDeepStrictEqual(current.authority.entry.record,record))throw recovery();
    if(sharedIdentityFile!==undefined&&!isDeepStrictEqual((await offlineIdentitySnapshot(sharedIdentityFile)).key,current.key))throw recovery();
    if(!isDeepStrictEqual(await offlineSourceTransferReceipt(identityFile,current.authority,files),transfer))throw recovery();
    for(const {path,file} of held)if(!sameFile(await file.stat({bigint:true}),await lstat(path,{bigint:true})))throw recovery();
    return {operationId,identityFile,status:state,generation:current.authority.entry.generation,decision:current.authority.hash,
      ...(transfer?{transferReceipt:transfer.value}:{}),...(sharedIdentityFile===undefined?{}:{sharedIdentityFile}),paths,identities};
  }catch(error){primaryFailure=error;throw error;}
  finally{
    const closed=await Promise.allSettled(held.map(({file})=>file.close())),failure=closed.find(value=>value.status==='rejected');
    if(failure&&!primaryFailure)throw commitUnconfirmed(failure.reason);
  }
}

async function epochFiles(root){
  const files=[];
  const visit=async(directory,prefix='',depth=0)=>{
    if(depth>=MAX_GENERATION_DEPTH)throw recovery();
    await identityDirectory(directory);
    const names=(await readdir(directory)).sort();
    const allowed=depth===0?['entry.json','legacy-seed.json','marker.json','next']:['entry.json','next'];
    if(names.some(name=>!allowed.includes(name))||!names.includes('entry.json')||depth===0&&!names.includes('marker.json'))throw recovery();
    for(const name of names){
      if(name==='next'){await visit(join(directory,name),prefix+'next/',depth+1);continue;}
      files.push({name:prefix+name,...await readStateBytes(join(directory,name),{singleLink:name!=='marker.json'})});
    }
  };
  await visit(root);return files;
}

async function publishEpochCopy(target,files){
  if(await maybeStat(target)){
    const existing=await epochFiles(target);
    if(existing.length!==files.length||existing.some((file,index)=>file.name!==files[index].name||!file.bytes.equals(files[index].bytes)))throw recovery();
    return;
  }
  const parent=dirname(target),prefix=join(parent,'.relay-identity-candidate-');
  const candidate=await createCandidateDirectory(prefix);let published=false;
  try{
    for(const file of files){const path=join(candidate,file.name);await mkdir(dirname(path),{recursive:true});await writeIdentityFile(path,file.bytes);}
    for(let depth=MAX_GENERATION_DEPTH-1;depth>=0;depth--){
      const directory=join(candidate,...Array(depth).fill('next'));
      if(await maybeStat(directory))await syncDirectory(directory);
    }
    if(await maybeStat(target))throw recovery();
    await rename(candidate,target);published=true;await syncDirectory(parent);
  }catch(error){if(published&&filesystemError(error))throw commitUnconfirmed(error);throw error;}
  finally{if(!published)await rm(candidate,{recursive:true,force:true}).catch(()=>{});}
}

/** The existing identity owner performs an explicit offline relocation. It
 * preserves the exact generation/decision chain at an independent final epoch;
 * neither registration nor secret generation is part of this operation. */
async function prepareOfflineIdentityRelocation({stateDirectory,identityFile,legacyIdentityFile,relayUrl,gatewaySecret,relocation}){
  const {operationId,validateOffline}=relocation??{};
  if(typeof operationId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)||typeof validateOffline!=='function'||
    typeof legacyIdentityFile!=='string'||resolve(legacyIdentityFile)!==legacyIdentityFile||
    identityFile!==undefined&&(typeof identityFile!=='string'||resolve(identityFile)!==identityFile))throw recovery();
  const source=legacyIdentityFile,finalTarget=identityFile??resolveIdentityFile({},stateDirectory),directory=dirname(finalTarget);
  if(source===finalTarget)throw recovery();
  const facts=Object.freeze({domain:'gateway-relay-identity',source,finalTarget,operationId});
  const authority=async()=>{if(await validateOffline(facts)===false)throw recovery();};
  await authority();
  const original=await offlineIdentitySnapshot(source);
  if(original.record)validateBinding(original.record,normalizeRelayOrigin(relayUrl),pairingHash(gatewaySecret));
  if(!original.authority)throw identityError('RELAY_IDENTITY_SOURCE_PREPARATION_REQUIRED','Prepare the observed Relay source before capturing its migration inventory');
  const files=await epochFiles(original.authority.root);
  await offlineSourceTransferReceipt(source,original.authority,files);
  const receiptPath=finalTarget+'.relocation-v1',receipt={version:1,...facts,sourceIdentity:original.key};
  const existing=await maybeStat(receiptPath);
  if(!existing){
    if(await maybeStat(finalTarget)||await maybeStat(finalTarget+STATE_SUFFIX)||
      await maybeStat(join(directory,basename(original.authority.root))))throw recovery();
    await identityDirectory(directory,true);await authority();
    await publishEntry(receiptPath,receipt,{reference:true});
  }
  const observed=JSON.parse((await readStateBytes(join(receiptPath,'reference.json'))).bytes);
  if(!isDeepStrictEqual(observed,receipt))throw recovery();
  const epoch=join(directory,basename(original.authority.root));
  await authority();
  if(!isDeepStrictEqual((await offlineIdentitySnapshot(source)).key,original.key))throw recovery();
  await publishEpochCopy(epoch,files);
  const info=await lstat(epoch,{bigint:true}),reference={...original.authority.reference,epoch,dev:String(info.dev),ino:String(info.ino),role:'canonical'};
  const prepared=await publishReference(finalTarget,reference);
  if(!isDeepStrictEqual(prepared.reference,reference))throw recovery();
  await ensureMarker(prepared);
  await authority();
  const current=await offlineIdentitySnapshot(source),target=await loadAuthority(finalTarget);
  if(!isDeepStrictEqual(current.key,original.key)||!target||target.entry.state!==original.authority.entry.state||
    !isDeepStrictEqual(target.entry.record,original.authority.entry.record)||
    target.entry.generation!==original.authority.entry.generation||target.hash!==original.authority.hash)throw recovery();
  await validatePointer(target);return finalTarget;
}

/** Preserve a real alias by publishing only its reference to this operation's
 * already verified target epoch. Its authority is never copied independently. */
async function offlineSharedIdentityRelocation({identityFile,legacyIdentityFile,relayUrl,gatewaySecret,relocation},publish){
  const {operationId,validateOffline,sharedIdentityFile,sourceSharedIdentityFile}=relocation??{};
  if(typeof operationId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)||typeof validateOffline!=='function'||
    [identityFile,legacyIdentityFile,sharedIdentityFile,sourceSharedIdentityFile].some(path=>typeof path!=='string'||resolve(path)!==path)||
    identityFile===legacyIdentityFile||identityFile===sharedIdentityFile||legacyIdentityFile===sourceSharedIdentityFile)throw recovery();
  const facts={domain:'gateway-relay-identity',source:legacyIdentityFile,finalTarget:identityFile,operationId};
  const authority=async()=>{if(await validateOffline(facts)===false)throw recovery();};
  await authority();
  const source=await offlineIdentitySnapshot(legacyIdentityFile),canonicalSource=await offlineIdentitySnapshot(sourceSharedIdentityFile);
  if(!source.authority||!isDeepStrictEqual(source.key,canonicalSource.key))throw recovery();
  await verifyInstanceIdentityRelocation({identityFile:sharedIdentityFile,legacyIdentityFile:sourceSharedIdentityFile,
    relayUrl,gatewaySecret,operationId,validateOffline});
  const canonicalTarget=await offlineIdentitySnapshot(sharedIdentityFile);
  const projection=await maybeStat(legacyIdentityFile)?await readStateBytes(legacyIdentityFile,{singleLink:false,maximum:MAX_IDENTITY_BYTES}):null;
  if(projection&&JSON.parse(projection.bytes).version!==1)throw recovery();
  if(publish){
    const existing=await loadAuthority(identityFile);
    if(!existing&&await maybeStat(identityFile))throw recovery();
    if(!projection&&await maybeStat(identityFile))throw recovery();
    await identityDirectory(dirname(identityFile),true);await authority();
    await publishReference(identityFile,{...canonicalTarget.authority.reference,role:'relocated-target'});
    if(projection){
      try{await writeIdentityFile(identityFile,projection.bytes);await syncDirectory(dirname(identityFile));}
      catch(error){if(error.code!=='EEXIST')throw error;}
    }
  }
  const target=await offlineIdentitySnapshot(identityFile);
  if(!target.authority||!isDeepStrictEqual(target.key,canonicalTarget.key))throw recovery();
  if(projection){
    const copied=await readStateBytes(identityFile,{maximum:MAX_IDENTITY_BYTES});
    if(!copied.bytes.equals(projection.bytes)||!await namedFileMatches(legacyIdentityFile,await lstat(legacyIdentityFile,{bigint:true}),projection.stat))throw recovery();
  }else if(await maybeStat(identityFile)||await maybeStat(legacyIdentityFile))throw recovery();
  await authority();
  if(!isDeepStrictEqual((await offlineIdentitySnapshot(legacyIdentityFile)).key,source.key)||
    !isDeepStrictEqual((await offlineIdentitySnapshot(sourceSharedIdentityFile)).key,source.key)||
    !isDeepStrictEqual((await offlineIdentitySnapshot(sharedIdentityFile)).key,target.key))throw recovery();
  return publish?identityFile:{operationId,generation:target.key.generation,decision:target.key.decision,status:target.authority.entry.state};
}

/** Inspect a completed transfer through the original owner without creating or
 * reconciling any receipt, marker, reference or generation. */
export async function verifyInstanceIdentityRelocation({identityFile,legacyIdentityFile,relayUrl,gatewaySecret,operationId,validateOffline,
  sharedIdentityFile,sourceSharedIdentityFile}={}){
  if(sharedIdentityFile!==undefined)return offlineSharedIdentityRelocation({identityFile,legacyIdentityFile,relayUrl,gatewaySecret,
    relocation:{operationId,validateOffline,sharedIdentityFile,sourceSharedIdentityFile}},false);
  if(typeof operationId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)||typeof validateOffline!=='function'||
    typeof identityFile!=='string'||resolve(identityFile)!==identityFile||typeof legacyIdentityFile!=='string'||
    resolve(legacyIdentityFile)!==legacyIdentityFile||identityFile===legacyIdentityFile)throw recovery();
  const facts=Object.freeze({domain:'gateway-relay-identity',source:legacyIdentityFile,finalTarget:identityFile,operationId});
  const authority=async()=>{if(await validateOffline(facts)===false)throw recovery();};
  await authority();
  const source=await offlineIdentitySnapshot(legacyIdentityFile),target=await offlineIdentitySnapshot(identityFile);
  if(!source.authority||!target.authority)throw recovery();
  if(source.record)validateBinding(source.record,normalizeRelayOrigin(relayUrl),pairingHash(gatewaySecret));
  if(target.record)validateBinding(target.record,normalizeRelayOrigin(relayUrl),pairingHash(gatewaySecret));
  const receipt=JSON.parse((await readStateBytes(join(identityFile+'.relocation-v1','reference.json'))).bytes);
  if(!isDeepStrictEqual(receipt,{version:1,...facts,sourceIdentity:source.key})||
    source.authority.root===target.authority.root||sameFile(source.authority.reference,target.authority.reference)||
    source.authority.entry.state!==target.authority.entry.state||source.authority.hash!==target.authority.hash||
    source.authority.entry.generation!==target.authority.entry.generation||!isDeepStrictEqual(source.authority.entry.record,target.authority.entry.record))throw recovery();
  const before=await epochFiles(source.authority.root),after=await epochFiles(target.authority.root);
  await offlineSourceTransferReceipt(legacyIdentityFile,source.authority,before);
  if(before.length!==after.length||before.some((file,index)=>file.name!==after[index].name||!file.bytes.equals(after[index].bytes)))throw recovery();
  await authority();
  if(!isDeepStrictEqual((await offlineIdentitySnapshot(legacyIdentityFile)).key,source.key)||
    !isDeepStrictEqual((await offlineIdentitySnapshot(identityFile)).key,target.key))throw recovery();
  return {operationId,generation:source.authority.entry.generation,decision:source.authority.hash,status:source.authority.entry.state};
}

function validateBinding(record, origin, configuredPairingHash) {
  if (record.relayOrigin !== origin) throw new Error('Client identity belongs to a different relay origin');
  if (configuredPairingHash && record.gatewaySecretHash !== configuredPairingHash) {
    throw new Error('Client identity belongs to a different Gateway internal secret');
  }
}

/** Load a registered identity, requiring an exact relay and optional internal-secret match. */
export async function readRegisteredClientIdentity({ identityFile = DEFAULT_IDENTITY_FILE, relayUrl, gatewaySecret, requireSingleLink = false, allowUnregistered = false } = {}) {
  const record = await readRecord(identityFile, requireSingleLink);
  if (allowUnregistered && (!record || record.status === 'pending')) return null;
  if (!record) throw new Error('Client identity file does not exist');
  if (record.status !== 'registered') throw new Error('Client identity is not registered; connect the relay client first');
  const origin = normalizeRelayOrigin(relayUrl);
  const tokenHash = gatewaySecret === undefined ? undefined : pairingHash(gatewaySecret);
  validateBinding(record, origin, tokenHash);
  return { id: record.id, secret: record.secret };
}

/** Read only the assigned Gateway ID for routing and QR generation. */
export async function readRegisteredClientId(options = {}) {
  return (await readRegisteredClientIdentity(options))?.id ?? null;
}

/** Load the cached identity or atomically create a durable enrollment proof. */
export async function prepareClientIdentity({ identityFile = DEFAULT_IDENTITY_FILE, relayUrl, gatewaySecret } = {}) {
  const path = resolve(identityFile);
  const origin = normalizeRelayOrigin(relayUrl);
  if(path===DEFAULT_IDENTITY_FILE&&!await loadAuthority(path)&&!await maybeStat(path)&&
    (await maybeStat(LEGACY_DEFAULT_IDENTITY_FILE)||await maybeStat(LEGACY_DEFAULT_IDENTITY_FILE+STATE_SUFFIX))){
    if(gatewaySecret===undefined)throw identityError('RELAY_IDENTITY_RECOVERY_REQUIRED','Restore the original Gateway internal secret to migrate the existing Relay identity');
    const source=await loadAuthority(LEGACY_DEFAULT_IDENTITY_FILE);
    if(source&&dirname(source.reference.epoch)!==dirname(path))throw recovery();
    await prepareInstanceIdentityFile({identityFile:path,legacyIdentityFile:LEGACY_DEFAULT_IDENTITY_FILE,relayUrl,gatewaySecret,requireEpochAtDestination:true});
  }
  let tokenHash;
  if (gatewaySecret !== undefined) tokenHash = pairingHash(gatewaySecret);
  let authority=await loadAuthority(path);
  const existing = await readRecord(path);
  if (existing) {
    validateBinding(existing, origin, tokenHash);
    if (existing.status === 'registered') {
      if(authority)await ensureMarker(authority);
      const current=await readRecord(path);validateBinding(current,origin,tokenHash);
      if(current.status!=='registered')throw recovery();
      return { status: 'registered', id: current.id, secret: current.secret };
    }
    if (!tokenHash) throw new Error('Configure KCODER_RELAY_GATEWAY_SECRET to resume client registration');
    if(!authority)authority=await authorityForMutation(path,()=>{throw recovery();});
  }else{
    if (!tokenHash) throw new Error('Configure KCODER_RELAY_GATEWAY_SECRET before client registration');
    authority=await authorityForMutation(path,()=>validateRecord({version:1,relayOrigin:origin,gatewaySecretHash:tokenHash,
      enrollmentToken:randomBytes(32).toString('base64url')}));
  }
  if(authority.entry.state==='revoked')throw revoked();
  await ensureMarker(authority);
  const winner=await readRecord(path);validateBinding(winner,origin,tokenHash);
  if(winner.status==='registered')return {status:'registered',id:winner.id,secret:winner.secret};
  return {status:'pending',enrollmentToken:winner.enrollmentToken};
}

/** Commit one assignment after registration, preserving the generation's decisions. */
export async function saveRegisteredClientIdentity({ identityFile = DEFAULT_IDENTITY_FILE, relayUrl, gatewaySecret, enrollmentToken, id, secret } = {}) {
  if (!validCredential(enrollmentToken)) throw new Error('Invalid client enrollment token');
  if (typeof id !== 'string' || !GATEWAY_ID.test(id) || !validCredential(secret)) throw new Error('Invalid registered client credentials');
  const origin = normalizeRelayOrigin(relayUrl);
  const tokenHash = pairingHash(gatewaySecret);
  const path=resolve(identityFile),authority=await loadAuthority(path);
  const existing = await readRecord(path);
  if (!existing) throw new Error('Pending client identity disappeared during registration');
  validateBinding(existing, origin, tokenHash);
  if (existing.status === 'registered') {
    if (existing.id !== id || existing.secret !== secret) throw new Error('Registered client identity changed unexpectedly');
    return { id, secret };
  }
  if (existing.enrollmentToken !== enrollmentToken) throw new Error('Client enrollment proof changed during registration');
  // A late writer cannot recreate a lost or revoked generation from its old proof.
  if(!authority)throw recovery();
  const record={
    version: 1,
    relayOrigin: origin,
    gatewaySecretHash: tokenHash,
    id,
    secret,
  };
  const after=await appendDecision(authority,'registered',record);
  if(after.entry.state==='revoked')throw revoked();
  if(after.entry.state!=='registered'||after.entry.record.id!==id||after.entry.record.secret!==secret)
    throw identityError('RELAY_IDENTITY_CONFLICT','Registered client identity changed unexpectedly');
  return { id, secret };
}

/** Read the current authority before a registration send or control reconnect. */
export async function assertClientIdentityActive({identityFile=DEFAULT_IDENTITY_FILE,relayUrl,gatewaySecret,enrollmentToken,id,secret}={}){
  const record=await readRecord(identityFile,true);
  if(!record)throw recovery();
  validateBinding(record,normalizeRelayOrigin(relayUrl),gatewaySecret===undefined?undefined:pairingHash(gatewaySecret));
  if(enrollmentToken!==undefined&&(record.status!=='pending'||record.enrollmentToken!==enrollmentToken)||
    id!==undefined&&(record.status!=='registered'||record.id!==id||record.secret!==secret))throw identityError('RELAY_IDENTITY_CONFLICT','Relay identity authority changed before use');
}
