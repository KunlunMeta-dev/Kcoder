//! The native catalog grants only the history files explicitly selected on its bounded pages.
use super::*;
use kcoder_migration::{
    batch::{BatchSource, history::HistoryBatchSource},
    discovery::SourceRegistry,
};
use kcoder_types::migration::MigrationSourceKind;
use serde_json::json;
use std::collections::BTreeSet;

pub(super) fn choose(
    guide: &Guide<'_>,
    registry: &mut SourceRegistry,
    kind: MigrationSourceKind,
    other_sources: usize,
) -> Result<Vec<BatchSource>> {
    guide.io.active()?;
    let first = registry.discover_history(kind, |_| !guide.cancelled.load(Ordering::Acquire))?;
    let catalog = first.catalog_id.clone();
    let mut page = first;
    let mut cursors = vec![None];
    let mut index = 0usize;
    let mut selected = BTreeSet::<String>::new();
    loop {
        guide.fresh()?;
        ensure!(
            page.items.len() <= 10,
            "migration_guide_invalid_history_page"
        );
        let rows = page
            .items
            .iter()
            .enumerate()
            .map(|(at, item)| {
                json!({
                    "number":at+1,"selected":selected.contains(&item.source_handle),
                    "title":item.title,"sourceSessionId":item.source_session_id,
                    "bytes":item.bytes,"archived":item.archived,"compressed":item.compressed,
                    "previewIncomplete":item.preview_incomplete,"importIssues":item.import_issues
                })
            })
            .collect::<Vec<_>>();
        let answer = guide.io.ask(
            "history_selection",
            "Explicitly select history files, with up to 64 configuration/history sources combined. toggle N selects/deselects; next/prev changes pages; done fixes the selection; skip excludes history. Archiving and continuation are separate steps; historical tools and models are not run.",
            json!({"page":index,"selected":selected.len(),"totalItems":page.total_items,
                "discoveryComplete":page.discovery_complete,"problems":page.problems,
                "hasNextPage":page.next_cursor.is_some(),"items":rows}),
            None,
        )?;
        let mut words = answer.split_whitespace();
        match words.next().unwrap_or("") {
            "skip" => return Ok(Vec::new()),
            "done" => {
                if !page.discovery_complete && !guide.io.yes("history_partial_consent",
                    "History discovery is incomplete. Archive only the discovered files you explicitly selected? Undiscovered or unselected records will not be reported as imported.")? {
                    continue;
                }
                guide.fresh()?;
                let inputs = selected
                    .iter()
                    .map(|handle| {
                        Ok(BatchSource::History(Box::new(HistoryBatchSource::new(
                            registry.history_selection(&catalog, handle)?.pin()?,
                        )?)))
                    })
                    .collect::<Result<Vec<_>>>()?;
                return Ok(inputs);
            }
            "next" if page.next_cursor.is_some() => {
                cursors.truncate(index + 1);
                cursors.push(page.next_cursor.clone());
                index += 1;
                page = registry.history_page(&catalog, cursors[index].as_deref(), |_| {
                    !guide.cancelled.load(Ordering::Acquire)
                })?;
            }
            "prev" if index > 0 => {
                index -= 1;
                page = registry.history_page(&catalog, cursors[index].as_deref(), |_| {
                    !guide.cancelled.load(Ordering::Acquire)
                })?;
            }
            "toggle" => {
                let item = words
                    .next()
                    .and_then(|n| n.parse::<usize>().ok())
                    .and_then(|n| n.checked_sub(1))
                    .and_then(|n| page.items.get(n));
                if let Some(item) = item {
                    if selected.remove(&item.source_handle) {
                        continue;
                    }
                    if !item.import_issues.is_empty() {
                        guide.io.notice(
                            "migration_history_source_blocked",
                            "This file has known blockers and was not selected; source and size checks are not bypassed.",
                        )?;
                    } else if other_sources.saturating_add(selected.len()) < 64 {
                        selected.insert(item.source_handle.clone());
                    } else {
                        guide.io.notice(
                            "migration_batch_budget_exceeded",
                            "This batch allows up to 64 configuration/history sources combined. Explicitly reduce the selection.",
                        )?;
                    }
                } else {
                    guide.io.notice(
                        "migration_guide_invalid_selection",
                        "Select a history number on the current page.",
                    )?;
                }
            }
            _ => guide.io.notice(
                "migration_guide_invalid_selection",
                "Choose a valid operation or a number on this page; no history job was created.",
            )?,
        }
    }
}
