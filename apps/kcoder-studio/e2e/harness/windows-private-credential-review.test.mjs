import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateNativeLibtestOptions, cleanupWindowsNativeFixture } from './windows-native-libtest.mjs';
import { privateNativeFailure, privatePeerFrame, privatePrefix } from './windows-private-credential-native.mjs';
import { privateDiagnostic, privateFinishReceipt, privatePlanCandidates, validatePrivateFixture, validateWindowsPrivateCredentialEvidence, windowsPrivateCredentialReview } from './windows-private-credential-review.mjs';
import { suiteEnvironmentNames } from './runner-options.mjs';
import { prepareSuiteArtifacts } from '../run-all.mjs';
import { repoRoot } from './run-context.mjs';

const owner = '11111111-1111-4111-8111-111111111111';
const options = { consent: '1', target: 'owned-host', parent: 'D:\\', node: 'D:\\node.exe',
  testBinary: '/owned/kcoder.exe', supervisor: '/owned/supervisor.exe', testSha256: 'a'.repeat(64),
  supervisorSha256: 'b'.repeat(64), sourceTreeSha256: 'c'.repeat(64), expectedCommit: 'd'.repeat(40),
  expectedDirty: false, probeKind: 'private-credentials', reviewedSourceSha256: 'e'.repeat(64), nodeSha256: 'f'.repeat(64) };

test('finish consumes the actual Native receipt wrapper and rejects the old flattened assumption', () => {
  const receipt = { requestId: owner, manifestSha256: 'a'.repeat(64) };
  assert.deepEqual(privateFinishReceipt({ receipt }, owner, receipt.manifestSha256), receipt);
  for (const value of [receipt, { receipt: null }, { receipt: { ...receipt, requestId: 'other' } },
    { receipt: { ...receipt, manifestSha256: 'b'.repeat(64) } }]) assert.throws(() => privateFinishReceipt(value, owner, receipt.manifestSha256));
});
test('phase diagnostics expose only fixed phase/error identifiers and numeric Native codes', () => {
  const error = privateNativeFailure(-32047);
  Object.defineProperty(error, 'message', { get() { throw Error('message must not be read'); } });
  Object.defineProperty(error, 'data', { get() { throw Error('data must not be read'); } });
  assert.deepEqual(privateDiagnostic('ordinary_finish', error), { phase: 'ordinary_finish', errorCode: 'WINDOWS_PRIVATE_RPC', nativeRpcCode: -32047 });
  const unknown = privateDiagnostic('SYNTHETIC_PRIVATE_VALUE', { code: 'SYNTHETIC_PRIVATE_VALUE', nativeRpcCode: 'SYNTHETIC_PRIVATE_VALUE' });
  assert.deepEqual(unknown, { phase: 'unknown', errorCode: 'unclassified', nativeRpcCode: null });
  assert.equal(JSON.stringify(unknown).includes('SYNTHETIC_PRIVATE_VALUE'), false);
});
test('plan selection uses typed candidates and preserves an unresolved raw profile-template declaration', () => {
  const page = { providers: [{ itemId: 'p1' }, { itemId: 'p2' }], mcps: [{ itemId: 'm1' }, { itemId: 'm2' }],
    items: [{ id: 'p1', category: 'provider' }, { id: 'p2', category: 'provider' },
      { id: 'm1', category: 'mcp' }, { id: 'm2', category: 'mcp' }, { id: 'template', category: 'provider', status: 'requires_action',
        issues: [{ code: 'missing_dependency', field: 'session_template' }] }] };
  const result = privatePlanCandidates(page);
  assert.equal(result.selected.length, 4); assert.equal(result.discoveredItems, 5); assert.equal(result.retained[0].id, 'template');
  assert.equal(result.publicRetained[0].reason, 'session_template_not_selected');
  for (const changed of [{ ...page, providers: [...page.providers, { itemId: 'unexpected' }] }, { ...page, nextCursor: 'another-page' },
    { ...page, providers: [page.providers[0], page.providers[0]] }, { ...page, providers: [{ itemId: 'foreign' }, page.providers[1]] }])
    assert.throws(() => privatePlanCandidates(changed));
});

test('Windows private RPC requires clean ordinary Native, an exact runtime review and existing Node pin', async () => {
  assert.doesNotThrow(() => validateNativeLibtestOptions(options));
  for (const field of ['reviewedSourceSha256', 'nodeSha256', 'expectedCommit', 'expectedDirty'])
    assert.throws(() => validateNativeLibtestOptions({ ...options, [field]: undefined }));
  for (const changed of [{ expectedDirty: true }, { rustMinStack: 16777216 }, { expectedTests: ['not_a_libtest'] }])
    assert.throws(() => validateNativeLibtestOptions({ ...options, ...changed }));
  const suite = 'suites/gateway/windows-private-credentials.e2e.mjs';
  await prepareSuiteArtifacts([suite], { run() { assert.fail('an actual source-pinned PE must never be silently rebuilt'); } });
  const names = suiteEnvironmentNames(suite);
  for (const name of ['KCODER_E2E_WINDOWS_PRIVATE_REVIEW_SHA256', 'KCODER_E2E_WINDOWS_PRIVATE_NODE_SHA256']) {
    assert.ok(names.includes(name)); assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(name), false);
  }
  assert.equal(names.includes('KCODER_E2E_WINDOWS_KEYRING_LOGON'), false);
  assert.equal(names.includes('KCODER_E2E_WINDOWS_NATIVE_RUST_MIN_STACK'), false);
  const first = await windowsPrivateCredentialReview(repoRoot), second = await windowsPrivateCredentialReview(repoRoot);
  assert.deepEqual(first, second); assert.match(first.sha256, /^[a-f0-9]{64}$/);
  assert.ok(first.files.some(row => row.path.endsWith('run-context.mjs')));
});

test('fixture values remain four bounded synthetic slots and private peer proofs cannot enter another frame', () => {
  const fixture = { owner, values: ['a', 'b', 'c', 'd'].map(value => value.repeat(64)) };
  assert.equal(validatePrivateFixture(fixture, owner).length, 4);
  for (const changed of [{ ...fixture, owner: 'different' }, { ...fixture, values: ['x'] }, { ...fixture, sourcePath: 'forbidden' },
    { ...fixture, values: [fixture.values[0], fixture.values[0], ...fixture.values.slice(2)] }])
    assert.throws(() => validatePrivateFixture(changed, owner));
  const proof = { version: 1, requestId: owner }, params = { requestId: owner, role: 'source' };
  assert.deepEqual(privatePeerFrame(1, privatePrefix + 'peer/accept', params, proof).kcoderPrivateMigrationSource, proof);
  assert.throws(() => privatePeerFrame(1, 'initialize', params, proof));
  assert.throws(() => privatePeerFrame(1, privatePrefix + 'peer/accept', { ...params, requestId: 'different' }, proof));
});

test('cleanup uses the finishing-only managed child and waits for its stop before returning the receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-native-cleanup-unit-'));
  const resultPath = join(root, 'cleanup.json'); let stopped = false, spawned = false;
  try {
    const context = { spawnOwned() { assert.fail('ordinary spawning is forbidden while finishing'); },
      spawnCleanupOwned(label, command, args) {
        spawned = true; assert.ok(label.endsWith(owner)); assert.equal(command, 'ssh');
        const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
        assert.ok(script.includes('D:\\kcoder-package-' + owner)); assert.ok(script.includes("'.owner.json'"));
        const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        queueMicrotask(() => { child.stdout.write(JSON.stringify({ cleaned: true, directoryAbsent: true, ownedPackageProcessesAbsent: true })); child.emit('close', 0); });
        return child;
      }, async stopOwned() { await new Promise(resolve => setTimeout(resolve, 5)); stopped = true; },
      redactText: value => value };
    await cleanupWindowsNativeFixture(context, options, 'D:\\kcoder-package-' + owner, owner, resultPath);
    assert.ok(spawned && stopped); assert.equal(JSON.parse(await readFile(resultPath, 'utf8')).cleaned, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a passed Native case cannot substitute a keyring, partial group, live child or unconfirmed cleanup claim', () => {
  const value = { passed: true, scope: 'windows_native_private_credentials_file_backend', fileBackend: true, systemKeyringVerified: false,
    sourceBytesUnchanged: true, sourceOffline: true, prepareReplyDiscarded: true, targetOnlyReopen: true,
    originalIntentRecovered: true, normalGroupPublished: true, normalGroupUndone: true, targetSettingsRestored: true,
    publicValuesAbsent: true, transportKeysReleased: true, ownedChildrenClosed: true, entries: 2, offers: 2,
    publishedReferences: 4, modelInferenceRequests: 0, oldToolsExecuted: 0, privatePrepareCalls: 1, wrongProfileAndPeerRejected: true,
    discoveredItems: 5, selectedItems: 4, retainedItems: [{ status: 'requires_action', issueCodes: ['missing_dependency'] }],
    processes: Array.from({ length: 4 }, (_, index) => ({ pid: index + 1, closed: true, exitCode: 0 })) };
  validateWindowsPrivateCredentialEvidence(value);
  for (const changed of [{ systemKeyringVerified: true }, { publishedReferences: 2 }, { transportKeysReleased: false },
    { modelInferenceRequests: 1 }, { processes: [{ pid: 1, closed: false, exitCode: null }] }])
    assert.throws(() => validateWindowsPrivateCredentialEvidence({ ...value, ...changed }));
});
