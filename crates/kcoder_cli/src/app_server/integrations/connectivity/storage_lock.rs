//! Current unsigned lock pins for the two existing task-source metadata owners.
//! The ordinary readers retain their cold pins; Accepted records and receipts are
//! copied unchanged. Only the original stopped publication can replace a pin.
use anyhow::{Context, Result, ensure};
use kcoder_config::{
    PortableLeaseIdentity, PrivateDirectory, PrivateLeaseMode,
    storage::{StorageCoordinator, StoragePublishedComponent},
};
use kcoder_native_scope::NativeDomain;
use kcoder_types::integrations::core::IntegrationScope;
use std::{ffi::OsStr, fs::File, io::Read};

type DecodePin = fn(&[u8], &IntegrationScope) -> Result<PortableLeaseIdentity>;

fn owner(domain: NativeDomain) -> Result<(&'static str, &'static str, u64, DecodePin)> {
    match domain {
        NativeDomain::ConnectivitySources => Ok((
            "native-sources.json",
            "native-sources.lock",
            2 * 1024 * 1024,
            super::native_sources::storage_lock_pin,
        )),
        NativeDomain::ConnectivityTaskCapabilityScope => Ok((
            "task-sources-owner.json",
            "task-sources.lock",
            512 * 1024,
            super::native_task_capability_scope::storage_lock_pin,
        )),
        _ => anyhow::bail!("STORAGE_TASK_METADATA_DOMAIN_INVALID"),
    }
}

fn read(directory: &PrivateDirectory, name: &str, limit: u64) -> Result<Vec<u8>> {
    let mut file = directory.open_single_link_regular_file(OsStr::new(name))?;
    let identity = PrivateDirectory::identity_of_file(&file)?;
    let mut bytes = Vec::new();
    (&mut file).take(limit + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= limit
            && directory.regular_file_identity(OsStr::new(name))? == identity,
        "STORAGE_TASK_METADATA_CHANGED"
    );
    Ok(bytes)
}

fn verify_lock(directory: &PrivateDirectory, name: &str, file: &File) -> Result<()> {
    ensure!(
        directory.portable_regular_identity(OsStr::new(name))?
            == directory.portable_regular_handle_identity(file)?,
        "STORAGE_TASK_METADATA_LOCK_CHANGED"
    );
    Ok(())
}

pub(crate) fn preview(
    directory: &PrivateDirectory,
    scope: &IntegrationScope,
    domain: NativeDomain,
) -> Result<()> {
    let (record, lock, limit, decode) = owner(domain)?;
    let bytes = read(directory, record, limit)?;
    let pin = decode(&bytes, scope)?;
    let lease = directory
        .try_existing_portable_lock(OsStr::new(lock), &pin, PrivateLeaseMode::Shared)?
        .context("STORAGE_TASK_METADATA_BUSY")?;
    if domain == NativeDomain::ConnectivityTaskCapabilityScope {
        super::native_task_capability_scope::validate_storage_index(directory)?;
    }
    ensure!(
        read(directory, record, limit)? == bytes,
        "STORAGE_TASK_METADATA_CHANGED"
    );
    verify_lock(directory, lock, lease.file())
}

/// `None` is the existing read-only verifier: it never acquires the parent's
/// coordinator or writes metadata. Neither mode scans unchanged binding files.
pub(crate) fn relocate_or_verify(
    mut coordinator: Option<&mut StorageCoordinator>,
    published: &StoragePublishedComponent,
    namespace: &OsStr,
    scope: &IntegrationScope,
    domain: NativeDomain,
) -> Result<()> {
    published.verify()?;
    ensure!(
        published.domain() == kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN,
        "STORAGE_TASK_METADATA_PUBLICATION_CHANGED"
    );
    if let Some(coordinator) = coordinator.as_deref_mut() {
        assert_publication(coordinator, published)?;
    }
    let original_root = PrivateDirectory::open_existing(published.source_path())?;
    ensure!(
        original_root.directory_identity()? == published.source_identity(),
        "STORAGE_SOURCE_CHANGED"
    );
    let source = original_root.open_child(namespace, false)?;
    let target = published.directory().open_child(namespace, false)?;
    ensure!(
        source.directory_identity()? != target.directory_identity()?,
        "STORAGE_TASK_METADATA_SAME_STORE"
    );
    let (record, lock, limit, decode) = owner(domain)?;
    let original = read(&source, record, limit)?;
    let source_pin = decode(&original, scope)?;
    let source_lease = source
        .try_existing_portable_lock(OsStr::new(lock), &source_pin, PrivateLeaseMode::Exclusive)?
        .context("STORAGE_TASK_METADATA_BUSY")?;
    let target_pin = target.portable_regular_identity(OsStr::new(lock))?;
    let target_lease = target
        .try_existing_portable_lock(OsStr::new(lock), &target_pin, PrivateLeaseMode::Exclusive)?
        .context("STORAGE_TASK_METADATA_BUSY")?;
    let mut expected: serde_json::Value = serde_json::from_slice(&original)?;
    *expected
        .get_mut("lockIdentity")
        .context("STORAGE_TASK_METADATA_INVALID")? = serde_json::to_value(&target_pin)?;
    let expected = serde_json::to_vec(&expected)?;
    ensure!(
        decode(&expected, scope)? == target_pin,
        "STORAGE_TASK_METADATA_INVALID"
    );
    let observed = read(&target, record, limit)?;
    ensure!(
        observed == expected || coordinator.is_some() && observed == original,
        "STORAGE_TASK_METADATA_TARGET_CHANGED"
    );
    if let Some(coordinator) = coordinator.as_deref_mut() {
        assert_publication(coordinator, published)?;
        published.verify()?;
        verify_lock(&source, lock, source_lease.file())?;
        verify_lock(&target, lock, target_lease.file())?;
        ensure!(
            read(&source, record, limit)? == original && read(&target, record, limit)? == observed,
            "STORAGE_TASK_METADATA_CHANGED"
        );
        if observed != expected {
            target.atomic_replace(OsStr::new(record), &expected)?;
        }
    }
    ensure!(
        read(&source, record, limit)? == original && read(&target, record, limit)? == expected,
        "STORAGE_TASK_METADATA_CHANGED"
    );
    verify_lock(&source, lock, source_lease.file())?;
    verify_lock(&target, lock, target_lease.file())?;
    ensure!(
        original_root
            .open_child(namespace, false)?
            .directory_identity()?
            == source.directory_identity()?
            && published
                .directory()
                .open_child(namespace, false)?
                .directory_identity()?
                == target.directory_identity()?,
        "STORAGE_TASK_METADATA_CHANGED"
    );
    published.verify()
}

fn assert_publication(
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
        .context("STORAGE_TASK_METADATA_PUBLICATION_CHANGED")?;
    ensure!(
        components.next().is_none()
            && component.source == published.source_path()
            && component.destination == published.destination_path()
            && component.source_identity == published.source_identity(),
        "STORAGE_TASK_METADATA_PUBLICATION_CHANGED"
    );
    Ok(())
}
