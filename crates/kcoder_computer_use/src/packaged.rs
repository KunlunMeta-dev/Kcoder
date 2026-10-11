//! Resolve Computer Use only from the installed executable's resources tree.
//! Release metadata is trusted under the installation directory's ACL; this is
//! integrity checking, not a claim of signature verification against local admin.
use crate::runtime::VerifiedRuntime;
use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseManifest {
    schema_version: u32,
    platform: String,
    kind: String,
    resources: Vec<Resource>,
}
#[derive(Deserialize)]
struct Resource {
    path: String,
    sha256: String,
    bytes: u64,
}

/// Fast eligibility check for the consent dialog, not an integrity verdict.
/// Full hashing remains mandatory in `installed_runtime` before worker startup.
pub fn inspect_installed_layout(executable: &Path) -> Result<()> {
    ensure!(
        executable.is_absolute(),
        "absolute executable path required"
    );
    let binary_dir = executable.parent().context("missing binary directory")?;
    ensure!(
        binary_dir.file_name().is_some_and(|name| name == "bin"),
        "invalid packaged layout"
    );
    let resources = binary_dir.parent().context("missing resources directory")?;
    for relative in [
        "kcoder-release-manifest.json",
        "computer-use/files.sha256.json",
        "computer-use/runtime-manifest.json",
        "computer-use/launch.py",
    ] {
        let metadata = fs::symlink_metadata(resources.join(relative))?;
        ensure!(
            metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.len() > 0
                && metadata.len() <= 8 * 1024 * 1024,
            "invalid component metadata"
        );
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            ensure!(
                metadata.file_attributes() & 0x400 == 0,
                "component metadata reparse point rejected"
            );
        }
    }
    Ok(())
}

pub fn installed_runtime(executable: &Path) -> Result<VerifiedRuntime> {
    ensure!(
        executable.is_absolute(),
        "absolute executable path required"
    );
    let binary_dir = executable.parent().context("missing binary directory")?;
    ensure!(
        binary_dir.file_name().is_some_and(|name| name == "bin"),
        "Computer Use requires the packaged resources/bin layout"
    );
    let resources = binary_dir.parent().context("missing resources directory")?;
    let manifest = resources.join("kcoder-release-manifest.json");
    let metadata = fs::symlink_metadata(&manifest)?;
    ensure!(
        metadata.is_file()
            && !metadata.file_type().is_symlink()
            && metadata.len() <= 8 * 1024 * 1024,
        "invalid release manifest file"
    );
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        ensure!(
            metadata.file_attributes() & 0x400 == 0,
            "release manifest reparse point rejected"
        );
    }
    let mut bytes = Vec::new();
    fs::File::open(&manifest)?
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 8 * 1024 * 1024, "release manifest too large");
    let release: ReleaseManifest = serde_json::from_slice(&bytes)?;
    ensure!(
        release.schema_version == 1
            && release.platform == "win32"
            && release.kind == "studio-desktop",
        "unexpected desktop release identity"
    );
    let matching: Vec<_> = release
        .resources
        .iter()
        .filter(|entry| entry.path == "computer-use/files.sha256.json")
        .collect();
    ensure!(
        matching.len() == 1,
        "release must pin exactly one Computer Use inventory"
    );
    let entry = matching[0];
    ensure!(
        entry.bytes <= 8 * 1024 * 1024
            && entry.sha256.len() == 64
            && entry.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "invalid runtime inventory pin"
    );
    let root = resources.join("computer-use");
    ensure!(
        fs::symlink_metadata(root.join("files.sha256.json"))?.len() == entry.bytes,
        "inventory length differs from release"
    );
    // Also bind this runtime to the actual executable covered by the release.
    let executable_name = executable
        .file_name()
        .and_then(|name| name.to_str())
        .context("invalid executable name")?;
    let path = format!("bin/{executable_name}");
    let binaries: Vec<_> = release
        .resources
        .iter()
        .filter(|item| item.path == path)
        .collect();
    ensure!(binaries.len() == 1, "release has no unique CLI entry");
    let mut file = fs::File::open(executable)?;
    let mut hash = Sha256::new();
    let mut count = 0u64;
    let mut buffer = [0; 65536];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        count += n as u64;
        ensure!(count <= 512 * 1024 * 1024, "CLI exceeds binary size limit");
        hash.update(&buffer[..n]);
    }
    ensure!(
        count == binaries[0].bytes && format!("{:x}", hash.finalize()) == binaries[0].sha256,
        "CLI does not match release manifest"
    );
    VerifiedRuntime::verify(&root, &entry.sha256)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn eligibility_does_not_claim_integrity_or_hash_runtime_contents() {
        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(temp.path().join("computer-use")).unwrap();
        let executable = bin.join("kcoder.exe");
        assert!(inspect_installed_layout(&executable).is_err());
        for relative in [
            "kcoder-release-manifest.json",
            "computer-use/files.sha256.json",
            "computer-use/runtime-manifest.json",
            "computer-use/launch.py",
        ] {
            std::fs::write(temp.path().join(relative), b"invalid-but-present").unwrap();
        }
        assert!(inspect_installed_layout(&executable).is_ok());
        assert!(installed_runtime(&executable).is_err());
        std::fs::remove_file(temp.path().join("computer-use/launch.py")).unwrap();
        assert!(inspect_installed_layout(&executable).is_err());
    }

    #[test]
    fn packaged_cli_and_inventory_must_both_match_release() {
        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join("bin");
        let root = temp.path().join("computer-use");
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(root.join("runtime/python")).unwrap();
        let executable = bin.join("kcoder.exe");
        fs::write(&executable, b"cli").unwrap();
        let manifest =
            br#"{"schemaVersion":1,"python":"runtime/python/python.exe","pythonVersion":"3.14.6","inputTrackingVersion":1,"clipboardRecoveryVersion":1,"clearTextVersion":1}"#;
        let resources: [(&str, &[u8]); 7] = [
            ("runtime/python/python.exe", b"python"),
            ("launch.py", b"launch"),
            ("worker.toml", b"config"),
            ("runtime-manifest.json", manifest),
            ("source/src/windows_mcp/kcoder_clipboard.py", b"wrapper"),
            ("source/src/windows_mcp/kcoder_clipboard_guard.py", b"guard"),
            ("source/src/windows_mcp/kcoder_clear.py", b"clear"),
        ];
        let mut files = serde_json::Map::new();
        for (path, data) in resources {
            fs::create_dir_all(root.join(path).parent().unwrap()).unwrap();
            fs::write(root.join(path), data).unwrap();
            files.insert(path.into(),serde_json::json!({"sha256":format!("{:x}",Sha256::digest(data)),"bytes":data.len()}));
        }
        let inventory =
            serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"files":files})).unwrap();
        fs::write(root.join("files.sha256.json"), &inventory).unwrap();
        let release = serde_json::json!({"schemaVersion":1,"kind":"studio-desktop","platform":"win32","resources":[
            {"path":"computer-use/files.sha256.json","sha256":format!("{:x}",Sha256::digest(&inventory)),"bytes":inventory.len()},
            {"path":"bin/kcoder.exe","sha256":format!("{:x}",Sha256::digest(b"cli")),"bytes":3}
        ]});
        fs::write(
            temp.path().join("kcoder-release-manifest.json"),
            serde_json::to_vec(&release).unwrap(),
        )
        .unwrap();
        assert!(installed_runtime(&executable).is_ok());
        fs::write(&executable, b"bad").unwrap();
        assert!(
            installed_runtime(&executable)
                .unwrap_err()
                .to_string()
                .contains("CLI does not match")
        );
    }

    #[test]
    fn rejects_development_layout_and_missing_pins() {
        let temp = tempfile::tempdir().unwrap();
        assert!(installed_runtime(&temp.path().join("kcoder.exe")).is_err());
        let bin = temp.path().join("bin");
        fs::create_dir(&bin).unwrap();
        fs::write(bin.join("kcoder.exe"), b"binary").unwrap();
        fs::write(
            temp.path().join("kcoder-release-manifest.json"),
            br#"{"schemaVersion":1,"kind":"studio-desktop","platform":"win32","resources":[]}"#,
        )
        .unwrap();
        assert!(
            installed_runtime(&bin.join("kcoder.exe"))
                .unwrap_err()
                .to_string()
                .contains("exactly one")
        );
    }
}
