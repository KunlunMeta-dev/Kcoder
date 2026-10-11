import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startWindowsRemoteStudio } from '../../harness/windows-remote-studio.mjs';
import { startSshFixture } from '../../harness/ssh-fixture.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
const target=process.env.KCODER_E2E_WINDOWS_SSH_TARGET;
const windowsBinary=process.env.KCODER_E2E_WINDOWS_BINARY;
const installation=process.env.KCODER_E2E_WINDOWS_STUDIO_DIRECTORY;
const node=process.env.KCODER_E2E_WINDOWS_NODE;
if(!target||!windowsBinary||!installation||!node) throw new Error('Explicit Windows private probe prerequisites required');
await runE2E(import.meta.url, { testId:'windows-local-versus-ssh-model-scope', tier:'manual-live',
  modelPolicy:'private Windows Electron and real SSH Linux target; synthetic isolated model credential and HTTP protocol' }, async context=>{
  const {path:workspace}=await materializeWorkspace(context,'minimal',{instanceId:'windows-remote-model'});
  const model=await startApprovalModelFixture(context,{textOnly:true,textOnlyResponse:'WINDOWS_REMOTE_MODEL_DONE',httpErrorPrompt:'WINDOWS_REMOTE_FAILURE',httpErrorStatus:400,httpErrorMessage:'WINDOWS_REMOTE_MODEL_REJECTED'});
  const profile=context.pathInState('remote-profile');
  const key='remote-only-synthetic-model-key'; context.registerSecret(key);
  await context.writeStateJson('remote-profile/settings.json',{active_provider:'remote',providers:{remote:{
    api_format:'openai_chat_completions',endpoint:model.baseUrl,default_model:'remote-model',no_proxy:true,
    context_window_tokens:128000,max_output_tokens:4096,output_headroom_tokens:4096,
  }}});
  await context.writeStateJson('remote-profile/credentials.json',{remote:{type:'api',key}});
  const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
  const binary=resolve(repoRoot,'target/debug/kcoder');
  const launcher=context.pathInState('remote-kcoder');
  await writeFile(launcher,`#!/bin/sh\nexport KCODER_CONFIG_DIR=${quote(profile)}\nexec ${quote(binary)} "$@"\n`,{mode:0o700});
  const ssh=await startSshFixture(context);
  const windows=await startWindowsRemoteStudio(context,{target,windowsBinary,installation,node,ssh});
  const result=await windows.run('remote-models',{workspace,server:{id:'remote-models',label:'Remote model fixture',transport:'ssh',
    host:'127.0.0.1',port:ssh.port,user:ssh.user,command:launcher,workspace}},['windows-remote-model.png','windows-remote-model-failure.png']);
  assert.equal(result.windowsCredentialsEmpty,true);
  assert.equal(JSON.parse(await readFile(resolve(profile,'settings.json'),'utf8')).providers.remote.models['remote-model'].extra_body.temperature,0.6);
  assert.equal(model.requests.length,3,'remote probe, successful chat and rejected remote chat; no local fallback');
  assert.ok(model.requests.every(request=>request.model==='remote-model'));
  assert.equal(model.requests[1].temperature,0.6);
  await context.writeArtifactJson('binary-fingerprints.json',{windowsBootstrap:createHash('sha256').update(await readFile(windowsBinary)).digest('hex'),linuxTarget:createHash('sha256').update(await readFile(binary)).digest('hex')});
  return {...result,requestCount:model.requests.length};
});
