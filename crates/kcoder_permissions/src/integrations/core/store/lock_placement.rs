//! A single current writer pin leaves the original signed genesis untouched.
use super::*;
use kcoder_config::storage::{StorageCoordinator, StoragePublishedComponent};

const FILE: &str = "issuer-lock-placement.json";
const MAX_BYTES: usize = 4096;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Placement {
    version: u32,
    binding_digest: String,
    lock_identity: PortableLeaseIdentity,
}

pub(super) struct Observed {
    anchor: File,
    bytes: Vec<u8>,
}

pub(super) fn observe(
    directory: &PrivateDirectory,
    binding: &Binding,
) -> Result<(PortableLeaseIdentity, Option<Observed>)> {
    let current = read(directory)?;
    let identity = match &current {
        Some(current) => {
            let placement: Placement = serde_json::from_slice(&current.bytes)
                .map_err(|_| anyhow::anyhow!("DELEGATION_LOCK_PLACEMENT_INVALID"))?;
            ensure!(
                placement.version == 1 && placement.binding_digest == binding_digest(binding)?,
                "DELEGATION_LOCK_PLACEMENT_INVALID"
            );
            placement.lock_identity
        }
        None => binding.lock_identity.clone(),
    };
    Ok((identity, current))
}

fn read(directory: &PrivateDirectory) -> Result<Option<Observed>> {
    let anchor = match directory.open_single_link_regular_file(OsStr::new(FILE)) {
        Ok(anchor) => anchor,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    (&anchor)
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= MAX_BYTES,
        "DELEGATION_LOCK_PLACEMENT_INVALID"
    );
    Ok(Some(Observed { anchor, bytes }))
}

pub(super) fn verify(directory: &PrivateDirectory, expected: Option<&Observed>) -> Result<()> {
    match (expected, read(directory)?) {
        (None, None) => Ok(()),
        (Some(expected), Some(current)) => {
            ensure!(
                current.bytes == expected.bytes
                    && directory.portable_regular_handle_identity(&current.anchor)?
                        == directory.portable_regular_handle_identity(&expected.anchor)?,
                "DELEGATION_LOCK_PLACEMENT_CHANGED"
            );
            Ok(())
        }
        _ => anyhow::bail!("DELEGATION_LOCK_PLACEMENT_CHANGED"),
    }
}

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

impl NativeDelegationAuthority {
    /// Only an original stopped publication may replace the current writer pin.
    /// Issuer/key/epoch, signed proofs, genesis and revocations remain unchanged.
    pub fn relocate_lock(
        &self,
        coordinator: &mut StorageCoordinator,
        published: &StoragePublishedComponent,
        namespace: &OsStr,
    ) -> Result<()> {
        self.lock_relocation(published, namespace, Some(coordinator))
    }

    /// Read-only reconciliation never adopts an unconverted or unknown lock.
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
        let target = self.relocation_target(published, namespace)?;
        let _source_lease = self.lock(PrivateLeaseMode::Exclusive)?;
        let target_identity = target.portable_regular_identity(OsStr::new(LOCK_FILE))?;
        let target_lease = target
            .try_existing_portable_lock(
                OsStr::new(LOCK_FILE),
                &target_identity,
                PrivateLeaseMode::Exclusive,
            )?
            .context("DELEGATION_AUTHORITY_BUSY")?;
        let expected = serde_json::to_vec(&Placement {
            version: 1,
            binding_digest: binding_digest(&self.binding)?,
            lock_identity: target_identity,
        })?;
        let current = read(&target)?;
        let current_bytes = current.as_ref().map(|current| current.bytes.as_slice());
        ensure!(
            current_bytes == Some(expected.as_slice())
                || (coordinator.is_some()
                    && current_bytes
                        == self
                            .lock_placement
                            .as_ref()
                            .map(|current| current.bytes.as_slice())),
            "DELEGATION_RELOCATION_TARGET_CHANGED"
        );
        let target_binding: Binding =
            serde_json::from_slice(&read_file(&target, BINDING_FILE, MAX_RECORD_BYTES)?)?;
        ensure!(
            target_binding == self.binding,
            "DELEGATION_RELOCATION_TARGET_CHANGED"
        );
        self.verify_storage()?;
        ensure!(
            self.relocation_target(published, namespace)?
                .directory_identity()?
                == target.directory_identity()?
                && target.portable_regular_identity(OsStr::new(LOCK_FILE))?
                    == *target_lease.identity(),
            "DELEGATION_RELOCATION_TARGET_CHANGED"
        );
        verify(&target, current.as_ref())?;
        if current_bytes != Some(expected.as_slice()) {
            assert_operation(
                coordinator
                    .as_deref_mut()
                    .context("DELEGATION_RELOCATION_READ_ONLY")?,
                published,
            )?;
            target.atomic_replace(OsStr::new(FILE), &expected)?;
        }
        ensure!(
            read(&target)?.is_some_and(|current| current.bytes == expected)
                && target.portable_regular_identity(OsStr::new(LOCK_FILE))?
                    == *target_lease.identity()
                && self
                    .relocation_target(published, namespace)?
                    .directory_identity()?
                    == target.directory_identity()?,
            "DELEGATION_RELOCATION_TARGET_CHANGED"
        );
        self.verify_storage()
    }

    fn relocation_target(
        &self,
        published: &StoragePublishedComponent,
        namespace: &OsStr,
    ) -> Result<PrivateDirectory> {
        published.verify()?;
        ensure!(
            published.domain() == kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN,
            "DELEGATION_RELOCATION_PUBLICATION_CHANGED"
        );
        let source = PrivateDirectory::open_existing(published.source_path())?;
        ensure!(
            source.directory_identity()? == published.source_identity()
                && source
                    .open_entry_handle(namespace)?
                    .open_child_directory()?
                    .open_entry_handle(OsStr::new("issuer"))?
                    .open_child_directory()?
                    .directory_identity()?
                    == self.directory.directory_identity()?,
            "DELEGATION_RELOCATION_SOURCE_CHANGED"
        );
        let target = published
            .directory()
            .open_entry_handle(namespace)?
            .open_child_directory()?
            .open_entry_handle(OsStr::new("issuer"))?
            .open_child_directory()?;
        ensure!(
            target.directory_identity()? != self.directory.directory_identity()?,
            "DELEGATION_RELOCATION_SAME_STORE"
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
        .context("DELEGATION_RELOCATION_PUBLICATION_CHANGED")?;
    ensure!(
        parts.next().is_none()
            && part.source == published.source_path()
            && part.destination == published.destination_path()
            && part.source_identity == published.source_identity(),
        "DELEGATION_RELOCATION_PUBLICATION_CHANGED"
    );
    Ok(())
}

#[cfg(test)]
mod tests;
