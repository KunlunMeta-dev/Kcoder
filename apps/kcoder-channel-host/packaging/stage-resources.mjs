// Build-owned public resources. No credential/profile/session data is staged.
import { mkdtemp, mkdir, lstat, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stageNativeConnectivityBundle } from '../scripts/stage-native-resources.mjs';

export async function stageConnectivityResources({destination,replace=false,stageBundle=stageNativeConnectivityBundle,renamePath=rename}={}) {
  if (!isAbsolute(destination)) throw Error('CHANNEL_STAGE_ABSOLUTE_DESTINATION_REQUIRED');
  destination=resolve(destination);const parent=dirname(destination);
  await mkdir(parent,{recursive:true});
  let existing=null;
  try {
    existing=await lstat(destination);
  } catch(error) { if(error.code!=='ENOENT')throw error; }
  if(existing) {
    if(!replace||!existing.isDirectory()||existing.isSymbolicLink())throw Error('CHANNEL_STAGE_DESTINATION_EXISTS');
    try {
      const old=JSON.parse(await readFile(join(destination,'channel-resource-manifest.json'),'utf8'));
      if(old?.schemaVersion!==1||old.name!=='@kunlunmeta/kcoder-channel-host')throw Error('CHANNEL_STAGE_DESTINATION_NOT_OWNED');
    } catch(error) {throw new Error('CHANNEL_STAGE_DESTINATION_NOT_OWNED',{cause:error});}
  }
  const owned=await mkdtemp(join(parent,'.kcoder-channel-stage-'));
  try {
    const staged=await stageBundle({output:join(owned,'component'),nodeProgram:process.execPath,bundleNode:process.platform==='darwin'});
    // Retain the previous generated tree as build evidence instead of deleting
    // an installation or a component another process may still be observing.
    let current=null;
    try {current=await lstat(destination);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(existing ? !current||!current.isDirectory()||current.isSymbolicLink()||current.dev!==existing.dev||current.ino!==existing.ino : current)
      throw Error('CHANNEL_STAGE_DESTINATION_CHANGED');
    const previous=existing?destination+'.previous-'+randomUUID():null;
    if(previous)await renamePath(destination,previous);
    try {
      await renamePath(join(owned,'component'),destination);
    } catch(error) {
      if(previous) {
        try {
          let occupied=false;
          try {await lstat(destination);occupied=true;}catch(probe){if(probe.code!=='ENOENT')throw probe;}
          if(occupied)throw Error('CHANNEL_STAGE_ROLLBACK_DESTINATION_OCCUPIED');
          await renamePath(previous,destination);
        } catch(rollback) {throw new AggregateError([error,rollback],'CHANNEL_STAGE_PUBLISH_AND_ROLLBACK_FAILED');}
      }
      throw error;
    }
    return {schemaVersion:1,componentRoot:destination,manifestSha256:staged.manifestSha256,nodeMinimumMajor:22};
  } finally {await rm(owned,{recursive:true,force:true});}
}
