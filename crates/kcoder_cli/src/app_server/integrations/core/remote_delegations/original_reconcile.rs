//! Current management authentication may only observe the stored original endpoint.
use super::*;
use kcoder_app_rpc_codec as rpc_codec;
use kcoder_types::integrations::core::*;
use transport::host_client::{NativeHostMethod, NativeRemoteHostClient};

pub fn reconcile<'a>(
    control: &'a NativeRemoteOperationControl,
    request: &'a RemoteOperationControlParams,
    host: Option<&'a Arc<NativeRemoteHostClient>>,
    rpc_id: &'a Value,
) -> futures::future::BoxFuture<'a, Result<()>> {
    Box::pin(reconcile_producer(control, request, host, rpc_id))
}
async fn reconcile_producer(
    control: &NativeRemoteOperationControl,
    request: &RemoteOperationControlParams,
    host: Option<&Arc<NativeRemoteHostClient>>,
    rpc_id: &Value,
) -> Result<()> {
    request.validate(false)?;
    control.check()?;
    let native = control.native();
    native.validate_scope(&request.scope)?;
    let Some(observed) = NativeRemoteJournal::read(native, &request.operation_id)? else {
        return Ok(());
    };
    let Some(mut endpoint) = observed.endpoint_receiver else {
        return Ok(());
    };
    // A known terminal historical receipt requires no transport or execution.
    if endpoint
        .outcome
        .is_some_and(|outcome| outcome != NativeRemoteCallOutcomeV1::OutcomeUnknown)
    {
        return Ok(());
    }
    native.validate_scope(&observed.scope_at_creation)?;
    let original = NativeOperations::load(native)?
        .context("REMOTE_ORIGINAL_OPERATION_MISSING")?
        .read(native, &request.operation_id)?
        .context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
    ensure!(
        original.port == "P-REMOTE" && original.method == "delegate",
        "REMOTE_OPERATION_KIND_MISMATCH"
    );
    let target: NativeRemoteTargetRefV1 =
        rpc_codec::decode(observed.recipient_identity["target"].clone())?;
    ensure!(
        observed.recipient_identity["kind"] == "native_ssh_acp"
            && target.target_revision == observed.recipient_revision,
        "REMOTE_ORIGINAL_TARGET_REQUIRED"
    );
    let registry =
        registry::observe(native, control.engine())?.context("REMOTE_RUNNER_NOT_AVAILABLE")?;
    ensure!(
        registry
            .peers()?
            .iter()
            .any(|peer| peer["kind"] == "native_ssh_acp"
                && peer["target"] == serde_json::to_value(&target).unwrap_or(Value::Null)),
        "REMOTE_ORIGINAL_TARGET_CHANGED"
    );
    let host = host.context("REMOTE_CONTROL_CURRENT_HOST_REQUIRED")?;
    let read = NativeRemoteOriginalReadV1 {
        version: NATIVE_REMOTE_CONTROL_VERSION,
        request_id: request.request_id.clone(),
        operation_id: request.operation_id.clone(),
        endpoint_instance_id: endpoint.endpoint_instance_id.clone(),
        source_scope: observed.scope_at_creation,
        receiver_accepted: endpoint.accepted.clone(),
    };
    read.validate().map_err(anyhow::Error::msg)?;
    let cancel = control.cancel_token();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    let reply = host
        .request(
            NativeHostMethod::ReadOriginal,
            serde_json::json!({"managementRpcId":rpc_id,"target":target,"original":read,
            "deadlineUtcMs": super::launch::now()? + 15_000}),
            deadline,
            &cancel,
        )
        .await?;
    control.check()?;
    registry.check_current()?;
    let reply: NativeRemoteOriginalReadReplyV1 = rpc_codec::decode(reply)?;
    ensure!(
        reply.original == read && (reply.outcome.is_none() || reply.finished_at_ms.is_some()),
        "REMOTE_ORIGINAL_READ_RECEIPT_CHANGED"
    );
    if reply.outcome.is_none() {
        return Ok(());
    }
    let guard = NativeDomainGuard::observe(
        native.profile()?,
        native.scope(),
        NativeDomain::RemoteDelegations,
    )?
    .context("REMOTE_JOURNAL_MISSING")?;
    let store = NativeRemoteDelegationStore::open_in(
        &guard.directory(native.profile()?)?,
        OsStr::new("data"),
        native.scope(),
    )?
    .context("REMOTE_JOURNAL_MISSING")?;
    endpoint.outcome = reply.outcome;
    control.check()?;
    // This updates only the original endpoint observation. No usage, cost,
    // budget, operation execution, cleanup or artifact completion is inferred.
    store.record_endpoint_receiver(&request.operation_id, &endpoint)?;
    control.check()?;
    Ok(())
}
