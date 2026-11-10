//! Explicitly selected history snapshots. Reading never starts the source agent or replays tools.
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_state::external_history::{ExternalHistoryCommit, ExternalHistoryStore};
use kcoder_types::external_history::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
};

mod claude;
mod codex;
mod encoded;
mod selection;
mod transport;
pub(crate) use selection::HistoryFileSelection;
pub(crate) fn codex_file_identity(path: &Path) -> Option<(String, String)> {
    codex::identity(path).map(|(thread, physical)| (thread.to_string(), physical.to_string()))
}
pub(crate) use claude::file_identity as claude_file_identity;

/// A private plan binding, not an RPC-authorized path supplied by a client.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistorySourceBinding {
    version: u32,
    root: PathBuf,
    relative: PathBuf,
    root_identity: String,
    parent_identity: String,
    file_identity: String,
    snapshot: ExternalHistorySnapshot,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    uploaded_source: Option<kcoder_types::migration_source_upload::SourceUploadProvenance>,
}

struct SelectedSource {
    directory: PrivateDirectory,
    file: File,
    root_identity: String,
    parent_identity: String,
    file_identity: String,
}

fn file_identity(file: &File) -> Result<String> {
    let metadata = file
        .metadata()
        .map_err(|_| anyhow::anyhow!("migration_history_source_unavailable"))?;
    ensure!(metadata.is_file(), "migration_history_unsafe_source");
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid only reads the effective identity.
        ensure!(
            metadata.uid() == unsafe { libc::geteuid() }
                && metadata.nlink() == 1
                && metadata.mode() & 0o022 == 0,
            "migration_history_source_ownership_mismatch"
        );
        Ok(format!("unix:{}:{}", metadata.dev(), metadata.ino()))
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
        };
        let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: file owns the live handle and information is valid output storage.
        ensure!(
            unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut information) }
                != 0
                && information.nNumberOfLinks == 1,
            "migration_history_source_identity_unavailable"
        );
        Ok(format!(
            "windows:{}:{}:{}",
            information.dwVolumeSerialNumber, information.nFileIndexHigh, information.nFileIndexLow
        ))
    }
    #[cfg(not(any(unix, windows)))]
    anyhow::bail!("migration_history_source_identity_unsupported")
}

fn open_selected(root: &Path, relative: &Path) -> Result<SelectedSource> {
    ensure!(
        root.is_absolute()
            && (encoded::is_zstd(relative)
                || relative
                    .extension()
                    .is_some_and(|extension| extension == "jsonl")),
        "migration_history_unsafe_source"
    );
    let parts = relative.components().collect::<Vec<_>>();
    ensure!(
        !parts.is_empty()
            && parts.len() <= 16
            && parts
                .iter()
                .all(|part| matches!(part, Component::Normal(_))),
        "migration_history_unsafe_source"
    );
    let mut directory = PrivateDirectory::open_existing(root)
        .map_err(|_| anyhow::anyhow!("migration_history_unsafe_source"))?;
    directory
        .verify_trusted_config_directory()
        .map_err(|_| anyhow::anyhow!("migration_history_source_ownership_mismatch"))?;
    let root_identity = directory.directory_identity()?;
    for part in &parts[..parts.len() - 1] {
        directory = directory
            .open_child(part.as_os_str(), false)
            .map_err(|_| anyhow::anyhow!("migration_history_unsafe_source"))?;
        directory
            .verify_trusted_config_directory()
            .map_err(|_| anyhow::anyhow!("migration_history_source_ownership_mismatch"))?;
    }
    let parent_identity = directory.directory_identity()?;
    let name = parts
        .last()
        .context("migration_history_unsafe_source")?
        .as_os_str()
        .to_os_string();
    let file = directory
        .open_single_link_regular_file(&name)
        .map_err(|_| anyhow::anyhow!("migration_history_unsafe_source"))?;
    let file_identity = file_identity(&file)?;
    Ok(SelectedSource {
        directory,
        file,
        root_identity,
        parent_identity,
        file_identity,
    })
}

impl SelectedSource {
    fn verify(&self, binding: &HistorySourceBinding) -> Result<()> {
        self.directory
            .verify_trusted_config_directory()
            .map_err(|_| anyhow::anyhow!("migration_history_source_ownership_mismatch"))?;
        ensure!(
            self.root_identity == binding.root_identity
                && self.parent_identity == binding.parent_identity
                && self.file_identity == binding.file_identity
                && file_identity(&self.file)? == binding.file_identity,
            "migration_history_source_changed"
        );
        let current = open_selected(&binding.root, &binding.relative)
            .map_err(|_| anyhow::anyhow!("migration_history_source_changed"))?;
        ensure!(
            current.root_identity == binding.root_identity
                && current.parent_identity == binding.parent_identity
                && current.file_identity == binding.file_identity
                && self.file.metadata()?.len() >= binding.physical_bytes(),
            "migration_history_source_changed"
        );
        Ok(())
    }
}

impl HistorySourceBinding {
    pub fn uploaded_source(
        &self,
    ) -> Option<&kcoder_types::migration_source_upload::SourceUploadProvenance> {
        self.uploaded_source.as_ref()
    }
    pub(crate) fn with_uploaded_source(
        mut self,
        value: Option<kcoder_types::migration_source_upload::SourceUploadProvenance>,
    ) -> Self {
        if value.is_some()
            && !self
                .snapshot
                .origin
                .source_instance
                .starts_with("user-upload:")
        {
            self.snapshot.origin.source_instance = format!(
                "user-upload:captured:{}",
                self.snapshot.origin.source_instance
            );
        }
        self.uploaded_source = value;
        self
    }
    /// Call only after the user selects this exact source root/file. A growing source is frozen
    /// at its initial byte boundary; incomplete trailing bytes remain evidence, not messages.
    pub fn capture(
        root: &Path,
        relative: &Path,
        origin: ExternalHistoryOrigin,
        check: &mut impl FnMut(u64, u64) -> bool,
    ) -> Result<Self> {
        Self::capture_at(root, relative, origin, None, check)
    }

    fn capture_at(
        root: &Path,
        relative: &Path,
        mut origin: ExternalHistoryOrigin,
        boundary: Option<u64>,
        check: &mut impl FnMut(u64, u64) -> bool,
    ) -> Result<Self> {
        codex::bind_artifact(relative, &mut origin)?;
        ensure!(
            serde_json::to_vec(&origin)?.len() <= 24 * 1024,
            "migration_history_origin_budget_exceeded"
        );
        for field in [
            &origin.source_instance,
            &origin.source_session_id,
            &origin.source_format,
            &origin.adapter_revision,
        ] {
            ensure!(
                !field.is_empty() && field.len() <= 4096,
                "migration_history_invalid_origin"
            );
        }
        let mut selected = open_selected(root, relative)?;
        // A caller's display label alone cannot merge distinct selected source roots.
        origin.source_instance = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                "kcoder.history-source.v1",
                origin.source,
                &origin.source_instance,
                &selected.root_identity,
            ))?)
        );
        let current_bytes = selected.file.metadata()?.len();
        let physical_bytes = boundary.unwrap_or(current_bytes);
        ensure!(
            current_bytes >= physical_bytes,
            "migration_history_source_changed"
        );
        ensure!(
            physical_bytes <= EXTERNAL_HISTORY_MAX_BYTES,
            "migration_history_source_budget_exceeded"
        );
        let (source_bytes, source_sha256, original) = if encoded::is_zstd(relative) {
            encoded::capture(&mut selected.file, physical_bytes, check)?
        } else {
            let mut consumed = 0;
            let mut hash = Sha256::new();
            let mut buffer = [0u8; 64 * 1024];
            while consumed < physical_bytes {
                ensure!(
                    check(consumed, physical_bytes),
                    "migration_history_cancelled"
                );
                let count = (physical_bytes - consumed).min(buffer.len() as u64) as usize;
                let read = selected
                    .file
                    .read(&mut buffer[..count])
                    .map_err(|_| anyhow::anyhow!("migration_history_source_unavailable"))?;
                ensure!(read > 0, "migration_history_source_changed");
                consumed += read as u64;
                hash.update(&buffer[..read]);
            }
            ensure!(
                check(consumed, physical_bytes),
                "migration_history_cancelled"
            );
            (physical_bytes, format!("{:x}", hash.finalize()), None)
        };
        let binding = Self {
            version: 1,
            root: root.to_owned(),
            relative: relative.to_owned(),
            root_identity: selected.root_identity.clone(),
            parent_identity: selected.parent_identity.clone(),
            file_identity: selected.file_identity.clone(),
            snapshot: ExternalHistorySnapshot {
                original,
                origin,
                source_bytes,
                source_sha256,
                record_limit: EXTERNAL_HISTORY_MAX_RECORDS,
            },
            uploaded_source: None,
        };
        selected.verify(&binding)?;
        Ok(binding)
    }

    pub fn snapshot(&self) -> &ExternalHistorySnapshot {
        &self.snapshot
    }

    pub(crate) fn physical_bytes(&self) -> u64 {
        self.snapshot
            .original
            .as_ref()
            .map_or(self.snapshot.source_bytes, |source| source.bytes)
    }

    /// The target store is resolved by the caller's account, not by this source binding.
    /// Lazy opening permits receipt recovery after the original selected file disappears.
    pub fn archive(
        &self,
        target: &ExternalHistoryStore,
        operation_id: &str,
        check: &mut impl FnMut(ExternalHistoryProgress) -> bool,
    ) -> Result<ExternalHistoryCommit> {
        self.archive_inner(target, operation_id, false, check)
    }
    pub(crate) fn archive_managed(
        &self,
        target: &ExternalHistoryStore,
        operation_id: &str,
        check: &mut impl FnMut(ExternalHistoryProgress) -> bool,
    ) -> Result<ExternalHistoryCommit> {
        self.archive_inner(target, operation_id, true, check)
    }
    fn archive_inner(
        &self,
        target: &ExternalHistoryStore,
        operation_id: &str,
        managed: bool,
        check: &mut impl FnMut(ExternalHistoryProgress) -> bool,
    ) -> Result<ExternalHistoryCommit> {
        ensure!(self.version == 1, "migration_history_unsupported_binding");
        let mut import = if managed {
            target.begin_managed(operation_id, &self.snapshot)?
        } else {
            target.begin(operation_id, &self.snapshot)?
        };
        let mut source = SnapshotReader {
            binding: self,
            selected: None,
            consumed: 0,
        };
        if self.snapshot.original.is_some() {
            import.stage_original_source(&mut source, check)?;
            import.decode_original_source(check)?;
        } else {
            import.stage_source(&mut source, check)?;
        }
        import.finish(check)
    }
}

struct SnapshotReader<'a> {
    binding: &'a HistorySourceBinding,
    selected: Option<SelectedSource>,
    consumed: u64,
}

impl Read for SnapshotReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        let read = (|| -> Result<usize> {
            if self.selected.is_none() {
                let mut selected = open_selected(&self.binding.root, &self.binding.relative)?;
                selected.verify(self.binding)?;
                selected.file.seek(SeekFrom::Start(0))?;
                self.selected = Some(selected);
            }
            let selected = self
                .selected
                .as_mut()
                .context("migration_history_source_unavailable")?;
            if self.consumed == self.binding.physical_bytes() {
                selected.verify(self.binding)?;
                return Ok(0);
            }
            let count =
                (self.binding.physical_bytes() - self.consumed).min(buffer.len() as u64) as usize;
            let read = selected.file.read(&mut buffer[..count])?;
            ensure!(read > 0, "migration_history_source_changed");
            self.consumed += read as u64;
            Ok(read)
        })();
        read.map_err(|_| std::io::Error::other("migration_history_source_changed_or_unavailable"))
    }
}
