//! Windows cannot rename a directory containing open regular-file handles.
use super::*;

/// Ephemeral identities only, while the original coordinator and pending gate remain held.
pub(in crate::storage) struct RenameFacts {
    pub path: PathBuf,
    pub identity: String,
    fences: Vec<String>,
}

impl RootLease {
    pub(in crate::storage) fn is_within(&self, path: &Path) -> bool {
        self.path.starts_with(path)
    }

    pub(in crate::storage) fn rename_facts(&self) -> Result<RenameFacts> {
        self.verify()?;
        Ok(RenameFacts {
            path: self.path.clone(),
            identity: self.directory.directory_identity()?,
            fences: self.fence_identities()?,
        })
    }
}

impl RenameFacts {
    /// Reopen only the original control leaves, with fresh access and kernel-lock checks.
    pub(in crate::storage) fn restore(&self, path: PathBuf) -> Result<RootLease> {
        let directory = PrivateDirectory::open_existing(&path)?;
        ensure!(
            directory.directory_identity()? == self.identity,
            "STORAGE_COMPONENT_BINDING_CHANGED"
        );
        let file = directory
            .try_existing_exclusive_lock(OsStr::new(WRITERS))?
            .context("STORAGE_WRITERS_ACTIVE")?;
        let secondary = if self.fences.len() == 2 {
            Some(
                directory
                    .open_read_write_file(OsStr::new("kcoder-storage-instances.lock"), false)?,
            )
        } else {
            None
        };
        let root = RootLease {
            path,
            directory,
            file,
            secondary,
        };
        root.verify()?;
        ensure!(
            root.fence_identities()? == self.fences,
            "STORAGE_COMPONENT_FENCE_CHANGED"
        );
        root.probe_secondary("STORAGE_WRITERS_ACTIVE")?;
        Ok(root)
    }
}
