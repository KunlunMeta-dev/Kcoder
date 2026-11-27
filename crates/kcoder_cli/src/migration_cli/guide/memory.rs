//! Explicit note selection never treats opaque source labels as destination authority.
use super::*;
use kcoder_migration::{batch::BatchSource, discovery::SourceRegistry};
use kcoder_types::{imported_memory::ImportedMemoryMapping, migration::MigrationSourceKind};
use serde_json::json;
use std::collections::BTreeSet;
#[path = "memory/records.rs"]
mod records;
pub(super) use records::run as records;

pub(super) fn mapping(guide: &Guide<'_>) -> Result<ImportedMemoryMapping> {
    match guide.io.ask("memory_mapping", "Source memory consists of unverified notes and remains disabled after import. Explicitly map it to user scope or the current trusted working directory; paths are not inferred from source labels.", json!([
        {"value":"global","label":"User scope (enabling requires separate confirmation)"},
        {"value":"current_workspace","label":"Current trusted working directory"}
    ]), None)?.as_str() {
        "global" => Ok(ImportedMemoryMapping::Global),
        "current_workspace" => {
            let context = guide.fresh()?;
            kcoder_config::imported_context::ImportedContextStore::open(&context.profile)?
                .capture_memory_workspace(&kcoder_config::imported_context::ImportedContextScope::Project { root:context.cwd })?;
            Ok(ImportedMemoryMapping::CurrentWorkspace)
        }
        _ => anyhow::bail!("migration_memory_scope_required"),
    }
}

pub(super) fn choose(
    guide: &Guide<'_>,
    registry: &mut SourceRegistry,
    source: MigrationSourceKind,
    other_sources: usize,
) -> Result<Vec<BatchSource>> {
    let mut check = |_| !guide.cancelled.load(Ordering::Acquire);
    let mut page = registry.discover_memories(source, &mut check)?;
    let catalog = page.catalog_id.clone();
    let mut cursors = vec![None];
    let mut page_index = 0usize;
    let mut selected = BTreeSet::<String>::new();
    loop {
        guide.fresh()?;
        let rows = page.items.iter().enumerate().map(|(at,item)| json!({
            "number":at+1,"selected":selected.contains(&item.source_id),"source":item.source,
            "layout":item.layout,"sourceGroup":item.source_group,"files":item.files,
            "bytes":item.bytes,"blockedItems":item.blocked_items
        })).collect::<Vec<_>>();
        let answer = guide.io.ask("memory_selection", "10 static sources per page. toggle N selects/deselects; next/prev changes pages; done fixes the selection; skip skips. Original directory labels are not target paths; notes are not verified facts or system instructions.", json!({"page":page_index,"items":rows,"selected":selected.len(),"hasNextPage":page.next_cursor.is_some(),"problems":page.problems,"unobserved":page.unobserved}), None)?;
        let mut words = answer.split_whitespace();
        match words.next().unwrap_or("") {
            "skip" => return Ok(Vec::new()),
            "done" => {
                return selected
                    .iter()
                    .map(|id| registry.selected_asset(id).map(BatchSource::Assets))
                    .collect();
            }
            "next" if page.next_cursor.is_some() => {
                cursors.truncate(page_index + 1);
                cursors.push(page.next_cursor.clone());
                page_index += 1;
                page =
                    registry.memory_page(&catalog, cursors[page_index].as_deref(), &mut check)?;
            }
            "prev" if page_index > 0 => {
                page_index -= 1;
                page =
                    registry.memory_page(&catalog, cursors[page_index].as_deref(), &mut check)?;
            }
            "toggle" => {
                let item = words
                    .next()
                    .and_then(|v| v.parse::<usize>().ok())
                    .and_then(|v| v.checked_sub(1))
                    .and_then(|at| page.items.get(at));
                if let Some(item) = item {
                    if selected.remove(&item.source_id) {
                        continue;
                    }
                    if item.blocked_items > 0 {
                        guide.io.notice(
                            "migration_memory_source_blocked",
                            "This source has blockers and was not selected; source checks are not bypassed and nothing is executed.",
                        )?;
                    } else if other_sources + selected.len() < 64 {
                        selected.insert(item.source_id.clone());
                    } else {
                        guide.io.notice(
                            "migration_batch_budget_exceeded",
                            "This batch allows up to 64 sources combined. Explicitly reduce the selection.",
                        )?;
                    }
                } else {
                    guide.io.notice(
                        "migration_guide_invalid_selection",
                        "Select a number on this page.",
                    )?;
                }
            }
            _ => guide.io.notice(
                "migration_guide_invalid_selection",
                "Choose a valid operation; memory was not created or enabled.",
            )?,
        }
    }
}
