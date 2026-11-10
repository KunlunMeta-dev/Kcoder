use super::*;
use std::{io::Read, time::UNIX_EPOCH};
pub const MAX_SNAPSHOT_BYTES: u64 = 3 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 8192;
// Reserve encoding overhead before hashing each entry, rather than allocating an oversized seal.
const MAX_MANIFEST_METADATA: usize = 1024 * 1024;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FileProof {
    pub identity: String,
    pub bytes: u64,
    pub sha256: String,
    modified_ns: Option<u128>,
    mode: String,
}
#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    path: String,
    identity: String,
    mode: String,
    file: Option<FileProof>,
}
#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Tree {
    identity: Option<String>,
    entries: Vec<Entry>,
}
#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Manifest {
    pub history: FileProof,
    state: Tree,
    artifacts: Option<Tree>,
    legacy_state: Option<FileProof>,
}
struct Budget<'a> {
    bytes: u64,
    entries: usize,
    metadata: usize,
    check: &'a mut dyn FnMut(u64) -> bool,
}
impl Budget<'_> {
    fn entry(&mut self, path: &str) -> Result<()> {
        self.metadata = self
            .metadata
            .checked_add(path.len().saturating_mul(6) + 1024)
            .context("historical_undo_snapshot_budget_exceeded")?;
        ensure!(
            self.metadata <= MAX_MANIFEST_METADATA,
            "historical_undo_snapshot_budget_exceeded"
        );
        Ok(())
    }
    fn charge(&mut self, bytes: u64) -> Result<()> {
        self.bytes = self
            .bytes
            .checked_add(bytes)
            .context("historical_undo_snapshot_budget_exceeded")?;
        ensure!(
            self.bytes <= MAX_SNAPSHOT_BYTES,
            "historical_undo_snapshot_budget_exceeded"
        );
        ensure!((self.check)(self.bytes), "historical_undo_cancelled");
        Ok(())
    }
}
fn mode(metadata: &std::fs::Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}:{}", metadata.uid(), metadata.gid(), metadata.mode())
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        format!("{}", metadata.file_attributes())
    }
    #[cfg(not(any(unix, windows)))]
    {
        format!("{}", metadata.permissions().readonly())
    }
}
pub(crate) fn identity(file: &File) -> Result<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata()?;
        Ok(format!("unix:{}:{}", metadata.dev(), metadata.ino()))
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: the owned file has a live handle and info is writable native output storage.
        ensure!(
            unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut info) } != 0
                && info.nNumberOfLinks == 1,
            "historical_undo_file_identity_unavailable"
        );
        Ok(format!(
            "windows:{}:{}:{}",
            info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
        ))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = file;
        anyhow::bail!("historical_undo_platform_unsupported")
    }
}
pub(crate) fn file_proof(
    directory: &PrivateDirectory,
    name: &OsStr,
    check: &mut impl FnMut(u64) -> bool,
) -> Result<FileProof> {
    let mut budget = Budget {
        bytes: 0,
        entries: 0,
        metadata: 0,
        check,
    };
    file(directory, name, &mut budget)
}
fn file(directory: &PrivateDirectory, name: &OsStr, budget: &mut Budget<'_>) -> Result<FileProof> {
    let mut source = directory.open_single_link_regular_file(name)?;
    let before = source.metadata()?;
    let native = identity(&source)?;
    ensure!(
        before.len() <= MAX_SNAPSHOT_BYTES.saturating_sub(budget.bytes),
        "historical_undo_snapshot_budget_exceeded"
    );
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let count = source.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        hash.update(&buffer[..count]);
        budget.charge(count as u64)?;
    }
    let after = directory.open_single_link_regular_file(name)?;
    let meta = after.metadata()?;
    ensure!(
        bytes == before.len()
            && meta.len() == before.len()
            && identity(&after)? == native
            && before.modified().ok() == meta.modified().ok()
            && mode(&before) == mode(&meta),
        "historical_undo_session_modified"
    );
    Ok(FileProof {
        identity: native,
        bytes,
        sha256: format!("{:x}", hash.finalize()),
        modified_ns: before
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_nanos()),
        mode: mode(&before),
    })
}
fn tree(root: &PrivateDirectory, name: &str, budget: &mut Budget<'_>) -> Result<Tree> {
    let directory = match root.open_child(OsStr::new(name), false) {
        Ok(value) => value,
        Err(error) if missing(&error) => {
            return Ok(Tree {
                identity: None,
                entries: Vec::new(),
            });
        }
        Err(error) => return Err(error),
    };
    directory.verify_private_directory()?;
    let identity = directory.directory_identity()?;
    let mut entries = Vec::new();
    visit(&directory, "", 0, budget, &mut entries)?;
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    ensure!(
        root.open_child(OsStr::new(name), false)?
            .directory_identity()?
            == identity,
        "historical_undo_target_changed"
    );
    Ok(Tree {
        identity: Some(identity),
        entries,
    })
}
fn visit(
    directory: &PrivateDirectory,
    prefix: &str,
    depth: usize,
    budget: &mut Budget<'_>,
    entries: &mut Vec<Entry>,
) -> Result<()> {
    ensure!(depth <= 16, "historical_undo_snapshot_budget_exceeded");
    directory.visit_entry_names_bounded(MAX_ENTRIES, |name| {
        budget.entries += 1;
        ensure!(
            budget.entries <= MAX_ENTRIES,
            "historical_undo_snapshot_budget_exceeded"
        );
        budget.charge(0)?;
        let text = name.to_str().context("historical_undo_unsupported_entry")?;
        ensure!(
            !text.chars().any(char::is_control),
            "historical_undo_unsupported_entry"
        );
        let path = if prefix.is_empty() {
            text.into()
        } else {
            format!("{prefix}/{text}")
        };
        ensure!(
            path.len() <= 2048,
            "historical_undo_snapshot_budget_exceeded"
        );
        budget.entry(&path)?;
        let metadata = directory.entry_metadata(name)?;
        if metadata.is_dir() {
            let child = directory.open_child(name, false)?;
            child.verify_private_directory()?;
            let identity = child.directory_identity()?;
            entries.push(Entry {
                path: path.clone(),
                identity: identity.clone(),
                mode: mode(&metadata),
                file: None,
            });
            visit(&child, &path, depth + 1, budget, entries)?;
            ensure!(
                directory.open_child(name, false)?.directory_identity()? == identity,
                "historical_undo_target_changed"
            );
        } else {
            ensure!(metadata.is_file(), "historical_undo_unsupported_entry");
            let proof = file(directory, name, budget)?;
            entries.push(Entry {
                path,
                identity: proof.identity.clone(),
                mode: proof.mode.clone(),
                file: Some(proof),
            });
        }
        Ok(())
    })
}
pub(crate) fn capture(
    lease: &HistoricalUndoLease,
    check: &mut impl FnMut(u64) -> bool,
) -> Result<Manifest> {
    lease.verify(&lease.history_path, &lease.artifact_root, &lease.session_id)?;
    let history = PrivateDirectory::open_existing(
        lease
            .history_path
            .parent()
            .context("historical_undo_missing_parent")?,
    )?;
    let artifacts = PrivateDirectory::open_existing(&lease.artifact_root)?;
    let mut budget = Budget {
        bytes: 0,
        entries: 0,
        metadata: 0,
        check,
    };
    let proof = file(
        &history,
        lease
            .history_path
            .file_name()
            .context("historical_undo_invalid_history_path")?,
        &mut budget,
    )?;
    let name = crate::artifact_id_path_component(&lease.session_id);
    let state = tree(&history, &name, &mut budget)?;
    let artifacts = if lease.history_identity == lease.artifact_identity {
        None
    } else {
        Some(tree(&artifacts, &name, &mut budget)?)
    };
    let legacy = crate::session_persistence::session_state_path_for_history(&lease.history_path);
    let legacy_state = match history.open_single_link_regular_file(
        legacy
            .file_name()
            .context("historical_undo_invalid_legacy_path")?,
    ) {
        Ok(_) => Some(file(&history, legacy.file_name().unwrap(), &mut budget)?),
        Err(error) if missing(&error) => None,
        Err(error) => return Err(error),
    };
    lease.verify(&lease.history_path, &lease.artifact_root, &lease.session_id)?;
    Ok(Manifest {
        history: proof,
        state,
        artifacts,
        legacy_state,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn long_paths_are_charged_before_the_entry_body_is_hashed() {
        let mut check = |_| true;
        let mut budget = Budget {
            bytes: 0,
            entries: 0,
            metadata: 0,
            check: &mut check,
        };
        let mut accepted = 0;
        while budget.entry(&"a".repeat(2048)).is_ok() {
            accepted += 1;
        }
        assert!(accepted < 100);
        assert_eq!(budget.bytes, 0);
        assert!(budget.metadata <= MAX_MANIFEST_METADATA + 2048 * 6 + 1024);
    }
}
