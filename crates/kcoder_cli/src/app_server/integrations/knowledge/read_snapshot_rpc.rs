//! Standard readonly envelope for the existing canonical task preparation snapshot.
use super::rpc::configuration::EngineSnapshot;
use super::{NativeMemorySnapshotReadError, read_thread_memory_snapshot};
use crate::app_server::integrations::core::{NativeIntegrationContext, NativeMemoryService};
use kcoder_engine::QueryEngine;
use kcoder_types::integrations::core::*;
use serde::Deserialize;
use serde_json::{Map, Value, json};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotReadParams {
    thread_id: String,
    task_id: String,
}

/// Root resolves the authorized actual thread first. This function never constructs a runtime.
pub(crate) fn request_native_memory_snapshot(
    request: &IntegrationRequest,
    authorized_thread_engine: &QueryEngine,
    native: &NativeIntegrationContext,
) -> IntegrationReply {
    use NativeMemorySnapshotReadError as Failure;
    if request.validate(false).is_err() {
        return failed(request, Failure::InvalidRequest);
    }
    let params: SnapshotReadParams =
        match serde_json::from_value(Value::Object(request.payload.clone())) {
            Ok(params) => params,
            Err(_) => return failed(request, Failure::InvalidRequest),
        };
    if params.thread_id.trim().is_empty() || params.task_id.trim().is_empty() {
        return failed(request, Failure::InvalidRequest);
    }
    if params.thread_id != authorized_thread_engine.session_id()
        || native.validate_scope(&request.scope).is_err()
    {
        return failed(request, Failure::Denied);
    }
    if EngineSnapshot::capture(authorized_thread_engine)
        .and_then(|binding| binding.verify_binding(authorized_thread_engine, native))
        .is_err()
    {
        return failed(request, Failure::Denied);
    }
    let source = match NativeMemoryService::load(native) {
        Ok(Some(source)) => source,
        _ => return failed(request, Failure::Unavailable),
    };
    let snapshot = match read_thread_memory_snapshot(
        native,
        authorized_thread_engine,
        &params.task_id,
        Some(&source),
    ) {
        Ok(snapshot) => snapshot,
        Err(error) => return failed(request, error),
    };
    if native.validate_scope(&request.scope).is_err() {
        return failed(request, Failure::Denied);
    }
    let result = json!({"snapshot":snapshot}).as_object().cloned();
    let reply = envelope(request, IntegrationStatus::Completed, result, None);
    if reply.validate().is_err() {
        return failed(request, Failure::Unavailable);
    }
    reply
}
fn failed(
    request: &IntegrationRequest,
    failure: NativeMemorySnapshotReadError,
) -> IntegrationReply {
    envelope(
        request,
        failure.status(),
        None,
        Some(IntegrationError {
            code: failure.code().into(),
            recovery: failure.recovery(),
            message_key: "knowledgeIntegration.operationFailed".into(),
        }),
    )
}
fn envelope(
    request: &IntegrationRequest,
    status: IntegrationStatus,
    result: Option<Map<String, Value>>,
    error: Option<IntegrationError>,
) -> IntegrationReply {
    IntegrationReply {
        contract_version: request.contract_version,
        request_id: request.request_id.clone(),
        status,
        operation_id: request
            .operation_id
            .clone()
            .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
        entity_revision: IntegrationNullable::Null,
        observed_at: chrono::Utc::now().to_rfc3339(),
        result: result.map_or(IntegrationNullable::Null, IntegrationNullable::Value),
        error: error.map_or(IntegrationNullable::Null, IntegrationNullable::Value),
    }
}
