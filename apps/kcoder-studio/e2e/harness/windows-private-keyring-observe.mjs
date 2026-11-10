import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot, runE2E } from './run-context.mjs';
import { psLiteral } from './windows-package-probe.mjs';
import { runKeyringWindowsCommand } from './windows-keyring-logon.mjs';

export async function observeFailedPrivateKeyring(context, { target, failedRun }) {
  const boundary = resolve(repoRoot, 'target/test/apps/kcoder-studio/e2e/suites/gateway/windows-private-keyring.e2e.mjs');
  const path = resolve(failedRun), child = relative(boundary, path);
  assert.ok(child && !child.startsWith('..' + sep) && !child.includes(sep));
  const failure = JSON.parse(await readFile(resolve(path, 'artifacts/result.json'), 'utf8'));
  assert.equal(failure.status, 'failed');
  const original = JSON.parse(await readFile(resolve(path, 'artifacts/owned-keyring-directory-intent.json'), 'utf8'));
  assert.equal(original.initiallyAbsent, true); assert.match(original.owner, /^[a-f0-9-]{36}$/);
  assert.match(original.root, /^[D-Z]:\\kcoder-package-[a-f0-9-]{36}$/);
  assert.ok(original.root.endsWith('kcoder-package-' + original.owner));
  const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
$root=${psLiteral(original.root)};$owner=${psLiteral(original.owner)};
function Read-OwnedJson([string]$leaf){$p=Join-Path $root $leaf;$f=Get-Item -LiteralPath $p -ErrorAction Stop;if($f.PSIsContainer -or ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $f.Length -gt 262144){throw 'Original metadata is unsafe'};return ([IO.File]::ReadAllText($p)|ConvertFrom-Json)}
$marker=Read-OwnedJson '.owner.json';if($marker.owner -ne $owner){throw 'Original directory owner changed'};
$i=Read-OwnedJson 'account-owner-intent.json';if($i.owner -ne $owner -or $i.username -notmatch '^kc_e2e_[a-f0-9]{8}$' -or $i.sid -notmatch '^S-1-5-21-[0-9-]+$' -or $i.scenario -ne 'private-rpc'){throw 'Original account intent changed'};
$phases=@('account_creation_intent','account_creation_rejected','account_born','root_born','vault_reopened_deleted','cleaned');$phase=if($i.phase -in $phases){$i.phase}else{'unknown'};
$actions=@('bootstrap','write','reopen','cleanup','observe','prove-account');$jobs=@();if($i.jobs.Count -gt 16){throw 'Original job budget changed'};
foreach($j in $i.jobs){$alive=$null;$same=$null;try{$p=[Diagnostics.Process]::GetProcessById([int]$j.pid);$alive=$true;try{$same=($p.StartTime.ToUniversalTime().Ticks.ToString() -eq [string]$j.creationTicks)}finally{$p.Dispose()}}catch [ArgumentException]{$alive=$false}catch{$same=$null};$jobs+=@(@{action=$(if($j.action -in $actions){$j.action}else{'unknown'});pid=$j.pid;creationTicks=[string]$j.creationTicks;sid=$j.sid;logonType=$j.logonType;logonLuid=$j.logonLuid;profileHiveLoaded=$j.profileHiveLoaded;elevated=$j.elevated;recordedJobStopped=$j.stopped;originalPidPresent=$alive;currentBirthMatches=$same})};
$exchanges=@();foreach($name in @('bootstrap','write','reopen','cleanup','observe')){$p=Join-Path (Join-Path $root 'exchange') ($name+'-result.json');if(Test-Path -LiteralPath $p){$x=Read-OwnedJson ('exchange\\'+$name+'-result.json');$code=if($x.errorCode -in @('owned_vault_action_failed','private_keyring_rpc_failed')){$x.errorCode}else{$null};$safe=$null;if($name -eq 'write' -and $x.status -eq 'passed'){$v=$x.value;$a=$v.nativeAudit;$safe=@{status=$v.status;stage=$(if($v.stage -eq 'private_bundle_published_pending_independent_logon'){$v.stage}else{'unknown'});forcedKeyring=$v.forcedKeyring;entries=$v.entries;offers=$v.offers;publishedReferences=$v.publishedReferences;sourceOffline=$v.sourceOffline;sourceBytesUnchanged=$v.sourceBytesUnchanged;prepareReplyDiscarded=$v.prepareReplyDiscarded;originalIntentRecovered=$v.originalIntentRecovered;privatePrepareCalls=$v.privatePrepareCalls;selectedItems=$v.selectedItems;discoveredItems=$v.discoveredItems;targetFilesAndRpcContainNoOriginalValues=$v.targetFilesAndRpcContainNoOriginalValues;modelInferenceRequests=$v.modelInferenceRequests;oldToolsExecuted=$v.oldToolsExecuted;nativeAudit=@{publishedBindingsVerified=$a.publishedBindingsVerified;referenceCount=$a.referenceCount;recipientCount=$a.recipientCount;vaultValuesMatched=$a.vaultValuesMatched;fileBackendUsed=$a.fileBackendUsed;publicValuesAbsent=$a.publicValuesAbsent}}};$exchanges+=@(@{action=$name;status=$(if($x.status -in @('passed','failed')){$x.status}else{'unknown'});errorCode=$code;privateRootAbsent=$x.privateRootAbsent;verifiedWrite=$safe})}};
$native=@{readStatus='unknown'};try{
 foreach($part in @('user-data',('user-data\\kcoder-package-'+$owner),('user-data\\kcoder-package-'+$owner+'\\private-target-profile'),('user-data\\kcoder-package-'+$owner+'\\private-target-profile\\migrations'))){$d=Get-Item -LiteralPath (Join-Path $root $part) -ErrorAction Stop;if(!$d.PSIsContainer -or ($d.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Unsafe original metadata directory'}};
 $prefix='user-data\\kcoder-package-'+$owner+'\\';$n=Read-OwnedJson ($prefix+'private-keyring-intent.json');if($n.owner -ne $owner -or $n.jobId -notmatch '^mig-[a-f0-9]{32}$' -or $n.requestId -notmatch '^[a-f0-9-]{36}$'){throw 'Original native locator changed'};
 $j=Read-OwnedJson ($prefix+'private-target-profile\\migrations\\'+$n.jobId+'.json');if($j.jobId -ne $n.jobId){throw 'Original job changed'};
 $p=Read-OwnedJson ($prefix+'private-keyring-proof.json');if($p.owner -ne $owner -or $p.rootIdentity -ne $i.rootIdentity -or $p.requestId -ne $n.requestId){throw 'Original native proof changed'};
 $native=@{readStatus='read';intentPhase=$(if($n.phase -in @('bound','receiving','prepared','apply_dispatched','published','undo_dispatched','undone','released')){$n.phase}else{'unknown'});jobId=$n.jobId;requestId=$n.requestId;applyRequestId=$n.applyRequestId;applySequence=$n.applySequence;undoRequestId=$n.undoRequestId;undoDispatched=$n.undoDispatched;undoSequence=$n.undoSequence;originalPrepareSequence=$n.originalIntent.sequence;originalExpectedSequence=$n.originalIntent.expectedSequence;jobStatus=$j.status;jobSequence=$j.sequence;credentialPhases=@($j.credentialPlans|ForEach-Object{$_.phase});mcpCredentialPhases=@($j.mcpCredentialPlans|ForEach-Object{$_.phase});referenceCount=$p.references.Count;recipientCount=$p.offers.Count}
}catch [UnauthorizedAccessException]{$native=@{readStatus='access_denied'}}catch [System.Management.Automation.ItemNotFoundException]{$native=@{readStatus='missing'}}catch{$native=@{readStatus='unavailable'}};
$account=Get-LocalUser -Name $i.username -ErrorAction SilentlyContinue;$profile=Get-CimInstance Win32_UserProfile -Filter ("SID='"+$i.sid+"'");
@{owner=$owner;ownedSid=$i.sid;username=$i.username;phase=$phase;lastLaunchStopped=$i.lastLaunchStopped;writesMayHaveRun=$i.writesMayHaveRun;bootstrapPid=$i.bootstrapPid;bootstrapCreationTicks=$i.bootstrapCreationTicks;rootIdentity=$i.rootIdentity;accountExists=($null -ne $account);accountSidMatches=($account -and $account.SID.Value -eq $i.sid);accountDescriptionMatches=($account -and $account.Description -eq ('KCKeyring '+$owner));profileExists=($null -ne $profile);profileLoaded=$(if($profile){$profile.Loaded}else{$false});native=$native;jobs=$jobs;exchanges=$exchanges;readOnly=$true;newLogons=0;vaultCalls=0}|ConvertTo-Json -Depth 8 -Compress`;
  const text = await runKeyringWindowsCommand(context, target, 'observe-original-private-keyring', 'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-S', 'none', target, 'powershell', '-NoProfile', '-NonInteractive',
      '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))))", 'utf16le').toString('base64')],
    { input: Buffer.from(script, 'utf8').toString('base64') + '\n' });
  const result = JSON.parse(text.trim()); assert.equal(result.owner, original.owner);
  assert.equal(result.readOnly, true); assert.equal(result.newLogons, 0); assert.equal(result.vaultCalls, 0);
  await context.writeArtifactJson('original-private-keyring-observation.json', result);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runE2E(import.meta.url, { testId: 'observe-failed-owned-private-keyring', tier: 'manual-live',
    modelPolicy: 'Read-only original failed fixture marker, account intent, exchange status and recorded PID birth. No secret file, new logon, vault call, mutation or cleanup.' },
  context => observeFailedPrivateKeyring(context, { target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET, failedRun: process.argv[2] }));
}
