//! Current unsigned writer pins for the existing Native business store formats.
//! Typed owners validate their records; copying and shutdown stay with the caller.
use anyhow::{Context, Result, ensure};
use kcoder_config::storage::{StorageCoordinator, StoragePublishedComponent};
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory, PrivateLeaseMode};
use std::{ffi::OsStr, io::Read};

pub(crate) enum Store {
    Operations,
    Automation,
    WorkspaceResources,
    Budgets,
    RemoteDelegations,
}

impl Store {
    fn layout(&self) -> (&str, &str, &str, &str, usize) {
        match self {
            Self::Operations => (
                "data",
                "owner.json",
                "operations.lock",
                "lock_identity",
                64 * 1024,
            ),
            Self::Automation => (
                "store",
                "automation-binding.json",
                "automations.lock",
                "lockIdentity",
                16 * 1024,
            ),
            Self::WorkspaceResources => (
                "data",
                "office-header.json",
                "office-state.lock",
                "lockIdentity",
                16 * 1024,
            ),
            Self::Budgets => ("ledger", "owner.json", "budgets.lock", "lockIdentity", 8192),
            Self::RemoteDelegations => (
                "data",
                "owner.json",
                "delegations.lock",
                "lockIdentity",
                8192,
            ),
        }
    }
}

pub(crate) fn place(
    store: Store,
    source: &PrivateDirectory,
    source_lock: &PortableLeaseIdentity,
    published: &StoragePublishedComponent,
    namespace: &OsStr,
    mut coordinator: Option<&mut StorageCoordinator>,
) -> Result<()> {
    if let Some(coordinator) = coordinator.as_deref_mut() {
        assert_operation(coordinator, published)?;
    }
    let (leaf, header, lock, field, limit) = store.layout();
    let target = open_target(source, published, namespace, leaf)?;
    let _source_lease = source
        .try_existing_portable_lock(OsStr::new(lock), source_lock, PrivateLeaseMode::Exclusive)?
        .context("NATIVE_STORE_WRITER_BUSY")?;
    let target_identity = target.portable_regular_identity(OsStr::new(lock))?;
    let target_lease = target
        .try_existing_portable_lock(
            OsStr::new(lock),
            &target_identity,
            PrivateLeaseMode::Exclusive,
        )?
        .context("NATIVE_STORE_WRITER_BUSY")?;
    let original = read(source, header, limit)?;
    let mut expected: serde_json::Value = serde_json::from_slice(&original)?;
    let pin = expected
        .as_object_mut()
        .and_then(|object| object.get_mut(field))
        .context("NATIVE_STORE_WRITER_HEADER_INVALID")?;
    ensure!(
        *pin == serde_json::to_value(source_lock)?,
        "NATIVE_STORE_WRITER_SOURCE_CHANGED"
    );
    *pin = serde_json::to_value(&target_identity)?;
    let expected = serde_json::to_vec(&expected)?;
    let header_anchor = target.open_single_link_regular_file(OsStr::new(header))?;
    let current = read(&target, header, limit)?;
    ensure!(
        current == expected || (coordinator.is_some() && current == original),
        "NATIVE_STORE_WRITER_TARGET_CHANGED"
    );
    let verify = || -> Result<()> {
        ensure!(
            open_target(source, published, namespace, leaf)?.directory_identity()?
                == target.directory_identity()?
                && source.portable_regular_identity(OsStr::new(lock))? == *source_lock
                && target.portable_regular_identity(OsStr::new(lock))? == *target_lease.identity()
                && read(source, header, limit)? == original,
            "NATIVE_STORE_WRITER_PLACEMENT_CHANGED"
        );
        Ok(())
    };
    verify()?;
    ensure!(
        target.portable_regular_identity(OsStr::new(header))?
            == target.portable_regular_handle_identity(&header_anchor)?,
        "NATIVE_STORE_WRITER_TARGET_CHANGED"
    );
    if let Some(coordinator) = coordinator {
        if current != expected {
            assert_operation(coordinator, published)?;
            target.atomic_replace(OsStr::new(header), &expected)?;
        }
    }
    verify()?;
    ensure!(
        read(&target, header, limit)? == expected,
        "NATIVE_STORE_WRITER_TARGET_CHANGED"
    );
    Ok(())
}

fn open_target(
    source: &PrivateDirectory,
    published: &StoragePublishedComponent,
    namespace: &OsStr,
    leaf: &str,
) -> Result<PrivateDirectory> {
    published.verify()?;
    ensure!(
        published.domain() == kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN,
        "NATIVE_STORE_WRITER_PUBLICATION_CHANGED"
    );
    let root = PrivateDirectory::open_existing(published.source_path())?;
    ensure!(
        root.directory_identity()? == published.source_identity()
            && child(&root, namespace, leaf)?.directory_identity()?
                == source.directory_identity()?,
        "NATIVE_STORE_WRITER_SOURCE_CHANGED"
    );
    let target = child(published.directory(), namespace, leaf)?;
    ensure!(
        target.directory_identity()? != source.directory_identity()?,
        "NATIVE_STORE_WRITER_SAME_STORE"
    );
    Ok(target)
}

fn child(root: &PrivateDirectory, namespace: &OsStr, leaf: &str) -> Result<PrivateDirectory> {
    root.open_entry_handle(namespace)?
        .open_child_directory()?
        .open_entry_handle(OsStr::new(leaf))?
        .open_child_directory()
}

fn read(directory: &PrivateDirectory, name: &str, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    directory
        .open_single_link_regular_file(OsStr::new(name))?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= limit, "NATIVE_STORE_WRITER_HEADER_TOO_LARGE");
    Ok(bytes)
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
        .context("NATIVE_STORE_WRITER_PUBLICATION_CHANGED")?;
    ensure!(
        parts.next().is_none()
            && part.source == published.source_path()
            && part.destination == published.destination_path()
            && part.source_identity == published.source_identity(),
        "NATIVE_STORE_WRITER_PUBLICATION_CHANGED"
    );
    Ok(())
}
