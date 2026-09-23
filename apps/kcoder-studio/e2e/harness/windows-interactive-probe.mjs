import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { repoRoot, waitFor } from './run-context.mjs';

// Reuses the logged-on user's token, never a saved password. Every task and
// process belongs to this run; personal installed Studio is only a copy source.
export async function runInteractiveWindowsProbe(context, { ps, cleanupPs, upload, directory, node, installation, flags }) {
  for (const value of [directory, node, installation]) if (typeof value !== 'string' || !value || value.includes("'")) throw new Error('Invalid owned interactive Windows path');
  if (!Array.isArray(flags) || flags.some(flag => !['--model-scope','--native-input'].includes(flag))) throw new Error('Unsupported interactive probe mode');
  if(typeof cleanupPs !== 'function') throw new Error('Interactive Windows cleanup transport is required');
  const task = `kcoder-input-e2e-${randomUUID()}`;
  await upload(resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/windows-interactive-probe.ps1'), 'interactive-probe.ps1');
  const config=await context.writeStateJson('interactive-config.json', {root:directory,node,installation,
    probe:`${directory}\\studio-ui-probe.cjs`,binary:`${directory}\\kcoder.exe`,overlay:`${directory}\\overlay`,flags});
  await upload(config,'interactive-config.json');
  context.addCleanup('remove owned interactive Windows task', async()=>{
    await cleanupPs(`$file='${directory}\\interactive-owner.pid';if(Test-Path -LiteralPath $file){$ownedId=[int](Get-Content -Raw -LiteralPath $file);$p=Get-CimInstance Win32_Process -Filter "ProcessId=$ownedId" -ErrorAction SilentlyContinue;if($p -and $p.CommandLine -and $p.CommandLine.Contains('${directory}')){& taskkill /PID $ownedId /T /F | Out-Null}};$task=Get-ScheduledTask -TaskName '${task}' -ErrorAction SilentlyContinue;if($task){Stop-ScheduledTask -TaskName '${task}' -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName '${task}' -Confirm:$false};if(Get-ScheduledTask -TaskName '${task}' -ErrorAction SilentlyContinue){throw 'Owned scheduled task survived cleanup'}`);
  });
  await ps(`$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name;$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited;$action=New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') -Argument '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${directory}\\interactive-probe.ps1" -Config "${directory}\\interactive-config.json"';$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 4);Register-ScheduledTask -TaskName '${task}' -Action $action -Principal $principal -Settings $settings | Out-Null;Start-ScheduledTask -TaskName '${task}'`);
  await waitFor(async()=>{
    const status=JSON.parse((await ps(`$done=Test-Path -LiteralPath '${directory}\\interactive-exit-code';$t=Get-ScheduledTask -TaskName '${task}';$i=Get-ScheduledTaskInfo -TaskName '${task}';[pscustomobject]@{done=$done;state=[string]$t.State;result=$i.LastTaskResult}|ConvertTo-Json -Compress`)).trim());
    if(!status.done && status.state==='Ready' && status.result!==267009 && status.result!==267011 && status.result!==0) throw new Error(`Interactive probe task could not run (${status.result})`);
    return status.done;
  },210000,'owned interactive Windows probe completion',500,context.abortSignal);
  const result=await ps(`if(Test-Path -LiteralPath '${directory}\\interactive-result.json'){Get-Content -Raw -LiteralPath '${directory}\\interactive-result.json'}else{throw (Get-Content -Raw -LiteralPath '${directory}\\interactive-failure.txt')}`);
  return JSON.parse(result.trim());
}
