import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const privateCredentialRuntimeFiles = Object.freeze([
  'windows-private-credential-review.mjs', 'windows-private-credential-native.mjs',
  'windows-private-credential-rpc.mjs', 'app-server-stdio.mjs', 'migration-no-inference.mjs',
]);
const controlFiles = ['run-context.mjs', 'windows-native-libtest.mjs', 'windows-native-libtest-probe.mjs', 'owned-process.mjs',
  'windows-package-probe.mjs', 'windows-ssh-auth.mjs', 'windows-keyring-logon.mjs'];
const prefix = 'apps/kcoder-studio/e2e/harness/';

export async function windowsPrivateCredentialReview(root) {
  const paths = [...new Set([...privateCredentialRuntimeFiles, ...controlFiles])].map(leaf => prefix + leaf);
  paths.push('apps/kcoder-studio/e2e/suites/gateway/windows-private-credentials.e2e.mjs');
  const files = await Promise.all(paths.sort().map(async path => ({ path,
    sha256: createHash('sha256').update(await readFile(resolve(root, path))).digest('hex') })));
  return { files, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}

export async function inspectWindowsPrivateNode(context, { consent, target }) {
  assert.equal(consent, '1'); assert.match(target ?? '', /^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*$/);
  const { runKeyringWindowsCommand } = await import('./windows-keyring-logon.mjs');
  const script = String.raw`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$node=Get-Command node.exe -CommandType Application -ErrorAction Stop;$path=$node.Source;if($path -notmatch '^[A-Za-z]:\\' -or $path -match '\\Users\\|\\AppData\\'){throw 'A non-profile Node executable is required'};$f=Get-Item -LiteralPath $path;if($f.PSIsContainer -or ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $f.Length -ge 268435456){throw 'Node source is unavailable'};@{path=$f.FullName;sha256=(Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLowerInvariant();bytes=$f.Length;readOnly=$true;accountsCreated=0;vaultCalls=0}|ConvertTo-Json -Compress`;
  const raw = await runKeyringWindowsCommand(context, target, 'windows-private-node-readonly', 'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-S', 'none', target, 'powershell', '-NoProfile', '-NonInteractive',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
  const value = JSON.parse(raw.trim()); assert.equal(value.readOnly, true); assert.equal(value.accountsCreated, 0); assert.equal(value.vaultCalls, 0);
  assert.match(value.sha256, /^[a-f0-9]{64}$/); assert.match(value.path, /^[A-Za-z]:\\.+\.exe$/);
  await context.writeArtifactJson('windows-private-node-readonly.json', value); return value;
}

export function validatePrivateFixture(value, owner) {
  assert.deepEqual(Object.keys(value).sort(), ['owner', 'values']);
  assert.equal(value.owner, owner);
  assert.ok(Array.isArray(value.values) && value.values.length === 4);
  for (const secret of value.values) assert.match(secret, /^[a-f0-9]{64}$/);
  assert.equal(new Set(value.values).size, 4);
  return value.values;
}

export function privateFinishReceipt(value, requestId, manifestSha256) {
  assert.deepEqual(Object.keys(value), ['receipt']);
  assert.equal(value.receipt?.requestId === requestId, true, 'private_windows_receipt_request_changed');
  assert.equal(value.receipt?.manifestSha256 === manifestSha256, true, 'private_windows_receipt_manifest_changed');
  return value.receipt;
}
// Only fixture-relevant, public diagnostic identifiers may be retained.
const retainedIssueCodes = new Set(['missing_dependency', 'missing_model_limits', 'missing_model', 'requires_review',
  'unsupported_field', 'unsupported_authentication', 'credential_resolution_required', 'secret_excluded']);
export function privatePlanCandidates(page) {
  assert.equal(page.nextCursor ?? null, null, 'private_windows_fixture_page_incomplete');
  assert.equal(page.providers.length, 2); assert.equal(page.mcps.length, 2);
  const selected = [...page.providers.map(row => ({ id: row.itemId, category: 'provider' })),
    ...page.mcps.map(row => ({ id: row.itemId, category: 'mcp' }))];
  assert.equal(new Set(selected.map(row => row.id)).size, 4);
  for (const row of selected) assert.equal(page.items.some(item => item.id === row.id && item.category === row.category), true,
    'private_windows_candidate_not_an_original_item');
  const retained = page.items.filter(item => !selected.some(row => row.id === item.id));
  const publicRetained = retained.map(item => {
    assert.equal(item.category, 'provider'); assert.equal(item.status, 'requires_action');
    assert.ok(item.issues.length > 0 && item.issues.every(issue => retainedIssueCodes.has(issue.code)), 'private_windows_unknown_retained_reason');
    return { category: 'provider', status: 'requires_action',
      reason: item.issues.some(issue => issue.code === 'missing_dependency' && issue.field === 'session_template')
        ? 'session_template_not_selected' : 'unconverted_declaration_not_selected',
      issueCodes: [...new Set(item.issues.map(issue => issue.code))].sort() };
  });
  return { selected, retained, publicRetained, discoveredItems: page.items.length };
}
const phases = new Set(['setup', 'capture', 'ordinary_finish', 'adoption', 'ordinary_plan', 'private_receive',
  'private_prepare', 'target_recovery', 'ordinary_apply', 'ordinary_undo', 'key_release']);
const errorCodes = new Set(['ERR_ASSERTION', 'ENOENT', 'EACCES', 'ETIMEDOUT', 'WINDOWS_PRIVATE_RPC', 'WINDOWS_PRIVATE_PEER']);
export function privateDiagnostic(phase, error) {
  return { phase: phases.has(phase) ? phase : 'unknown',
    errorCode: errorCodes.has(error?.code) ? error.code : 'unclassified',
    nativeRpcCode: [-32047, -32600, -32601, -32602, -32603].includes(error?.nativeRpcCode) ? error.nativeRpcCode : null };
}

export function validateWindowsPrivateCredentialEvidence(value) {
  assert.equal(value.passed, true);
  assert.equal(value.scope, 'windows_native_private_credentials_file_backend');
  assert.equal(value.fileBackend, true); assert.equal(value.systemKeyringVerified, false);
  for (const name of ['sourceBytesUnchanged', 'sourceOffline', 'prepareReplyDiscarded', 'targetOnlyReopen',
    'originalIntentRecovered', 'normalGroupPublished', 'normalGroupUndone', 'targetSettingsRestored',
    'publicValuesAbsent', 'transportKeysReleased', 'ownedChildrenClosed', 'wrongProfileAndPeerRejected']) assert.equal(value[name], true, name);
  assert.equal(value.entries, 2); assert.equal(value.offers, 2); assert.equal(value.publishedReferences, 4);
  assert.equal(value.selectedItems, 4); assert.ok(Number.isSafeInteger(value.discoveredItems) && value.discoveredItems >= 4 && value.discoveredItems <= 10);
  assert.equal(value.retainedItems.length, value.discoveredItems - 4);
  for (const item of value.retainedItems) {
    assert.equal(item.status, 'requires_action'); assert.ok(item.issueCodes.length > 0 && item.issueCodes.every(code => retainedIssueCodes.has(code)));
  }
  assert.equal(value.privatePrepareCalls, 1);
  assert.equal(value.modelInferenceRequests, 0); assert.equal(value.oldToolsExecuted, 0);
  assert.ok(value.processes.length >= 4 && value.processes.every(row => Number.isSafeInteger(row.pid) && row.pid > 0 && row.closed && row.exitCode === 0));
}
