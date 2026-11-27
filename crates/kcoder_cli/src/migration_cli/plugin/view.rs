//! Deliberate public projection excludes source roots, package proofs and private batch references.
use super::*;
pub(in crate::migration_cli) fn public(value: &PluginMigrationView) -> Value {
    json!({"operationId":value.operation_id,"sequence":value.sequence,"stage":value.stage,
        "source":value.source,"name":value.name,"installedVersion":value.installed_version,
        "scope":value.scope,"sourceEnabled":value.source_enabled,"targetId":value.target_id,
        "packageFiles":value.package_files,"packageBytes":value.package_bytes,
        "capabilities":value.capabilities,"readiness":value.readiness,"pending":value.pending,
        "imported":value.imported,"cancelRequested":value.cancel_requested,
        "cancelRevision":value.cancel_revision,"batchJobId":value.batch_job_id,"failureCode":value.failure_code,
        "runtimeReadiness":"not_verified_by_migration"})
}
pub(in crate::migration_cli) fn candidate(
    value: &kcoder_migration::plugin_migration::PluginMigrationCandidate,
) -> Value {
    json!({"source":value.source,"name":value.name,"installedVersion":value.installed_version,
        "scope":value.scope,"sourceEnabled":value.source_enabled,"pending":value.pending})
}
