import {constants} from 'node:fs';
import {lstat,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const sourceFiles=new Set(['stdio.mjs','private-peer.mjs','store.mjs','store-bootstrap.mjs','validation.mjs','errors.mjs','native-results.mjs','service.mjs','task-sources.mjs','readiness-probe.mjs']);

/** Advisory startup evidence only. Never store source errors or credential values. */
export async function recordApplicationStartupFailure(error,{stage='EXIT',runtimeDirectory=`/run/user/${process.getuid?.()}`}={}){
 let directoryHandle;
 try{
  if(process.platform!=='linux')return false;
  const directory=await lstat(runtimeDirectory);
  if(!directory.isDirectory()||directory.isSymbolicLink())return false;
  directoryHandle=await open(runtimeDirectory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  const held=await directoryHandle.stat();
  if(!held.isDirectory()||held.dev!==directory.dev||held.ino!==directory.ino)return false;
  const hash=value=>createHash('sha256').update(String(value??'')).digest('hex');
  const frames=String(error?.stack??'').split('\n').slice(1).flatMap(line=>line.match(/[a-zA-Z0-9_-]+\.mjs:\d{1,5}:\d{1,5}(?!\d)/g)??[]).filter(value=>sourceFiles.has(value.split(':')[0])).slice(0,8);
  const value={version:1,pid:process.pid,stage:/^[A-Z_]{1,64}$/.test(stage)?stage:'EXIT',codeSha256:hash(error?.code),messageSha256:hash(error?.message),frames};
  // The Linux directory descriptor remains authoritative if an ancestor is renamed.
  const file=await open(`/proc/self/fd/${directoryHandle.fd}/kcoder-application-startup-${process.pid}.json`,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW);
  try{await file.writeFile(JSON.stringify(value)+'\n');await file.sync();}finally{await file.close();}
  return true;
 }catch{return false;}
 finally{await directoryHandle?.close().catch(()=>{});}
}
