import assert from 'node:assert/strict';
import test from 'node:test';
import { windowsInstallerFixtureParent, validateWindowsInstallerInputs, validateWindowsInstallerDirectoryTrust, validateWindowsInstallerUiResult, validateWindowsInstallerUpgradeMode, validateWindowsInstallerUpgradeResult } from './windows-installer-lifecycle.mjs';
import { suiteEnvironmentNames } from './runner-options.mjs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
test('installation lifecycle requires an explicit Windows host and a personal read-only baseline',()=>{
 const good={target:'fixture@10.0.0.1',installation:'C:\\Users\\fixture\\AppData\\Local\\Programs\\kcoder-studio',installer:'/owned/old.exe'};
 assert.doesNotThrow(()=>validateWindowsInstallerInputs(good));
 for(const patch of [{target:'fixture@host;echo bad'},{installation:'C:\\Windows'},{installer:'/owned/app.asar'}])assert.throws(()=>validateWindowsInstallerInputs({...good,...patch}));
});
test('ordinary installed UI uses an owned common parent without traversing a personal AppData tree',()=>{
 assert.equal(windowsInstallerFixtureParent({exerciseUI:true}),'C:\\ProgramData');
 assert.equal(windowsInstallerFixtureParent({nativeComponents:true}),'C:\\ProgramData');
 assert.equal(windowsInstallerFixtureParent({minimalUninstallProbe:true}),'C:\\ProgramData');
 assert.equal(windowsInstallerFixtureParent({exerciseUI:true,probeVolume:'D'}),'D:\\');
 assert.equal(windowsInstallerFixtureParent({}),null);
 assert.throws(()=>windowsInstallerFixtureParent({probeVolume:'..'}));
});
test('a new installer cannot run without a frozen source commit and CLI digest',async()=>{
 const {verifyWindowsInstallerMechanism}=await import('./windows-installer-lifecycle.mjs');
 const options={target:'fixture@10.0.0.1',installation:'C:\\Users\\fixture\\AppData\\Local\\Programs\\kcoder-studio',installer:'/owned/old.exe',newInstaller:'/owned/new.exe',exerciseUI:true,node:'C:\\node.exe'};
 // Input rejection precedes reading package bytes, creating accounts or accepting secrets.
 await assert.rejects(verifyWindowsInstallerMechanism({},options),/frozen full source commit/);
 await assert.rejects(verifyWindowsInstallerMechanism({},{...options,expectedCommit:'d3b9e8876',expectedCliSha256:'a'.repeat(64)}),/frozen full source commit/);
 await assert.rejects(verifyWindowsInstallerMechanism({},{...options,expectedCommit:'a'.repeat(40),expectedCliSha256:'missing'}),/frozen full source commit/);
});

test('mechanism-only same-version upgrade is explicit and cannot claim UI or source certification',async()=>{
 const options={newInstaller:'/owned/new.exe',mechanismOnlyUpgrade:true};
 assert.equal(validateWindowsInstallerUpgradeMode(options),true);
 assert.equal(validateWindowsInstallerUpgradeMode({newInstaller:'/owned/new.exe',exerciseUI:true}),false);
 for(const patch of [{mechanismOnlyUpgrade:false},{mechanismOnlyUpgrade:'1'},{newInstaller:undefined},{newInstaller:'/owned/app.asar'},{exerciseUI:true},{smokeOnly:true},{directoryTrust:true}]){
  assert.throws(()=>validateWindowsInstallerUpgradeMode({...options,...patch}),/upgrade|Upgrade/);
 }
 const {verifyWindowsInstallerMechanism}=await import('./windows-installer-lifecycle.mjs');
 await assert.rejects(verifyWindowsInstallerMechanism({}, {target:'fixture@10.0.0.1',installation:'C:\\Users\\fixture\\AppData\\Local\\Programs\\kcoder-studio',installer:'/nonexistent/old.exe',...options}),{code:'ENOENT'});
});

test('mechanism-only receipt requires real old install, replacement and uninstall without a clean-build claim',()=>{
 const cliHash='b'.repeat(64);
 const install=label=>({action:'install',sid:'S-1-5-21-owned',installedCliVersion:'kcoder 1.0.0',installedResources:{'resources\\bin\\kcoder.exe':cliHash,'resources\\app.asar':label}});
 const result={passed:true,upgraded:true,mechanismOnly:true,verificationScope:'nsis_mechanism',directoryTrust:'not_requested',ui:[],buildIdentity:null,buildIdentityProbeOwner:'not_requested',steps:[{action:'inspect'},install('old'),install('new'),{action:'uninstall'}]};
 const options={mechanismOnlyUpgrade:true,oldSha256:'a'.repeat(64),newSha256:'c'.repeat(64),expectedCliSha256:cliHash};
 assert.doesNotThrow(()=>validateWindowsInstallerUpgradeResult(result,options));
 // Identical installer bytes can also exercise actual same-version replacement.
 const same=structuredClone(result);same.steps[2].installedResources={...same.steps[1].installedResources};
 assert.doesNotThrow(()=>validateWindowsInstallerUpgradeResult(same,{...options,newSha256:options.oldSha256}));
 for(const change of [value=>{value.steps.splice(2,1)},value=>{value.steps[2].sid='foreign'},value=>{value.ui=[{label:'fake'}]},value=>{value.verificationScope='installed_ui'},value=>{value.buildIdentity={build_dirty:false}},value=>{value.buildIdentityProbeOwner='ui-profile-owner'},value=>{value.steps[2].installedResources['resources\\bin\\kcoder.exe']='d'.repeat(64)}]){
  const changed=structuredClone(result);change(changed);assert.throws(()=>validateWindowsInstallerUpgradeResult(changed,options));
 }
 const full={...structuredClone(result),mechanismOnly:false,buildIdentity:{build_commit:'e'.repeat(40),build_dirty:false,executable_sha256:cliHash}};
 assert.doesNotThrow(()=>validateWindowsInstallerUpgradeResult(full,{...options,mechanismOnlyUpgrade:false,expectedCommit:'e'.repeat(40)}));
 full.buildIdentity.build_dirty=true;
 assert.throws(()=>validateWindowsInstallerUpgradeResult(full,{...options,mechanismOnlyUpgrade:false,expectedCommit:'e'.repeat(40)}),/frozen clean build/);
});

test('session keeps explicit mechanism replacement outside the installed UI branch',()=>{
 const session=readFileSync(new URL('./windows-installer-session.ps1',import.meta.url),'utf8');
 const replacement=session.indexOf("if($request.mechanismOnlyUpgrade){Run-OwnedUserAction 'install'");
 assert.ok(replacement>session.indexOf("Run-OwnedUserAction 'install' (Join-Path $RunRoot 'old.exe')"));
 assert.ok(replacement<session.indexOf('if($request.exerciseUI) {'));
 assert.ok(session.indexOf("Run-OwnedUserAction 'uninstall'",replacement)>replacement);
 const user=readFileSync(new URL('./windows-installer-user.ps1',import.meta.url),'utf8');
 assert.ok(user.includes("if($buildIdentity.build_dirty -ne $false){throw 'Installed CLI was built from a dirty source tree'}"));
 const suite=readFileSync(new URL('../suites/gateway/windows-installer-lifecycle.e2e.mjs',import.meta.url),'utf8');
 assert.ok(suite.includes("mechanismOnlyUpgrade:process.env.KCODER_E2E_WINDOWS_INSTALLER_MECHANISM_UPGRADE==='1'"));
});

test('extra directory trust is opt-in only for the original full upgrade lifecycle',()=>{
 const full={exerciseUI:true,newInstaller:'/owned/new.exe'};
 assert.equal(validateWindowsInstallerDirectoryTrust(full),false);
 assert.equal(validateWindowsInstallerDirectoryTrust({...full,directoryTrust:true}),true);
 for(const patch of [{exerciseUI:false},{smokeOnly:true},{newInstaller:undefined},{directoryTrust:'1'}]){
  assert.throws(()=>validateWindowsInstallerDirectoryTrust({...full,directoryTrust:true,...patch}),/Directory trust/);
 }
 const flag='KCODER_E2E_WINDOWS_INSTALLER_DIRECTORY_TRUST';
 assert.ok(suiteEnvironmentNames('suites/gateway/windows-installer-lifecycle.e2e.mjs').includes(flag));
 for(const suite of ['suites/gateway/windows-migration.e2e.mjs','suites/gateway/windows-cross-host-source.e2e.mjs','suites/browser/migration.e2e.mjs'])assert.equal(suiteEnvironmentNames(suite).includes(flag),false);
});

test('core upgrade results retain both restoration stages without claiming directory trust',()=>{
 const core={passed:true,actualInstalledResources:true,historyRestored:true,modelBodyRetained:true,themeRetained:true,targetRetained:true,pluginRetained:true,pluginHookExecuted:true,directoryTrust:'not_requested'};
 const result={steps:[{action:'install',sid:'ordinary'}],directoryTrust:'not_requested',ui:[{label:'seed',sid:'ordinary',isAdmin:false,result:{passed:true,directoryTrust:'not_requested'}},...['restored','restarted'].map(label=>({label,sid:'ordinary',isAdmin:false,result:{...core}}))]};
 const options={exerciseUI:true};
 assert.doesNotThrow(()=>validateWindowsInstallerUiResult(result,options));
 for(const change of [
  value=>{value.directoryTrust='verified'},
  value=>{value.ui[1].result.directoryTrust='verified'},
  value=>{value.ui[1].result.windowsDirectoryTrustVerified=true},
  value=>{value.ui.pop()},
  value=>{value.ui[1].sid='peer'},
  value=>{value.ui[1].isAdmin=true},
  ...['actualInstalledResources','historyRestored','modelBodyRetained','themeRetained','targetRetained','pluginRetained','pluginHookExecuted'].map(fact=>value=>{value.ui[2].result[fact]=false}),
 ]){
  const changed=structuredClone(result);change(changed);
  assert.throws(()=>validateWindowsInstallerUiResult(changed,options));
 }
 const requested=structuredClone(result);requested.directoryTrust='verified';
 for(const item of requested.ui.slice(1)){item.result.directoryTrust='verified';item.result.windowsDirectoryTrustVerified=true}
 assert.doesNotThrow(()=>validateWindowsInstallerUiResult(requested,{exerciseUI:true,directoryTrust:true}));
 delete requested.ui[2].result.windowsDirectoryTrustVerified;
 assert.throws(()=>validateWindowsInstallerUiResult(requested,{exerciseUI:true,directoryTrust:true}));
});

test('existing smoke results keep their own smaller scope and never claim directory trust',()=>{
 const result={steps:[{action:'install',sid:'ordinary'}],directoryTrust:'not_requested',ui:['seed','restored'].map(label=>({label,sid:'ordinary',isAdmin:false,result:{passed:true,smokeOnly:true,directoryTrust:'not_requested'}}))};
 assert.doesNotThrow(()=>validateWindowsInstallerUiResult(result,{exerciseUI:true,smokeOnly:true}));
 assert.throws(()=>validateWindowsInstallerUiResult(result,{exerciseUI:true}));
});

test('installed probe arguments separate current capability checks from explicit directory trust',()=>{
 const source=readFileSync(new URL('./windows-studio-ui-probe.cjs',import.meta.url),'utf8');
 const end=source.indexOf('const lifecycleModelUrl');assert.ok(end>0);
 const flags=argv=>runInNewContext(source.slice(0,end)+'\n({lifecycleCurrentFeatures,lifecycleDirectoryTrust,lifecycleSmoke})',{
  require:createRequire(import.meta.url),process:{argv:['node','probe.cjs',...argv]},
 });
 const core=['--direct-install','--lifecycle-verify','--lifecycle-current-features'];
 assert.equal(flags(core).lifecycleCurrentFeatures,true);
 assert.equal(flags(core).lifecycleDirectoryTrust,false);
 assert.equal(flags([...core,'--lifecycle-directory-trust']).lifecycleDirectoryTrust,true);
 assert.equal(flags([...core,'--lifecycle-smoke']).lifecycleSmoke,true);
 for(const missing of core)assert.throws(()=>flags([...core.filter(flag=>flag!==missing),'--lifecycle-directory-trust']),/Directory trust/);
 assert.throws(()=>flags([...core,'--lifecycle-directory-trust','--lifecycle-smoke']),/Directory trust/);
});

test('actual Windows cleanup rejects a wrong owner and removes only owned readonly files', {
 skip: process.env.KCODER_E2E_WINDOWS_CLEANUP_PROBE !== '1',
}, async () => {
 const { randomUUID, randomBytes } = await import('node:crypto');
 const { readFile } = await import('node:fs/promises');
 const { runE2E } = await import('./run-context.mjs');
 const { windowsSshInvocation } = await import('./windows-ssh-auth.mjs');
 const target = process.env.KCODER_E2E_WINDOWS_SSH_TARGET;
 assert.match(target || '', /^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/);
 const owner = randomUUID(), username = 'kc_e2e_' + randomBytes(4).toString('hex');
 const source = await readFile(new URL('./windows-installer-cleanup.ps1', import.meta.url), 'utf8');
 await runE2E(import.meta.url, { testId: 'windows-installer-owned-readonly-cleanup', tier: 'manual-live',
  modelPolicy: 'actual owned Windows temporary files only; no installer, account creation, personal data or model',
 }, async context => {
  const execute = (cleanupOnly) => new Promise((resolve, reject) => {
   const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$request=[Console]::In.ReadToEnd()|ConvertFrom-Json;$root=Join-Path ([IO.Path]::GetTempPath()) ('kcoder-installer-'+$request.owner);$cleanup=[ScriptBlock]::Create($request.source);if($request.cleanupOnly){if(Test-Path -LiteralPath $root){& $cleanup -RunRoot $root -Owner $request.owner -Username $request.username};exit};if(Test-Path -LiteralPath $root){throw 'Owned fixture collision'};if(Get-LocalUser -Name $request.username -ErrorAction SilentlyContinue){throw 'Fixture account name collision'};[void][IO.Directory]::CreateDirectory($root);[IO.File]::WriteAllText((Join-Path $root '.owner.json'),(@{owner=$request.owner;username=$request.username}|ConvertTo-Json -Compress));$file=Join-Path $root 'readonly-fixture.txt';[IO.File]::WriteAllText($file,'Owned readonly cleanup fixture');[IO.File]::SetAttributes($file,[IO.FileAttributes]::ReadOnly);$rejected=$false;try{& $cleanup -RunRoot $root -Owner ([Guid]::NewGuid().ToString()) -Username $request.username}catch{$rejected=$true};if(!$rejected -or !(Test-Path -LiteralPath $file)){throw 'Wrong owner changed fixture'};$result=& $cleanup -RunRoot $root -Owner $request.owner -Username $request.username;$facts=$result|ConvertFrom-Json;if(!$facts.cleaned -or $facts.readOnlyFilesCleared -ne 1 -or (Test-Path -LiteralPath $root)){throw 'Readonly cleanup incomplete'};@{wrongOwnerRejected=$true;readOnlyFilesCleared=$facts.readOnlyFilesCleared;directoryAbsent=$true;accountCreated=$false}|ConvertTo-Json -Compress`;
   const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target, 'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
   const spec = windowsSshInvocation(context, 'ssh', args, target);
   const child = cleanupOnly
    ? context.spawnCleanupOwned('windows-readonly-cleanup-reconcile', spec.command, spec.args, { ...spec.options, stdin: 'pipe', signal: AbortSignal.timeout(30000) })
    : context.spawnOwned('windows-readonly-cleanup-probe', spec.command, spec.args, { ...spec.options, stdin: 'pipe', signal: AbortSignal.timeout(30000) });
   let stdout = '';
   child.stdout.on('data', bytes => { stdout += bytes; });
   child.once('error', reject);
   child.once('close', code => code === 0 ? resolve(stdout.trim()) : reject(Error(`Windows owned cleanup probe exited ${code}`)));
   child.stdin.end(JSON.stringify({ owner, username, source, cleanupOnly }));
  });
  context.addCleanup('reconcile exact readonly fixture root', () => execute(true));
  const facts = JSON.parse(await execute(false));
  assert.deepEqual(facts, { wrongOwnerRejected: true, readOnlyFilesCleared: 1, directoryAbsent: true, accountCreated: false });
  await context.writeArtifactJson('windows-readonly-cleanup.json', facts);
  return facts;
 });
});


test('Windows component parent probe keeps explicit input scope before creating any account', async () => {
 const {verifyWindowsNativeComponents} = await import('./windows-installer-lifecycle.mjs');
 const owned = {target:'fixture@host', installation:'C:\\Users\\fixture\\AppData\\Local\\Programs\\kcoder-studio',
  probeCli:'/owned/cli.exe', probeSupervisor:'/owned/supervisor.exe', sdkArchive:'/owned/channel.zip', node:'C:\\node.exe'};
 for (const patch of [{exerciseUI:true}, {newInstaller:'/owned/setup.exe'}, {smokeOnly:true}, {minimalUninstallProbe:true}, {node:undefined}, {sdkArchive:undefined}])
  await assert.rejects(verifyWindowsNativeComponents({}, {...owned,...patch}), /Native component probe scope conflict|Upgrade requires/);
 const flags = suiteEnvironmentNames('suites/gateway/windows-native-components.e2e.mjs');
 for (const flag of ['KCODER_E2E_WINDOWS_NATIVE_COMPONENTS','KCODER_E2E_WINDOWS_NATIVE_CLI','KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR','KCODER_E2E_WINDOWS_CHANNEL_SOURCE_ARCHIVE']) {
  assert.ok(flags.includes(flag));
  assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(flag),false);
 }
});

test('ordinary Chromium native acceptance cannot claim UI or use a peer/admin result',async()=>{
 const {validateWindowsBrowserProfileNativeResult}=await import('./windows-installer-lifecycle.mjs');
 const result={passed:true,verificationScope:'actual_native_windows_components',steps:[{action:'nativeComponents',sid:'original-owner',probe:{passed:true,verificationScope:'ordinary_windows_actual_chromium_native_profile_consumer',sid:'original-owner',isAdmin:false,summary:{passed:1,failed:0,ignored:0},modelCalls:0,studioUi:false,appServerCrash:false,nativeObservation:{defaultProductionProfile:true,chromiumDefaultKeyPolicy:true,passwordStoreOverride:false}}}]};
 assert.doesNotThrow(()=>validateWindowsBrowserProfileNativeResult(result));
 for(const patch of [{sid:'peer'},{isAdmin:true},{passed:false},{studioUi:true},{appServerCrash:true},{summary:{passed:1,failed:0,ignored:1}}]){
  const changed=structuredClone(result);Object.assign(changed.steps[0].probe,patch);
  assert.throws(()=>validateWindowsBrowserProfileNativeResult(changed));
 }
});


test('Office current installer acceptance is opt-in and cannot pass with browser download requested',async()=>{
 const {validateWindowsInstallerOfficeMode,validateWindowsInstalledOfficeResult}=await import('./windows-installer-lifecycle.mjs');
 const options={officeNative:true,exerciseUI:true,newInstaller:'/owned/final.exe'};
 assert.equal(validateWindowsInstallerOfficeMode(options),true);
 for(const patch of [{exerciseUI:false},{newInstaller:undefined},{smokeOnly:true},{mechanismOnlyUpgrade:true},{nativeComponentsProbe:true}])assert.throws(()=>validateWindowsInstallerOfficeMode({...options,...patch}));
 assert.equal(validateWindowsInstallerOfficeMode({...options,officeUpgradeOnly:true}),true);
 for(const patch of [{officeNative:false},{officeUpgradeOnly:'1'},{directoryTrust:true}])assert.throws(()=>validateWindowsInstallerOfficeMode({...options,officeUpgradeOnly:true,...patch}));
 assert.equal(validateWindowsInstallerOfficeMode({...options,officeUpgradeOnly:true,officeFreshInstallOnly:true}),true);
 assert.throws(()=>validateWindowsInstallerOfficeMode({...options,officeFreshInstallOnly:true}));
 const office={passed:true,actualInstalledElectron:true,actualNativeOfficeGeneration:true,actualArtifactCollection:true,nativeDownloadStatus:'completed',nativeDialogInvoked:true,bytes:300000,sha256:'a'.repeat(64),attachmentChunkReads:[{offset:0,length:262144}],controlledProviderRequests:3,additionalDownloadProviderRequests:0,externalModelCalls:0,platformCalls:0,qualityClaim:false};
 const result={steps:[{action:'install',sid:'owned-user'},{action:'officeUI',sid:'owned-user'}],office:{result:office}};
 assert.doesNotThrow(()=>validateWindowsInstalledOfficeResult(result,true));
 for(const key of ['nativeDownloadStatus','actualInstalledElectron','nativeDialogInvoked','sha256','qualityClaim']){
  const bad=structuredClone(result);bad.office.result[key]=key==='nativeDownloadStatus'?'download_requested':key==='sha256'?'missing':key==='qualityClaim'?true:false;
  assert.throws(()=>validateWindowsInstalledOfficeResult(bad,true));
 }
 const foreign=structuredClone(result);foreign.steps[1].sid='peer';assert.throws(()=>validateWindowsInstalledOfficeResult(foreign,true));
});


test('serialized browser history seed owns its websocket without Node globals', async()=>{
 const source=readFileSync(new URL('./windows-studio-ui-probe.cjs',import.meta.url),'utf8');
 const start=source.indexOf('async function seedProjectHistory(');
 const end=source.indexOf('\n(async () => {',start);
 assert.ok(start>=0&&end>start);
 const sockets=[];
 class BrowserSocket extends EventTarget {
  constructor(){super();sockets.push(this);queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
  send(text){const request=JSON.parse(text);const result=request.method==='plugin/install'?{plugin:{id:'owned-plugin'}}:{};
   queueMicrotask(()=>{const event=new Event('message');event.data=JSON.stringify({id:request.id,result});this.dispatchEvent(event);});}
  close(){this.dispatchEvent(new Event('close'));}
 }
 const result=await runInNewContext('('+source.slice(start,end)+')(undefined,false,"owned-plugin")',{
  URL,location:{href:'http://127.0.0.1:12345/',protocol:'http:'},
  document:{querySelector(){return {content:'synthetic-csrf'};}},WebSocket:BrowserSocket,setTimeout,clearTimeout,
 });
 assert.equal(result,'owned-plugin');assert.equal(sockets.length,1);
});
