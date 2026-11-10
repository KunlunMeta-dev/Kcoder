//! Native original-operation UI control keeps the connection loop free and never runs a model.
use super::*;
use crate::app_server::task_spawn::JoinSetExt as _;
use crate::app_server::{ConnectionState, error_response, send, success_response};
use kcoder_app_protocol::integrations::RemoteOperationControlMethod;
use kcoder_app_rpc_codec as rpc_codec;
use kcoder_engine::QueryEngine;
use kcoder_types::integrations::core::{RemoteOperationControlParams, RemoteOperationListParams};
enum Request {
    List(RemoteOperationListParams),
    One(RemoteOperationControlParams, bool),
}
use tokio::sync::mpsc;

pub(in crate::app_server) async fn dispatch(
    method: &str,
    id: &Value,
    params: &Value,
    engine: &QueryEngine,
    outbound: &mpsc::Sender<Value>,
    state: &mut ConnectionState,
) -> Result<bool> {
    let method: RemoteOperationControlMethod =
        match serde_json::from_value(Value::String(method.into())) {
            Ok(method) => method,
            Err(_) => return Ok(false),
        };
    let prepared = (|| -> Result<_> {
        ensure!(
            state.integration_remote_operation_control_v1 && state.knowledge_rpc_tasks.len() < 64,
            "REMOTE_CONTROL_CAPABILITY_UNAVAILABLE"
        );
        let request = if method == RemoteOperationControlMethod::List {
            let request: RemoteOperationListParams = rpc_codec::decode(params.clone())?;
            request.validate()?;
            Request::List(request)
        } else {
            let request: RemoteOperationControlParams = rpc_codec::decode(params.clone())?;
            request.validate(method == RemoteOperationControlMethod::Cancel)?;
            Request::One(request, method == RemoteOperationControlMethod::Cancel)
        };
        let worker = NativeRemoteOperationControl::capture(
            state
                .integration_context
                .as_ref()
                .context("REMOTE_CONTROL_SCOPE_UNAVAILABLE")?,
            engine,
            Arc::downgrade(&state.source_management_owner),
            state.input_ended.child_token(),
        )?;
        Ok((request, worker, state.native_remote_host_client.clone()))
    })();
    let (request, worker, host) = match prepared {
        Ok(prepared) => prepared,
        Err(_) => {
            send(
                outbound,
                error_response(id.clone(), -32086, "REMOTE_CONTROL_UNAVAILABLE"),
            )
            .await?;
            return Ok(true);
        }
    };
    let (outbound, id, ended) = (outbound.clone(), id.clone(), state.input_ended.clone());
    state.knowledge_rpc_tasks.spawn_shared(async move {
        let cancel = worker.cancel_token();
        let _cancel_on_drop = cancel.drop_guard();
        if let Request::One(ref request, false) = request
            && worker
                .reconcile_endpoint(request, host.as_ref(), &id)
                .await
                .is_err()
        {
            let _ = send(
                &outbound,
                error_response(id, -32086, "REMOTE_CONTROL_UNAVAILABLE"),
            )
            .await;
            return;
        }
        let job = crate::app_server::task_spawn::spawn_blocking(move || -> Result<Value> {
            match request {
                Request::List(request) => Ok(serde_json::to_value(worker.list(&request)?)?),
                Request::One(request, cancellation) => {
                    Ok(serde_json::to_value(worker.run(&request, cancellation)?)?)
                }
            }
        });
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), job).await;
        if ended.is_cancelled() {
            return;
        }
        let response = match result {
            Ok(Ok(Ok(reply))) => success_response(id, reply),
            Ok(Ok(Err(_))) => error_response(id, -32086, "REMOTE_CONTROL_UNAVAILABLE"),
            _ => error_response(id, -32086, "REMOTE_CONTROL_OUTCOME_UNKNOWN"),
        };
        let _ = send(&outbound, response).await;
    });
    Ok(true)
}
