//! Install Office only on the host's clone of one already accepted ordinary turn.
use super::{
    lazy_session::NativeOfficeLazySession,
    native_host::{NativeOfficeInstalledPaths, NativeOfficeProviders},
};
use crate::app_server::integrations::core::NativeIntegrationContext;
use anyhow::{Context, Result, ensure};
use kcoder_engine::{
    QueryEngine,
    integrations::office::{OfficeNativeToolOwner, OfficeToolOwnerResolver},
};
use kcoder_state::{
    AppStateIdentity,
    turn_attempt_store::{TurnAttemptRecord, TurnAttemptStore},
};
use kcoder_tools::ToolContext;
use kcoder_types::{
    StudioWorkMode, TurnAttemptIdentity, TurnAttemptStatus, integrations::office::OfficeTaskRef,
};
use std::sync::Arc;

#[cfg(test)]
#[path = "turn_binding_tests.rs"]
mod tests;

/// Call after durable Accepted and before the Provider on a turn-local Engine
/// clone. The resident baseline must remain unmodified for the next turn.
/// Installed paths and providers are native startup inputs, never tool JSON.
pub(crate) fn install_office_for_accepted_turn(
    context: &NativeIntegrationContext,
    attempt: &TurnAttemptIdentity,
    engine: QueryEngine,
    installed: NativeOfficeInstalledPaths,
    providers: NativeOfficeProviders,
    source_revision: String,
) -> Result<QueryEngine> {
    let enabled = engine
        .settings
        .read()
        .map_err(|_| anyhow::anyhow!("OFFICE_SETTINGS_UNAVAILABLE"))?
        .integrations
        .office
        .enabled;
    if !enabled
        || engine.effective_studio_work_mode() != StudioWorkMode::Kworker
        || engine.state.session_mode() != kcoder_state::SessionMode::Default
    {
        return Ok(engine);
    }
    let resolver = accepted_resolver(context, &engine, attempt)?;
    let session = NativeOfficeLazySession::for_current_turn(
        context,
        &engine,
        installed,
        providers,
        source_revision,
        resolver,
    )?;
    // Preserve deferred extensions and temporarily filtered ordinary tools.
    // with_turn_tools still enforces the host's existing native ceiling.
    let mut registry = engine.tools.clone();
    for tool in session.registry()?.all() {
        registry
            .try_register(tool)
            .map_err(|_| anyhow::anyhow!("OFFICE_NATIVE_TOOL_COLLISION"))?;
    }
    engine
        .with_turn_tools(registry)
        .with_native_office_projection_authority(session.projection_authority())
}

fn accepted_resolver(
    context: &NativeIntegrationContext,
    engine: &QueryEngine,
    attempt: &TurnAttemptIdentity,
) -> Result<OfficeToolOwnerResolver> {
    context.verify()?;
    attempt
        .validate()
        .map_err(|_| anyhow::anyhow!("OFFICE_NATIVE_CALL_OWNER_MISMATCH"))?;
    ensure!(
        attempt.thread_id == engine.session_id(),
        "OFFICE_NATIVE_CALL_OWNER_MISMATCH"
    );
    let accepted = read_accepted(engine, attempt)?;
    let binding = Arc::new(AcceptedBinding {
        context: context.recapture_for_owned_service()?,
        engine: engine.clone(),
        state: engine.state.inspection_identity(),
        accepted,
    });
    let resolver: OfficeToolOwnerResolver = Arc::new(move |actual| binding.resolve(actual));
    Ok(resolver)
}

struct AcceptedBinding {
    context: NativeIntegrationContext,
    engine: QueryEngine,
    state: AppStateIdentity,
    accepted: TurnAttemptRecord,
}
impl AcceptedBinding {
    fn resolve(&self, actual: &ToolContext) -> Result<OfficeNativeToolOwner> {
        self.context.verify()?;
        ensure!(!actual.is_aborted(), "OFFICE_CANCELLED");
        ensure!(
            self.state.matches(&actual.state)
                && actual.state.session_id() == self.accepted.identity.thread_id
                && self.engine.session_id() == self.accepted.identity.thread_id,
            "OFFICE_NATIVE_CALL_OWNER_MISMATCH"
        );
        let call = actual
            .tool_call_id
            .as_ref()
            .filter(|value| {
                !value.trim().is_empty()
                    && value.len() <= 256
                    && !value.chars().any(char::is_control)
            })
            .context("OFFICE_NATIVE_CALL_ID_REQUIRED")?;
        ensure!(
            read_accepted(&self.engine, &self.accepted.identity)? == self.accepted,
            "OFFICE_NATIVE_CALL_OWNER_MISMATCH"
        );
        Ok(OfficeNativeToolOwner {
            scope: self.context.scope().clone(),
            task: OfficeTaskRef {
                thread_id: self.accepted.identity.thread_id.clone(),
                turn_id: self.accepted.identity.turn_id.clone(),
                run_id: None,
            },
            state_identity: self.state.clone(),
            native_call_id: call.clone(),
            // The lazy backend derives the stable action from the actual Native
            // task/call/tool. This marker cannot allocate a caller-selected op.
            operation_id: "resolved-by-native-office-lazy-session".into(),
        })
    }
}
fn read_accepted(
    engine: &QueryEngine,
    identity: &TurnAttemptIdentity,
) -> Result<TurnAttemptRecord> {
    let store = TurnAttemptStore::open_existing(
        &engine.session_storage_dir_for(&identity.thread_id),
        &identity.thread_id,
    )?
    .context("OFFICE_NATIVE_TASK_NOT_FOUND")?;
    let record = store
        .load(identity)?
        .context("OFFICE_NATIVE_TASK_NOT_FOUND")?;
    ensure!(
        record.identity == *identity
            && record.status == TurnAttemptStatus::Accepted
            && record.completion.is_none(),
        "OFFICE_NATIVE_TASK_NOT_ACCEPTED"
    );
    Ok(record)
}
