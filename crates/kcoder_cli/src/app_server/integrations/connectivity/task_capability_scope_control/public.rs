//! Public handlers receive an already resolved exact native task capability.
use super::super::native_task_capability_scope::NativeTaskCapabilityScopeCallback;
use super::super::{NativeConnectivitySourceCatalog, NativeTaskCapabilityScopeFactory};
use super::*;
use crate::app_server::integrations::core::NativeOperations;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

pub(crate) struct NativeTaskCapabilityScopeControlTarget {
    pub(super) binding: Arc<NativeTaskCapabilityScopeBinding>,
    pub(super) facts: Arc<NativeTaskCapabilityScopeFactory>,
    pub(super) catalog: Arc<NativeConnectivitySourceCatalog>,
}
impl NativeTaskCapabilityScopeControlTarget {
    /// Pure lookup on the already resident actual factory. It never selects a
    /// latest turn, initializes source storage or resumes another runtime.
    pub(crate) async fn restore(
        context: &NativeIntegrationContext,
        reference: &IntegrationTaskCapabilityScopeControlTarget,
        facts: Arc<NativeTaskCapabilityScopeFactory>,
        catalog: Arc<NativeConnectivitySourceCatalog>,
    ) -> Result<Option<Self>> {
        reference.validate()?;
        let accepted = if let Some(operation) = &reference.runtime_operation_id {
            NativeAcceptedTaskIdentity::capture_runtime(
                context,
                operation,
                &reference.initial_attempt,
                facts.as_ref(),
            )
            .await?
        } else {
            NativeAcceptedTaskIdentity::capture_studio(
                context,
                &reference.initial_attempt,
                facts.as_ref(),
            )
            .await?
        };
        let Some(store) =
            super::super::native_task_capability_scope::NativeTaskCapabilityScopeBindingStore::observe(context)?
        else {
            return Ok(None);
        };
        let Some(binding) = Arc::new(store)
            .restore(context, &accepted.task_key()?, facts.as_ref())
            .await?
        else {
            return Ok(None);
        };
        binding.accepted().validate_control_target(reference)?;
        Self::capture(context, Arc::new(binding), facts, catalog)
            .await
            .map(Some)
    }
    /// Root resolves the original Task/Turn/Attempt on its existing manager.
    /// A thread label alone never selects a latest accepted task here.
    pub(crate) async fn capture(
        context: &NativeIntegrationContext,
        binding: Arc<NativeTaskCapabilityScopeBinding>,
        facts: Arc<NativeTaskCapabilityScopeFactory>,
        catalog: Arc<NativeConnectivitySourceCatalog>,
    ) -> Result<Self> {
        binding.accepted().verify(context, facts.as_ref()).await?;
        ensure!(
            facts.actual_root().session_id() == binding.accepted().thread_id(),
            "TASK_CAPABILITY_SCOPE_CONTROL_TARGET_MISMATCH"
        );
        Ok(Self {
            binding,
            facts,
            catalog,
        })
    }
}
enum SourceControlPayload {
    Read(IntegrationTaskCapabilityScopeControlReadParams),
    Set(IntegrationTaskCapabilityScopeControlSetParams),
    Operation(IntegrationTaskCapabilityScopeControlOperationParams),
}
impl SourceControlPayload {
    fn target(&self) -> &IntegrationTaskCapabilityScopeControlTarget {
        match self {
            Self::Read(value) => &value.target,
            Self::Set(value) => &value.target,
            Self::Operation(value) => &value.target,
        }
    }
}
impl NativeTaskCapabilityScopeControlMethod {
    fn decode_payload(self, request: &IntegrationRequest) -> Result<SourceControlPayload> {
        let value = Value::Object(request.payload.clone());
        Ok(match self {
            Self::Read => SourceControlPayload::Read(serde_json::from_value(value)?),
            Self::Set => SourceControlPayload::Set(serde_json::from_value(value)?),
            Self::ReadOperation => SourceControlPayload::Operation(serde_json::from_value(value)?),
        })
    }
    pub(crate) fn target_reference(
        self,
        request: &IntegrationRequest,
    ) -> Result<IntegrationTaskCapabilityScopeControlTarget> {
        let payload = self.decode_payload(request)?;
        payload.target().validate()?;
        Ok(payload.target().clone())
    }
    pub(crate) async fn handle_public(
        self,
        context: &NativeIntegrationContext,
        request: &IntegrationRequest,
        target: &NativeTaskCapabilityScopeControlTarget,
        permit: Option<&Arc<NativeTaskCapabilityScopeManagementPermit>>,
        cancel: CancellationToken,
    ) -> Result<Value> {
        self.handle_authorized(context, request, target, permit, cancel)
            .await
    }
    async fn handle_authorized(
        self,
        context: &NativeIntegrationContext,
        request: &IntegrationRequest,
        target: &NativeTaskCapabilityScopeControlTarget,
        permit: Option<&Arc<NativeTaskCapabilityScopeManagementPermit>>,
        cancel: CancellationToken,
    ) -> Result<Value> {
        request.validate(self == Self::Set)?;
        context.validate_scope(&request.scope)?;
        ensure!(
            !cancel.is_cancelled(),
            "TASK_CAPABILITY_SCOPE_CONTROL_CANCELLED"
        );
        target
            .binding
            .accepted()
            .verify(context, target.facts.as_ref())
            .await?;
        let payload = self.decode_payload(request)?;
        target
            .binding
            .accepted()
            .validate_control_target(payload.target())?;
        match self {
            Self::Read => {
                let SourceControlPayload::Read(payload) = payload else {
                    unreachable!()
                };
                let params = payload.params;
                ensure!(
                    params.thread_id == target.binding.accepted().thread_id(),
                    "TASK_CAPABILITY_SCOPE_CONTROL_TARGET_MISMATCH"
                );
                serde_json::to_value(
                    target
                        .binding
                        .snapshot(context, target.facts.as_ref())
                        .await?,
                )
                .map_err(Into::into)
            }
            Self::Set => {
                let SourceControlPayload::Set(payload) = payload else {
                    unreachable!()
                };
                let params = payload.params;
                ensure!(
                    params.thread_id == target.binding.accepted().thread_id(),
                    "TASK_CAPABILITY_SCOPE_CONTROL_TARGET_MISMATCH"
                );
                let operation = request
                    .operation_id
                    .as_deref()
                    .context("TASK_CAPABILITY_SCOPE_OPERATION_REQUIRED")?;
                let permit =
                    permit.context("TASK_CAPABILITY_SCOPE_NATIVE_MANAGEMENT_PROOF_REQUIRED")?;
                if params.resource_bindings.is_some() {
                    permit.verify_resource_request(request)?;
                }
                permit.verify(
                    context.scope(),
                    &target.binding.task_key()?,
                    operation,
                    &params.selection,
                )?;
                target.facts.install_public_management(permit)?;
                let service = match NativeOperations::load(context)? {
                    Some(service) => service,
                    None => NativeOperations::initialize(context, operation)?,
                };
                let (_receipt, first) = service.begin(context, request, "P-TASK", self.wire())?;
                if !first {
                    let _ = target.binding.read_control_operation(context, operation)?;
                    let receipt =
                        project_original_operation(context, &service, &target.binding, operation)?;
                    return Ok(
                        json!({"snapshot":target.binding.snapshot(context,target.facts.as_ref()).await?,"operation":receipt}),
                    );
                }
                let expected = request
                    .expected_revision
                    .as_deref()
                    .context("TASK_CAPABILITY_SCOPE_EXPECTED_REVISION_REQUIRED")?
                    .parse::<u64>()
                    .context("TASK_CAPABILITY_SCOPE_EXPECTED_REVISION_INVALID")?;
                ensure!(
                    !cancel.is_cancelled(),
                    "TASK_CAPABILITY_SCOPE_CONTROL_CANCELLED"
                );
                let staged = target
                    .binding
                    .stage_selection_with_resources(
                        context,
                        operation,
                        expected,
                        params.selection,
                        params.resource_bindings,
                        &target.catalog,
                        target.facts.as_ref(),
                    )
                    .await;
                // Keep the original ledger-only unknown outcome; observe no private values.
                if let Err(error) = &staged {
                    use crate::app_server::integrations::core::service_leases::scope_host::frontend::{
                        OriginalPreparationStage, report_original_failure,
                    };
                    report_original_failure(OriginalPreparationStage::OriginalUiCall, error);
                }
                if staged.is_err()
                    && target
                        .binding
                        .read_control_operation(context, operation)?
                        .is_none()
                {
                    // This operation may have reached only its original ledger.
                    // Reconcile the original metadata; never stage a second time.
                    let error = IntegrationError {
                        code: "TASK_CAPABILITY_SCOPE_CONTROL_OUTCOME_UNKNOWN".into(),
                        message_key: "integration.task_capability_scope_control_outcome_unknown"
                            .into(),
                        recovery: IntegrationRecovery::ReconcileOriginal,
                    };
                    let current = service
                        .read(context, operation)?
                        .context("TASK_CAPABILITY_SCOPE_OPERATION_REQUIRED")?;
                    let operation = service.transition(
                        context,
                        &current,
                        IntegrationOperationPhase::Unknown,
                        Some(error),
                    )?;
                    return Ok(
                        json!({"snapshot":target.binding.snapshot(context,target.facts.as_ref()).await?,"operation":operation}),
                    );
                }
                let _ = staged?;
                let _ = try_apply_pending(context, target).await?;
                let operation =
                    project_original_operation(context, &service, &target.binding, operation)?;
                Ok(
                    json!({"snapshot":target.binding.snapshot(context,target.facts.as_ref()).await?,"operation":operation}),
                )
            }
            Self::ReadOperation => {
                let SourceControlPayload::Operation(params) = payload else {
                    unreachable!()
                };
                // Reconcile the already-admitted local metadata transaction;
                // this read never initializes a store or replays a new intent.
                let _ = try_apply_pending(context, target).await?;
                let service = NativeOperations::load(context)?
                    .context("TASK_CAPABILITY_SCOPE_OPERATION_REQUIRED")?;
                let operation = project_original_operation(
                    context,
                    &service,
                    &target.binding,
                    &params.operation_id,
                )?;
                Ok(
                    json!({"snapshot":target.binding.snapshot(context,target.facts.as_ref()).await?,"operation":operation}),
                )
            }
        }
    }
}
pub(super) fn project_original_operation(
    context: &NativeIntegrationContext,
    service: &NativeOperations,
    binding: &NativeTaskCapabilityScopeBinding,
    operation: &str,
) -> Result<IntegrationOperationReceipt> {
    let original = service
        .read(context, operation)?
        .context("TASK_CAPABILITY_SCOPE_OPERATION_REQUIRED")?;
    ensure!(
        original.port == "P-TASK"
            && original.method == NativeTaskCapabilityScopeControlMethod::Set.wire(),
        "TASK_CAPABILITY_SCOPE_OPERATION_MISMATCH"
    );
    let Some(control) = binding.read_control_operation(context, operation)? else {
        return Ok(original);
    };
    let phase = match control.phase {
        NativeTaskCapabilityScopeControlPhase::PendingBoundary => {
            IntegrationOperationPhase::Executing
        }
        NativeTaskCapabilityScopeControlPhase::Applied => IntegrationOperationPhase::Completed,
        NativeTaskCapabilityScopeControlPhase::Rejected
        | NativeTaskCapabilityScopeControlPhase::Superseded => IntegrationOperationPhase::Rejected,
        NativeTaskCapabilityScopeControlPhase::OutcomeUnknown => IntegrationOperationPhase::Unknown,
    };
    if original.phase == phase {
        return Ok(original);
    }
    let error = matches!(
        phase,
        IntegrationOperationPhase::Rejected | IntegrationOperationPhase::Unknown
    )
    .then(|| IntegrationError {
        code: control
            .reason_code
            .unwrap_or_else(|| "TASK_CAPABILITY_SCOPE_CONTROL_REJECTED".into()),
        message_key: "integration.task_capability_scope_control_rejected".into(),
        recovery: IntegrationRecovery::ReconcileOriginal,
    });
    match service.transition(context, &original, phase, error) {
        Ok(current) => Ok(current),
        Err(_) => service
            .read(context, operation)?
            .context("TASK_CAPABILITY_SCOPE_OPERATION_OUTCOME_UNKNOWN"),
    }
}
pub(crate) async fn try_apply_pending(
    context: &NativeIntegrationContext,
    target: &NativeTaskCapabilityScopeControlTarget,
) -> Result<bool> {
    apply_pending_binding(context, target.binding.as_ref(), target.facts.as_ref()).await
}
pub(crate) async fn apply_pending_binding(
    context: &NativeIntegrationContext,
    binding: &NativeTaskCapabilityScopeBinding,
    facts: &NativeTaskCapabilityScopeFactory,
) -> Result<bool> {
    let snapshot = binding.snapshot(context, facts).await?;
    if snapshot.effective_from == IntegrationTaskCapabilityScopeBoundary::CurrentSnapshot {
        return Ok(false);
    }
    let boundary = match facts.claim_control_boundary() {
        Ok(boundary) => boundary,
        Err(_) => return Ok(false),
    };
    let native = facts.actual_root().native_tool_execution_witness();
    let callback = NativeTaskCapabilityScopeCallback {
        session_id: native.session_id(),
        native_witness: &native,
    };
    let operation = binding
        .pending_control_operation(context)?
        .context("TASK_CAPABILITY_SCOPE_NO_PENDING_CHANGE")?;
    let commit = format!("source-boundary-{}", snapshot.revision);
    binding
        .commit_boundary(context, &commit, snapshot.revision, facts, &callback)
        .await?;
    if let Some(service) = NativeOperations::load(context)? {
        project_original_operation(context, &service, binding, &operation)?;
    }
    drop(boundary);
    Ok(true)
}
