//! Selection never decodes an opaque source handle into a filesystem path.
use super::*;
use serde_json::json;
use std::collections::BTreeSet;

pub(in crate::migration_cli) async fn sources(
    io: &GuideIo,
    client: &mut impl Client,
    source: MigrationSourceKind,
    other: usize,
) -> Result<Vec<MigrationBatchProjectSource>> {
    let first: MigrationProjectSourcesResult = read(
        client,
        method::MIGRATION_PROJECTS_DISCOVER,
        &MigrationProjectsDiscoverParams { source },
    )
    .await?;
    source_page(&first, source, None, 0)?;
    let catalog = first.catalog_id.clone();
    let complete = first.known_rows_complete;
    let total = first.total_items;
    let format = first.format_revision.clone();
    let mut current = first;
    let mut selected = BTreeSet::<String>::new();
    loop {
        io.active()?;
        let rows=current.items.iter().enumerate().map(|(i,row)|json!({"number":i+1,"title":row.display_name,"roots":row.roots,"originalProjectId":row.original_project_id,"selected":selected.contains(&row.source_handle)})).collect::<Vec<_>>();
        let answer=io.ask("project_sources","Project lists retain only known original names, order and root path provenance. Worktrees, trust and authentication are not migrated. toggle N selects/deselects; roots N reads provenance; next/prev changes pages; done fixes the selection; skip returns.",json!({"page":current.page_index,"items":rows,"selected":selected.len(),"totalItems":current.total_items,"knownRowsComplete":complete,"problems":current.problems,"unobserved":current.unobserved}),None)?;
        let mut words = answer.split_whitespace();
        match words.next().unwrap_or("") {
            "skip" => return Ok(Vec::new()),
            "done" if !selected.is_empty() => {
                if !complete && !io.yes("project_partial_consent","The source explicitly reported an incomplete project list. Retain only observed, explicitly selected projects? This will not be called a complete project import.")? {continue;}
                return Ok(selected
                    .into_iter()
                    .map(|source_handle| MigrationBatchProjectSource {
                        catalog_id: catalog.clone(),
                        source_handle,
                    })
                    .collect());
            }
            direction @ ("next" | "prev") => {
                let next = if direction == "next" {
                    current.next_page
                } else {
                    current.page_index.checked_sub(1)
                };
                if let Some(index) = next {
                    let result: MigrationProjectSourcesResult = read(
                        client,
                        method::MIGRATION_PROJECTS_SOURCES,
                        &MigrationProjectsSourcesParams {
                            catalog_id: catalog.clone(),
                            page_index: index,
                        },
                    )
                    .await?;
                    source_page(&result, source, Some(&catalog), index)?;
                    ensure!(
                        result.known_rows_complete == complete
                            && result.total_items == total
                            && result.format_revision == format,
                        "migration_project_catalog_changed"
                    );
                    current = result;
                }
            }
            verb @ ("toggle" | "roots") => {
                let row = words
                    .next()
                    .and_then(|v| v.parse::<usize>().ok())
                    .filter(|n| (1..=10).contains(n))
                    .and_then(|n| current.items.get(n - 1));
                let Some(row) = row else {
                    io.notice(
                        "migration_project_invalid_selection",
                        "Select a number on this page.",
                    )?;
                    continue;
                };
                if verb == "roots" {
                    let mut index = 0;
                    loop {
                        let result: MigrationProjectSourceRootsResult = read(
                            client,
                            method::MIGRATION_PROJECTS_SOURCE_ROOTS,
                            &MigrationProjectSourceRootsParams {
                                catalog_id: catalog.clone(),
                                source_handle: row.source_handle.clone(),
                                page_index: index,
                            },
                        )
                        .await?;
                        page(
                            index,
                            result.next_page,
                            result.roots.len(),
                            result.total_roots,
                        )?;
                        ensure!(
                            result.catalog_id == catalog
                                && result.source_handle == row.source_handle
                                && result.page_index == index,
                            "migration_project_invalid_response"
                        );
                        let reply = io.ask(
                            "project_source_roots",
                            "These original paths are provenance only; they do not authorize opening source or target directories. next/prev/back.",
                            serde_json::to_value(&result)?,
                            Some("back"),
                        )?;
                        match reply.as_str() {
                            "next" if result.next_page.is_some() => {
                                index = result.next_page.unwrap()
                            }
                            "prev" if index > 0 => index -= 1,
                            _ => break,
                        }
                    }
                } else if !selected.remove(&row.source_handle) {
                    ensure!(
                        row.roots > 0 && row.roots <= 16,
                        "migration_project_source_unavailable"
                    );
                    ensure!(
                        selected.len() + other < 64,
                        "migration_batch_budget_exceeded"
                    );
                    selected.insert(row.source_handle.clone());
                }
            }
            _ => io.notice(
                "migration_project_invalid_selection",
                "Select a project on this page or a valid operation; no target associations were created.",
            )?,
        }
    }
}
