//! Publication remains an explicit terminal operation; no model request follows it.
use super::*;
use kcoder_app_protocol::{MigrationContinuationCreateParams, method};
use kcoder_types::{StudioWorkMode, historical_continuation::HistoricalContinuationOptions};
use std::time::{Duration, Instant};

pub(super) fn handles(action: &HistoryAction) -> bool {
    matches!(
        action,
        HistoryAction::Continue { .. }
            | HistoryAction::ContinuationRead { .. }
            | HistoryAction::ContinuationResume { .. }
            | HistoryAction::ContinuationCancel { .. }
            | HistoryAction::Source { .. }
    )
}

pub(super) fn run(
    action: &HistoryAction,
    context: &Context,
    overlays: &[PathBuf],
    cancelled: &AtomicBool,
) -> Result<()> {
    let mut client = rpc::Client::start(context, overlays)?;
    client.require_capability("migrationContinuationV1")?;
    let result = match action {
        HistoryAction::Continue {
            job_id,
            view_id,
            request_id,
            model,
            settings_template,
            local,
        } => {
            let local_attachments = super::local_attachment::parse_bindings(local)?;
            if !local_attachments.is_empty() {
                client.require_capability("migrationLocalAttachmentsV1")?;
            }
            let params = MigrationContinuationCreateParams {
                request_id: request_id.clone(),
                source_job_id: job_id.clone(),
                view_id: view_id.clone(),
                policy: HistoricalContextPolicy::default(),
                options: HistoricalContinuationOptions {
                    model: model.clone(),
                    settings_template: settings_template.clone(),
                    studio_work_mode: StudioWorkMode::Kcoder,
                    local_attachments,
                },
            };
            let created = client.call(
                method::MIGRATION_CONTINUATION_CREATE,
                serde_json::to_value(params)?,
            )?;
            // A retried create may already be imported or stopped. Never implicitly resume it.
            if created["workerRunning"] == true {
                wait(&mut client, request_id, created, cancelled)?
            } else if created["job"]["stage"] == "planned" {
                let running = client.call(
                    method::MIGRATION_CONTINUATION_RUN,
                    json!({"jobId":request_id,"expectedSequence":created["job"]["sequence"]}),
                )?;
                wait(&mut client, request_id, running, cancelled)?
            } else {
                created
            }
        }
        HistoryAction::ContinuationResume {
            job_id,
            expected_sequence,
        } => {
            let running = client.call(
                method::MIGRATION_CONTINUATION_RESUME,
                json!({"jobId":job_id,"expectedSequence":expected_sequence}),
            )?;
            wait(&mut client, job_id, running, cancelled)?
        }
        HistoryAction::ContinuationRead { job_id } => {
            client.call(method::MIGRATION_CONTINUATION_READ, json!({"jobId":job_id}))?
        }
        HistoryAction::ContinuationCancel { job_id } => client.call(
            method::MIGRATION_CONTINUATION_CANCEL,
            json!({"jobId":job_id}),
        )?,
        HistoryAction::Source { thread_id } => client.call(
            method::MIGRATION_CONTINUATION_SOURCE,
            json!({"threadId":thread_id}),
        )?,
        _ => anyhow::bail!("migration_unknown_operation"),
    };
    super::super::batch::print(&result)?;
    if result["job"]["stage"] == "imported"
        && let Some(id) = result["job"]["threadId"].as_str()
    {
        eprintln!(
            "Idle KCoder session: {id}. From the selected working directory, open explicitly with kcoder --resume {id}; no model request has been sent."
        );
    }
    ensure!(
        !cancelled.load(Ordering::Acquire),
        "migration_cancelled_publication_requires_read"
    );
    ensure!(
        !matches!(
            result["job"]["stage"].as_str(),
            Some("failed" | "blocked" | "publish_unknown")
        ),
        "migration_continuation_not_imported_use_read"
    );
    Ok(())
}
fn wait(
    client: &mut rpc::Client,
    id: &str,
    mut result: Value,
    cancelled: &AtomicBool,
) -> Result<Value> {
    let deadline = Instant::now() + Duration::from_secs(300);
    let mut requested = false;
    while result["workerRunning"] == true {
        if cancelled.load(Ordering::Acquire) && !requested {
            let _ = client.call(method::MIGRATION_CONTINUATION_CANCEL, json!({"jobId":id}))?;
            requested = true;
        }
        ensure!(
            Instant::now() < deadline,
            "migration_continuation_wait_expired_use_read"
        );
        std::thread::sleep(Duration::from_millis(100));
        result = client.call(method::MIGRATION_CONTINUATION_READ, json!({"jobId":id}))?;
    }
    Ok(result)
}
