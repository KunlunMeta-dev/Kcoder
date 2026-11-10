import assert from 'node:assert/strict';
import { runE2E } from '../../harness/run-context.mjs';
import { runWindowsPackageProbe } from '../../harness/windows-package-probe.mjs';

await runE2E(import.meta.url,{testId:'windows-existing-vendor-sources-idle-continuation',tier:'manual-live',modelPolicy:'explicit read-only personal-source consent; actual Windows source archives and idle continuation; no model turn or historical command; all target writes isolated'},async context=>{
  assert.equal(process.env.KCODER_E2E_WINDOWS_PERSONAL_MIGRATION_READ,'1','explicit existing-source read gate required');
  const roots=JSON.parse(process.env.KCODER_E2E_WINDOWS_MIGRATION_SOURCE_ROOTS||'null');
  for(const key of ['claude','codex'])assert.match(roots?.[key]||'',/^[A-Za-z]:\\[^\0\r\n]+$/);
  return runWindowsPackageProbe(context,{target:process.env.KCODER_E2E_WINDOWS_SSH_TARGET,node:process.env.KCODER_E2E_WINDOWS_NODE,
    parent:process.env.KCODER_E2E_WINDOWS_PROBE_PARENT,archive:process.env.KCODER_E2E_WINDOWS_PAYLOAD_ARCHIVE,
    archiveSha256:process.env.KCODER_E2E_WINDOWS_PAYLOAD_SHA256,nativeCommit: process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT, commit:process.env.KCODER_E2E_WINDOWS_EXPECTED_COMMIT,
    cliSha256:process.env.KCODER_E2E_WINDOWS_EXPECTED_CLI_SHA256,focus:'migration',
    taskContinuation:{authorized:true,noModel:true,sourceRoots:roots,endpoint:'http://127.0.0.1:9/',apiFormat:'openai_chat_completions',name:'fixture'}});
});
