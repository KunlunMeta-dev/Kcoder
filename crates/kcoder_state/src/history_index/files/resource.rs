//! Optional migration accounting stays below SQLite and precedes every actual growth write.
use super::*;
use crate::external_history::lifecycle::{
    ArchiveReadGuard,
    resource_budget::{ResourceKind, ResourceStream},
};
use sha2::{Digest, Sha256};

pub(crate) fn resource_for_database(
    guard: &ArchiveReadGuard,
    directory: &PrivateDirectory,
    scope: &str,
    writable: bool,
    file_ceiling: u64,
) -> Result<Option<ResourceStream>> {
    if !writable {
        return Ok(None);
    }
    let existed = match directory.open_single_link_regular_file(OsStr::new(DATABASE)) {
        Ok(_) => true,
        Err(error) if missing(&error) => false,
        Err(error) => return Err(error),
    };
    let identity = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(
            "sqlite-allocation/v1",
            scope,
            directory.directory_identity()?,
        ))?)
    );
    let ceiling = file_ceiling
        .checked_mul(2)
        .context("history_resource_budget_exceeded")?;
    // The main database and its temporary rollback journal share one allocation watermark.
    // Journal deletion does not forget an unknown range or create one charge per transaction.
    guard.resource_stream(ResourceKind::DerivedIndex, &identity, ceiling, 2, existed)
}

impl Root {
    pub(super) fn resource_extent(&self, name: &str, file: &File, length: u64) -> Result<()> {
        let Some(resource) = &self.resource else {
            return Ok(());
        };
        if resource.is_committed() {
            let checkpoint = self
                .recovery
                .as_ref()
                .filter(|_| self.recovery_active.load(Ordering::Acquire))
                .context("history_resource_already_committed")?;
            ensure!(
                name == DATABASE && length <= checkpoint.database_bytes(),
                "history_projection_recovery_extent_denied"
            );
            checkpoint.verify_file(&self.directory, name, file)?;
            return Ok(());
        }
        let held = self.directory.portable_regular_handle_identity(file)?;
        ensure!(
            self.directory.portable_regular_identity(OsStr::new(name))? == held,
            "history_resource_database_changed"
        );
        let own = file.metadata()?.len().max(length);
        let other_name = match name {
            DATABASE => JOURNAL,
            JOURNAL => DATABASE,
            _ => anyhow::bail!("history_resource_database_changed"),
        };
        let other = match self
            .directory
            .open_single_link_regular_file(OsStr::new(other_name))
        {
            Ok(file) => file.metadata()?.len(),
            Err(error) if missing(&error) => 0,
            Err(error) => return Err(error),
        };
        ensure!(
            own <= self.max_file_bytes && other <= self.max_file_bytes,
            "history_resource_budget_exceeded"
        );
        resource.ensure_extent(
            own.checked_add(other)
                .context("history_resource_budget_exceeded")?,
        )
    }
}

impl Lease {
    /// The domain producer holds its writer and has committed its complete SQLite checkpoint.
    /// This accounts allocation facts, not source semantics, content correctness or deletion rights.
    pub(crate) fn finish_resource_usage(&self) -> Result<()> {
        let root = self
            .0
            .root
            .lock()
            .map_err(|_| anyhow::anyhow!("catalog file lease unavailable"))?
            .clone()
            .context("catalog file lease released")?;
        let Some(resource) = &root.resource else {
            return Ok(());
        };
        let mut facts = Vec::new();
        let mut bytes = 0u64;
        for name in [DATABASE, JOURNAL] {
            match root
                .directory
                .open_single_link_regular_file(OsStr::new(name))
            {
                Ok(file) => {
                    let identity = root.directory.portable_regular_handle_identity(&file)?;
                    ensure!(
                        root.directory.portable_regular_identity(OsStr::new(name))? == identity,
                        "history_resource_database_changed"
                    );
                    let size = file.metadata()?.len();
                    ensure!(
                        size <= root.max_file_bytes,
                        "history_resource_budget_exceeded"
                    );
                    bytes = bytes
                        .checked_add(size)
                        .context("history_resource_budget_exceeded")?;
                    facts.push((name, identity, size));
                }
                Err(error) if missing(&error) && name == JOURNAL => {}
                Err(error) => return Err(error),
            }
        }
        resource.ensure_extent(bytes)?;
        let receipt = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                "sqlite-allocation-receipt/v1",
                root.directory.directory_identity()?,
                &facts,
            ))?)
        );
        resource.settle(bytes, facts.len() as u32, &receipt)
    }
}
