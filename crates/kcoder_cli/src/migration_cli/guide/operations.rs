//! Read before confirmation; the native journal, not the terminal projection, owns execution facts.
use super::*;
use kcoder_migration::batch::execution::{BatchExecution, BatchRunEvent, BatchRunMode};
use kcoder_types::migration::MigrationJobStatus as Status;
use serde_json::json;

pub(super) fn results(guide: &Guide<'_>, job: &MigrationJob) -> Result<()> {
    let mut page = 0usize;
    loop {
        let current = guide.store()?.read(&job.job_id)?;
        guide.show(&current)?;
        guide.io.state(
            "plan_details",
            &super::view::plans(&guide.store()?, &current, page, &guide.context.profile)?,
        )?;
        let mut rows = crate::migration_view::items_result(&current, None, Some(page))?;
        crate::migration_view::include_template_candidates(&current, &mut rows);
        guide.io.state("items", &rows)?;
        match guide
            .io
            .text(
                "results_page",
                "结果每页最多10项。next/prev 翻页；back 返回；查看不会执行迁移。",
                Some("back"),
            )?
            .as_str()
        {
            "next" if (page + 1) * 10 < current.inventory.items.len() => page += 1,
            "prev" if page > 0 => page -= 1,
            "back" => return Ok(()),
            _ => guide.io.notice(
                "migration_guide_invalid_selection",
                "请选择有效结果页；未修改目标。",
            )?,
        }
    }
}
fn request(
    guide: &Guide<'_>,
    job: &MigrationJob,
    operation: &str,
    plan: &str,
) -> Result<(String, BatchRunMode)> {
    let batch = job
        .batch
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("migration_not_a_batch"))?;
    let mut mode = match operation {
        "undo" => BatchRunMode::Rollback,
        "resume" => BatchRunMode::Resume,
        _ => BatchRunMode::Apply,
    };
    let kind = if operation == "undo" {
        "rollback"
    } else {
        operation
    };
    let mut proposed = format!("terminal-{kind}-{plan}");
    let historical_resume = operation == "resume"
        && batch
            .sources
            .iter()
            .any(|source| matches!(source, kcoder_migration::batch::BatchSource::History(_)));
    if historical_resume {
        // Explicit native Resume also acknowledges a stopped child while its parent is Applying.
        proposed.push_str(&format!("-{}", job.sequence));
    }
    if operation == "resume" && matches!(job.status, Status::Cancelled | Status::CancelRequested) {
        // A new, explicitly confirmed resume acknowledges this exact cancellation watermark.
        if !historical_resume {
            proposed.push_str(&format!("-{}", job.sequence));
        }
    } else if operation == "resume" {
        let prefix = format!("terminal-resume-{plan}-");
        if let Some((key, _)) = batch
            .request_kinds
            .iter()
            .filter(|(key, kind)| key.starts_with(&prefix) && kind.as_str() == "resume")
            .max_by_key(|(key, _)| {
                key.rsplit('-')
                    .next()
                    .and_then(|n| n.parse::<u64>().ok())
                    .unwrap_or(0)
            })
        {
            proposed = key.clone();
        } else if !historical_resume
            && batch
                .request_kinds
                .get(&format!("terminal-apply-{plan}"))
                .is_some_and(|k| k == "apply")
        {
            proposed = format!("terminal-apply-{plan}");
            mode = BatchRunMode::Apply;
        }
    }
    let acknowledging_cancel =
        operation == "resume" && matches!(job.status, Status::Cancelled | Status::CancelRequested);
    let pending = if operation == "undo" {
        job.status == Status::RollingBack
    } else {
        !acknowledging_cancel
            && !historical_resume
            && (matches!(job.status, Status::Applying | Status::RollingBack)
                || crate::migration_view::read_result(job)
                    .job
                    .has_unconfirmed_outcomes)
    };
    let default =
        (!pending || batch.request_kinds.contains_key(&proposed)).then_some(proposed.as_str());
    let id = guide.io.text(
        "request_id",
        if pending && default.is_none() {
            "该操作可能由其他入口执行。请输入原 requestId 核对；不会换新请求猜测结果。"
        } else {
            "保存本次 requestId；回执丢失必须先 read 同一作业并复用本身份。"
        },
        default,
    )?;
    ensure!(
        !id.is_empty()
            && id.len() <= 256
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_:.".contains(&b)),
        "migration_invalid_request_reference"
    );
    if pending {
        let original = batch
            .request_kinds
            .get(&id)
            .ok_or_else(|| anyhow::anyhow!("migration_guide_original_request_required"))?;
        mode = match (operation, original.as_str()) {
            ("apply" | "resume", "apply") => BatchRunMode::Apply,
            ("resume", "resume") => BatchRunMode::Resume,
            ("undo", "rollback") => BatchRunMode::Rollback,
            _ => anyhow::bail!("migration_request_conflict"),
        };
    }
    Ok((id, mode))
}
pub(super) fn operate(
    guide: &Guide<'_>,
    previous: &MigrationJob,
    operation: &str,
) -> Result<MigrationJob> {
    let store = guide.store()?;
    let job = store.read(&previous.job_id)?;
    let plan = job
        .batch
        .as_ref()
        .and_then(|b| b.plan_id.clone())
        .ok_or_else(|| anyhow::anyhow!("migration_guide_preview_required"))?;
    guide.show(&job)?;
    guide.io.state(
        "plan_details",
        &super::view::plans(&store, &job, 0, &guide.context.profile)?,
    )?;
    ensure!(
        operation != "apply" || job.status != Status::Cancelled,
        "migration_explicit_resume_required"
    );
    let (request_id, mode) = request(guide, &job, operation, &plan)?;
    let token = if operation == "undo" {
        "UNDO"
    } else if operation == "resume" {
        "RESUME"
    } else {
        "IMPORT"
    };
    if operation == "undo" && job.batch.as_ref().is_some_and(|batch| batch.actions.iter().any(|action|
        matches!(&action.action, kcoder_migration::batch::BatchActionKind::History { .. })
            || matches!(&action.action, kcoder_migration::batch::BatchActionKind::Reuse { proof } if proof.history_job_id.is_some())
    )) {
        guide.io.notice("migration_history_retirement_required",
            "历史档案不会由普通撤销删除，需单独授权的退休流程。可撤销的配置和资产仍按原回执处理；若历史返回冲突，会明确保留该状态，不视为整批已撤销。")?;
    }
    let confirmation=guide.io.ask("confirm_operation","核对目标、逐项计划、状态与回执。只保存/恢复该固定计划，不运行来源程序；撤销会保留用户编辑或后来复用而报告冲突。输入明确确认词执行，其他回答返回。",json!({"profileDirectory":guide.context.profile,"workspaceDirectory":guide.context.cwd,"jobId":job.job_id,"planId":plan,"sequence":job.sequence,"requestId":request_id,"operation":operation,"confirmation":token}),None)?;
    if confirmation != token {
        guide
            .io
            .notice("migration_guide_not_confirmed", "未确认，未提交目标变更。")?;
        return Ok(job);
    }
    let context = guide.fresh()?;
    for action in &job
        .batch
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("migration_not_a_batch"))?
        .actions
    {
        if let kcoder_migration::batch::BatchActionKind::Settings { plan } = &action.action {
            for step in &plan.steps {
                match step {
                    kcoder_migration::batch::settings::SettingsStep::Provider(_) => {
                        super::super::settings_targets::writable(&context, &job, &["providers"])?
                    }
                    kcoder_migration::batch::settings::SettingsStep::Mcp(_) => {
                        super::super::settings_targets::writable(
                            &context,
                            &job,
                            &["mcp_servers", "mcp_disabled_servers"],
                        )?
                    }
                }
            }
        }
    }
    guide.io.state("operation",&json!({"jobId":job.job_id,"planId":plan,"expectedSequence":job.sequence,"requestId":request_id,"operation":operation}))?;
    if job.batch.as_ref().is_some_and(|batch| {
        batch
            .sources
            .iter()
            .any(|source| matches!(source, kcoder_migration::batch::BatchSource::Project(_)))
    }) {
        return super::projects::operate(guide, &job, &plan, &request_id, mode);
    }
    let mut progress = super::progress::Progress::default();
    super::super::batch::with_targets(&context, &job, false, |targets| {
        store.run_batch_controlled(
            BatchExecution {
                job_id: &job.job_id,
                plan_id: &plan,
                request_id: &request_id,
                expected_sequence: job.sequence,
                mode,
            },
            targets,
            &mut |event| {
                if guide.cancelled.load(Ordering::Acquire) {
                    return false;
                }
                match event {
                    BatchRunEvent::Action { index, total, .. } => guide
                        .io
                        .state(
                            "progress",
                            &json!({"actionIndex":index,"totalActions":total}),
                        )
                        .is_ok(),
                    BatchRunEvent::Checkpoint => true,
                    BatchRunEvent::History { action_id, event } => {
                        progress.history(guide, action_id, event)
                    }
                }
            },
        )
    })
}
