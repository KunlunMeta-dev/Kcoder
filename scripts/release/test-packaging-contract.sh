#!/usr/bin/env bash

set -euo pipefail

repo_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
windows_internal="$repo_dir/scripts/release/package_internal_windows.ps1"
windows_installer="$repo_dir/scripts/install/installers/kcoder-windows-installer.nsi"
windows_marketplace_paths="$repo_dir/scripts/install/lib/windows-marketplace-paths.ps1"
windows_marketplace_repair="$repo_dir/scripts/install/installers/repair-windows-marketplaces.ps1"
tauri_build="$repo_dir/apps/kcoder-studio/renderer/src-tauri/build.rs"
tauri_debug_sidecar="$repo_dir/apps/kcoder-studio/renderer/src-tauri/binaries/wegent-executor-x86_64-unknown-linux-gnu"
retired_stem_a=kunlun
retired_stem_b=code
retired_stem="${retired_stem_a}${retired_stem_b}"

bash -n "$repo_dir/scripts/release/package_release.sh"
bash -n "$repo_dir/scripts/release/package_windows_release.sh"
bash -n "$tauri_debug_sidecar"
rg -q 'Set-StrictMode -Version Latest' "$repo_dir/scripts/release/package_release.ps1"
test -f "$windows_installer"
test -f "$windows_marketplace_paths"
test -f "$windows_marketplace_repair"
[[ "$(od -An -tx1 -N3 "$windows_installer" | tr -d ' \n')" == "efbbbf" ]]
rg -q 'KCODER_INTERNAL_BINARY' "$windows_internal"
rg -q 'KCODER_INTERNAL_PROCESS_SUPERVISOR_BIN' "$windows_internal"
rg -q 'KCODER_INTERNAL_V1' "$windows_internal"
rg -q 'kcoder-windows-installer.nsi' "$windows_internal"
rg -q 'makensis\.exe' "$windows_internal"
rg -q 'install_kcoder\.exe' "$windows_internal"
! rg -q 'config validate' "$windows_internal"
rg -q "Bundled credentials do not include active provider" "$windows_internal"
rg -Fq '"-DOUT_FILE=$stagedInstaller"' "$windows_internal"
rg -Fq 'Set-PrivateDirectoryPermissions $stage' "$windows_internal"
rg -Fq 'Set-PrivateFilePermissions $destinationTemp' "$windows_internal"
rg -Fq 'Set-PrivateFilePermissions $checksumTemp' "$windows_internal"
rg -Fq 'Set-PrivateFilePermissions $outputPath' "$windows_internal"
rg -Fq 'Set-PrivateFilePermissions $checksumPath' "$windows_internal"
rg -q 'Failed to remove credential-bearing temporary files' "$windows_internal"
rg -q 'windows-marketplace-paths.ps1' "$windows_internal"
rg -q 'Remove-NonPortableWindowsMarketplaces' "$windows_marketplace_paths"
rg -Fq '$removedMarketplaces = @(Remove-NonPortableWindowsMarketplaces $settings)' "$windows_internal"
rg -q 'Removed non-portable local plugin marketplaces from Windows bundle settings' "$windows_internal"
rg -q '\^/' "$windows_marketplace_paths"
rg -q 'root' "$windows_marketplace_paths"
rg -q 'bak-' "$windows_marketplace_repair"
rg -q 'File\]::Replace' "$windows_marketplace_repair"
rg -q 'config validate' "$windows_marketplace_repair"
rg -q 'marketplace list' "$windows_marketplace_repair"
rg -q 'Get-NonPortableWindowsMarketplaceNames' "$windows_marketplace_repair"
rg -q 'File /oname=kcoder.exe' "$windows_installer"
rg -q 'File /oname=kcoder-process-supervisor.exe' "$windows_installer"
rg -q 'MUI_PAGE_DIRECTORY' "$windows_installer"
rg -q 'InstallDir "\$LOCALAPPDATA\\Programs\\KCoder"' "$windows_installer"
rg -q 'InstallDirRegKey HKCU "Software\\KCoder" "InstallDir"' "$windows_installer"
rg -q 'WriteRegStr HKCU "Software\\KCoder"' "$windows_installer"
rg -q 'CreateShortCut "\$SMPROGRAMS\\KCoder\\KCoder.lnk"' "$windows_installer"
rg -Fq 'OutFile "${OUT_FILE}"' "$windows_installer"
rg -q 'PATH is too long for safe legacy cleanup' "$windows_installer"
rg -q 'PATH is too long for a safe automatic update' "$windows_installer"
rg -Fq '${If} $4 > 1021' "$windows_installer"
rg -Fq 'IntOp $6 $4 + $5' "$windows_installer"
rg -Fq '${If} $6 > 1023' "$windows_installer"
rg -Fq '$LOCALAPPDATA\Programs\${RETIRED_NAME_COMPACT}' "$windows_installer"
rg -Fq '$SMPROGRAMS\${RETIRED_NAME_SPACED}\${RETIRED_NAME_SPACED}.lnk' "$windows_installer"
! rg -q "File /oname=${retired_stem}.exe" "$windows_installer"
! rg -q 'kcoder-company-internal\.exe' "$windows_internal"
rg -q 'x86_64-pc-windows-gnu' "$repo_dir/scripts/release/package_windows_release.sh"
rg -q 'kcoder_process_supervisor' "$repo_dir/scripts/release/package_windows_release.sh"
rg -q 'install-kcoder.ps1' "$repo_dir/scripts/release/package_windows_release.sh"
rg -q 'install-kcoder.ps1' "$repo_dir/scripts/release/package_release.ps1"
! rg -q "${retired_stem}\.exe" "$repo_dir/scripts/release/package_release.ps1"
! rg -q "${retired_stem}\.exe" "$repo_dir/scripts/release/package_windows_release.sh"
! rg -q "stage/${retired_stem}" "$repo_dir/scripts/release/package_release.sh"
! rg -q "name = \"${retired_stem}\"" "$repo_dir/crates/kcoder_cli/Cargo.toml"
[[ ! -e "$repo_dir/crates/kcoder_cli/src/bin/${retired_stem}.rs" ]]
! rg -q "name = \"${retired_stem_a}\"" "$repo_dir/crates/kcoder_cli/Cargo.toml"
[[ ! -e "$repo_dir/crates/kcoder_cli/src/bin/${retired_stem_a}.rs" ]]
rg -q 'KCODER_TAURI_DEBUG_STUB_V1' "$tauri_build"
rg -q 'KCODER_TAURI_DEBUG_STUB_V1' "$tauri_debug_sidecar"
tauri_stub_output="$(printf '%s\n' '{"type":"request","id":"contract-1","method":"executor.health","params":{}}' | bash "$tauri_debug_sidecar")"
rg -q '"event":"executor.ready"' <<<"$tauri_stub_output"
rg -q '"id":"contract-1"' <<<"$tauri_stub_output"
rg -q '"code":"SIDECAR_NOT_BUILT"' <<<"$tauri_stub_output"
rg -q 'ProgramFiles' "$repo_dir/scripts/release/install-kcoder.ps1"
rg -q "SetEnvironmentVariable\('Path',.*'User'" "$repo_dir/scripts/release/install-kcoder.ps1"
rg -q 'Get-ChildItem -LiteralPath \$Source -Force' "$repo_dir/scripts/release/install-kcoder.ps1"
rg -q 'Copy-Item -LiteralPath \$item\.FullName.*-Recurse -Force' "$repo_dir/scripts/release/install-kcoder.ps1"
rg -q '\[switch\]\$NoPause' "$repo_dir/scripts/release/install-kcoder.ps1"
rg -q 'Read-Host.*Installation failed' "$repo_dir/scripts/release/install-kcoder.ps1"
if rg -n '\|[[:space:]]*$' "$repo_dir/scripts/release/install-kcoder.ps1"; then
  echo "Windows PowerShell installer must not use a multiline pipeline." >&2
  exit 1
fi
# PowerShell 5 parses this file correctly through its UTF-8 BOM.
node -e 'const fs=require("node:fs");const b=fs.readFileSync(process.argv[1]);if(!b.subarray(0,3).equals(Buffer.from([239,187,191])))throw new Error("PowerShell installer requires UTF-8 BOM")' "$repo_dir/scripts/release/install-kcoder.ps1"

node - "$repo_dir" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const repo = process.argv[2];
const cargo = fs.readFileSync(path.join(repo, "Cargo.toml"), "utf8");
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (!cargoVersion) throw new Error("Cargo workspace version is missing");

const studioPath = path.join(repo, "apps/kcoder-studio/package.json");
const mobilePath = path.join(repo, "apps/kcoder-studio/mobile/package.json");
const studio = JSON.parse(fs.readFileSync(studioPath, "utf8"));
const mobile = JSON.parse(fs.readFileSync(mobilePath, "utf8"));

if (studio.version !== cargoVersion) {
  throw new Error(`Studio version ${studio.version} does not match Cargo ${cargoVersion}`);
}
if (mobile.version !== cargoVersion) {
  throw new Error(`Mobile version ${mobile.version} does not match Cargo ${cargoVersion}`);
}
for (const script of ["desktop:pack:linux", "desktop:pack:win", "pack:web", "mobile:pack:web"]) {
  if (typeof studio.scripts?.[script] !== "string") throw new Error(`Missing Studio script: ${script}`);
}
if (typeof mobile.scripts?.["pack:web"] !== "string") throw new Error("Missing Mobile pack:web script");
if (!studio.scripts["pack:web"].includes("mkdirSync")) throw new Error("Studio pack:web does not create its destination");
if (!mobile.scripts["pack:web"].includes("mkdirSync")) throw new Error("Mobile pack:web does not create its destination");
if (!studio.scripts["pack:web"].includes("../../target/packages/kcoder-studio-gateway")) {
  throw new Error("Studio pack:web writes outside the release package root");
}
if (!mobile.scripts["pack:web"].includes("../../../target/packages/kcoder-studio-mobile")) {
  throw new Error("Mobile pack:web writes outside the release package root");
}
if (!studio.private || !mobile.private) throw new Error("Release npm tarballs must remain explicit private packages");
if (!studio.files?.includes("renderer/dist")) throw new Error("Studio npm package omits renderer dist");
if (!mobile.files?.includes("dist")) throw new Error("Mobile npm package omits Expo dist");
const weworkNpmIgnore = fs.readFileSync(path.join(repo, "apps/kcoder-studio/renderer/.npmignore"), "utf8");
if (!weworkNpmIgnore.includes("!dist/") || !weworkNpmIgnore.includes("!dist/**")) {
  throw new Error("Wework npm ignore rules omit the renderer dist from the parent tarball");
}

const electronConfig = JSON.stringify(studio.build ?? {});
if (!electronConfig.includes("target/release/kcoder")) {
  throw new Error("Electron package does not embed the release CLI sidecar");
}
console.log(`release packaging contract: ok (${cargoVersion})`);
NODE
