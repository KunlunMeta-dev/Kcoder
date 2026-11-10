//! Native budget intent is separate from batch runner acceptance and cancellation.
use super::*;
pub(super) fn execute(
    factory: &dyn MigrationHost,
    profile: &Path,
    operation: &str,
    params: Value,
) -> Result<Value> {
    let store = MigrationStore::open_existing(profile)?;
    if operation == method::MIGRATION_BATCH_RESOURCES_ATTACHMENT_READ {
        let params: MigrationHistoryResourceAttachmentReadParams = decode(params)?;
        return super::super::history::attachment_projection(
            store.resource_attachment(&params.job_id)?,
        );
    }
    if operation == method::MIGRATION_BATCH_RESOURCES_READ {
        let params: MigrationResourceBudgetReadParams = decode(params)?;
        return Ok(serde_json::to_value(store.batch_resource_budget(
            &params.job_id,
            params.request_id.as_deref(),
        )?)?);
    }
    if operation == method::MIGRATION_BATCH_RESOURCES_ATTACH {
        let params: MigrationHistoryParentResourceAttachParams = decode(params)?;
        ensure!(params.confirm, "migration_resource_consent_required");
        let saved = store.read(&params.job_id)?;
        verify_target_layout(factory, profile, &saved)?;
        let history = kcoder_migration::history_jobs::HistoryJobStore::open_existing(profile)?
            .ok_or_else(|| anyhow::anyhow!("history_job_not_found"))?;
        return Ok(serde_json::to_value(store.attach_batch_resource_budget(
            &params.job_id,
            &params.plan_id,
            params.expected_sequence,
            params.limits,
            true,
            &history,
        )?)?);
    }
    let params: MigrationResourceIncreaseParams = decode(params)?;
    ensure!(params.confirm, "migration_resource_consent_required");
    let saved = store.read(&params.job_id)?;
    verify_target_layout(factory, profile, &saved)?;
    Ok(serde_json::to_value(store.raise_batch_resource_budget(
        &params.job_id,
        &params.plan_id,
        &params.request_id,
        params.expected_policy_revision,
        params.limits,
        true,
    )?)?)
}
