//! Accept only bytes completed by this connection's existing attachment uploader.
use super::*;
use crate::app_server::attachments::{AttachmentDirectories, attachment_upload_finish};
use crate::app_server::task_spawn::JoinSetExt as _;
use kcoder_app_protocol::{AttachmentUploadFinishParams, AttachmentUploadFinishResult};
use kcoder_state::integrations::office::OfficeInputMetadata;

pub(in crate::app_server) async fn dispatch_upload_finish(
    method: &str,
    id: &Value,
    params: &Value,
    workspace: &QueryEngine,
    outbound: &mpsc::Sender<Value>,
    state: &mut ConnectionState,
    staged: &mut AttachmentDirectories,
) -> Result<bool> {
    if method != "attachment/upload/finish"
        || params
            .get("office_input")
            .is_none_or(|value| value.is_null())
    {
        return Ok(false);
    }
    // An opted-in failure must never fall through to the path-returning legacy
    // uploader. Scope/metadata describe the request; only the native finish
    // result and this connection's staging owner establish byte provenance.
    let cancel = state.input_ended.child_token();
    let prepared = (|| -> Result<_> {
        ensure!(state.integration_office_v1, "OFFICE_INPUT_UNAVAILABLE");
        ensure!(state.knowledge_rpc_tasks.len() < 64, "OFFICE_RPC_BUSY");
        let params: AttachmentUploadFinishParams = serde_json::from_value(params.clone())?;
        ensure!(params.retention.is_none(), "OFFICE_INPUT_UNAVAILABLE");
        let request = params
            .office_input
            .as_ref()
            .context("OFFICE_INPUT_REQUIRED")?;
        request.validate(true)?;
        let metadata: OfficeInputMetadata =
            serde_json::from_value(Value::Object(request.payload.clone()))?;
        metadata.validate()?;
        let native = state
            .integration_context
            .as_ref()
            .context("OFFICE_NATIVE_SCOPE_UNAVAILABLE")?
            .recapture_for_owned_service()?;
        native.validate_scope(&request.scope)?;
        let assets = NativeOfficeFileAssets::capture(
            &native,
            workspace,
            state.integration_office_transfers.clone(),
            None,
        )?;
        let actual = attachment_upload_finish(&params, staged)?;
        let input = assets.prepare_finished_input(&native, staged, &actual, request, &cancel)?;
        Ok((native, assets, input, request.timeout_ms))
    })();
    let (native, assets, input, timeout_ms) = match prepared {
        Ok(prepared) => prepared,
        Err(_) => {
            send(
                outbound,
                error_response(id.clone(), -32075, "OFFICE_INPUT_UNAVAILABLE"),
            )
            .await?;
            return Ok(true);
        }
    };
    let (id, outbound) = (id.clone(), outbound.clone());
    state.knowledge_rpc_tasks.spawn_shared(async move {
        // Cancelling/aborting this connection-owned future also revokes the
        // bounded blocking worker. It cannot silently continue with authority.
        let _cancel_on_drop = cancel.clone().drop_guard();
        let worker_cancel = cancel.clone();
        let mut worker = tokio::task::spawn_blocking(move || {
            assets.commit_finished_input(&native, input, &worker_cancel)
        });
        let result =
            tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), &mut worker).await;
        let response = match result {
            Ok(Ok(Ok(receipt))) => {
                match serde_json::to_value(AttachmentUploadFinishResult::Office(receipt)) {
                    Ok(value) => success_response(id, value),
                    Err(_) => error_response(id, -32076, "OFFICE_INPUT_RESULT_UNCONFIRMED"),
                }
            }
            Ok(_) => error_response(id, -32076, "OFFICE_INPUT_RESULT_UNCONFIRMED"),
            Err(_) => {
                cancel.cancel();
                // Reconcile through the original operation; never replay a
                // potentially committed input or destroy its durable blob.
                let _ = worker.await;
                error_response(id, -32076, "OFFICE_INPUT_RESULT_UNCONFIRMED")
            }
        };
        // The staging owner remains on this connection and cleans up its own
        // original upload on disconnect. Durable material has separate custody.
        let _ = send(&outbound, response).await;
    });
    Ok(true)
}
