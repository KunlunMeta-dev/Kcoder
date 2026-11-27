//! Preserve copied epoch bytes; legacy relocation fields are read compatibility only.
use super::*;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RelocationReceipt {
    operation_id: String,
    logical_profile_seed: String,
    source_profile_identity: String,
    source_record_sha256: String,
    source_head_sha256: String,
}

pub(super) fn valid_version(header: &Header) -> bool {
    matches!(
        (header.version, &header.relocation),
        (1, None) | (2, Some(_))
    )
}

pub(super) fn verify_logical_binding(
    header: &Header,
    logical_profile: &ProfileIdentity,
) -> Result<()> {
    let derive = |domain| {
        kcoder_integration_storage::profile_resources::profile_resource_identity(
            domain,
            logical_profile.logical_seed(),
        )
    };
    ensure!(
        header.owner.account_id == derive("account-profile")
            && header.owner.target_id == derive("native-target"),
        "INTEGRATION_IDENTITY_BINDING_CHANGED"
    );
    if let Some(receipt) = &header.relocation {
        validate_operation(&receipt.operation_id)?;
        ensure!(
            receipt.logical_profile_seed == logical_profile.logical_seed()
                && receipt.source_profile_identity != header.profile_identity
                && [&receipt.source_record_sha256, &receipt.source_head_sha256]
                    .into_iter()
                    .all(|value| value.len() == 64
                        && value.bytes().all(|byte| byte.is_ascii_hexdigit())),
            "INTEGRATION_IDENTITY_RELOCATION_BINDING_CHANGED"
        );
    }
    Ok(())
}

pub(super) fn verify_relocated_from(
    source: &NativeIdentity,
    target: &NativeIdentity,
    source_profile_identity: &str,
    operation_id: &str,
) -> Result<()> {
    validate_operation(operation_id)?;
    ensure!(
        source.binding.profile_identity == source_profile_identity
            && source.logical_profile.logical_seed() == target.logical_profile.logical_seed()
            && source.header == target.header
            && read_anchored_bytes(&source.record_anchor)?
                == read_anchored_bytes(&target.record_anchor)?
            && read_anchored_bytes(&source.head_anchor)?
                == read_anchored_bytes(&target.head_anchor)?,
        "INTEGRATION_IDENTITY_RELOCATION_TARGET_CHANGED"
    );
    Ok(())
}

impl NativeIdentity {
    /// After confirmed complete exit, bind only the copied lock's current
    /// placement. The existing coordinator owns publication and operation receipts.
    pub fn relocate(
        &self,
        source_profile: &PrivateDirectory,
        final_target_profile: &PrivateDirectory,
        source_scope: &IntegrationScope,
        operation_id: &str,
        expected_snapshot: &NativeIdentitySnapshot,
    ) -> Result<Self> {
        validate_global_scope(source_scope)?;
        validate_operation(operation_id)?;
        ensure!(
            IntegrationOwner::from(source_scope) == self.header.owner
                && source_scope.identity_generation == expected_snapshot.generation,
            "INTEGRATION_IDENTITY_RELOCATION_SCOPE_MISMATCH"
        );
        let source_directory = self.verify_binding(source_profile)?;
        let _source_lease = source_directory
            .try_existing_portable_lock(
                OsStr::new(LOCK),
                &self.binding.lock_identity,
                PrivateLeaseMode::Exclusive,
            )?
            .context("INTEGRATION_IDENTITY_BUSY")?;
        self.verify_binding(source_profile)?;
        ensure!(
            self.read_snapshot_epoch()?.snapshot() == *expected_snapshot,
            "INTEGRATION_IDENTITY_RELOCATION_REVISION_CONFLICT"
        );
        // This creates the legacy logical seed once; subsequent moves copy it
        // unchanged. It neither grants authorization nor substitutes an epoch.
        self.logical_profile
            .relocate(source_profile, final_target_profile, operation_id)?;
        let target_guard =
            NativeDomainGuard::observe(final_target_profile, source_scope, NativeDomain::Identity)?
                .context("INTEGRATION_IDENTITY_RELOCATION_UNCONFIRMED")?;
        let target_directory = target_guard.directory(final_target_profile)?;
        let target_lock = target_directory.open_single_link_regular_file(OsStr::new(LOCK))?;
        let target_lock_identity =
            target_directory.portable_regular_handle_identity(&target_lock)?;
        let target_lease = target_directory
            .try_existing_portable_lock(
                OsStr::new(LOCK),
                &target_lock_identity,
                PrivateLeaseMode::Exclusive,
            )?
            .context("INTEGRATION_IDENTITY_BUSY")?;
        let target_record = target_directory.open_single_link_regular_file(OsStr::new(RECORD))?;
        let target_head = target_directory.open_single_link_regular_file(OsStr::new(HEAD))?;
        let source_record = read_anchored_bytes(&self.record_anchor)?;
        let source_head = read_anchored_bytes(&self.head_anchor)?;
        let expected = serde_json::to_vec(&LockPlacement {
            version: 1,
            header_digest: hash(&self.header)?,
            lock_identity: target_lock_identity,
        })?;
        ensure!(
            expected.len() <= MAX_LOCK_PLACEMENT_BYTES as usize,
            "INTEGRATION_IDENTITY_LOCK_PLACEMENT_INVALID"
        );
        let current = read_lock_placement(&target_directory)?;
        let current_bytes = current.as_ref().map(|placement| placement.bytes.as_slice());
        ensure!(
            current_bytes == Some(expected.as_slice())
                || current_bytes
                    == self
                        .lock_placement
                        .as_ref()
                        .map(|placement| placement.bytes.as_slice()),
            "INTEGRATION_IDENTITY_LOCK_PLACEMENT_CONFLICT"
        );
        let verify_target = || -> Result<()> {
            ensure!(
                target_guard
                    .directory(final_target_profile)?
                    .directory_identity()?
                    == target_directory.directory_identity()?
                    && read_anchored_bytes(&target_record)? == source_record
                    && read_anchored_bytes(&target_head)? == source_head,
                "INTEGRATION_IDENTITY_RELOCATION_TARGET_CHANGED"
            );
            for (name, anchor) in [
                (RECORD, &target_record),
                (HEAD, &target_head),
                (LOCK, &target_lock),
            ] {
                ensure!(
                    target_directory.portable_regular_identity(OsStr::new(name))?
                        == target_directory.portable_regular_handle_identity(anchor)?,
                    "INTEGRATION_IDENTITY_RELOCATION_TARGET_CHANGED"
                );
            }
            Ok(())
        };
        verify_target()?;
        self.verify_binding(source_profile)?;
        ensure!(
            self.read_snapshot_epoch()?.snapshot() == *expected_snapshot
                && read_anchored_bytes(&self.record_anchor)? == source_record
                && read_anchored_bytes(&self.head_anchor)? == source_head,
            "INTEGRATION_IDENTITY_RELOCATION_REVISION_CONFLICT"
        );
        verify_lock_placement(&target_directory, current.as_ref())?;
        if current_bytes != Some(expected.as_slice()) {
            target_directory.atomic_replace(OsStr::new(LOCK_PLACEMENT), &expected)?;
        }
        verify_target()?;
        ensure!(
            read_lock_placement(&target_directory)?
                .is_some_and(|placement| placement.bytes == expected),
            "INTEGRATION_IDENTITY_RELOCATION_UNCONFIRMED"
        );
        drop(target_lease);
        let target = NativeIdentity::observe(final_target_profile, source_scope)?
            .context("INTEGRATION_IDENTITY_RELOCATION_UNCONFIRMED")?;
        let _target_lease = target
            .directory
            .try_existing_portable_lock(
                OsStr::new(LOCK),
                &target.binding.lock_identity,
                PrivateLeaseMode::Exclusive,
            )?
            .context("INTEGRATION_IDENTITY_BUSY")?;
        target.verify_binding(final_target_profile)?;
        verify_relocated_from(self, &target, &self.binding.profile_identity, operation_id)?;
        ensure!(
            target.read_snapshot_epoch()?.snapshot() == *expected_snapshot
                && self.read_snapshot_epoch()?.snapshot() == *expected_snapshot,
            "INTEGRATION_IDENTITY_RELOCATION_REVISION_CONFLICT"
        );
        self.verify_binding(source_profile)?;
        #[cfg(test)]
        if self
            .lose_relocation_ack
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            anyhow::bail!("INTEGRATION_IDENTITY_RELOCATION_UNCONFIRMED");
        }
        Ok(target)
    }
}

#[cfg(test)]
#[path = "relocation/tests.rs"]
mod tests;
