import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runE2E } from '../harness/run-context.mjs';
import { runWindowsNativeLibtest } from '../harness/windows-native-libtest.mjs';
import { windowsNativeCaseContext } from '../harness/windows-native-case.mjs';


export async function runWindowsWebNetwork({scope = process.env.KCODER_E2E_WEB_NATIVE_SCOPE, externalAuthorized = false, sourceUrl = import.meta.url} = {}) {
assert.equal(process.env.KCODER_E2E_WINDOWS_NATIVE_LIBTEST, '1', 'Explicit native platform consent is required');
assert.equal(typeof scope, 'string', 'Choose a finite native web scope');
assert.ok(!scope.startsWith('external-') || externalAuthorized, 'Use the separately consented external matrix entry');
const roster = JSON.parse(await readFile(new URL('../fixtures/web-network-native-roster.json', import.meta.url)));
assert.ok(['tools', 'engine', 'mcp', 'pac', 'system-observe', 'runtime', 'runtime-verify', 'external-read', 'external-python', 'external-diagnostic', 'external-python-diagnostic', 'external-python-direct','external-python-hostname-diagnostic'].includes(scope));
const options = {
  consent: process.env.KCODER_E2E_WINDOWS_NATIVE_LIBTEST,
  ...(process.env.KCODER_E2E_WINDOWS_CHUNKED_TRANSFER==='1'?{chunkedTransfer:true}:{}),
  ...(process.env.KCODER_E2E_WINDOWS_LEGACY_SCP==='1'?{legacyScp:true}:{}),
  ...(process.env.KCODER_E2E_WINDOWS_TRANSFER_COMPRESSION==='1'?{compressTransfer:true}:{}),
  target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET,
  parent: process.env.KCODER_E2E_WINDOWS_PROBE_PARENT,
  node: process.env.KCODER_E2E_WINDOWS_NODE,
  testBinary: process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_BIN,
  ...(process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_GZIP?{testBinaryArchive:process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_GZIP,testBinaryArchiveSha256:process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_GZIP_SHA256}:{}),
  testSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_SHA256,
  sourceTreeSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_SOURCE_SHA256,
  supervisor: process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_BIN,
  supervisorSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_SHA256,
};
if (scope.startsWith('external-')) assert.equal(process.env.KCODER_E2E_WEB_EXTERNAL_NETWORK, '1', 'External web read requires a separate explicit consent');
const external = 'web_network::system_proxy::native_observation::native_inherited_proxy_reads_one_fixed_public_source_with_verified_tls';
const observer = 'web_network::system_proxy::native_observation::native_static_proxy_observation_is_read_only_and_redacted';
return runE2E(sourceUrl, {
  testId: `windows-web-network-${scope}`, tier: 'manual-live', cleanupTimeoutMs: 120000,
  modelPolicy: (scope==='external-python-hostname-diagnostic'?'One fixed official Python URL through the current static system proxy using ordinary hostname CONNECT and system curl. No credential, TLS bypass, Registry write, numeric destination override or pinned product-read acceptance.':scope.endsWith('direct') ? 'One explicitly consented owned direct pinned TLS diagnostic, without modifying the target proxy settings; it is not a successful default-route product read.' : scope.startsWith('external-') ? 'One fixed public example.com or official Python HTTPS read through the actual target static proxy; explicit external and native consent, no model, Key, personal query, Registry write or installer acceptance.' : 'Actual GNU Rust tests on an authorized Windows host with owned profiles, exact test roster and held Job supervision. Only controlled loopback fixture traffic or read-only redacted system proxy observation; no external model/provider, personal settings, Registry writes, installed application or installer acceptance.'),
}, async context => {
  const selected = (scope.endsWith('diagnostic')||scope.endsWith('direct')) ? [{names:['pinned_proxy_diagnostic']}] : ['external-read','external-python'].includes(scope) ? [{names: [external], exact: external}] : scope === 'runtime-verify' ? [{names:['native_sealed_runtime_verify_only']}] : scope === 'runtime' ? [{names: ['test_real_curl_cannot_bypass_private_destination_guard', 'test_real_service_cannot_reach_an_ungranted_private_upstream', 'test_real_service_search_authentication_and_owner_eof']}] : scope === 'system-observe' ? [{ names: [observer], exact: observer }] : roster[scope];
  const results = [];
  for (const [index, selection] of selected.entries()) {
    const child = windowsNativeCaseContext(context, `${scope}-${index}`);
    results.push(await runWindowsNativeLibtest(child, { ...options,
      expectedTests: selection.names,
      ...(scope === 'pac' ? { pacFixture: true, runIgnored: true } : {}),
      ...(['external-read','external-python'].includes(scope) ? {externalWebRead:true,externalWebCase:scope==='external-python'?'python-asyncio':'example'} : {}),
      ...((scope.endsWith('diagnostic')||scope.endsWith('direct')) ? {probeKind:'web-diagnostic',externalWebCase:scope.includes('python')?'python-asyncio':'example',...(scope.endsWith('direct')?{diagnosticDirect:true}:scope==='external-python-hostname-diagnostic'?{diagnosticHostname:true}:{})} : {}),
      ...(scope === 'runtime-verify' ? {probeKind:'web-verify-only',runtimeArchive:process.env.KCODER_E2E_WEB_RUNTIME_ARCHIVE,runtimeArchiveSha256:process.env.KCODER_E2E_WEB_RUNTIME_SHA256} : {}),
      ...(scope === 'runtime' ? {probeKind: 'web-runtime', runtimeArchive: process.env.KCODER_E2E_WEB_RUNTIME_ARCHIVE, runtimeArchiveSha256: process.env.KCODER_E2E_WEB_RUNTIME_SHA256} : selection.exact ? { exactTest: selection.exact, runIgnored: true } : { testFilter: selection.filter }),
    }));
  }
  return { passed: true, scope, nativeCases: results.reduce((total, row) => total + row.summary.passed, 0),
    externalRequests: scope==='external-python-hostname-diagnostic' ? 1 : scope.endsWith('diagnostic') ? 3 : scope.startsWith('external-') ? 1 : 0, installerAcceptance: false, results };
});

}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runWindowsWebNetwork();
