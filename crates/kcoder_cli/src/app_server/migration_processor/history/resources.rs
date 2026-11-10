//! Native quota observations and explicit changes use only the authenticated target profile.
use super::*;
use anyhow::Context;
mod attachment;
pub(crate) use attachment::project as attachment_projection;

pub(super) fn handles(operation: &str) -> bool {
    matches!(
        operation,
        method::MIGRATION_HISTORY_RESOURCES_ATTACHMENT_READ
            | method::MIGRATION_HISTORY_RESOURCES_READ
            | method::MIGRATION_HISTORY_RESOURCES_INCREASE
            | method::MIGRATION_HISTORY_RESOURCES_ATTACH
    )
}

pub(super) fn execute(profile: &Path, operation: &str, params: Value) -> Result<Value> {
    let store = HistoryJobStore::open_existing(profile)?.context("history_job_not_found")?;
    match operation {
        method::MIGRATION_HISTORY_RESOURCES_ATTACHMENT_READ => {
            let params: MigrationHistoryResourceAttachmentReadParams = decode(params)?;
            attachment_projection(store.resource_attachment(&params.job_id)?)
        }
        method::MIGRATION_HISTORY_RESOURCES_READ => {
            let params: MigrationHistoryResourceReadParams = decode(params)?;
            let (owner_job_id, initial_limits, budget) =
                store.observe_resource_budget(&params.job_id, params.request_id.as_deref())?;
            Ok(serde_json::to_value(MigrationHistoryResourceResult {
                owner_job_id,
                initial_limits: initial_limits.map(Into::into),
                budget,
            })?)
        }
        method::MIGRATION_HISTORY_RESOURCES_ATTACH => {
            let params: MigrationHistoryResourceAttachParams = decode(params)?;
            store.attach_resource_budget(
                &params.job_id,
                params.expected_sequence,
                params.limits,
                params.confirm,
            )?;
            let (owner_job_id, initial_limits, budget) =
                store.observe_resource_budget(&params.job_id, None)?;
            Ok(serde_json::to_value(MigrationHistoryResourceResult {
                owner_job_id,
                initial_limits: initial_limits.map(Into::into),
                budget,
            })?)
        }
        method::MIGRATION_HISTORY_RESOURCES_INCREASE => {
            let params: MigrationHistoryResourceIncreaseParams = decode(params)?;
            Ok(serde_json::to_value(store.raise_resource_budget(
                &params.job_id,
                &params.request_id,
                params.expected_policy_revision,
                params.limits,
                params.confirm,
            )?)?)
        }
        _ => anyhow::bail!("migration_unknown_operation"),
    }
}

#[cfg(test)]
mod tests;
