//! Task permission and original resident configuration in this app-server.
use crate::app_server::{ConnectionState, QueryEngine};
use anyhow::{Context, Result, ensure};

pub(in crate::app_server) fn verify_original_ui_source(state: &ConnectionState) -> Result<()> {
    let owner =
        super::main_public::NativeConnectivityManagementOwner::from_initialized_task_ui(state)?;
    owner.verify(
        state
            .integration_context
            .as_ref()
            .context("TASK_UI_SCOPE_REQUIRED")?,
    )
}

pub(in crate::app_server) fn verify_expert_control(
    state: &ConnectionState,
    origin: &QueryEngine,
    thread: &str,
) -> Result<Vec<std::fs::File>> {
    super::main_public::NativeConnectivityManagementOwner::initialized_task_ui_context(state)?;
    crate::app_server::thread_metadata::access::task_access(origin, thread)
}

/// Keep the original task configuration in the app-server, independently of a
/// presentation's lifetime policy. This is not a UI or platform input permit.
pub(in crate::app_server) fn retain_original_configuration(
    state: &ConnectionState,
    manager: &mut crate::app_server::thread_runtime::ThreadManager,
    thread: &str,
) -> Result<()> {
    super::main_public::NativeConnectivityManagementOwner::from_initialized_task_ui(state)?;
    let native = state
        .integration_context
        .as_ref()
        .context("TASK_UI_SCOPE_REQUIRED")?;
    if let Some(original) = manager.original_task_configuration(thread) {
        let resident = manager
            .engine(thread)
            .context("ORIGINAL_TASK_OWNER_REQUIRED")?;
        original.for_resident(
            native,
            &resident,
            manager
                .lease(thread)
                .context("ORIGINAL_TASK_LEASE_REQUIRED")?,
        )?;
        return Ok(());
    }
    let original = crate::app_server::integrations::core::runtime_driver::NativeOriginalTaskConfiguration::resident(
        native, manager, thread,
    )?;
    manager.retain_original_task_configuration(native, thread, original)
}

/// A source's retained task configuration is not an execution permit. The
/// ordinary first-party dispatcher still creates this input's own Native guard.
pub(in crate::app_server) fn prepare_resident_input(
    state: &ConnectionState,
    manager: &crate::app_server::thread_runtime::ThreadManager,
    thread: &str,
) -> Result<Option<QueryEngine>> {
    if state.native_source_dispatch || state.native_source_accepted.is_some() {
        return Ok(None);
    }
    let Some(configuration) = manager.original_task_configuration(thread) else {
        return Ok(None);
    };
    ensure!(
        state.initialized
            && state.integration_task_capability_scope_v1
            && !state.input_ended.is_cancelled()
            && state.native_runtime_thread_initializer.is_none(),
        "TASK_UI_NATIVE_SOURCE_REQUIRED"
    );
    let native = state
        .integration_context
        .as_ref()
        .context("TASK_UI_SCOPE_REQUIRED")?;
    let actual = manager
        .engine(thread)
        .context("TASK_UI_ORIGINAL_RUNTIME_REQUIRED")?;
    let candidate = configuration.for_resident(
        native,
        &actual,
        manager
            .lease(thread)
            .context("TASK_UI_ORIGINAL_LEASE_REQUIRED")?,
    )?;
    drop(crate::app_server::thread_metadata::access::task_access(
        &candidate, thread,
    )?);
    Ok(Some(candidate))
}
