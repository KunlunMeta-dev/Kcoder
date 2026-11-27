//! Credentials remain on the authenticated target host, outside ordinary RPC payloads.
use super::*;
use kcoder_migration::{
    credentials::CredentialTarget,
    store::{CredentialResolution, CredentialTargets},
};
use std::path::Path;

pub(super) fn handles(method: &str) -> bool {
    matches!(
        method,
        method::MIGRATION_CREDENTIAL_PLAN
            | method::MIGRATION_CREDENTIAL_APPLY
            | method::MIGRATION_CREDENTIAL_UNDO
    )
}
pub(super) fn execute(
    factory: &dyn MigrationHost,
    profile: &Path,
    operation: &str,
    params: Value,
) -> Result<Value> {
    let store = MigrationStore::open_existing(profile)?;
    let target = CredentialTarget::open(profile)?;
    let backend = kcoder_config::OsCredentialBackend::new();
    let policy = factory.current_settings()?.credential_store;
    let targets = CredentialTargets {
        target: &target,
        backend: &backend,
        policy,
    };
    let job = if operation == method::MIGRATION_CREDENTIAL_PLAN {
        let params: MigrationCredentialPlanParams = decode(params)?;
        let job = store.read(&params.job_id)?;
        let selector = selector(&job, &params.item_id, params.source)?;
        store.prepare_credential(
            &params.job_id,
            params.expected_sequence,
            &CredentialResolution {
                item_id: params.item_id,
                selector,
                consent_api_key: params.consent_api_key,
            },
            &targets,
        )?
    } else {
        let params: MigrationCredentialOperationParams = decode(params)?;
        store.apply_credential(
            &params.job_id,
            &params.plan_id,
            params.expected_sequence,
            operation == method::MIGRATION_CREDENTIAL_UNDO,
            &targets,
        )?
    };
    Ok(serde_json::to_value(read_result(&job))?)
}

pub(super) use kcoder_migration_client::migration_input::selector;
