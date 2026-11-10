//! Saved-code purpose adapter to the original shared native user manager.
use super::*;
use anyhow::{Context, ensure};
use std::{path::Path, process::Child, time::Duration};
pub(crate) fn try_run(arguments: &[std::ffi::OsString]) -> Option<Result<()>> {
    super::super::user_manager::try_run(arguments)
}
pub(super) fn request_start(
    profile: &Path,
    workspace: &Path,
    id: &str,
    budget: Duration,
) -> Result<serde_json::Value> {
    super::super::user_manager::request_start(profile, workspace, id, budget)
}
#[cfg(target_os = "linux")]
pub(in crate::app_server::integrations::core::service_leases) fn spawn_original(
    profile: &Path,
    workspace: &Path,
    id: &str,
    budget: Duration,
) -> Result<(Child, Result<serde_json::Value>)> {
    let mut context = native(profile, workspace)?;
    let storage =
        NativeServiceLeases::load(&context)?.context("NATIVE_CODE_ORIGINAL_STORE_REQUIRED")?;
    let store = storage.store(&context)?;
    let record = store
        .read_native_code(id)?
        .context("NATIVE_CODE_SERVICE_NOT_FOUND")?;
    ensure!(
        record.enabled && record.state != NativeCodeServiceState::Revoked,
        "NATIVE_CODE_SERVICE_NOT_ENABLED"
    );
    let launch = store.read_native_code_launch(id)?;
    let settings = super::source::load_settings(profile, workspace, &launch.settings_file)?;
    context.refresh_configuration_revision(
        kcoder_engine::model_configuration_summary(
            &settings,
            kcoder_types::ModelConfigurationBoundary::SessionSnapshot,
        )?
        .revision,
    )?;
    context.validate_scope(&record.intent.scope)?;
    let source = super::source::NativeSavedCodeSource::from_launch(
        &context,
        &launch,
        &tokio_util::sync::CancellationToken::new(),
    )?;
    let issuer = crate::app_server::integrations::core::NativePolicyService::load(&context)?
        .context("NATIVE_CODE_ORIGINAL_ISSUER_REQUIRED")?;
    issuer.authorize_native_code_service(&context, &record, &source.snapshot()?, now()?)?;
    let availability = store
        .claim_native_code_owner(id)?
        .ok_or(super::super::user_manager::OriginalOwnerBusy)?;
    drop(availability);
    super::launch::spawn_owned(&context, &record, &launch, budget)
}
#[cfg(target_os = "linux")]
fn native(profile: &Path, workspace: &Path) -> Result<NativeIntegrationContext> {
    NativeIntegrationContext::capture_existing(
        profile,
        workspace,
        "native-code-manager-read",
        "native-code-manager-read-only",
    )
}
