// Reuse the original InteractiveToken carrier and original private desktop owner.
import { runE2E } from './run-context.mjs';
import { readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
export async function run(input) {
  process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN = join(input.root,'supervisor.exe');
  let failure;
  try {
    await runE2E(import.meta.url, { testId: 'windows-widget-interactive-owned-carrier', tier: 'manual-live',
      modelPolicy: 'Original ordinary InteractiveToken Task and held Job/private desktop for one registered model-independent widget controller suite.', retainSuccessEvidence: true,
      evidenceReason: 'Actual Windows SID, private desktop handles and original registered suite result are required.' }, async context => {
      const body = '$i=[Security.Principal.WindowsIdentity]::GetCurrent();@{sid=$i.User.Value;isAdmin=([Security.Principal.WindowsPrincipal]::new($i)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId}|ConvertTo-Json -Compress';
      const caller = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(body, 'utf16le').toString('base64')], {encoding:'utf8',windowsHide:true}));
      await context.writeArtifactJson('actual-caller.json', caller);
      assert.equal(caller.sid, input.sid); assert.equal(caller.isAdmin, false); assert.ok(caller.sessionId > 0);
      const harness = join(input.root, 'source/apps/kcoder-studio/e2e/harness');
      const descriptor = await context.writeStateJson('private-desktop.json', {
        owner: input.owner, sessionId: caller.sessionId, root: input.root,
        desktopSource: join(harness, 'windows-source-desktop.cs'),
        assembly: context.pathInState('private-desktop.dll'), actor: join(harness, 'windows-widget-owned-actor.ps1'),
        actorConfiguration: join(input.root, 'actor.json'), birth: context.pathInArtifacts('private-desktop-birth.json'),
        released: context.pathInArtifacts('private-desktop-released.json'),
      });
      const literal = value => "'" + value.replaceAll("'", "''") + "'";
      const launch = '& ([ScriptBlock]::Create([IO.File]::ReadAllText(' + literal(join(harness,'windows-widget-private-actor.ps1')) + '))) -Configuration ' + literal(descriptor);
      const child = context.spawnOwned('widget-private-desktop-owner', join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(launch,'utf16le').toString('base64')], {env:context.isolatedEnvironment()});
      const exit = await new Promise((accept, reject) => {child.once('error',reject);child.once('close',accept);});
      assert.equal(exit,0);
      const released = JSON.parse((await readFile(context.pathInArtifacts('private-desktop-released.json'),'utf8')).replace(/^\uFEFF/,''));
      assert.equal(released.inheritedWindowStation,true); assert.equal(released.inheritedStationVisible,true);
      assert.deepEqual(released.handles,{station:false,desktop:false,process:false});
      if(input.suite==='native-stream-self-test'){
        const result=JSON.parse(await readFile(join(input.root,'native-stream-self-test/verification.json'),'utf8'));
        const receipt=JSON.parse(await readFile(join(input.root,'native-stream-exit.json'),'utf8'));
        assert.equal(receipt.owner,input.owner);assert.equal(receipt.sid,input.sid);assert.equal(receipt.capture.ExitCode,0);
        assert.equal(result.passed,true);assert.equal(result.normal.ExitCode,23);assert.equal(result.exactStdout,true);assert.equal(result.exactStderr,true);
        await context.writeArtifactJson('native-stream-self-test.json',{result,receipt});
        return {actualCaller:caller,privateDesktopReleased:true,nativeStreamSelfTest:true};
      }
      if(input.suite==='native-storage-unit'){
        const receipt=JSON.parse(await readFile(join(input.root,'native-storage-unit-exit.json'),'utf8'));
        assert.equal(receipt.owner,input.owner);assert.equal(receipt.sid,input.sid);
        const bytes=await readFile(join(input.root,'suite.stdout.log'));
        const tap=bytes[0]===255&&bytes[1]===254?bytes.subarray(2).toString('utf16le'):bytes.toString('utf8').replace(/^\uFEFF/,'');
        const summary=Object.fromEntries(['tests','pass','fail','skipped','cancelled'].map(key=>[key,Number(new RegExp('^# '+key+' ([0-9]+)','m').exec(tap)?.[1]??-1)]));
        await context.writeArtifactJson('native-storage-unit-result.json',{receipt,summary});
        assert.equal(receipt.exitCode,0);assert.equal(summary.fail,0);assert.equal(summary.skipped,0);assert.equal(summary.cancelled,0);assert.equal(summary.tests,14);assert.equal(summary.pass,14);
        return {actualCaller:caller,privateDesktopReleased:true,nativeStorageUnit:summary};
      }
      const suite=input.suite||'suites/browser/electron-widget-controller.e2e.mjs';
      assert.ok(['suites/browser/electron-widget-controller.e2e.mjs','suites/browser/desktop-session-renewal.e2e.mjs'].includes(suite));
      const runs = join(input.root,'source/target/test/apps/kcoder-studio/e2e',suite);
      const names = await readdir(runs); assert.equal(names.length,1);
      const manifest = JSON.parse(await readFile(join(runs,names[0],'manifest.json'),'utf8'));
      await context.writeArtifactJson('original-suite-manifest.json',manifest);
      assert.equal(manifest.status,'passed',manifest.error);
      assert.ok(manifest.cleanupSteps.every(step=>step.status==='completed'));
      await assert.rejects(lstat(join(runs,names[0],'state')), {code:'ENOENT'});
      return {actualCaller:caller,privateDesktopReleased:true,originalSuiteRun:names[0]};
    });
  } catch (error) { failure = String(error.stack); }
  await writeFile(join(input.root,'channel-scope-result.json'),JSON.stringify({passed:!failure,failure}));
}
