//! Stopped placement of the existing, unsigned writer and Gateway fence pins.
//! Immutable launch, approval, service and operation records are never rewritten.
use super::*;
use app_server_host::GATEWAY_SLOT;
use kcoder_config::storage::{StorageCoordinator, StoragePublishedComponent};

impl IntegrationServiceLeaseStore {
    /// Source-only preview. No namespace, fence, locator or grant is created.
    pub fn preview_gateway_fence_relocation(&self) -> Result<()> {
        self.verify()?;
        ensure!(
            self.list_native_code()?.is_empty(),
            "SERVICE_LEASE_NATIVE_CODE_RELOCATION_UNSUPPORTED"
        );
        let legacy = self.list_scope_hosts()?;
        let selections = self.app_server_host_selections()?;
        let gateway = self.gateway_app_server_slot_identity()?;
        let host_exists = match self
            .directory
            .entry_metadata(OsStr::new(scope_host::HOST_SLOT))
        {
            Ok(_) => true,
            Err(error) if missing(&error) => false,
            Err(error) => return Err(error),
        };
        ensure!(
            gateway.is_some() || (!host_exists && legacy.is_empty() && selections.is_empty()),
            "SERVICE_LEASE_LEGACY_HOST_RELOCATION_UNSUPPORTED"
        );
        self.verify()
    }

    /// The original stopped operation supplies its actual published root. Only
    /// the two current fence pins may change; all historical bytes stay intact.
    pub fn relocate_gateway_fences(
        &self,
        coordinator: &mut StorageCoordinator,
        published: &StoragePublishedComponent,
        namespace_name: &OsStr,
    ) -> Result<()> {
        self.gateway_fence_relocation(published, namespace_name, Some(coordinator))
    }

    /// Reconciliation is read-only and never repairs a copied or unknown pin.
    pub fn verify_gateway_fence_relocation(
        &self,
        published: &StoragePublishedComponent,
        namespace_name: &OsStr,
    ) -> Result<()> {
        self.gateway_fence_relocation(published, namespace_name, None)
    }

    fn gateway_fence_relocation(
        &self,
        published: &StoragePublishedComponent,
        namespace_name: &OsStr,
        mut coordinator: Option<&mut StorageCoordinator>,
    ) -> Result<()> {
        if let Some(coordinator) = coordinator.as_deref_mut() {
            assert_copy_operation(coordinator, published)?;
            self.preview_gateway_fence_relocation()?;
        } else {
            self.verify()?;
        }
        let target_namespace = self.gateway_fence_target(published, namespace_name)?;
        let target = target_namespace
            .open_entry_handle(&self.name)?
            .open_child_directory()?;
        ensure!(
            self.directory.directory_identity()? != target.directory_identity()?,
            "SERVICE_LEASE_RELOCATION_SAME_STORE"
        );
        let _source_writer = self.writer()?;
        let target_writer_identity = target.portable_regular_identity(OsStr::new("writer.lock"))?;
        let target_writer = target
            .try_existing_portable_lock(
                OsStr::new("writer.lock"),
                &target_writer_identity,
                PrivateLeaseMode::Exclusive,
            )?
            .context("SERVICE_LEASE_RELOCATION_BUSY")?;
        let gateway = self.gateway_app_server_slot_identity()?;
        let (_source_host, target_host) = if let Some(identity) = gateway {
            let source = self
                .directory
                .try_existing_portable_lock(
                    OsStr::new(scope_host::HOST_SLOT),
                    &identity,
                    PrivateLeaseMode::Exclusive,
                )?
                .context("SERVICE_LEASE_RELOCATION_BUSY")?;
            let identity = target.portable_regular_identity(OsStr::new(scope_host::HOST_SLOT))?;
            let target = target
                .try_existing_portable_lock(
                    OsStr::new(scope_host::HOST_SLOT),
                    &identity,
                    PrivateLeaseMode::Exclusive,
                )?
                .context("SERVICE_LEASE_RELOCATION_BUSY")?;
            (Some(source), Some(target))
        } else {
            (None, None)
        };
        self.verify()?;
        let expected_header = placement_bytes(
            &self.header_bytes,
            "writerIdentity",
            &target_writer_identity,
        )?;
        let gateway_bytes = if let Some(host) = &target_host {
            let original = read(&self.directory, GATEWAY_SLOT)?;
            let expected = placement_bytes(
                &original,
                "identity",
                &target.portable_regular_handle_identity(host.file())?,
            )?;
            Some((original, expected))
        } else {
            None
        };
        // The copier owns payload integrity. This owner checks only both pins
        // before writing either; unknown pin bytes must never be overwritten.
        let header_observed = read(&target, "owner.json")?;
        check_pin(
            &header_observed,
            &self.header_bytes,
            &expected_header,
            coordinator.is_some(),
        )?;
        let gateway_observed = if let Some((original, expected)) = &gateway_bytes {
            let observed = read(&target, GATEWAY_SLOT)?;
            check_pin(&observed, original, expected, coordinator.is_some())?;
            Some(observed)
        } else {
            match target.open_single_link_regular_file(OsStr::new(GATEWAY_SLOT)) {
                Ok(_) => anyhow::bail!("SERVICE_LEASE_RELOCATION_TARGET_CHANGED"),
                Err(error) if missing(&error) => {}
                Err(error) => return Err(error),
            }
            None
        };
        let verify_fences = || -> Result<()> {
            ensure!(
                target.portable_regular_identity(OsStr::new("writer.lock"))?
                    == target.portable_regular_handle_identity(target_writer.file())?,
                "SERVICE_LEASE_RELOCATION_TARGET_CHANGED"
            );
            if let Some(host) = &target_host {
                ensure!(
                    target.portable_regular_identity(OsStr::new(scope_host::HOST_SLOT))?
                        == target.portable_regular_handle_identity(host.file())?,
                    "SERVICE_LEASE_RELOCATION_TARGET_CHANGED"
                );
            }
            self.gateway_app_server_slot_identity()?;
            Ok(())
        };
        verify_fences()?;
        self.gateway_fence_target(published, namespace_name)?;
        self.verify()?;
        if let Some((original, _)) = &gateway_bytes {
            ensure!(
                read(&self.directory, GATEWAY_SLOT)? == *original,
                "SERVICE_LEASE_RELOCATION_SOURCE_CHANGED"
            );
        }
        if let Some(coordinator) = coordinator {
            if let (Some((_, expected)), Some(observed)) = (&gateway_bytes, &gateway_observed) {
                replace_pin(
                    &target,
                    GATEWAY_SLOT,
                    observed,
                    expected,
                    coordinator,
                    published,
                )?;
            }
            // The writer pin is last, keeping partially converted stores closed.
            replace_pin(
                &target,
                "owner.json",
                &header_observed,
                &expected_header,
                coordinator,
                published,
            )?;
        }
        verify_fences()?;
        ensure!(
            read(&target, "owner.json")? == expected_header,
            "SERVICE_LEASE_RELOCATION_TARGET_CHANGED"
        );
        if let Some((_, expected)) = &gateway_bytes {
            ensure!(
                read(&target, GATEWAY_SLOT)? == *expected,
                "SERVICE_LEASE_RELOCATION_TARGET_CHANGED"
            );
        }
        if let Some((original, _)) = &gateway_bytes {
            ensure!(
                read(&self.directory, GATEWAY_SLOT)? == *original,
                "SERVICE_LEASE_RELOCATION_SOURCE_CHANGED"
            );
        }
        ensure!(
            self.gateway_fence_target(published, namespace_name)?
                .open_entry_handle(&self.name)?
                .open_child_directory()?
                .directory_identity()?
                == target.directory_identity()?,
            "SERVICE_LEASE_RELOCATION_TARGET_CHANGED"
        );
        self.verify()
    }

    fn gateway_fence_target(
        &self,
        published: &StoragePublishedComponent,
        namespace_name: &OsStr,
    ) -> Result<PrivateDirectory> {
        published.verify()?;
        ensure!(
            published.domain() == kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN,
            "SERVICE_LEASE_RELOCATION_PUBLICATION_CHANGED"
        );
        let root = PrivateDirectory::open_existing(published.source_path())?;
        ensure!(
            root.directory_identity()? == published.source_identity()
                && root
                    .open_entry_handle(namespace_name)?
                    .open_child_directory()?
                    .directory_identity()?
                    == self.parent.directory_identity()?,
            "SERVICE_LEASE_RELOCATION_SOURCE_CHANGED"
        );
        published
            .directory()
            .open_entry_handle(namespace_name)?
            .open_child_directory()
    }
}

fn check_pin(observed: &[u8], original: &[u8], expected: &[u8], write: bool) -> Result<()> {
    ensure!(
        observed == expected || (write && observed == original),
        "SERVICE_LEASE_RELOCATION_TARGET_CHANGED"
    );
    Ok(())
}

fn placement_bytes(
    original: &[u8],
    field: &str,
    identity: &PortableLeaseIdentity,
) -> Result<Vec<u8>> {
    let mut document: serde_json::Value = serde_json::from_slice(original)?;
    let value = document
        .as_object_mut()
        .and_then(|object| object.get_mut(field))
        .context("SERVICE_LEASE_RELOCATION_SOURCE_CHANGED")?;
    *value = serde_json::to_value(identity)?;
    serde_json::to_vec(&document).map_err(Into::into)
}

fn replace_pin(
    directory: &PrivateDirectory,
    name: &str,
    observed: &[u8],
    expected: &[u8],
    coordinator: &mut StorageCoordinator,
    published: &StoragePublishedComponent,
) -> Result<()> {
    ensure!(
        read(directory, name)? == observed,
        "SERVICE_LEASE_RELOCATION_TARGET_CHANGED"
    );
    if observed != expected {
        assert_copy_operation(coordinator, published)?;
        directory.atomic_replace(OsStr::new(name), expected)?;
    }
    Ok(())
}

fn assert_copy_operation(
    coordinator: &mut StorageCoordinator,
    published: &StoragePublishedComponent,
) -> Result<()> {
    let receipt = coordinator.assert_offline_owner(published.operation_id())?;
    let mut components = receipt
        .plan
        .components
        .iter()
        .filter(|part| part.domain == published.domain());
    let component = components
        .next()
        .context("SERVICE_LEASE_RELOCATION_PUBLICATION_CHANGED")?;
    ensure!(
        components.next().is_none()
            && component.source == published.source_path()
            && component.destination == published.destination_path()
            && component.source_identity == published.source_identity(),
        "SERVICE_LEASE_RELOCATION_PUBLICATION_CHANGED"
    );
    Ok(())
}
