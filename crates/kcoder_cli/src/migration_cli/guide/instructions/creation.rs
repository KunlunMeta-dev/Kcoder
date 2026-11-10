//! Reopening an original request observes or explicitly finishes its sealed capture.
use super::*;
use kcoder_migration::store::{BatchCreationStage as Stage, BatchCreationWorkerState as Worker};
pub(in crate::migration_cli::guide) fn open(guide: &Guide<'_>) -> Result<Option<MigrationJob>> {
    let request = guide.io.text(
        "creation_request_id",
        "原捕获请求 UUID（只核对原拥有者和回执，不重新发现来源）",
        None,
    )?;
    recover(guide, &request)
}
pub(super) fn recover(guide: &Guide<'_>, request: &str) -> Result<Option<MigrationJob>> {
    loop {
        let store = guide.store()?;
        let observation = store.read_batch_creation(request)?;
        guide.io.state("creation",&json!({"requestId":observation.request_id,"jobId":observation.job_id,"stage":format!("{:?}",observation.stage).to_ascii_lowercase(),"workerState":format!("{:?}",observation.worker_state).to_ascii_lowercase(),"controlRevision":observation.control_revision,"cancelRequested":observation.cancel_requested}))?;
        if let Some(job) = observation.job {
            return Ok(Some(job));
        }
        let command=guide.io.ask("creation_control", "read 只读核对；cancel 请求停止本捕获；resume 明确恢复已完整封存的捕获；back 退出保留原ID。部分捕获可从初始 instructions 输入同一原UUID，明确重新授权并核对原选择；不会猜测或换请求。", json!({"canFinishWithoutSource":observation.stage==Stage::Prepared&&observation.worker_state==Worker::Stopped}),Some("read"))?;
        if command == "back" {
            return Ok(None);
        }
        if command == "read" {
            continue;
        }
        ensure!(
            matches!(command.as_str(), "cancel" | "resume"),
            "migration_guide_invalid_selection"
        );
        if command == "resume"
            && (observation.stage != Stage::Prepared || observation.worker_state != Worker::Stopped)
        {
            guide.io.notice(
                "migration_batch_creation_original_source_required",
                "尚未完整封存，或拥有者仍在运行；不能无来源发布。保留原请求，未重试捕获。",
            )?;
            continue;
        }
        let control = guide.io.text(
            "creation_control_id",
            "此次明确控制请求 UUID（留空新建；丢回执时先只读核对原请求）",
            None,
        )?;
        let control = if control.is_empty() {
            uuid::Uuid::new_v4().to_string()
        } else {
            control
        };
        let required = if command == "cancel" {
            "CANCEL"
        } else {
            "RESUME"
        };
        if guide.io.text(
            "creation_confirm",
            &format!(
                "输入 {required} 确认控制原捕获；恢复只发布原封存批次，不导入目标或启用内容。"
            ),
            None,
        )? != required
        {
            continue;
        }
        let fresh = guide.store()?;
        let current = fresh.read_batch_creation(request)?;
        ensure!(
            current.control_revision == observation.control_revision
                && current.stage == observation.stage
                && current.worker_state == observation.worker_state,
            "migration_revision_conflict"
        );
        let revision = current
            .control_revision
            .ok_or_else(|| anyhow::anyhow!("migration_batch_creation_unknown"))?;
        let result = if command == "cancel" {
            fresh.cancel_batch_creation_request(request, &control, revision)
        } else {
            let intent = fresh.batch_creation_intent(request)?;
            fresh
                .resume_batch_creation(&intent, &control, revision)
                .and_then(|resumed| {
                    fresh.continue_batch_creation(
                        &intent,
                        resumed
                            .control_revision
                            .ok_or_else(|| anyhow::anyhow!("migration_batch_creation_unknown"))?,
                        |_| {
                            Err(anyhow::anyhow!(
                                "migration_batch_creation_original_source_required"
                            ))
                        },
                        &mut |_, _| guide.io.active().is_ok(),
                    )
                })
        };
        if let Err(error) = result {
            guide.io.notice(
                &safe_error(&error),
                "未把控制当作成功；先回读同一原请求，不重放变更。",
            )?;
        }
    }
}
