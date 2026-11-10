//! Explicit MCP private-field consent never accepts values, paths, or backend accounts.
use super::*;
use kcoder_migration::mcp_credentials::McpCredentialTarget;
use std::path::Path;

pub(super) fn handles(method: &str) -> bool {
    matches!(
        method,
        method::MIGRATION_MCP_CREDENTIAL_READ
            | method::MIGRATION_BATCH_MCP_CREDENTIAL_READ
            | method::MIGRATION_MCP_CREDENTIAL_PLAN
            | method::MIGRATION_MCP_CREDENTIAL_APPLY
            | method::MIGRATION_MCP_CREDENTIAL_UNDO
    )
}
pub(super) fn execute(
    factory: &dyn MigrationHost,
    profile: &Path,
    operation: &str,
    params: Value,
) -> Result<Value> {
    let store = MigrationStore::open_existing(profile)?;
    let grouped = operation == method::MIGRATION_BATCH_MCP_CREDENTIAL_READ;
    let job = if grouped || operation == method::MIGRATION_MCP_CREDENTIAL_READ {
        let params: MigrationOperationParams = decode(params)?;
        let job = store.read(&params.job_id)?;
        ensure!(!grouped || job.batch.is_some(), "migration_not_a_batch");
        job
    } else {
        ensure!(
            factory.migration_mcp_settings_path()?.parent() == Some(profile),
            "migration_wrong_target"
        );
        let target = McpCredentialTarget::open(profile)?;
        let backend = kcoder_config::OsCredentialBackend::new();
        let policy = factory.current_settings()?.credential_store;
        if operation == method::MIGRATION_MCP_CREDENTIAL_PLAN {
            let params: MigrationMcpCredentialPlanParams = decode(params)?;
            store.prepare_mcp_credentials(
                &params.job_id,
                params.expected_sequence,
                &params.item_id,
                &params.fields,
                params.consent_private_values,
                &target,
                policy,
                &backend,
            )?
        } else {
            let params: MigrationCredentialOperationParams = decode(params)?;
            store.apply_mcp_credentials(
                &params.job_id,
                &params.plan_id,
                params.expected_sequence,
                operation == method::MIGRATION_MCP_CREDENTIAL_UNDO,
                &target,
                policy,
                &backend,
            )?
        }
    };
    let result = MigrationMcpCredentialsResult {
        job: read_result(&job).job,
        plans: job
            .mcp_credential_plans
            .iter()
            .filter(|plan| plan.atomic_group_id.is_some() == grouped)
            .map(|plan| MigrationMcpCredentialPlanSummary {
                plan_id: plan.plan_id.clone(),
                item_id: plan.item_id.clone(),
                target_name: plan.config.name.clone(),
                transport: plan.config.transport.clone(),
                storage: match plan.reference.storage {
                    kcoder_config::imported_credentials::ImportStorage::File => {
                        MigrationCredentialStorage::File
                    }
                    kcoder_config::imported_credentials::ImportStorage::Keyring => {
                        MigrationCredentialStorage::Keyring
                    }
                },
                fields: plan.fields.clone(),
                remaining_fields: plan.remaining_fields(),
                phase: plan.phase,
                undo_requested: plan.undo_requested,
                error_code: plan.error_code.clone(),
            })
            .collect(),
    };
    Ok(serde_json::to_value(result)?)
}
