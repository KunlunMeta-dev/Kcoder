//! Only the unsigned current writer pin changes during a stopped publication.
use super::*;
use anyhow::Context;
use kcoder_config::storage::{StorageCoordinator, StoragePublishedComponent};

impl MemoryReviewStore {
    /// The caller has confirmed complete instance exit. The original operation
    /// owns copying and payload integrity; this changes only its final lock pin.
    pub fn relocate_lock(
        &self,
        coordinator: &mut StorageCoordinator,
        published: &StoragePublishedComponent,
        namespace: &OsStr,
    ) -> Result<()> {
        self.lock_relocation(published, namespace, Some(coordinator))
    }

    /// Read-only reconciliation. An unconverted or unknown pin is never repaired.
    pub fn verify_lock_relocation(
        &self,
        published: &StoragePublishedComponent,
        namespace: &OsStr,
    ) -> Result<()> {
        self.lock_relocation(published, namespace, None)
    }

    fn lock_relocation(
        &self,
        published: &StoragePublishedComponent,
        namespace: &OsStr,
        mut coordinator: Option<&mut StorageCoordinator>,
    ) -> Result<()> {
        if let Some(coordinator) = coordinator.as_deref_mut() {
            assert_operation(coordinator, published)?;
        }
        self.verify_binding()?;
        let target = self.relocation_target(published, namespace)?;
        let _source_lease = self
            .directory
            .try_existing_portable_lock(
                OsStr::new(LOCK),
                &self.binding.lock_identity,
                PrivateLeaseMode::Exclusive,
            )?
            .context("MEMORY_BUSY")?;
        let target_identity = target.portable_regular_identity(OsStr::new(LOCK))?;
        let target_lease = target
            .try_existing_portable_lock(
                OsStr::new(LOCK),
                &target_identity,
                PrivateLeaseMode::Exclusive,
            )?
            .context("MEMORY_BUSY")?;
        let binding_anchor =
            target.open_single_link_regular_file(OsStr::new("memory-binding.json"))?;
        let current: StoreBinding = read_private_json(&target, "memory-binding.json", 16 * 1024)?;
        let expected = StoreBinding {
            lock_identity: target_identity,
            ..self.binding.clone()
        };
        ensure!(
            current == expected || (coordinator.is_some() && current == self.binding),
            "MEMORY_RELOCATION_TARGET_CHANGED"
        );
        self.verify_binding()?;
        ensure!(
            self.relocation_target(published, namespace)?
                .directory_identity()?
                == target.directory_identity()?
                && target.portable_regular_identity(OsStr::new(LOCK))? == *target_lease.identity()
                && target.portable_regular_identity(OsStr::new("memory-binding.json"))?
                    == target.portable_regular_handle_identity(&binding_anchor)?,
            "MEMORY_RELOCATION_TARGET_CHANGED"
        );
        if current != expected {
            assert_operation(
                coordinator
                    .as_deref_mut()
                    .context("MEMORY_RELOCATION_READ_ONLY")?,
                published,
            )?;
            target.atomic_replace(
                OsStr::new("memory-binding.json"),
                &serde_json::to_vec(&expected)?,
            )?;
        }
        ensure!(
            read_private_json::<StoreBinding>(&target, "memory-binding.json", 16 * 1024)?
                == expected
                && target.portable_regular_identity(OsStr::new(LOCK))? == *target_lease.identity()
                && self
                    .relocation_target(published, namespace)?
                    .directory_identity()?
                    == target.directory_identity()?,
            "MEMORY_RELOCATION_TARGET_CHANGED"
        );
        self.verify_binding()
    }

    fn relocation_target(
        &self,
        published: &StoragePublishedComponent,
        namespace: &OsStr,
    ) -> Result<PrivateDirectory> {
        published.verify()?;
        ensure!(
            published.domain() == kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN,
            "MEMORY_RELOCATION_PUBLICATION_CHANGED"
        );
        let source = PrivateDirectory::open_existing(published.source_path())?;
        ensure!(
            source.directory_identity()? == published.source_identity()
                && source
                    .open_entry_handle(namespace)?
                    .open_child_directory()?
                    .open_entry_handle(OsStr::new("data"))?
                    .open_child_directory()?
                    .directory_identity()?
                    == self.directory.directory_identity()?,
            "MEMORY_RELOCATION_SOURCE_CHANGED"
        );
        let target = published
            .directory()
            .open_entry_handle(namespace)?
            .open_child_directory()?
            .open_entry_handle(OsStr::new("data"))?
            .open_child_directory()?;
        ensure!(
            target.directory_identity()? != self.directory.directory_identity()?,
            "MEMORY_RELOCATION_SAME_STORE"
        );
        Ok(target)
    }
}

fn assert_operation(
    coordinator: &mut StorageCoordinator,
    published: &StoragePublishedComponent,
) -> Result<()> {
    let receipt = coordinator.assert_offline_owner(published.operation_id())?;
    let mut parts = receipt
        .plan
        .components
        .iter()
        .filter(|part| part.domain == published.domain());
    let part = parts
        .next()
        .context("MEMORY_RELOCATION_PUBLICATION_CHANGED")?;
    ensure!(
        parts.next().is_none()
            && part.source == published.source_path()
            && part.destination == published.destination_path()
            && part.source_identity == published.source_identity(),
        "MEMORY_RELOCATION_PUBLICATION_CHANGED"
    );
    Ok(())
}

#[cfg(test)]
mod tests;
