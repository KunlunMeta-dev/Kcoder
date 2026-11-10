//! Opt-in profile configuration is independent of model metadata/health capability versions.
use super::*;
use crate::app_server::task_spawn::JoinSetExt as _;
use crate::app_server::{ConnectionState, error_response, send, success_response};
use kcoder_app_protocol::integrations::ModelPolicySettingsMethod;
use kcoder_app_rpc_codec as rpc_codec;
use tokio::sync::mpsc;
pub(in crate::app_server) async fn dispatch(
    method: &str,
    id: &Value,
    params: &Value,
    engine: &QueryEngine,
    outbound: &mpsc::Sender<Value>,
    state: &mut ConnectionState,
) -> Result<bool> {
    let method: ModelPolicySettingsMethod =
        match serde_json::from_value(Value::String(method.into())) {
            Ok(method) => method,
            Err(_) => return Ok(false),
        };
    let captured = (|| -> Result<_> {
        ensure!(
            state.integration_model_policy_settings_v1 && state.knowledge_rpc_tasks.len() < 64,
            "MODEL_POLICY_SETTINGS_UNAVAILABLE"
        );
        let request: IntegrationRequest = rpc_codec::decode(params.clone())?;
        request.validate(method == ModelPolicySettingsMethod::Save)?;
        let worker = NativeModelPolicySettings::capture(
            state
                .integration_context
                .as_ref()
                .context("MODEL_POLICY_SETTINGS_UNAVAILABLE")?,
            engine,
            request.clone(),
            Arc::downgrade(&state.source_management_owner),
            state.input_ended.child_token(),
        )?;
        Ok((request, worker))
    })();
    let (request, worker) = match captured {
        Ok(captured) => captured,
        Err(error) => {
            send(
                outbound,
                error_response(id.clone(), -32083, public_error(&error)),
            )
            .await?;
            return Ok(true);
        }
    };
    let (id, outbound, ended) = (id.clone(), outbound.clone(), state.input_ended.clone());
    state.knowledge_rpc_tasks.spawn_shared(async move {
        let cancel = worker.cancel.clone();
        let _cancel_on_drop = cancel.clone().drop_guard();
        let job = crate::app_server::task_spawn::spawn_blocking(
            move || -> Result<(IntegrationStatus, Value)> {
                worker.check()?;
                match method {
                    ModelPolicySettingsMethod::Read => Ok((
                        IntegrationStatus::Completed,
                        serde_json::to_value(worker.read()?)?,
                    )),
                    ModelPolicySettingsMethod::ReadOperation => Ok((
                        IntegrationStatus::Completed,
                        serde_json::to_value(IntegrationOperationReadResult {
                            unsubmitted_input: None,
                            receipt: worker
                                .read_operation()?
                                .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
                        })?,
                    )),
                    ModelPolicySettingsMethod::Save => {
                        let saved = worker.save()?;
                        // The RPC completed an observation/transaction attempt;
                        // only the original nested receipt reports write outcome.
                        Ok((IntegrationStatus::Completed, serde_json::to_value(saved)?))
                    }
                }
            },
        );
        let result =
            tokio::time::timeout(std::time::Duration::from_millis(request.timeout_ms), job).await;
        if ended.is_cancelled() {
            return;
        }
        let response = match result {
            Ok(Ok(Ok((status, Value::Object(result))))) => success_response(
                id,
                json!(IntegrationReply {
                    contract_version: request.contract_version,
                    request_id: request.request_id,
                    operation_id: request
                        .operation_id
                        .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
                    entity_revision: IntegrationNullable::Null,
                    status,
                    observed_at: chrono::Utc::now().to_rfc3339(),
                    result: IntegrationNullable::Value(result),
                    error: IntegrationNullable::Null,
                }),
            ),
            Ok(Ok(Err(error))) => error_response(id, -32083, public_error(&error)),
            _ => error_response(id, -32083, "MODEL_POLICY_SETTINGS_OUTCOME_UNKNOWN"),
        };
        let _ = send(&outbound, response).await;
    });
    Ok(true)
}
fn public_error(error: &anyhow::Error) -> &'static str {
    error
        .chain()
        .find_map(|error| match error.to_string().as_str() {
            "MODEL_ORGANIZATION_POLICY_REQUIRED" => Some("MODEL_ORGANIZATION_POLICY_REQUIRED"),
            "MODEL_POLICY_SETTINGS_REVISION_REQUIRED" => {
                Some("MODEL_POLICY_SETTINGS_REVISION_REQUIRED")
            }
            "MODEL_POLICY_SETTINGS_REVISION_CONFLICT" => {
                Some("MODEL_POLICY_SETTINGS_REVISION_CONFLICT")
            }
            "MODEL_POLICY_SETTINGS_CUSTOM_FILE_UNAVAILABLE" => {
                Some("MODEL_POLICY_SETTINGS_CUSTOM_FILE_UNAVAILABLE")
            }
            "MODEL_POLICY_SETTINGS_TARGET_CHANGED" => Some("MODEL_POLICY_SETTINGS_TARGET_CHANGED"),
            "MODEL_POLICY_SETTINGS_MODEL_UNAVAILABLE" => {
                Some("MODEL_POLICY_SETTINGS_MODEL_UNAVAILABLE")
            }
            "MODEL_POLICY_SETTINGS_OPERATION_MISMATCH" => {
                Some("MODEL_POLICY_SETTINGS_OPERATION_MISMATCH")
            }
            "MODEL_POLICY_SETTINGS_INVALID_REQUEST" => {
                Some("MODEL_POLICY_SETTINGS_INVALID_REQUEST")
            }
            "MODEL_POLICY_SETTINGS_CALLER_EXPIRED" => Some("MODEL_POLICY_SETTINGS_CALLER_EXPIRED"),
            _ => None,
        })
        .unwrap_or("MODEL_POLICY_SETTINGS_UNAVAILABLE")
}
