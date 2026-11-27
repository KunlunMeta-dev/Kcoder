//! Pin a Goal sidecar before releasing the history fence.
use super::*;
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory};
use std::ffi::OsString;
use std::fs::File;
use std::io::{Seek, SeekFrom};

pub(crate) struct HeldGoalMetadata {
    history_path: PathBuf,
    selected: PathBuf,
    selection: &'static str,
    child_name: Option<OsString>,
    directory: PrivateDirectory,
    directory_identity: String,
    file: File,
    file_identity: PortableLeaseIdentity,
}

impl HeldGoalMetadata {
    pub(crate) fn is_primary(&self) -> bool {
        self.selection == "primary"
    }

    /// Compare with the still-held descriptor from the original publisher.
    pub(crate) fn matches_publisher(
        &self,
        directory: &PrivateDirectory,
        file: &File,
    ) -> anyhow::Result<bool> {
        Ok(self.directory_identity == directory.directory_identity()?
            && self.file_identity == directory.portable_regular_handle_identity(file)?)
    }

    /// Called only under the first original history fence. This does not read
    /// or parse the sidecar and never creates or repairs its path.
    pub(crate) fn open(path: &Path, root: &PrivateDirectory) -> anyhow::Result<Self> {
        let parent = path.parent().context("session sidecar has no parent")?;
        let session_id = session_id_from_history_path(path)?;
        let primary = session_state_path(parent, &session_id);
        let legacy = session_state_path_for_history(path);
        for (selected, selection) in [(&primary, "primary"), (&legacy, "legacy")] {
            let child_name = if selection == "primary" {
                Some(
                    primary
                        .parent()
                        .and_then(Path::file_name)
                        .context("sidecar has no session directory")?
                        .to_os_string(),
                )
            } else {
                None
            };
            let directory = match child_name.as_deref() {
                Some(name) => match root.open_child(name, false) {
                    Ok(directory) => directory,
                    Err(error) if metadata_not_found(&error) => continue,
                    Err(error) => return Err(error),
                },
                None => root.duplicate_handle()?,
            };
            directory.verify_private_directory()?;
            let name = selected.file_name().context("sidecar has no name")?;
            let file = match directory.open_regular_file_snapshot(name) {
                Ok(file) => file,
                Err(error) if metadata_not_found(&error) => continue,
                Err(error) => return Err(error),
            };
            let file_identity = directory.portable_regular_handle_identity(&file)?;
            let directory_identity = directory.directory_identity()?;
            let held = Self {
                history_path: path.to_path_buf(),
                selected: selected.to_path_buf(),
                selection,
                child_name,
                directory,
                directory_identity,
                file,
                file_identity,
            };
            held.verify(root)?;
            return Ok(held);
        }
        anyhow::bail!("session sidecar is unavailable")
    }

    /// Copy only the originally pinned file while the history fence is released.
    pub(crate) fn copy(
        &mut self,
        max_bytes: u64,
        mut check: impl FnMut() -> anyhow::Result<()>,
    ) -> anyhow::Result<CapturedSessionMetadata> {
        anyhow::ensure!(
            (1..=1024 * 1024).contains(&max_bytes),
            "invalid captured metadata budget"
        );
        check()?;
        let before = self.file.metadata()?;
        anyhow::ensure!(
            before.len() <= max_bytes,
            "session sidecar exceeds byte budget"
        );
        let identity = crate::history_index::transcript_input_identity(&self.file)?;
        self.file.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::with_capacity(before.len() as usize);
        let mut chunk = [0_u8; 16 * 1024];
        while (bytes.len() as u64) < before.len() {
            check()?;
            let allowance = (before.len() - bytes.len() as u64).min(chunk.len() as u64) as usize;
            let read = self.file.read(&mut chunk[..allowance])?;
            check()?;
            if read == 0 {
                break;
            }
            bytes.extend_from_slice(&chunk[..read]);
        }
        let after = self.file.metadata()?;
        check()?;
        anyhow::ensure!(
            before.len() == bytes.len() as u64
                && after.len() == before.len()
                && after.modified().ok() == before.modified().ok(),
            "session sidecar changed during capture"
        );
        Ok(CapturedSessionMetadata {
            history_path: self.history_path.clone(),
            selected: self.selected.clone(),
            selection: self.selection,
            identity: Some(identity),
            bytes: Some(bytes),
        })
    }

    /// Confirm the held directory and leaf are still the currently attached objects.
    pub(crate) fn verify(&self, root: &PrivateDirectory) -> anyhow::Result<()> {
        if self.selection == "legacy" {
            let parent = self
                .history_path
                .parent()
                .context("session sidecar has no parent")?;
            let session_id = session_id_from_history_path(&self.history_path)?;
            let primary = session_state_path(parent, &session_id);
            let directory_name = primary
                .parent()
                .and_then(Path::file_name)
                .context("primary sidecar has no session directory")?;
            match root.open_child(directory_name, false) {
                Ok(directory) => {
                    let name = primary.file_name().context("primary sidecar has no name")?;
                    match directory.open_regular_file_snapshot(name) {
                        Err(error) if metadata_not_found(&error) => {}
                        Ok(_) => anyhow::bail!("primary sidecar appeared after legacy selection"),
                        Err(error) => return Err(error),
                    }
                }
                Err(error) if metadata_not_found(&error) => {}
                Err(error) => return Err(error),
            }
        }
        let current = match self.child_name.as_deref() {
            Some(name) => root.open_child(name, false)?,
            None => root.duplicate_handle()?,
        };
        anyhow::ensure!(
            current.directory_identity()? == self.directory_identity,
            "sidecar directory changed"
        );
        let name = self.selected.file_name().context("sidecar has no name")?;
        anyhow::ensure!(
            self.directory
                .portable_regular_handle_identity(&self.file)?
                == self.file_identity
                && current
                    .portable_regular_handle_identity(&current.open_regular_file_snapshot(name)?)?
                    == self.file_identity,
            "sidecar object changed"
        );
        Ok(())
    }
}
