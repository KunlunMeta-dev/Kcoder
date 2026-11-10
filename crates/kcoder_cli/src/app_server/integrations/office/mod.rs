//! Business RPC leaf. The composition root supplies authenticated host context.
#[cfg(test)]
mod deferred_projection_tests;
pub(crate) mod lazy_session;
pub(crate) mod native_assets;
pub(crate) mod native_host;
mod organization_policy;
pub(in crate::app_server) use organization_policy::authorize_office_action as authorize_agent_definition_action;
#[cfg(test)]
mod private;
pub(crate) mod rpc;
mod runtime_port;
pub(crate) mod settings;
pub(crate) mod startup_binding;
pub(crate) mod turn_binding;
use kcoder_app_protocol::integrations::office::OfficeMethod;
use kcoder_engine::integrations::office::OfficeService;
use kcoder_office_worker::{node_generator, read_worker};
use kcoder_types::integrations::core::*;
pub use node_generator::OfficeNodeGenerator;
pub use read_worker::{OfficeReadHeader, OfficeReadWorker, run_read_worker};
use tokio_util::sync::CancellationToken;

/// No method accepts an arbitrary port/provider or caller-selected storage path.
pub async fn dispatch(
    method: &str,
    request: &IntegrationRequest,
    service: &OfficeService,
    cancel: &CancellationToken,
) -> IntegrationReply {
    let result = async {
        let method_kind = OfficeMethod::parse(method)
            .ok_or_else(|| anyhow::anyhow!("OFFICE_METHOD_UNSUPPORTED"))?;
        request.validate(method_kind.is_mutation())?;
        // Cancellation is cooperative; owned generators/ports receive this token
        // and settle before returning. Mutation timeout is an unknown outcome.
        let scoped = cancel.child_token();
        let work = service.dispatch(method, request, method_kind.action(), &scoped);
        tokio::pin!(work);
        tokio::select! {
            result=&mut work=>result,
            _=tokio::time::sleep(std::time::Duration::from_millis(request.timeout_ms))=>{
                scoped.cancel();
                let _=tokio::time::timeout(std::time::Duration::from_secs(2),&mut work).await;
                anyhow::bail!("OFFICE_TIMEOUT")
            }
        }
    }
    .await;
    reply_result(method, request, result)
}

pub(crate) fn reply_result(
    method: &str,
    request: &IntegrationRequest,
    result: anyhow::Result<serde_json::Value>,
) -> IntegrationReply {
    let observed_at = chrono::Utc::now().to_rfc3339();
    match result {
        Ok(value) => IntegrationReply {
            contract_version: request.contract_version,
            request_id: request.request_id.clone(),
            status: IntegrationStatus::Completed,
            operation_id: request
                .operation_id
                .clone()
                .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
            entity_revision: IntegrationNullable::Null,
            observed_at,
            result: IntegrationNullable::Value(
                value
                    .as_object()
                    .cloned()
                    .unwrap_or_else(|| serde_json::Map::from_iter([("value".into(), value)])),
            ),
            error: IntegrationNullable::Null,
        },
        Err(error) => {
            let code = public_error(&error);
            let mutation = OfficeMethod::parse(method).is_some_and(OfficeMethod::is_mutation);
            let uncertain = mutation
                && matches!(
                    code.as_str(),
                    "OFFICE_TIMEOUT"
                        | "OFFICE_STORE_BUSY"
                        | "OFFICE_RECONCILIATION_REQUIRED"
                        | "OFFICE_PORT_UNCONFIRMED"
                        | "OFFICE_RUNTIME_ACCEPTANCE_UNCONFIRMED"
                        | "OFFICE_SCOPE_CHANGED"
                        | "OFFICE_CANCELLED"
                        | "OFFICE_CLEANUP_UNCONFIRMED"
                        | "OFFICE_HOST_UNCONFIRMED"
                        | "OFFICE_OPERATION_FAILED"
                );
            let unavailable = matches!(
                code.as_str(),
                "OFFICE_DISABLED"
                    | "OFFICE_DEPENDENCY_UNAVAILABLE"
                    | "OFFICE_DEPENDENCY_UNKNOWN"
                    | "OFFICE_FORMAT_UNAVAILABLE"
                    | "OFFICE_INPUT_PROVIDER_UNAVAILABLE"
                    | "OFFICE_ORGANIZATION_PROVIDER_UNAVAILABLE"
            );
            IntegrationReply {
                contract_version: request.contract_version,
                request_id: request.request_id.clone(),
                status: if uncertain {
                    IntegrationStatus::Unknown
                } else if unavailable {
                    IntegrationStatus::Unavailable
                } else {
                    IntegrationStatus::Rejected
                },
                operation_id: request
                    .operation_id
                    .clone()
                    .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
                entity_revision: IntegrationNullable::Null,
                observed_at,
                result: IntegrationNullable::Null,
                error: IntegrationNullable::Value(IntegrationError {
                    code,
                    recovery: if uncertain {
                        IntegrationRecovery::ReconcileOriginal
                    } else if unavailable {
                        IntegrationRecovery::RepairConfiguration
                    } else if !mutation {
                        IntegrationRecovery::RetryRead
                    } else {
                        IntegrationRecovery::ExplicitUserDecision
                    },
                    message_key: if uncertain {
                        "office.reconcileOriginal".into()
                    } else {
                        "office.operationFailed".into()
                    },
                }),
            }
        }
    }
}
fn public_error(error: &anyhow::Error) -> String {
    error
        .chain()
        .find_map(|error| {
            kcoder_types::integrations::office::office_public_error_code(&error.to_string())
        })
        .unwrap_or("OFFICE_OPERATION_FAILED")
        .into()
}

pub(crate) mod installed_resources;
