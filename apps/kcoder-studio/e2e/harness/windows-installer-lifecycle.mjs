import assert from 'node:assert/strict';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { repoRoot } from './run-context.mjs';
const execFileAsync=promisify(execFile);
export function validateWindowsInstallerInputs({target,installation,installer}){
 if(!/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/.test(target||''))throw Error('Explicit Windows SSH target required');
 if(typeof installation!=='string'||!/^C:\\Users\\[^\\]+\\AppData\\Local\\Programs\\/.test(installation)||installation.includes("'"))throw Error('Explicit personal installation baseline required');
 if(typeof installer!=='string'||!installer.endsWith('.exe'))throw Error('Actual NSIS installer required');
}
export async function verifyWindowsInstallerMechanism(context,options){
 validateWindowsInstallerInputs(options);
 const {target,installation,installer,newInstaller,exerciseUI=false,smokeOnly=false,node,expectedCommit,expectedCliSha256}=options;
 if(exerciseUI&&(!node||/['"\r\n]/.test(node)))throw Error('Explicit safe Windows Node path required');
 if(newInstaller&&(!exerciseUI||!newInstaller.endsWith('.exe')))throw Error('Upgrade requires actual installer and installed UI verification');
 if((newInstaller||expectedCommit||expectedCliSha256)&&(!/^[a-f0-9]{40}$/.test(expectedCommit||'')||!/^[a-f0-9]{64}$/.test(expectedCliSha256||'')))throw Error('Upgrade requires the frozen full source commit and expected CLI SHA256');
 const newSha256=newInstaller?createHash('sha256').update(await readFile(newInstaller)).digest('hex'):null;
 const owner=randomUUID(),username='kc_e2e_'+randomBytes(4).toString('hex');
 const password=randomBytes(24).toString('base64url')+'aA9!';context.registerSecret(password);
 const oldSha256=createHash('sha256').update(await readFile(installer)).digest('hex');
 let sequence=0;
 const argsFor=script=>['-o','BatchMode=yes','-S','none',target,'powershell','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);"+script,'utf16le').toString('base64')];
 const execute=(command,args,input,timeoutMs=300000)=>new Promise((resolve,reject)=>{
  const label=`windows-installer-${++sequence}`;
  const child=context.spawnOwned(label,command,args,{stdin:input===undefined?'ignore':'pipe'});
  let output='',error='';const timer=setTimeout(()=>{void context.stopOwned(label);reject(Error('Owned Windows installer command timed out'));},timeoutMs);
  child.stdout.on('data',bytes=>{output+=bytes;if(output.length>4*1024*1024)void context.stopOwned(label);});
  child.stderr.on('data',bytes=>{error=(error+bytes).slice(-8192)});
  child.once('error',error=>{clearTimeout(timer);reject(error)});
  child.once('close',code=>{clearTimeout(timer);code===0?resolve(output):reject(Error(`Owned Windows command failed (${code}): ${context.redactText(error||output).slice(-2500)}`))});
  if(input!==undefined)child.stdin.end(input);
 });
 const ps=(script,input,timeout)=>execute('ssh',argsFor(script),input,timeout);
 const snapshotScript=`$root='${installation}';$files=@{};foreach($leaf in @('kcoder-studio.exe','resources\\app.asar','resources\\bin\\kcoder.exe')){$p=Join-Path $root $leaf;if(!(Test-Path -LiteralPath $p)){throw 'Personal baseline resource missing'};$files[$leaf]=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash};$reg=@(Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'|ForEach-Object{Get-ItemProperty -LiteralPath $_.PSPath}|Where-Object{($_.InstallLocation -and $_.InstallLocation.TrimEnd('\\') -eq $root.TrimEnd('\\')) -or ($_.UninstallString -and $_.UninstallString.TrimStart('"').StartsWith(($root.TrimEnd('\\')+'\\'),[StringComparison]::OrdinalIgnoreCase))}|Select-Object DisplayName,DisplayVersion,InstallLocation,UninstallString);@{files=$files;registration=$reg}|ConvertTo-Json -Depth 5 -Compress`;
 const before=JSON.parse((await ps(snapshotScript)).trim());
 assert.equal(before.registration.length,1,'Personal per-user registration must be included in the read-only baseline');
 await context.writeArtifactJson('personal-installation-before.json',before);
 const directory=JSON.parse((await ps(`$p=Join-Path ([IO.Path]::GetTempPath()) 'kcoder-installer-${owner}';if(Test-Path -LiteralPath $p){throw 'Owned directory collision'};[IO.Directory]::CreateDirectory($p)|Out-Null;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;& icacls $p /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' ('*'+$sid+':(OI)(CI)F')|Out-Null;if($LASTEXITCODE -ne 0){throw 'Could not isolate run directory'};[IO.File]::WriteAllText((Join-Path $p '.owner.json'),'${JSON.stringify({owner,username})}');ConvertTo-Json -InputObject $p -Compress`)).trim());
 assert.ok(directory.endsWith('kcoder-installer-'+owner)&&!directory.includes("'"));
 const remote=directory.replaceAll('\\','/');
 const cleanupEvidence=context.pathInArtifacts('windows-cleanup.json');
 let cleanupUploaded=false;
 context.addCleanup('remove isolated Windows installer account and profile',async()=>{
  const cleanupScript=cleanupUploaded ? `& '${directory}\\cleanup.ps1' -RunRoot '${directory}' -Owner '${owner}' -Username '${username}'` : `$m=Get-Content -LiteralPath '${directory}\\.owner.json' -Raw|ConvertFrom-Json;if($m.owner -ne '${owner}' -or $m.username -ne '${username}'){throw 'Ownership mismatch'};[IO.Directory]::Delete('${directory}',$true);@{cleaned=$true;accountAbsent=$true;profileAbsent=$true;directoryAbsent=$true}|ConvertTo-Json -Compress`;
  const result=await execFileAsync('ssh',argsFor(cleanupScript),{timeout:90000,maxBuffer:2*1024*1024});
  const after=JSON.parse((await execFileAsync('ssh',argsFor(snapshotScript),{timeout:30000,maxBuffer:2*1024*1024})).stdout.trim());
  assert.deepEqual(after,before,'personal installation and registration must remain unchanged');
  await writeFile(cleanupEvidence,JSON.stringify({...JSON.parse(result.stdout.trim()),personalInstallationUnchanged:true}),{mode:0o600});
 });
 const upload=(source,leaf)=>execute('scp',['-o','BatchMode=yes','-o','ControlPath=none',source,`${target}:${remote}/${leaf}`],undefined,180000);
 await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-installer-cleanup.ps1'),'cleanup.ps1');cleanupUploaded=true;
 await context.writeArtifactJson('windows-owned-run.json',{directory,owner,username,installerSha256:oldSha256,...(newSha256?{newInstallerSha256:newSha256,expectedBuildCommit:expectedCommit,expectedCliSha256}:{})});
 await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-installer-user.ps1'),'user.ps1');
 await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-installer-session.ps1'),'session.ps1');
 await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-installer-desktop.cs'),'desktop.cs');
 await upload(installer,'old.exe');
 if(newInstaller)await upload(newInstaller,'new.exe');
 if(exerciseUI){
  await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-studio-ui-probe.cjs'),'probe.cjs');
  await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-installer-model.cjs'),'model.cjs');
 }

 let result;
 try { result=JSON.parse((await ps(`& '${directory}\\session.ps1' -RunRoot '${directory}'`,JSON.stringify({username,owner,password,oldSha256,newSha256,exerciseUI,smokeOnly,node,expectedCommit,expectedCliSha256}),1200000)).trim()); }
 finally {
  for (let step=1;step<=4;step++) {
   if ((await ps(`Test-Path -LiteralPath '${directory}\\result-${step}.json'`)).trim()==='True')
    await execute('scp',['-o','BatchMode=yes','-o','ControlPath=none',`${target}:${remote}/result-${step}.json`,context.pathInArtifacts(`user-step-${step}.json`)]);
  }
  if(exerciseUI){
   const names=JSON.parse((await ps(`@(Get-ChildItem -LiteralPath '${directory}' -File|Where-Object{$_.Name -match '^(seed|restored|restarted)-(stdout\\.json|stderr\\.log)$|^windows-.*\\.(png|json)$'}|Select-Object -ExpandProperty Name)|ConvertTo-Json -Compress`)).trim()||'[]');
   for(const name of (Array.isArray(names)?names:[names]))if(/^[a-zA-Z0-9_.-]+$/.test(name))await execute('scp',['-o','BatchMode=yes','-o','ControlPath=none',`${target}:${remote}/${name}`,context.pathInArtifacts(name)]);
  }
 }
 assert.equal(result.passed,true);
 if(expectedCommit) assert.deepEqual(result.buildIdentity,{build_commit:expectedCommit,build_dirty:false,executable_sha256:expectedCliSha256},'Fresh or upgraded installed CLI execution must match the frozen clean build');
 if(newInstaller){
  assert.equal(result.upgraded,true);
  const installs=result.steps.filter(step=>step.action==='install');
  assert.equal(installs.length,2);
  assert.equal(installs[0].sid,installs[1].sid,'Upgrade must use the same ordinary account');
  assert.deepEqual(result.buildIdentity,{build_commit:expectedCommit,build_dirty:false,executable_sha256:expectedCliSha256},'Actual installed CLI execution must match the frozen clean build');
  assert.equal(installs[1].installedResources['resources\\bin\\kcoder.exe'].toLowerCase(),expectedCliSha256);
  if(newSha256!==oldSha256)assert.notDeepEqual(installs[0].installedResources,installs[1].installedResources,'New installer must replace actual installed resources');
 }

 await context.writeArtifactJson('windows-installer-result.json',result);
 return result;
}
