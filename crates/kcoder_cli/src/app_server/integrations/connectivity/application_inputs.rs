//! Exact selected application material, read once on its original native MCP connection.
use super::{
    NativeConnectivitySourceCatalog, NativeMcpSourceSelector,
    application_resources::NativeApplicationResourceConnection,
    application_resources::NativeApplicationResourceHost,
    application_task::{
        NativeApplicationTaskGrant, NativeApplicationTaskGrants, NativeApplicationTaskReadUse,
    },
    main_public::NativeConnectivityPublicCall,
    native_mcp_source_facts,
};
use crate::app_server::integrations::core::{NativeIntegrationContext, runtime_driver::*};
use anyhow::{Context, Result, ensure};
use kcoder_config::CredentialBackend;
use kcoder_engine::QueryEngine;
use kcoder_types::integrations::core::*;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::{Arc, OnceLock};
use tokio_util::sync::CancellationToken;
mod business;
pub(crate) mod business_result;
/// This finite concrete host wrapper can expose only its retained registered MCP object.
/// The caller still owns actual emitter/actor lineage and every execution permission.
pub(super) fn business_source_tool(
    native: &NativeIntegrationContext,
    tool: &Arc<dyn kcoder_tools::Tool>,
) -> Result<Option<Arc<dyn kcoder_tools::Tool>>> {
    let object: &dyn std::any::Any = tool.as_ref();
    object
        .downcast_ref::<business::ApplicationBusinessTool>()
        .map(|wrapper| wrapper.original_source_tool(native))
        .transpose()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Source {
    kind: String,
    application_kind: String,
    connection_id: String,
    resource_refs: Vec<Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Message {
    text: String,
    attachments: Vec<Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    source: Source,
    conversation_key: String,
    message: Message,
    #[serde(default)]
    thread_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Selected {
    native_namespace_id: String,
    connection_id: String,
    connection_revision: String,
    application_kind: String,
    source: Selector,
    resources: Vec<Resource>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Selector {
    name: String,
    plugin_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Resource {
    reference: Value,
    source_resource_ref: ResourceRef,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResourceRef {
    id: String,
    revision: String,
    kind: String,
}

fn read_action(kind: &str, action: &str) -> bool {
    match kind {
        "tencent_docs" => matches!(action, "document.summarize" | "document.compare"),
        "agent_mail" => matches!(action, "mail.summarize" | "mail.draft"),
        "feishu_bitable" => matches!(action, "table.analyze" | "table.query"),
        _ => false,
    }
}
fn business_action(kind: &str, action: &str) -> bool {
    matches!(
        (kind, action),
        ("tencent_docs", "document.create")
            | ("agent_mail", "mail.send")
            | ("feishu_bitable", "table.export")
    )
}
pub(super) fn matches_policy(
    caller: &NativeConnectivityPublicCall,
    request: &IntegrationRequest,
) -> Result<bool> {
    caller.verify(caller.context().scope())?;
    caller.context().validate_scope(&request.scope)?;
    let original = caller.call();
    if original.method!=kcoder_app_protocol::integrations::connectivity::ConnectivityMethod::PrepareConnectionAction
        || original.request.operation_id!=request.operation_id {return Ok(false);}
    let body = &original.request.payload;
    let expected = match body.get("action").and_then(Value::as_str) {
        Some("setResources") => json!({"action":"application.selectResources","resource":{
            "connectionId":body.get("connectionId"),"resourceRefs":body.get("resourceGrants")}}),
        Some("runOfficeTask") => {
            ensure!(
                matches!(
                    body.get("businessAction").and_then(Value::as_str),
                    Some(
                        "document.summarize"
                            | "document.compare"
                            | "mail.summarize"
                            | "mail.draft"
                            | "table.analyze"
                            | "table.query"
                            | "document.create"
                            | "mail.send"
                            | "table.export"
                    )
                ),
                "APPLICATION_READ_TASK_ONLY"
            );
            json!({"action":"application.runOfficeTask","resource":{"connectionId":body.get("connectionId"),
                "connectionRevision":original.request.expected_revision,"businessAction":body.get("businessAction"),"resourceRefs":body.get("resourceRefs")}})
        }
        _ => return Ok(false),
    };
    Ok(Value::Object(request.payload.clone()) == expected)
}

pub(super) async fn verify_policy_source(
    native: &NativeIntegrationContext,
    host: &NativeApplicationResourceHost,
    engine: &QueryEngine,
    vault: Arc<dyn CredentialBackend>,
    caller: &NativeConnectivityPublicCall,
    policy: &IntegrationRequest,
    cancel: &CancellationToken,
) -> Result<()> {
    ensure!(
        matches_policy(caller, policy)?,
        "APPLICATION_ORIGINAL_PUBLIC_TASK_REQUIRED"
    );
    let id = caller
        .call()
        .request
        .payload
        .get("connectionId")
        .and_then(Value::as_str)
        .context("APPLICATION_ORIGINAL_CONNECTION_REQUIRED")?;
    let fact = host
        .pipe
        .read_owned(
            &host.parent,
            "connectivity.resolveApplicationConfiguration",
            json!({"scope":native.scope(),"connectionId":id}),
        )
        .await?;
    ensure!(
        fact["nativeNamespaceId"].as_str() == Some(host.facade.namespace_id(native)?)
            && fact["connectionId"] == id
            && fact["connectionRevision"].as_str()
                == caller.call().request.expected_revision.as_deref(),
        "APPLICATION_CONNECTION_CHANGED"
    );
    if caller
        .call()
        .request
        .payload
        .get("action")
        .and_then(Value::as_str)
        == Some("runOfficeTask")
    {
        ensure!(
            read_action(
                fact["kind"].as_str().unwrap_or(""),
                caller
                    .call()
                    .request
                    .payload
                    .get("businessAction")
                    .and_then(Value::as_str)
                    .unwrap_or("")
            ) || business_action(
                fact["kind"].as_str().unwrap_or(""),
                caller
                    .call()
                    .request
                    .payload
                    .get("businessAction")
                    .and_then(Value::as_str)
                    .unwrap_or("")
            ),
            "APPLICATION_READ_TASK_ONLY"
        );
    }
    // Removing this owner's grant must remain possible when its provider is offline.
    if caller
        .call()
        .request
        .payload
        .get("action")
        .and_then(Value::as_str)
        == Some("setResources")
        && caller
            .call()
            .request
            .payload
            .get("resourceGrants")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
    {
        caller.verify(native.scope())?;
        return Ok(());
    }
    let selector: NativeMcpSourceSelector = serde_json::from_value(fact["source"].clone())?;
    let mut facts = native_mcp_source_facts(native, &host.factory, vault.as_ref())?;
    facts.retain(|fact| fact.matches_selector(&selector));
    ensure!(facts.len() == 1, "APPLICATION_SOURCE_UNAVAILABLE");
    let catalog = NativeConnectivitySourceCatalog::observe(native)?
        .context("NATIVE_SOURCE_CATALOG_NOT_OBSERVED")?;
    let inventory = catalog.inventory(native, &facts, &engine.active_tool_registry())?;
    ensure!(
        inventory.task_sources.len() == 1,
        "APPLICATION_SOURCE_UNAVAILABLE"
    );
    let descriptor = &inventory.task_sources[0];
    let choice = IntegrationTaskCapabilitySourceChoice {
        source_ref: descriptor.source_ref.clone(),
        account_ref: descriptor.account_ref.clone(),
    };
    let connection =
        NativeApplicationResourceConnection::capture(native, engine, &host.factory, vault, choice)?;
    connection.verify_current(native)?;
    if caller
        .call()
        .request
        .payload
        .get("action")
        .and_then(Value::as_str)
        == Some("runOfficeTask")
    {
        let selected=host.pipe.read_owned(&host.parent,"connectivity.resolveApplicationResources",json!({"scope":native.scope(),"connectionId":id,"resourceRefs":caller.call().request.payload.get("resourceRefs")})).await?;
        ensure!(
            selected["nativeNamespaceId"] == fact["nativeNamespaceId"]
                && selected["connectionRevision"] == fact["connectionRevision"],
            "APPLICATION_SELECTED_RESOURCES_CHANGED"
        );
    }
    ensure!(!cancel.is_cancelled(), "APPLICATION_TASK_CANCELLED");
    caller.verify(native.scope())
}

pub(super) struct NativeApplicationTaskSource {
    context: NativeIntegrationContext,
    host: NativeApplicationResourceHost,
    grant: Arc<NativeApplicationTaskGrant>,
    original: IntegrationRequest,
    selection: Value,
    connection_id: String,
    refs: Vec<Value>,
    connections: Vec<Arc<NativeApplicationResourceConnection>>,
    prepared: OnceLock<PreparedRuntimeTask>,
    business: Option<Arc<business::NativeApplicationBusiness>>,
}
impl NativeApplicationTaskSource {
    pub(super) fn client_cancellation(&self) -> CancellationToken {
        self.grant.client_cancellation()
    }
    #[expect(
        clippy::too_many_arguments,
        reason = "Keep the original public owner, selected source, services and operation explicit"
    )]
    pub(super) async fn read_original(
        native: &NativeIntegrationContext,
        host: NativeApplicationResourceHost,
        engine: &QueryEngine,
        vault: Arc<dyn CredentialBackend>,
        callers: Vec<Arc<NativeConnectivityPublicCall>>,
        grants: &NativeApplicationTaskGrants,
        request: IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<(Arc<Self>, String)> {
        native.validate_scope(&request.scope)?;
        request.validate_method(IntegrationPort::Runtime, "acceptTask")?;
        let input: Input = serde_json::from_value(Value::Object(request.payload.clone()))?;
        let caller = callers
            .into_iter()
            .find(|caller| {
                caller.verify(native.scope()).is_ok()
                    && caller.call().request.operation_id == request.operation_id
                    && caller
                        .call()
                        .request
                        .payload
                        .get("action")
                        .and_then(Value::as_str)
                        == Some("runOfficeTask")
                    && caller
                        .call()
                        .request
                        .payload
                        .get("connectionId")
                        .and_then(Value::as_str)
                        == Some(input.source.connection_id.as_str())
            })
            .context("APPLICATION_ORIGINAL_PUBLIC_TASK_REQUIRED")?;
        let body = &caller.call().request.payload;
        ensure!(
            input.source.kind == "application"
                && input.thread_id.is_none()
                && input.message.attachments.is_empty()
                && input.source.resource_refs.len() <= 100
                && body.get("resourceRefs") == Some(&json!(input.source.resource_refs))
                && body.get("taskText").and_then(Value::as_str)
                    == Some(input.message.text.as_str())
                && body
                    .get("attachments")
                    .is_none_or(|attachments| attachments.as_array().is_some_and(Vec::is_empty))
                && !input.message.text.trim().is_empty()
                && input.message.text.len() <= 64 * 1024,
            "APPLICATION_ORIGINAL_INPUT_CHANGED"
        );
        let operation = request
            .operation_id
            .as_deref()
            .context("APPLICATION_ORIGINAL_OPERATION_REQUIRED")?
            .to_owned();
        let conversation = format!(
            "application-conversation_{:x}",
            Sha256::digest(serde_json::to_vec(&json!([
                input.source.connection_id,
                operation
            ]))?)
        );
        ensure!(
            input.conversation_key == conversation,
            "APPLICATION_ORIGINAL_CONVERSATION_CHANGED"
        );
        let grant = grants.bind(&caller)?;
        let mut source = Self {
            context: native.recapture_for_owned_service()?,
            host,
            grant,
            original: request,
            selection: Value::Null,
            connection_id: input.source.connection_id,
            refs: input.source.resource_refs,
            connections: Vec::new(),
            prepared: OnceLock::new(),
            business: None,
        };
        source.selection = source.current_selection(cancel).await?;
        let selected: Selected = serde_json::from_value(source.selection.clone())?;
        ensure!(
            selected.native_namespace_id == source.host.facade.namespace_id(native)?
                && selected.connection_id == source.connection_id
                && !selected.connection_revision.is_empty()
                && caller.call().request.expected_revision.as_deref()
                    == Some(selected.connection_revision.as_str())
                && selected.application_kind == input.source.application_kind
                && !selected.resources.is_empty()
                && selected.resources.len() == source.refs.len(),
            "APPLICATION_SELECTED_RESOURCES_CHANGED"
        );
        ensure!(
            read_action(
                &selected.application_kind,
                caller
                    .call()
                    .request
                    .payload
                    .get("businessAction")
                    .and_then(Value::as_str)
                    .unwrap_or("")
            ) || business_action(
                &selected.application_kind,
                caller
                    .call()
                    .request
                    .payload
                    .get("businessAction")
                    .and_then(Value::as_str)
                    .unwrap_or("")
            ),
            "APPLICATION_READ_TASK_ONLY"
        );
        let selector = NativeMcpSourceSelector {
            server: selected.source.name,
            plugin: selected.source.plugin_id,
        };
        let mut facts = native_mcp_source_facts(native, &source.host.factory, vault.as_ref())?;
        facts.retain(|fact| fact.matches_selector(&selector));
        ensure!(facts.len() == 1, "APPLICATION_SOURCE_UNAVAILABLE");
        let catalog = NativeConnectivitySourceCatalog::observe(native)?
            .context("NATIVE_SOURCE_CATALOG_NOT_OBSERVED")?;
        let inventory = catalog.inventory(native, &facts, &engine.active_tool_registry())?;
        ensure!(
            inventory.task_sources.len() == 1,
            "APPLICATION_SOURCE_UNAVAILABLE"
        );
        let descriptor = &inventory.task_sources[0];
        let choice = IntegrationTaskCapabilitySourceChoice {
            source_ref: descriptor.source_ref.clone(),
            account_ref: descriptor.account_ref.clone(),
        };
        ensure!(
            catalog.resolve_choice(native, &choice, &facts)? == selector,
            "APPLICATION_SOURCE_CHANGED"
        );
        let connection = NativeApplicationResourceConnection::capture(
            native,
            engine,
            &source.host.factory,
            vault,
            choice.clone(),
        )?;
        let mut uris = Vec::new();
        for (index, resource) in selected.resources.iter().enumerate() {
            ensure!(
                resource.reference == source.refs[index]
                    && resource.reference.get("kind").and_then(Value::as_str)
                        == Some(resource.source_resource_ref.kind.as_str()),
                "APPLICATION_SELECTED_RESOURCES_CHANGED"
            );
            super::application_task::verify_resource_revision(
                &choice,
                &resource.source_resource_ref.revision,
            )?;
            uris.push(resource.source_resource_ref.id.clone());
        }
        if let Some(business) = business::NativeApplicationBusiness::capture(
            native,
            engine,
            caller.clone(),
            source.grant.clone(),
            connection.clone(),
            uris,
        )? {
            source.business = Some(business);
            source.connections.push(connection);
            source.verify_native()?;
            let text=json!({"task":input.message.text,"originalOperationId":operation,"selectedResourceUris":source.business.as_ref().unwrap().uris(),"untrustedSourceData":true}).to_string();
            return Ok((Arc::new(source), text));
        }
        let mut material = Vec::new();
        for (index, resource) in selected.resources.into_iter().enumerate() {
            ensure!(
                resource.reference == source.refs[index]
                    && !resource.source_resource_ref.revision.is_empty()
                    && resource.reference.get("kind").and_then(Value::as_str)
                        == Some(resource.source_resource_ref.kind.as_str()),
                "APPLICATION_SELECTED_RESOURCES_CHANGED"
            );
            caller.verify(native.scope())?;
            source.verify_native()?;
            ensure!(
                source.current_selection(cancel).await? == source.selection,
                "APPLICATION_SELECTED_RESOURCES_CHANGED"
            );
            let permission = NativeApplicationTaskReadUse::from_selected_resource(
                caller.clone(),
                choice.clone(),
                resource.source_resource_ref.id,
                &resource.source_resource_ref.revision,
                source.grant.clone(),
            )?;
            let snapshot = connection
                .read_for_task(native, &permission, cancel)
                .await?;
            ensure!(
                source.current_selection(cancel).await? == source.selection,
                "APPLICATION_SELECTED_RESOURCES_CHANGED"
            );
            material.push(
                json!({"resourceRef":resource.reference,"sourceRevision":snapshot.revision,
                "mimeType":snapshot.mime_type,"text":snapshot.text}),
            );
            ensure!(
                serde_json::to_vec(&material)?.len() <= 64 * 1024,
                "APPLICATION_MATERIAL_LIMIT"
            );
        }
        source.connections.push(connection);
        source.verify_native()?;
        caller.verify(native.scope())?;
        let text=json!({"task":input.message.text,"untrustedSourceData":true,"applicationMaterial":material}).to_string();
        ensure!(text.len() <= 64 * 1024, "APPLICATION_MATERIAL_LIMIT");
        Ok((Arc::new(source), text))
    }
    async fn current_selection(&self, cancel: &CancellationToken) -> Result<Value> {
        self.verify_native()?;
        let value = tokio::select! {biased;
            _=cancel.cancelled()=>anyhow::bail!("APPLICATION_TASK_CANCELLED"),
            value=self.host.pipe.read_owned(&self.host.parent,"connectivity.resolveApplicationResources",json!({"scope":self.context.scope(),"connectionId":self.connection_id,"resourceRefs":self.refs}))=>value?,
        };
        ensure!(
            value["nativeNamespaceId"].as_str()
                == Some(self.host.facade.namespace_id(&self.context)?),
            "APPLICATION_NAMESPACE_CHANGED"
        );
        self.verify_native()?;
        Ok(value)
    }
    pub(super) fn bind_prepared(&self, task: PreparedRuntimeTask) -> Result<()> {
        self.prepared
            .set(task)
            .map_err(|_| anyhow::anyhow!("APPLICATION_ORIGINAL_RUNTIME_CHANGED"))
    }
    pub(super) fn business_tools(&self) -> Option<kcoder_tools::ToolRegistry> {
        self.business.as_ref().map(|business| business.registry())
    }
    pub(super) fn bind_business_state(&self, state: &kcoder_state::AppState) -> Result<()> {
        if let Some(business) = &self.business {
            business.bind_state(state)?;
        }
        Ok(())
    }
    pub(super) fn authorize_business(
        &self,
        request: &kcoder_engine::integrations::core::NativeToolAuthorizationRequest<'_>,
    ) -> Result<()> {
        self.business
            .as_ref()
            .context("APPLICATION_BUSINESS_UNAVAILABLE")?
            .authorize(request)
    }
    pub(super) fn verify_native(&self) -> Result<()> {
        self.context.verify()?;
        self.grant.verify(&self.context)?;
        self.host.parent.verify(&self.context)?;
        let lease = self
            .host
            .facade
            .lease_for_parent(&self.context, &self.host.parent)?;
        self.host
            .facade
            .require_ready(&self.context, Some(&self.host.parent), &lease.lease_id)?;
        for connection in &self.connections {
            connection.verify_current(&self.context)?;
        }
        Ok(())
    }
}
#[async_trait::async_trait]
#[kcoder_async_box::shared]
impl NativeRuntimeCurrentSource for NativeApplicationTaskSource {
    async fn verify_current_source(
        &self,
        native: &NativeIntegrationContext,
        original: &IntegrationRequest,
        prepared: &PreparedRuntimeTask,
        cancel: &CancellationToken,
    ) -> Result<()> {
        native.validate_scope(self.context.scope())?;
        ensure!(
            original == &self.original && self.prepared.get() == Some(prepared),
            "APPLICATION_ORIGINAL_RUNTIME_CHANGED"
        );
        self.verify_native()?;
        ensure!(
            self.current_selection(cancel).await? == self.selection,
            "APPLICATION_SELECTED_RESOURCES_CHANGED"
        );
        self.verify_native()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_app_protocol::integrations::connectivity::{
        ConnectivityMethod, ConnectivityPort, ConnectivityPortCall,
    };
    #[test]
    fn application_policy_cannot_borrow_another_resource_operation_or_scope() -> Result<()> {
        let fixture =
            crate::app_server::integrations::core::runtime_driver::test_support::Fixture::new();
        let state = crate::app_server::ConnectionState {
            initialized: true,
            integration_context: Some(fixture.context),
            ..Default::default()
        };
        let scope = state.integration_context.as_ref().unwrap().scope().clone();
        let refs = json!([{"id":"original-resource","revision":"1","kind":"mailbox"}]);
        let public=IntegrationRequest {contract_version:IntegrationContractVersion::ParallelV1,request_id:"original-select".into(),scope:scope.clone(),operation_id:Some("original-select".into()),expected_revision:Some("1".into()),timeout_ms:1000,cancellation_ref:None,payload:json!({"action":"setResources","connectionId":"original-application","resourceGrants":refs}).as_object().unwrap().clone()};
        let caller = NativeConnectivityPublicCall::capture(
            &state,
            ConnectivityPortCall {
                port: ConnectivityPort::Connection,
                method: ConnectivityMethod::PrepareConnectionAction,
                request: public.clone(),
            },
        )?;
        let mut policy = public.clone();
        policy.request_id = "nested-exact-policy".into();
        policy.payload=json!({"action":"application.selectResources","resource":{"connectionId":"original-application","resourceRefs":refs}}).as_object().unwrap().clone();
        assert!(matches_policy(&caller, &policy)?);
        policy.payload.get_mut("resource").unwrap()["resourceRefs"][0]["id"] =
            json!("replacement-resource");
        assert!(!matches_policy(&caller, &policy)?);
        policy.payload=json!({"action":"application.selectResources","resource":{"connectionId":"original-application","resourceRefs":refs}}).as_object().unwrap().clone();
        policy.operation_id = Some("different-operation".into());
        assert!(!matches_policy(&caller, &policy)?);
        policy.operation_id = public.operation_id;
        policy.scope.workspace_id = IntegrationNullable::Value("foreign-workspace".into());
        assert!(matches_policy(&caller, &policy).is_err());
        Ok(())
    }
    #[test]
    fn application_input_only_flow_never_accepts_external_write_actions() {
        assert!(read_action("agent_mail", "mail.summarize"));
        assert!(read_action("agent_mail", "mail.draft"));
        assert!(read_action("tencent_docs", "document.compare"));
        assert!(read_action("feishu_bitable", "table.query"));
        assert!(!read_action("agent_mail", "mail.send"));
        assert!(!read_action("tencent_docs", "document.create"));
        assert!(!read_action("feishu_bitable", "table.export"));
        assert!(!read_action("tencent_docs", "mail.summarize"));
    }
}
