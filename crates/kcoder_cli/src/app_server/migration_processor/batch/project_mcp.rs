//! Name-only pages retain the original catalog revision and authenticated target scope.
use super::*;

pub(super) fn catalog(
    factory: &dyn MigrationHost,
    profile: &Path,
    params: MigrationProjectMcpCatalogParams,
) -> Result<Value> {
    ensure!(params.page_index <= 102, "migration_invalid_cursor");
    ensure!(
        params.page_index == 0 || params.expected_revision.is_some(),
        "migration_invalid_cursor"
    );
    let job = MigrationStore::open_existing(profile)?.read(&params.job_id)?;
    settings_target::verify(factory, profile, &job)?;
    let mut result = MigrationProjectMcpCatalogResult {
        job_id: params.job_id,
        status: MigrationProjectMcpCatalogStatus::NotProject,
        names: Vec::new(),
        total_names: 0,
        revision: None,
        next_page_index: None,
    };
    if let Some(project) = job.project_target() {
        match McpTarget::preview_project_mcp_catalog(profile, project) {
            Ok(catalog) => {
                ensure!(
                    params
                        .expected_revision
                        .as_ref()
                        .is_none_or(|revision| revision == &catalog.revision),
                    "migration_target_changed"
                );
                let offset = params.page_index * 10;
                ensure!(
                    offset < catalog.names.len() || offset == 0,
                    "migration_invalid_cursor"
                );
                result.status = MigrationProjectMcpCatalogStatus::SelectionRequired;
                result.total_names = catalog.names.len();
                result.names = catalog.names.into_iter().skip(offset).take(10).collect();
                result.revision = Some(catalog.revision);
                result.next_page_index =
                    (offset + 10 < result.total_names).then_some(params.page_index + 1);
            }
            Err(error) if error.to_string() == "migration_project_mcp_catalog_already_declared" => {
                ensure!(
                    params.page_index == 0 && params.expected_revision.is_none(),
                    "migration_target_changed"
                );
                result.status = MigrationProjectMcpCatalogStatus::AlreadyDeclared;
            }
            Err(error) => return Err(error),
        }
    } else {
        ensure!(
            params.page_index == 0 && params.expected_revision.is_none(),
            "migration_invalid_cursor"
        );
    }
    Ok(serde_json::to_value(result)?)
}
