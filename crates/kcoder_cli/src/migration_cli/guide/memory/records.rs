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
        let answer = guide.io.ask("memory_records", "已迁入的未验证笔记，每页10项。read N 查看正文；enable N / disable N 明确控制新会话上下文；undo N 打开原迁移记录；receipt 核对原requestId；next/prev 翻页；back 返回。", json!({"page":page,"items":rows,"totalRecords":records.len()}), None)?;
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
                    "原 requestId（只读核对，不重新启用或创建记录）",
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
                "请选择本页编号或有效翻页操作。",
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
                    "请选择有效操作；未改变笔记。",
                )?;
                Ok(())
            }
        };
        if let Err(error) = result {
            guide.io.notice(
                &safe_error(&error),
                "没有将此操作当作成功。若回执不明，用原 requestId 核对；不会自动重放或换 owner。",
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
            || !guide.io.yes("memory_next_text", "继续只读下一页正文？")?
        {
            return Ok(());
        }
        offset = end;
    }
}
fn control(guide: &Guide<'_>, record: &ImportedContext, enabled: bool) -> Result<()> {
    if !guide.io.yes("memory_control_consent", if enabled {
        "确认把此未验证的模型笔记用于范围匹配的新会话 Runtime 上下文？它不是已验证事实或系统指令；不会修改已有会话上下文。"
    } else {"确认停用此笔记的新会话上下文？不删除笔记或迁移回执。"})? {return Ok(());}
    let request = ImportedMemoryControl {
        request_id: guide.io.text(
            "memory_request_id",
            "保留此 requestId；若丢失回复只能先核对这个身份。",
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
        "撤销由原迁移记录处理，可能包含同批其他项目；启用或用户修改的笔记仍受原生冲突保护。",
    )?;
    if guide.io.yes(
        "memory_undo_original",
        "是否查看原批次撤销并按其原生确认流程继续？",
    )? {
        super::super::operations::operate(guide, &job, "undo")?;
    }
    Ok(())
}
