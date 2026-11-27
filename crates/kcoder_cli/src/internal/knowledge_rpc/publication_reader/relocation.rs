//! Final publication bindings are issued only by the stopped data owner.
use super::{BINDING, Binding, DB, LOCK, PublicationAnchors, read_binding};
use anyhow::{Context, Result, ensure};
use kcoder_config::{
    PrivateDirectory, PrivateLeaseMode, SqliteSourceReadLease, VerifiedPrivateLease,
    profile_identity::ProfileIdentity,
};
use kcoder_knowledge::relocation::{
    KnowledgeCatalogRelocationPreview, KnowledgeCatalogRelocationSnapshot, KnowledgeRelocationKind,
    KnowledgeRelocationLimits, knowledge_catalog_relocation_preview,
    knowledge_catalog_relocation_snapshot_from_source,
};
use kcoder_native_scope::{
    NativeDomain, NativeDomainGuard, NativeIdentity, NativeIdentitySnapshot,
    NativeIntegrationContext,
};
use kcoder_types::integrations::{core::IntegrationScope, knowledge::KnowledgeOwner};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicationRelocationSnapshot {
    profile_identity: String,
    logical_profile_seed: String,
    owner: KnowledgeOwner,
    binding_sha256: String,
    identity_generation: String,
    identity_revision: u64,
    identity_enabled: bool,
    pub catalog: KnowledgeCatalogRelocationSnapshot,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicationRelocationReceipt {
    operation_id: String,
    source: PublicationRelocationSnapshot,
}

pub(super) fn verify_profile_binding(binding: &Binding, profile: &PrivateDirectory) -> Result<()> {
    match (binding.version, &binding.relocation) {
        (1, None) => Ok(()),
        (2, Some(receipt)) => {
            let logical = ProfileIdentity::observe(profile)?;
            ensure!(
                valid_operation(&receipt.operation_id)
                    && receipt.source.logical_profile_seed == logical.logical_seed()
                    && receipt.source.catalog.directory_identity != binding.namespace_identity
                    && receipt.source.owner == binding.owner
                    && sha(&receipt.source.binding_sha256)
                    && sha(&receipt.source.catalog.content_sha256)
                    && receipt.source.identity_revision > 0,
                "KNOWLEDGE_NATIVE_RELOCATION_BINDING_CHANGED"
            );
            logical.verify(profile)
        }
        _ => anyhow::bail!("KNOWLEDGE_NATIVE_BINDING_VERSION_UNSUPPORTED"),
    }
}

pub struct NativePublicationRelocation {
    profile_path: PathBuf,
    profile: PrivateDirectory,
    logical: ProfileIdentity,
    identity: NativeIdentity,
    scope: IntegrationScope,
    guard: NativeDomainGuard,
    directory: PrivateDirectory,
    binding: Binding,
    anchors: PublicationAnchors,
    limits: KnowledgeRelocationLimits,
}
/// Holds the original publication writer gate and SQLite native writer exclusion.
pub struct PreparedNativePublicationRelocation<'a> {
    owner: &'a NativePublicationRelocation,
    source: SqliteSourceReadLease,
    _namespace_lease: VerifiedPrivateLease,
}
impl PreparedNativePublicationRelocation<'_> {
    pub fn relocation_snapshot(&self) -> Result<PublicationRelocationSnapshot> {
        self.owner.snapshot_locked(&self.source)
    }
    pub fn relocate(
        self,
        final_target_profile: &Path,
        operation_id: &str,
        expected: &PublicationRelocationSnapshot,
    ) -> Result<()> {
        self.owner.relocation_target(
            final_target_profile,
            operation_id,
            expected,
            true,
            &self.source,
        )
    }
}
impl NativePublicationRelocation {
    /// Scope selects an already existing data owner. This does not initialize
    /// an absent identity, accept business, or reactivate a disabled epoch.
    pub fn observe(
        profile_path: &Path,
        scope: &IntegrationScope,
        limits: KnowledgeRelocationLimits,
    ) -> Result<Option<Self>> {
        scope.validate()?;
        let profile_path = profile_path.canonicalize()?;
        let profile = PrivateDirectory::open_existing(&profile_path)?;
        let logical = ProfileIdentity::observe(&profile)?;
        let (global, identity, snapshot) =
            NativeIntegrationContext::observe_global_profile(&profile, &scope.target_revision)?
                .context("KNOWLEDGE_NATIVE_IDENTITY_REQUIRED")?;
        ensure!(
            global.account_id == scope.account_id
                && global.target_id == scope.target_id
                && snapshot.generation == scope.identity_generation,
            "KNOWLEDGE_NATIVE_RELOCATION_OWNER_MISMATCH"
        );
        let Some(guard) = NativeDomainGuard::observe(&profile, scope, NativeDomain::Knowledge)?
        else {
            return Ok(None);
        };
        let directory = guard.directory(&profile)?;
        let binding = read_binding(&directory)?;
        let anchors = PublicationAnchors::observe(&directory, &binding)?;
        let result = Self {
            profile_path,
            profile,
            logical,
            identity,
            scope: scope.clone(),
            guard,
            directory,
            binding,
            anchors,
            limits,
        };
        result.verify_source()?;
        Ok(Some(result))
    }

    pub fn relocation_snapshot(&self) -> Result<PublicationRelocationSnapshot> {
        self.verify_source()?;
        let _lease = self
            .directory
            .try_existing_portable_lock(
                OsStr::new(LOCK),
                &self.binding.lock_identity,
                PrivateLeaseMode::Shared,
            )?
            .context("KNOWLEDGE_NATIVE_BUSY")?;
        let source = self.acquire_sqlite_source()?;
        self.snapshot_locked(&source)
    }

    pub fn prepare_relocation(&self) -> Result<PreparedNativePublicationRelocation<'_>> {
        self.verify_source()?;
        let namespace_lease = self
            .directory
            .try_existing_portable_lock(
                OsStr::new(LOCK),
                &self.binding.lock_identity,
                PrivateLeaseMode::Exclusive,
            )?
            .context("KNOWLEDGE_NATIVE_BUSY")?;
        let source = self.acquire_sqlite_source()?;
        Ok(PreparedNativePublicationRelocation {
            owner: self,
            source,
            _namespace_lease: namespace_lease,
        })
    }

    fn acquire_sqlite_source(&self) -> Result<SqliteSourceReadLease> {
        self.directory
            .try_sqlite_source_read_lease(OsStr::new(DB), self.limits.bytes)?
            .context("KNOWLEDGE_NATIVE_BUSY")
    }

    pub fn preview_relocation(&self) -> Result<KnowledgeCatalogRelocationPreview> {
        self.verify_source()?;
        let _lease = self
            .directory
            .try_existing_portable_lock(
                OsStr::new(LOCK),
                &self.binding.lock_identity,
                PrivateLeaseMode::Shared,
            )?
            .context("KNOWLEDGE_NATIVE_BUSY")?;
        knowledge_catalog_relocation_preview(
            &self.directory,
            KnowledgeRelocationKind::Publications,
            self.limits,
        )
    }

    pub fn relocate(
        &self,
        final_target_profile: &Path,
        operation_id: &str,
        expected: &PublicationRelocationSnapshot,
    ) -> Result<()> {
        self.prepare_relocation()?
            .relocate(final_target_profile, operation_id, expected)
    }

    pub fn verify_relocation(
        &self,
        final_target_profile: &Path,
        operation_id: &str,
        expected: &PublicationRelocationSnapshot,
    ) -> Result<()> {
        let prepared = self.prepare_relocation()?;
        self.relocation_target(
            final_target_profile,
            operation_id,
            expected,
            false,
            &prepared.source,
        )
    }

    fn verify_source(&self) -> Result<()> {
        self.logical.verify(&self.profile)?;
        ensure!(
            PrivateDirectory::open_existing(&self.profile_path)?.directory_identity()?
                == self.profile.directory_identity()?,
            "KNOWLEDGE_NATIVE_RELOCATION_SOURCE_CHANGED"
        );
        self.binding.verify_profile_binding(&self.profile)?;
        self.anchors
            .verify(&self.guard.directory(&self.profile)?, &self.binding)?;
        ensure!(
            self.binding.owner == KnowledgeOwner::from(&self.scope)
                && read_binding(&self.directory)? == self.binding,
            "KNOWLEDGE_NATIVE_RELOCATION_SOURCE_CHANGED"
        );
        self.identity.snapshot(&self.profile)?;
        Ok(())
    }

    fn snapshot_locked(
        &self,
        source: &SqliteSourceReadLease,
    ) -> Result<PublicationRelocationSnapshot> {
        self.verify_source()?;
        source.verify()?;
        let identity = self.identity.snapshot(&self.profile)?;
        let catalog = knowledge_catalog_relocation_snapshot_from_source(
            &self.directory,
            KnowledgeRelocationKind::Publications,
            self.limits,
            source,
        )?;
        let snapshot = PublicationRelocationSnapshot {
            profile_identity: self.profile.directory_identity()?,
            logical_profile_seed: self.logical.logical_seed().into(),
            owner: self.binding.owner.clone(),
            binding_sha256: digest(&read_bytes(
                &self
                    .directory
                    .open_single_link_regular_file(OsStr::new(BINDING))?,
            )?),
            identity_generation: identity.generation.clone(),
            identity_revision: identity.revision,
            identity_enabled: identity.enabled,
            catalog,
        };
        self.verify_source()?;
        source.verify()?;
        ensure!(
            self.identity.snapshot(&self.profile)? == identity,
            "KNOWLEDGE_NATIVE_RELOCATION_IDENTITY_CHANGED"
        );
        Ok(snapshot)
    }

    fn relocation_target(
        &self,
        target_path: &Path,
        operation_id: &str,
        expected: &PublicationRelocationSnapshot,
        publish: bool,
        source: &SqliteSourceReadLease,
    ) -> Result<()> {
        ensure!(
            valid_operation(operation_id),
            "KNOWLEDGE_NATIVE_RELOCATION_INVALID_OPERATION"
        );
        ensure!(
            self.snapshot_locked(source)? == *expected,
            "KNOWLEDGE_NATIVE_RELOCATION_SOURCE_CHANGED"
        );
        let target_path = target_path.canonicalize()?;
        let target_profile = PrivateDirectory::open_existing(&target_path)?;
        let logical =
            self.logical
                .verify_relocation(&self.profile, &target_profile, operation_id)?;
        let expected_identity = NativeIdentitySnapshot {
            generation: expected.identity_generation.clone(),
            revision: expected.identity_revision,
            enabled: expected.identity_enabled,
        };
        verify_target_identity(&target_profile, &self.scope, &expected_identity)?;
        let transaction =
            self.guard
                .prepare_relocation(&self.profile, &target_profile, operation_id)?;
        let target = transaction.target_directory();
        let lock = target.portable_regular_identity(OsStr::new(LOCK))?;
        let _target_lease = target
            .try_existing_portable_lock(OsStr::new(LOCK), &lock, PrivateLeaseMode::Exclusive)?
            .context("KNOWLEDGE_NATIVE_BUSY")?;
        let original_anchor = target.open_single_link_regular_file(OsStr::new(BINDING))?;
        let original = read_bytes(&original_anchor)?;
        // Only the real writer lock needs a new placement pin. Historical
        // catalog fields and old compatibility receipts are copied unchanged.
        let mut binding = self.binding.clone();
        binding.lock_identity = lock;
        let committed =
            serde_json::from_slice::<Binding>(&original).is_ok_and(|current| current == binding);
        ensure!(
            committed || digest(&original) == expected.binding_sha256,
            "KNOWLEDGE_NATIVE_RELOCATION_CONFLICT"
        );
        ensure!(
            publish || committed && transaction.is_committed(),
            "KNOWLEDGE_NATIVE_RELOCATION_UNCONFIRMED"
        );
        let target_source = target
            .try_sqlite_source_read_lease(OsStr::new(DB), self.limits.bytes)?
            .context("KNOWLEDGE_NATIVE_BUSY")?;
        let target_catalog = knowledge_catalog_relocation_snapshot_from_source(
            target,
            KnowledgeRelocationKind::Publications,
            self.limits,
            &target_source,
        )?;
        ensure!(
            target_catalog.same_content(&expected.catalog)
                && target_catalog.directory_identity != expected.catalog.directory_identity
                && target_catalog.database_identity != expected.catalog.database_identity
                && target_catalog.objects_identity != expected.catalog.objects_identity,
            "KNOWLEDGE_NATIVE_RELOCATION_DATA_CHANGED"
        );
        let verify = || -> Result<()> {
            logical.verify(&target_profile)?;
            verify_target_identity(&target_profile, &self.scope, &expected_identity)?;
            ensure!(
                self.snapshot_locked(source)? == *expected
                    && PrivateDirectory::open_existing(&target_path)?.directory_identity()?
                        == target_profile.directory_identity()?
                    && knowledge_catalog_relocation_snapshot_from_source(
                        target,
                        KnowledgeRelocationKind::Publications,
                        self.limits,
                        &target_source
                    )? == target_catalog,
                "KNOWLEDGE_NATIVE_RELOCATION_DATA_CHANGED"
            );
            Ok(())
        };
        verify()?;
        if !committed {
            let bytes = serde_json::to_vec(&binding)?;
            target
                .atomic_publish_from_reader(
                    OsStr::new(BINDING),
                    &mut bytes.as_slice(),
                    true,
                    || {
                        self.verify_source()?;
                        source.verify()?;
                        target_source.verify()?;
                        verify_target_identity(&target_profile, &self.scope, &expected_identity)?;
                        ensure!(
                            read_bytes(
                                &target.open_single_link_regular_file(OsStr::new(BINDING))?
                            )? == original
                                && target.portable_regular_identity(OsStr::new(BINDING))?
                                    == target.portable_regular_handle_identity(&original_anchor)?,
                            "KNOWLEDGE_NATIVE_RELOCATION_CONFLICT"
                        );
                        Ok(())
                    },
                )
                .context("KNOWLEDGE_NATIVE_RELOCATION_UNCONFIRMED")?;
        }
        verify()?;
        let anchors = PublicationAnchors::observe(target, &binding)?;
        binding.verify_profile_binding(&target_profile)?;
        transaction.commit(|_, target| {
            anchors.verify(target, &binding)?;
            self.verify_source()?;
            verify_target_identity(&target_profile, &self.scope, &expected_identity)
        })?;
        let guard =
            NativeDomainGuard::observe(&target_profile, &self.scope, NativeDomain::Knowledge)?
                .context("KNOWLEDGE_NATIVE_RELOCATION_UNCONFIRMED")?;
        anchors.verify(&guard.directory(&target_profile)?, &binding)?;
        verify_target_identity(&target_profile, &self.scope, &expected_identity)?;
        self.verify_source()?;
        Ok(())
    }
}

fn verify_target_identity(
    profile: &PrivateDirectory,
    scope: &IntegrationScope,
    expected: &NativeIdentitySnapshot,
) -> Result<()> {
    let (global, _, snapshot) =
        NativeIntegrationContext::observe_global_profile(profile, &scope.target_revision)?
            .context("KNOWLEDGE_NATIVE_IDENTITY_REQUIRED")?;
    ensure!(
        global.account_id == scope.account_id
            && global.target_id == scope.target_id
            && snapshot == *expected,
        "KNOWLEDGE_NATIVE_RELOCATION_IDENTITY_CHANGED"
    );
    Ok(())
}
fn read_bytes(file: &File) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    file.take(16 * 1024 + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 16 * 1024, "KNOWLEDGE_NATIVE_BINDING_CHANGED");
    Ok(bytes)
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn sha(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn valid_operation(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= 256 && !value.chars().any(char::is_control)
}

#[cfg(test)]
#[path = "relocation/tests.rs"]
mod tests;
