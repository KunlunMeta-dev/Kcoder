//! Finite connection-owned metadata RPCs. These do not activate a task or authorize a model call.
use super::*;
use crate::app_server::task_spawn::JoinSetExt as _;
use crate::app_server::{ConnectionState, error_response, send, success_response};
use kcoder_app_protocol::integrations::ModelPoliciesMethod;
use kcoder_app_rpc_codec as rpc_codec;
use serde_json::Value;
use tokio::sync::mpsc;

pub(in crate::app_server) async fn dispatch(
    method: &str,
    id: &Value,
    params: &Value,
    workspace: &QueryEngine,
    outbound: &mpsc::Sender<Value>,
    state: &mut ConnectionState,
) -> Result<bool> {
    if super::settings::dispatch(method, id, params, workspace, outbound, state).await? {
        return Ok(true);
    }
    let method = match method {
        "integrations/models/readPolicies" => ModelPoliciesMethod::ReadPolicies,
        "integrations/models/readHealth" => ModelPoliciesMethod::ReadHealth,
        "integrations/models/readUsage" => ModelPoliciesMethod::ReadUsage,
        "integrations/models/resolveSelection" => ModelPoliciesMethod::ResolveSelection,
        _ => return Ok(false),
    };
    let prepared = (|| -> Result<_> {
        let negotiated = if method == ModelPoliciesMethod::ReadUsage {
            state.integration_model_usage_v1
        } else if method == ModelPoliciesMethod::ReadHealth {
            state.integration_model_health_v1
        } else {
            state.integration_model_policies_v1
        };
        ensure!(negotiated, "MODEL_POLICY_UNAVAILABLE");
        ensure!(state.knowledge_rpc_tasks.len() < 64, "MODEL_POLICY_BUSY");
        let request: IntegrationRequest = rpc_codec::decode(params.clone())
            .map_err(|_| anyhow::anyhow!("MODEL_POLICY_INVALID_REQUEST"))?;
        if method == ModelPoliciesMethod::ResolveSelection {
            let selection: IntegrationModelResolutionRequest =
                rpc_codec::decode(Value::Object(request.payload.clone()))
                    .map_err(|_| anyhow::anyhow!("MODEL_POLICY_INVALID_REQUEST"))?;
            // This public surface previews a new workspace selection. An
            // actual task's inherited or verifier-locked model belongs to its
            // original session/Office host, never this bootstrap Engine.
            ensure!(
                matches!(
                    selection.selection,
                    IntegrationModelSelectionIntent::AutoPolicy { .. }
                        | IntegrationModelSelectionIntent::Explicit { .. }
                ),
                "MODEL_SELECTION_REQUIRES_TASK_CONTEXT"
            );
        }
        OwnedModelPolicyRequest::capture(
            state
                .integration_context
                .as_ref()
                .context("MODEL_POLICY_UNAVAILABLE")?,
            workspace,
            request,
            method,
            Arc::downgrade(&state.source_management_owner),
            state.input_ended.child_token(),
        )
    })();
    let prepared = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            send(
                outbound,
                error_response(id.clone(), -32082, public_error(&error)),
            )
            .await?;
            return Ok(true);
        }
    };
    let (id, outbound) = (id.clone(), outbound.clone());
    let ended = state.input_ended.clone();
    state.knowledge_rpc_tasks.spawn_shared(async move {
        let result = prepared.run().await;
        if ended.is_cancelled() {
            return;
        }
        let response = match result {
            Ok(reply) => match serde_json::to_value(reply) {
                Ok(value) => success_response(id, value),
                Err(_) => error_response(id, -32082, "MODEL_POLICY_RESULT_UNCONFIRMED"),
            },
            Err(error) => error_response(id, -32082, public_error(&error)),
        };
        let _ = send(&outbound, response).await;
    });
    Ok(true)
}
fn public_error(error: &anyhow::Error) -> &'static str {
    error
        .chain()
        .find_map(|error| match error.to_string().as_str() {
            "MODEL_POLICY_INVALID_REQUEST" => Some("MODEL_POLICY_INVALID_REQUEST"),
            "MODEL_POLICY_BUSY" => Some("MODEL_POLICY_BUSY"),
            "MODEL_SELECTION_REQUIRES_TASK_CONTEXT" => {
                Some("MODEL_SELECTION_REQUIRES_TASK_CONTEXT")
            }
            "MODEL_AUTO_POLICY_UNAVAILABLE" => Some("MODEL_AUTO_POLICY_UNAVAILABLE"),
            "MODEL_AUTO_POLICY_DISABLED" => Some("MODEL_AUTO_POLICY_DISABLED"),
            "MODEL_AUTO_CONFIGURATION_BLOCKED" => Some("MODEL_AUTO_CONFIGURATION_BLOCKED"),
            "MODEL_AUTO_CANDIDATE_COOLING_DOWN" => Some("MODEL_AUTO_CANDIDATE_COOLING_DOWN"),
            "MODEL_AUTO_PROBE_BUSY" => Some("MODEL_AUTO_PROBE_BUSY"),
            "MODEL_AUTO_POLICY_VERSION_CHANGED" => Some("MODEL_AUTO_POLICY_VERSION_CHANGED"),
            "MODEL_AUTO_NO_ELIGIBLE_CANDIDATE" => Some("MODEL_AUTO_NO_ELIGIBLE_CANDIDATE"),
            "MODEL_AUTO_CONFIGURATION_CHANGED" => Some("MODEL_AUTO_CONFIGURATION_CHANGED"),
            "MODEL_ORGANIZATION_POLICY_REQUIRED" => Some("MODEL_ORGANIZATION_POLICY_REQUIRED"),
            "MODEL_DATA_POLICY_DENIED" => Some("MODEL_DATA_POLICY_DENIED"),
            "MODEL_POLICY_CANCELLED" | "MODEL_POLICY_CALLER_EXPIRED" => {
                Some("MODEL_POLICY_CANCELLED")
            }
            _ => None,
        })
        .unwrap_or("MODEL_POLICY_UNAVAILABLE")
}
