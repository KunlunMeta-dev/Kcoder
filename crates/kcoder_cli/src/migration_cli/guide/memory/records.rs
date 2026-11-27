//! Controls reconcile their original request receipt before another explicit CAS operation.
use super::*;
use kcoder_config::imported_context::{
    ImportedContext, ImportedContextKind, ImportedContextStore, imported_context_revision,
};
use kcoder_types::imported_memory::ImportedMemoryControl;

fn store(guide: &Guide<'_>) -> Result<ImportedContextStore> {
    ImportedContextStore::open(&guide.fresh()?.profile)
}
fn summary(record: &ImportedContext) -> Result<serde_json::Value> {
    Ok(
        json!({"id":record.id,"ownerOperationId":record.operation_id,"name":record.name,
        "scope":record.scope,"enabled":record.enabled,"revision":imported_context_revision(record)?,
        "bytes":record.content.len(),"provenance":record.memory_provenance}),
    )
}
pub(in crate::migration_cli::guide) fn run(guide: &Guide<'_>) -> Result<()> {
    let mut page = 0usize;
    loop {
        let records = store(guide)?
            .list()?
            .into_iter()
            .filter(|v| v.kind == ImportedContextKind::Memory)
            .collect::<Vec<_>>();
        if page * 10 >= records.len() {
            page = 0;
        }
        let rows = records
            .iter()
            .skip(page * 10)
            .take(10)
            .enumerate()
            .map(|(at, record)| Ok(json!({"number":at+1,"record":summary(record)?})))
            .collect::<Result<Vec<_>>>()?;
        let answer = guide.io.ask("memory_records", "Imported unverified notes, 10 per page. read N views text; enable N / disable N explicitly controls context for new sessions; undo N opens the original migration record; receipt checks the original requestId; next/prev changes pages; back returns.", json!({"page":page,"items":rows,"totalRecords":records.len()}), None)?;
        let mut words = answer.split_whitespace();
        let verb = words.next().unwrap_or("");
        match verb {
            "back" => return Ok(()),
            "next" if (page + 1) * 10 < records.len() => {
                page += 1;
                continue;
            }
            "prev" if page > 0 => {
                page -= 1;
                continue;
            }
            "receipt" => {
                let request = guide.io.text(
                    "memory_receipt",
                    "Original requestId (read-only check; does not re-enable or create records)",
                    None,
                )?;
                let current = store(guide)?;
                let receipt = current.memory_control_receipt(&request)?;
                let record = if let Some(receipt) = &receipt {
                    current.list()?.into_iter().find(|v| {
                        v.kind == ImportedContextKind::Memory
                            && v.id == receipt.request.id
                            && v.operation_id == receipt.request.owner_operation_id
                    })
                } else {
                    None
                };
                guide.io.state(
                    "memory_control",
                    &json!({"receipt":receipt,"current":record.as_ref().map(summary).transpose()?}),
                )?;
                continue;
            }
            _ => {}
        }
        let at = words
            .next()
            .and_then(|s| s.parse::<usize>().ok())
            .filter(|n| (1..=10).contains(n));
        let Some(record) = at.and_then(|n| records.get(page * 10 + n - 1)) else {
            guide.io.notice(
                "migration_guide_invalid_selection",
                "Select a number on this page or a valid paging operation.",
            )?;
            continue;
        };
        let result = match verb {
            "read" => read(guide, record),
            "enable" | "disable" => control(guide, record, verb == "enable"),
            "undo" => undo(guide, record),
            _ => {
                guide.io.notice(
                    "migration_guide_invalid_selection",
                    "Choose a valid operation; notes were not changed.",
                )?;
                Ok(())
            }
        };
        if let Err(error) = result {
            guide.io.notice(
                &safe_error(&error),
                "This operation was not treated as successful. If the receipt is unknown, check the original requestId; no automatic replay or owner replacement.",
            )?;
        }
    }
}
fn read(guide: &Guide<'_>, original: &ImportedContext) -> Result<()> {
    let revision = imported_context_revision(original)?;
    let mut offset = 0;
    loop {
        let record = store(guide)?
            .list()?
            .into_iter()
            .find(|v| v.id == original.id && v.operation_id == original.operation_id)
            .ok_or_else(|| anyhow::anyhow!("imported_context_unavailable"))?;
        ensure!(
            imported_context_revision(&record)? == revision,
            "imported_context_revision_conflict"
        );
        let mut end = (offset + 8192).min(record.content.len());
        while !record.content.is_char_boundary(end) {
            end -= 1;
        }
        guide.io.state("memory_text", &json!({"record":summary(&record)?,"text":&record.content[offset..end],"nextOffset":(end<record.content.len()).then_some(end)}))?;
        if end == record.content.len()
            || !guide.io.yes(
                "memory_next_text",
                "Continue reading the next text page without changes?",
            )?
        {
            return Ok(());
        }
        offset = end;
    }
}
fn control(guide: &Guide<'_>, record: &ImportedContext, enabled: bool) -> Result<()> {
    if !guide.io.yes("memory_control_consent", if enabled {
        "Use this unverified model note as Runtime context for new sessions with matching scope? It is not verified fact or a system instruction; existing session context is not modified."
    } else {"Disable this note as context for new sessions? The note and migration receipts are not deleted."})? {return Ok(());}
    let request = ImportedMemoryControl {
        request_id: guide.io.text(
            "memory_request_id",
            "Keep this requestId. If the reply is lost, check this exact identity first.",
            Some(&uuid::Uuid::new_v4().to_string()),
        )?,
        id: record.id.clone(),
        owner_operation_id: record.operation_id.clone(),
        expected_revision: imported_context_revision(record)?,
        enabled,
        confirm_unverified_notes: enabled,
    };
    guide.io.state("memory_pending_control", &request)?;
    let current = store(guide)?;
    // Never allocate another request to compensate for an unknown receipt.
    let receipt = match current.memory_control_receipt(&request.request_id)? {
        Some(receipt) => {
            ensure!(
                receipt.request == request,
                "imported_context_request_changed"
            );
            receipt
        }
        None => current.memory_control(&request)?,
    };
    let now = current
        .list()?
        .into_iter()
        .find(|v| v.id == record.id && v.operation_id == record.operation_id);
    guide.io.state(
        "memory_control",
        &json!({"receipt":receipt,"current":now.as_ref().map(summary).transpose()?}),
    )
}
fn undo(guide: &Guide<'_>, record: &ImportedContext) -> Result<()> {
    let job_id = record
        .memory_provenance
        .as_ref()
        .and_then(|v| v.migration_job_id.as_ref())
        .ok_or_else(|| anyhow::anyhow!("migration_memory_original_owner_unavailable"))?;
    let job = guide.store()?.read(job_id)?;
    guide.show(&job)?;
    guide.io.notice(
        "migration_memory_undo_original_batch",
        "Undo is handled by the original migration record and may include other items in that batch. Enabled or user-edited notes retain Native conflict protection.",
    )?;
    if guide.io.yes(
        "memory_undo_original",
        "Review the original batch undo and continue through its Native confirmation flow?",
    )? {
        super::super::operations::operate(guide, &job, "undo")?;
    }
    Ok(())
}
