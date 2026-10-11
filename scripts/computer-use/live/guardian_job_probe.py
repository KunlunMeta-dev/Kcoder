"""Verify independent cleanup lifetime, without reading or controlling the desktop.
Creates only a uniquely named temporary task and owned processes/files.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid


def ps_quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def wait_file(path, timeout):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        try:
            return json.loads(path.read_text(encoding='utf-8-sig'))
        except (OSError, ValueError):
            time.sleep(0.1)
    raise TimeoutError('owned fixture did not report before deadline')


def run(supervisor_path):
    report = {'status': 'failed', 'desktopInputSent': False}
    task_name = 'KCoderGuardianProbe-' + uuid.uuid4().hex
    process = None
    powershell = str(Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe')
    with tempfile.TemporaryDirectory(prefix='kcoder-guardian-probe-', dir=Path.home() / 'Downloads') as directory:
        root = Path(directory)
        # Python's Windows mode=0700 directory can be administrator-owned when
        # created through elevated SSH. Grant the exact account SID access for
        # the limited interactive task; do not broaden access to other users.
        acl_script = f"$ErrorActionPreference='Stop';$path={ps_quote(root)};$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;& ($env:SystemRoot + '\\System32\\icacls.exe') $path /grant ('*' + $sid + ':(OI)(CI)F') | Out-Null;if ($LASTEXITCODE -ne 0) {{ throw 'owned fixture ACL update failed' }}"
        subprocess.run([powershell, '-NoProfile', '-Command', acl_script], check=True, capture_output=True, timeout=10)
        guardian = root / 'guardian.ps1'
        owner = root / 'owner.ps1'
        status = root / 'supervisor.jsonl'
        ready = root / 'guardian-ready.json'
        recovered = root / 'guardian-recovered.json'
        guardian.write_text('''param([int]$OwnerProcessId)
$ErrorActionPreference = 'Stop'
trap { [IO.File]::WriteAllText(READY, (@{ error=$_.Exception.Message } | ConvertTo-Json -Compress)); exit 1 }
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class OwnedParent { [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid); [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle, uint timeout); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle); }'
$owner = [OwnedParent]::OpenProcess(0x100000, $false, $OwnerProcessId)
if ($owner -eq [IntPtr]::Zero) { throw 'cannot open owned parent synchronization handle' }
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText(READY, (@{ pid=$PID; session=(Get-Process -Id $PID).SessionId } | ConvertTo-Json -Compress), $utf8)
if ([OwnedParent]::WaitForSingleObject($owner, 45000) -ne 0) { throw 'owned parent did not exit' }
[IO.File]::WriteAllText(RECOVERED, (@{ ownerExited=$true; survivorPid=$PID } | ConvertTo-Json -Compress), $utf8)
[OwnedParent]::CloseHandle($owner) | Out-Null
'''.replace('READY', ps_quote(ready)).replace('RECOVERED', ps_quote(recovered)), encoding='utf-8-sig')
        prefix = subprocess.list2cmdline(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', str(guardian), '-OwnerProcessId'])
        owner.write_text(f'''$ErrorActionPreference = 'Stop'
$arguments = {ps_quote(prefix + ' ')} + $PID
$action = New-ScheduledTaskAction -Execute {ps_quote(powershell)} -Argument $arguments
$principal = New-ScheduledTaskPrincipal -UserId {ps_quote(os.environ['USERNAME'])} -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName {ps_quote(task_name)} -Action $action -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName {ps_quote(task_name)}
Start-Sleep -Seconds 60
''', encoding='utf-8-sig')
        try:
            process = subprocess.Popen([str(supervisor_path)], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            nonce = uuid.uuid4().hex
            # Forward only basic OS/user paths, never credentials from the caller.
            environment = {key: value for key, value in os.environ.items() if key.upper() in {
                'SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE',
                'USERNAME', 'USERDOMAIN', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
            }}
            request = dict(version=1, nonce=nonce, executable=powershell, cwd=str(root),
                           status_file=str(status), args=['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', str(owner)], env=environment)
            process.stdin.write((json.dumps(request)+'\n').encode())
            process.stdin.flush()
            until = time.monotonic() + 10
            while time.monotonic() < until:
                if process.poll() is not None:
                    raise RuntimeError('supervisor exited before ready')
                if status.exists() and '"READY"' in status.read_text(encoding='utf-8'):
                    break
                time.sleep(0.05)
            else:
                raise TimeoutError('supervisor readiness timeout')
            process.stdin.write((json.dumps(dict(command='START', version=1, nonce=nonce))+'\n').encode())
            process.stdin.flush()
            observed = wait_file(ready, 25)
            if 'error' in observed:
                raise RuntimeError(observed['error'])
            process.kill()  # Terminates only this fixture's supervisor and owned Job.
            process.wait(timeout=10)
            result = wait_file(recovered, 15)
            assert result['ownerExited'] and result['survivorPid'] == observed['pid']
            assert observed['session'] != 0
            report.update(status='passed', survivedOwnerJob=True, session=observed['session'])
        except Exception as error:
            report['error'] = type(error).__name__ + ': ' + str(error)[:200]
            diagnostic = f"$task=Get-ScheduledTask -TaskName {ps_quote(task_name)} -ErrorAction SilentlyContinue; if ($task) {{ $info=Get-ScheduledTaskInfo -TaskName {ps_quote(task_name)}; @{{ result=$info.LastTaskResult; action=$task.Actions.Arguments; executable=$task.Actions.Execute }} | ConvertTo-Json -Compress }}"
            result = subprocess.run([powershell, '-NoProfile', '-Command', diagnostic], capture_output=True, timeout=10)
            report['launchDiagnostic'] = result.stdout.decode(errors='replace').strip()
            diagnostic = f"$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile({ps_quote(guardian)},[ref]$tokens,[ref]$errors)|Out-Null; @{{parseErrors=@($errors|ForEach-Object Message);acl=(Get-Acl -LiteralPath {ps_quote(root)}).AccessToString}} | ConvertTo-Json -Compress"
            result = subprocess.run([powershell, '-NoProfile', '-Command', diagnostic], capture_output=True, timeout=10)
            report['scriptDiagnostic'] = result.stdout.decode(errors='replace').strip()
        finally:
            if process:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=10)
                process.stdin.close()
            cleanup = root / 'cleanup.ps1'
            cleanup.write_text(f'''$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName {ps_quote(task_name)} -ErrorAction SilentlyContinue
if ($task) {{
 if ($task.State -eq 'Running') {{ Stop-ScheduledTask -TaskName {ps_quote(task_name)} }}
 Unregister-ScheduledTask -TaskName {ps_quote(task_name)} -Confirm:$false
}}
''', encoding='utf-8-sig')
            done = subprocess.run([powershell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', str(cleanup)], capture_output=True, timeout=15)
            report['cleanup'] = done.returncode == 0
            if not report['cleanup']:
                report['status'] = 'failed'
    print(json.dumps(report))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    if len(sys.argv) > 2:
        import contextlib
        with open(sys.argv[2], 'x', encoding='utf-8') as output, contextlib.redirect_stdout(output):
            try:
                code = run(Path(sys.argv[1]))
            except Exception as error:
                diagnostic = getattr(error, 'stderr', b'') or b''
                print(json.dumps({'status':'failed', 'error':str(error)[:200], 'diagnostic':diagnostic.decode(errors='replace')[:1500], 'desktopInputSent':False}))
                code = 1
    else:
        code = run(Path(sys.argv[1]))
    sys.exit(code)
