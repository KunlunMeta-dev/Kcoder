//! Definition management reuses the State catalog directly, without an Office host.
use super::{agent_resources::AgentResources, office::reply_result};
use crate::app_server::{
    ConnectionState, error_response, send, success_response, task_spawn::JoinSetExt as _,
};
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::integrations::{host::IntegrationScopeReadParams, office::OfficeMethod};
use kcoder_engine::{
    QueryEngine,
    integrations::agent_definitions::{AgentDefinitionHost, AgentDefinitionService},
};
use kcoder_state::{domain_storage::DomainStorageGuard, integrations::resources::ResourceStore};
use kcoder_types::diagnostic_cause::coded;
use kcoder_types::integrations::core::*;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct StoredResourceHost {
    resources: AgentResources,
    guard: DomainStorageGuard,
    store: Arc<ResourceStore>,
}

#[async_trait::async_trait]
impl AgentDefinitionHost for StoredResourceHost {
    fn validate_scope(&self, scope: &IntegrationScope) -> Result<()> {
        self.resources.validate_scope(scope)?;
        self.resources.verify_store(&self.guard, &self.store)
    }

    async fn call_port(
        &self,
        port: IntegrationPort,
        method: &str,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<IntegrationReply> {
        self.resources
            .call_port(port, method, request, cancel)
            .await
    }
}

#[async_trait::async_trait]
impl AgentDefinitionHost for AgentResources {
    fn validate_scope(&self, scope: &IntegrationScope) -> Result<()> {
        self.validate_scope(scope)
    }

    async fn call_port(
        &self,
        port: IntegrationPort,
        method: &str,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<IntegrationReply> {
        ensure!(
            port == IntegrationPort::Policy && method == "evaluateAction",
            "AGENT_RESOURCE_PROVIDER_UNAVAILABLE"
        );
        ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
        self.validate_scope(&request.scope)?;
        let action = request
            .payload
            .get("action")
            .and_then(Value::as_str)
            .context("OFFICE_POLICY_DENIED")?;
        let revision = self.authorize(action, &request.request_id)?;
        Ok(reply_result(
            method,
            request,
            Ok(json!({
                "decision": "allow", "policyRevision": revision.map(|revision| revision.to_string()).unwrap_or_else(|| "app-server-resource-policy-v1".into()),
                "reasonCode": "PROFILE_RESOURCE_OWNER",
            })),
        ))
    }
}

pub(in crate::app_server) async fn dispatch(
    method: &str,
    id: &Value,
    params: &Value,
    engine: &QueryEngine,
    outbound: &mpsc::Sender<Value>,
    state: &mut ConnectionState,
) -> Result<bool> {
    if method == kcoder_app_protocol::METHOD_AGENT_DEFINITION_SCOPE_READ {
        let result = (|| -> Result<_> {
            ensure!(
                state.agent_definition_management_v1,
                "AGENT_MANAGEMENT_UNAVAILABLE"
            );
            let _: IntegrationScopeReadParams = serde_json::from_value(params.clone())?;
            let resources = AgentResources::capture(engine)?;
            resources.authorize("agent.definition.read", "agent-resource-scope")?;
            Ok(serde_json::to_value(resources.scope())?)
        })();
        let response = match result {
            Ok(scope) => success_response(id.clone(), scope),
            Err(_) => error_response(id.clone(), -32076, "AGENT_RESOURCE_SCOPE_UNAVAILABLE"),
        };
        send(outbound, response).await?;
        return Ok(true);
    }
    if !AgentDefinitionService::handles(method) {
        return Ok(false);
    }
    let prepared = (|| -> Result<_> {
        ensure!(
            state.agent_definition_management_v1
                || state.integration_office_v1
                    && method != kcoder_app_protocol::METHOD_AGENT_DEFINITION_OPERATION_READ,
            "AGENT_MANAGEMENT_UNAVAILABLE"
        );
        ensure!(state.knowledge_rpc_tasks.len() < 64, "OFFICE_RPC_BUSY");
        let kind = if method == kcoder_app_protocol::METHOD_AGENT_DEFINITION_OPERATION_READ {
            OfficeMethod::ReadOfficeOperation
        } else {
            OfficeMethod::parse(method).context("OFFICE_METHOD_UNSUPPORTED")?
        };
        let action = if method == kcoder_app_protocol::METHOD_AGENT_DEFINITION_OPERATION_READ {
            "agent.definition.read"
        } else {
            kind.action()
        };
        let request: IntegrationRequest = kcoder_app_rpc_codec::decode(params.clone())?;
        request.validate(kind.is_mutation())?;
        let resources = AgentResources::capture(engine)?;
        resources.validate_scope(&request.scope)?;
        resources.authorize(action, &request.request_id)?;
        // Explicit Office scopes retain their dynamic readiness checks.
        if state.integration_office_v1
            && &request.scope != resources.scope()
            && (kind == OfficeMethod::ValidateAssistant
                && request
                    .payload
                    .get("definition")
                    .and_then(|value| {
                        serde_json::from_value::<kcoder_types::agent_definition::AgentDefinition>(
                            value.clone(),
                        )
                        .ok()
                    })
                    .is_some_and(|definition| {
                        !definition.resources.is_empty()
                            || !definition.capabilities.is_empty()
                            || definition.workflow_ref.is_some()
                    }))
        {
            return Ok(None);
        }
        let store = resources.store(if kind.is_mutation() {
            request.operation_id.as_deref()
        } else {
            None
        })?;
        let allow_organization_templates = engine
            .settings
            .read()
            .map_err(coded("OFFICE_SETTINGS_UNAVAILABLE"))?
            .integrations
            .office
            .allow_organization_templates;
        Ok(Some((
            kind,
            action,
            request,
            resources,
            store,
            allow_organization_templates,
        )))
    })();
    let (kind, action, request, resources, store, allow_organization_templates) = match prepared {
        Ok(Some(prepared)) => prepared,
        Ok(None) => return Ok(false),
        Err(error) => {
            send(
                outbound,
                error_response(id.clone(), -32076, &super::office::public_error(&error)),
            )
            .await?;
            return Ok(true);
        }
    };
    let (method, id, outbound) = (method.to_owned(), id.clone(), outbound.clone());
    let cancel = state.input_ended.child_token();
    state.knowledge_rpc_tasks.spawn_shared(async move {
        let _cancel_on_drop = cancel.clone().drop_guard();
        let operation = async {
            let value = if let Some((guard, store)) = store {
                let store = Arc::new(store);
                let host = Arc::new(StoredResourceHost {
                    resources,
                    guard,
                    store: store.clone(),
                });
                let service = AgentDefinitionService {
                    store,
                    host: host.clone(),
                    allow_organization_templates,
                };
                let value = service.dispatch(&method, &request, action, &cancel).await;
                host.validate_scope(&request.scope)?;
                host.resources.authorize(action, &request.request_id)?;
                value
            } else {
                let value = match kind {
                    OfficeMethod::ListAssistants => {
                        AgentDefinitionService::builtin_assistant_catalog(&request)
                    }
                    OfficeMethod::ReadExpertPackage => {
                        AgentDefinitionService::builtin_expert_assets(&request)
                    }
                    OfficeMethod::ReadExpertMarket => {
                        AgentDefinitionService::expert_market_detail(&request, &cancel).await
                    }
                    OfficeMethod::ListExpertMarket => {
                        AgentDefinitionService::expert_market_catalog(&request, &cancel).await
                    }
                    OfficeMethod::ListSkillMarket => {
                        AgentDefinitionService::skill_market_catalog(&request, &cancel).await
                    }
                    OfficeMethod::ValidateAssistant => {
                        ensure!(request.payload.len() == 1, "OFFICE_INVALID_INPUT");
                        let definition = kcoder_app_rpc_codec::decode(
                            request
                                .payload
                                .get("definition")
                                .cloned()
                                .context("OFFICE_INVALID_INPUT")?,
                        )?;
                        resources
                            .inspect_requirements(&request, &definition, &cancel)
                            .await
                    }
                    OfficeMethod::ReadOfficeOperation => {
                        Err(anyhow::anyhow!("OFFICE_ACTION_NOT_FOUND"))
                    }
                    _ => Err(anyhow::anyhow!("OFFICE_DEPENDENCY_UNAVAILABLE")),
                };
                resources.validate_scope(&request.scope)?;
                resources.authorize(action, &request.request_id)?;
                value
            };
            Ok::<_, anyhow::Error>(reply_result(&method, &request, value))
        };
        let reply = tokio::time::timeout(
            std::time::Duration::from_millis(request.timeout_ms),
            operation,
        )
        .await;
        let response = match reply {
            Ok(Ok(reply)) => success_response(id, serde_json::to_value(reply).unwrap()),
            Ok(Err(error)) if !kind.is_mutation() => success_response(
                id,
                serde_json::to_value(reply_result(&method, &request, Err(error))).unwrap(),
            ),
            _ => error_response(id, -32076, "OFFICE_RPC_RESULT_UNCONFIRMED"),
        };
        let _ = send(&outbound, response).await;
    });
    Ok(true)
}
