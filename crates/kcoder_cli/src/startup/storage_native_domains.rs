//! Verify Native owners after the stopped copy; convert only required addresses.
use super::storage_connectivity::{relocate_connectivity_store, verify_connectivity_source};
use crate::app_server::storage_task_metadata as storage_lock;
use anyhow::{Context, Result, ensure};
use kcoder_browser::NativeBrowserCatalogRelocation;
use kcoder_config::{
    PrivateDirectory,
    storage::{StorageCoordinator, StoragePublishedComponent},
};
use kcoder_knowledge::relocation::KnowledgeRelocationLimits;
use kcoder_knowledge_rpc::publication_reader::relocation::NativePublicationRelocation;
use kcoder_memory::integrations::knowledge::MemoryReviewStore;
use kcoder_native_delegation::NativeDelegationAuthority;
use kcoder_native_scope::{
    NativeDomain, NativeIdentity, NativeIntegrationContext, NativeProfileDomains,
};
use kcoder_native_service_runtime::connectivity::NativeConnectivityLeaseFacade;
use kcoder_state::integrations::{
    core::{
        IntegrationOperationStore, budgets::NativeBudgetStore,
        remote_delegations::NativeRemoteDelegationStore,
        service_leases::IntegrationServiceLeaseStore,
    },
    knowledge::AutomationStore,
    resources::ResourceStore,
};
use kcoder_types::integrations::core::IntegrationOwner;
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};
use tokio::process::Command;

pub(super) struct NativeProfileDomainOwners {
    source_path: PathBuf,
    source: PrivateDirectory,
    identity: NativeIdentity,
    inventory: NativeProfileDomains,
    revision: String,
    owners: Vec<(usize, DomainOwner)>,
}

enum DomainOwner {
    Browser(NativeBrowserCatalogRelocation),
    Knowledge(NativePublicationRelocation),
    Connectivity(NativeConnectivityLeaseFacade),
    Memory(MemoryReviewStore),
    Policy(NativeDelegationAuthority),
    Operations(IntegrationOperationStore),
    Automation(AutomationStore),
    WorkspaceResources(ResourceStore),
    Budgets(NativeBudgetStore),
    RemoteDelegations(NativeRemoteDelegationStore),
    Services,
    TaskMetadata,
}

impl NativeProfileDomainOwners {
    /// Enumerate only original committed owners, including disabled data scopes.
    /// Missing identities and domains are never initialized by this observation.
    /// No writer or marker lease is retained across the profile copy.
    pub(super) fn observe(profile_path: &Path, revision: &str) -> Result<Option<Self>> {
        let source_path = profile_path.canonicalize()?;
        let source = PrivateDirectory::open_existing(&source_path)?;
        let Some(inventory) = NativeProfileDomains::observe(&source, revision)? else {
            return Ok(None);
        };
        let (_, identity, snapshot) =
            NativeIntegrationContext::observe_global_profile(&source, revision)?
                .context("NATIVE_DOMAIN_EXISTING_IDENTITY_REQUIRED")?;
        ensure!(
            inventory.snapshot() == &snapshot,
            "NATIVE_DOMAIN_SOURCE_EPOCH_CHANGED"
        );
        let mut owners = Vec::new();
        for (index, entry) in inventory.domains().iter().enumerate() {
            let owner = match entry.domain() {
                NativeDomain::Identity => continue,
                // Retired payloads have no writer or runtime owner. Keep their
                // original marker and data in the strict inventory and byte copy;
                // the remaining credential-metadata invalidation fence cold-opens
                // that same marker without interpreting credential contents.
                domain if domain.is_legacy_channel() => continue,
                NativeDomain::BrowserProfiles => DomainOwner::Browser(
                    NativeBrowserCatalogRelocation::observe(entry, &identity, &source)?,
                ),
                NativeDomain::Knowledge => {
                    let owner = NativePublicationRelocation::observe(
                        &source_path,
                        entry.scope(),
                        KnowledgeRelocationLimits::default(),
                    )?
                    .context("KNOWLEDGE_NATIVE_RELOCATION_OWNER_MISSING")?;
                    DomainOwner::Knowledge(owner)
                }
                NativeDomain::Connectivity => DomainOwner::Connectivity(
                    NativeConnectivityLeaseFacade::observe_for_relocation(
                        entry,
                        &identity,
                        &source,
                        &source_path,
                    )?,
                ),
                NativeDomain::Services => {
                    verify_services(&entry.directory(&identity, &source)?, entry.scope())?;
                    DomainOwner::Services
                }
                NativeDomain::Memory => DomainOwner::Memory(MemoryReviewStore::open_in(
                    &entry.directory(&identity, &source)?,
                    OsStr::new("data"),
                    entry.scope(),
                )?),
                NativeDomain::Policy => DomainOwner::Policy(NativeDelegationAuthority::open_in(
                    &entry.directory(&identity, &source)?,
                    OsStr::new("issuer"),
                    entry.scope(),
                )?),
                NativeDomain::Operations => {
                    DomainOwner::Operations(IntegrationOperationStore::open_in(
                        &entry.directory(&identity, &source)?,
                        OsStr::new("data"),
                        entry.scope(),
                    )?)
                }
                NativeDomain::Automation => DomainOwner::Automation(AutomationStore::open_in(
                    &entry.directory(&identity, &source)?,
                    OsStr::new("store"),
                    entry.scope(),
                )?),
                NativeDomain::WorkspaceResources => DomainOwner::WorkspaceResources(
                    ResourceStore::open_in(
                        &entry.directory(&identity, &source)?,
                        OsStr::new("data"),
                        IntegrationOwner::from(entry.scope()),
                    )?
                    .context("OFFICE_NATIVE_STORE_UNCONFIRMED")?,
                ),
                NativeDomain::Budgets => DomainOwner::Budgets(
                    NativeBudgetStore::open_in(
                        &entry.directory(&identity, &source)?,
                        OsStr::new("ledger"),
                        entry.scope(),
                    )?
                    .context("BUDGET_JOURNAL_MISSING")?,
                ),
                NativeDomain::RemoteDelegations => DomainOwner::RemoteDelegations(
                    NativeRemoteDelegationStore::open_in(
                        &entry.directory(&identity, &source)?,
                        OsStr::new("data"),
                        entry.scope(),
                    )?
                    .context("REMOTE_JOURNAL_MISSING")?,
                ),
                NativeDomain::ConnectivitySources
                | NativeDomain::ConnectivityTaskCapabilityScope => {
                    storage_lock::preview(
                        &entry.directory(&identity, &source)?,
                        entry.scope(),
                        entry.domain(),
                    )?;
                    DomainOwner::TaskMetadata
                }
                domain => anyhow::bail!(
                    "STORAGE_NATIVE_DOMAIN_OWNER_UNSUPPORTED: {domain:?}: {}",
                    entry.namespace_id()
                ),
            };
            owners.push((index, owner));
        }
        let owners = Self {
            source_path,
            source,
            identity,
            inventory,
            revision: revision.into(),
            owners,
        };
        owners.verify()?;
        Ok(Some(owners))
    }

    fn verify(&self) -> Result<()> {
        ensure!(
            PrivateDirectory::open_existing(&self.source_path)?.directory_identity()?
                == self.source.directory_identity()?,
            "NATIVE_DOMAIN_SOURCE_PROFILE_CHANGED"
        );
        self.inventory.verify(&self.identity, &self.source)
    }

    pub(super) fn source_count(&self) -> usize {
        self.owners.len()
    }

    pub(super) fn snapshot(&self) -> &kcoder_native_scope::NativeIdentitySnapshot {
        self.inventory.snapshot()
    }

    /// Only converted placement metadata needs a source/target comparison here.
    /// The generic copier already verified every unchanged payload.
    pub(super) fn verify_placements(&self, published: &StoragePublishedComponent) -> Result<()> {
        self.verify()?;
        for (index, owner) in &self.owners {
            let entry = &self.inventory.domains()[*index];
            let namespace = OsStr::new(entry.namespace_id());
            match owner {
                DomainOwner::Memory(store) => store.verify_lock_relocation(published, namespace)?,
                DomainOwner::Policy(store) => store.verify_lock_relocation(published, namespace)?,
                DomainOwner::Operations(store) => {
                    store.verify_lock_relocation(published, namespace)?
                }
                DomainOwner::Automation(store) => {
                    store.verify_lock_relocation(published, namespace)?
                }
                DomainOwner::WorkspaceResources(store) => {
                    store.verify_lock_relocation(published, namespace)?
                }
                DomainOwner::Budgets(store) => {
                    store.verify_lock_relocation(published, namespace)?
                }
                DomainOwner::RemoteDelegations(store) => {
                    store.verify_lock_relocation(published, namespace)?
                }
                _ => {}
            }
            if matches!(owner, DomainOwner::TaskMetadata) {
                storage_lock::relocate_or_verify(
                    None,
                    published,
                    OsStr::new(entry.namespace_id()),
                    entry.scope(),
                    entry.domain(),
                )?;
            }
            if matches!(owner, DomainOwner::Services) {
                let entry = &self.inventory.domains()[*index];
                let directory = entry.directory(&self.identity, &self.source)?;
                let store = IntegrationServiceLeaseStore::open_in(
                    &directory,
                    OsStr::new("leases"),
                    entry.scope(),
                )?;
                store
                    .verify_gateway_fence_relocation(published, OsStr::new(entry.namespace_id()))?;
            }
        }
        published.verify()
    }

    pub(super) fn requires_owner_runtime(&self) -> bool {
        self.owners
            .iter()
            .any(|(_, owner)| matches!(owner, DomainOwner::Connectivity(_)))
    }

    /// Prepare the existing application's SQLite coordination files before the
    /// strict source inventory. This stage's Native lease ends before copying;
    /// the coordinator retains continuous full-instance exclusion throughout.
    pub(super) async fn prepare_sources(
        &self,
        coordinator: &mut StorageCoordinator,
        operation_id: &str,
        mut command: Option<&mut Command>,
    ) -> Result<()> {
        self.verify()?;
        for (index, owner) in &self.owners {
            if let DomainOwner::Connectivity(owner) = owner {
                let command = command
                    .as_deref_mut()
                    .context("STORAGE_OWNER_RUNTIME_REQUIRED")?;
                let prepared = owner.prepare_relocation_source_offline(
                    &self.inventory.domains()[*index],
                    &self.identity,
                    &self.source,
                    &self.source_path,
                    operation_id,
                )?;
                verify_connectivity_source(coordinator, operation_id, command, &prepared).await?;
            }
        }
        self.verify()
    }

    /// The caller confirms complete instance exit and finishes the sole global
    /// NativeIdentity conversion before these short owner transactions.
    pub(super) async fn finish(
        self,
        coordinator: &mut StorageCoordinator,
        published: &StoragePublishedComponent,
        mut command: Option<&mut Command>,
    ) -> Result<()> {
        self.verify()?;
        let operation_id = published.operation_id();
        let target = published.directory();
        let (_, target_identity, snapshot) =
            NativeIntegrationContext::observe_global_profile(target, &self.revision)?
                .context("NATIVE_DOMAIN_EXISTING_IDENTITY_REQUIRED")?;
        ensure!(
            &snapshot == self.inventory.snapshot(),
            "NATIVE_DOMAIN_TARGET_IDENTITY_CHANGED"
        );
        let identity_entry = self
            .inventory
            .domains()
            .iter()
            .find(|entry| entry.domain() == NativeDomain::Identity)
            .context("NATIVE_DOMAIN_EXISTING_IDENTITY_REQUIRED")?;
        identity_entry.verify_target_relocation(
            &self.identity,
            &self.source,
            &target_identity,
            target,
            published,
            Path::new(""),
        )?;
        for (index, owner) in &self.owners {
            let entry = &self.inventory.domains()[*index];
            let current_pin = matches!(
                owner,
                DomainOwner::Memory(_)
                    | DomainOwner::Policy(_)
                    | DomainOwner::Operations(_)
                    | DomainOwner::Automation(_)
                    | DomainOwner::WorkspaceResources(_)
                    | DomainOwner::Budgets(_)
                    | DomainOwner::RemoteDelegations(_)
            );
            if current_pin {
                entry.verify_target_relocation(
                    &self.identity,
                    &self.source,
                    &target_identity,
                    target,
                    published,
                    Path::new(""),
                )?;
            }
            let namespace = OsStr::new(entry.namespace_id());
            match owner {
                DomainOwner::Memory(store) => {
                    store.relocate_lock(coordinator, published, namespace)?;
                    MemoryReviewStore::open_in(
                        &target.open_child(namespace, false)?,
                        OsStr::new("data"),
                        entry.scope(),
                    )?;
                }
                DomainOwner::Policy(store) => {
                    store.relocate_lock(coordinator, published, namespace)?;
                    NativeDelegationAuthority::open_in(
                        &target.open_child(namespace, false)?,
                        OsStr::new("issuer"),
                        entry.scope(),
                    )?;
                }
                DomainOwner::Operations(store) => {
                    store.relocate_lock(coordinator, published, namespace)?;
                    IntegrationOperationStore::open_in(
                        &target.open_child(namespace, false)?,
                        OsStr::new("data"),
                        entry.scope(),
                    )?;
                }
                DomainOwner::Automation(store) => {
                    store.relocate_lock(coordinator, published, namespace)?;
                    AutomationStore::open_in(
                        &target.open_child(namespace, false)?,
                        OsStr::new("store"),
                        entry.scope(),
                    )?;
                }
                DomainOwner::WorkspaceResources(store) => {
                    store.relocate_lock(coordinator, published, namespace)?;
                    ResourceStore::open_in(
                        &target.open_child(namespace, false)?,
                        OsStr::new("data"),
                        IntegrationOwner::from(entry.scope()),
                    )?
                    .context("OFFICE_NATIVE_STORE_UNCONFIRMED")?;
                }
                DomainOwner::Budgets(store) => {
                    store.relocate_lock(coordinator, published, namespace)?;
                    NativeBudgetStore::open_in(
                        &target.open_child(namespace, false)?,
                        OsStr::new("ledger"),
                        entry.scope(),
                    )?
                    .context("BUDGET_JOURNAL_MISSING")?;
                }
                DomainOwner::RemoteDelegations(store) => {
                    store.relocate_lock(coordinator, published, namespace)?;
                    NativeRemoteDelegationStore::open_in(
                        &target.open_child(namespace, false)?,
                        OsStr::new("data"),
                        entry.scope(),
                    )?
                    .context("REMOTE_JOURNAL_MISSING")?;
                }
                DomainOwner::Browser(owner) => {
                    let catalog = owner.prepare_relocation(entry, &self.identity, &self.source)?;
                    let transaction = entry.prepare_relocation(
                        &self.identity,
                        &self.source,
                        &target_identity,
                        target,
                        published,
                        Path::new(""),
                    )?;
                    catalog.relocate(transaction)?;
                }
                DomainOwner::Knowledge(owner) => {
                    entry.verify_target_relocation(
                        &self.identity,
                        &self.source,
                        &target_identity,
                        target,
                        published,
                        Path::new(""),
                    )?;
                    // This owner acquires its original writer/SQLite leases
                    // and verifies the final binding in the same short call.
                    let snapshot = owner.relocation_snapshot()?;
                    owner.relocate(published.destination_path(), operation_id, &snapshot)?;
                }
                DomainOwner::Services => {
                    let source_domain = entry.directory(&self.identity, &self.source)?;
                    let source_store = IntegrationServiceLeaseStore::open_in(
                        &source_domain,
                        OsStr::new("leases"),
                        entry.scope(),
                    )?;
                    source_store.relocate_gateway_fences(
                        coordinator,
                        published,
                        OsStr::new(entry.namespace_id()),
                    )?;
                    let target_domain = kcoder_native_scope::NativeDomainGuard::observe(
                        target,
                        entry.scope(),
                        NativeDomain::Services,
                    )?
                    .context("SERVICE_LEASE_STORE_MISSING")?;
                    verify_services(&target_domain.directory(target)?, entry.scope())?;
                    entry.verify_target_relocation(
                        &self.identity,
                        &self.source,
                        &target_identity,
                        target,
                        published,
                        Path::new(""),
                    )?;
                }
                DomainOwner::TaskMetadata => {
                    storage_lock::relocate_or_verify(
                        Some(coordinator),
                        published,
                        OsStr::new(entry.namespace_id()),
                        entry.scope(),
                        entry.domain(),
                    )?;
                    entry.verify_target_relocation(
                        &self.identity,
                        &self.source,
                        &target_identity,
                        target,
                        published,
                        Path::new(""),
                    )?;
                }
                DomainOwner::Connectivity(owner) => {
                    let transaction = owner.prepare_relocation_offline(
                        entry,
                        &self.identity,
                        &self.source,
                        &target_identity,
                        published,
                    )?;
                    relocate_connectivity_store(
                        coordinator,
                        operation_id,
                        command
                            .as_deref_mut()
                            .context("STORAGE_OWNER_RUNTIME_REQUIRED")?,
                        transaction,
                    )
                    .await?;
                }
            }
            if current_pin {
                entry.verify_target_relocation(
                    &self.identity,
                    &self.source,
                    &target_identity,
                    target,
                    published,
                    Path::new(""),
                )?;
            }
        }
        let final_inventory = NativeProfileDomains::observe(target, &self.revision)?
            .context("NATIVE_DOMAIN_EXISTING_IDENTITY_REQUIRED")?;
        ensure!(
            final_inventory.snapshot() == self.inventory.snapshot()
                && final_inventory.domains().len() == self.inventory.domains().len()
                && final_inventory
                    .domains()
                    .iter()
                    .zip(self.inventory.domains())
                    .all(|(new, old)| new.domain() == old.domain()
                        && new.namespace_id() == old.namespace_id()
                        && new.scope() == old.scope()),
            "NATIVE_DOMAIN_INVENTORY_CHANGED"
        );
        self.verify()?;
        published.verify()
    }
}

// Verify current fence placement without claiming or restarting stored work.
fn verify_services(
    directory: &PrivateDirectory,
    scope: &kcoder_types::integrations::core::IntegrationScope,
) -> Result<()> {
    let store = IntegrationServiceLeaseStore::open_in(directory, OsStr::new("leases"), scope)?;
    store.preview_gateway_fence_relocation()
}

#[cfg(test)]
#[path = "storage_native_domains/companions_tests.rs"]
mod companions_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_native_scope::NativeDomainGuard;

    #[test]
    fn absent_native_profile_never_creates_identity_or_domains() -> Result<()> {
        let root = tempfile::tempdir()?;
        assert!(NativeProfileDomainOwners::observe(root.path(), "revision")?.is_none());
        assert_eq!(std::fs::read_dir(root.path())?.count(), 0);
        Ok(())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn registered_browser_and_task_sources_relocate_with_the_disabled_epoch() -> Result<()> {
        use crate::app_server::{
            NativeConnectivitySourceCatalog, NativeTaskCapabilityScopeBindingStore,
        };
        use kcoder_config::storage::{StorageResolveInput, resolve_storage_paths};
        use kcoder_state::browser_profiles::BrowserProfileStore;
        use kcoder_types::{
            STORAGE_PERSISTENT_ROOT_DOMAIN, StorageLaunchIntent, StorageLocationRecord,
            StorageMigrationComponent, StorageMigrationPhase as Phase, StorageMigrationPlan,
            browser_profiles::{BrowserAccountProfileDraft, BrowserProfilePurpose},
        };
        use std::collections::{BTreeMap, BTreeSet};

        let root = tempfile::tempdir()?;
        let base = PrivateDirectory::open_existing(root.path())?;
        let profile = base.create_private_child(OsStr::new("source"))?;
        base.create_private_child(OsStr::new("operation-home"))?;
        let source_path = root.path().join("source");
        let mut originals = BTreeMap::new();
        let mut task_metadata = BTreeMap::new();
        for workspace in ["first", "second"] {
            base.create_private_child(OsStr::new(workspace))?;
            let native = NativeIntegrationContext::capture(
                &source_path,
                &root.path().join(workspace),
                workspace,
                "revision",
            )?;
            let (domain, store) = NativeDomainGuard::initialize(
                &profile,
                native.scope(),
                NativeDomain::BrowserProfiles,
                workspace,
                |directory| {
                    BrowserProfileStore::create_in(directory, OsStr::new("catalog"), native.scope())
                },
            )?;
            let original = store.save(
                workspace,
                BrowserAccountProfileDraft {
                    id: format!("account-{workspace}"),
                    label: workspace.into(),
                    account_label: None,
                    purpose: BrowserProfilePurpose::Business,
                },
                0,
            )?;
            originals.insert(domain.namespace_id().to_owned(), original);
            drop(NativeConnectivitySourceCatalog::initialize(
                &native, workspace,
            )?);
            drop(NativeTaskCapabilityScopeBindingStore::initialize(
                &native, workspace,
            )?);
            for (kind, leaf) in [
                (NativeDomain::ConnectivitySources, "native-sources.json"),
                (
                    NativeDomain::ConnectivityTaskCapabilityScope,
                    "task-sources-owner.json",
                ),
            ] {
                let task_domain =
                    NativeDomainGuard::observe(&profile, native.scope(), kind)?.unwrap();
                task_metadata.insert(
                    task_domain.namespace_id().to_owned(),
                    (
                        kind,
                        leaf,
                        std::fs::read(source_path.join(task_domain.namespace_id()).join(leaf))?,
                    ),
                );
            }
        }
        let (_, identity, _) =
            NativeIntegrationContext::observe_global_profile(&profile, "revision")?.unwrap();
        identity.disable(&profile, "keep-disabled", 1, 1000)?;
        let snapshot = identity.snapshot(&profile)?;
        let (global, _, _) =
            NativeIntegrationContext::observe_global_profile(&profile, "revision")?.unwrap();
        let owners = NativeProfileDomainOwners::observe(&source_path, "revision")?.unwrap();
        let home = root.path().join("operation-home");
        let target_path = root.path().join("target");
        let id = "every-native-browser-owner";
        let mut coordinator = StorageCoordinator::acquire(&home)?;
        coordinator.begin(StorageMigrationPlan {
            version: 1,
            operation_id: id.into(),
            original: None,
            from: resolve_storage_paths(&StorageResolveInput {
                home: Some(home),
                ..Default::default()
            })?,
            target: StorageLocationRecord {
                version: 1,
                revision: 1,
                data_root: target_path.clone(),
                cache_root: root.path().join("cache"),
                operation_id: Some(id.into()),
            },
            components: vec![StorageMigrationComponent {
                domain: STORAGE_PERSISTENT_ROOT_DOMAIN.into(),
                source: source_path.clone(),
                destination: target_path,
                source_identity: profile.directory_identity()?,
                estimated_bytes: 0,
            }],
            target_bindings: vec![],
            launch_intent: StorageLaunchIntent::VerifyOnly,
        })?;
        coordinator.advance(id, Phase::Planned, Phase::Stopping)?;
        coordinator.advance(id, Phase::Stopping, Phase::Stopped)?;
        let mut unused_node = Command::new("native-browser-must-not-launch-a-helper");
        assert_eq!(owners.source_count(), 6);
        coordinator.advance(id, Phase::Stopped, Phase::Copying)?;
        coordinator.publish_component(id, STORAGE_PERSISTENT_ROOT_DOMAIN, &BTreeSet::new())?;
        let published = coordinator.open_published_component(id, STORAGE_PERSISTENT_ROOT_DOMAIN)?;
        for entry in owners.inventory.domains() {
            if matches!(
                entry.domain(),
                NativeDomain::ConnectivitySources | NativeDomain::ConnectivityTaskCapabilityScope
            ) {
                let directory = published
                    .directory()
                    .open_child(OsStr::new(entry.namespace_id()), false)?;
                assert!(
                    storage_lock::preview(&directory, entry.scope(), entry.domain()).is_err(),
                    "a raw copy must not silently adopt a replacement lock"
                );
            }
        }
        let target_identity =
            identity.relocate(&profile, published.directory(), &global, id, &snapshot)?;
        owners
            .finish(&mut coordinator, &published, Some(&mut unused_node))
            .await?;
        assert_eq!(target_identity.snapshot(published.directory())?, snapshot);
        assert!(!snapshot.enabled);
        let target_inventory =
            NativeProfileDomains::observe(published.directory(), "revision")?.unwrap();
        NativeProfileDomainOwners::observe(&root.path().join("source"), "revision")?
            .unwrap()
            .verify_placements(&published)?;
        let mut restored = BTreeMap::new();
        for entry in target_inventory.domains() {
            if let Some((kind, leaf, bytes)) = task_metadata.get(entry.namespace_id()) {
                let directory = entry.directory(&target_identity, published.directory())?;
                storage_lock::preview(&directory, entry.scope(), *kind)?;
                let actual = std::fs::read(
                    published
                        .destination_path()
                        .join(entry.namespace_id())
                        .join(leaf),
                )?;
                let mut expected: serde_json::Value = serde_json::from_slice(bytes)?;
                let mut actual: serde_json::Value = serde_json::from_slice(&actual)?;
                assert_ne!(expected["lockIdentity"], actual["lockIdentity"]);
                expected.as_object_mut().unwrap().remove("lockIdentity");
                actual.as_object_mut().unwrap().remove("lockIdentity");
                assert_eq!(
                    actual, expected,
                    "source IDs, source versions and operation receipts stay unchanged"
                );
                assert_eq!(
                    std::fs::read(source_path.join(entry.namespace_id()).join(leaf))?,
                    *bytes
                );
            }
            if entry.domain() == NativeDomain::BrowserProfiles {
                let directory = entry.directory(&target_identity, published.directory())?;
                let store =
                    BrowserProfileStore::open_in(&directory, OsStr::new("catalog"), entry.scope())?
                        .unwrap();
                let page = store.list(None, true)?;
                assert_eq!(page.items.len(), 1);
                restored.insert(entry.namespace_id().to_owned(), page.items[0].clone());
            }
        }
        assert_eq!(restored, originals);
        let entry = target_inventory
            .domains()
            .iter()
            .find(|entry| entry.domain() == NativeDomain::ConnectivityTaskCapabilityScope)
            .unwrap();
        let directory = published
            .directory()
            .open_child(OsStr::new(entry.namespace_id()), false)?;
        let name = OsStr::new("task-sources-owner.json");
        let original = std::fs::read(
            published
                .destination_path()
                .join(entry.namespace_id())
                .join(name),
        )?;
        directory.atomic_replace(name, b"{}")?;
        assert!(
            storage_lock::relocate_or_verify(
                None,
                &published,
                OsStr::new(entry.namespace_id()),
                entry.scope(),
                entry.domain()
            )
            .is_err()
        );
        assert_eq!(
            std::fs::read(
                published
                    .destination_path()
                    .join(entry.namespace_id())
                    .join(name)
            )?,
            b"{}"
        );
        directory.atomic_replace(name, &original)?;
        Ok(())
    }
}
