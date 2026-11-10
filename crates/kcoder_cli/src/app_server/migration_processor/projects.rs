//! Native source and target catalogs remain connection-owned and never accept target paths.
use super::*;
use kcoder_config::imported_projects::ProjectWorkspaceRegistry;
use kcoder_migration::project_migration::{ProjectReadCancellation, ProjectTargetCatalog};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};
#[derive(Default)]
pub(super) struct Targets(BTreeMap<String, ProjectTargetCatalog>);
pub(super) fn handles(operation: &str) -> bool {
    matches!(
        operation,
        method::MIGRATION_PROJECTS_DISCOVER
            | method::MIGRATION_PROJECTS_SOURCES
            | method::MIGRATION_PROJECTS_SOURCE_ROOTS
            | method::MIGRATION_PROJECTS_TARGETS
            | method::MIGRATION_PROJECTS_TARGET_ROOTS
            | method::MIGRATION_PROJECTS_REPORT
    )
}
pub(super) fn cancelled(processor: &MigrationProcessor) -> Result<ProjectReadCancellation> {
    ensure!(
        !processor.cancellation().is_cancelled(),
        "migration_project_source_cancelled"
    );
    let original = processor.cancellation();
    Ok(ProjectReadCancellation::with_probe(move || {
        original.is_cancelled()
    }))
}
pub(super) fn execute(
    processor: &MigrationProcessor,
    factory: &dyn MigrationHost,
    profile: &Path,
    operation: &str,
    params: Value,
) -> Result<Value> {
    if operation == method::MIGRATION_PROJECTS_REPORT {
        let params: MigrationProjectReportParams = decode(params)?;
        return Ok(serde_json::to_value(
            MigrationStore::open_existing(profile)?.project_report(
                &params.job_id,
                &params.item_id,
                params.page_index,
            )?,
        )?);
    }
    if matches!(
        operation,
        method::MIGRATION_PROJECTS_DISCOVER
            | method::MIGRATION_PROJECTS_SOURCES
            | method::MIGRATION_PROJECTS_SOURCE_ROOTS
    ) {
        let mut registry = processor
            .registry
            .lock()
            .map_err(|_| anyhow::anyhow!("migration_busy"))?;
        processor.initialize_registry(&mut registry, factory)?;
        let registry = registry
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("migration_project_catalog_unavailable"))?;
        let cancel = cancelled(processor)?;
        return match operation {
            method::MIGRATION_PROJECTS_DISCOVER => {
                let p: MigrationProjectsDiscoverParams = decode(params)?;
                Ok(serde_json::to_value(
                    registry.discover_projects(p.source, &cancel)?,
                )?)
            }
            method::MIGRATION_PROJECTS_SOURCES => {
                let p: MigrationProjectsSourcesParams = decode(params)?;
                Ok(serde_json::to_value(registry.projects_page(
                    &p.catalog_id,
                    p.page_index,
                    &cancel,
                )?)?)
            }
            _ => {
                let p: MigrationProjectSourceRootsParams = decode(params)?;
                Ok(serde_json::to_value(registry.project_source_roots(
                    &p.catalog_id,
                    &p.source_handle,
                    p.page_index,
                    &cancel,
                )?)?)
            }
        };
    }
    let mut targets = processor
        .project_targets
        .lock()
        .map_err(|_| anyhow::anyhow!("migration_busy"))?;
    targets.0.retain(|_, catalog| !catalog.expired());
    if operation == method::MIGRATION_PROJECTS_TARGETS {
        let p: MigrationProjectTargetsParams = decode(params)?;
        let id = match p.target_catalog_id {
            Some(id) => id,
            None => {
                ensure!(p.page_index == 0, "migration_invalid_cursor");
                ensure!(
                    targets.0.len() < 4,
                    "migration_project_target_catalog_limit"
                );
                let (cwd, registry_root) = factory.migration_project_target_context();
                let registry = registry_root
                    .as_ref()
                    .map(|root| ProjectWorkspaceRegistry::open_native(root))
                    .transpose();
                let registry = match registry {
                    Ok(value) => value,
                    Err(error)
                        if error.chain().any(|e| {
                            e.downcast_ref::<std::io::Error>()
                                .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
                        }) =>
                    {
                        None
                    }
                    Err(_) => anyhow::bail!("migration_project_target_unavailable"),
                };
                let key = registry_root
                    .as_ref()
                    .and_then(|path| path.file_name())
                    .and_then(|name| name.to_str())
                    .map(str::to_owned)
                    .unwrap_or_else(|| {
                        format!(
                            "current-{:x}",
                            Sha256::digest(cwd.as_os_str().as_encoded_bytes())
                        )
                    });
                let catalog =
                    match ProjectTargetCatalog::capture(profile, &cwd, &key, registry.as_ref()) {
                        Ok(catalog) => catalog,
                        // The ordinary workspace list can create its lock before the first registry
                        // publication. Missing registry metadata is unobserved, not an empty catalog;
                        // the independent original Native cwd remains the only offered authority.
                        Err(error)
                            if registry.is_some()
                                && error.chain().any(|cause| {
                                    cause.downcast_ref::<std::io::Error>().is_some_and(|error| {
                                        error.kind() == std::io::ErrorKind::NotFound
                                    })
                                }) =>
                        {
                            ProjectTargetCatalog::capture(profile, &cwd, &key, None)?
                        }
                        Err(error) => return Err(error),
                    };
                let id = catalog.id().to_owned();
                targets.0.insert(id.clone(), catalog);
                id
            }
        };
        return Ok(serde_json::to_value(
            targets
                .0
                .get(&id)
                .ok_or_else(|| anyhow::anyhow!("migration_project_target_catalog_unavailable"))?
                .page(profile, p.page_index)?,
        )?);
    }
    let p: MigrationProjectTargetRootsParams = decode(params)?;
    Ok(serde_json::to_value(
        targets
            .0
            .get(&p.target_catalog_id)
            .ok_or_else(|| anyhow::anyhow!("migration_project_target_catalog_unavailable"))?
            .roots(profile, &p.target_handle, p.page_index)?,
    )?)
}
pub(super) fn resolve(
    processor: &MigrationProcessor,
    profile: &Path,
    scanned: &kcoder_migration::store::MigrationJob,
    item: &str,
    mapping: &kcoder_types::migration_projects::MigrationProjectMappingChoice,
) -> Result<kcoder_migration::project_migration::ProjectTargetSelection> {
    let batch = scanned
        .batch
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("migration_not_a_batch"))?;
    let kcoder_migration::batch::BatchSource::Project(source) = batch.source_for(item)? else {
        anyhow::bail!("migration_invalid_batch_resolution")
    };
    let targets = processor
        .project_targets
        .lock()
        .map_err(|_| anyhow::anyhow!("migration_busy"))?;
    targets
        .0
        .get(&mapping.target_catalog_id)
        .ok_or_else(|| anyhow::anyhow!("migration_project_target_catalog_unavailable"))?
        .resolve(profile, source, mapping)
}

#[cfg(test)]
mod cancellation_tests {
    use super::*;
    #[test]
    fn the_native_probe_observes_the_original_connection_shutdown_after_creation() {
        let processor = MigrationProcessor::new();
        let probe = cancelled(&processor).unwrap();
        assert!(!probe.is_cancelled());
        processor.cancellation().cancel();
        assert!(probe.is_cancelled());
        assert!(cancelled(&processor).is_err());
    }
}
