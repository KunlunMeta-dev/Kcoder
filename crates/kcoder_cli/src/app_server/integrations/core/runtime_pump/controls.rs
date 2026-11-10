//! Finite controls on the existing owner's queue and original Driver only.
use super::admission::{RuntimeControlMethod, RuntimeControlRequest};
use super::*;
use kcoder_app_rpc_codec as rpc_codec;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OperationRead {
    operation_id: String,
}

impl NativeRuntimePump {
    pub(super) fn control_request(&mut self, call: RuntimeControlRequest) {
        let request = &call.request;
        let result = (|| -> Result<IntegrationReply> {
            call.context.validate_scope(&request.scope)?;
            // Loading a canonical existing store populates only original indexes;
            // it never queues recovery, creates storage or grants an admission.
            if self.driver.is_none() {
                self.driver = NativeRuntimeDriver::load(&call.context)?;
            }
            let driver = self.driver.as_mut().context("RUNTIME_UNAVAILABLE")?;
            match call.method {
                RuntimeControlMethod::ReadOperation => {
                    let params: OperationRead =
                        serde_json::from_value(Value::Object(request.payload.clone()))?;
                    ensure!(
                        !params.operation_id.is_empty() && params.operation_id.len() <= 256,
                        "RUNTIME_OPERATION_INVALID"
                    );
                    let receipt = driver.read_operation(&call.context, &params.operation_id)?;
                    let unsubmitted_input =
                        driver.unsubmitted_input(&call.context, &params.operation_id)?;
                    let result = IntegrationOperationReadResult {
                        receipt: receipt
                            .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
                        unsubmitted_input,
                    };
                    completed(request, serde_json::to_value(result)?)
                }
                RuntimeControlMethod::ReadTask => {
                    let reference: IntegrationRuntimeReadTaskParams =
                        rpc_codec::decode(Value::Object(request.payload.clone()))?;
                    let Some((task, revision)) =
                        driver.read_confirmed_task_reference(&call.context, &reference)?
                    else {
                        return Ok(failed(
                            request,
                            IntegrationStatus::Unavailable,
                            "RUNTIME_OUTPUT_UNCONFIRMED",
                        ));
                    };
                    completed_task_read(request, task, revision)
                }
                RuntimeControlMethod::CancelTask => {
                    let reference: IntegrationRuntimeReadTaskParams =
                        rpc_codec::decode(Value::Object(request.payload.clone()))?;
                    let original = driver.operation_for_reference(&call.context, &reference)?;
                    let task = driver.read_task_reference(&call.context, &reference)?;
                    let terminal = matches!(
                        task.state,
                        IntegrationTaskState::Completed
                            | IntegrationTaskState::Failed
                            | IntegrationTaskState::Cancelled
                    );
                    // A cold read cannot appoint itself the owner of a live run.
                    ensure!(
                        terminal || self.active.contains_key(&original),
                        "RUNTIME_OWNER_UNAVAILABLE"
                    );
                    let acceptance = driver
                        .read_operation(&call.context, &original)?
                        .and_then(|receipt| receipt.runtime_acceptance)
                        .context("RUNTIME_ACCEPTANCE_UNCONFIRMED")?;
                    let submission = driver.cancel_task(&call.context, &original, request)?;
                    match submission {
                        RuntimeSubmission::Known(value) => Ok(accepted(request, value)),
                        RuntimeSubmission::Queued => Ok(accepted(request, acceptance)),
                        RuntimeSubmission::Unconfirmed => Ok(failed(
                            request,
                            IntegrationStatus::Unknown,
                            "RUNTIME_CANCELLATION_UNCONFIRMED",
                        )),
                    }
                }
            }
        })();
        let reply = result.unwrap_or_else(|_| {
            failed(
                request,
                IntegrationStatus::Unavailable,
                "RUNTIME_CONTROL_UNAVAILABLE",
            )
        });
        let _ = call.reply.send(reply);
    }
}

pub(in crate::app_server) fn completed_task_read(
    request: &IntegrationRequest,
    task: IntegrationRuntimeTask,
    revision: u64,
) -> Result<IntegrationReply> {
    let mut reply = completed(request, serde_json::to_value(task)?)?;
    reply.entity_revision = IntegrationNullable::Value(revision.to_string());
    Ok(reply)
}

pub(super) fn completed(request: &IntegrationRequest, value: Value) -> Result<IntegrationReply> {
    let result = value
        .as_object()
        .cloned()
        .context("RUNTIME_CONTROL_RESULT_INVALID")?;
    Ok(IntegrationReply {
        contract_version: request.contract_version,
        request_id: request.request_id.clone(),
        status: IntegrationStatus::Completed,
        operation_id: request
            .operation_id
            .clone()
            .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
        entity_revision: IntegrationNullable::Null,
        observed_at: chrono::Utc::now().to_rfc3339(),
        result: IntegrationNullable::Value(result),
        error: IntegrationNullable::Null,
    })
}
