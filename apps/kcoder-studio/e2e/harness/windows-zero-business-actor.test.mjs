import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {verifyWindowsNativeComponents} from './windows-installer-lifecycle.mjs';

test('ordinary zero-business mode cannot bypass the existing gates or component scope',async()=>{
 const options={target:'fixture@owned',installation:'C:\\Users\\fixture\\AppData\\Local\\Programs\\kcoder-studio',node:'C:\\node.exe',probeCli:'/owned/probe.exe',probeSupervisor:'/owned/supervisor.exe',zeroBusinessMode:'exa-head',diagnosticSourceCommit:'a'.repeat(40),sourceTreeSha256:'b'.repeat(64),nativeConsent:'1',externalConsent:'1'};
 for(const patch of [{zeroBusinessMode:'search'},{nativeConsent:undefined},{externalConsent:undefined},{diagnosticSourceCommit:'unknown'},{sourceTreeSha256:'unknown'},{exerciseUI:true}])await assert.rejects(verifyWindowsNativeComponents({},{...options,...patch}));
});
test('control endpoints are fixed HEAD without query or redirects; actor source persists no response body',async()=>{
 const source=await readFile(new URL('./windows-zero-business-actor.ps1',import.meta.url),'utf8');
 assert.match(source,/https:\/\/mcp\.exa\.ai\/mcp/);assert.match(source,/https:\/\/www\.bing\.com\/search/);
 assert.match(source,/AllowAutoRedirect=\$false/);assert.match(source,/HttpMethod\]::Head/);
 assert.doesNotMatch(source,/ReadAsString|ReadAsByte|ServerCertificateCustomValidationCallback|\/search\?q=|UseDefaultCredentials=\$true/);
 assert.match(source,/StandardInput\.WriteLine/);assert.match(source,/heldProcessHandle=\$process\.Handle/);assert.match(source,/StandardInput\.Close/);assert.match(source,/\$process\.Kill\(\)/);assert.doesNotMatch(source,/taskkill|Stop-Process|\/PID|\/T\b/);
 assert.match(source,/private-state-directory\.ps1/);assert.match(source,/rawStderrPersisted=\$false/);
});

test("WPAD observation uses only official discovery and frees the returned pointer",async()=>{const source=await readFile(new URL("./windows-wpad-discovery.ps1",import.meta.url),"utf8");assert.match(source,/WinHttpDetectAutoProxyConfigUrl\(DHCP \| DNS_A/);assert.match(source,/finally.*GlobalFree\(pointer\)/);assert.match(source,/if\(\$CompileOnly\)/);assert.match(source,/apiCallAttempted=\$false/);assert.doesNotMatch(source,/WinHttpGetProxyForUrl|HttpClient|WebRequest|ReadAsString|Get-Content/);});

test("in-process actor accepts only fixed compile flag and keeps destination HTTP absent",async()=>{const actor=await readFile(new URL("./windows-zero-business-actor.ps1",import.meta.url),"utf8");const probe=await readFile(new URL("./windows-native-libtest-probe.mjs",import.meta.url),"utf8");assert.match(actor,/winhttp-inprocess-compile/);assert.match(actor,/destinationHttpSent -ne \$false/);assert.match(probe,/input\.inProcessCompileOnly===true\?\['-CompileOnly'\]/);assert.match(probe,/winhttp-inprocess\.ps1/);assert.doesNotMatch(actor,/taskkill|Stop-Process|\/PID|\/T\b/);});
