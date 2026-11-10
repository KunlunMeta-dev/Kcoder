// Build-owned public resources. No credential/profile/session data is staged.
import { mkdtemp, mkdir, lstat, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stageNativeConnectivityBundle } from '../scripts/stage-native-resources.mjs';

export async function stageConnectivityResources({destination,replace=false}={}) {
  if (!isAbsolute(destination)) throw Error('CHANNEL_STAGE_ABSOLUTE_DESTINATION_REQUIRED');
  destination=resolve(destination);const parent=dirname(destination);
  await mkdir(parent,{recursive:true});
  let existing=false;
  try {
    const info=await lstat(destination);existing=true;
    if(!replace||!info.isDirectory()||info.isSymbolicLink())throw Error('CHANNEL_STAGE_DESTINATION_EXISTS');
    const old=JSON.parse(await readFile(join(destination,'channel-resource-manifest.json'),'utf8'));
    if(old.schemaVersion!==1||old.name!=='@kunlunmeta/kcoder-channel-host')throw Error('CHANNEL_STAGE_DESTINATION_NOT_OWNED');
  } catch(error) { if(error.code!=='ENOENT')throw error; }
  const owned=await mkdtemp(join(parent,'.kcoder-channel-stage-'));
  try {
    const staged=await stageNativeConnectivityBundle({output:join(owned,'component'),nodeProgram:process.execPath,bundleNode:process.platform==='darwin'});
    // Retain the previous generated tree as build evidence instead of deleting
    // an installation or a component another process may still be observing.
    if(existing)await rename(destination,destination+'.previous-'+randomUUID());
    await rename(join(owned,'component'),destination);
    return {schemaVersion:1,componentRoot:destination,manifestSha256:staged.manifestSha256,nodeMinimumMajor:22};
  } finally {await rm(owned,{recursive:true,force:true});}
}
