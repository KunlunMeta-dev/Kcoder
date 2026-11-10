import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runE2E} from '../harness/run-context.mjs';
import {verifyWindowsNativeComponents} from '../harness/windows-installer-lifecycle.mjs';

const mode=process.env.KCODER_E2E_WEB_DIAGNOSTIC_MODE;
assert.ok(['exa-head','exa-handshake','searx-startup','wpad-detect','wpad-compile','winhttp-inprocess-compile','winhttp-inprocess-resolve'].includes(mode));
const input=JSON.parse(await readFile(process.env.KCODER_E2E_WEB_DIAGNOSTIC_INPUT,'utf8'));
assert.match(input.sourceCommit??'',/^[a-f0-9]{40}$/);assert.match(input.sourceTreeSha256??'',/^[a-f0-9]{64}$/);
assert.equal(input.cliBeforeSha256,'19f9e45a3c0caed0b28b35951e28a0bb511c9a76b01ba25149dc1f1dac7b25ef');assert.equal(input.cliAfterSha256,input.cliBeforeSha256);
const options={target:process.env.KCODER_E2E_WINDOWS_SSH_TARGET,installation:process.env.KCODER_E2E_WINDOWS_STUDIO_DIRECTORY,node:process.env.KCODER_E2E_WINDOWS_NODE,
 nativeConsent:process.env.KCODER_E2E_WINDOWS_NATIVE_LIBTEST,externalConsent:process.env.KCODER_E2E_WEB_EXTERNAL_NETWORK,zeroBusinessMode:mode,diagnosticSourceCommit:input.sourceCommit,sourceTreeSha256:input.sourceTreeSha256,
 probeCli:input.binary,probeSupervisor:process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_BIN,runtimeArchive:process.env.KCODER_E2E_WEB_RUNTIME_ARCHIVE,runtimeArchiveSha256:process.env.KCODER_E2E_WEB_RUNTIME_SHA256};
await runE2E(import.meta.url,{testId:'windows-ordinary-sid-zero-business-'+mode,tier:'manual-live',cleanupTimeoutMs:120000,
 modelPolicy:'New owned ordinary SID; fixed endpoint handshake or exact production startup observation only, no Search/tools-call/model or installation, no personal proxy/CA/Registry changes. Startup may initialize engines or resolve PAC.'},async context=>{
 await context.writeArtifactJson('zero-business-input-identity.json',{mode,...input});
 return verifyWindowsNativeComponents(context,options);
});
