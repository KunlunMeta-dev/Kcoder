//! Definitions enter the ordinary immutable batch only after explicit passive-source selection.
use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use kcoder_migration::{batch::BatchSource, discovery::SourceRegistry};
use kcoder_types::migration::{MigrationCategory as Category, MigrationSourceKind};
use serde_json::json;
use std::collections::BTreeSet;
pub(super) fn choose(
    guide: &Guide<'_>,
    registry: &mut SourceRegistry,
    kind: MigrationSourceKind,
    include_project: bool,
    other: usize,
) -> Result<Vec<BatchSource>> {
    let mut page = registry.definition_page(&[kind], include_project, None, 0)?;
    let catalog = page.catalog_id.clone();
    let mut index = 0;
    let mut selected = BTreeSet::<String>::new();
    loop {
        guide.fresh()?;
        let rows=page.sources.iter().enumerate().map(|(at,row)|json!({"number":at+1,"sourceId":row.source_id,"scope":row.scope,"categories":row.categories,"selected":selected.contains(&row.source_id)})).collect::<Vec<_>>();
        let answer=guide.io.ask("definition_selection","Up to 10 sources per page. toggle N selects/deselects; next/prev changes pages; done fixes the selection; skip skips. Originals are saved as pending by default. Compatible Agents require separate explicit review/adaptation during batch selection and remain disabled after import. Hooks are not executed.",json!({"page":index,"items":rows,"selected":selected.len(),"hasNextPage":page.next_page.is_some(),"problems":page.problems.iter().map(|problem|json!({"scope":problem.scope,"code":problem.code})).collect::<Vec<_>>()}),None)?;
        let mut words = answer.split_whitespace();
        match words.next().unwrap_or("") {
            "skip" => return Ok(Vec::new()),
            "done" => {
                return selected
                    .iter()
                    .map(|id| registry.selected_asset(id).map(BatchSource::Assets))
                    .collect();
            }
            "next" if page.next_page.is_some() => {
                index += 1;
                page = registry.definition_page(&[kind], include_project, Some(&catalog), index)?;
            }
            "prev" if index > 0 => {
                index -= 1;
                page = registry.definition_page(&[kind], include_project, Some(&catalog), index)?;
            }
            "toggle" => {
                let row = words
                    .next()
                    .and_then(|n| n.parse::<usize>().ok())
                    .and_then(|n| n.checked_sub(1))
                    .and_then(|n| page.sources.get(n));
                if let Some(row) = row {
                    if !selected.remove(&row.source_id) {
                        ensure!(
                            other + selected.len() < 64,
                            "migration_batch_budget_exceeded"
                        );
                        selected.insert(row.source_id.clone());
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
                "Choose a valid operation; no source definitions were executed.",
            )?,
        }
    }
}
pub(super) fn saved(guide: &Guide<'_>, job: &MigrationJob) -> Result<()> {
    let items = job
        .inventory
        .items
        .iter()
        .filter(|item| matches!(item.preview.category, Category::Agent | Category::Hook))
        .collect::<Vec<_>>();
    let mut page = 0;
    loop {
        guide.fresh()?;
        let answer=guide.io.ask("definition_saved","Select a number on this page to view the original record field report; next/prev changes pages; back returns. Prepared snapshots remain readable after the originals are moved.",json!({"page":page,"items":items.iter().skip(page*10).take(10).enumerate().map(|(at,item)|json!({"number":at+1,"item":item.preview})).collect::<Vec<_>>()}),None)?;
        match answer.as_str() {
            "back" => return Ok(()),
            "next" if (page + 1) * 10 < items.len() => page += 1,
            "prev" if page > 0 => page -= 1,
            _ => {
                if let Some(item) = answer
                    .parse::<usize>()
                    .ok()
                    .and_then(|n| n.checked_sub(1))
                    .filter(|n| *n < 10)
                    .and_then(|n| items.get(page * 10 + n))
                {
                    preview(guide, job, &item.preview.id)?;
                } else {
                    guide.io.notice(
                        "migration_guide_invalid_selection",
                        "Select a number on this page.",
                    )?;
                }
            }
        }
    }
}
pub(super) fn preview(guide: &Guide<'_>, job: &MigrationJob, item: &str) -> Result<()> {
    let snapshot = guide.store()?.definition_snapshot(&job.job_id, item)?;
    let mut page = 0;
    loop {
        let mut report = snapshot.report.clone();
        report.fields = report.fields.into_iter().skip(page * 10).take(10).collect();
        guide.io.state("definition_report",&json!({"jobId":job.job_id,"itemId":item,"report":report,"pageIndex":page,"totalFields":snapshot.report.fields.len(),"totalBytes":snapshot.bytes.len()}))?;
        match guide
            .io
            .text(
                "definition_page",
                "next/prev changes field pages; body explicitly reads the original definition without executing it; back returns.",
                None,
            )?
            .as_str()
        {
            "back" => return Ok(()),
            "next" if (page + 1) * 10 < snapshot.report.fields.len() => page += 1,
            "prev" if page > 0 => page -= 1,
            "body" => body(guide, &snapshot.bytes)?,
            _ => guide
                .io
                .notice("migration_guide_invalid_selection", "Choose a valid operation.")?,
        }
    }
}
fn body(guide: &Guide<'_>, bytes: &[u8]) -> Result<()> {
    let text = std::str::from_utf8(bytes).ok();
    let mut start = 0;
    loop {
        guide.fresh()?;
        let mut end = (start + 16 * 1024).min(bytes.len());
        if let Some(text) = text {
            while !text.is_char_boundary(end) {
                end -= 1;
            }
        }
        guide.io.state("definition_body",&json!({"offset":start,"text":text.map(|text|&text[start..end]),"bytesBase64":text.is_none().then(||STANDARD.encode(&bytes[start..end])),"totalBytes":bytes.len(),"requiresReview":true,"executionAllowed":false}))?;
        if end == bytes.len()
            || !guide.io.yes(
                "definition_next_body",
                "Explicitly read the next section of the original definition?",
            )?
        {
            return Ok(());
        }
        start = end;
    }
}
