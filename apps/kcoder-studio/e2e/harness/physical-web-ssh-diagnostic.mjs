import assert from 'node:assert/strict';
import {normalizeServer,launchSpec} from '../../src/server-config.js';
import {AppServerStdioClient} from './app-server-stdio.mjs';
import {physicalWindowsServer} from './physical-web-windows.mjs';
export async function diagnosePhysicalProductSsh(context,remote,{host,user}){
 const server=normalizeServer(physicalWindowsServer(remote.root,'ssh-owner',host,user),{platform:process.platform});
 const spec=launchSpec(server),child=context.spawnOwned('physical-product-ssh-diagnostic',spec.command,spec.args,{stdin:'pipe'});
 let stderrBytes=0;child.stderr.on('data',data=>{stderrBytes+=data.length});
 const rpc=new AppServerStdioClient('product actual Windows SSH preflight',child,{defaultTimeoutMs:12000});
 let initialized,errorType;
 try{const frame=await rpc.request('initialize',{protocolVersion:'2026-07-27',clientInfo:{name:'owned-product-ssh-preflight',version:'1'}});assert.equal(frame.error,undefined);assert.ok(frame.result.cwd?.startsWith(remote.root));initialized={cwd:frame.result.cwd,serverInfo:frame.result.serverInfo};}
 catch(error){errorType=error.name;}
 finally{child.stdin.end();await Promise.race([new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('close',resolve)}),new Promise(resolve=>setTimeout(resolve,3000))]);if(child.exitCode===null)await context.stopOwned('physical-product-ssh-diagnostic');rpc.closeReader();}
 const records=JSON.parse((await remote.ps(`$r='${remote.root}';@(Get-ChildItem -LiteralPath (Join-Path $r 'profiles') -Filter 'launch-owner-*.json' -Recurse -File|ForEach-Object{$v=Get-Content -LiteralPath $_.FullName -Raw|ConvertFrom-Json;@{parentPid=$v.parentPid;childPid=$v.childPid;parentFileTime=$v.parentFileTime;childFileTime=$v.childFileTime}})|ConvertTo-Json -Compress`)).trim()||'[]');
 const result={passed:Boolean(initialized),scope:'actual product launchSpec SSH/windows initialize only; no Gateway success/public request claim',initialized,errorType,exitCode:child.exitCode,signalCode:child.signalCode,stderrBytes,records};await context.writeArtifactJson('physical-product-ssh-diagnostic.json',result);return result;
}
