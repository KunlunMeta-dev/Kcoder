import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {runE2E} from '../harness/run-context.mjs';
import {prepareWindowsManagedPacCertificates} from '../harness/windows-managed-pac-certificates.mjs';
import {verifyWindowsInstallerMechanism} from '../harness/windows-installer-lifecycle.mjs';

assert.equal(process.env.KCODER_E2E_WINDOWS_CONTROLLED_PAC,'1','Separate controlled own-SID PAC authorization required');
assert.equal(process.env.KCODER_E2E_WINDOWS_NATIVE_LIBTEST,'1');assert.equal(process.env.KCODER_E2E_WEB_EXTERNAL_NETWORK,'1');
const build=JSON.parse(await readFile(process.env.KCODER_E2E_WINDOWS_CONTROLLED_BUILD_RESULT,'utf8'));
assert.equal(build.sourceCommit,'d3d8211ea3f8aa2bbbf6e289fa0dc05f78f5892d');assert.equal(build.installerSha256,'269c68e623053c80172bed3b915ece0a6e96b115137a488b845184ee6c3bf5cc');
assert.equal(createHash('sha256').update(await readFile(build.installer)).digest('hex'),build.installerSha256);
await runE2E(import.meta.url,{testId:'windows-installed-native-controlled-owned-pac',tier:'manual-live',cleanupTimeoutMs:120000,
 modelPolicy:'Oned3 NSIS install under a fresh ordinary SID; read-only scope/API preflight before installation, then explicit own-SID HKCU fixture PAC apply/restore, one !bing controlled managed native query with normal ASK and3native summaries, actual Python/parent/numericCONNECT/TLS; no real default/public acceptance, no personal/machine Registry or certificate-store writes.'},async context=>{
 const certificates=await prepareWindowsManagedPacCertificates(context);
 await context.writeArtifactJson('controlled-package-source.json',{sourceCommit:build.sourceCommit,installerSha256:build.installerSha256,cliSha256:build.cliSha256,controlledFixtureId:certificates.fixtureId,realDefaultPublicAcceptance:false});
 return verifyWindowsInstallerMechanism(context,{target:process.env.KCODER_E2E_WINDOWS_SSH_TARGET,installation:process.env.KCODER_E2E_WINDOWS_STUDIO_DIRECTORY,node:process.env.KCODER_E2E_WINDOWS_NODE,
  installer:build.installer,newInstaller:build.installer,expectedCommit:build.sourceCommit,expectedCliSha256:build.cliSha256,
  nativeWebSearch:true,nativeWebFreshOnly:true,nativeBundledParentRoute:true,nativeBundledControlled:true,controlledPacConsent:'1',controlledInstallerSha256:build.installerSha256,nativeConsent:'1',externalConsent:'1',controlledCertificates:certificates,
  managedJobLauncher:process.env.KCODER_E2E_WINDOWS_MANAGED_JOB_LAUNCHER});
});
