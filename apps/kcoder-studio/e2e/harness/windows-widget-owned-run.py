"""Run the registered Windows controller suite in its original owned logon Job."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import secrets
import subprocess
import tarfile
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root-source', required=True)
    parser.add_argument('--preparation', required=True)
    parser.add_argument('--runtime', required=True)
    parser.add_argument('--supervisor', required=True)
    parser.add_argument('--target', required=True)
    parser.add_argument('--node', required=True)
    parser.add_argument('--evidence', required=True)
    parser.add_argument('--interactive', action='store_true')
    parser.add_argument('--suite', choices=['suites/browser/electron-widget-controller.e2e.mjs','suites/browser/desktop-session-renewal.e2e.mjs','native-storage-unit','native-stream-self-test'], default='suites/browser/electron-widget-controller.e2e.mjs')
    args = parser.parse_args()
    evidence = Path(args.evidence)
    evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
    preparation = json.loads(Path(args.preparation).read_text())
    runtime = Path(args.runtime)
    assert hashlib.sha256(runtime.read_bytes()).hexdigest() == preparation['runtime']['sha256']
    owner = str(uuid.uuid4())
    username = 'kc_e2e_' + secrets.token_hex(4)
    remote = 'C:\\kcoder-widget-' + owner
    record = {'version': 1, 'owner': owner, 'username': username,
              'target': args.target, 'remoteRoot': remote, 'phase': 'staging'}
    (evidence / 'owner.json').write_text(json.dumps(record, indent=2))
    ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', args.target]

    def ps(body, data=None, timeout=60):
        encoded = base64.b64encode(body.encode('utf-16le')).decode()
        result = subprocess.run(ssh + ['powershell', '-NoProfile', '-NonInteractive',
                                      '-EncodedCommand', encoded], input=data,
                                capture_output=True, timeout=timeout)
        return result

    def quoted(value):
        return "'" + value.replace("'", "''") + "'"

    result = ps("$ErrorActionPreference='Stop';if(Test-Path -LiteralPath " + quoted(remote) +
                "){throw 'Owner root already exists'};New-Item -ItemType Directory -Path " +
                quoted(remote) + "|Out-Null")
    assert result.returncode == 0, 'Remote exclusive staging failed'
    inputs = []
    with tarfile.open(evidence / 'inputs.tar', 'w') as archive:
        for entry in preparation['source_closure']:
            path = Path(args.root_source) / entry['path']
            assert hashlib.sha256(path.read_bytes()).hexdigest() == entry['sha256']
            inputs.append(entry)
            archive.add(path, arcname='source/' + entry['path'])
        for name in ['windows-widget-owned-actor.ps1', 'windows-widget-owned-session.ps1',
                     'windows-widget-private-actor.ps1', 'windows-widget-interactive-run.mjs',
                     'windows-widget-interactive-entry.mjs','windows-native-stream.cs'] + (['windows-native-stream.verify.ps1','windows-native-stream-fixture.mjs','windows-native-stream.test.mjs'] if args.suite == 'native-stream-self-test' else []):
            relative = 'apps/kcoder-studio/e2e/harness/' + name
            path = Path(__file__).parent / name
            inputs.append({'path': relative, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
            archive.add(path, arcname='source/' + relative)
        for name in ['windows-interactive-task.ps1', 'windows-source-desktop.cs']:
            relative = 'apps/kcoder-studio/e2e/harness/' + name
            path = Path(args.root_source) / relative
            inputs.append({'path': relative, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
            archive.add(path, arcname='source/' + relative)
        marker = evidence / '.owner.json'
        marker.write_text(json.dumps({'owner': owner, 'username': username}))
        inventory = evidence / 'source-inputs.json'
        inventory.write_text(json.dumps(inputs, indent=2))
        archive.add(marker, arcname='.owner.json')
        archive.add(inventory, arcname='source-inputs.json')
        archive.add(Path(args.supervisor), arcname='supervisor.exe')
    for local, name in [(evidence / 'inputs.tar', 'inputs.tar'), (runtime, 'electron.zip')]:
        subprocess.run(['scp', '-q', str(local), args.target + ':' + remote.replace('\\', '/') + '/' + name],
                       check=True, timeout=180)
    script = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$root=" + quoted(remote) + ";"
    script += "if((Get-FileHash (Join-Path $root 'electron.zip') -Algorithm SHA256).Hash.ToLowerInvariant() -cne '" + preparation['runtime']['sha256'] + "'){throw 'Runtime digest mismatch'};"
    script += "tar -xf (Join-Path $root 'inputs.tar') -C $root;if($LASTEXITCODE){throw 'Source extraction failed'};Expand-Archive -LiteralPath (Join-Path $root 'electron.zip') -DestinationPath (Join-Path $root 'electron');"
    script += "$h=Join-Path $root 'source\\apps\\kcoder-studio\\e2e\\harness';foreach($leaf in @('windows-widget-owned-actor.ps1','windows-widget-owned-session.ps1')){$tokens=$null;$errors=$null;[Management.Automation.Language.Parser]::ParseFile((Join-Path $h $leaf),[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){$errors|ForEach-Object{$_.Message};throw 'Actor syntax error'}};"
    script += "& ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $h 'windows-widget-owned-session.ps1')))) -Root $root"
    if args.interactive:
        script = script[:script.index("& ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $h 'windows-widget-owned-session.ps1'))))")]
        script += "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;"
        script += "@{root=$root;owner=" + quoted(owner) + ";sid=$sid;suite="+quoted(args.suite)+";node=" + quoted(args.node) + "}|ConvertTo-Json -Compress|Set-Content -LiteralPath (Join-Path $root 'actor.json') -Encoding UTF8;"
        script += "Copy-Item -LiteralPath (Join-Path $h 'windows-widget-interactive-entry.mjs') -Destination (Join-Path $root 'windows-widget-interactive-entry.mjs');"
        script += "@{root=$root;owner=" + quoted(owner) + ";sid=$sid;suite="+quoted(args.suite)+"}|ConvertTo-Json -Compress|Set-Content -LiteralPath (Join-Path $root 'descriptor.json') -Encoding UTF8;"
        script += "& ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $h 'windows-interactive-task.ps1')))) -Descriptor (Join-Path $root 'descriptor.json') -Node " + quoted(args.node)
    request = {'owner': owner, 'username': username, 'password': secrets.token_urlsafe(24) + 'aA9!',
               'node': args.node}
    record['phase'] = 'original-owned-session-running'
    (evidence / 'owner.json').write_text(json.dumps(record, indent=2))
    result = ps(script, json.dumps(request).encode(), timeout=570)
    (evidence / 'session.stdout.log').write_bytes(result.stdout)
    (evidence / 'session.stderr.log').write_bytes(result.stderr)
    record['sessionExit'] = result.returncode
    record['phase'] = 'session-terminal-evidence-pending'
    (evidence / 'owner.json').write_text(json.dumps(record, indent=2))
    # Archive only this run; retain unknown owner state rather than replaying the actor.
    result = ps("$root=" + quoted(remote) + ";tar -cf (Join-Path $root 'evidence.tar') -C $root session-receipt.json channel-fixture-task.json channel-scope-result.json suite.stdout.log suite.stderr.log source-inputs.json source/target/test")
    (evidence / 'archive.stderr.log').write_bytes(result.stderr)
    subprocess.run(['scp', '-q', args.target + ':' + remote.replace('\\', '/') + '/evidence.tar',
                    str(evidence / 'evidence.tar')], check=True, timeout=60)
    print(json.dumps(record))


if __name__ == '__main__':
    main()
