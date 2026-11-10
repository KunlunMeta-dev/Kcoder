import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createInterface} from 'node:readline';
import {windowsSshInvocation} from './windows-ssh-auth.mjs';
import {ownedCreationScript,psLiteral} from './windows-package-probe.mjs';
import {repoRoot,waitFor} from './run-context.mjs';

export async function preflightPhysicalWindowsHost(context,{target,node,parent}) {
 assert.match(target,/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/);assert.match(node,/^[A-Za-z]:\\[^'"\r\n]+\.exe$/);assert.match(parent,/^[D-Z]:\\$/);
 const script=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$node=${psLiteral(node)};$parent=${psLiteral(parent)};if(!(Test-Path -LiteralPath $node -PathType Leaf) -or !(Test-Path -LiteralPath $parent -PathType Container)){throw 'Physical runtime prerequisite missing'};$v=(& $node --version|Out-String).Trim();$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$h=[Security.Cryptography.SHA256]::Create();$digest=[BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($sid))).Replace('-','').ToLowerInvariant();@{readOnly=$true;platform='windows';architecture=$env:PROCESSOR_ARCHITECTURE;nodeVersion=$v;accountIdentitySha256=$digest;accountsCreated=0;personalConfigurationModified=$false}|ConvertTo-Json -Compress`;
 const spec=windowsSshInvocation(context,'ssh',['-T','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ControlPath=none',target,'powershell.exe','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],target);
 const child=context.spawnOwned('physical-host-readonly-preflight',spec.command,spec.args,{...spec.options,stdin:'ignore',signal:AbortSignal.timeout(25000)});
 let output='';child.stdout.on('data',data=>{if(output.length<8192)output+=data});child.stderr.resume();
 const code=await new Promise((accept,reject)=>{child.once('error',reject);child.once('close',accept)});assert.equal(code,0,'Physical host prerequisite unavailable');const value=JSON.parse(output.trim());assert.equal(value.platform,'windows');assert.equal(value.architecture,'AMD64');assert.ok(Number(/^v([0-9]+)/.exec(value.nodeVersion)?.[1])>=22);await context.writeArtifactJson('physical-host-readonly-preflight.json',value);return value;
}
export function physicalWindowsServer(root,id,host,user){
 assert.ok(['ssh-owner','ssh-peer'].includes(id));assert.match(host,/^[a-zA-Z0-9.-]+$/);assert.match(user,/^[a-zA-Z0-9_.-]+$/);
 const directory=root+'\\profiles\\'+id;
 return{id:id.replace('ssh-',''),label:'Owned '+id,transport:'ssh',runtime:'kcoder',remotePlatform:'windows',host,user,command:directory+'\\launcher.exe',workspace:directory+'\\workspace'};
}
export function physicalWebCleanupScript(root,owner){
 return `& ${psLiteral(root+'\\cleanup.ps1')} -Root ${psLiteral(root)} -Owner ${psLiteral(owner)}`;
}
export async function stagePhysicalWebWindows(context,options){
 assert.equal(options.nativeConsent,'1');assert.match(options.target,/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/);assert.match(options.parent,/^[D-Z]:\\$/);assert.match(options.cliSha256,/^[a-f0-9]{64}$/);assert.match(options.archiveSha256,/^[a-f0-9]{64}$/);
 const owner=randomUUID();context.registerSecret(owner);context.registerSecret(options.gatewayToken);
 let sequence=0;
 const execute=(command,args,{input,cleanup=false,timeout=30000}={})=>new Promise((accept,reject)=>{
  const label='physical-web-'+(++sequence),spec=windowsSshInvocation(context,command,args,options.target),spawn=cleanup?context.spawnCleanupOwned.bind(context):context.spawnOwned.bind(context),child=spawn(label,spec.command,spec.args,{...spec.options,stdin:input===undefined?'ignore':'pipe'});
  let out='',err='',bytes=0;const timer=setTimeout(()=>{void context.stopOwned(label);reject(Error('Owned physical command deadline'))},timeout);
  child.stdout.on('data',data=>{bytes+=data.length;if(bytes>65536){void context.stopOwned(label);reject(Error('Owned physical output budget'))}else out+=data});child.stderr.on('data',data=>{err=(err+data).slice(-4096)});child.once('error',reject);child.once('close',code=>{clearTimeout(timer);code===0?accept(out):reject(Error('Owned physical command failed '+code+': '+context.redactText(err)))});if(input!==undefined)child.stdin.end(input);
 });
 const args=script=>['-T','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ControlPath=none',options.target,'powershell.exe','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';"+script,'utf16le').toString('base64')];
 const ps=(script,opts)=>execute('ssh',args(script),opts);
 const root=JSON.parse((await ps(ownedCreationScript(options.parent,owner))).trim());
 let cleanupUploaded=false;
 const cleanupPath=context.pathInArtifacts('physical-windows-cleanup.json');
 context.addCleanup('revoke exact physical target actors and remove only their root',async()=>{
  const fallback=`$r=${psLiteral(root)};if((Get-Content -LiteralPath (Join-Path $r '.owner.json') -Raw|ConvertFrom-Json).owner -cne ${psLiteral(owner)}){throw 'Owner changed'};[IO.Directory]::Delete($r,$true);@{directoryAbsent=!(Test-Path -LiteralPath $r)}|ConvertTo-Json -Compress`;
  const value=JSON.parse((await ps(cleanupUploaded?physicalWebCleanupScript(root,owner):fallback,{cleanup:true,timeout:45000})).trim());assert.equal(value.directoryAbsent,true);await writeFile(cleanupPath,JSON.stringify(value),{mode:0o600});
 });
 const upload=(path,leaf)=>execute('scp',['-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ControlPath=none',path,options.target+':'+root.replaceAll('\\','/')+'/'+leaf],{timeout:240000});
 await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/physical-web-windows-cleanup.ps1'),'cleanup.ps1');cleanupUploaded=true;
 await ps(`$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseFile(${psLiteral(root+'\\cleanup.ps1')},[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Owned cleanup source parse failed'}`);
 if(options.privateUrlFile){
  const download=JSON.parse(await readFile(options.privateUrlFile,'utf8'));
  const signed=download.url;assert.equal(typeof signed,'string');context.registerSecret(signed);
  assert.equal(download.bytes,options.archiveBytes);assert.equal(download.sha256,options.archiveSha256);
  let url;try{url=new URL(signed)}catch{throw Error('Invalid private asset URL descriptor')}
  assert.ok(url.protocol==='https:'&&['release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(url.hostname)&&!url.username&&!url.password,'Unsupported private asset host');
  await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-owned-private-download.ps1'),'private-download.ps1');
  await ps(`foreach($f in @('cleanup.ps1','private-download.ps1')){$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseFile((Join-Path ${psLiteral(root)} $f),[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Owned PowerShell source parse failed'}}`);
  const input=JSON.stringify({url:signed,root,owner,leaf:'payload.tar.gz',bytes:options.archiveBytes,sha256:options.archiveSha256});
  assert.ok(Buffer.byteLength(input)<=8192,'Private stdin descriptor bound');
  const value=JSON.parse((await ps(`& ${psLiteral(root+'\\private-download.ps1')};if($LASTEXITCODE -ne 0){throw 'Private artifact download failed'}`,{input,timeout:210000})).trim());
  assert.equal(value.passed,true);assert.equal(value.sha256,options.archiveSha256);await context.writeArtifactJson('physical-private-transfer.json',value);
 }else await upload(options.archive,'payload.tar.gz');
 await upload(options.launcher,'profile-launcher.exe');
 await upload(options.membersFile,'members.json');
 await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/physical-web-windows-controller.mjs'),'controller.mjs');await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/owned-process.mjs'),'owned-process.mjs');await upload(resolve(repoRoot,'apps/kcoder-studio/desktop/native-component-image.mjs'),'native-component-image.mjs');
 await ps(`$r=${psLiteral(root)};if((Get-FileHash -LiteralPath (Join-Path $r 'payload.tar.gz') -Algorithm SHA256).Hash.ToLowerInvariant() -cne '${options.archiveSha256}'){throw 'Payload archive identity changed'};& tar -xf (Join-Path $r 'payload.tar.gz') -C $r;if($LASTEXITCODE -ne 0){throw 'Owned payload extraction failed'};if((Get-FileHash -LiteralPath (Join-Path $r 'payload/bin/kcoder.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -cne '${options.cliSha256}'){throw 'Native image changed'}`,{timeout:90000});
 await ps(`$r=${psLiteral(root)};$m=Get-Content -LiteralPath (Join-Path $r 'members.json') -Raw|ConvertFrom-Json;if($m.sourceCommit -cne '${options.sourceCommit}' -or $m.gatewaySourceCommit -cne '${options.gatewaySourceCommit}' -or $m.files.Count -lt 1 -or $m.files.Count -gt 512){throw 'Owned source inventory bound'};foreach($f in $m.files){if($f.member -notmatch '^payload/' -or $f.member.Split('/') -contains '..' -or $f.member.Contains(':') -or $f.member.Contains([char]92) -or $f.sha256 -notmatch '^[a-f0-9]{64}$'){throw 'Owned member path invalid'};$p=Join-Path $r ([string]$f.member);$i=Get-Item -LiteralPath $p;if($i.Attributes -band [IO.FileAttributes]::ReparsePoint -or $i.Length -ne [long]$f.bytes -or (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() -cne $f.sha256){throw 'Owned source member changed'}};if(@(Get-ChildItem -LiteralPath (Join-Path $r 'payload') -Recurse -File).Count -ne $m.files.Count){throw 'Unknown payload member'}`,{timeout:90000});

 const nativeBuild=JSON.parse(await readFile(options.nativeBuildResult,'utf8'));assert.equal(nativeBuild.cliSha256,options.cliSha256);
 const config={root,owner,nativePin:nativeBuild.nativePin,node:options.node,ownerEndpoint:options.ownerEndpoint,peerEndpoint:options.peerEndpoint,gatewayToken:options.gatewayToken};const configPath=await context.writeStateJson('physical-controller.json',config);await upload(configPath,'controller.json');
 const spec=windowsSshInvocation(context,'ssh',args(`& ${psLiteral(options.node)} ${psLiteral(root+'\\controller.mjs')} ${psLiteral(root+'\\controller.json')};exit $LASTEXITCODE`),options.target);
 const child=context.spawnOwned('physical-windows-controller',spec.command,spec.args,{...spec.options,stdin:'pipe'}),reader=createInterface({input:child.stdout,crlfDelay:Infinity});let ready,failure;const replies=new Map(),waiters=new Map();
 reader.on('line',line=>{try{const frame=JSON.parse(line);if(frame.ready)ready=frame;else{replies.set(frame.id,frame);waiters.get(frame.id)?.(frame)}}catch{failure=Error('Owned controller JSON frame invalid')}});child.stderr.resume();child.stdin.write(JSON.stringify({owner})+'\n');
 await waitFor(()=>{if(failure)throw failure;if(child.exitCode!==null)throw Error('Owned controller exited');return ready},30000,'physical controller readiness',50,context.abortSignal);
 let requestId=0;
 const request=async action=>{const id=++requestId;const done=new Promise((accept,reject)=>{const timer=setTimeout(()=>{waiters.delete(id);reject(Error('Owned controller action deadline'))},35000);waiters.set(id,value=>{clearTimeout(timer);waiters.delete(id);value.error?reject(Error(value.error)):accept(value.result)})});child.stdin.write(JSON.stringify({id,owner,action})+'\n');return done;};
 context.addCleanup('close physical controller authority',async()=>{try{await request('stop')}finally{child.stdin.end();reader.close()}});
 await context.writeArtifactJson('physical-target-stage.json',{root,sourceCommit:options.sourceCommit,cliSha256:options.cliSha256,archiveSha256:options.archiveSha256,gatewaySourceCommit:options.gatewaySourceCommit,actualPhysicalHost:options.target.split('@')[1],accountsCreated:0,personalConfigModified:false});
 await context.writeArtifactJson('physical-private-file-acls.json',ready.privateFiles);
 return{root,request,ps,execute,target:options.target,owner};
}
