import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, lstat, writeFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { repoRoot } from './run-context.mjs';
import { ownedCreationScript, ownedCleanupScript, psLiteral } from './windows-package-probe.mjs';
import { runKeyringLogonPreflight, runKeyringWindowsCommand } from './windows-keyring-logon.mjs';
import { validateOwnedCoreResult, validateOwnedCoreCleanup } from './windows-keyring-core-result.mjs';
import { validateOwnedHostResult, validateOwnedHostCleanup } from './windows-keyring-host-result.mjs';
import { prepareOwnedHostHandoff, inspectOwnedHostNode } from './windows-keyring-host-handoff.mjs';
import { preparePrivateKeyringHandoff, privateKeyringSources } from './windows-private-keyring-handoff.mjs';
import { validatePrivateKeyringResult, validatePrivateKeyringCleanup } from './windows-private-keyring-result.mjs';
import { createKeyringRecovery } from './windows-keyring-recovery.mjs';

const sources = [
  ['apps/kcoder-studio/e2e/harness/windows-installer-desktop.cs', 'desktop.cs'],
  ['apps/kcoder-studio/e2e/harness/windows-keyring-logon-process.cs', 'logon.cs'],
  ['apps/kcoder-studio/e2e/harness/windows-keyring-logon-session.ps1', 'session.ps1'],
  ['apps/kcoder-studio/e2e/harness/windows-keyring-logon-user.ps1', 'actor.ps1'],
];
const nativeSources = ['crates/kcoder_config/examples/windows_migration_security.rs',
  'crates/kcoder_config/examples/windows_migration_security/implementation.rs',
  'crates/kcoder_config/examples/windows_migration_security/vault_logon.rs'];

const coreSources = [
  'crates/kcoder_config/examples/windows_imported_credential_security.rs',
  ...['backend', 'core', 'fixture'].map(name => `crates/kcoder_config/examples/windows_imported_credential_security/${name}.rs`),
  'apps/kcoder-studio/e2e/harness/windows-keyring-core-result.mjs',
  'apps/kcoder-studio/e2e/suites/gateway/windows-keyring-core.e2e.mjs',
];

export async function keyringAccountSourceReview(scenario = 'raw') {
  assert.ok(['raw', 'config-core', 'host-rpc', 'private-rpc'].includes(scenario));
  const files = [];
  for (const path of new Set([...sources.map(([path]) => path), ...(scenario === 'private-rpc' ? [] : nativeSources),
    'apps/kcoder-studio/e2e/harness/windows-keyring-account.mjs',
    'apps/kcoder-studio/e2e/harness/run-context.mjs',
    'apps/kcoder-studio/e2e/harness/owned-process.mjs',
    'apps/kcoder-studio/e2e/harness/windows-ssh-auth.mjs',
    'apps/kcoder-studio/e2e/harness/windows-keyring-logon.mjs',
    'apps/kcoder-studio/e2e/harness/windows-keyring-logon-preflight.ps1',
    'apps/kcoder-studio/e2e/suites/gateway/windows-keyring-account.e2e.mjs',
    'apps/kcoder-studio/e2e/harness/windows-keyring-core-result.mjs',
    ...(['config-core', 'host-rpc'].includes(scenario) ? coreSources : []),
    ...(scenario === 'host-rpc' ? [
      'crates/kcoder_config/examples/windows_imported_credential_security/host_audit.rs',
      ...['host-probe', 'host-result', 'host-handoff'].map(name => `apps/kcoder-studio/e2e/harness/windows-keyring-${name}.mjs`),
      'apps/kcoder-studio/e2e/harness/app-server-stdio.mjs',
      'apps/kcoder-studio/e2e/suites/gateway/windows-keyring-host.e2e.mjs',
    ] : []),
    ...(scenario === 'private-rpc' ? [
      'crates/kcoder_config/examples/windows_private_credential_audit.rs',
      'crates/kcoder_config/examples/windows_private_credential_audit/audit.rs',
      'crates/kcoder_config/examples/windows_private_credential_audit/proof.rs',
      ...privateKeyringSources.map(([leaf]) => 'apps/kcoder-studio/e2e/harness/' + leaf),
      'apps/kcoder-studio/e2e/harness/windows-private-keyring-handoff.mjs',
      'apps/kcoder-studio/e2e/harness/windows-private-keyring-result.mjs',
      'apps/kcoder-studio/e2e/harness/windows-keyring-recovery.mjs',
      'apps/kcoder-studio/e2e/harness/windows-keyring-recovery-files.mjs',
      'apps/kcoder-studio/e2e/harness/retention.mjs',
      'apps/kcoder-studio/e2e/harness/windows-keyring-host-handoff.mjs',
      'apps/kcoder-studio/e2e/harness/windows-package-probe.mjs',
      'apps/kcoder-studio/e2e/suites/gateway/windows-private-keyring.e2e.mjs',
    ] : [])])) {
    const bytes = await readFile(resolve(repoRoot, path));
    files.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return { files, sourceSha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}

export function validateOwnedVaultResult(result, owner, username) {
  assert.equal(result.passed, true); assert.equal(result.scope, 'os_backend_only');
  assert.equal(result.owner, owner); assert.equal(result.username, username);
  assert.match(result.ownedSid, /^S-1-5-21-[0-9-]+$/);
  assert.equal(result.coreMigrationVerified, false); assert.equal(result.hostMigrationVerified, false);
  assert.equal(result.written.stage, 'written_pending_independent_reopen');
  assert.equal(result.reopened.stage, 'reopened_and_deleted');
  for (const value of [result.written, result.reopened]) {
    assert.equal(value.status, 'passed'); assert.equal(value.fileBackendUsed, false);
    assert.equal(value.exactRandomAccountOnly, true); assert.equal(value.readbackMatched, true);
    assert.equal(value.enumeratedAccounts, false);
  }
  assert.equal(result.reopened.cleanup.systemEntryAbsenceVerified, true);
  validateOwnedLogonJobs(result);
}

function validateOwnedLogonJobs(result) {
  assert.deepEqual(result.jobs.map(value => value.action), ['bootstrap', 'write', 'reopen']);
  assert.equal(new Set(result.jobs.map(value => `${value.pid}:${value.creationTicks}`)).size, 3);
  assert.equal(new Set(result.jobs.map(value => value.logonLuid)).size, 3);
  for (const job of result.jobs) {
    assert.equal(job.sid, result.ownedSid); assert.equal(job.logonType, 2);
    assert.ok(Number.isSafeInteger(job.pid) && job.pid > 0); assert.match(job.creationTicks, /^[0-9]+$/);
    assert.equal(job.profileHiveLoaded, true); assert.equal(job.elevated, false); assert.equal(job.stopped, true);
  }
}

export function validateOwnedKeyringCleanup(value, owner, scenario = 'raw') {
  if (owner !== undefined) {
    assert.equal(value.owner, owner);
    if (value.disposition !== 'never_created') assert.match(value.ownedSid, /^S-1-5-21-[0-9-]+$/);
  }
  assert.equal(value.cleaned, true); assert.equal(value.accountAbsent, true); assert.equal(value.profileAbsent, true);
  assert.ok(value.disposition === 'never_created' || value.allJobsStopped === true);
  if (value.vault) {
    assert.equal(value.vault.safeToRemoveRoot, true);
    assert.ok(value.vault.systemEntryAbsenceVerified === true || value.vault.noVaultWriteDispatched === true ||
      (scenario === 'config-core' && value.vault.noBackendWriteDispatched === true && value.vault.referenceCount === 0 && value.vault.coreCaseNotCompleted === true) ||
      (scenario === 'host-rpc' && value.vault.noHostWriteDispatched === true && value.vault.referenceCount === 0 && value.vault.hostCaseNotCompleted === true) ||
      (scenario === 'private-rpc' && value.vault.noPrivateWriteDispatched === true && value.vault.referenceCount === 0 && value.vault.privateCaseNotCompleted === true));
  } else assert.ok(value.disposition === 'never_created' || value.noVaultWriteDispatched === true);
}

export async function reconcileRejectedAccountDescription(context, { target, priorRun }) {
  const boundary = resolve(repoRoot, 'target/test/apps/kcoder-studio/e2e/suites/gateway/windows-keyring-account.e2e.mjs');
  const path = resolve(priorRun), child = relative(boundary, path);
  assert.ok(child && !child.startsWith('..' + sep) && !child.includes(sep));
  const failure = JSON.parse(await readFile(resolve(path, 'artifacts/result.json'), 'utf8'));
  assert.equal(failure.status, 'failed');
  assert.match(failure.error, /Description/); assert.match(failure.error, /ParameterArgumentValidationError/);
  const match = failure.error.match(/D:\\kcoder-package-([a-f0-9-]{36})\\session\.ps1/);
  assert.ok(match, 'Only the retained exact pre-invocation failure can be reconciled');
  const owner = match[1], root = `D:\\kcoder-package-${owner}`;
  const ps = script => runKeyringWindowsCommand(context, target, 'rejected-account-observation', 'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-S', 'none', target, 'powershell', '-NoProfile', '-NonInteractive',
      '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" + script, 'utf16le').toString('base64')]);
  const observed = JSON.parse((await ps(`$root=${psLiteral(root)};$owner=${psLiteral(owner)};$m=Get-Content -LiteralPath (Join-Path $root '.owner.json') -Raw|ConvertFrom-Json;$i=Get-Content -LiteralPath (Join-Path $root 'account-owner-intent.json') -Raw|ConvertFrom-Json;if($m.owner -ne $owner -or $i.owner -ne $owner -or $i.description -ne ('KCoderKeyringE2E '+$owner) -or $i.username -notmatch '^kc_e2e_[a-f0-9]{8}$' -or $i.sid -or $i.jobs.Count -ne 0 -or $i.writesMayHaveRun -or $i.bootstrapPid -or !$i.lastLaunchStopped){throw 'Original pre-creation facts changed'};if(Get-LocalUser -Name $i.username -ErrorAction SilentlyContinue){throw 'An account exists; never remove or adopt it'};@{owner=$owner;accountAbsent=$true;noActorStarted=$true;noVaultWriteDispatched=$true;descriptionLength=$i.description.Length}|ConvertTo-Json -Compress`)).trim());
  assert.equal(observed.owner, owner); assert.equal(observed.accountAbsent, true);
  assert.equal(observed.noActorStarted, true); assert.equal(observed.noVaultWriteDispatched, true);
  assert.ok(observed.descriptionLength > 48);
  await context.writeArtifactJson('rejected-account-original-facts.json', observed);
  const spec = windowsSshInvocationForRecovery(target, ownedCleanupScript(root, owner));
  const gone = JSON.parse((await runKeyringWindowsCommand(context, target, 'rejected-account-original-root-cleanup', 'ssh', spec)).trim());
  assert.equal(gone.cleaned, true);
  await context.writeArtifactJson('rejected-account-original-cleanup.json', gone);
  return { originalRootCleaned: true, accountAbsent: true, vaultCalls: 0, newAccountCreated: false };
}

function windowsSshInvocationForRecovery(target, script) {
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-S', 'none', target, 'powershell', '-NoProfile', '-NonInteractive',
    '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" + script, 'utf16le').toString('base64')];
}

export async function runOwnedKeyringAccount(context, options) {
  assert.equal(options.consent, '1');
  assert.ok(['compile', 'roundtrip'].includes(options.mode));
  assert.ok([undefined, 'prebinding-reject', 'sid-ack', 'root-ack', 'cleanup-ack'].includes(options.fault));
  const scenario = options.scenario ?? 'raw';
  assert.ok(['raw', 'config-core', 'host-rpc', 'private-rpc'].includes(scenario));
  if (scenario !== 'raw') assert.equal(options.fault, undefined);
  const review = await keyringAccountSourceReview(scenario);
  if (options.mode === 'roundtrip') {
    assert.match(options.reviewedSourceSha256 ?? '', /^[a-f0-9]{64}$/);
    assert.equal(options.reviewedSourceSha256, review.sourceSha256, 'Only the explicitly reviewed adapter can create an account');
    assert.match(options.helperSha256 ?? '', /^[a-f0-9]{64}$/);
    const stat = await lstat(options.helper); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size < 64 * 1024 * 1024);
    assert.equal(createHash('sha256').update(await readFile(options.helper)).digest('hex'), options.helperSha256);
  }
  await runKeyringLogonPreflight(context, { ...options, mode: 'preflight' });
  await context.writeArtifactJson('owned-keyring-adapter-source.json', review);
  let sequence = 0;
  const args = script => ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-S', 'none', options.target,
    'powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" + script, 'utf16le').toString('base64')];
  const ps = (script, input, timeoutMs = 60000) => runKeyringWindowsCommand(context, options.target,
    `keyring-account-${++sequence}`, 'ssh', args(script), { input, timeoutMs });
  const owner = randomUUID(), username = 'kc_e2e_' + randomBytes(4).toString('hex');
  const password = randomBytes(32).toString('base64url') + 'aA9!'; context.registerSecret(password);
  const root = options.parent.replace(/\\$/, '') + '\\kcoder-package-' + owner;
  const absence = JSON.parse((await ps(`@{absent=(!(Test-Path -LiteralPath ${psLiteral(root)}))}|ConvertTo-Json -Compress`)).trim());
  assert.equal(absence.absent, true, 'An existing account fixture directory is never adopted');
  await context.writeArtifactJson('owned-keyring-directory-intent.json', { owner, root, initiallyAbsent: true });
  // Recovery credentials are born before any remote account effect and never enter state/artifacts.
  const recovery = scenario === 'private-rpc' && options.mode === 'roundtrip'
    ? await createKeyringRecovery(context, { owner, root, username, target: options.target, runRoot: context.runRoot }, password) : null;
  const cleanupEvidence = context.pathInArtifacts('owned-keyring-account-cleanup.json');
  let sessionReady = false, accountMayExist = false, cleaned = false;
  const sessionCommand = `& ${psLiteral(root + '\\session.ps1')} -RunRoot ${psLiteral(root)} -Owner ${psLiteral(owner)}`;
  const input = action => JSON.stringify({ action, owner, username, password, helperSha256: options.helperSha256, fault: options.fault, scenario }) + '\n';
  let originalSid, coreCompleted = false, hostCompleted = false, privateCompleted = false;
  const validateCleanup = value => {
    validateOwnedKeyringCleanup(value, owner, scenario);
    if (originalSid) assert.equal(value.ownedSid, originalSid);
    if (coreCompleted) validateOwnedCoreCleanup(value.vault);
    if (hostCompleted) validateOwnedHostCleanup(value.vault);
    if (privateCompleted) validatePrivateKeyringCleanup(value.vault);
  };
  const cleanupCommand = (script, payload) => runKeyringWindowsCommand(context, options.target,
    `keyring-account-cleanup-${++sequence}`, 'ssh', args(script),
    { input: payload, timeoutMs: payload === undefined ? 30000 : 110000, cleanup: context.finishing });
  context.addCleanup('remove exact owned vault entry then normal-logon account/profile and fixture', async () => {
    if (cleaned) return;
    let receipt;
    if (accountMayExist) {
      assert.equal(sessionReady, true);
      const value = JSON.parse((await cleanupCommand(sessionCommand, input('cleanup'))).trim());
      validateCleanup(value); receipt = value;
      if (recovery && value.ownedSid) await recovery.bindSid(value.ownedSid);
      await writeFile(cleanupEvidence, JSON.stringify(context.redactValue(value), null, 2) + '\n', { mode: 0o600 });
    }
    const command = `if(!(Test-Path -LiteralPath ${psLiteral(root)})){@{cleaned=$true;directoryAbsent=$true;ownedPackageProcessesAbsent=$true;alreadyAbsent=$true}|ConvertTo-Json -Compress}else{${ownedCleanupScript(root, owner)}}`;
    const gone = JSON.parse((await cleanupCommand(command)).trim());
    assert.equal(gone.cleaned, true); cleaned = true;
    if (recovery && receipt) await recovery.confirmRemoteCleanup({ ...receipt, rootAbsent: true });
  });
  // The original nonce and cleanup owner exist even if directory creation loses its reply.
  assert.equal(JSON.parse((await ps(ownedCreationScript(options.parent, owner))).trim()), root);
  for (const [source, leaf] of sources) {
    await runKeyringWindowsCommand(context, options.target, `keyring-account-${++sequence}`, 'scp',
      ['-o', 'BatchMode=yes', '-o', 'ControlPath=none', resolve(repoRoot, source), `${options.target}:${root.replaceAll('\\', '/')}/${leaf}`]);
  }
  sessionReady = true;
  const compiled = JSON.parse((await ps(`$env:TEMP=Join-Path ${psLiteral(root)} 'compiler-temp';$env:TMP=$env:TEMP;[IO.Directory]::CreateDirectory($env:TEMP)|Out-Null;Add-Type -Path @(${psLiteral(root + '\\desktop.cs')},${psLiteral(root + '\\logon.cs')});foreach($leaf in @('session.ps1','actor.ps1')){$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path ${psLiteral(root)} $leaf),[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Owned actor script syntax failed'};if($leaf -eq 'session.ps1'){$save=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Save-Intent'},$false);$desc=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-OwnedDescription'},$false)}};$description=& ($desc.Body.GetScriptBlock()) ${psLiteral(owner)};$limit=(Get-Command New-LocalUser).Parameters['Description'].Attributes|Where-Object{$_ -is [Management.Automation.ValidateLengthAttribute]};if(!$limit -or !$description.EndsWith(${psLiteral(owner)}) -or $description.Length -gt $limit.MaxLength -or $description.Length -lt $limit.MinLength){throw 'Original nonce description exceeds actual command bounds'};$intentPath=Join-Path ${psLiteral(root)} 'intent-replace-check.json';$script:intent=@{sequence=1};& ($save.Body.GetScriptBlock());$script:intent.sequence=2;& ($save.Body.GetScriptBlock());if((Get-Content -LiteralPath $intentPath -Raw|ConvertFrom-Json).sequence -ne 2){throw 'Actual intent replacement failed'};Remove-Item -LiteralPath $intentPath;@{compiled=$true;actorsParsed=$true;descriptionFitsCommand=$true;intentReplaceVerified=$true;accountsCreated=0;vaultCalls=0;normalLogonAttempted=$false}|ConvertTo-Json -Compress`)).trim());
  await context.writeArtifactJson('owned-keyring-adapter-compile.json', compiled);
  assert.deepEqual(compiled, { compiled: true, actorsParsed: true, descriptionFitsCommand: true, intentReplaceVerified: true, accountsCreated: 0, vaultCalls: 0, normalLogonAttempted: false });
  if (['host-rpc', 'private-rpc'].includes(scenario)) {
    const node = await inspectOwnedHostNode(ps, options.hostNode);
    if (options.hostNodeSha256) assert.equal(node.sha256, options.hostNodeSha256);
    await context.writeArtifactJson('owned-host-node-source.json', node);
  }
  if (options.mode === 'compile') return { adapterCompiled: true, accountCreated: false, osVaultVerified: false };
  await runKeyringWindowsCommand(context, options.target, `keyring-account-${++sequence}`, 'scp',
    ['-o', 'BatchMode=yes', '-o', 'ControlPath=none', options.helper, `${options.target}:${root.replaceAll('\\', '/')}/security-helper.exe`]);
  if (['host-rpc', 'private-rpc'].includes(scenario)) {
    const prepare = scenario === 'private-rpc' ? preparePrivateKeyringHandoff : prepareOwnedHostHandoff;
    await prepare(context, options, { owner, root, ps,
      copy: (path, leaf) => runKeyringWindowsCommand(context, options.target, `keyring-account-${++sequence}`, 'scp',
        ['-o', 'BatchMode=yes', '-o', 'ControlPath=none', path, `${options.target}:${root.replaceAll('\\', '/')}/${leaf}`]) });
  }
  if (recovery) await recovery.markRemoteMayExist();
  accountMayExist = true;
  const faultObserved = async () => {
    const value = JSON.parse((await ps(`$i=Get-Content -LiteralPath ${psLiteral(root + '\\account-owner-intent.json')} -Raw|ConvertFrom-Json;if($i.owner -ne ${psLiteral(owner)} -or $i.username -ne ${psLiteral(username)}){throw 'Original fixture intent changed'};@{fault=$i.testFaultReached;phase=$i.phase;sid=$i.sid;creationRejectedBeforeInvocation=$i.creationRejectedBeforeInvocation;creationRejectionCode=$i.creationRejectionCode}|ConvertTo-Json -Compress`)).trim());
    assert.equal(value.fault, options.fault, 'An unrelated failure cannot satisfy an injected receipt-loss case');
    if (options.fault === 'prebinding-reject') {
      assert.equal(value.creationRejectedBeforeInvocation, true); assert.equal(value.creationRejectionCode, 'parameter_binding');
      assert.equal(value.sid, null);
    }
    await context.writeArtifactJson('owned-keyring-injected-fault.json', value);
  };
  let result;
  try { result = JSON.parse((await ps(sessionCommand, input('run'), 240000)).trim()); }
  catch (error) {
    if (!['prebinding-reject', 'sid-ack', 'root-ack'].includes(options.fault)) {
      if (recovery) {
        try {
          // This is only an observation of the original nonce/SID, never an account creation retry.
          const observed = JSON.parse((await ps(`$i=Get-Content -LiteralPath ${psLiteral(root + '\\account-owner-intent.json')} -Raw|ConvertFrom-Json;$m=Get-Content -LiteralPath ${psLiteral(root + '\\.owner.json')} -Raw|ConvertFrom-Json;if($m.owner -ne ${psLiteral(owner)} -or $i.owner -ne ${psLiteral(owner)} -or $i.username -ne ${psLiteral(username)} -or $i.description -ne ${psLiteral('KCKeyring ' + owner)} -or $i.scenario -ne 'private-rpc'){throw 'Original recovery owner changed'};@{owner=$i.owner;ownedSid=$i.sid}|ConvertTo-Json -Compress`)).trim());
          assert.equal(observed.owner, owner);
          if (observed.ownedSid) { await recovery.bindSid(observed.ownedSid); originalSid = observed.ownedSid; }
        } catch {
          await context.writeArtifactJson('keyring-recovery-observation.json', { status: 'unknown', errorCode: 'keyring_recovery_sid_unconfirmed' });
        }
      }
      throw error;
    }
    await faultObserved();
    const reconciled = JSON.parse((await ps(sessionCommand, input('cleanup'), 110000)).trim());
    validateCleanup(reconciled);
    await writeFile(cleanupEvidence, JSON.stringify(context.redactValue(reconciled), null, 2) + '\n', { mode: 0o600 });
    const gone = JSON.parse((await ps(ownedCleanupScript(root, owner))).trim()); assert.equal(gone.cleaned, true); cleaned = true;
    return { injectedReceiptLossReconciled: options.fault, osVaultVerified: false, fixtureCleaned: true };
  }
  if (scenario === 'config-core') {
    validateOwnedCoreResult(result, owner, username); validateOwnedLogonJobs(result); coreCompleted = true;
  } else if (scenario === 'host-rpc') {
    validateOwnedHostResult(result, owner, username); validateOwnedLogonJobs(result); hostCompleted = true;
  } else if (scenario === 'private-rpc') {
    validatePrivateKeyringResult(result, owner, username); validateOwnedLogonJobs(result); privateCompleted = true;
  } else validateOwnedVaultResult(result, owner, username);
  originalSid = result.ownedSid;
  if (recovery) await recovery.bindSid(originalSid);
  await context.writeArtifactJson('owned-keyring-vault-result.json', result);
  let removed;
  try { removed = JSON.parse((await ps(sessionCommand, input('cleanup'), 110000)).trim()); }
  catch (error) {
    if (options.fault !== 'cleanup-ack') throw error;
    await faultObserved();
    removed = JSON.parse((await ps(sessionCommand, input('cleanup'), 110000)).trim());
  }
  validateCleanup(removed);
  if (recovery && removed.ownedSid) await recovery.bindSid(removed.ownedSid);
  await writeFile(cleanupEvidence, JSON.stringify(context.redactValue(removed), null, 2) + '\n', { mode: 0o600 });
  const gone = JSON.parse((await ps(ownedCleanupScript(root, owner))).trim()); assert.equal(gone.cleaned, true); cleaned = true;
  if (recovery) await recovery.confirmRemoteCleanup({ ...removed, rootAbsent: true });
  return { osVaultVerified: true, coreStoreVerified: coreCompleted, coreMigrationVerified: false,
    hostMigrationVerified: hostCompleted || privateCompleted, privateTransferVerified: privateCompleted, gatewayMigrationVerified: false, fixtureCleaned: true };
}
