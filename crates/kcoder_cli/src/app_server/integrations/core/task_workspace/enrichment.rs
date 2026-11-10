//! Read original native capabilities on the existing owner job, never derive a grant from labels.
use super::*;
use crate::app_server::integrations::{
    connectivity::{
        task_capability_scope_control::NativeTaskCapabilityScopeControlMethod,
        task_capability_scope_runtime::PreparedTaskCapabilityScopeControl,
    },
    core::runtime_pump::NativeRuntimeClient,
};
use crate::app_server::{ConnectionState, engine_factory::AppServerEngineFactory};
use anyhow::{Context, ensure};
use kcoder_app_rpc_codec as rpc_codec;
use serde_json::json;
use std::sync::{Arc, Weak};
use std::time::Duration;

#[derive(Clone, Default)]
pub(super) struct ObservedEnrichment {
    pub authority_fence: Option<String>,
    pub task_capability_scope_target: Option<IntegrationTaskCapabilityScopeControlTarget>,
    pub task_capability_scope_selection: Option<IntegrationTaskCapabilityScopeSnapshot>,
    pub runtime: Option<IntegrationRuntimeTask>,
    pub task_capability_scope_reason: Option<&'static str>,
    pub runtime_reason: Option<&'static str>,
}
pub(super) struct PreparedEnrichment {
    task_capability_scope_target: IntegrationTaskCapabilityScopeControlTarget,
    task_capability_scope: Option<PreparedTaskCapabilityScopeControl>,
    runtime: Option<NativeRuntimeClient>,
    native: NativeIntegrationContext,
    request: IntegrationRequest,
    owner: Weak<()>,
    ended: CancellationToken,
}
impl PreparedEnrichment {
    /// This reuses the exact existing native selector. It cannot restore a
    /// missing resident, choose a first/latest attempt, or initialize a store.
    pub(super) fn capture(
        state: &ConnectionState,
        request: &IntegrationRequest,
        params: &TaskWorkspaceReadParams,
        threads: &ThreadManager,
        configuration: &AppServerEngineFactory,
    ) -> Result<Option<Self>> {
        let Some(task_capability_scope_target) = &params.task_capability_scope_target else {
            return Ok(None);
        };
        params.validate()?;
        let native = state
            .integration_context
            .as_ref()
            .context("TASK_WORKSPACE_UNAVAILABLE")?
            .recapture_for_owned_service()?;
        native.validate_scope(&request.scope)?;
        let scope_request = IntegrationRequest {
            operation_id: None,
            expected_revision: None,
            payload: json!({"target":task_capability_scope_target,"params":{"threadId":params.thread_id}})
                .as_object()
                .unwrap()
                .clone(),
            ..request.clone()
        };
        let task_capability_scope = state
            .integration_task_capability_scope
            .capture_public_control(
                state,
                scope_request,
                NativeTaskCapabilityScopeControlMethod::Read,
                threads,
                configuration,
            )
            .ok();
        Ok(Some(Self {
            task_capability_scope_target: task_capability_scope_target.clone(),
            task_capability_scope,
            runtime: state.integration_runtime.clone(),
            native,
            request: request.clone(),
            owner: Arc::downgrade(&state.source_management_owner),
            ended: state.input_ended.child_token(),
        }))
    }
    fn current(&self, cancel: &CancellationToken) -> Result<()> {
        ensure!(
            !cancel.is_cancelled() && !self.ended.is_cancelled() && self.owner.upgrade().is_some(),
            "TASK_WORKSPACE_CANCELLED"
        );
        self.native.validate_scope(&self.request.scope)
    }
    pub(super) async fn observe(
        mut self,
        cancel: &CancellationToken,
    ) -> Result<ObservedEnrichment> {
        self.current(cancel)?;
        let mut observed = ObservedEnrichment {
            task_capability_scope_target: Some(self.task_capability_scope_target.clone()),
            task_capability_scope_reason: Some("TASK_WORKSPACE_SCOPE_UNCONFIRMED"),
            runtime_reason: Some("TASK_WORKSPACE_RUNTIME_UNCONFIRMED"),
            ..Default::default()
        };
        if let Some(prepared) = self.task_capability_scope.take() {
            let result = tokio::select! { biased;
                _ = cancel.cancelled() => return Err(anyhow::anyhow!("TASK_WORKSPACE_CANCELLED")),
                _ = self.ended.cancelled() => return Err(anyhow::anyhow!("TASK_WORKSPACE_CANCELLED")),
                result = tokio::time::timeout(Duration::from_millis(self.request.timeout_ms), prepared.run()) => result,
            };
            if let Ok(Ok(value)) = result
                && let Ok(scope_selection) =
                    rpc_codec::decode::<IntegrationTaskCapabilityScopeSnapshot>(value)
                && scope_selection.thread_id
                    == self.task_capability_scope_target.initial_attempt.thread_id
                && scope_selection.selection.validate().is_ok()
                && scope_selection
                    .effective_sources
                    .iter()
                    .all(|source| source.validate().is_ok())
            {
                observed.task_capability_scope_selection = Some(scope_selection);
                observed.task_capability_scope_reason = None;
            }
        }
        self.current(cancel)?;
        // A verified task capability scope read proves this complete original tuple. An ID
        // alone must not join another runtime into an otherwise readable task.
        if observed.task_capability_scope_selection.is_some() {
            if let (Some(operation), Some(runtime)) = (
                &self.task_capability_scope_target.runtime_operation_id,
                &self.runtime,
            ) {
                observed.runtime = self.observe_runtime(runtime, operation, cancel).await.ok();
                if observed.runtime.is_some() {
                    observed.runtime_reason = None;
                }
            } else if self
                .task_capability_scope_target
                .runtime_operation_id
                .is_none()
            {
                observed.runtime_reason = Some("TASK_WORKSPACE_RUNTIME_REFERENCE_NOT_SELECTED");
            }
        }
        self.current(cancel)?;
        Ok(observed)
    }
    async fn observe_runtime(
        &self,
        runtime: &NativeRuntimeClient,
        operation: &str,
        cancel: &CancellationToken,
    ) -> Result<IntegrationRuntimeTask> {
        let request = IntegrationRequest {
            operation_id: None,
            expected_revision: None,
            payload: json!({"operationId":operation})
                .as_object()
                .unwrap()
                .clone(),
            ..self.request.clone()
        };
        let context = Arc::new(self.native.recapture_for_owned_service()?);
        let reply = tokio::select! { biased;
            _ = cancel.cancelled() => anyhow::bail!("TASK_WORKSPACE_CANCELLED"),
            _ = self.ended.cancelled() => anyhow::bail!("TASK_WORKSPACE_CANCELLED"),
            result = tokio::time::timeout(Duration::from_millis(self.request.timeout_ms), runtime.read_operation(context.clone(), request.clone())) => result??,
        };
        self.current(cancel)?;
        let value = result(&request, reply)?;
        let receipt: IntegrationOperationReceipt =
            serde_json::from_value(value["receipt"].clone())?;
        ensure!(
            receipt.operation_id == operation
                && receipt.port == "P-RUNTIME"
                && receipt.method == "acceptTask"
                && matches!(
                    receipt.phase,
                    IntegrationOperationPhase::Accepted
                        | IntegrationOperationPhase::Completed
                        | IntegrationOperationPhase::CancelRequested
                        | IntegrationOperationPhase::Cancelled
                        | IntegrationOperationPhase::Unknown
                )
                && IntegrationOwner::from(&receipt.scope)
                    == IntegrationOwner::from(self.native.scope()),
            "TASK_WORKSPACE_RUNTIME_UNCONFIRMED"
        );
        let accepted = receipt
            .runtime_acceptance
            .context("TASK_WORKSPACE_RUNTIME_UNCONFIRMED")?;
        accepted.validate()?;
        ensure!(
            accepted.thread_id == self.task_capability_scope_target.initial_attempt.thread_id,
            "TASK_WORKSPACE_RUNTIME_UNCONFIRMED"
        );
        let reference = IntegrationRuntimeReadTaskParams {
            thread_id: Some(accepted.thread_id.clone()),
            turn_id: accepted.turn_id.clone(),
            task_id: accepted.task_id.clone(),
        };
        reference.validate()?;
        let request = IntegrationRequest {
            operation_id: None,
            expected_revision: None,
            payload: serde_json::to_value(reference)?
                .as_object()
                .unwrap()
                .clone(),
            ..self.request.clone()
        };
        let reply = tokio::select! { biased;
            _ = cancel.cancelled() => anyhow::bail!("TASK_WORKSPACE_CANCELLED"),
            _ = self.ended.cancelled() => anyhow::bail!("TASK_WORKSPACE_CANCELLED"),
            result = tokio::time::timeout(Duration::from_millis(self.request.timeout_ms), runtime.read_task(context, request.clone())) => result??,
        };
        self.current(cancel)?;
        let task: IntegrationRuntimeTask = rpc_codec::decode(result(&request, reply)?)?;
        ensure!(
            task.thread_id == accepted.thread_id
                && task.turn_id == accepted.turn_id
                && task.task_id == accepted.task_id,
            "TASK_WORKSPACE_RUNTIME_UNCONFIRMED"
        );
        Ok(task)
    }
}
fn result(request: &IntegrationRequest, reply: IntegrationReply) -> Result<serde_json::Value> {
    ensure!(
        reply.contract_version == request.contract_version
            && reply.request_id == request.request_id
            && reply.status == IntegrationStatus::Completed
            && reply.error.as_ref().is_none()
            && reply.operation_id.as_ref().is_none(),
        "TASK_WORKSPACE_RUNTIME_UNCONFIRMED"
    );
    Ok(serde_json::Value::Object(
        reply
            .result
            .as_ref()
            .context("TASK_WORKSPACE_RUNTIME_UNCONFIRMED")?
            .clone(),
    ))
}

/// The C-owned fixture supplies its real private ticket/Accepted target and
/// keeps driving the same pump while this owned read-only observer waits.
#[cfg(test)]
pub(crate) fn spawn_task_capability_scope_enrichment_probe(
    state: &ConnectionState,
    threads: &ThreadManager,
    configuration: &AppServerEngineFactory,
    target: IntegrationTaskCapabilityScopeControlTarget,
    runtime: NativeRuntimeClient,
) -> Result<tokio::task::JoinHandle<Result<serde_json::Value>>> {
    let scope = state
        .integration_context
        .as_ref()
        .context("TASK_WORKSPACE_UNAVAILABLE")?
        .scope()
        .clone();
    let params = TaskWorkspaceReadParams {
        thread_id: target.initial_attempt.thread_id.clone(),
        cursor: None,
        task_capability_scope_target: Some(target.clone()),
    };
    let request = IntegrationRequest {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: "d33-real-private-runtime-observation".into(),
        scope,
        operation_id: None,
        expected_revision: None,
        timeout_ms: 10_000,
        cancellation_ref: None,
        payload: Default::default(),
    };
    let mut prepared =
        PreparedEnrichment::capture(state, &request, &params, threads, configuration)?
            .context("actual selected target missing")?;
    prepared.runtime = Some(runtime);
    let cancel = state.input_ended.child_token();
    Ok(crate::app_server::task_spawn::spawn(async move {
        let observed = prepared.observe(&cancel).await?;
        ensure!(
            observed.task_capability_scope_target.as_ref() == Some(&target)
                && observed.task_capability_scope_selection.is_some()
                && observed.runtime.is_some(),
            "actual task capability scope/runtime read was not available"
        );
        Ok(
            json!({"target":observed.task_capability_scope_target,"sourceSelection":observed.task_capability_scope_selection,"runtime":observed.runtime}),
        )
    }))
}
