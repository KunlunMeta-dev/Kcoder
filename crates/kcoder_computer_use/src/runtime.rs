//! Verify a packaged Python runtime without executing any of its code.
//! The inventory digest MUST originate in the host release manifest, not in the
//! same untrusted directory. Host installation ACLs must prevent concurrent edits.
use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const INVENTORY: &str = "files.sha256.json";
const MAX_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;
const MAX_FILES: usize = 30_000;
const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Inventory {
    schema_version: u32,
    files: BTreeMap<String, Entry>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    sha256: String,
    bytes: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u32,
    python: String,
    python_version: String,
    #[serde(default)]
    input_tracking_version: u32,
    #[serde(default)]
    clipboard_recovery_version: u32,
    #[serde(default)]
    clear_text_version: u32,
}

/// Constructed only after validation, so a caller cannot substitute PATH/python.
#[derive(Debug)]
pub struct VerifiedRuntime {
    root: PathBuf,
    python: PathBuf,
    launcher: PathBuf,
}
impl VerifiedRuntime {
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn python(&self) -> &Path {
        &self.python
    }
    pub fn launcher(&self) -> &Path {
        &self.launcher
    }
    pub fn verify(root: &Path, expected_inventory_sha256: &str) -> Result<Self> {
        ensure!(root.is_absolute(), "runtime root must be absolute");
        for ancestor in root.ancestors() {
            ensure_plain(ancestor)?;
        }
        let root = fs::canonicalize(root)?;
        let bytes = read_bounded(&root.join(INVENTORY), MAX_MANIFEST_BYTES)?;
        ensure!(
            hex_digest(&bytes) == expected_inventory_sha256,
            "runtime inventory does not match release manifest"
        );
        let inventory: Inventory =
            serde_json::from_slice(&bytes).context("invalid runtime inventory")?;
        ensure!(
            inventory.schema_version == 1
                && !inventory.files.is_empty()
                && inventory.files.len() <= MAX_FILES,
            "invalid runtime inventory size/version"
        );
        let mut total = 0u64;
        for (relative, entry) in &inventory.files {
            validate_relative(relative)?;
            ensure!(relative != INVENTORY, "inventory cannot include itself");
            ensure!(entry.bytes <= MAX_FILE_BYTES, "runtime file exceeds limit");
            total = total
                .checked_add(entry.bytes)
                .context("runtime total overflow")?;
            ensure!(total <= MAX_TOTAL_BYTES, "runtime exceeds total budget");
        }
        let mut actual = BTreeSet::new();
        collect(&root, &root, 0, &mut actual)?;
        actual.remove(INVENTORY);
        ensure!(
            actual.len() == inventory.files.len()
                && actual.iter().all(|p| inventory.files.contains_key(p)),
            "runtime file set differs from inventory"
        );
        // Hash every byte on every verification. Bound parallel file reads so
        // Windows file-open/scanner latency does not serialize thousands of
        // independent resources; never replace integrity checks with a TTL cache.
        let entries: Vec<_> = inventory.files.iter().collect();
        let next = std::sync::atomic::AtomicUsize::new(0);
        let workers = std::thread::available_parallelism().map_or(1, |count| count.get().min(4));
        std::thread::scope(|scope| -> Result<()> {
            let mut tasks = Vec::new();
            for _ in 0..workers {
                let entries = &entries;
                let next = &next;
                let root = &root;
                tasks.push(scope.spawn(move || -> Result<()> {
                    let mut buffer = [0u8; 65536];
                    while let Some((relative, entry)) =
                        entries.get(next.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
                    {
                        verify_resource(root, relative, entry, &mut buffer)?;
                    }
                    Ok(())
                }));
            }
            for task in tasks {
                task.join()
                    .map_err(|_| anyhow::anyhow!("runtime verification worker failed"))??;
            }
            Ok(())
        })?;
        let manifest_bytes = read_bounded(&root.join("runtime-manifest.json"), 65536)?;
        let manifest: Manifest = serde_json::from_slice(
            manifest_bytes
                .strip_prefix(&[0xef, 0xbb, 0xbf])
                .unwrap_or(&manifest_bytes),
        )?;
        ensure!(
            manifest.schema_version == 1 && manifest.python_version.starts_with("3.14."),
            "unsupported Python runtime version"
        );
        ensure!(
            manifest.input_tracking_version == 1,
            "unsupported desktop input tracking protocol; update bundled component"
        );
        ensure!(
            manifest.clipboard_recovery_version == 1,
            "unsupported desktop clipboard recovery protocol; update bundled component"
        );
        ensure!(
            manifest.clear_text_version == 1,
            "unsupported verified text clearing; update bundled component"
        );
        // PowerShell records Windows separators; normalize before strict validation.
        let python = manifest.python.replace('\\', "/");
        validate_relative(&python)?;
        ensure!(
            python.starts_with("runtime/") && python.ends_with("/python.exe"),
            "unexpected interpreter location"
        );
        for required in [
            python.as_str(),
            "launch.py",
            "worker.toml",
            "runtime-manifest.json",
            "source/src/windows_mcp/kcoder_clipboard.py",
            "source/src/windows_mcp/kcoder_clipboard_guard.py",
            "source/src/windows_mcp/kcoder_clear.py",
        ] {
            ensure!(
                inventory.files.contains_key(required),
                "missing required runtime resource: {required}"
            );
        }
        Ok(Self {
            python: root.join(python),
            launcher: root.join("launch.py"),
            root,
        })
    }
}
fn hex_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn verify_resource(root: &Path, relative: &str, entry: &Entry, buffer: &mut [u8]) -> Result<()> {
    let path = root.join(relative);
    let meta = ensure_plain(&path)?;
    ensure!(
        meta.is_file() && meta.len() == entry.bytes,
        "runtime resource size mismatch: {relative}"
    );
    let mut input = fs::File::open(path)?.take(MAX_FILE_BYTES + 1);
    let mut hash = Sha256::new();
    let mut count = 0;
    loop {
        let n = input.read(buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
        count += n as u64;
    }
    ensure!(
        count == entry.bytes && format!("{:x}", hash.finalize()) == entry.sha256,
        "runtime resource hash mismatch: {relative}"
    );
    Ok(())
}

fn validate_relative(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty() && value.len() <= 2048 && !value.contains(['\\', ':', '\0']),
        "invalid runtime path"
    );
    for part in value.split('/') {
        ensure!(
            !part.is_empty()
                && part != "."
                && part != ".."
                && !part.ends_with([' ', '.'])
                && part != "__pycache__"
                && !part.ends_with(".pyc"),
            "invalid runtime path component"
        );
    }
    Ok(())
}
fn ensure_plain(path: &Path) -> Result<fs::Metadata> {
    let meta = fs::symlink_metadata(path)?;
    ensure!(
        !meta.file_type().is_symlink(),
        "linked runtime resource rejected"
    );
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        ensure!(
            meta.file_attributes() & 0x400 == 0,
            "runtime reparse point rejected"
        );
    }
    ensure!(
        meta.is_file() || meta.is_dir(),
        "unsupported runtime resource"
    );
    Ok(meta)
}
fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let meta = ensure_plain(path)?;
    ensure!(
        meta.is_file() && meta.len() <= limit,
        "runtime metadata too large"
    );
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(limit + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= limit,
        "runtime metadata grew beyond limit"
    );
    Ok(bytes)
}
fn collect(root: &Path, path: &Path, depth: usize, files: &mut BTreeSet<String>) -> Result<()> {
    ensure!(depth <= 32, "runtime directory nesting exceeds limit");
    for entry in fs::read_dir(path)? {
        let path = entry?.path();
        let meta = ensure_plain(&path)?;
        if meta.is_dir() {
            collect(root, &path, depth + 1, files)?;
        } else {
            let relative = path
                .strip_prefix(root)?
                .to_str()
                .context("runtime path is not UTF-8")?
                .replace('\\', "/");
            validate_relative(&relative)?;
            files.insert(relative);
            ensure!(files.len() <= MAX_FILES + 1, "runtime has too many files");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(root: &Path) -> String {
        fixture_with_tracking(root, 1)
    }
    fn fixture_with_tracking(root: &Path, tracking: u32) -> String {
        fixture_with_protocols(root, tracking, 1)
    }
    fn fixture_with_protocols(root: &Path, tracking: u32, clipboard: u32) -> String {
        fixture_with_versions(root, tracking, clipboard, 1)
    }
    fn fixture_with_versions(root: &Path, tracking: u32, clipboard: u32, clear: u32) -> String {
        fs::create_dir_all(root.join("runtime/python")).unwrap();
        fs::create_dir_all(root.join("source/src/windows_mcp")).unwrap();
        for (path, data) in [
            ("runtime/python/python.exe", b"binary".as_slice()),
            ("launch.py", b"launcher"),
            ("worker.toml", b"config"),
            ("source/src/windows_mcp/kcoder_clipboard.py", b"wrapper"),
            ("source/src/windows_mcp/kcoder_clipboard_guard.py", b"guard"),
            ("source/src/windows_mcp/kcoder_clear.py", b"clear"),
        ] {
            fs::write(root.join(path), data).unwrap();
        }
        fs::write(root.join("runtime-manifest.json"),serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"python":"runtime\\python\\python.exe","pythonVersion":"3.14.6","inputTrackingVersion":tracking,"clipboardRecoveryVersion":clipboard,"clearTextVersion":clear})).unwrap()).unwrap();
        let mut entries = serde_json::Map::new();
        for path in [
            "runtime/python/python.exe",
            "launch.py",
            "worker.toml",
            "runtime-manifest.json",
            "source/src/windows_mcp/kcoder_clipboard.py",
            "source/src/windows_mcp/kcoder_clipboard_guard.py",
            "source/src/windows_mcp/kcoder_clear.py",
        ] {
            let bytes = fs::read(root.join(path)).unwrap();
            entries.insert(
                path.into(),
                serde_json::json!({"bytes":bytes.len(),"sha256":hex_digest(&bytes)}),
            );
        }
        let bytes =
            serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"files":entries})).unwrap();
        fs::write(root.join(INVENTORY), &bytes).unwrap();
        hex_digest(&bytes)
    }
    #[test]
    fn parallel_verification_rejects_same_size_tampering_in_every_resource() {
        let directory = tempfile::tempdir().unwrap();
        let pin = fixture(directory.path());
        let inventory: Inventory =
            serde_json::from_slice(&fs::read(directory.path().join(INVENTORY)).unwrap()).unwrap();
        for relative in inventory.files.keys() {
            let path = directory.path().join(relative);
            let original = fs::read(&path).unwrap();
            let mut changed = original.clone();
            changed[0] ^= 1;
            fs::write(&path, changed).unwrap();
            assert!(
                VerifiedRuntime::verify(directory.path(), &pin)
                    .unwrap_err()
                    .to_string()
                    .contains("hash mismatch"),
                "{relative}"
            );
            fs::write(path, original).unwrap();
        }
        VerifiedRuntime::verify(directory.path(), &pin).unwrap();
    }
    #[test]
    fn verified_clear_requires_known_version_and_the_sealed_helper() {
        for clear in [0, 2] {
            let directory = tempfile::tempdir().unwrap();
            let pin = fixture_with_versions(directory.path(), 1, 1, clear);
            assert!(
                VerifiedRuntime::verify(directory.path(), &pin)
                    .unwrap_err()
                    .to_string()
                    .contains("verified text clearing")
            );
        }
        let directory = tempfile::tempdir().unwrap();
        fixture(directory.path());
        let missing = "source/src/windows_mcp/kcoder_clear.py";
        fs::remove_file(directory.path().join(missing)).unwrap();
        let path = directory.path().join(INVENTORY);
        let mut inventory: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        inventory["files"].as_object_mut().unwrap().remove(missing);
        let bytes = serde_json::to_vec(&inventory).unwrap();
        fs::write(path, &bytes).unwrap();
        assert!(
            VerifiedRuntime::verify(directory.path(), &hex_digest(&bytes))
                .unwrap_err()
                .to_string()
                .contains("missing required runtime resource")
        );
    }
    #[test]
    fn clipboard_helper_cannot_be_omitted_from_an_otherwise_valid_inventory() {
        let directory = tempfile::tempdir().unwrap();
        fixture_with_protocols(directory.path(), 1, 1);
        let missing = "source/src/windows_mcp/kcoder_clipboard_guard.py";
        fs::remove_file(directory.path().join(missing)).unwrap();
        let path = directory.path().join(INVENTORY);
        let mut inventory: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        inventory["files"].as_object_mut().unwrap().remove(missing);
        let bytes = serde_json::to_vec(&inventory).unwrap();
        fs::write(path, &bytes).unwrap();
        assert!(
            VerifiedRuntime::verify(directory.path(), &hex_digest(&bytes))
                .unwrap_err()
                .to_string()
                .contains("missing required runtime resource")
        );
    }
    #[test]
    fn input_tracking_protocol_cannot_be_omitted_or_guessed() {
        for tracking in [0, 2] {
            let dir = tempfile::tempdir().unwrap();
            let pin = fixture_with_tracking(dir.path(), tracking);
            assert!(
                VerifiedRuntime::verify(dir.path(), &pin)
                    .unwrap_err()
                    .to_string()
                    .contains("input tracking protocol")
            );
        }
    }
    #[test]
    fn clipboard_owner_protocol_rejects_old_and_unknown_workers() {
        for clipboard in [0, 2] {
            let dir = tempfile::tempdir().unwrap();
            let pin = fixture_with_protocols(dir.path(), 1, clipboard);
            assert!(
                VerifiedRuntime::verify(dir.path(), &pin)
                    .unwrap_err()
                    .to_string()
                    .contains("clipboard recovery protocol")
            );
        }
    }
    #[test]
    fn valid_bundle_is_relocatable_and_rejects_tampering() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("bundle");
        fs::create_dir(&root).unwrap();
        let pin = fixture(&root);
        let verified = VerifiedRuntime::verify(&root, &pin).unwrap();
        let command = crate::launch::worker_command(&verified, &std::env::temp_dir()).unwrap();
        assert_eq!(command.get_program(), verified.python());
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(&args[..4], &["-I", "-B", "-X", "utf8"]);
        assert_eq!(args[4], verified.launcher().to_string_lossy());
        assert_eq!(command.get_current_dir(), Some(verified.root()));
        let relocated = dir.path().join("中文 path");
        fs::rename(&root, &relocated).unwrap();
        assert!(VerifiedRuntime::verify(&relocated, &pin).is_ok());
        fs::write(relocated.join("launch.py"), b"tampered").unwrap();
        assert!(VerifiedRuntime::verify(&relocated, &pin).is_err());
    }
    #[test]
    fn rejects_unknown_files_untrusted_manifest_and_path_escapes() {
        let dir = tempfile::tempdir().unwrap();
        let pin = fixture(dir.path());
        assert!(VerifiedRuntime::verify(dir.path(), &"0".repeat(64)).is_err());
        fs::write(dir.path().join("extra.pth"), b"import bad").unwrap();
        assert!(VerifiedRuntime::verify(dir.path(), &pin).is_err());
        for path in [
            "../escape",
            "/absolute",
            "C:/x",
            "a//b",
            "a/../b",
            "a.",
            "a:stream",
        ] {
            assert!(validate_relative(path).is_err());
        }
    }
}
