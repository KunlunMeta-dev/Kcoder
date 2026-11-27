import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

test('per-user proxy fixture is definitions-only and guards nonce/SID/creator and both policy views',async()=>{
 const source=await readFile(new URL('./windows-owned-proxy-fixture.ps1',import.meta.url),'utf8');
 assert.match(source,/nativeBundledControlled -ne \$true/);assert.match(source,/controlledPacConsent -cne '1'/);
 assert.match(source,/creatorSid -ceq \$currentSid/);assert.match(source,/account.Description -cne/);
 assert.match(source,/RegistryView\]::Registry64/);assert.match(source,/RegistryView\]::Registry32/);
 assert.match(source,/OpenSubKey\(\$path,\$false\)/);assert.match(source,/ProxySettingsPerUser/);
 assert.doesNotMatch(source,/Set-ItemProperty|SetValue|CreateSubKey|Start-Service|X509Store|netsh/);
});
test('capture uses FLAGS_UI, restores FLAGS and releases native string allocations without public values',async()=>{
 const source=await readFile(new URL('./windows-owned-proxy-fixture.ps1',import.meta.url),'utf8');
 assert.match(source,/Kind=i==0\?10u/);assert.match(source,/Kind=1,Data/);assert.match(source,/GlobalFree\(option.Data.Text\)/);
 assert.match(source,/Original per-user proxy settings did not restore/);assert.match(source,/writeCountUnit=/);
 assert.match(source,/machineRegistryWrites=0,personalRegistryWrites=0/);assert.match(source,/globalCacheResetCalls=0/);
 assert.doesNotMatch(source,/public (?:string|Snapshot) (?:Before|Original|Proxy|Pac)\s*\{|ToString\(\).*Pac|Write-Host|Console\.Write/);
});
