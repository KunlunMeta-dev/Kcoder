//! An offline Node owner holds its own lock, independent of its Rust parent's lifetime.
use super::*;

impl RootLease {
    /// Called only after this exact root's primary lease has been acquired.
    /// Missing secondary leaves are compatible with roots without a child owner.
    pub(super) fn probe_secondary(&self, busy: &'static str) -> Result<()> {
        let file = match self
            .directory
            .try_existing_shared_lock(OsStr::new(SECONDARY))
        {
            Ok(Some(file)) => file,
            Ok(None) => {
                self.verify()?;
                let named = self
                    .directory
                    .open_single_link_regular_file(OsStr::new(SECONDARY))?;
                ensure!(named.metadata()?.len() == 0, "STORAGE_ROOT_CHANGED");
                PortableLeaseIdentity::from_storage_lock_handle(&named)?;
                anyhow::bail!(busy);
            }
            Err(error) if missing(&error) => return self.verify(),
            Err(error) => return Err(error),
        };
        ensure!(file.metadata()?.len() == 0, "STORAGE_ROOT_CHANGED");
        let identity = PortableLeaseIdentity::from_storage_lock_handle(&file)?;
        ensure!(
            PortableLeaseIdentity::from_storage_lock_handle(
                &self
                    .directory
                    .open_single_link_regular_file(OsStr::new(SECONDARY))?,
            )? == identity,
            "STORAGE_ROOT_CHANGED"
        );
        self.verify()?;
        // The retained primary prevents another cooperating migration from
        // delegating a child after this successful, short secondary check.
        drop(file);
        Ok(())
    }

    /// Prepare only a control leaf, before inventory. This handle is deliberately
    /// unlocked: the child independently acquires and retains the exclusive lock.
    pub(in crate::storage) fn prepare_child_fence(&mut self) -> Result<()> {
        self.verify()?;
        if self.secondary.is_none() {
            let file = match self
                .directory
                .open_read_write_file(OsStr::new(SECONDARY), true)
            {
                Ok(file) => file,
                Err(error)
                    if error
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|error| error.kind() == std::io::ErrorKind::AlreadyExists) =>
                {
                    self.directory
                        .open_read_write_file(OsStr::new(SECONDARY), false)?
                }
                Err(error) => return Err(error),
            };
            ensure!(file.metadata()?.len() == 0, "STORAGE_ROOT_CHANGED");
            PortableLeaseIdentity::from_storage_lock_handle(&file)?;
            self.secondary = Some(file);
        }
        self.verify()
    }

    pub(super) fn verify_secondary_snapshot(&self) -> Result<()> {
        if let Some(file) = &self.secondary {
            let named = self
                .directory
                .open_single_link_regular_file(OsStr::new(SECONDARY))?;
            ensure!(
                file.metadata()?.len() == 0
                    && named.metadata()?.len() == 0
                    && PortableLeaseIdentity::from_storage_lock_handle(file)?
                        == PortableLeaseIdentity::from_storage_lock_handle(&named)?,
                "STORAGE_ROOT_CHANGED"
            );
        }
        Ok(())
    }

    /// Exact held identities, never a filename-wide copy exclusion.
    pub fn fence_identities(&self) -> Result<Vec<String>> {
        let mut identities = vec![self.fence_identity()?];
        if let Some(file) = &self.secondary {
            identities.push(serde_json::to_string(
                &PortableLeaseIdentity::from_storage_lock_handle(file)?,
            )?);
        }
        Ok(identities)
    }

    pub(in crate::storage) fn child_fence_fact(&self) -> Result<(PathBuf, String, String, String)> {
        self.verify()?;
        let secondary = self
            .secondary
            .as_ref()
            .context("STORAGE_CHILD_FENCE_UNPREPARED")?;
        Ok((
            self.path.clone(),
            self.directory.directory_identity()?,
            self.fence_identity()?,
            serde_json::to_string(&PortableLeaseIdentity::from_storage_lock_handle(secondary)?)?,
        ))
    }
}
