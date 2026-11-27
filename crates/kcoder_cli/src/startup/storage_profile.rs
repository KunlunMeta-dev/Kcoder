//! The stopped Native profile copy, composed from its existing storage owners.
//! This is not the public plan/admission gate or an alternative migration engine.
use super::{
    storage_gateway_domains::{
        prepare_gateway_domains, relocate_gateway_domains, verify_gateway_domains,
    },
    storage_native_domains::NativeProfileDomainOwners,
};
use anyhow::{Context, Result, ensure};
use kcoder_config::{
    CredentialBackend, PrivateDirectory,
    imported_context::ImportedContextStore,
    imported_credentials::ImportedCredentialStore,
    imported_projects::{ImportedProjectAssociationsStore, ProjectWorkspaceRegistry},
    profile_identity::ProfileIdentity,
    settings_templates::SettingsTemplateStore,
    storage::{
        StorageComponentDirectory, StorageCoordinator, StoragePublishedComponent, browser_cache,
    },
    workspace_identity::WorkspaceIdentity,
};
use kcoder_knowledge::relocation::{KnowledgeRelocationLimits, WikiRelocation};
use kcoder_migration::{
    history_jobs::relocation::HistoryJobStorageRelocation,
    local_attachment::LocalAttachmentStorageRelocation,
};
use kcoder_native_scope::NativeIntegrationContext;
use kcoder_state::{
    continuous_work::ContinuousWorkStore, history_storage_relocation::HistoryStorageRelocation,
};
use kcoder_types::{STORAGE_PERSISTENT_ROOT_DOMAIN, StorageLayout, StorageMigrationPhase};
use kcoder_workspace_resources::managed_worktrees::relocation::{
    profile_relocation_snapshots, profile_relocation_snapshots_for_operation,
};
use tokio::process::Command;

/// The single coordinator has already confirmed complete instance shutdown.
/// All adapters here preserve business state and use its original publication.
pub(super) async fn copy_and_relocate_profile(
    coordinator: &mut StorageCoordinator,
    id: &str,
    credentials_backend: &dyn CredentialBackend,
    registry: Option<&ProjectWorkspaceRegistry>,
    owner_evidence_directory: &std::path::Path,
    mut owner_command: Option<&mut Command>,
) -> Result<StoragePublishedComponent> {
    let receipt = coordinator
        .current()?
        .context("STORAGE_OPERATION_MISSING")?;
    let plan = &receipt.plan;
    ensure!(
        plan.operation_id == id && receipt.phase == StorageMigrationPhase::Copying,
        "STORAGE_PHASE_INVALID"
    );
    let component = plan
        .components
        .first()
        .context("STORAGE_PROFILE_COMPONENT_INVALID")?;
    ensure!(
        (plan.components.len() == 1 || plan.from.layout == StorageLayout::Legacy)
            && component.domain == STORAGE_PERSISTENT_ROOT_DOMAIN
            && component.source == plan.from.data_root
            && component.destination == plan.target.data_root
            && component.source != component.destination,
        "STORAGE_PROFILE_COMPONENT_INVALID"
    );
    let source = PrivateDirectory::open_existing(&component.source)?;
    ensure!(
        source.directory_identity()? == component.source_identity,
        "STORAGE_SOURCE_CHANGED"
    );
    coordinator.prepare_source_retirements(id)?;
    let native_owners =
        NativeProfileDomainOwners::observe(&component.source, "storage-relocation-v1")?;
    if let Some(owners) = &native_owners {
        owners
            .prepare_sources(coordinator, id, owner_command.as_deref_mut())
            .await?;
    }
    // Registered legacy clients have their own components in this same operation.
    let gateway = if plan.from.layout == StorageLayout::Legacy {
        None
    } else {
        let owner = prepare_gateway_domains(coordinator, id, owner_command.as_deref_mut()).await?;
        ensure!(
            owner.component_domain() == component.domain,
            "STORAGE_GATEWAY_COMPONENT_CONFLICT"
        );
        Some(owner)
    };
    ensure!(
        PrivateDirectory::open_existing(owner_evidence_directory)?.directory_identity()?
            == coordinator
                .offline_operation_directory(id)?
                .directory_identity()?,
        "STORAGE_OPERATION_DIRECTORY_CHANGED"
    );
    const ATTACHMENTS: &str = "native-profile-attachments";
    let attachments = match receipt.owner_receipts.get(ATTACHMENTS) {
        Some(value) => serde_json::from_value::<kcoder_attachments::ProfileAttachmentsRelocation>(
            value.clone(),
        )?,
        None => {
            let owner = kcoder_attachments::ProfileAttachmentsRelocation::snapshot(
                &component.source,
                id,
                owner_evidence_directory,
            )?;
            coordinator.record_owner_receipt(
                id,
                ATTACHMENTS,
                None,
                serde_json::to_value(&owner)?,
            )?;
            owner
        }
    };

    // Missing owners remain missing. Only the stopped transaction may create
    // its coordination files; no business settings or replacement identities.
    let templates = SettingsTemplateStore::open(&component.source)?;
    let credentials = ImportedCredentialStore::open(&component.source)?;
    templates.preview_relocation()?;
    credentials.preview_relocation(credentials_backend)?;
    let prepared_templates = templates.prepare_relocation(id)?;
    let prepared_credentials = credentials.prepare_relocation(id, credentials_backend)?;
    let context = ImportedContextStore::observe(&component.source)?;
    let context_snapshot = context
        .as_ref()
        .map(ImportedContextStore::relocation_snapshot)
        .transpose()?;
    let projects = ImportedProjectAssociationsStore::observe(&component.source)?;
    let project_snapshot = projects
        .as_ref()
        .map(|owner| owner.relocation_snapshot(registry))
        .transpose()?;
    let continuous = ContinuousWorkStore::open_existing(&component.source)?;
    let continuous_snapshot = continuous
        .as_ref()
        .map(ContinuousWorkStore::relocation_snapshot)
        .transpose()?;
    let migration_history = HistoryJobStorageRelocation::snapshot(&component.source)?;
    let local_attachments = LocalAttachmentStorageRelocation::snapshot(&component.source)?;
    let history_snapshot = HistoryStorageRelocation::snapshot(&component.source)?;
    let wiki = WikiRelocation::observe(&component.source, KnowledgeRelocationLimits::default())?;
    let prepared_wiki = wiki
        .as_ref()
        .map(WikiRelocation::prepare_relocation)
        .transpose()?;
    let wiki_snapshot = prepared_wiki
        .as_ref()
        .map(|owner| owner.relocation_snapshot())
        .transpose()?;
    let profile = ProfileIdentity::observe(&source)?;
    let native =
        NativeIntegrationContext::observe_global_profile(&source, "storage-relocation-v1")?;

    let mut browser_owner = if plan.from.layout == StorageLayout::Legacy {
        None
    } else {
        browser_cache::prepare_browser_cache(coordinator, id)?
    };
    if let Some(owner) = &browser_owner {
        record_browser_owner(coordinator, id, owner)?;
    }
    let mut exclusions = if plan.from.layout == StorageLayout::Legacy {
        // Its separate Desktop component owns cache exclusions and inventory.
        Default::default()
    } else {
        browser_cache::browser_cache_copy_exclusions(
            plan,
            browser_owner.as_ref(),
            STORAGE_PERSISTENT_ROOT_DOMAIN,
        )?
    };
    if let Some(gateway) = &gateway {
        exclusions.extend(gateway.copy_exclusions().iter().cloned());
    }
    for client in &plan.components[1..] {
        if let Ok(relative) = client.source.strip_prefix(&component.source) {
            ensure!(
                !relative.as_os_str().is_empty(),
                "STORAGE_GATEWAY_COMPONENT_CONFLICT"
            );
            exclusions.insert(relative.to_path_buf());
        }
    }
    let directory = coordinator.prepare_component_staging(id, STORAGE_PERSISTENT_ROOT_DOMAIN)?;
    let operation = coordinator.offline_operation_directory(id)?;
    let worktrees = match &directory {
        StorageComponentDirectory::Staging(_) => {
            profile_relocation_snapshots(&component.source, &component.destination).await?
        }
        StorageComponentDirectory::Published(_) => {
            let published =
                coordinator.open_published_component(id, STORAGE_PERSISTENT_ROOT_DOMAIN)?;
            profile_relocation_snapshots_for_operation(
                &component.source,
                &component.destination,
                id,
                &operation,
                &published,
            )
            .await?
        }
        StorageComponentDirectory::InPlace(_) => anyhow::bail!("STORAGE_PROFILE_COMPONENT_INVALID"),
    };
    if let Some(gateway) = &gateway {
        gateway.verify(coordinator, id)?;
    }
    match directory {
        StorageComponentDirectory::Staging(_) => {
            coordinator.publish_component_checked(
                id,
                STORAGE_PERSISTENT_ROOT_DOMAIN,
                &exclusions,
                |inventory| {
                    if plan.from.layout != StorageLayout::Legacy {
                        browser_cache::validate_browser_cache_source_inventory(
                            plan,
                            browser_owner.as_ref(),
                            STORAGE_PERSISTENT_ROOT_DOMAIN,
                            inventory,
                        )?;
                    }
                    if let Some(gateway) = &gateway {
                        gateway.verify_source_inventory(inventory)
                    } else {
                        Ok(())
                    }
                },
            )?;
        }
        StorageComponentDirectory::Published(_) => {}
        StorageComponentDirectory::InPlace(_) => anyhow::bail!("STORAGE_PROFILE_COMPONENT_INVALID"),
    }
    let published = coordinator.open_published_component(id, STORAGE_PERSISTENT_ROOT_DOMAIN)?;
    let target = published.directory();
    if let Some((scope, identity, snapshot)) = native {
        identity.relocate(&source, target, &scope, id, &snapshot)?;
    } else {
        profile.relocate(&source, target, id)?;
    }
    WorkspaceIdentity::rebind_profile(&source, target, id)?;
    for owner in &worktrees {
        let moved = owner
            .source_store
            .relocate(
                &owner.target_store,
                id,
                &operation,
                &owner.snapshot,
                &published,
            )
            .await?;
        for workspace in moved.workspace_facts() {
            workspace.relocate_workspace_identity(&source, target)?;
        }
        let verified = owner
            .source_store
            .verify_relocation(
                &owner.target_store,
                id,
                &operation,
                &owner.snapshot,
                &published,
            )
            .await?;
        for workspace in verified.workspace_facts() {
            workspace.verify_workspace_identity_relocation(&source, target)?;
        }
    }

    // All business processes have exited. Convert the original owners only
    // after raw publication and the sole global identity conversion.
    if let Some(owners) = native_owners {
        owners
            .finish(coordinator, &published, owner_command.as_deref_mut())
            .await?;
    }
    if let Some(gateway) = &gateway {
        relocate_gateway_domains(
            coordinator,
            id,
            owner_command.as_deref_mut(),
            gateway,
            &published,
        )
        .await?;
        verify_gateway_domains(
            coordinator,
            id,
            owner_command.as_deref_mut(),
            gateway,
            &published,
        )
        .await?;
    }
    prepared_templates.relocate(&component.destination)?;
    prepared_credentials.verify_target(target, credentials_backend)?;
    // Each owner reads back its final records and payloads before returning.
    // The same stopped operation does not need an immediate second scan;
    // independent cold verification remains with the existing owner APIs.
    if let (Some(owner), Some(snapshot)) = (&context, &context_snapshot) {
        owner.relocate(&component.destination, id, snapshot)?;
    }
    if let (Some(owner), Some(snapshot)) = (&projects, &project_snapshot) {
        owner.relocate(&component.destination, id, snapshot, registry)?;
    }
    if let (Some(owner), Some(snapshot)) = (&continuous, &continuous_snapshot) {
        owner.relocate(&component.destination, id, snapshot)?;
    }
    if let (Some(prepared), Some(snapshot)) = (prepared_wiki, &wiki_snapshot) {
        // This transaction verifies its final record and payload before returning.
        // The same stopped operation does not need a second full reconciliation.
        prepared.relocate(&component.destination, id, snapshot)?;
    }
    // Each relocation reads back its final owner records before returning.
    // Standalone verification remains available for independent recovery.
    HistoryStorageRelocation::relocate(
        &component.source,
        &component.destination,
        id,
        &history_snapshot,
        &published,
    )?;
    HistoryJobStorageRelocation::relocate(
        &component.source,
        &component.destination,
        id,
        &migration_history,
        &published,
    )?;
    LocalAttachmentStorageRelocation::relocate(
        &component.source,
        &component.destination,
        id,
        &local_attachments,
        &published,
    )?;
    // Both attachment transactions read back their final owner records. Keep
    // standalone read-only recovery APIs, but do not immediately scan again.
    attachments.relocate(
        &component.source,
        &component.destination,
        owner_evidence_directory,
        &published,
    )?;
    prepared_templates.verify_target(&component.destination)?;
    if let Some(owner) = &mut browser_owner {
        *owner = browser_cache::prepare_browser_cache_target(coordinator, id, owner)?;
        record_browser_owner(coordinator, id, owner)?;
        *owner = browser_cache::apply_browser_cache(coordinator, id, owner)?;
        record_browser_owner(coordinator, id, owner)?;
        browser_cache::verify_browser_cache(plan, owner)?;
    }
    profile.verify_relocation(&source, target, id)?;
    published.verify()?;
    coordinator.assert_source_retirements_ready(id)?;
    Ok(published)
}

pub(super) fn record_browser_owner(
    coordinator: &mut StorageCoordinator,
    id: &str,
    owner: &kcoder_types::StorageBrowserCacheReceipt,
) -> Result<()> {
    let current = coordinator
        .current()?
        .context("STORAGE_OPERATION_MISSING")?;
    let before = current
        .owner_receipts
        .get(browser_cache::BROWSER_CACHE_OWNER);
    let after = serde_json::to_value(owner)?;
    if before != Some(&after) {
        coordinator.record_owner_receipt(id, browser_cache::BROWSER_CACHE_OWNER, before, after)?;
    }
    Ok(())
}
