//! Application management stays bound to the original public native call.
use super::{
    NativeConnectivityFactPipe, NativeConnectivityLeaseFacade, NativeConnectivityParent,
    NativeConnectivitySourceCatalog, NativeMcpSourceSelector,
    application_discovery::NativeApplicationDiscoveryUse,
    application_resources::NativeApplicationResourceConnection,
    main_public::NativeConnectivityPublicCall, native_mcp_source_facts,
};
use crate::app_server::{
    engine_factory::AppServerEngineFactory, integrations::core::NativeIntegrationContext,
};
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::integrations::connectivity::ConnectivityMethod;
use kcoder_config::CredentialBackend;
use kcoder_engine::QueryEngine;
use kcoder_tools::ToolRegistry;
use kcoder_types::integrations::core::{IntegrationScope, IntegrationTaskCapabilitySourceChoice};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(super) struct NativeApplicationHost<'a> {
    pub native: &'a NativeIntegrationContext,
    pub parent: &'a NativeConnectivityParent,
    pub pipe: &'a dyn NativeConnectivityFactPipe,
    pub factory: &'a AppServerEngineFactory,
    pub engine: &'a QueryEngine,
    pub registry: &'a ToolRegistry,
    pub vault: Arc<dyn CredentialBackend>,
    pub callers: Vec<Arc<NativeConnectivityPublicCall>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ApplicationCall {
    scope: IntegrationScope,
    method: String,
    #[serde(default)]
    connection: Option<Value>,
    #[serde(default)]
    args: Vec<Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Connection {
    id: String,
    revision: String,
    kind: String,
    configuration: Configuration,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Configuration {
    mcp_server_name: String,
    #[serde(default)]
    plugin_id: Option<String>,
    #[serde(default, rename = "appliesToNewConversations")]
    _applies_to_new_conversations: Option<bool>,
}
impl Connection {
    fn selector(&self) -> NativeMcpSourceSelector {
        NativeMcpSourceSelector {
            server: self.configuration.mcp_server_name.clone(),
            plugin: self.configuration.plugin_id.clone(),
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfigurationFact {
    native_namespace_id: String,
    connection_id: String,
    connection_revision: String,
    kind: String,
    source: NativeMcpSourceSelector,
}

fn matches_original(
    caller: &NativeConnectivityPublicCall,
    method: &str,
    connection: Option<&Connection>,
    args: &[Value],
) -> bool {
    let call = caller.call();
    let body = &call.request.payload;
    if method == "listSources" {
        return args.is_empty()
            && connection.is_none()
            && call.method == ConnectivityMethod::ListConnections
            && body.get("category").and_then(Value::as_str) != Some("channels");
    }
    let Some(connection) = connection else {
        return false;
    };
    if body.get("connectionId").and_then(Value::as_str) != Some(connection.id.as_str()) {
        return method == "read"
            && args.is_empty()
            && call.method == ConnectivityMethod::ListConnections
            && body.get("category").and_then(Value::as_str) != Some("channels");
    }
    match method {
        "read" => {
            args.is_empty()
                && matches!(
                    call.method,
                    ConnectivityMethod::ReadConnection
                        | ConnectivityMethod::ReadResourceGrant
                        | ConnectivityMethod::PrepareConnectionAction
                )
        }
        "listResources" => {
            call.method == ConnectivityMethod::ReadResourceGrant
                && body.get("discover") == Some(&Value::Bool(true))
                && args == [Value::Object(body.clone())]
        }
        "setEnabled" => {
            call.method == ConnectivityMethod::PrepareConnectionAction
                && call.request.expected_revision.as_deref() == Some(connection.revision.as_str())
                && args.len() == 1
                && args[0].as_bool().is_some_and(|enabled| {
                    match body.get("action").and_then(Value::as_str) {
                        Some("start" | "enable") => enabled,
                        Some("stop" | "disable" | "disconnect") => !enabled,
                        _ => false,
                    }
                })
        }
        "disconnect" => {
            args.is_empty()
                && call.method == ConnectivityMethod::PrepareConnectionAction
                && body.get("action").and_then(Value::as_str) == Some("disconnect")
                && call.request.expected_revision.as_deref() == Some(connection.revision.as_str())
        }
        _ => false,
    }
}

impl NativeApplicationHost<'_> {
    async fn verify_connection(&self, connection: &Connection) -> Result<()> {
        ensure!(
            matches!(
                connection.kind.as_str(),
                "tencent_docs" | "agent_mail" | "feishu_bitable"
            ),
            "APPLICATION_UNSUPPORTED"
        );
        let fact: ConfigurationFact = serde_json::from_value(
            self.pipe
                .read_owned(
                    self.parent,
                    "connectivity.resolveApplicationConfiguration",
                    json!({"scope":self.native.scope(),"connectionId":connection.id}),
                )
                .await?,
        )?;
        let facade = NativeConnectivityLeaseFacade::observe(self.native)?
            .context("CONNECTIVITY_NATIVE_UNAVAILABLE")?;
        ensure!(
            fact.native_namespace_id == facade.namespace_id(self.native)?
                && fact.connection_id == connection.id
                && fact.connection_revision == connection.revision
                && fact.kind == connection.kind
                && fact.source == connection.selector(),
            "APPLICATION_SOURCE_CHANGED"
        );
        Ok(())
    }
    fn source_summaries(&self) -> Result<Value> {
        let facts = native_mcp_source_facts(self.native, self.factory, self.vault.as_ref())?;
        let catalog = NativeConnectivitySourceCatalog::observe(self.native)?;
        let inventory = catalog
            .as_ref()
            .map(|catalog| catalog.inventory(self.native, &facts, self.registry))
            .transpose()?;
        let items = facts
            .iter()
            .map(|fact| {
                let mut summary = fact.application_summary();
                let choice = inventory.as_ref().and_then(|inventory| {
                    inventory.task_sources.iter().find_map(|descriptor| {
                        let choice = IntegrationTaskCapabilitySourceChoice {
                            source_ref: descriptor.source_ref.clone(),
                            account_ref: descriptor.account_ref.clone(),
                        };
                        catalog
                            .as_ref()?
                            .resolve_choice(self.native, &choice, std::slice::from_ref(fact))
                            .ok()
                            .map(|_| choice)
                    })
                });
                // A public locator from current native facts, never execution authority.
                summary
                    .as_object_mut()
                    .unwrap()
                    .insert("taskSourceChoice".into(), serde_json::to_value(choice)?);
                Ok::<_, anyhow::Error>(summary)
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(json!({"items":items,"truncated":false}))
    }
    fn summary(&self, connection: &Connection) -> Result<Value> {
        let selector = connection.selector();
        let facts = native_mcp_source_facts(self.native, self.factory, self.vault.as_ref())?;
        let matches = facts
            .iter()
            .filter(|fact| fact.matches_selector(&selector))
            .collect::<Vec<_>>();
        ensure!(matches.len() == 1, "APPLICATION_SOURCE_UNAVAILABLE");
        let mut summary = matches[0].application_summary();
        summary.as_object_mut().unwrap().insert(
            "source".into(),
            json!({"name":selector.server,"pluginId":selector.plugin}),
        );
        Ok(summary)
    }
    fn choice(&self, connection: &Connection) -> Result<IntegrationTaskCapabilitySourceChoice> {
        let selector = connection.selector();
        let mut facts = native_mcp_source_facts(self.native, self.factory, self.vault.as_ref())?;
        facts.retain(|fact| fact.matches_selector(&selector));
        ensure!(facts.len() == 1, "APPLICATION_SOURCE_UNAVAILABLE");
        let catalog = NativeConnectivitySourceCatalog::observe(self.native)?
            .context("NATIVE_SOURCE_CATALOG_NOT_OBSERVED")?;
        let inventory = catalog.inventory(self.native, &facts, self.registry)?;
        ensure!(
            inventory.task_sources.len() == 1,
            "APPLICATION_SOURCE_UNAVAILABLE"
        );
        let source = &inventory.task_sources[0];
        let choice = IntegrationTaskCapabilitySourceChoice {
            source_ref: source.source_ref.clone(),
            account_ref: source.account_ref.clone(),
        };
        ensure!(
            catalog.resolve_choice(self.native, &choice, &facts)? == selector,
            "APPLICATION_SOURCE_CHANGED"
        );
        Ok(choice)
    }
    pub(super) async fn handle(&self, params: Value, cancel: &CancellationToken) -> Result<Value> {
        let input: ApplicationCall = serde_json::from_value(params)
            .map_err(|_| anyhow::anyhow!("APPLICATION_CALL_INVALID"))?;
        self.native.validate_scope(&input.scope)?;
        let settings = self.factory.current_settings()?;
        ensure!(
            !settings.training_mode && settings.integrations.connectivity.enabled,
            "CONNECTIVITY_DISABLED"
        );
        let connection = input
            .connection
            .clone()
            .map(serde_json::from_value::<Connection>)
            .transpose()?;
        let caller = self
            .callers
            .iter()
            .find(|caller| {
                caller.verify(self.native.scope()).is_ok()
                    && matches_original(caller, &input.method, connection.as_ref(), &input.args)
            })
            .context("APPLICATION_ORIGINAL_PUBLIC_CALL_REQUIRED")?
            .clone();
        if let Some(connection) = &connection {
            self.verify_connection(connection).await?;
        }
        ensure!(!cancel.is_cancelled(), "APPLICATION_CALL_CANCELLED");
        let result = match input.method.as_str() {
            "listSources" => self.source_summaries()?,
            "read" => self.summary(connection.as_ref().unwrap())?,
            "setEnabled" => serde_json::to_value(
                crate::app_server::mcp_processor::set_enabled(
                    self.factory.clone(),
                    kcoder_app_protocol::McpSetEnabledParams {
                        name: connection
                            .as_ref()
                            .unwrap()
                            .configuration
                            .mcp_server_name
                            .clone(),
                        plugin_id: connection.as_ref().unwrap().configuration.plugin_id.clone(),
                        enabled: input.args[0].as_bool().unwrap(),
                    },
                )
                .await?,
            )?,
            "disconnect" => serde_json::to_value(
                crate::app_server::mcp_processor::logout(
                    self.factory.clone(),
                    kcoder_app_protocol::McpServerParams {
                        name: connection
                            .as_ref()
                            .unwrap()
                            .configuration
                            .mcp_server_name
                            .clone(),
                        plugin_id: connection.as_ref().unwrap().configuration.plugin_id.clone(),
                    },
                )
                .await?,
            )?,
            "listResources" => {
                let connection = connection.as_ref().unwrap();
                let choice = self.choice(connection)?;
                let source = NativeApplicationResourceConnection::capture(
                    self.native,
                    self.engine,
                    self.factory,
                    self.vault.clone(),
                    choice.clone(),
                )?;
                let permission =
                    NativeApplicationDiscoveryUse::capture(caller.clone(), choice.clone())?;
                let descriptors = tokio::time::timeout(
                    caller.remaining()?,
                    source.list_resources(self.native, &permission, cancel),
                )
                .await
                .context("APPLICATION_DISCOVERY_TIMEOUT")??;
                resource_page(&choice, &connection.kind, descriptors, &input.args[0])?
            }
            _ => anyhow::bail!("APPLICATION_NATIVE_AUTHORIZATION_ENTRY_REQUIRED"),
        };
        if let Some(connection) = &connection {
            self.verify_connection(connection).await?;
        }
        caller.verify(self.native.scope())?;
        ensure!(!cancel.is_cancelled(), "APPLICATION_CALL_CANCELLED");
        Ok(result)
    }
}

fn resource_page(
    choice: &IntegrationTaskCapabilitySourceChoice,
    kind: &str,
    descriptors: Vec<kcoder_mcp::apps::ResourceDescriptor>,
    payload: &Value,
) -> Result<Value> {
    let limit = payload.get("limit").and_then(Value::as_u64).unwrap_or(10);
    ensure!(
        (1..=10).contains(&limit),
        "APPLICATION_RESOURCE_LIMIT_INVALID"
    );
    let mut items = Vec::new();
    for descriptor in descriptors {
        let resource_kind = descriptor
            .meta
            .as_ref()
            .and_then(|meta| meta.get("io.kcoder.applicationResource"))
            .and_then(|meta| meta.get("kind"))
            .and_then(Value::as_str)
            .context("APPLICATION_RESOURCE_KIND_UNDECLARED")?;
        ensure!(
            match kind {
                "tencent_docs" => matches!(resource_kind, "document" | "spreadsheet"),
                "agent_mail" => resource_kind == "mailbox",
                "feishu_bitable" => matches!(resource_kind, "base" | "table"),
                _ => false,
            },
            "APPLICATION_RESOURCE_KIND_UNSUPPORTED"
        );
        ensure!(
            !descriptor.uri.is_empty()
                && descriptor.uri.len() <= 4096
                && !descriptor.uri.chars().any(char::is_control),
            "APPLICATION_RESOURCE_URI_INVALID"
        );
        let revision = super::application_task::resource_revision(choice, &descriptor)?;
        items.push(json!({"id":descriptor.uri,"revision":revision,"kind":resource_kind,"label":descriptor.name.chars().take(160).collect::<String>()}));
    }
    items.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    ensure!(
        items
            .windows(2)
            .all(|items| items[0]["id"] != items[1]["id"]),
        "APPLICATION_RESOURCE_AMBIGUOUS"
    );
    let fingerprint = format!("{:x}", Sha256::digest(serde_json::to_vec(&items)?));
    let offset = match payload.get("after").filter(|value| !value.is_null()) {
        None => 0,
        Some(value) => {
            let (previous, offset) = value
                .as_str()
                .context("APPLICATION_RESOURCE_CURSOR_INVALID")?
                .split_once(':')
                .context("APPLICATION_RESOURCE_CURSOR_INVALID")?;
            ensure!(previous == fingerprint, "APPLICATION_RESOURCE_CURSOR_STALE");
            offset
                .parse::<usize>()
                .context("APPLICATION_RESOURCE_CURSOR_INVALID")?
        }
    };
    ensure!(offset <= items.len(), "APPLICATION_RESOURCE_CURSOR_INVALID");
    let end = offset.saturating_add(limit as usize).min(items.len());
    Ok(
        json!({"items":items[offset..end],"nextCursor":(end < items.len()).then(||format!("{fingerprint}:{end}"))}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::integrations::core::{IntegrationNullable, IntegrationRevisionRef};
    fn descriptor(id: &str, kind: Option<&str>) -> kcoder_mcp::apps::ResourceDescriptor {
        kcoder_mcp::apps::ResourceDescriptor {
            uri: format!("owned-resource://{id}"),
            name: id.into(),
            mime_type: Some("text/plain".into()),
            meta: kind.map(|kind| json!({"io.kcoder.applicationResource":{"kind":kind}})),
        }
    }
    #[test]
    fn resource_discovery_keeps_exact_kinds_and_rejects_changed_page_snapshots() -> Result<()> {
        let choice = IntegrationTaskCapabilitySourceChoice {
            source_ref: IntegrationRevisionRef {
                id: "actual-source".into(),
                revision: "actual-source-revision".into(),
            },
            account_ref: IntegrationNullable::Null,
        };
        for (app, kind) in [
            ("tencent_docs", "document"),
            ("agent_mail", "mailbox"),
            ("feishu_bitable", "table"),
        ] {
            let page = resource_page(
                &choice,
                app,
                vec![descriptor("one", Some(kind)), descriptor("two", Some(kind))],
                &json!({"limit":1}),
            )?;
            let cursor = page["nextCursor"].clone();
            let next = resource_page(
                &choice,
                app,
                vec![descriptor("two", Some(kind)), descriptor("one", Some(kind))],
                &json!({"limit":1,"after":cursor}),
            )?;
            assert_eq!(next["items"][0]["id"], "owned-resource://two");
            assert!(next["nextCursor"].is_null());
            assert!(
                resource_page(
                    &choice,
                    app,
                    vec![descriptor("changed", Some(kind))],
                    &json!({"after":page["nextCursor"]})
                )
                .is_err()
            );
            assert!(
                resource_page(&choice, app, vec![descriptor("one", None)], &json!({})).is_err()
            );
        }
        assert!(
            resource_page(
                &choice,
                "agent_mail",
                vec![descriptor("one", Some("document"))],
                &json!({})
            )
            .is_err()
        );
        Ok(())
    }
    #[test]
    fn private_callbacks_cannot_widen_the_original_public_application_action() -> Result<()> {
        use kcoder_app_protocol::integrations::connectivity::{
            ConnectivityPort, ConnectivityPortCall,
        };
        use kcoder_types::integrations::core::*;
        let fixture =
            crate::app_server::integrations::core::runtime_driver::test_support::Fixture::new();
        let state = crate::app_server::ConnectionState {
            initialized: true,
            integration_context: Some(fixture.context),
            ..Default::default()
        };
        let caller = NativeConnectivityPublicCall::capture(
            &state,
            ConnectivityPortCall {
                port: ConnectivityPort::Connection,
                method: ConnectivityMethod::PrepareConnectionAction,
                request: IntegrationRequest {
                    contract_version: IntegrationContractVersion::ParallelV1,
                    request_id: "original-enable".into(),
                    scope: state.integration_context.as_ref().unwrap().scope().clone(),
                    operation_id: Some("original-enable".into()),
                    expected_revision: Some("1".into()),
                    timeout_ms: 1000,
                    cancellation_ref: None,
                    payload: json!({"action":"enable","connectionId":"owned"})
                        .as_object()
                        .unwrap()
                        .clone(),
                },
            },
        )?;
        let mut connection: Connection = serde_json::from_value(
            json!({"id":"owned","revision":"1","kind":"agent_mail","configuration":{"mcpServerName":"source"}}),
        )?;
        assert!(matches_original(
            &caller,
            "setEnabled",
            Some(&connection),
            &[json!(true)]
        ));
        assert!(!matches_original(
            &caller,
            "setEnabled",
            Some(&connection),
            &[json!(false)]
        ));
        assert!(!matches_original(
            &caller,
            "disconnect",
            Some(&connection),
            &[]
        ));
        assert!(!matches_original(
            &caller,
            "listResources",
            Some(&connection),
            &[json!({"discover":true})]
        ));
        connection.revision = "2".into();
        assert!(!matches_original(
            &caller,
            "setEnabled",
            Some(&connection),
            &[json!(true)]
        ));
        state.input_ended.cancel();
        assert!(caller.verify(caller.context().scope()).is_err());
        Ok(())
    }
}
