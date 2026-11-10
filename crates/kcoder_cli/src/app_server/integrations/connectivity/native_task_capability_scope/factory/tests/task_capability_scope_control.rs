use super::*;
use crate::app_server::integrations::connectivity::task_capability_scope_control::{
    NativeTaskCapabilityScopeControlMethod, NativeTaskCapabilityScopeControlPhase,
    NativeTaskCapabilityScopeControlTarget, try_apply_pending,
};
use tokio_util::sync::CancellationToken;

pub(super) async fn verify_public_control(
    context: &NativeIntegrationContext,
    raw: &QueryEngine,
    lease: &SessionLease,
    connection: &crate::app_server::ConnectionState,
    binding: &Arc<NativeTaskCapabilityScopeBinding>,
    facts: &Arc<NativeTaskCapabilityScopeFactory>,
    catalog: &Arc<NativeConnectivitySourceCatalog>,
) -> Result<()> {
    let target = NativeTaskCapabilityScopeControlTarget::capture(
        context,
        binding.clone(),
        facts.clone(),
        catalog.clone(),
    )
    .await?;
    let reference = binding.accepted().control_target();
    assert!(
        NativeTaskCapabilityScopeControlTarget::restore(
            context,
            &reference,
            facts.clone(),
            catalog.clone()
        )
        .await?
        .is_some()
    );
    let mut wrong_reference = reference.clone();
    wrong_reference.initial_attempt.attempt_id = "missing-original-attempt".into();
    assert!(
        NativeTaskCapabilityScopeControlTarget::restore(
            context,
            &wrong_reference,
            facts.clone(),
            catalog.clone()
        )
        .await
        .is_err()
    );
    let selection = IntegrationTaskCapabilityScopeSelection {
        mode: IntegrationTaskCapabilityScopeMode::InheritCurrent,
        sources: vec![],
    };
    let mut request = IntegrationRequest {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: "actual-public-set-sources".into(),
        scope: context.scope().clone(),
        operation_id: Some("actual-public-control-original".into()),
        expected_revision: Some("1".into()),
        timeout_ms: 30_000,
        cancellation_ref: None,
        payload: serde_json::json!({"target":binding.accepted().control_target(),"params":{"threadId":raw.session_id(),"selection":selection}})
            .as_object()
            .unwrap()
            .clone(),
    };
    let original_request = request.clone();
    let permit = crate::app_server::integrations::core::task_capability_scope_control::NativeTaskCapabilityScopeManagementPermit::from_public_control(
        connection, raw, lease, &request, &binding.task_key()?, &selection)?;
    let held = raw.native_tool_gate_handle().try_boundary(&raw.state)?;
    let reply = NativeTaskCapabilityScopeControlMethod::Set
        .handle_public(
            context,
            &request,
            &target,
            Some(&permit),
            CancellationToken::new(),
        )
        .await?;
    assert_eq!(reply["snapshot"]["revision"], 2);
    assert_eq!(reply["snapshot"]["effectiveFrom"], "next_tool_boundary");
    assert_eq!(reply["operation"]["phase"], "executing");
    let saved = binding
        .read_control_operation(context, "actual-public-control-original")?
        .unwrap();
    assert!(saved.phase == NativeTaskCapabilityScopeControlPhase::PendingBoundary);
    // The native intent was admitted and persisted in the original Record.
    // A disconnected live request permit is now unusable for a new write.
    connection.input_ended.cancel();
    assert!(
        permit
            .verify(
                context.scope(),
                &binding.task_key()?,
                "actual-public-control-original",
                &selection
            )
            .is_err()
    );
    drop(permit);
    drop(held);
    assert!(try_apply_pending(context, &target).await?);
    assert!(!try_apply_pending(context, &target).await?);
    let saved = binding
        .read_control_operation(context, "actual-public-control-original")?
        .unwrap();
    assert!(saved.phase == NativeTaskCapabilityScopeControlPhase::Applied);
    let active = binding.snapshot(context, facts.as_ref()).await?;
    assert_eq!(active.revision, 3);
    assert_eq!(
        active.effective_from,
        IntegrationTaskCapabilityScopeBoundary::CurrentSnapshot
    );

    let resumed = crate::app_server::ConnectionState {
        integration_context: Some(context.recapture_for_owned_service()?),
        ..Default::default()
    };
    let permit = crate::app_server::integrations::core::task_capability_scope_control::NativeTaskCapabilityScopeManagementPermit::from_public_control(
        &resumed, raw, lease, &request, &binding.task_key()?, &selection)?;
    // A lost caller ACK reads the original operation and does not stage again.
    let repeated = NativeTaskCapabilityScopeControlMethod::Set
        .handle_public(
            context,
            &request,
            &target,
            Some(&permit),
            CancellationToken::new(),
        )
        .await?;
    assert_eq!(repeated["snapshot"]["revision"], 3);
    assert_eq!(repeated["operation"]["phase"], "completed");
    assert_eq!(binding.snapshot(context, facts.as_ref()).await?, active);
    drop(permit);
    request.operation_id = None;
    request.expected_revision = None;
    request.payload = serde_json::json!({"target":binding.accepted().control_target(),"params":{"threadId":raw.session_id()}})
        .as_object()
        .unwrap()
        .clone();
    let read = NativeTaskCapabilityScopeControlMethod::Read
        .handle_public(context, &request, &target, None, CancellationToken::new())
        .await?;
    assert_eq!(read["revision"], 3);
    request.payload = serde_json::json!({"target":binding.accepted().control_target(),"operationId":"actual-public-control-original"})
        .as_object()
        .unwrap()
        .clone();
    let observed = NativeTaskCapabilityScopeControlMethod::ReadOperation
        .handle_public(context, &request, &target, None, CancellationToken::new())
        .await?;
    assert_eq!(observed["operation"]["phase"], "completed");
    assert!(
        binding
            .read_control_operation(context, "a-new-unadmitted-operation")?
            .is_none()
    );
    let mut altered = original_request;
    altered.payload.get_mut("target").unwrap()["initialAttempt"]["attemptId"] =
        serde_json::json!("another-original-attempt");
    let service = crate::app_server::integrations::core::NativeOperations::load(context)?.unwrap();
    assert!(
        service
            .begin(context, &altered, "P-TASK", "setTaskSources")
            .is_err(),
        "the original operation freezes its exact target tuple"
    );
    assert!(
        NativeTaskCapabilityScopeControlMethod::Set
            .handle_public(context, &altered, &target, None, CancellationToken::new())
            .await
            .is_err()
    );
    assert_eq!(binding.snapshot(context, facts.as_ref()).await?, active);
    Ok(())
}
