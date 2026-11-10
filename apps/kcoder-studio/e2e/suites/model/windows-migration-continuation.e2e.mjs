import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runE2E, waitFor } from '../../harness/run-context.mjs';
import { realModelPreflight } from '../../harness/real-model.mjs';
import { startLiveModelObserver, liveModelRequestPath } from '../../harness/live-model-observer.mjs';
import { runWindowsPackageProbe } from '../../harness/windows-package-probe.mjs';
import { windowsSshInvocation } from '../../harness/windows-ssh-auth.mjs';

await runE2E(import.meta.url,{testId:'windows-real-model-migrated-task-continuation',tier:'real-model-credentialed',modelPolicy:'real provider required; two owned vendor histories, one new user turn each; bounded native Windows file tools; no personal history or credential copying'},async context=>{
  assert.equal(process.env.KCODER_E2E_REAL_MODEL,'1','explicit real-model gate required');
  const model=await realModelPreflight(process.env.KCODER_E2E_MODEL_PROFILE||'kunlunmeta');
  const store=JSON.parse(await readFile(resolve(model.configDir,'credentials.json'),'utf8'));
  const credential=store[model.provider];
  assert.equal(credential?.type,'api','approved API credential required; subscription tokens cannot be reused');
  assert.ok(credential.key);context.registerSecret(credential.key);
  const auth=model.providerConfig.api_format==='anthropic_messages'?{'x-api-key':credential.key}:{authorization:'Bearer '+credential.key};
  const observer=await startLiveModelObserver(context,model.providerConfig.endpoint,8,{upstreamHeaders:auth,requestTimeoutMs:65000,
    allowedPaths:[liveModelRequestPath(model.providerConfig.endpoint,model.providerConfig.api_format)],
    beforeForward:input=>{assert.equal(input.model,model.model);assert.ok(Number.isSafeInteger(input.outputTokenLimit)&&input.outputTokenLimit>0&&input.outputTokenLimit<=2048);return {budget:'at most 8 requests, 2048 output tokens each'};}});
  const endpoint=new URL(observer.endpoint),port=Number(endpoint.port),target=process.env.KCODER_E2E_WINDOWS_SSH_TARGET;
  const spec=windowsSshInvocation(context,'ssh',['-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=10','-S','none','-N','-R',`127.0.0.1:0:127.0.0.1:${port}`,target],target);
  const forward=context.spawnOwned('windows-live-model-forward',spec.command,spec.args,spec.options);
  let forwardedPort;forward.stderr.on('data',data=>{const match=/Allocated port (\d+) for remote forward/.exec(String(data));if(match)forwardedPort=Number(match[1]);});
  await waitFor(()=>{if(forward.exitCode!==null)throw Error('Owned encrypted model transport exited');return forwardedPort;},10000,'Windows allocated loopback model port');
  const nativeEndpoint=new URL(observer.endpoint);nativeEndpoint.port=String(forwardedPort);
  const options={target,node:process.env.KCODER_E2E_WINDOWS_NODE,parent:process.env.KCODER_E2E_WINDOWS_PROBE_PARENT,
    archive:process.env.KCODER_E2E_WINDOWS_PAYLOAD_ARCHIVE,archiveSha256:process.env.KCODER_E2E_WINDOWS_PAYLOAD_SHA256,
    nativeCommit: process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT, commit:process.env.KCODER_E2E_WINDOWS_EXPECTED_COMMIT,cliSha256:process.env.KCODER_E2E_WINDOWS_EXPECTED_CLI_SHA256,focus:'migration',
    taskContinuation:{authorized:true,endpoint:nativeEndpoint.href,name:model.model,apiFormat:model.providerConfig.api_format,forwardToken:observer.forwardToken}};
  let result;
  try{result=await runWindowsPackageProbe(context,options);}
  finally{await context.writeArtifactJson('real-model-continuation-observations.json',{model:model.model,requests:observer.observations,
    scope:'two short synthetic histories through actual Windows runtime; no mock model and no personal transcript bodies',credentialCopiedToWindows:false});}
  assert.equal(result.results.at(-1).details.results.length,2);
  assert.ok(observer.observations.length>=2&&observer.observations.length<=8);
  assert.ok(observer.observations.every(request=>request.status===200));
  return result;
});
