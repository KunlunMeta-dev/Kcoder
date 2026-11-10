import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'node:net';
import {runE2E,waitFor} from '../../harness/run-context.mjs';
import {startGateway} from '../../harness/gateway.mjs';
import {windowsSshInvocation} from '../../harness/windows-ssh-auth.mjs';
import {stagePhysicalWebWindows,physicalWindowsServer,preflightPhysicalWindowsHost} from '../../harness/physical-web-windows.mjs';
import {diagnosePhysicalProductSsh} from '../../harness/physical-web-ssh-diagnostic.mjs';
import {startPhysicalWebModel,exercisePhysicalWebTarget} from '../../harness/physical-web-protocol.mjs';

const target=process.env.KCODER_E2E_PHYSICAL_WEB_TARGET;
const executeWeb=process.argv.includes('--execute-web');
if(executeWeb)assert.equal(process.env.KCODER_E2E_PHYSICAL_WEB_EXECUTE,'1','Explicit finite physical Fetch lane required');
assert.equal(process.env.KCODER_E2E_WINDOWS_NATIVE_LIBTEST,'1','Explicit native consent required');
if(executeWeb)assert.equal(process.env.KCODER_E2E_WEB_EXTERNAL_NETWORK,'1','Two fixed HTTPS Fetches require external consent');
assert.match(target??'',/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/);
const [user,host]=target.split('@');
const options={nativeBuildResult:process.env.KCODER_E2E_PHYSICAL_WEB_NATIVE_BUILD_RESULT,target,node:process.env.KCODER_E2E_WINDOWS_NODE,parent:process.env.KCODER_E2E_WINDOWS_PROBE_PARENT,
 archive:process.env.KCODER_E2E_PHYSICAL_WEB_ARCHIVE,membersFile:process.env.KCODER_E2E_PHYSICAL_WEB_MEMBERS,privateUrlFile:process.env.KCODER_E2E_PHYSICAL_WEB_PRIVATE_URL_FILE,archiveBytes:Number(process.env.KCODER_E2E_PHYSICAL_WEB_ARCHIVE_BYTES),archiveSha256:process.env.KCODER_E2E_PHYSICAL_WEB_ARCHIVE_SHA256,
 launcher:process.env.KCODER_E2E_PHYSICAL_WEB_LAUNCHER,cliSha256:process.env.KCODER_E2E_WINDOWS_EXPECTED_CLI_SHA256,
 gatewaySourceCommit:process.env.KCODER_E2E_PHYSICAL_WEB_GATEWAY_SOURCE_COMMIT,
 sourceCommit:process.env.KCODER_E2E_WINDOWS_EXPECTED_COMMIT,nativeConsent:process.env.KCODER_E2E_WINDOWS_NATIVE_LIBTEST};
assert.match(options.sourceCommit??'',/^[a-f0-9]{40}$/);assert.match(options.gatewaySourceCommit??'',/^[a-f0-9]{40}$/);
await runE2E(import.meta.url,{testId:'physical-windows-ssh-http-native-web',tier:'manual-live',cleanupTimeoutMs:60000,
 modelPolicy:executeWeb?'Root actual product Gateway SSH/windows stdio and Root HTTP/WS to an owned physical Windows Gateway; at most one fixed official Python HTTPS Fetch per transport, normal ASK, zero Search, deterministic localhost model, original receipt read after disconnect and independent profiles.':'Zero-public preflight of actual product physical Windows SSH/HTTP Gateway transport with independent owned profiles and deterministic local model echo; no account creation, installation or personal settings.'},async context=>{
 const prerequisite=await preflightPhysicalWindowsHost(context,options);
 if(process.argv.includes('--check-host'))return{passed:true,scope:'read-only physical host prerequisites only',prerequisite,publicFetches:0};
 const model=await startPhysicalWebModel(context,{executeWeb});
 const modelPort=Number(new URL(model.baseUrl).port);
 const reverseArgs=['-T','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ControlPath=none','-o','ExitOnForwardFailure=yes','-N','-R',`127.0.0.1:0:127.0.0.1:${modelPort}`,target];
 const reverseSpec=windowsSshInvocation(context,'ssh',reverseArgs,target),reverse=context.spawnOwned('physical-model-reverse-forward',reverseSpec.command,reverseSpec.args,reverseSpec.options);
 let reverseLog='';reverse.stderr.on('data',data=>{reverseLog=(reverseLog+data).slice(-8192)});
 const remotePort=await waitFor(()=>{if(reverse.exitCode!==null)throw Error('Owned model reverse forward exited');return Number(/Allocated port (\d+)/.exec(reverseLog)?.[1])||null},20000,'owned physical model reverse forwarding',50,context.abortSignal);
 const gatewayToken=randomBytes(24).toString('base64url');context.registerSecret(gatewayToken);
 const remote=await stagePhysicalWebWindows(context,{...options,gatewayToken,ownerEndpoint:`http://127.0.0.1:${remotePort}/v1`,peerEndpoint:`http://127.0.0.1:${remotePort}/v1`});
 if(process.argv.includes('--diagnose-ssh')){const result=await diagnosePhysicalProductSsh(context,remote,{host,user});assert.equal(result.passed,true,'Product physical SSH initialize prerequisite failed');return result;}
 const observation=JSON.parse((await remote.ps("$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$s=[Security.Cryptography.SHA256]::Create();$h=[BitConverter]::ToString($s.ComputeHash([Text.Encoding]::UTF8.GetBytes($sid))).Replace('-','').ToLowerInvariant();@{platform='windows';architecture=$env:PROCESSOR_ARCHITECTURE;accountIdentitySha256=$h;remoteMachine=$env:COMPUTERNAME;readOnly=$true;accountsCreated=0}|ConvertTo-Json -Compress")).trim());
 assert.equal(observation.platform,'windows');assert.equal(observation.architecture,'AMD64');
 await context.writeArtifactJson('physical-host-identity.json',observation);
 const clientProfile=context.pathInState('client-gateway-profile'),clientWorkspace=context.pathInState('client-workspace');await mkdir(clientProfile,{recursive:true});await mkdir(clientWorkspace,{recursive:true});
 await context.writeStateJson('client-gateway-profile/settings.json',{credential_store:'file',active_provider:'owned',model:'ssh-peer',max_retries:0,providers:{owned:{api_format:'openai_chat_completions',endpoint:model.baseUrl,default_model:'ssh-peer',authentication:{mode:'none'},discover_models:false,context_window_tokens:128000,max_output_tokens:512,output_headroom_tokens:4096}}});
 const servers=['ssh-owner','ssh-peer'].map(id=>physicalWindowsServer(remote.root,id,host,user));
 const serversFile=await context.writeStateJson('physical-ssh-servers.json',servers);
 const gatewayRoot=process.env.KCODER_E2E_PHYSICAL_WEB_GATEWAY_ROOT;
 assert.ok(gatewayRoot&&process.env.KCODER_E2E_PHYSICAL_WEB_CLIENT_BIN,'Explicit frozen product Gateway and local bootstrap binary required');
 const localGateway=await startGateway(context,{label:'physical-ssh-gateway',gatewayRoot:resolve(gatewayRoot),workspace:clientWorkspace,serversFile,kcoderBin:process.env.KCODER_E2E_PHYSICAL_WEB_CLIENT_BIN,auth:true,env:{KCODER_CONFIG_DIR:clientProfile,KCODER_STUDIO_WEB_ROOT:resolve(gatewayRoot,'../renderer-dist')}});
 const results=[];
 const httpOnly=process.argv.includes('--http-only');
 const sshOnly=process.argv.includes('--ssh-only');
 assert.ok(!(httpOnly&&sshOnly));
 try{
  if(!httpOnly)results.push(await exercisePhysicalWebTarget(context,{gateway:localGateway,model,transport:'ssh',remoteRoot:remote.root,executeWeb}));
  if(sshOnly)return{passed:true,results,scope:'physical SSH only'};
  const remoteGateway=await remote.request('startGateway');
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const localPort=reservation.address().port;context.registerPort('physical-http-forward',localPort);
  let released=false;context.addCleanup('release only owned HTTP forwarding reservation',async()=>{if(!released)await new Promise(resolve=>reservation.close(resolve))});
  const forwardArgs=['-T','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ControlPath=none','-o','ExitOnForwardFailure=yes','-N','-L',`127.0.0.1:${localPort}:127.0.0.1:${remoteGateway.port}`,target];
  const forwardSpec=windowsSshInvocation(context,'ssh',forwardArgs,target);
  await new Promise(resolve=>reservation.close(resolve));released=true;
  const forward=context.spawnOwned('physical-http-forward',forwardSpec.command,forwardSpec.args,forwardSpec.options);forward.stderr.resume();
  const httpGateway={baseUrl:`http://127.0.0.1:${localPort}`,wsUrl:`ws://127.0.0.1:${localPort}`,authToken:gatewayToken};
  await waitFor(async()=>{
   if(forward.exitCode!==null)throw Error('Owned HTTP forward exited');
   // The production token GET explicitly trusts this loopback tunnel authority.
   const url=new URL('/login',httpGateway.baseUrl);url.searchParams.set('token',gatewayToken);
   const response=await fetch(url,{redirect:'manual'}).catch(()=>null);
   if(!response||response.status!==303)return false;
   const cookie=(response.headers.get('set-cookie')||'').split(';',1)[0];
   if(!cookie.startsWith('kcoder_studio_session='))return false;
   context.registerSecret(cookie);httpGateway.bootstrapCookie=cookie;return true;
  },20000,'actual remote Gateway authenticated HTTP forwarding',100,context.abortSignal);
  results.push(await exercisePhysicalWebTarget(context,{gateway:httpGateway,model,transport:'http',remoteRoot:remote.root,executeWeb}));
 }finally{for(const id of ['ssh-owner','http-owner'])model.release(id);await context.writeArtifactJson('physical-model-counts.json',model.stats())}
 const stats=model.stats();await context.writeArtifactJson('physical-web-results.json',{results,stats,sourceCommit:options.sourceCommit,gatewaySourceCommit:options.gatewaySourceCommit,cliSha256:options.cliSha256,accountScope:'two distinct owned profiles under the same existing Windows account; no cross-account claim',networkMode:'direct set only in owned target profile settings; no inherit/system proxy repair claim',physicalHost:observation,localClientPlatform:process.platform,publicFetchLimit:executeWeb?2:0,publicSearches:0,paidModels:0});
 assert.equal(results.length,httpOnly?1:2);return{passed:true,results,stats};
});
