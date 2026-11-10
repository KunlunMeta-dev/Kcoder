import {transferWindowsArtifact} from './windows-artifact-transfer.mjs';
import {requireNativeSearchGates} from './windows-native-web-search.mjs';
import { windowsSshInvocation } from './windows-ssh-auth.mjs';
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
export function windowsInstallerFixtureParent({probeVolume,minimalUninstallProbe=false,nativeComponents=false,exerciseUI=false,nativeWebSearch=false}={}){
 if(probeVolume!==undefined&&!['C','D'].includes(probeVolume))throw Error('Invalid owned probe volume');
 if(probeVolume==='D')return 'D:\\';
 return minimalUninstallProbe||nativeComponents||exerciseUI||nativeWebSearch?'C:\\ProgramData':null;
}
export function validateWindowsInstallerDirectoryTrust({directoryTrust=false,exerciseUI=false,smokeOnly=false,newInstaller}={}){
 if(typeof directoryTrust!=='boolean')throw Error('Directory trust must be an explicit boolean');
 if(directoryTrust&&(!exerciseUI||smokeOnly||!newInstaller))throw Error('Directory trust requires full installed upgrade UI verification');
 return directoryTrust;
}
export function validateWindowsInstallerUpgradeMode({mechanismOnlyUpgrade=false,newInstaller,exerciseUI=false,smokeOnly=false,directoryTrust=false,nativeWebSearch=false}={}){
 if(typeof mechanismOnlyUpgrade!=='boolean')throw Error('Mechanism-only upgrade must be an explicit boolean');
 if(mechanismOnlyUpgrade&&(!newInstaller?.endsWith('.exe')||exerciseUI||smokeOnly||directoryTrust))throw Error('Mechanism-only upgrade requires an actual new installer without UI, smoke or directory trust claims');
 if(newInstaller&&(!newInstaller.endsWith('.exe')||(!exerciseUI&&!mechanismOnlyUpgrade&&!nativeWebSearch)))throw Error('Upgrade requires actual installer and installed UI verification or explicit mechanism-only upgrade');
 return mechanismOnlyUpgrade;
}
export function validateWindowsInstallerUpgradeResult(result,{mechanismOnlyUpgrade=false,officeNative=false,nativeWebSearch=false,expectedCommit,expectedCliSha256,oldSha256,newSha256}={}){
 assert.equal(result.upgraded,true);
 const installs=result.steps.filter(step=>step.action==='install');
 assert.deepEqual(result.steps.map(step=>step.action),nativeWebSearch?['inspect','install','install','nativeWebSearch','uninstall']:officeNative?['inspect','install','install','officeUI','uninstall']:['inspect','install','install','uninstall'],'Upgrade must exercise both installers and uninstall');
 assert.equal(installs[0].sid,installs[1].sid,'Upgrade must use the same ordinary account');
 if(mechanismOnlyUpgrade){
  assert.equal(result.mechanismOnly,true);
  assert.equal(result.verificationScope,'nsis_mechanism');
  assert.deepEqual(result.ui,[],'Mechanism-only upgrade cannot claim installed UI coverage');
  assert.equal(result.buildIdentity,null,'Mechanism-only upgrade does not certify a clean source identity');
  assert.equal(result.buildIdentityProbeOwner,'not_requested');
 }else{
  assert.deepEqual(result.buildIdentity,{build_commit:expectedCommit,build_dirty:false,executable_sha256:expectedCliSha256},'Actual installed CLI execution must match the frozen clean build');
 }
 if(expectedCliSha256)assert.equal(installs[1].installedResources['resources\\bin\\kcoder.exe'].toLowerCase(),expectedCliSha256);
 if(newSha256!==oldSha256)assert.notDeepEqual(installs[0].installedResources,installs[1].installedResources,'New installer must replace actual installed resources');
}
export function validateWindowsInstallerUiResult(result,{directoryTrust=false,exerciseUI=false,smokeOnly=false}={}){
 assert.equal(result.directoryTrust,directoryTrust?'verified':'not_requested','Directory trust must report only the requested verification scope');
 if(!exerciseUI)return;
 assert.deepEqual(result.ui?.map(item=>item.label),smokeOnly?['seed','restored']:['seed','restored','restarted'],'Installed UI lifecycle stages must remain complete');
 for(const {label,result:ui} of result.ui){
  assert.equal(ui.passed,true);
  const observation=result.ui.find(item=>item.result===ui);
  assert.equal(observation.sid,result.steps?.find(item=>item.action==='install')?.sid,'Installed UI must use the ordinary installer SID');
  assert.equal(observation.isAdmin,false,'Installed UI must be unprivileged');
  assert.equal(ui.directoryTrust,label==='seed'||smokeOnly?'not_requested':directoryTrust?'verified':'not_requested');
  if(label!=='seed'&&!smokeOnly){
   for(const fact of ['actualInstalledResources','historyRestored','modelBodyRetained','themeRetained','targetRetained','pluginRetained','pluginHookExecuted'])assert.equal(ui[fact],true,`Core restored UI fact ${fact}`);
   assert.equal(ui.windowsDirectoryTrustVerified===true,directoryTrust,'Only an explicit directory probe may claim verification');
  }
 }
}
export function validateWindowsInstallerOfficeMode(options) {
 if(options.officeFreshInstallOnly!==undefined&&typeof options.officeFreshInstallOnly!=='boolean')throw Error('Office fresh install scope must be an explicit boolean');
 if(options.officeFreshInstallOnly&&!options.officeUpgradeOnly)throw Error('Office fresh install scope requires the independent Office lane');
 if(options.officeUpgradeOnly!==undefined&&typeof options.officeUpgradeOnly!=='boolean')throw Error('Office upgrade scope must be an explicit boolean');
 if(options.officeUpgradeOnly&&(!options.officeNative||options.directoryTrust))throw Error('Office upgrade scope requires native Office without history or directory trust claims');
 const requested=options.officeNative===true;
 if(requested&&(!options.exerciseUI||!options.newInstaller||options.smokeOnly||options.mechanismOnlyUpgrade||options.minimalUninstallProbe||options.nativeComponentsProbe))throw Error('Office native acceptance requires full current installer upgrade and real installed UI');
 return requested;
}
export function validateWindowsInstalledOfficeResult(result,requested){
 if(!requested)return;
 const office=result.office?.result;
 const step=result.steps?.find(item=>item.action==='officeUI');assert.ok(step);assert.equal(step.sid,result.steps.filter(item=>item.action==='install').at(-1)?.sid,'Office must run as the original ordinary installer SID');
 assert.equal(office?.passed,true);assert.equal(office.actualInstalledElectron,true);assert.equal(office.actualNativeOfficeGeneration,true);
 assert.equal(office.actualArtifactCollection,true);assert.equal(office.nativeDownloadStatus,'completed');assert.equal(office.nativeDialogInvoked,true);
 assert.ok(office.bytes>256*1024);assert.match(office.sha256,/^[a-f0-9]{64}$/);assert.ok(office.attachmentChunkReads?.length>0);
 assert.equal(office.controlledProviderRequests,3);assert.equal(office.additionalDownloadProviderRequests,0);assert.equal(office.externalModelCalls,0);assert.equal(office.platformCalls,0);assert.equal(office.qualityClaim,false);
}
export function validateWindowsBrowserProfileNativeResult(result,{mode='native'}={}){
 assert.equal(result.passed,true);
 assert.equal(result.verificationScope,'actual_native_windows_components');
 assert.deepEqual(result.steps.map(step=>step.action),['nativeComponents']);
 const step=result.steps[0],probe=step.probe;
 assert.equal(probe.passed,true);
 assert.equal(probe.verificationScope,mode==='electron-ui'?'ordinary_windows_actual_electron_browser_profiles':mode==='stdio-crash'?'ordinary_windows_actual_browser_profile_stdio_crash':'ordinary_windows_actual_chromium_native_profile_consumer');
 assert.equal(probe.sid,step.sid);assert.equal(probe.isAdmin,false);
 if(mode==='electron-ui'){
  for(const field of ['passed','actualPackagedElectron','actualGatewayOuterJob','actualProfileUiSaveSelect','actualHandoffRoundTrip','explicitTemporarySwitch','originalCleanupReceiptConfirmed','originalUseReleased'])assert.equal(probe.nativeObservation[field],true);
  assert.equal(probe.nativeObservation.modelCalls,0);assert.equal(probe.nativeObservation.installerClaim,false);return;
 }
 if(mode==='stdio-crash'){
  for(const field of ['passed','defaultProductionProfile','chromiumDefaultKeyPolicy','normalCookieCloseReopen','actualAppServerHardCrash','originalReceiptConfirmed','originalLaunchReplayRejected','cookieRetainedAfterRecovery'])assert.equal(probe.nativeObservation[field],true);
  assert.equal(probe.nativeObservation.providerCalls,0);assert.equal(probe.nativeObservation.studioUi,false);
  return;
 }
 assert.deepEqual(probe.summary,{passed:1,failed:0,ignored:0});
 assert.equal(probe.modelCalls,0);assert.equal(probe.studioUi,false);assert.equal(probe.appServerCrash,false);
 assert.equal(probe.nativeObservation.defaultProductionProfile,true);
 assert.equal(probe.nativeObservation.chromiumDefaultKeyPolicy,true);
 assert.equal(probe.nativeObservation.passwordStoreOverride,false);
}
export function validateInstalledNativeSearchMode(options) {
 if(options.nativeWebSearch!==undefined&&typeof options.nativeWebSearch!=='boolean')throw Error('Native search scope must be explicit');
 if(options.nativeBundledParentRoute!==undefined&&typeof options.nativeBundledParentRoute!=='boolean')throw Error('Bundled parent scope must be explicit');
 if(options.nativeBundledParentRoute&&(!options.nativeWebSearch||!options.nativeWebFreshOnly))throw Error('Bundled parent query requires the fresh native lane');
 if(!options.nativeWebSearch)return false;
 if(options.nativeWebFreshOnly!==undefined&&typeof options.nativeWebFreshOnly!=='boolean')throw Error('Fresh native web scope must be explicit');
 requireNativeSearchGates(options.nativeConsent,options.externalConsent);
 if(!options.newInstaller||options.exerciseUI||options.mechanismOnlyUpgrade||options.smokeOnly||options.officeNative||options.directoryTrust||options.minimalUninstallProbe||options.nativeComponentsProbe||!options.node)throw Error('Native search requires isolated old/new NSIS installation without another lane');
 return true;
}
export function validateControlledBundledSearchMode(options){
 if(options.nativeBundledControlled===undefined||options.nativeBundledControlled===false)return false;
 assert.equal(options.nativeBundledControlled,true);assert.equal(options.controlledPacConsent,'1');
 assert.equal(options.nativeWebSearch,true);assert.equal(options.nativeWebFreshOnly,true);assert.equal(options.nativeBundledParentRoute,true);
 assert.equal(options.expectedCommit,'d3d8211ea3f8aa2bbbf6e289fa0dc05f78f5892d');assert.equal(options.expectedCliSha256,'c57332022e2dff2b54df26463105f67760ae85bcec261ee6342104bea72062dc');
 assert.equal(options.controlledInstallerSha256,'269c68e623053c80172bed3b915ece0a6e96b115137a488b845184ee6c3bf5cc');
 assert.equal(options.installer,options.newInstaller);assert.ok(options.managedJobLauncher);
 assert.match(options.controlledCertificates?.fixtureId??'',/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
 for(const key of ['caPath','certificatePath','keyPath'])assert.ok(options.controlledCertificates[key]);
 return true;
}
export function validateControlledBundledSearchResult(result,expected){
 assert.equal(result.verificationScope,'installed_owned_controlled_pac_managed_search');assert.equal(result.realDefaultPublicAcceptance,false);
 assert.equal(result.steps.filter(step=>step.action==='install').length,1);assert.equal(result.steps.filter(step=>step.action==='uninstall').length,1);
 assert.ok(!result.steps.some(step=>step.action==='nativeWebSearch'));
 const preflight=result.steps.find(step=>step.action==='controlledPacPreflight');assert.equal(preflight?.probe.passed,true);assert.equal(preflight.probe.ownSidHkcuWriteCalls,0);
 const step=result.steps.find(step=>step.action==='nativeBundledSearch');assert.ok(step?.ok);assert.equal(step.isAdmin,false);
 assert.equal(step.sid,result.steps.find(step=>step.action==='install').sid);const p=step.probe;
 assert.equal(p.passed,true);assert.equal(p.realDefaultPublicAcceptance,false);assert.equal(p.processCaEnvironmentRestored,true);assert.equal(p.networkFlagsRestored,true);assert.equal(p.controlledNetwork.autoDetect,false);assert.equal(p.controlledNetwork.pacUrlConfigured,true);
 assert.equal(p.proxyRestoration.settings.originalPerConnectionReadbackEqual,true);assert.ok(p.ownSidWriteReceipt.ownSidHkcuWriteCalls>=2);
 assert.equal(p.machineRegistryWrites,0);assert.equal(p.personalRegistryWrites,0);assert.equal(p.certificateStoreWrites,0);
 assert.equal(p.installedOwnedWorkersAbsent,true);assert.equal(p.fixtureStopped.stats.closed,true);assert.equal(p.fixtureStopped.stats.activeSockets,0);
 assert.equal(p.fixtureStopped.stats.externalConnections,0);assert.equal(p.native.native.receipt.sources.length,3);
 assert.deepEqual(p.native.native.buildIdentity,{build_commit:expected.expectedCommit,build_dirty:false,executable_sha256:expected.expectedCliSha256});
 assert.equal(p.native.native.permissionMode,'ask');assert.equal(p.native.native.approvals.length,1);
}
export function validateInstalledNativeSearchResult(result,expected) {
 assert.ok(['installed_native_default_web','installed_native_default_web_fresh'].includes(result.verificationScope));
 const step=result.steps.find(step=>step.action==='nativeWebSearch');assert.ok(step);
 assert.equal(step.sid,result.steps.filter(step=>step.action==='install').at(-1).sid);assert.equal(step.isAdmin,false);
 assert.equal(result.nativeWebSearch.passed,true);assert.equal(result.nativeWebSearch.searchConfigurationWritten,false);assert.equal(result.nativeWebSearch.mcpConfigurationWritten,false);
 assert.equal(result.nativeWebSearch.externalModelCalls,0);assert.equal(result.nativeWebSearch.controlledProviderRequests,3);
 assert.equal(result.nativeWebSearch.permissionMode,'ask');assert.equal(result.nativeWebSearch.approvals.length,2);
 assert.deepEqual(result.nativeWebSearch.approvals.map(({toolCallId,tool,decision,resolved})=>({toolCallId,tool,decision,resolved})),[{toolCallId:'owned-native-first-web-search',tool:'WebSearch',decision:'accept',resolved:true},{toolCallId:'owned-native-first-web-fetch',tool:'WebFetch',decision:'accept',resolved:true}]);
 assert.deepEqual(result.nativeWebSearch.buildIdentity,{build_commit:expected.expectedCommit,build_dirty:false,executable_sha256:expected.expectedCliSha256});
 assert.ok(result.nativeWebSearch.receipt.sources.some(source=>source.readStatus==='summary_only'));
 assert.ok(result.nativeWebSearch.page.sources.some(source=>['read','partial'].includes(source.readStatus)));
}
export function validateBundledParentSearchResult(result,expected) {
 const step=result.steps.find(value=>value.action==='nativeBundledSearch');assert.ok(step);
 assert.equal(step.sid,result.steps.find(value=>value.action==='nativeWebSearch').sid);assert.equal(step.isAdmin,false);
 const p=result.bundledParentRoute;assert.equal(p.passed,true);
 assert.equal(p.scope,'actual-native-bundled-source-under-system-automatic-proxy');
 assert.equal(p.searchConfigurationWritten,true);assert.equal(p.mcpConfigurationWritten,false);assert.equal(p.externalModelCalls,0);assert.equal(p.controlledProviderRequests,2);assert.equal(p.permissionMode,'ask');
 assert.equal(p.receipt.toolCallId,'owned-native-bundled-parent-search');assert.equal(p.receipt.provider,'searxng-bundled');assert.ok(['success','partial'].includes(p.receipt.status));assert.ok(p.receipt.sources.length>0&&p.receipt.sources.every(source=>source.readStatus==='summary_only'));
 assert.equal(p.approvals.length,1);assert.equal(p.approvals[0].toolCallId,p.receipt.toolCallId);assert.equal(p.approvals[0].decision,'accept');assert.equal(p.approvals[0].resolved,true);
 assert.equal(p.ordinaryAccountNetwork.apiSucceeded,true);assert.ok(p.ordinaryAccountNetwork.autoDetect||p.ordinaryAccountNetwork.pacUrlConfigured);assert.equal(p.ordinaryAccountNetwork.proxyEnvironmentPresent,false);
 assert.deepEqual(p.nativeEof,{forcedKill:false,exitCode:0});assert.equal(p.nativeOwnedWorkersAbsent,true);assert.deepEqual(p.parentRouteEvidence,{requiredByObservedSystemFlags:true,perUrlCounterObserved:false});
 assert.deepEqual(p.buildIdentity,{build_commit:expected.expectedCommit,build_dirty:false,executable_sha256:expected.expectedCliSha256});
}
export async function verifyWindowsInstallerMechanism(context,options){
 validateWindowsInstallerInputs(options);
 const nativeWebSearch=validateInstalledNativeSearchMode(options);
 const controlledPac=validateControlledBundledSearchMode(options);
 const officeNative=validateWindowsInstallerOfficeMode(options);
 const officeUpgradeOnly=options.officeUpgradeOnly===true;
 const officeFreshInstallOnly=options.officeFreshInstallOnly===true;
 if(options.startupWindowExpected!==undefined&&typeof options.startupWindowExpected!=='boolean')throw Error('Restricted startup verification requires an explicit boolean');
 const startupWindowExpected=options.startupWindowExpected===true;
 if(startupWindowExpected&&(!options.officeNative||!options.exerciseUI||!options.newInstaller))throw Error('Restricted startup verification requires the actual installed Office lane');
 const {target,installation,installer,newInstaller,exerciseUI=false,smokeOnly=false,node,expectedCommit,expectedCliSha256}=options;
 const mechanismOnlyUpgrade=validateWindowsInstallerUpgradeMode(options);
 const directoryTrust=validateWindowsInstallerDirectoryTrust(options);
 if((exerciseUI||nativeWebSearch)&&(!node||/['"\r\n]/.test(node)))throw Error('Explicit safe Windows Node path required');
 if(((newInstaller&&!mechanismOnlyUpgrade)||expectedCommit||expectedCliSha256)&&(!/^[a-f0-9]{40}$/.test(expectedCommit||'')||!/^[a-f0-9]{64}$/.test(expectedCliSha256||'')))throw Error('Upgrade requires the frozen full source commit and expected CLI SHA256');
 const newSha256=newInstaller?createHash('sha256').update(await readFile(newInstaller)).digest('hex'):null;
 const minimalUninstallProbe=options.minimalUninstallProbe===true;
 const nativeComponents=options.nativeComponentsProbe===true;
 const zeroBusiness=options.zeroBusinessMode!==undefined;
 if(zeroBusiness){assert.ok(['exa-head','exa-handshake','searx-startup','wpad-detect','wpad-compile','winhttp-inprocess-compile','winhttp-inprocess-resolve'].includes(options.zeroBusinessMode));requireNativeSearchGates(options.nativeConsent,options.externalConsent);assert.equal(nativeComponents,true);assert.match(options.diagnosticSourceCommit??'',/^[a-f0-9]{40}$/);assert.match(options.sourceTreeSha256??'',/^[a-f0-9]{64}$/);}

 const browserProfileNative=options.browserProfileNativeProbe===true;
 const browserProfileNativeMode=options.browserProfileNativeMode??'native';
 if(!['native','stdio-crash','electron-ui'].includes(browserProfileNativeMode)||(!browserProfileNative&&options.browserProfileNativeMode!==undefined))throw Error('Invalid browser profile native mode');
 if(browserProfileNativeMode==='electron-ui'&&(!options.desktopArchive||!/^[a-f0-9]{64}$/.test(options.desktopArchiveSha256||'')))throw Error('Browser Electron requires its exact desktop archive');
 if(browserProfileNative&&(!nativeComponents||!options.chromiumArchive||!/^[a-f0-9]{64}$/.test(options.chromiumArchiveSha256||'')||!/^[a-f0-9]{64}$/.test(options.sourceTreeSha256||'')))throw Error('Browser profile native probe requires exact source and Chromium archive pins');
 if(nativeComponents&&(newInstaller||exerciseUI||smokeOnly||directoryTrust||minimalUninstallProbe||!options.probeCli||!options.probeSupervisor||(!browserProfileNative&&!zeroBusiness&&!options.sdkArchive)||!node))throw Error('Native component probe scope conflict');
 if(minimalUninstallProbe&&(newInstaller||exerciseUI||smokeOnly||directoryTrust||!options.probeCli||!options.probeSupervisor))throw Error('Minimal uninstall probe requires exact CLI/supervisor without UI or full installer');
 if(options.probeVolume!==undefined&&!['C','D'].includes(options.probeVolume))throw Error('Invalid owned probe volume');
 const probeCliSha256=minimalUninstallProbe||nativeComponents?createHash('sha256').update(await readFile(options.probeCli)).digest('hex'):null;
 const managedJobLauncherSha256=controlledPac?createHash('sha256').update(await readFile(options.managedJobLauncher)).digest('hex'):null;
 const probeSupervisorSha256=minimalUninstallProbe||nativeComponents?createHash('sha256').update(await readFile(options.probeSupervisor)).digest('hex'):null;
 const owner=randomUUID(),username='kc_e2e_'+randomBytes(4).toString('hex');
 const password=randomBytes(24).toString('base64url')+'aA9!';context.registerSecret(password);
 const oldSha256=createHash('sha256').update(await readFile(installer)).digest('hex');
 if(controlledPac){assert.equal(oldSha256,options.controlledInstallerSha256);assert.equal(newSha256,oldSha256);}
 if(officeFreshInstallOnly&&oldSha256!==newSha256)throw Error('Office fresh diagnostic must use the same actual stage package identity');
 let sequence=0;
 const argsFor=script=>['-o','BatchMode=yes','-S','none',target,'powershell','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);"+script,'utf16le').toString('base64')];
 const execute=(command,args,input,timeoutMs=300000)=>new Promise((resolve,reject)=>{
  const label=`windows-installer-${++sequence}`;
  const spec=windowsSshInvocation(context,command,args,target);
  const child=context.spawnOwned(label,spec.command,spec.args,{...spec.options,stdin:input===undefined?'ignore':'pipe'});
  let output='',error='';const timer=setTimeout(()=>{void context.stopOwned(label);reject(Error('Owned Windows installer command timed out'));},timeoutMs);
  child.stdout.on('data',bytes=>{output+=bytes;if(output.length>4*1024*1024)void context.stopOwned(label);});
  child.stderr.on('data',bytes=>{error=(error+bytes).slice(-8192)});
  child.once('error',error=>{clearTimeout(timer);reject(error)});
  child.once('close',code=>{clearTimeout(timer);code===0?resolve(output):reject(Error(`Owned Windows command failed (${code}): ${context.redactText(error||output).slice(-2500)}`))});
  if(input!==undefined)child.stdin.end(input);
 });
 const ps=(script,input,timeout)=>execute('ssh',argsFor(script),input,timeout);
 const cleanupExecute=(args,options)=>{const spec=windowsSshInvocation(context,'ssh',args,target);return execFileAsync(spec.command,spec.args,{...options,...spec.options});};
 const snapshotScript=`$root='${installation}';$files=@{};foreach($leaf in @('kcoder-studio.exe','resources\\app.asar','resources\\bin\\kcoder.exe')){$p=Join-Path $root $leaf;if(!(Test-Path -LiteralPath $p)){throw 'Personal baseline resource missing'};$files[$leaf]=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash};$reg=@(Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'|ForEach-Object{Get-ItemProperty -LiteralPath $_.PSPath}|Where-Object{($_.InstallLocation -and $_.InstallLocation.TrimEnd('\\') -eq $root.TrimEnd('\\')) -or ($_.UninstallString -and $_.UninstallString.TrimStart('"').StartsWith(($root.TrimEnd('\\')+'\\'),[StringComparison]::OrdinalIgnoreCase))}|Select-Object DisplayName,DisplayVersion,InstallLocation,UninstallString);$processes=@(Get-CimInstance Win32_Process -Filter \"Name='kcoder-studio.exe'\"|Where-Object{$_.ExecutablePath -and $_.ExecutablePath.StartsWith(($root.TrimEnd('\\')+'\\'),[StringComparison]::OrdinalIgnoreCase)}|Sort-Object ProcessId|ForEach-Object{@{pid=$_.ProcessId;creationTicks=$_.CreationDate.ToUniversalTime().Ticks.ToString()}});@{files=$files;registration=$reg;personalProcesses=$processes}|ConvertTo-Json -Depth 5 -Compress`;
 const before=JSON.parse((await ps(snapshotScript)).trim());
 assert.equal(before.registration.length,1,'Personal per-user registration must be included in the read-only baseline');
 await context.writeArtifactJson('personal-installation-before.json',before);
 const parent=windowsInstallerFixtureParent({...options,minimalUninstallProbe,nativeComponents,exerciseUI});
 const directory=JSON.parse((await ps(`$p=Join-Path ${parent?`'${parent}'`:'([IO.Path]::GetTempPath())'} 'kcoder-installer-${owner}';if(Test-Path -LiteralPath $p){throw 'Owned directory collision'};[IO.Directory]::CreateDirectory($p)|Out-Null;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;& icacls $p /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' ('*'+$sid+':(OI)(CI)F')|Out-Null;if($LASTEXITCODE -ne 0){throw 'Could not isolate run directory'};[IO.File]::WriteAllText((Join-Path $p '.owner.json'),(@{owner='${owner}';username='${username}';creatorSid=$sid}|ConvertTo-Json -Compress));$verified=Get-Content -LiteralPath (Join-Path $p '.owner.json') -Raw|ConvertFrom-Json;if($verified.owner -cne '${owner}' -or $verified.username -cne '${username}' -or $verified.creatorSid -cne $sid){throw 'Owned creator marker readback failed'};ConvertTo-Json -InputObject $p -Compress`)).trim());
 assert.ok(directory.endsWith('kcoder-installer-'+owner)&&!directory.includes("'"));
 const remote=directory.replaceAll('\\','/');
 const cleanupEvidence=context.pathInArtifacts('windows-cleanup.json');
 let cleanupUploaded=false;
 context.addCleanup('remove isolated Windows installer account and profile',async()=>{
  const cleanupScript=cleanupUploaded ? `& '${directory}\\cleanup.ps1' -RunRoot '${directory}' -Owner '${owner}' -Username '${username}'` : `$m=Get-Content -LiteralPath '${directory}\\.owner.json' -Raw|ConvertFrom-Json;if($m.owner -ne '${owner}' -or $m.username -ne '${username}'){throw 'Ownership mismatch'};[IO.Directory]::Delete('${directory}',$true);@{cleaned=$true;accountAbsent=$true;profileAbsent=$true;directoryAbsent=$true}|ConvertTo-Json -Compress`;
  const result=await cleanupExecute(argsFor(cleanupScript),{timeout:90000,maxBuffer:2*1024*1024});
  const after=JSON.parse((await cleanupExecute(argsFor(snapshotScript),{timeout:30000,maxBuffer:2*1024*1024})).stdout.trim());
  assert.deepEqual(after,before,'personal installation and registration must remain unchanged');
  await writeFile(cleanupEvidence,JSON.stringify({...JSON.parse(result.stdout.trim()),personalInstallationUnchanged:true}),{mode:0o600});
 });
 const upload=(source,leaf)=>options.chunkedTransfer?transferWindowsArtifact({context,ps,uploadPart:(part,relative)=>execute('scp',['-o','BatchMode=yes','-o','ControlPath=none',part,`${target}:${remote}/${relative}`],undefined,120000),local:source,owner,root:directory,leaf}):execute('scp',['-o','BatchMode=yes','-o','ControlPath=none',source,`${target}:${remote}/${leaf}`],undefined,180000);
 await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-installer-cleanup.ps1'),'cleanup.ps1');cleanupUploaded=true;
 await context.writeArtifactJson('windows-owned-run.json',{directory,owner,username,mechanismOnlyUpgrade,...(zeroBusiness?{zeroBusinessMode:options.zeroBusinessMode,diagnosticSourceCommit:options.diagnosticSourceCommit,installerInvoked:false}:{}),installerSha256:oldSha256,...(newSha256?{newInstallerSha256:newSha256,expectedBuildCommit:expectedCommit,expectedCliSha256}:{})});
 await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-installer-user.ps1'),'user.ps1');
 await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-installer-session.ps1'),'session.ps1');
 await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-installer-desktop.cs'),'desktop.cs');
 if(!nativeComponents)await upload(installer,'old.exe');
 if(nativeComponents){
  await upload(options.probeCli,'probe-cli.exe');await upload(options.probeSupervisor,'probe-supervisor.exe');
  if(zeroBusiness){
   await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-zero-business-actor.ps1'),'zero-business-actor.ps1');
   await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-state-directory.ps1'),'private-state-directory.ps1');
   if(['wpad-detect','wpad-compile'].includes(options.zeroBusinessMode))await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-wpad-discovery.ps1'),'wpad-discovery.ps1');
   await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-native-libtest-probe.mjs'),'probe.mjs');
   await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/owned-process.mjs'),'owned-process.mjs');
   await upload(options.probeCli,'tests.exe');await upload(options.probeSupervisor,'supervisor.exe');
   if(options.zeroBusinessMode.startsWith('winhttp-inprocess-')){const helper=resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-winhttp-inprocess.ps1');const bytes=await readFile(helper);const digest=createHash('sha256').update(bytes).digest('hex');assert.equal(digest,'e52d8e078bb50517671586b5e37f50fc1d02e333b92dafa014be581c7634ed3c');await context.writeArtifactJson('inprocess-helper-source.json',{sourceCommit:'f10e54dbe322233f98eb7b9e998a4385c9b355ec',sha256:digest,bytes:bytes.length,nativePeExecuted:false});await upload(helper,'winhttp-inprocess.ps1');}
   if(options.zeroBusinessMode==='searx-startup'){assert.match(options.runtimeArchiveSha256??'',/^[a-f0-9]{64}$/);await upload(options.runtimeArchive,'runtime.tar.gz');}
  }else if(browserProfileNative){
   await upload(options.chromiumArchive,'chromium.zip');
   await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-browser-profile-probe.ps1'),'browser-profile-probe.ps1');
   if(browserProfileNativeMode==='electron-ui'){
    await upload(options.desktopArchive,'desktop.zip');
    await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-studio-ui-probe.cjs'),'probe.cjs');
    for(const leaf of ['windows-cdp-document.cjs','windows-gateway-startup-records.cjs','windows-browser-profile-ui.cjs','windows-installer-model.cjs'])await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness',leaf),leaf);
    await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-installer-model.cjs'),'model.cjs');
   }
   if(browserProfileNativeMode==='stdio-crash')for(const leaf of ['windows-browser-profile-crash.mjs','app-server-stdio.mjs'])await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness',leaf),leaf);
  }else{
  if(options.readonlyProbe)await upload(options.readonlyProbe,'native-store-readonly-probe.exe');
  if(options.nativeImageAddon)await upload(options.nativeImageAddon,'kcoder-native-image.node');
  if(options.nativeGateway){await upload(options.gatewayArchive,'gateway-source.zip');await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-native-gateway-probe.cjs'),'native-gateway-probe.cjs');}
  await upload(options.sdkArchive,'channel-source.zip');
  await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-native-components-probe.ps1'),'native-components-probe.ps1');
  await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-native-components-probe.cjs'),'native-components-probe.cjs');
  }
 }
 if(minimalUninstallProbe){
  await upload(options.probeCli,'probe-cli.exe');
  await upload(options.probeSupervisor,'probe-supervisor.exe');
  await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-installer-uninstall-probe.ps1'),'uninstall-probe.ps1');
  await upload(resolve(repoRoot,'apps/kcoder-studio/desktop/windows-shell/install-cli.ps1'),'install-cli.ps1');
  await upload(resolve(repoRoot,'apps/kcoder-studio/desktop/windows-shell/close-installed-processes.ps1'),'close-installed-processes.ps1');
  if(options.probeWithProductFix)await upload(resolve(repoRoot,'apps/kcoder-studio/desktop/windows-shell-close-processes.test.ps1'),'close-processes.test.ps1');
 }
 if(newInstaller&&!officeFreshInstallOnly&&!options.nativeWebFreshOnly)await upload(newInstaller,'new.exe');
 if(controlledPac){
  const cert=options.controlledCertificates;await upload(cert.caPath,'managed-ca.pem');await upload(cert.certificatePath,'managed-leaf.pem');await upload(cert.keyPath,'managed-leaf-key.pem');
  const descriptor=await context.writeStateJson('managed-pac-certificates.json',{fixtureId:cert.fixtureId,caSha256:cert.caSha256,certificateSha256:cert.certificateSha256});await upload(descriptor,'managed-pac-certificates.json');
  await upload(options.managedJobLauncher,'managed-job-launcher.exe');
  for(const leaf of ['windows-managed-pac-session.mjs','windows-managed-pac-fixture.mjs','windows-owned-proxy-fixture.ps1','windows-managed-pac-actor.ps1'])await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness',leaf),leaf.replace('windows-owned-proxy-fixture.ps1','owned-proxy-fixture.ps1').replace('windows-managed-pac-actor.ps1','managed-pac-actor.ps1'));
  await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-state-directory.ps1'),'private-state-directory.ps1');
 }
 if(nativeWebSearch)for(const leaf of ['windows-native-web-search.mjs','windows-native-web-model.mjs','windows-managed-pac-fixture.mjs','app-server-stdio.mjs'])await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness',leaf),leaf);
 if(exerciseUI){
  await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-studio-ui-probe.cjs'),'probe.cjs');
  await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-cdp-document.cjs'),'windows-cdp-document.cjs');
  await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-gateway-startup-records.cjs'),'windows-gateway-startup-records.cjs');
  await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-installer-model.cjs'),'model.cjs');
  if(officeNative){
   for(const name of ['windows-office-model.cjs','windows-office-native-ui.cjs','windows-office-save-dialog.ps1','windows-office-docx-reader.ps1','windows-office-startup-observation.ps1','windows-office-process-probe.ps1'])await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness',name),name);
   await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/suites/office/native-download-model.mjs'),'native-download-model.mjs');
  }
 }

 if(nativeWebSearch||zeroBusiness){
  const parsed=JSON.parse((await ps(`$r='${directory}';foreach($leaf in @('session.ps1','user.ps1'${zeroBusiness?",'zero-business-actor.ps1','private-state-directory.ps1'":''}${controlledPac?",'managed-pac-actor.ps1','owned-proxy-fixture.ps1','private-state-directory.ps1'":''})){$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseFile((Join-Path $r $leaf),[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Owned installer source parse failed before account creation'}};@{parsed=$true;accountCreated=$false;installed=$false}|ConvertTo-Json -Compress`)).trim());
  assert.equal(parsed.parsed,true);await context.writeArtifactJson('native-installer-source-parse.json',parsed);
 }
 let result;
 try { result=JSON.parse((await ps(`& '${directory}\\session.ps1' -RunRoot '${directory}'`,JSON.stringify({username,owner,password,oldSha256,newSha256,exerciseUI,nativeBundledControlled:controlledPac,controlledPacConsent:options.controlledPacConsent,controlledFixtureId:options.controlledCertificates?.fixtureId,managedJobLauncherSha256,zeroBusinessMode:options.zeroBusinessMode,diagnosticSourceCommit:options.diagnosticSourceCommit,runtimeArchiveSha256:options.runtimeArchiveSha256,nativeWebSearch,nativeWebFreshOnly:options.nativeWebFreshOnly===true,nativeBundledParentRoute:options.nativeBundledParentRoute===true,nativeConsent:options.nativeConsent,externalConsent:options.externalConsent,officeNative,officeUpgradeOnly,officeFreshInstallOnly,startupWindowExpected,smokeOnly,directoryTrust,mechanismOnlyUpgrade,minimalUninstallProbe,nativeComponents,browserProfileNative,browserProfileNativeMode,desktopArchiveSha256:options.desktopArchiveSha256,chromiumArchiveSha256:options.chromiumArchiveSha256,sourceTreeSha256:options.sourceTreeSha256,probeTerminalHolder:options.probeTerminalHolder===true,probeWithProductFix:options.probeWithProductFix===true,probeCliSha256,probeSupervisorSha256,nativeImageOnly:options.nativeImageOnly===true,nativeGateway:options.nativeGateway===true,node,expectedCommit,expectedCliSha256}),1200000)).trim()); }
 finally {
  if(nativeComponents){
   for(const name of ['native-components-last-stderr.log','native-components-progress.json','native-gateway-stderr.log'])if((await ps(`Test-Path -LiteralPath '${directory}\\${name}'`)).trim()==='True')
    await execute('scp',['-o','BatchMode=yes','-o','ControlPath=none',`${target}:${remote}/${name}`,context.pathInArtifacts(name)]);
  }
  for (let step=1;step<=(nativeWebSearch?5:exerciseUI?(officeNative?8:smokeOnly?6:7):4);step++) {
   if ((await ps(`Test-Path -LiteralPath '${directory}\\result-${step}.json'`)).trim()==='True')
    await execute('scp',['-o','BatchMode=yes','-o','ControlPath=none',`${target}:${remote}/result-${step}.json`,context.pathInArtifacts(`user-step-${step}.json`)]);
  }
  if(exerciseUI||(browserProfileNative&&browserProfileNativeMode==='electron-ui')){
   const names=JSON.parse((await ps(`@(Get-ChildItem -LiteralPath '${directory}' -File|Where-Object{$_.Name -match '^(seed|restored|restarted|office)-(stdout\\.json|stderr\\.log)$|^windows-.*\\.(png|json)$|^claimed-native-office\\.docx$'}|Select-Object -ExpandProperty Name)|ConvertTo-Json -Compress`)).trim()||'[]');
   for(const name of (Array.isArray(names)?names:[names]))if(/^[a-zA-Z0-9_.-]+$/.test(name))await execute('scp',['-o','BatchMode=yes','-o','ControlPath=none',`${target}:${remote}/${name}`,context.pathInArtifacts(name)]);
  }
 }
 assert.equal(result.passed,true);
 validateWindowsInstalledOfficeResult(result,officeNative);
 if(controlledPac)validateControlledBundledSearchResult(result,{expectedCommit,expectedCliSha256});
 else if(nativeWebSearch)validateInstalledNativeSearchResult(result,{expectedCommit,expectedCliSha256});
 if(options.nativeBundledParentRoute&&!controlledPac)validateBundledParentSearchResult(result,{expectedCommit,expectedCliSha256});
 if(nativeComponents){if(zeroBusiness){const observation=result.steps[0];assert.equal(observation.probe.zeroBusinessObservation,true);assert.equal(observation.isAdmin,false);assert.equal(observation.probe.logicalQueries,0);assert.equal(observation.probe.modelCalls,0);await context.writeArtifactJson('windows-zero-business-result.json',result);return result;}assert.equal(result.verificationScope,'actual_native_windows_components');if(browserProfileNative)validateWindowsBrowserProfileNativeResult(result,{mode:browserProfileNativeMode});await context.writeArtifactJson('windows-native-components-result.json',result);return result;}
 if(officeUpgradeOnly){
  assert.equal(result.verificationScope,officeFreshInstallOnly?'installed_office_fresh':'installed_office_upgrade');assert.deepEqual(result.ui,[]);assert.equal(result.historyRestored,false);assert.equal(result.oldUiStartupVerified,false);
 }else validateWindowsInstallerUiResult(result,{directoryTrust,exerciseUI,smokeOnly});
 if(expectedCommit&&!mechanismOnlyUpgrade) assert.deepEqual(result.buildIdentity,{build_commit:expectedCommit,build_dirty:false,executable_sha256:expectedCliSha256},'Fresh or upgraded installed CLI execution must match the frozen clean build');
 if(newInstaller&&!officeFreshInstallOnly&&!options.nativeWebFreshOnly)validateWindowsInstallerUpgradeResult(result,{mechanismOnlyUpgrade,officeNative,nativeWebSearch,expectedCommit,expectedCliSha256,oldSha256,newSha256});

 await context.writeArtifactJson('windows-installer-result.json',result);
 return result;
}
export async function verifyWindowsNativeComponents(context,options){
 return verifyWindowsInstallerMechanism(context,{...options,installer:options.probeCli,nativeComponentsProbe:true});
}
