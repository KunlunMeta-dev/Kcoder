//! Explicit project catalogs preserve foreign root strings without opening them.
use super::*;
use crate::project_migration::{
    ProjectBatchSource, ProjectReadCancellation, ProjectRegistryCapture,
};
use kcoder_types::migration_projects::*;

pub(super) struct Catalog {
    created: Instant,
    source: MigrationSourceKind,
    capture: Option<ProjectRegistryCapture>,
    handles: Vec<String>,
    problem: Option<MigrationProjectDiscoveryProblem>,
}
fn source_problem(error: &anyhow::Error) -> MigrationProjectDiscoveryProblem {
    let code = error.to_string();
    if code.contains("busy") {
        MigrationProjectDiscoveryProblem::RegistryBusy
    } else if code.contains("budget") {
        MigrationProjectDiscoveryProblem::RegistryBudgetExceeded
    } else if code.contains("changed") {
        MigrationProjectDiscoveryProblem::RegistryChanged
    } else if code.contains("unsupported") {
        MigrationProjectDiscoveryProblem::RegistryUnsupported
    } else {
        MigrationProjectDiscoveryProblem::RegistryUnavailable
    }
}
fn unobserved() -> Vec<MigrationProjectUnobserved> {
    vec![
        MigrationProjectUnobserved::VendorMetadata,
        MigrationProjectUnobserved::SourceTrust,
        MigrationProjectUnobserved::WorktreeContents,
        MigrationProjectUnobserved::SessionRecency,
        MigrationProjectUnobserved::LegacyDesktopRegistry,
    ]
}
impl SourceRegistry {
    pub fn discover_projects(
        &mut self,
        source: MigrationSourceKind,
        cancel: &ProjectReadCancellation,
    ) -> Result<MigrationProjectSourcesResult> {
        self.verify_selected_root(Some(source))?;
        // Project registries need a same-descriptor manifest proof, including committed WAL.
        // The physical Native producer is not permission to reinterpret an uploaded DB.
        ensure!(
            self.uploaded_operation_id().is_none(),
            "migration_project_registry_unsupported"
        );
        self.project_catalogs
            .retain(|_, c| c.created.elapsed() < GRANT_LIFETIME);
        ensure!(
            self.project_catalogs.len() < 4,
            "migration_project_catalog_limit"
        );
        let root = if let Some(selected) = &self.selected_root {
            selected.binding.root().to_owned()
        } else if source == MigrationSourceKind::Codex {
            self.roots
                .codex_home
                .clone()
                .unwrap_or_else(|| self.roots.home.join(".codex"))
        } else {
            // The registered Native home grant includes its known .claude.json leaf. A selected
            // .claude directory never grants the parent or falls back to this default home.
            self.roots.home.clone()
        };
        let captured = match source {
            MigrationSourceKind::ClaudeCode => {
                ProjectRegistryCapture::capture_claude_registry_directory(&root, cancel)
            }
            MigrationSourceKind::Codex => {
                ProjectRegistryCapture::capture_codex_product_directory(&root, cancel)
            }
        }
        .and_then(|capture| {
            capture.with_selected_root(
                self.selected_root
                    .as_ref()
                    .map(|r| r.binding.for_read_scope(false)),
            )
        });
        ensure!(!cancel.is_cancelled(), "migration_project_source_cancelled");
        let (capture, problem) = match captured {
            Ok(capture) => (Some(capture), None),
            Err(error) => (None, Some(source_problem(&error))),
        };
        let handles = capture
            .as_ref()
            .map(|c| {
                c.records()
                    .iter()
                    .map(|_| format!("project-source-{}", uuid::Uuid::new_v4().simple()))
                    .collect()
            })
            .unwrap_or_default();
        let id = format!("projects-{}", uuid::Uuid::new_v4().simple());
        self.project_catalogs.insert(
            id.clone(),
            Catalog {
                created: Instant::now(),
                source,
                capture,
                handles,
                problem,
            },
        );
        self.projects_page(&id, 0, cancel)
    }
    pub fn projects_page(
        &self,
        catalog_id: &str,
        page: u32,
        cancel: &ProjectReadCancellation,
    ) -> Result<MigrationProjectSourcesResult> {
        self.verify_selected_root(None)?;
        let catalog = self.project_catalog(catalog_id)?;
        if let Some(capture) = &catalog.capture {
            capture.validate(cancel)?;
        }
        let start = (page as usize)
            .checked_mul(10)
            .ok_or_else(|| anyhow::anyhow!("migration_invalid_cursor"))?;
        ensure!(start <= catalog.handles.len(), "migration_invalid_cursor");
        let items = catalog
            .capture
            .as_ref()
            .map(|capture| {
                capture
                    .records()
                    .iter()
                    .enumerate()
                    .skip(start)
                    .take(10)
                    .map(|(index, row)| {
                        let label_origin = if catalog.source == MigrationSourceKind::ClaudeCode {
                            MigrationProjectLabelOrigin::PathBasename
                        } else if row.name.is_empty() {
                            MigrationProjectLabelOrigin::OriginalId
                        } else {
                            MigrationProjectLabelOrigin::RegistryName
                        };
                        MigrationProjectSourceSummary {
                            source_handle: catalog.handles[index].clone(),
                            display_name: if row.name.is_empty() {
                                row.id.clone()
                            } else {
                                row.name.clone()
                            },
                            label_origin,
                            original_project_id: (catalog.source == MigrationSourceKind::Codex)
                                .then(|| row.id.clone()),
                            roots: row.roots.len() as u32,
                            position: row.position,
                            source_created_at_ms: row.created_at_ms,
                            source_updated_at_ms: row.updated_at_ms,
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(MigrationProjectSourcesResult {
            catalog_id: catalog_id.to_owned(),
            source: catalog.source,
            page_index: page,
            items,
            total_items: catalog.handles.len() as u32,
            next_page: (start + 10 < catalog.handles.len()).then_some(page + 1),
            known_rows_complete: catalog.capture.is_some(),
            format_revision: catalog
                .capture
                .as_ref()
                .map(|c| c.format_revision().to_owned()),
            unobserved: unobserved(),
            problems: catalog.problem.into_iter().collect(),
        })
    }
    fn project_catalog(&self, id: &str) -> Result<&Catalog> {
        let catalog = self
            .project_catalogs
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("migration_project_catalog_unavailable"))?;
        ensure!(
            catalog.created.elapsed() < GRANT_LIFETIME,
            "migration_project_catalog_expired"
        );
        Ok(catalog)
    }
    pub fn selected_project(
        &self,
        catalog_id: &str,
        handle: &str,
        cancel: &ProjectReadCancellation,
    ) -> Result<ProjectBatchSource> {
        self.verify_selected_root(None)?;
        let catalog = self.project_catalog(catalog_id)?;
        let index = catalog
            .handles
            .iter()
            .position(|h| h == handle)
            .ok_or_else(|| anyhow::anyhow!("migration_project_selection_unknown"))?;
        let capture = catalog
            .capture
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("migration_project_catalog_unavailable"))?;
        capture.selected(&capture.records()[index].id, cancel)
    }
    pub fn project_source_roots(
        &self,
        catalog_id: &str,
        handle: &str,
        page: u32,
        cancel: &ProjectReadCancellation,
    ) -> Result<MigrationProjectSourceRootsResult> {
        let source = self.selected_project(catalog_id, handle, cancel)?;
        let start = (page as usize)
            .checked_mul(10)
            .ok_or_else(|| anyhow::anyhow!("migration_invalid_cursor"))?;
        ensure!(
            start <= source.record().roots.len(),
            "migration_invalid_cursor"
        );
        let roots = source
            .record()
            .roots
            .iter()
            .enumerate()
            .skip(start)
            .take(10)
            .map(|(index, path)| {
                Ok(MigrationProjectSourceRoot {
                    source_root_id: source.source_root_id(index)?,
                    ordinal: index as u32,
                    original_path: path.clone(),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(MigrationProjectSourceRootsResult {
            catalog_id: catalog_id.to_owned(),
            source_handle: handle.to_owned(),
            page_index: page,
            roots,
            total_roots: source.record().roots.len() as u32,
            next_page: (start + 10 < source.record().roots.len()).then_some(page + 1),
        })
    }
}

#[cfg(test)]
mod tests;
