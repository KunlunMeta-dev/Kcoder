//! A domain owner may reissue only its own physical namespace binding.
use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RelocationReceipt {
    operation_id: String,
    source_profile_identity: String,
    source_marker_identity: PortableLeaseIdentity,
    source_directory_identity: String,
    source_control_sha256: String,
    target_profile_identity: String,
}

pub(super) fn valid_version(initialization: &Initialization) -> bool {
    matches!(
        (initialization.version, &initialization.relocation),
        (1, None) | (2, Some(_))
    )
}

pub(super) fn validate_history(initialization: &Initialization) -> Result<()> {
    ensure!(
        valid_version(initialization),
        "INTEGRATION_STORAGE_OWNER_MISMATCH"
    );
    if let Some(receipt) = &initialization.relocation {
        validate_operation(&receipt.operation_id)?;
        ensure!(
            !receipt.source_profile_identity.is_empty()
                && !receipt.target_profile_identity.is_empty()
                && receipt.source_profile_identity != receipt.target_profile_identity
                && receipt.source_control_sha256.len() == 64
                && receipt
                    .source_control_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit()),
            "INTEGRATION_STORAGE_RELOCATION_BINDING_CHANGED"
        );
    }
    Ok(())
}

/// Compatibility transaction for owners which still use a marker receipt as
/// their commit witness. Ordinary cold opens never need to rewrite the marker.
/// Keeps both original marker leases and the actual final directory handles.
/// Shutdown and business-data conversion remain the caller's responsibilities.
pub struct DomainStorageRelocation<'a> {
    source: &'a DomainStorageGuard,
    source_profile: &'a PrivateDirectory,
    target_profile: &'a PrivateDirectory,
    source_directory: PrivateDirectory,
    target_directory: PrivateDirectory,
    source_control: Vec<u8>,
    target_control: Vec<u8>,
    target_marker_identity: PortableLeaseIdentity,
    receipt: RelocationReceipt,
    committed: Option<DomainStorageGuard>,
    source_lease: PrivateFileLock,
    target_lease: PrivateFileLock,
}

impl DomainStorageGuard {
    /// Compatibility entry for owners whose commit protocol still uses the
    /// marker receipt. It is not required to reopen a copied domain.
    /// Only the already verified domain owner may prepare a stopped relocation.
    /// The target namespace must have been published at its final location, with
    /// an exact source control copy or this operation's committed owner receipt.
    pub fn prepare_relocation<'a>(
        &'a self,
        source_profile: &'a PrivateDirectory,
        final_target_profile: &'a PrivateDirectory,
        operation_id: &str,
    ) -> Result<DomainStorageRelocation<'a>> {
        validate_operation(operation_id)?;
        self.directory(source_profile)?;
        final_target_profile.verify_config_root_directory()?;
        let source_profile_identity = source_profile.directory_identity()?;
        let target_profile_identity = final_target_profile.directory_identity()?;
        ensure!(
            source_profile_identity != target_profile_identity,
            "INTEGRATION_STORAGE_RELOCATION_SAME_ROOT"
        );
        let source_lease = hold_marker(&self.marker_anchor)?;
        let source_directory = self.directory(source_profile)?;
        let source_control = read_control_bytes(source_lease.file())?;
        let target_marker =
            final_target_profile.open_single_link_regular_file(OsStr::new(&self.marker_name))?;
        let target_marker_identity =
            PortableLeaseIdentity::from_private_regular_handle(&target_marker)?;
        let target_lease = hold_marker(&target_marker)?;
        let target_control = read_control_bytes(target_lease.file())?;
        let target_directory =
            final_target_profile.open_child(OsStr::new(self.namespace_id()), false)?;
        target_directory.verify_private_directory()?;
        let receipt = RelocationReceipt {
            operation_id: operation_id.into(),
            source_profile_identity,
            source_marker_identity: self.marker_identity.clone(),
            source_directory_identity: source_directory.directory_identity()?,
            source_control_sha256: digest(&source_control),
            target_profile_identity,
        };
        let committed = if target_control == source_control {
            None
        } else {
            let (initialization, ready) = parse_control(&target_control)?;
            validate_history(&initialization)?;
            ensure!(
                initialization.owner == self.initialization.owner
                    && initialization.domain == self.initialization.domain
                    && initialization.operation_id == self.initialization.operation_id
                    && initialization.directory_name == self.initialization.directory_name
                    && initialization.marker_identity == target_marker_identity
                    && initialization.relocation.as_ref() == Some(&receipt)
                    && ready.directory_identity == target_directory.directory_identity()?,
                "INTEGRATION_STORAGE_RELOCATION_CONFLICT"
            );
            Some(DomainStorageGuard {
                initialization,
                ready,
                control_bytes: target_control.clone().into_boxed_slice(),
                marker_name: self.marker_name.clone(),
                marker_identity: target_marker_identity.clone(),
                marker_anchor: target_marker,
                profile_identity: final_target_profile.directory_identity()?,
                directory: target_directory.duplicate_handle()?,
            })
        };
        let transaction = DomainStorageRelocation {
            source: self,
            source_profile,
            target_profile: final_target_profile,
            source_directory,
            target_directory,
            source_control,
            target_control,
            target_marker_identity,
            receipt,
            committed,
            source_lease,
            target_lease,
        };
        transaction.verify()?;
        Ok(transaction)
    }
}

impl DomainStorageRelocation<'_> {
    pub fn source_directory(&self) -> &PrivateDirectory {
        &self.source_directory
    }

    pub fn target_directory(&self) -> &PrivateDirectory {
        &self.target_directory
    }

    pub fn is_committed(&self) -> bool {
        self.committed.is_some()
    }

    pub fn verify(&self) -> Result<()> {
        ensure!(
            self.source_profile.directory_identity()? == self.receipt.source_profile_identity
                && self.target_profile.directory_identity()?
                    == self.receipt.target_profile_identity
                && self
                    .source
                    .directory(self.source_profile)?
                    .directory_identity()?
                    == self.source_directory.directory_identity()?
                && read_control_bytes(self.source_lease.file())? == self.source_control,
            "INTEGRATION_STORAGE_RELOCATION_SOURCE_CHANGED"
        );
        let marker = self
            .target_profile
            .open_single_link_regular_file(OsStr::new(&self.source.marker_name))?;
        ensure!(
            PortableLeaseIdentity::from_private_regular_handle(&marker)?
                == self.target_marker_identity
                && PortableLeaseIdentity::from_private_regular_handle(self.target_lease.file())?
                    == self.target_marker_identity
                && read_control_bytes(self.target_lease.file())? == self.target_control
                && self
                    .target_profile
                    .open_child(OsStr::new(self.source.namespace_id()), false)?
                    .directory_identity()?
                    == self.target_directory.directory_identity()?,
            "INTEGRATION_STORAGE_RELOCATION_TARGET_CHANGED"
        );
        self.target_directory.verify_private_directory()?;
        Ok(())
    }

    /// Publish only after the owning store validates its final data and physical
    /// bindings. A committed replay invokes validation but never reissues a marker.
    pub fn commit(
        mut self,
        verify_owner: impl FnOnce(&PrivateDirectory, &PrivateDirectory) -> Result<()>,
    ) -> Result<DomainStorageGuard> {
        self.verify()?;
        verify_owner(&self.source_directory, &self.target_directory)?;
        self.verify()?;
        if let Some(guard) = self.committed.take() {
            guard.directory(self.target_profile)?;
            return Ok(guard);
        }
        let temporary = format!(
            ".integration-relocation-{}.prepared",
            digest(&serde_json::to_vec(&(
                &self.source.marker_name,
                &self.receipt
            ))?)
        );
        let temporary = OsStr::new(&temporary);
        let marker = match self.target_profile.open_read_write_file(temporary, true) {
            Ok(mut marker) => {
                let mut initialization = self.source.initialization.clone();
                initialization.version = 2;
                initialization.marker_identity =
                    PortableLeaseIdentity::from_private_regular_handle(&marker)?;
                initialization.relocation = Some(self.receipt.clone());
                let ready = Ready {
                    directory_identity: self.target_directory.directory_identity()?,
                };
                serde_json::to_writer(&mut marker, &initialization)?;
                marker.write_all(b"\n")?;
                serde_json::to_writer(&mut marker, &ready)?;
                marker.write_all(b"\n")?;
                marker.sync_all()?;
                marker
            }
            Err(error) if exists(&error) => {
                self.target_profile.open_read_write_file(temporary, false)?
            }
            Err(error) => return Err(error),
        };
        let control = read_control_bytes(
            &self
                .target_profile
                .open_single_link_regular_file(temporary)?,
        )?;
        let (initialization, ready) = parse_control(&control)?;
        validate_history(&initialization)?;
        let marker_identity = PortableLeaseIdentity::from_private_regular_handle(&marker)?;
        ensure!(
            initialization.owner == self.source.initialization.owner
                && initialization.domain == self.source.initialization.domain
                && initialization.operation_id == self.source.initialization.operation_id
                && initialization.directory_name == self.source.initialization.directory_name
                && initialization.marker_identity == marker_identity
                && initialization.relocation.as_ref() == Some(&self.receipt)
                && ready.directory_identity == self.target_directory.directory_identity()?,
            "INTEGRATION_STORAGE_RELOCATION_CONFLICT"
        );
        self.verify()?;
        self.target_profile.publish_prepared(
            temporary,
            OsStr::new(&self.source.marker_name),
            &PrivateDirectory::identity_of_file(&marker)?,
        )?;
        let guard = DomainStorageGuard {
            initialization,
            ready,
            control_bytes: control.into_boxed_slice(),
            marker_name: self.source.marker_name.clone(),
            marker_identity,
            marker_anchor: marker,
            profile_identity: self.target_profile.directory_identity()?,
            directory: self.target_directory.duplicate_handle()?,
        };
        guard.directory(self.target_profile)?;
        self.source.directory(self.source_profile)?;
        Ok(guard)
    }
}

fn hold_marker(marker: &File) -> Result<PrivateFileLock> {
    // Duplicate the original file object, so domain callbacks can still read
    // its locked bytes on Windows. Never drop either lease for an observation.
    let file = marker.try_clone()?;
    FileExt::try_lock_exclusive(&file).context("INTEGRATION_STORAGE_BUSY")?;
    Ok(PrivateFileLock::from_locked(file))
}

fn validate_operation(value: &str) -> Result<()> {
    ensure!(
        !value.trim().is_empty() && value.chars().count() <= 256,
        "INTEGRATION_STORAGE_INVALID_OPERATION"
    );
    Ok(())
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn exists(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::AlreadyExists)
}

#[cfg(test)]
#[path = "relocation/tests.rs"]
mod tests;
