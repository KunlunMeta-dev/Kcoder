//! Reusable Agent definition management, independent of Office enablement and execution.
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use kcoder_config::integrations::agent_definitions::{
    BUILTIN_AGENT_DEFINITION_VERSION, builtin_agent_definition, builtin_agent_definition_version,
    builtin_agent_definitions, builtin_octop_definitions, builtin_octop_package,
    validate_agent_definition,
};
use kcoder_state::integrations::resources::ResourceStore;
use kcoder_types::{agent_definition::*, integrations::core::*};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
mod catalog;
mod expert;
mod organization;
mod skills;

#[derive(Clone)]
pub struct SharedAgentDefinition {
    pub version: AgentDefinitionVersion,
    pub publication: AgentResourceRef,
}

/// The authenticated host provides policy and optional business requirement inspection.
/// No generator, artifact producer or Office settings are required to manage definitions.
#[async_trait]
pub trait AgentDefinitionHost: Send + Sync {
    fn validate_scope(&self, scope: &IntegrationScope) -> Result<()>;
    async fn call_port(
        &self,
        port: IntegrationPort,
        method: &str,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<IntegrationReply>;
    async fn validate_sources(
        &self,
        _request: &IntegrationRequest,
        sources: &[AgentResourceRef],
        _cancel: &CancellationToken,
    ) -> Result<()> {
        ensure!(sources.is_empty(), "AGENT_RESOURCE_PROVIDER_UNAVAILABLE");
        Ok(())
    }
    async fn inspect_requirements(
        &self,
        _request: &IntegrationRequest,
        definition: &AgentDefinition,
        _cancel: &CancellationToken,
    ) -> Result<Value> {
        validate_agent_definition(definition)?;
        Ok(
            json!({"definitionValid":true,"staticOnly":true,"adoptable":false,"requiredCapabilities":definition.capabilities,"requiredResources":definition.resources,"reasonCode":"AGENT_RECHECK_ON_EXECUTION"}),
        )
    }
    async fn organization_templates(
        &self,
        _request: &IntegrationRequest,
        _cancel: &CancellationToken,
    ) -> Result<Vec<SharedAgentDefinition>> {
        anyhow::bail!("AGENT_ORGANIZATION_PROVIDER_UNAVAILABLE")
    }
    async fn publish_organization_template(
        &self,
        _request: &IntegrationRequest,
        _version: &AgentDefinitionVersion,
        _cancel: &CancellationToken,
    ) -> Result<AgentResourceRef> {
        anyhow::bail!("AGENT_ORGANIZATION_PROVIDER_UNAVAILABLE")
    }
    async fn archive_organization_template(
        &self,
        _request: &IntegrationRequest,
        _publication: &AgentResourceRef,
        _cancel: &CancellationToken,
    ) -> Result<()> {
        anyhow::bail!("AGENT_ORGANIZATION_PROVIDER_UNAVAILABLE")
    }
}

pub struct AgentDefinitionService {
    pub store: Arc<ResourceStore>,
    pub host: Arc<dyn AgentDefinitionHost>,
    pub allow_organization_templates: bool,
}
impl AgentDefinitionService {
    /// Existing assistant RPC names are kept stable; adoption is an Office task operation.
    pub fn handles(method: &str) -> bool {
        (method.starts_with("integrations/assistant/") && method != "integrations/assistant/adopt")
            || method == "agentDefinitions/operation/read"
    }
    pub async fn dispatch(
        &self,
        method: &str,
        request: &IntegrationRequest,
        action: &str,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        ensure!(Self::handles(method), "OFFICE_METHOD_UNSUPPORTED");
        self.check(request, cancel)?;
        self.policy(
            request,
            action,
            Value::Object(request.payload.clone()),
            cancel,
        )
        .await?;
        self.check(request, cancel)?;
        if method == "agentDefinitions/operation/read" {
            return self.read_definition_operation(request);
        }
        self.assistant(method, request, cancel).await
    }
    fn read_definition_operation(&self, request: &IntegrationRequest) -> Result<Value> {
        let operation = request
            .payload
            .get("operationId")
            .and_then(Value::as_str)
            .context("OFFICE_INVALID_INPUT")?;
        if let Some(record) = self.store.read_action(operation)? {
            ensure!(
                matches!(
                    record.method.as_str(),
                    "assistant.publishOrganization" | "assistant.archiveOrganization"
                ),
                "OFFICE_POLICY_DENIED"
            );
            return Ok(json!({
                "operationId":record.operation_id,
                "method":record.method,
                "phase":record.phase,
                "result":record.result,
                "recovery":if record.phase=="completed"{"none"}else{"reconcile_original"}
            }));
        }
        let result = self
            .store
            .read_definition_operation(operation)?
            .context("OFFICE_ACTION_NOT_FOUND")?;
        Ok(json!({
            "operationId":operation,
            "method":"state.transaction",
            "phase":"completed",
            "result":result,
            "recovery":"none"
        }))
    }
    pub(crate) fn check(
        &self,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<()> {
        ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
        request.scope.validate()?;
        self.host.validate_scope(&request.scope)?;
        ensure!(
            IntegrationOwner::from(&request.scope) == *self.store.owner(),
            "OFFICE_OWNER_MISMATCH"
        );
        Ok(())
    }
    pub(crate) async fn policy(
        &self,
        request: &IntegrationRequest,
        action: &str,
        resources: Value,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let mut call = request.clone();
        call.payload = json!({"action":action,"resources":resources})
            .as_object()
            .context("OFFICE_INVALID_INPUT")?
            .clone();
        let value = self
            .port(
                IntegrationPort::Policy,
                "evaluateAction",
                &call,
                cancel,
                false,
            )
            .await?;
        let evaluation: IntegrationPolicyEvaluation =
            serde_json::from_value(value).context("OFFICE_POLICY_UNCONFIRMED")?;
        ensure!(
            !evaluation.policy_revision.is_empty(),
            "OFFICE_POLICY_UNCONFIRMED"
        );
        ensure!(
            evaluation.decision == IntegrationPolicyDecision::Allow,
            if evaluation.decision == IntegrationPolicyDecision::Deny {
                "OFFICE_POLICY_DENIED"
            } else {
                "OFFICE_POLICY_UNCONFIRMED"
            }
        );
        Ok(())
    }
    pub(crate) async fn port(
        &self,
        port: IntegrationPort,
        method: &str,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
        accept: bool,
    ) -> Result<Value> {
        request.validate_method(port, method)?;
        self.check(request, cancel)?;
        let reply = self.host.call_port(port, method, request, cancel).await?;
        reply.validate()?;
        ensure!(
            reply.request_id == request.request_id
                && reply.operation_id.as_ref() == request.operation_id.as_ref(),
            "OFFICE_PORT_IDENTITY_MISMATCH"
        );
        match reply.status {
            IntegrationStatus::Rejected => anyhow::bail!("OFFICE_PORT_REJECTED"),
            IntegrationStatus::Unavailable => anyhow::bail!("OFFICE_PORT_UNAVAILABLE"),
            IntegrationStatus::Unknown => anyhow::bail!("OFFICE_PORT_UNCONFIRMED"),
            _ => {}
        }
        ensure!(
            reply.status == IntegrationStatus::Completed
                || (accept && reply.status == IntegrationStatus::Accepted),
            "OFFICE_PORT_UNCONFIRMED"
        );
        self.check(request, cancel)?;
        Ok(Value::Object(
            reply
                .result
                .as_ref()
                .context("OFFICE_PORT_RESULT_MISSING")?
                .clone(),
        ))
    }
    pub(crate) fn expected(request: &IntegrationRequest) -> Result<Option<u64>> {
        request
            .expected_revision
            .as_ref()
            .map(|revision| revision.parse::<u64>().context("OFFICE_INVALID_REVISION"))
            .transpose()
    }
    pub(crate) fn reserve(
        &self,
        request: &IntegrationRequest,
        method: &str,
    ) -> Result<Option<Value>> {
        let (fresh, record) = self.store.begin_action(
            operation(request)?,
            method,
            &Value::Object(request.payload.clone()),
        )?;
        if fresh {
            Ok(None)
        } else if record.phase == "completed" {
            Ok(Some(record.result.context("OFFICE_RECEIPT_CORRUPT")?))
        } else {
            anyhow::bail!("OFFICE_RECONCILIATION_REQUIRED")
        }
    }
    pub(crate) fn complete(&self, request: &IntegrationRequest, value: Value) -> Result<Value> {
        self.store.complete_action(operation(request)?, &value)?;
        Ok(value)
    }
}
pub(crate) fn operation(request: &IntegrationRequest) -> Result<&str> {
    request
        .operation_id
        .as_deref()
        .context("OFFICE_OPERATION_REQUIRED")
}
pub(crate) fn payload<T: DeserializeOwned>(request: &IntegrationRequest) -> Result<T> {
    serde_json::from_value(Value::Object(request.payload.clone())).context("OFFICE_INVALID_INPUT")
}
pub(crate) fn now() -> Result<u64> {
    u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis(),
    )
    .context("OFFICE_CLOCK_UNAVAILABLE")
}
pub(crate) fn hash(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}
pub(crate) fn child_operation(request: &IntegrationRequest, suffix: &str) -> Result<String> {
    Ok(format!(
        "office-{}",
        hash(format!("{}:{suffix}", operation(request)?).as_bytes())
    ))
}
pub(crate) fn page_values<T: serde::Serialize>(
    values: Vec<T>,
    request: &IntegrationRequest,
) -> Result<Value> {
    let limit = request
        .payload
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(10);
    ensure!((1..=10).contains(&limit), "OFFICE_INVALID_PAGE_LIMIT");
    let identity = hash(&serde_json::to_vec(&(
        values
            .iter()
            .map(serde_json::to_value)
            .collect::<std::result::Result<Vec<_>, _>>()?,
        &request.scope,
    ))?);
    let cursor = request.payload.get("cursor").and_then(Value::as_str);
    let offset = match cursor {
        None => 0,
        Some(cursor) => {
            let (fingerprint, offset) = cursor.split_once(':').context("OFFICE_INVALID_CURSOR")?;
            ensure!(fingerprint == identity, "OFFICE_STALE_CURSOR");
            offset.parse::<usize>().context("OFFICE_INVALID_CURSOR")?
        }
    };
    ensure!(offset <= values.len(), "OFFICE_INVALID_CURSOR");
    let total = values.len();
    let end = (offset + limit as usize).min(total);
    let items = values
        .into_iter()
        .skip(offset)
        .take(limit as usize)
        .map(serde_json::to_value)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(
        json!({"items":items,"total":total,"nextCursor":if end<total {Some(format!("{identity}:{end}"))}else{None}}),
    )
}

#[cfg(test)]
mod tests;
