# Build-time only. End-user machines never run uv or fetch dependencies.
param(
    [Parameter(Mandatory=$true)][string]$SourceArchive,
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [string]$PythonVersion = '3.14.6',
    [string]$Uv = 'uv',
    [string]$Proxy = ''
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$pin = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'upstream.json') -Raw | ConvertFrom-Json
$archive = (Resolve-Path -LiteralPath $SourceArchive).Path
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pin.sourceArchiveSha256) { throw 'Upstream source hash mismatch' }
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Output directory must not exist; use a fresh build directory' }
$root = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $root | Out-Null
if ($Proxy) { $env:HTTPS_PROXY=$Proxy; $env:HTTP_PROXY=$Proxy }
$env:UV_PYTHON_INSTALL_DIR=Join-Path $root 'runtime'
$env:UV_PYTHON_BIN_DIR=Join-Path $root 'build-bin'
$env:UV_NO_PROGRESS='1'
$env:PYTHONIOENCODING='utf-8'
$env:PYTHONDONTWRITEBYTECODE='1'
$source = Join-Path $root 'source'
Expand-Archive -LiteralPath $archive -DestinationPath $source
$desktop = Join-Path $source 'src\windows_mcp\desktop\service.py'
$content = [IO.File]::ReadAllText($desktop)
if (-not $content.Contains('from fuzzywuzzy import process')) { throw 'Expected upstream import is missing; re-review patch' }
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText($desktop,$content.Replace('from fuzzywuzzy import process','from thefuzz import process'),$utf8)
$project = Join-Path $source 'pyproject.toml'
$content = [IO.File]::ReadAllText($project)
foreach ($dependency in @('    "fuzzywuzzy>=0.18.0",','    "python-levenshtein>=0.27.1",')) {
    if (-not $content.Contains($dependency)) { throw 'Expected dependency is missing; re-review patch' }
    $content=$content.Replace($dependency,'')
}
[IO.File]::WriteAllText($project,$content,$utf8)
& $Uv python install $PythonVersion
if ($LASTEXITCODE -ne 0) { throw 'Python installation failed' }
$python = (& $Uv python find --managed-python $PythonVersion).Trim()
if ($LASTEXITCODE -ne 0 -or -not $python.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) { throw 'Interpreter must belong to build directory' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'patch_input_cleanup.py') -Destination (Join-Path $root 'patch_input_cleanup.py')
& $python -I -B (Join-Path $root 'patch_input_cleanup.py') $desktop
if ($LASTEXITCODE -ne 0) { throw 'Worker input cleanup patch failed' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'patch_input_tagging.py') -Destination (Join-Path $root 'patch_input_tagging.py')
& $python -I -B (Join-Path $root 'patch_input_tagging.py') (Join-Path $source 'src\windows_mcp\uia\core.py')
if ($LASTEXITCODE -ne 0) { throw 'Input tagging patch failed' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'patch_uia_threading.py') -Destination (Join-Path $root 'patch_uia_threading.py')
& $python -I -B (Join-Path $root 'patch_uia_threading.py') (Join-Path $source 'src\windows_mcp\uia\core.py')
if ($LASTEXITCODE -ne 0) { throw 'Worker UIA threading patch failed' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'patch_snapshot_scope.py') -Destination (Join-Path $root 'patch_snapshot_scope.py')
& $python -I -B (Join-Path $root 'patch_snapshot_scope.py') $desktop
if ($LASTEXITCODE -ne 0) { throw 'Worker snapshot scope patch failed' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'patch_clipboard_paste.py') -Destination (Join-Path $root 'patch_clipboard_paste.py')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'clipboard_paste.py') -Destination (Join-Path $source 'src\windows_mcp\kcoder_clipboard.py')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'clipboard_guard.py') -Destination (Join-Path $source 'src\windows_mcp\kcoder_clipboard_guard.py')
& $python -I -B (Join-Path $root 'patch_clipboard_paste.py') $desktop
if ($LASTEXITCODE -ne 0) { throw 'Worker clipboard preservation patch failed' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'patch_clear_text.py') -Destination (Join-Path $root 'patch_clear_text.py')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'clear_text.py') -Destination (Join-Path $source 'src\windows_mcp\kcoder_clear.py')
& $python -I -B (Join-Path $root 'patch_clear_text.py') $desktop
if ($LASTEXITCODE -ne 0) { throw 'Worker verified editable-text clear patch failed' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'patch_unicode_input.py') -Destination (Join-Path $root 'patch_unicode_input.py')
& $python -I -B (Join-Path $root 'patch_unicode_input.py') (Join-Path $source 'src\windows_mcp\uia\core.py')
if ($LASTEXITCODE -ne 0) { throw 'Worker Unicode input patch failed' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'patch_shortcut_input.py') -Destination (Join-Path $root 'patch_shortcut_input.py')
& $python -I -B (Join-Path $root 'patch_shortcut_input.py') (Join-Path $source 'src\windows_mcp\uia\core.py')
if ($LASTEXITCODE -ne 0) { throw 'Worker shortcut input patch failed' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uv.lock') -Destination (Join-Path $source 'uv.lock') -Force
& $Uv lock --check --project $source --python $python
if ($LASTEXITCODE -ne 0) { throw 'Dependency locking failed' }
$requirements=Join-Path $root 'requirements.txt'
& $Uv export --project $source --frozen --no-dev --no-emit-project --format requirements-txt --output-file $requirements
if ($LASTEXITCODE -ne 0) { throw 'Dependency export failed' }
& $Uv pip install --python $python --target (Join-Path $root 'packages') --require-hashes --only-binary ':all:' -r $requirements
if ($LASTEXITCODE -ne 0) { throw 'Offline runtime dependency staging failed' }
# The wheel contains upstream test fixtures with synthetic API credentials.
# They are not runtime dependencies and must not enter the desktop installer.
$posthogTests = Join-Path $root 'packages\posthog\test'
if (Test-Path -LiteralPath $posthogTests) { Remove-Item -LiteralPath $posthogTests -Recurse -Force }
# These ARM launchers are unused by the fixed x64 interpreter and are not
# reliably retained by the Windows installer path. Exclude before sealing.
$distlib = Join-Path (Split-Path -Parent $python) 'Lib\site-packages\pip\_vendor\distlib'
foreach ($leaf in @('t64-arm.exe','w64-arm.exe')) {
    $unused = Join-Path $distlib $leaf
    if (Test-Path -LiteralPath $unused) { Remove-Item -LiteralPath $unused -Force }
}
foreach ($bad in @('fuzzywuzzy','Levenshtein','python_levenshtein')) {
    if (Get-ChildItem -LiteralPath (Join-Path $root 'packages') | Where-Object { $_.Name -like "$bad*" }) { throw "Excluded dependency survived: $bad" }
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'launch.py') -Destination (Join-Path $root 'launch.py')
Copy-Item -LiteralPath (Join-Path $source 'LICENSE.md') -Destination (Join-Path $root 'WINDOWS-MCP-LICENSE.md')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'worker.toml') -Destination (Join-Path $root 'worker.toml')
$relativePython=$python.Substring($root.Length+1)
$manifest=@{schemaVersion=1;inputTrackingVersion=1;clipboardRecoveryVersion=1;clearTextVersion=1;status='prototype';upstream=$pin;pythonVersion=$PythonVersion;python=$relativePython;requirementsSha256=(Get-FileHash $requirements -Algorithm SHA256).Hash.ToLowerInvariant()}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $root 'runtime-manifest.json') -Encoding UTF8
& $python -I -B (Join-Path $root 'launch.py') --kcoder-runtime-check
if ($LASTEXITCODE -ne 0) { throw 'Runtime import check failed' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'check-runtime.py') -Destination (Join-Path $root 'check-runtime.py')
& $python -I -B (Join-Path $root 'check-runtime.py') $root
if ($LASTEXITCODE -ne 0) { throw 'Runtime inventory or matching checks failed' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'collect_licenses.py') -Destination (Join-Path $root 'collect_licenses.py')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'license-overrides') -Destination (Join-Path $root 'license-overrides') -Recurse
& $python -I -B (Join-Path $root 'collect_licenses.py') $root
if ($LASTEXITCODE -ne 0) { throw 'Third-party notice collection failed' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'runtime_inventory.py') -Destination (Join-Path $root 'runtime_inventory.py')
# uv distributions can contain build-time bytecode; keep the resource tree immutable.
Get-ChildItem -LiteralPath $root -Filter '*.pyc' -Recurse -File | Remove-Item -Force
Get-ChildItem -LiteralPath $root -Filter '__pycache__' -Recurse -Directory | Sort-Object { $_.FullName.Length } -Descending | Remove-Item -Recurse -Force
# uv adds a minor-version junction pointing to the concrete interpreter.
# We launch the pinned concrete directory, so remove only direct runtime aliases.
Get-ChildItem -LiteralPath (Join-Path $root 'runtime') -Directory | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } | ForEach-Object {
    [IO.Directory]::Delete($_.FullName)
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'runtime_notices.py') -Destination (Join-Path $root 'runtime_notices.py')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'stage_runtime_notices.py') -Destination (Join-Path $root 'stage_runtime_notices.py')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'runtime-license-overrides') -Destination (Join-Path $root 'runtime-license-overrides') -Recurse
& $python -I -B (Join-Path $root 'stage_runtime_notices.py') $root (Join-Path $root 'runtime-license-overrides')
if ($LASTEXITCODE -ne 0) { throw 'Version-bound runtime notice staging failed' }
& $python -I -B (Join-Path $root 'runtime_notices.py') $root (Join-Path $root 'runtime-notices.json')
if ($LASTEXITCODE -ne 0) { throw 'Interpreter/vendor notice inventory failed' }
& $python -I -B (Join-Path $root 'runtime_inventory.py') seal $root
if ($LASTEXITCODE -ne 0) { throw 'Runtime integrity inventory failed' }
Write-Output "Runtime staged at $root"
