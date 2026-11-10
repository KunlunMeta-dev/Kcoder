import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { AppServerStdioClient, waitForStdioChildClose } from './app-server-stdio.mjs';
export async function observeOriginalForegroundChannels(context,fixture,ui,{owner=ui.gateway.child,requireScopeFence=false,expectedSdks=2,label='original-foreground-channel-pidfds',attachTimeoutMs=15000}={}){
 assert.ok(Number.isInteger(expectedSdks) && expectedSdks >= 0 && expectedSdks <= 8);
 assert.ok(expectedSdks > 0 || requireScopeFence, 'A Core-only observation requires the original scope fence');
 assert.ok(Number.isInteger(attachTimeoutMs) && attachTimeoutMs >= 1000 && attachTimeoutMs <= 60000);
 const child=context.spawnOwned(label,'/usr/bin/python3',['-u',fileURLToPath(new URL('./native-channel-foreground-pidfd.py',import.meta.url)),
  String(owner.pid),String(fixture.uid),fixture.imageSha256,fixture.nodeImageSha256,requireScopeFence?fixture.profile:'',String(expectedSdks)],{stdin:'pipe'});
 const client=new AppServerStdioClient(label,child,{defaultTimeoutMs:15000});
 const request=async (method,params={},timeoutMs)=>{const response=await client.request(method,params,timeoutMs);assert.equal(response.error,undefined,method+': '+response.error?.message);return response.result;};
 const original=await attachOriginalForegroundTree(
  timeout=>client.request('attach',{},timeout),{timeoutMs:attachTimeoutMs});
 context.addCleanup('close original foreground-only pidfd observer',async()=>{
  if(requireScopeFence)await request('cleanup');
  child.stdin.end();await waitForStdioChildClose(child,5000,label);client.closeReader();await context.stopOwned(label);
 });
 return{original,read:()=>request('observe'),inspectScopeWait:()=>request('inspect_scope_wait'),freezeScope:()=>request('freeze_scope'),retireScopeControl:()=>request('retire_scope_control'),releaseScope:()=>request('release_scope'),loseScopeOwners:()=>request('lose_scope_owners'),crashCore:()=>request('crash_core')};
}

/** Reobserve only an incomplete original tree, never a failed identity check. */
export async function attachOriginalForegroundTree(observe,
 {timeoutMs,now=Date.now,delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
 const deadline=now()+timeoutMs;
 for(;;){
  const response=await observe(Math.max(1,deadline-now()));
  if(!response.error)return response.result;
  assert.ok(response.error.data?.incomplete===true && now()<deadline,
   `attach: ${response.error.message}`);
  await delay(Math.min(100,deadline-now()));
 }
}
