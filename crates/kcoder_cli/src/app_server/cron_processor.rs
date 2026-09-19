use anyhow::{Context, Result};
use kcoder_app_protocol::{CronCreateParams, CronDeleteParams, CronParams};
use kcoder_engine::QueryEngine;
use serde_json::{Value, json};

pub(super) fn process(engine: &QueryEngine, method: &str, params: Value) -> Result<Value> {
    anyhow::ensure!(
        !engine.settings.read().unwrap().training_mode,
        "scheduled tasks are disabled in training mode"
    );
    let scheduler = engine.cron_scheduler();
    let session_id = engine.session_id();
    let owner = kcoder_tools::cron::APP_PROJECT_CRON_OWNER;
    match method {
        "cron/list" => {
            let params: CronParams = serde_json::from_value(params)?;
            anyhow::ensure!(
                params
                    .thread_id
                    .as_deref()
                    .is_none_or(|id| id == session_id),
                "scheduled task thread mismatch"
            );
            scheduler
                .migrate_app_jobs_to_project()
                .map_err(anyhow::Error::msg)?;
            let jobs = scheduler
                .list_for_session(owner)
                .map_err(anyhow::Error::msg)?;
            Ok(json!({"jobs": jobs, "executionPolicy": "project-new-session", "timezone": "UTC"}))
        }
        "cron/create" => {
            let params: CronCreateParams = serde_json::from_value(params)?;
            anyhow::ensure!(
                params
                    .thread_id
                    .as_deref()
                    .is_none_or(|id| id == session_id),
                "scheduled task thread mismatch"
            );
            anyhow::ensure!(params.confirmed, "explicit user confirmation is required");
            anyhow::ensure!(
                params.prompt.len() <= 32 * 1024,
                "scheduled task prompt is too large"
            );
            let schedule =
                serde_json::from_value(params.schedule).context("invalid cron schedule")?;
            scheduler
                .migrate_app_jobs_to_project()
                .map_err(anyhow::Error::msg)?;
            let job = scheduler
                .create_for_session(
                    owner.to_string(),
                    params.prompt,
                    schedule,
                    params.jitter_seconds,
                )
                .map_err(anyhow::Error::msg)?;
            // The write already committed. A racing read must not turn it into an error
            // that encourages the caller to create the same schedule again.
            let job_count = scheduler
                .list_for_session(owner)
                .ok()
                .map(|jobs| jobs.len());
            Ok(json!({"job": job, "jobCount": job_count}))
        }
        "cron/delete" => {
            let params: CronDeleteParams = serde_json::from_value(params)?;
            anyhow::ensure!(
                params
                    .thread_id
                    .as_deref()
                    .is_none_or(|id| id == session_id),
                "scheduled task thread mismatch"
            );
            scheduler
                .migrate_app_jobs_to_project()
                .map_err(anyhow::Error::msg)?;
            let deleted = scheduler
                .delete_for_session(&params.job_id, owner)
                .map_err(anyhow::Error::msg)?;
            let job_count = scheduler
                .list_for_session(owner)
                .ok()
                .map(|jobs| jobs.len());
            Ok(json!({"deleted": deleted, "jobCount": job_count}))
        }
        _ => anyhow::bail!("unknown scheduled task method"),
    }
}
