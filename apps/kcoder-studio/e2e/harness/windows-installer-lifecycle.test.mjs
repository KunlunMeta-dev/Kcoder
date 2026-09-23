import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWindowsInstallerInputs } from './windows-installer-lifecycle.mjs';
test('installation lifecycle requires an explicit Windows host and a personal read-only baseline',()=>{
 const good={target:'fixture@10.0.0.1',installation:'C:\\Users\\fixture\\AppData\\Local\\Programs\\kcoder-studio',installer:'/owned/old.exe'};
 assert.doesNotThrow(()=>validateWindowsInstallerInputs(good));
 for(const patch of [{target:'fixture@host;echo bad'},{installation:'C:\\Windows'},{installer:'/owned/app.asar'}])assert.throws(()=>validateWindowsInstallerInputs({...good,...patch}));
});
test('a new installer cannot run without a frozen source commit and CLI digest',async()=>{
 const {verifyWindowsInstallerMechanism}=await import('./windows-installer-lifecycle.mjs');
 const options={target:'fixture@10.0.0.1',installation:'C:\\Users\\fixture\\AppData\\Local\\Programs\\kcoder-studio',installer:'/owned/old.exe',newInstaller:'/owned/new.exe',exerciseUI:true,node:'C:\\node.exe'};
 // Input rejection precedes reading package bytes, creating accounts or accepting secrets.
 await assert.rejects(verifyWindowsInstallerMechanism({},options),/frozen full source commit/);
 await assert.rejects(verifyWindowsInstallerMechanism({},{...options,expectedCommit:'d3b9e8876',expectedCliSha256:'a'.repeat(64)}),/frozen full source commit/);
 await assert.rejects(verifyWindowsInstallerMechanism({},{...options,expectedCommit:'a'.repeat(40),expectedCliSha256:'missing'}),/frozen full source commit/);
});
