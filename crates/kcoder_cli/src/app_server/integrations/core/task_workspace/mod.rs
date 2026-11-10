//! Native task observations only; this module never controls an execution.
mod enrichment;
#[cfg(test)]
pub(crate) use enrichment::spawn_task_capability_scope_enrichment_probe;
mod pagination;
pub(crate) mod rpc;
mod source;
use super::NativeIntegrationContext;
use crate::app_server::thread_runtime::ThreadManager;
use anyhow::Result;
use kcoder_engine::QueryEngine;
use kcoder_types::integrations::core::*;
use tokio_util::sync::CancellationToken;

/// Capture only live object references and authoritative run facts on the
/// protocol loop. File observation and pagination happen on the owned worker.
pub(crate) struct NativeTaskWorkspaceSelection {
    thread_id: String,
    resident: Option<QueryEngine>,
    running: bool,
    projection: crate::app_server::ThreadRunProjection,
    state_epoch: Option<kcoder_state::AppStateLifecycleIdentity>,
}
impl NativeTaskWorkspaceSelection {
    pub(crate) fn capture(
        threads: &ThreadManager,
        params: &TaskWorkspaceReadParams,
    ) -> Result<Self> {
        params.validate()?;
        let resident = threads.engine(&params.thread_id);
        if let Some(engine) = &resident {
            crate::app_server::ensure_active_thread(
                engine,
                threads.lease(&params.thread_id),
                &params.thread_id,
            )?;
        }
        let state_epoch = resident
            .as_ref()
            .map(|engine| engine.state.inspection_lifecycle_identity());
        Ok(Self {
            thread_id: params.thread_id.clone(),
            resident,
            state_epoch,
            running: threads.running_thread_ids().contains(&params.thread_id),
            projection: crate::app_server::ThreadRunProjection::for_thread(
                threads,
                true,
                &params.thread_id,
            ),
        })
    }
    fn verify(&self) -> Result<()> {
        anyhow::ensure!(
            match (&self.resident, &self.state_epoch) {
                (Some(engine), Some(epoch)) =>
                    engine.session_id() == self.thread_id && epoch.matches(&engine.state),
                (None, None) => true,
                _ => false,
            },
            "TASK_WORKSPACE_SOURCE_CHANGED"
        );
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct NativeTaskWorkspaceReader {
    pages: pagination::ObservationPages,
}
impl std::fmt::Debug for NativeTaskWorkspaceReader {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("NativeTaskWorkspaceReader { snapshots: private }")
    }
}
impl NativeTaskWorkspaceReader {
    #[cfg(test)]
    pub(crate) fn read(
        &mut self,
        native: &NativeIntegrationContext,
        workspace: &QueryEngine,
        threads: &ThreadManager,
        params: &TaskWorkspaceReadParams,
        cancel: &CancellationToken,
    ) -> Result<TaskWorkspaceSnapshot> {
        let selection = NativeTaskWorkspaceSelection::capture(threads, params)?;
        self.read_owned(native, workspace, &selection, params, cancel)
    }
    #[cfg(test)]
    pub(crate) fn read_owned(
        &mut self,
        native: &NativeIntegrationContext,
        workspace: &QueryEngine,
        selection: &NativeTaskWorkspaceSelection,
        params: &TaskWorkspaceReadParams,
        cancel: &CancellationToken,
    ) -> Result<TaskWorkspaceSnapshot> {
        self.read_owned_enriched(
            native,
            workspace,
            selection,
            params,
            enrichment::ObservedEnrichment::default(),
            cancel,
        )
    }
    fn read_owned_enriched(
        &mut self,
        native: &NativeIntegrationContext,
        workspace: &QueryEngine,
        selection: &NativeTaskWorkspaceSelection,
        params: &TaskWorkspaceReadParams,
        observed: enrichment::ObservedEnrichment,
        cancel: &CancellationToken,
    ) -> Result<TaskWorkspaceSnapshot> {
        self.read_inner(native, workspace, selection, params, observed, cancel)
            .map_err(|error| {
                let code = error
                    .chain()
                    .find_map(|cause| match cause.to_string().as_str() {
                        "TASK_WORKSPACE_CANCELLED" => Some("TASK_WORKSPACE_CANCELLED"),
                        "TASK_WORKSPACE_OWNER_MISMATCH" => Some("TASK_WORKSPACE_OWNER_MISMATCH"),
                        "TASK_WORKSPACE_CURSOR_INVALID" => Some("TASK_WORKSPACE_CURSOR_INVALID"),
                        "TASK_WORKSPACE_CURSOR_EXPIRED" => Some("TASK_WORKSPACE_CURSOR_EXPIRED"),
                        "TASK_WORKSPACE_CAPACITY" => Some("TASK_WORKSPACE_CAPACITY"),
                        "TASK_WORKSPACE_SOURCE_CHANGED" => Some("TASK_WORKSPACE_SOURCE_CHANGED"),
                        _ => None,
                    })
                    .unwrap_or("TASK_WORKSPACE_UNAVAILABLE");
                error.context(code)
            })
    }
    fn read_inner(
        &mut self,
        native: &NativeIntegrationContext,
        workspace: &QueryEngine,
        selection: &NativeTaskWorkspaceSelection,
        params: &TaskWorkspaceReadParams,
        observed: enrichment::ObservedEnrichment,
        cancel: &CancellationToken,
    ) -> Result<TaskWorkspaceSnapshot> {
        params.validate()?;
        anyhow::ensure!(
            selection.thread_id == params.thread_id,
            "TASK_WORKSPACE_OWNER_MISMATCH"
        );
        selection.verify()?;
        let current = source::NativeSource::capture(native, workspace, selection)?;
        current.check(cancel)?;
        let fence = current.authority_fence()?;
        anyhow::ensure!(
            observed
                .authority_fence
                .as_ref()
                .is_none_or(|original| original == &fence),
            "TASK_WORKSPACE_SOURCE_CHANGED"
        );
        if let Some(cursor) = &params.cursor {
            return self.pages.page(
                native.scope(),
                &params.thread_id,
                cursor,
                &fence,
                params.task_capability_scope_target.as_ref(),
                cancel,
            );
        }
        let observation = current.collect(&params.thread_id, cancel)?;
        current.check(cancel)?;
        anyhow::ensure!(
            current.authority_fence()? == fence,
            "TASK_WORKSPACE_SOURCE_CHANGED"
        );
        self.pages.start(
            native.scope().clone(),
            observation,
            &fence,
            params.task_capability_scope_target.clone(),
            observed,
            cancel,
        )
    }
}
#[cfg(test)]
mod tests;
