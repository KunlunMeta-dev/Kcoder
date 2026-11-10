import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {validateControlledBundledSearchMode} from './windows-installer-lifecycle.mjs';
import {controlledPacNativeCase} from './windows-native-web-search.mjs';
import {validateManagedPacObservation} from './windows-managed-pac-session.mjs';

test('controlled installation remains distinct from real default and cannot switch package source',()=>{
 const value={nativeBundledControlled:true,controlledPacConsent:'1',controlledInstallerSha256:'269c68e623053c80172bed3b915ece0a6e96b115137a488b845184ee6c3bf5cc',nativeWebSearch:true,nativeWebFreshOnly:true,nativeBundledParentRoute:true,installer:'/owned/d3.exe',newInstaller:'/owned/d3.exe',expectedCommit:'d3d8211ea3f8aa2bbbf6e289fa0dc05f78f5892d',expectedCliSha256:'c57332022e2dff2b54df26463105f67760ae85bcec261ee6342104bea72062dc',managedJobLauncher:'/owned/original-job.exe',controlledCertificates:{fixtureId:'11111111-2222-3333-4444-555555555555',caPath:'/private/ca.pem',certificatePath:'/private/leaf.pem',keyPath:'/private/leaf-key.pem'}};
 assert.equal(validateControlledBundledSearchMode(value),true);
 for(const patch of [{controlledPacConsent:undefined},{nativeWebFreshOnly:false},{nativeBundledParentRoute:false},{expectedCommit:'a'.repeat(40)},{newInstaller:'/owned/other.exe'},{controlledInstallerSha256:'b'.repeat(64)}])assert.throws(()=>validateControlledBundledSearchMode({...value,...patch}));
});
test('native receipt and actual numeric tunnel/TLS observations are independently required',()=>{
 const expected=controlledPacNativeCase('11111111-2222-3333-4444-555555555555');
 const native={passed:true,realDefaultPublicAcceptance:false,receipt:{provider:'searxng-bundled',sources:expected.expectedSources.map(url=>({url,readStatus:'summary_only'}))},nativeEof:{forcedKill:false,exitCode:0}};
 const stats={externalConnections:0,pacRequests:1,connectAccepted:1,tlsAccepted:1,originRequests:1,connectDenied:0,tlsRejected:0,originDenied:0,transportErrors:0};
 assert.doesNotThrow(()=>validateManagedPacObservation(native,stats,expected));
 for(const patch of [{externalConnections:1},{connectAccepted:0},{tlsAccepted:0},{originRequests:0},{originDenied:1}])assert.throws(()=>validateManagedPacObservation(native,{...stats,...patch},expected));
 assert.throws(()=>validateManagedPacObservation({...native,realDefaultPublicAcceptance:true},stats,expected));
});
test('controlled scope/API read preflight precedes install and fixture EOF uses original handles',async()=>{
 const session=await readFile(new URL('./windows-installer-session.ps1',import.meta.url),'utf8');
 const start=session.indexOf('if($request.nativeBundledControlled)');const controlled=session.slice(start,session.indexOf(" Run-OwnedUserAction 'inspect'",start));
 assert.ok(controlled.indexOf("'controlledPacPreflight'")<controlled.indexOf("'install'"));assert.ok(controlled.includes("finally{Run-OwnedUserAction 'uninstall'"));
 const actor=await readFile(new URL('./windows-managed-pac-actor.ps1',import.meta.url),'utf8');
 assert.doesNotMatch(actor,/taskkill|Stop-Process|\/PID|\/T\b/);assert.match(actor,/\$held=\$process.Handle/);assert.match(actor,/\$process.Kill\(\)/);
 assert.match(actor,/Stop-OwnedProxyFixture/);assert.match(actor,/SSL_CERT_FILE/);const user=await readFile(new URL('./windows-installer-user.ps1',import.meta.url),'utf8');assert.match(user,/if\(!\('OwnedWinHttpFlags' -as \[type\]\)\)/);
});
