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
            "明确选择历史文件，最多与配置来源合计64项。toggle N 选择/取消，next/prev 翻页，done 固定所选，skip 不选历史。归档与接续是独立步骤，不会运行历史工具或模型。",
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
                    "历史发现不完整。是否仅归档已明确选择的已发现文件？未发现/未选择的记录不会被当作已迁入。")? {
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
                            "该文件有已知阻断项，未选择；不会绕过来源或大小校验。",
                        )?;
                    } else if other_sources.saturating_add(selected.len()) < 64 {
                        selected.insert(item.source_handle.clone());
                    } else {
                        guide.io.notice(
                            "migration_batch_budget_exceeded",
                            "本批配置与历史来源合计最多64项；请明确减少选择。",
                        )?;
                    }
                } else {
                    guide.io.notice(
                        "migration_guide_invalid_selection",
                        "请选择当前页的历史编号。",
                    )?;
                }
            }
            _ => guide.io.notice(
                "migration_guide_invalid_selection",
                "请选择有效操作或当前页编号；未创建历史作业。",
            )?,
        }
    }
}
