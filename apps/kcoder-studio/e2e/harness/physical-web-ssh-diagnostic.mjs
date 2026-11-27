import assert from 'node:assert/strict';
import {normalizeServer,launchSpec} from '../../src/server-config.js';
import {AppServerStdioClient,waitForStdioChildClose} from './app-server-stdio.mjs';
import {physicalWindowsServer} from './physical-web-windows.mjs';

export async function closePhysicalProductDiagnostic(context,child,rpc,{waitForClose=waitForStdioChildClose}={}){
 const errors=[];
 try{if(child.stdin&&!child.stdin.destroyed)child.stdin.end();}catch(error){errors.push(error);}
 try{await waitForClose(child,3000,'owned physical SSH diagnostic');}
 catch(error){
  if(child.exitCode===null&&child.signalCode===null){
   try{await context.stopOwned('physical-product-ssh-diagnostic');}catch(stopError){errors.push(stopError);}
  }else errors.push(error);
 }
 finally{
  try{rpc.closeReader();}catch(error){errors.push(error);}
  try{rpc.failPending?.(new Error('Owned physical diagnostic closed; pending outcomes remain unknown'));}catch(error){errors.push(error);}
 }
 if(errors.length)throw new AggregateError(errors,'Owned physical diagnostic cleanup was not confirmed');
}

export async function diagnosePhysicalProductSsh(context,remote,{host,user}){
 const server=normalizeServer(physicalWindowsServer(remote.root,'ssh-owner',host,user),{platform:process.platform});
 const spec=launchSpec(server),child=context.spawnOwned('physical-product-ssh-diagnostic',spec.command,spec.args,{stdin:spec.stdio?.[0]??'pipe'});
 let stderrBytes=0;child.stderr.on('data',data=>{stderrBytes+=data.length});
 const rpc=new AppServerStdioClient('product actual Windows SSH preflight',child,{defaultTimeoutMs:12000});
 let initialized,errorType,cleanupErrorType;
 child.stdin?.on('error',error=>{cleanupErrorType??=error.name;});
 try{const frame=await rpc.request('initialize',{protocolVersion:'2026-07-27',clientInfo:{name:'owned-product-ssh-preflight',version:'1'}});assert.equal(frame.error,undefined);assert.ok(frame.result.cwd?.startsWith(remote.root));initialized={cwd:frame.result.cwd,serverInfo:frame.result.serverInfo};}
 catch(error){errorType=error.name;}
 finally{
  try{await closePhysicalProductDiagnostic(context,child,rpc);}catch(error){cleanupErrorType??=error.name;}
 }
 const records=JSON.parse((await remote.ps(`$r='${remote.root}';@(Get-ChildItem -LiteralPath (Join-Path $r 'profiles') -Filter 'launch-owner-*.json' -Recurse -File|ForEach-Object{$v=Get-Content -LiteralPath $_.FullName -Raw|ConvertFrom-Json;@{parentPid=$v.parentPid;childPid=$v.childPid;parentFileTime=$v.parentFileTime;childFileTime=$v.childFileTime}})|ConvertTo-Json -Compress`)).trim()||'[]');
 const result={passed:Boolean(initialized)&&!cleanupErrorType,scope:'actual product launchSpec SSH/windows initialize only; no Gateway success/public request claim',initialized,errorType,cleanupErrorType,cleanup:cleanupErrorType?'unconfirmed':'confirmed',exitCode:child.exitCode,signalCode:child.signalCode,stderrBytes,records};await context.writeArtifactJson('physical-product-ssh-diagnostic.json',result);return result;
}
