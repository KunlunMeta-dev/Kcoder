//! Offline domain observations retain data ownership without runtime admission.
use super::super::{NativeDomainRelocation, NativeIntegrationContext, NativeRegisteredDomain};
use super::*;
use kcoder_config::storage::StoragePublishedComponent;
use std::path::{Component, Path, PathBuf};

pub struct NativeProfileDomains {
    profile_identity: String,
    principal: IntegrationOwner,
    snapshot: NativeIdentitySnapshot,
    domains: Vec<NativeObservedDomain>,
}

/// Only the original Native owner and registered private marker construct this
/// data scope. It does not admit an app-server or enable a revoked profile.
pub struct NativeObservedDomain {
    profile_identity: String,
    principal: IntegrationOwner,
    snapshot: NativeIdentitySnapshot,
    scope: IntegrationScope,
    pinned_revision: Option<String>,
    registered: NativeRegisteredDomain,
}

pub struct NativeObservedDomainRelocation<'a> {
    source: &'a NativeObservedDomain,
    source_identity: &'a NativeIdentity,
    source_profile: &'a PrivateDirectory,
    target_identity: &'a NativeIdentity,
    target_profile: &'a PrivateDirectory,
    published: &'a StoragePublishedComponent,
    profile_relative: PathBuf,
    transaction: NativeDomainRelocation<'a>,
}

impl NativeIdentity {
    /// A strict, bounded shallow read. Identity is included for accounting but
    /// its sole formal relocation remains the caller's NativeIdentity operation.
    pub fn observe_domains(
        &self,
        profile: &PrivateDirectory,
        configuration_revision: &str,
    ) -> Result<NativeProfileDomains> {
        let snapshot = self.snapshot(profile)?;
        let mut domains = Vec::new();
        for registered in NativeDomainGuard::observe_registered_domains(profile)? {
            let owner = registered.owner();
            ensure!(
                owner.account_id == self.header.owner.account_id
                    && owner.target_id == self.header.owner.target_id,
                "NATIVE_DOMAIN_FOREIGN_PROFILE_OWNER: {}",
                registered.namespace_id()
            );
            if registered.domain() == NativeDomain::Identity {
                ensure!(
                    owner == &self.header.owner
                        && registered.namespace_id() == self.guard.namespace_id(),
                    "NATIVE_DOMAIN_IDENTITY_OWNER_MISMATCH: {}",
                    registered.namespace_id()
                );
            }
            let mut scope = IntegrationScope {
                account_id: owner.account_id.clone(),
                target_id: owner.target_id.clone(),
                workspace_id: owner.workspace_id.clone(),
                organization_id: owner.organization_id.clone(),
                identity_generation: snapshot.generation.clone(),
                target_revision: configuration_revision.into(),
            };
            scope.validate()?;
            ensure!(
                IntegrationOwner::from(&scope) == *registered.owner(),
                "NATIVE_DOMAIN_OWNER_METADATA_INVALID: {}",
                registered.namespace_id()
            );
            let pinned_revision =
                NativeIntegrationContext::observe_data_lifecycle_revision(profile, &mut scope)?;
            domains.push(NativeObservedDomain {
                profile_identity: profile.directory_identity()?,
                principal: self.header.owner.clone(),
                snapshot: snapshot.clone(),
                scope,
                pinned_revision,
                registered,
            });
        }
        let result = NativeProfileDomains {
            profile_identity: profile.directory_identity()?,
            principal: self.header.owner.clone(),
            snapshot,
            domains,
        };
        result.verify(self, profile)?;
        Ok(result)
    }
}

impl NativeProfileDomains {
    /// Preview absent profiles without skipping orphaned or partial controls.
    /// An identity-free root with registered domains is not initialized here.
    pub fn observe(
        profile: &PrivateDirectory,
        configuration_revision: &str,
    ) -> Result<Option<Self>> {
        let Some((_, identity, _)) =
            NativeIntegrationContext::observe_global_profile(profile, configuration_revision)?
        else {
            ensure!(
                NativeDomainGuard::observe_registered_domains(profile)?.is_empty(),
                "NATIVE_DOMAIN_EXISTING_IDENTITY_REQUIRED"
            );
            return Ok(None);
        };
        identity
            .observe_domains(profile, configuration_revision)
            .map(Some)
    }
    pub fn domains(&self) -> &[NativeObservedDomain] {
        &self.domains
    }
    pub fn snapshot(&self) -> &NativeIdentitySnapshot {
        &self.snapshot
    }
    pub fn verify(&self, identity: &NativeIdentity, profile: &PrivateDirectory) -> Result<()> {
        verify_identity(
            identity,
            profile,
            &self.profile_identity,
            &self.principal,
            &self.snapshot,
        )?;
        let current = NativeDomainGuard::observe_registered_domains(profile)?;
        ensure!(
            current
                .iter()
                .map(|entry| entry.namespace_id())
                .eq(self.domains.iter().map(|entry| entry.namespace_id())),
            "NATIVE_DOMAIN_INVENTORY_CHANGED"
        );
        for domain in &self.domains {
            domain.verify_marker(profile)?;
        }
        verify_identity(
            identity,
            profile,
            &self.profile_identity,
            &self.principal,
            &self.snapshot,
        )?;
        Ok(())
    }
}

impl NativeObservedDomain {
    /// Reuse this observation's held marker when the same offline owner also
    /// constructs a business facade. This grants no new identity or authority.
    pub fn clone_domain_guard(
        &self,
        identity: &NativeIdentity,
        profile: &PrivateDirectory,
    ) -> Result<NativeDomainGuard> {
        self.verify(identity, profile)?;
        self.registered.guard().try_clone(profile)
    }

    pub fn domain(&self) -> NativeDomain {
        self.registered.domain()
    }
    pub fn namespace_id(&self) -> &str {
        self.registered.namespace_id()
    }
    pub fn scope(&self) -> &IntegrationScope {
        &self.scope
    }
    pub fn snapshot(&self) -> &NativeIdentitySnapshot {
        &self.snapshot
    }
    pub fn verify(&self, identity: &NativeIdentity, profile: &PrivateDirectory) -> Result<()> {
        verify_identity(
            identity,
            profile,
            &self.profile_identity,
            &self.principal,
            &self.snapshot,
        )?;
        self.verify_marker(profile)
    }
    pub fn directory(
        &self,
        identity: &NativeIdentity,
        profile: &PrivateDirectory,
    ) -> Result<PrivateDirectory> {
        self.verify(identity, profile)?;
        self.registered.guard().directory(profile)
    }

    fn verify_marker(&self, profile: &PrivateDirectory) -> Result<()> {
        let mut scope = self.scope.clone();
        ensure!(
            NativeIntegrationContext::observe_data_lifecycle_revision(profile, &mut scope)?
                == self.pinned_revision
                && scope == self.scope,
            "NATIVE_DOMAIN_LIFECYCLE_CHANGED: {}",
            self.namespace_id()
        );
        self.registered.verify(profile)
    }

    /// Read-only publication proof for stores which prepare their own original
    /// domain transaction, without acquiring a competing marker lease here.
    pub fn verify_target_relocation(
        &self,
        source_identity: &NativeIdentity,
        source_profile: &PrivateDirectory,
        target_identity: &NativeIdentity,
        target_profile: &PrivateDirectory,
        published: &StoragePublishedComponent,
        profile_relative: &Path,
    ) -> Result<()> {
        self.verify(source_identity, source_profile)?;
        verify_target(
            self,
            source_identity,
            source_profile,
            target_identity,
            target_profile,
            published,
            profile_relative,
        )
    }

    /// The business owner must adapt and verify its data inside commit. A
    /// namespace marker alone never proves a migrated domain.
    pub fn prepare_relocation<'a>(
        &'a self,
        source_identity: &'a NativeIdentity,
        source_profile: &'a PrivateDirectory,
        target_identity: &'a NativeIdentity,
        target_profile: &'a PrivateDirectory,
        published: &'a StoragePublishedComponent,
        profile_relative: &Path,
    ) -> Result<NativeObservedDomainRelocation<'a>> {
        ensure!(
            self.domain() != NativeDomain::Identity,
            "NATIVE_DOMAIN_IDENTITY_RELOCATED_SEPARATELY"
        );
        self.verify_target_relocation(
            source_identity,
            source_profile,
            target_identity,
            target_profile,
            published,
            profile_relative,
        )?;
        let transaction = self.registered.guard().prepare_relocation(
            source_profile,
            target_profile,
            published.operation_id(),
        )?;
        let result = NativeObservedDomainRelocation {
            source: self,
            source_identity,
            source_profile,
            target_identity,
            target_profile,
            published,
            profile_relative: profile_relative.into(),
            transaction,
        };
        result.verify()?;
        Ok(result)
    }
}

impl NativeObservedDomainRelocation<'_> {
    pub fn domain(&self) -> NativeDomain {
        self.source.domain()
    }
    pub fn namespace_id(&self) -> &str {
        self.source.namespace_id()
    }
    pub fn source_directory(&self) -> &PrivateDirectory {
        self.transaction.source_directory()
    }
    pub fn target_directory(&self) -> &PrivateDirectory {
        self.transaction.target_directory()
    }
    pub fn operation_id(&self) -> &str {
        self.published.operation_id()
    }
    pub fn is_committed(&self) -> bool {
        self.transaction.is_committed()
    }
    pub fn verify(&self) -> Result<()> {
        self.source
            .verify(self.source_identity, self.source_profile)?;
        verify_target(
            self.source,
            self.source_identity,
            self.source_profile,
            self.target_identity,
            self.target_profile,
            self.published,
            &self.profile_relative,
        )?;
        self.transaction.verify()
    }
    pub fn commit(
        self,
        owner: impl FnOnce(&PrivateDirectory, &PrivateDirectory) -> Result<()>,
    ) -> Result<NativeDomainGuard> {
        self.verify()?;
        let Self {
            source,
            source_identity,
            source_profile,
            target_identity,
            target_profile,
            published,
            profile_relative,
            transaction,
        } = self;
        transaction.commit(|old, new| {
            source.verify(source_identity, source_profile)?;
            verify_target(
                source,
                source_identity,
                source_profile,
                target_identity,
                target_profile,
                published,
                &profile_relative,
            )?;
            owner(old, new)?;
            source.verify(source_identity, source_profile)?;
            verify_target(
                source,
                source_identity,
                source_profile,
                target_identity,
                target_profile,
                published,
                &profile_relative,
            )
        })
    }
}

fn verify_identity(
    identity: &NativeIdentity,
    profile: &PrivateDirectory,
    expected_profile: &str,
    principal: &IntegrationOwner,
    snapshot: &NativeIdentitySnapshot,
) -> Result<()> {
    ensure!(
        profile.directory_identity()? == expected_profile
            && identity.header.owner == *principal
            && identity.snapshot(profile)? == *snapshot,
        "NATIVE_DOMAIN_SOURCE_EPOCH_CHANGED"
    );
    Ok(())
}

fn verify_target(
    source: &NativeObservedDomain,
    source_identity: &NativeIdentity,
    source_profile: &PrivateDirectory,
    target_identity: &NativeIdentity,
    target_profile: &PrivateDirectory,
    published: &StoragePublishedComponent,
    relative: &Path,
) -> Result<()> {
    published.verify()?;
    ensure!(
        published.domain() == kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN
            && relative.components().count() <= 128
            && relative
                .components()
                .all(|part| matches!(part, Component::Normal(_))),
        "NATIVE_DOMAIN_PUBLICATION_MISMATCH"
    );
    let source_root = PrivateDirectory::open_existing(published.source_path())?;
    let old = profile_identity_at(&source_root, relative)?;
    let new = profile_identity_at(published.directory(), relative)?;
    ensure!(
        source_root.directory_identity()? == published.source_identity()
            && old == source_profile.directory_identity()?
            && new == target_profile.directory_identity()?
            && target_identity.header.owner == source_identity.header.owner
            && target_identity.snapshot(target_profile)? == source.snapshot,
        "NATIVE_DOMAIN_TARGET_IDENTITY_CHANGED"
    );
    super::relocation::verify_relocated_from(
        source_identity,
        target_identity,
        &source.profile_identity,
        published.operation_id(),
    )
}

fn profile_identity_at(root: &PrivateDirectory, relative: &Path) -> Result<String> {
    // Empty relative paths designate the already-held Published root itself.
    if relative.as_os_str().is_empty() {
        return root.directory_identity();
    }
    let mut current: Option<PrivateDirectory> = None;
    for part in relative.components() {
        let Component::Normal(name) = part else {
            anyhow::bail!("NATIVE_DOMAIN_PUBLICATION_MISMATCH")
        };
        current = Some(current.as_ref().unwrap_or(root).open_child(name, false)?);
    }
    current
        .context("NATIVE_DOMAIN_PUBLICATION_MISMATCH")?
        .directory_identity()
}

#[cfg(test)]
#[path = "domain_inventory/tests.rs"]
mod tests;
