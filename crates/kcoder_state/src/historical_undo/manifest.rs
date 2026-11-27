use super::*;
use crate::history_storage_relocation::HistoryDirectoryBinding;
use std::{io::Read, time::UNIX_EPOCH};
pub const MAX_SNAPSHOT_BYTES: u64 = 3 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 8192;
// Reserve encoding overhead before hashing each entry, rather than allocating an oversized seal.
const MAX_MANIFEST_METADATA: usize = 1024 * 1024;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FileProof {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub identity: String,
    pub bytes: u64,
    pub sha256: String,
    modified_ns: Option<u128>,
    mode: String,
}
impl FileProof {
    pub(crate) fn matches(
        &self,
        current: &Self,
        directory: &PrivateDirectory,
        name: &OsStr,
    ) -> Result<bool> {
        Ok(self.same_content(current)
            && directory.history_matches_file_identity(name, &self.identity)?)
    }

    pub(crate) fn matches_exact(&self, current: &Self) -> bool {
        self.identity == current.identity && self.same_content(current)
    }

    pub(crate) fn same_content(&self, current: &Self) -> bool {
        self.bytes == current.bytes
            && self.sha256 == current.sha256
            && self.modified_ns == current.modified_ns
            && self.mode == current.mode
    }
}
#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    path: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
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
    let owner = directory.history_owner_seed()?;
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
        identity: Some(owner),
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
    directory.visit_entry_names_bounded(MAX_ENTRIES + 1, |name| {
        if directory.history_relocation_entry(name)? {
            return Ok(());
        }
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

impl Manifest {
    /// Source namespace facts remain authoritative even when the old Undo seal
    /// is stale. Comparing only its old `None` fields could reject later data.
    pub(crate) fn verify_relocation_boundaries(
        &self,
        source_history: &PrivateDirectory,
        target_history: &PrivateDirectory,
        source_artifacts: &PrivateDirectory,
        target_artifacts: &PrivateDirectory,
        session: &str,
    ) -> Result<()> {
        let history_name = format!("{session}.jsonl");
        let legacy =
            crate::session_persistence::session_state_path_for_history(Path::new(&history_name));
        for name in [
            OsStr::new(&history_name),
            legacy
                .file_name()
                .context("historical_undo_invalid_legacy_path")?,
        ] {
            ensure!(
                entry_metadata(source_history, name)? == entry_metadata(target_history, name)?,
                "HISTORY_RELOCATION_SOURCE_METADATA_CHANGED"
            );
        }
        let state = crate::artifact_id_path_component(session);
        self.state
            .verify_relocation_boundaries(source_history, target_history, &state)?;
        if let Some(artifacts) = &self.artifacts {
            artifacts.verify_relocation_boundaries(source_artifacts, target_artifacts, &state)?;
        }
        Ok(())
    }

    pub(crate) fn matches(
        &self,
        lease: &HistoricalUndoLease,
        current: &Self,
        legacy_identity: bool,
    ) -> Result<bool> {
        let history = PrivateDirectory::open_existing(
            lease
                .history_path
                .parent()
                .context("historical_undo_missing_parent")?,
        )?;
        let artifacts = PrivateDirectory::open_existing(&lease.artifact_root)?;
        let history_name = lease
            .history_path
            .file_name()
            .context("historical_undo_invalid_history_path")?;
        let state_name = crate::artifact_id_path_component(&lease.session_id);
        let legacy =
            crate::session_persistence::session_state_path_for_history(&lease.history_path);
        Ok((if legacy_identity {
            self.history
                .matches(&current.history, &history, history_name)?
        } else {
            self.history.same_content(&current.history)
        }) && self
            .state
            .matches(&current.state, &history, &state_name, legacy_identity)?
            && match (&self.artifacts, &current.artifacts) {
                (None, None) => true,
                (Some(expected), Some(current)) => {
                    expected.matches(current, &artifacts, &state_name, legacy_identity)?
                }
                _ => false,
            }
            && match (&self.legacy_state, &current.legacy_state) {
                (None, None) => true,
                (Some(expected), Some(current)) => {
                    if legacy_identity {
                        expected.matches(
                            current,
                            &history,
                            legacy
                                .file_name()
                                .context("historical_undo_invalid_legacy_path")?,
                        )?
                    } else {
                        expected.same_content(current)
                    }
                }
                _ => false,
            })
    }

    pub(crate) fn retain_content_only(&mut self) {
        self.history.identity.clear();
        if let Some(file) = &mut self.legacy_state {
            file.identity.clear();
        }
        for tree in std::iter::once(&mut self.state).chain(self.artifacts.iter_mut()) {
            for entry in &mut tree.entries {
                entry.identity.clear();
                if let Some(file) = &mut entry.file {
                    file.identity.clear();
                }
            }
        }
    }

    pub(crate) fn collect_relocation(
        &self,
        lease: &HistoricalUndoLease,
        history_path: &[String],
        artifact_path: &[String],
        graph: &mut crate::history_storage_relocation::graph::OwnerGraph,
    ) -> Result<()> {
        let history = PrivateDirectory::open_existing(
            lease
                .history_path
                .parent()
                .context("historical_undo_missing_parent")?,
        )?;
        let artifacts = PrivateDirectory::open_existing(&lease.artifact_root)?;
        let legacy =
            crate::session_persistence::session_state_path_for_history(&lease.history_path);
        let history_name = lease
            .history_path
            .file_name()
            .and_then(OsStr::to_str)
            .context("historical_undo_invalid_history_path")?;
        graph.add(history_path, &history, &[history_name])?;
        if let Ok(file) = history.open_single_link_regular_file(OsStr::new(history_name))
            && self.history.identity == identity(&file)?
        {
            graph.retain_current_file(history_path, history_name);
        }
        if let Some(legacy_proof) = &self.legacy_state {
            let legacy_name = legacy
                .file_name()
                .and_then(OsStr::to_str)
                .context("historical_undo_invalid_legacy_path")?;
            graph.add(history_path, &history, &[legacy_name])?;
            if let Ok(file) = history.open_single_link_regular_file(OsStr::new(legacy_name))
                && legacy_proof.identity == identity(&file)?
            {
                graph.retain_current_file(history_path, legacy_name);
            }
        }
        let name = crate::artifact_id_path_component(&lease.session_id);
        self.state
            .collect_relocation(&history, &name, history_path, graph)?;
        if let Some(artifacts_manifest) = &self.artifacts {
            artifacts_manifest.collect_relocation(&artifacts, &name, artifact_path, graph)?;
        }
        Ok(())
    }
}

fn open_entry_parent(root: &PrivateDirectory, path: &str) -> Result<(PrivateDirectory, String)> {
    let parts: Vec<_> = path.split('/').collect();
    ensure!(
        !parts.is_empty()
            && parts.len() <= 17
            && parts.iter().all(|part| !part.is_empty()
                && !matches!(*part, "." | "..")
                && !part.contains(['\\', '\0'])),
        "historical_undo_unsupported_entry"
    );
    let mut directory = root.duplicate_handle()?;
    for part in &parts[..parts.len() - 1] {
        directory = directory.open_child(OsStr::new(part), false)?;
    }
    Ok((directory, parts[parts.len() - 1].into()))
}

// None is absent. Directories keep their mode; ordinary files also keep mtime.
fn entry_metadata(
    directory: &PrivateDirectory,
    name: &OsStr,
) -> Result<Option<(bool, String, Option<std::time::SystemTime>)>> {
    match directory.entry_metadata(name) {
        Ok(metadata) => {
            ensure!(
                metadata.is_dir() || metadata.is_file(),
                "historical_undo_unsupported_entry"
            );
            Ok(Some((
                metadata.is_dir(),
                mode(&metadata),
                if metadata.is_file() {
                    metadata.modified().ok()
                } else {
                    None
                },
            )))
        }
        Err(error) if missing(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

fn path_metadata(
    directory: &PrivateDirectory,
    path: &str,
) -> Result<Option<(bool, String, Option<std::time::SystemTime>)>> {
    match open_entry_parent(directory, path) {
        Ok((parent, leaf)) => entry_metadata(&parent, OsStr::new(&leaf)),
        Err(error) if missing(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

pub(crate) fn verify_relocation_entry_metadata(
    source: &PrivateDirectory,
    target: &PrivateDirectory,
    name: &OsStr,
) -> Result<()> {
    ensure!(
        entry_metadata(source, name)? == entry_metadata(target, name)?,
        "HISTORY_RELOCATION_SOURCE_METADATA_CHANGED"
    );
    Ok(())
}

impl Tree {
    fn verify_relocation_boundaries(
        &self,
        source: &PrivateDirectory,
        target: &PrivateDirectory,
        name: &str,
    ) -> Result<()> {
        let name = OsStr::new(name);
        let metadata = entry_metadata(source, name)?;
        ensure!(
            metadata == entry_metadata(target, name)?,
            "HISTORY_RELOCATION_SOURCE_METADATA_CHANGED"
        );
        if !metadata.is_some_and(|(directory, _, _)| directory) {
            return Ok(());
        }
        let source = source.open_child(name, false)?;
        let target = target.open_child(name, false)?;
        for entry in &self.entries {
            ensure!(
                path_metadata(&source, &entry.path)? == path_metadata(&target, &entry.path)?,
                "HISTORY_RELOCATION_SOURCE_METADATA_CHANGED"
            );
        }
        Ok(())
    }

    fn matches(
        &self,
        current: &Self,
        parent: &PrivateDirectory,
        name: &str,
        legacy_identity: bool,
    ) -> Result<bool> {
        let Some(identity) = &self.identity else {
            return Ok(self.entries.is_empty()
                && current.identity.is_none()
                && current.entries.is_empty());
        };
        if current.identity.is_none() || self.entries.len() != current.entries.len() {
            return Ok(false);
        }
        let root = parent.open_child(OsStr::new(name), false)?;
        if legacy_identity && !root.history_matches_directory(identity)? {
            return Ok(false);
        }
        for (expected, current) in self.entries.iter().zip(&current.entries) {
            if expected.path != current.path || expected.mode != current.mode {
                return Ok(false);
            }
            let (directory, leaf) = open_entry_parent(&root, &expected.path)?;
            let same = match (&expected.file, &current.file) {
                (None, None) => {
                    !legacy_identity
                        || directory
                            .open_child(OsStr::new(&leaf), false)?
                            .history_matches_directory(&expected.identity)?
                }
                (Some(file), Some(current_file)) => {
                    if legacy_identity {
                        expected.identity == file.identity
                            && file.matches(current_file, &directory, OsStr::new(&leaf))?
                    } else {
                        file.same_content(current_file)
                    }
                }
                _ => false,
            };
            if !same {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn collect_relocation(
        &self,
        parent: &PrivateDirectory,
        name: &str,
        relative: &[String],
        graph: &mut crate::history_storage_relocation::graph::OwnerGraph,
    ) -> Result<()> {
        if self.identity.is_none() {
            return Ok(());
        }
        let root = match parent.open_child(OsStr::new(name), false) {
            Ok(root) => root,
            Err(error) if missing(&error) => return Ok(()),
            Err(error) => return Err(error),
        };
        let mut path = relative.to_vec();
        path.push(name.into());
        graph.add(&path, &root, &[])?;
        if self.identity.as_ref() == Some(&root.directory_identity()?) {
            graph.retain_current_directory(&path);
        }
        for entry in &self.entries {
            let (directory, leaf) = match open_entry_parent(&root, &entry.path) {
                Ok(entry) => entry,
                Err(error) if missing(&error) => continue,
                Err(error) => return Err(error),
            };
            let mut relative = path.clone();
            relative.extend(entry.path.split('/').map(str::to_owned));
            match directory.entry_metadata(OsStr::new(&leaf)) {
                Ok(metadata) if entry.file.is_none() && metadata.is_dir() => {
                    let child = directory.open_child(OsStr::new(&leaf), false)?;
                    graph.add(&relative, &child, &[])?;
                    if entry.identity == child.directory_identity()? {
                        graph.retain_current_directory(&relative);
                    }
                }
                Ok(metadata) if entry.file.is_some() && metadata.is_file() => {
                    relative.pop();
                    graph.add(&relative, &directory, &[&leaf])?;
                    if entry.identity
                        == identity(&directory.open_single_link_regular_file(OsStr::new(&leaf))?)?
                    {
                        graph.retain_current_file(&relative, &leaf);
                    }
                }
                Ok(_) => (),
                Err(error) if missing(&error) => (),
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
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
