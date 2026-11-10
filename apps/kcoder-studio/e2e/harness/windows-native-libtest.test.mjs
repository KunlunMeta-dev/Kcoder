import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeLibtestInputSizeLimit, validateNativeLibtestOptions } from './windows-native-libtest.mjs';
import { prepareSuiteArtifacts } from '../run-all.mjs';
import { suiteEnvironmentNames } from './runner-options.mjs';
import { WINDOWS_PAC_TEST_FILTER, WINDOWS_PAC_TESTS } from './windows-pac-fixture.mjs';

const valid = { consent: '1', target: 'owned-host', parent: 'D:\\', node: 'D:\\node.exe',
  testBinary: '/owned/tests.exe', supervisor: '/owned/supervisor.exe', testSha256: 'a'.repeat(64),
  supervisorSha256: 'b'.repeat(64), sourceTreeSha256: 'c'.repeat(64), expectedTests: ['an_actual_case'] };
test('PAC fixture is bound to the exact explicit-config native roster and cannot widen another probe', () => {
  const pac = { ...valid, pacFixture: true, runIgnored: true, testFilter: WINDOWS_PAC_TEST_FILTER, expectedTests: WINDOWS_PAC_TESTS };
  assert.doesNotThrow(() => validateNativeLibtestOptions(pac));
  for (const patch of [{ pacFixture: false }, { testFilter: 'web_network::tests::' }, { expectedTests: ['unrelated_case'] }, { probeKind: 'web-diagnostic' }, { runIgnored: undefined }])
    assert.throws(() => validateNativeLibtestOptions({ ...pac, ...patch }));
});
test('explicit ignored Chromium cases retain one exact pinned native roster', () => {
  const browser = { ...valid, exactTest: 'an_actual_case', runIgnored: true,
    chromiumArchive: '/owned/chromium.zip', chromiumArchiveSha256: 'd'.repeat(64) };
  assert.doesNotThrow(() => validateNativeLibtestOptions(browser));
  for (const patch of [{ exactTest: undefined }, { runIgnored: false },
    { chromiumArchiveSha256: undefined }, { probeKind: 'private-credentials' }])
    assert.throws(() => validateNativeLibtestOptions({ ...browser, ...patch }));
});
test('only opt-in default-dev read-consumer PE inputs receive the bounded debug-symbol allowance', () => {
  const fixture = { ...valid, pathFixture: { scope: 'tools', mode: 'baseline' } };
  assert.equal(nativeLibtestInputSizeLimit(fixture, 'tests.exe'), 512 * 1024 * 1024);
  for (const options of [valid, { ...fixture, probeKind: 'cross-host-source' }, { ...fixture, probeKind: 'private-credentials' }])
    assert.equal(nativeLibtestInputSizeLimit(options, 'tests.exe'), 256 * 1024 * 1024);
  for (const leaf of ['supervisor.exe', 'probe.mjs', 'gateway.tar'])
    assert.equal(nativeLibtestInputSizeLimit(fixture, leaf), 256 * 1024 * 1024);
});
test('native libtest requires explicit consent, hashes, isolated drive and exact nonempty case names', () => {
  assert.doesNotThrow(() => validateNativeLibtestOptions(valid));
  for (const field of Object.keys(valid)) assert.throws(() => validateNativeLibtestOptions({ ...valid, [field]: undefined }));
  for (const expectedTests of [[], ['duplicate', 'duplicate'], ['name\ninjected']])
    assert.throws(() => validateNativeLibtestOptions({ ...valid, expectedTests }));
  assert.throws(() => validateNativeLibtestOptions({ ...valid, parent: 'C:\\' }));
});

test('two-machine source acceptance needs fixed bundles and an owned SSH peer without widening existing libtests', async () => {
  const options = { ...valid, probeKind: 'cross-host-source', expectedTests: undefined,
    expectedCommit: 'd'.repeat(40), expectedDirty: true, gatewayBundle: '/owned/gateway.tar', gatewayBundleSha256: 'e'.repeat(64),
    sshWrapper: '/owned/ssh.exe', sshWrapperSha256: 'f'.repeat(64), clientKey: '/owned/key', knownHosts: '/owned/known_hosts',
    crossHost: { host: '192.0.2.20', command: '/owned/launch', workspace: '/owned/workspace', contentVersion: 'cross-host-contents/v1' } };
  assert.doesNotThrow(() => validateNativeLibtestOptions(options));
  for (const field of ['gatewayBundle', 'gatewayBundleSha256', 'sshWrapper', 'sshWrapperSha256', 'clientKey', 'knownHosts', 'crossHost'])
    assert.throws(() => validateNativeLibtestOptions({ ...options, [field]: undefined }));
  assert.throws(() => validateNativeLibtestOptions({ ...options, rustMinStack: 16777216 }));
  assert.throws(() => validateNativeLibtestOptions({ ...options, crossHost: { ...options.crossHost, contentVersion: undefined } }));
  const suite = 'suites/gateway/windows-cross-host-source.e2e.mjs';
  await prepareSuiteArtifacts([suite], { run: async () => assert.fail('two-machine acceptance must use its separately frozen binaries and Gateway snapshot') });
  assert.ok(suiteEnvironmentNames(suite).includes('KCODER_E2E_WINDOWS_CROSS_HOST_SOURCE'));
  assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes('KCODER_E2E_WINDOWS_CROSS_HOST_SOURCE'), false);
  for (const name of ['KCODER_E2E_WINDOWS_CROSS_HOST_CHECKOUT', 'KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY', 'KCODER_E2E_KCODER_BIN_SHA256']) {
    assert.ok(suiteEnvironmentNames(suite).includes(name));
    assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(name), false);
  }
});
test('native undo runs only supplied test binaries and forwards pins only to its selected suite', async () => {
  const suite = 'suites/gateway/windows-historical-undo.e2e.mjs';
  await prepareSuiteArtifacts([suite], { run: async () => assert.fail('native source-pinned test must not rebuild unrelated artifacts') });
  for (const name of ['KCODER_E2E_WINDOWS_NATIVE_LIBTEST', 'KCODER_E2E_WINDOWS_NATIVE_TEST_SHA256', 'KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_BIN']) {
    assert.ok(suiteEnvironmentNames(suite).includes(name));
    assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(name), false);
  }
});

test('native terminal acceptance records dirty source identity separately from Rust libtest counts', async () => {
  const terminal = { ...valid, probeKind: 'terminal', expectedTests: undefined, expectedCommit: 'd'.repeat(40), expectedDirty: true };
  assert.doesNotThrow(() => validateNativeLibtestOptions(terminal));
  assert.doesNotThrow(() => validateNativeLibtestOptions({ ...terminal, rustMinStack: 16 * 1024 * 1024 }));
  for (const rustMinStack of [0, -1, 128 * 1024 * 1024, '16777216'])
    assert.throws(() => validateNativeLibtestOptions({ ...terminal, rustMinStack }));
  for (const field of ['expectedCommit', 'expectedDirty']) assert.throws(() => validateNativeLibtestOptions({ ...terminal, [field]: undefined }));
  assert.throws(() => validateNativeLibtestOptions({ ...terminal, expectedTests: ['misleading_libtest_case'] }));
  const suite = 'suites/gateway/windows-terminal-lifecycle.e2e.mjs';
  await prepareSuiteArtifacts([suite], { run: async () => assert.fail('standalone native source acceptance must not repackage an installer') });
  for (const name of ['KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT', 'KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY']) {
    assert.ok(suiteEnvironmentNames(suite).includes(name));
    assert.equal(suiteEnvironmentNames('suites/gateway/windows-historical-undo.e2e.mjs').includes(name), false);
  }
});

test('native local-attachment acceptance pins a clean CLI and never enables a diagnostic stack', async () => {
  const options = { ...valid, probeKind: 'local-attachment', expectedTests: undefined,
    expectedCommit: 'd'.repeat(40), expectedDirty: false };
  assert.doesNotThrow(() => validateNativeLibtestOptions(options));
  assert.throws(() => validateNativeLibtestOptions({ ...options, expectedDirty: true }));
  assert.throws(() => validateNativeLibtestOptions({ ...options, rustMinStack: 16 * 1024 * 1024 }));
  assert.throws(() => validateNativeLibtestOptions({ ...options, expectedTests: ['not_a_libtest'] }));
  const suite = 'suites/gateway/windows-local-attachment.e2e.mjs';
  await prepareSuiteArtifacts([suite], { run: async () => assert.fail('native upload acceptance must not build an installer or reuse a personal installation') });
  for (const name of ['KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT', 'KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY', 'KCODER_E2E_WINDOWS_NATIVE_SOURCE_SHA256'])
    assert.ok(suiteEnvironmentNames(suite).includes(name));
  assert.equal(suiteEnvironmentNames(suite).includes('KCODER_E2E_WINDOWS_NATIVE_RUST_MIN_STACK'), false);
});

test('a targeted native State regression selects exactly its named test and never broadens the expected roster', async () => {
  const exactTest = 'external_history::local_attachment::tests::observer_treats_the_native_writer_lock_as_busy_without_changing_its_identity';
  const options = { ...valid, exactTest, expectedTests: [exactTest] };
  assert.doesNotThrow(() => validateNativeLibtestOptions(options));
  for (const changed of ['', 'other_case', 'case\nother'])
    assert.throws(() => validateNativeLibtestOptions({ ...options, exactTest: changed }));
  assert.throws(() => validateNativeLibtestOptions({ ...options, expectedTests: [exactTest, 'unselected'] }));
  const suite = 'suites/gateway/windows-local-attachment-lock.e2e.mjs';
  await prepareSuiteArtifacts([suite], { run: async () => assert.fail('native lock acceptance must use its exact source-pinned test binary') });
  assert.ok(suiteEnvironmentNames(suite).includes('KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT'));
});

test('native snapshot acceptance uses only the supplied CLI regression binary', async () => {
  const suite = 'suites/gateway/windows-snapshot-paths.e2e.mjs';
  await prepareSuiteArtifacts([suite], { run: async () => assert.fail('snapshot acceptance must not rebuild or substitute the supplied native tests') });
  for (const name of ['KCODER_E2E_WINDOWS_NATIVE_TEST_BIN', 'KCODER_E2E_WINDOWS_NATIVE_TEST_SHA256',
    'KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT', 'KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY', 'KCODER_E2E_WINDOWS_NATIVE_SOURCE_SHA256'])
    assert.ok(suiteEnvironmentNames(suite).includes(name));
  const exactTest = 'app_server::tests::isolated_turn_snapshot_supports_windows_paths_beyond_max_path';
  assert.doesNotThrow(() => validateNativeLibtestOptions({ ...valid, exactTest, expectedTests: [exactTest] }));
  assert.doesNotThrow(() => validateNativeLibtestOptions({ ...valid, exactTest, expectedTests: [exactTest], gitLineEndings: 'preserve' }));
  assert.throws(() => validateNativeLibtestOptions({ ...valid, gitLineEndings: 'rewrite' }));
});

test('native Config lease acceptance forwards pinned overlay identity without rebuilding or changing the stack', async () => {
  const suite = 'suites/gateway/windows-profile-settings-lock.e2e.mjs';
  await prepareSuiteArtifacts([suite], { run: async () => assert.fail('native Config acceptance must use its separately frozen test binary') });
  for (const name of ['KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT', 'KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY',
    'KCODER_E2E_WINDOWS_NATIVE_SOURCE_SHA256', 'KCODER_E2E_WINDOWS_NATIVE_TEST_SHA256']) {
    assert.ok(suiteEnvironmentNames(suite).includes(name));
    assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(name), false);
  }
  assert.equal(suiteEnvironmentNames(suite).includes('KCODER_E2E_WINDOWS_NATIVE_RUST_MIN_STACK'), false);
  assert.ok(suiteEnvironmentNames(suite).includes('KCODER_E2E_WINDOWS_CONFIG_LOCK_SCOPE'));
  assert.equal(suiteEnvironmentNames('suites/gateway/windows-local-attachment-lock.e2e.mjs').includes('KCODER_E2E_WINDOWS_CONFIG_LOCK_SCOPE'), false);
});

test('a native module filter requires its complete explicit roster without counting other libtests', () => {
  const testFilter = 'source_transfer::tests::adoption::';
  const options = { ...valid, testFilter, expectedTests: [testFilter + 'one', testFilter + 'two'] };
  assert.doesNotThrow(() => validateNativeLibtestOptions(options));
  for (const filter of ['', 'adoption', 'source.*::', 'source\n::', 'source_transfer::tests::other::'])
    assert.throws(() => validateNativeLibtestOptions({ ...options, testFilter: filter }));
  assert.throws(() => validateNativeLibtestOptions({ ...options, exactTest: options.expectedTests[0] }));
  assert.throws(() => validateNativeLibtestOptions({ ...options, expectedTests: ['outside::case'] }));
});

test('read path fixtures cannot widen a generic roster or enter default private and cross-host probes', () => {
  const exactTest = 'file::read_access::tests::actual_read_evidence_cannot_survive_replaced_file_or_parent';
  const options = { ...valid, exactTest, expectedTests: [exactTest], pathFixture: { scope: 'tools', mode: 'long-case' } };
  assert.doesNotThrow(() => validateNativeLibtestOptions(options));
  for (const probeKind of ['terminal', 'private-credentials', 'cross-host-source', 'local-attachment'])
    assert.throws(() => validateNativeLibtestOptions({ ...options, probeKind }));
  for (const change of [{ exactTest: 'other_case', expectedTests: ['other_case'] }, { rustMinStack: 16777216 },
    { pathFixture: { scope: 'tools', mode: 'peer-share' } }, { pathFixture: { scope: 'tools', mode: 'baseline', host: 'peer' } }])
    assert.throws(() => validateNativeLibtestOptions({ ...options, ...change }));
});

test('owned web runtime accepts only a frozen archive and an explicit native roster', () => {
  const runtime = {...valid, probeKind: 'web-runtime', runtimeArchive: '/owned/runtime.tar.gz', runtimeArchiveSha256: 'd'.repeat(64)};
  assert.doesNotThrow(() => validateNativeLibtestOptions(runtime));
  for (const patch of [{runtimeArchive: undefined}, {runtimeArchiveSha256: undefined}, {runtimeArchive: '/owned/unpinned.zip'}, {runIgnored: true}])
    assert.throws(() => validateNativeLibtestOptions({...runtime,...patch}));
});

test('external native web consent cannot widen another ignored test or runtime mode', () => {
  const name = 'web_network::system_proxy::native_observation::native_inherited_proxy_reads_one_fixed_public_source_with_verified_tls';
  const selected = {...valid, externalWebRead: true, exactTest: name, expectedTests: [name], runIgnored: true};
  assert.doesNotThrow(() => validateNativeLibtestOptions(selected));
  for (const patch of [{exactTest:'other_case',expectedTests:['other_case']},{runIgnored:undefined},{probeKind:'web-runtime'}])
    assert.throws(() => validateNativeLibtestOptions({...selected,...patch}));
});

test('native public cases and direct diagnostic keep their finite source selector', () => {
  const name = 'web_network::system_proxy::native_observation::native_inherited_proxy_reads_one_fixed_public_source_with_verified_tls';
  const selected = {...valid, externalWebRead:true, externalWebCase:'python-asyncio', exactTest:name, expectedTests:[name], runIgnored:true};
  assert.doesNotThrow(()=>validateNativeLibtestOptions(selected));
  assert.throws(()=>validateNativeLibtestOptions({...selected,externalWebCase:'https://arbitrary.invalid'}));
  assert.throws(()=>validateNativeLibtestOptions({...selected,diagnosticDirect:true}));
});

test('ordinary hostname proxy control is limited to one Python case and cannot widen direct mode', () => {
  const selected = {...valid, probeKind:'web-diagnostic', externalWebCase:'python-asyncio', diagnosticHostname:true};
  assert.doesNotThrow(()=>validateNativeLibtestOptions(selected));
  for (const patch of [{probeKind:'libtest'},{externalWebCase:'example'},{diagnosticDirect:true},{diagnosticHostname:false}])
    assert.throws(()=>validateNativeLibtestOptions({...selected,...patch}));
});


test('unknown live web scope fails before any remote source request', async () => {
  const {spawnSync} = await import('node:child_process');
  const script = new URL('../preflight/windows-web-network-live.mjs', import.meta.url);
  const result=spawnSync(process.execPath,[script.pathname],{encoding:'utf8',env:{...process.env,KCODER_E2E_WINDOWS_NATIVE_LIBTEST:'1',KCODER_E2E_WEB_EXTERNAL_NETWORK:'1',KCODER_E2E_WEB_NATIVE_SCOPE:'unregistered-case'},timeout:10000});
  assert.equal(result.status,1);
  assert.match(result.stderr,/Unknown external native web scope/);
});


test('diagnostic-only transport omits the unexecuted libtest binary but keeps supervisor and source pins', () => {
 const selected={...valid,probeKind:'web-diagnostic',externalWebCase:'python-asyncio',diagnosticHostname:true,testBinary:undefined,testSha256:undefined};
 assert.doesNotThrow(()=>validateNativeLibtestOptions(selected));
 for(const patch of [{probeKind:'libtest'},{testBinary:'/unpaired.exe'},{testSha256:'a'.repeat(64)},{supervisorSha256:undefined}])assert.throws(()=>validateNativeLibtestOptions({...selected,...patch}));
});


test('native transfer compression is an explicit transport-only opt in',()=>{
 assert.doesNotThrow(()=>validateNativeLibtestOptions({...valid,compressTransfer:true}));
 assert.throws(()=>validateNativeLibtestOptions({...valid,compressTransfer:'1'}));
});


test('compressed native transfer still requires the original exact executable identity',()=>{
 const selected={...valid,testBinaryArchive:'/owned/tests.exe.gz',testBinaryArchiveSha256:'d'.repeat(64)};
 assert.doesNotThrow(()=>validateNativeLibtestOptions(selected));
 for(const patch of [{testBinary:undefined},{testSha256:undefined},{testBinaryArchive:'/owned/other.zip'},{testBinaryArchiveSha256:undefined},{probeKind:'web-diagnostic'}])assert.throws(()=>validateNativeLibtestOptions({...selected,...patch}));
});

test('verify-only mode fixes the diagnostic roster and cannot enable external requests or libtests',()=>{
  const options={...valid,probeKind:'web-verify-only',runtimeArchive:'/owned/runtime.tar.gz',runtimeArchiveSha256:'d'.repeat(64),expectedTests:['native_sealed_runtime_verify_only']};
  assert.doesNotThrow(()=>validateNativeLibtestOptions(options));
  for(const patch of [{runtimeArchive:undefined},{runtimeArchiveSha256:undefined},{expectedTests:['an_actual_case']},{externalWebRead:true},{externalWebCase:'python-asyncio'},{exactTest:'native_sealed_runtime_verify_only'},{testFilter:'native_'},{runIgnored:true}])assert.throws(()=>validateNativeLibtestOptions({...options,...patch}));
});
