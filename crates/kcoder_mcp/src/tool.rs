use crate::client::McpClient;
use crate::model::McpToolDefinition;
use crate::result_content::convert_result;
use async_trait::async_trait;
pub use kcoder_mcp_policy::{PrivateValues, mcp_tool_name};
use kcoder_tools::{Tool, ToolContext, ToolError, ToolOutput, ToolSource};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{debug, error};

/// Shared handle to a single MCP server connection. All tools from the same
/// server share this handle so they reuse one stdio transport.
pub type McpServerHandle = Arc<Mutex<McpClient>>;

/// A tool that proxies calls to an external MCP server.
pub struct McpTool {
    server_name: String,
    native_origin: Option<Arc<crate::native_origin::NativeMcpConnectionOrigin>>,
    exposed_name: String,
    handle: McpServerHandle,
    definition: McpToolDefinition,
    plugin_id: Option<String>,
    private_values: Arc<PrivateValues>,
    required_trust: Option<(std::path::PathBuf, std::path::PathBuf)>,
    app_authorizer: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    session_lease: Option<tokio_util::sync::CancellationToken>,
    credential_context: Option<crate::server_policy::CredentialContext>,
}

impl McpTool {
    /// Redacted source definition for the bound UI host, never reconstructed from text.
    pub fn app_definition(&self) -> &McpToolDefinition {
        &self.definition
    }
    pub fn app_authority_current(&self) -> bool {
        self.app_source_authorized()
    }
    pub fn new(
        server_name: impl Into<String>,
        handle: McpServerHandle,
        definition: McpToolDefinition,
    ) -> Self {
        let native_origin = handle
            .try_lock()
            .ok()
            .and_then(|client| client.native_origin());
        let server_name = server_name.into();
        let exposed_name = mcp_tool_name(&server_name, &definition.name);
        Self {
            server_name,
            native_origin,
            exposed_name,
            handle,
            definition,
            plugin_id: None,
            required_trust: None,
            app_authorizer: None,
            session_lease: None,
            credential_context: None,
            private_values: Arc::new(PrivateValues::default()),
        }
    }

    pub fn with_credential_context(
        mut self,
        context: crate::server_policy::CredentialContext,
    ) -> Self {
        self.credential_context = Some(context);
        self
    }

    /// Native boundary inspection may observe the actual mutex without keeping
    /// this shared connection alive after its owner releases it.
    pub fn native_connection_gate(&self) -> std::sync::Weak<tokio::sync::Mutex<crate::McpClient>> {
        Arc::downgrade(&self.handle)
    }

    /// Original connection birth evidence. Missing is unknown, never a name lookup.
    pub fn native_origin(&self) -> Option<&Arc<crate::native_origin::NativeMcpConnectionOrigin>> {
        self.native_origin.as_ref()
    }

    /// Host-supplied values belong only to this exact plugin/server operation.
    pub fn with_private_values(mut self, values: Arc<PrivateValues>) -> Result<Self, ToolError> {
        if values.contains(&self.definition.name) || values.contains(&self.server_name) {
            return Err(ToolError::InvalidInput(
                "MCP tool identity contains private data".into(),
            ));
        }
        self.definition.description = values.text(&self.definition.description);
        values.json(&mut self.definition.input_schema);
        if let Some(meta) = self.definition.meta.as_mut() {
            values.json(meta);
        }
        self.private_values = values;
        Ok(self)
    }

    /// Bind project provenance once; authorization is checked at each call.
    pub fn with_folder_trust(
        mut self,
        directory: impl Into<std::path::PathBuf>,
        config_dir: impl Into<std::path::PathBuf>,
    ) -> Self {
        self.required_trust = Some((directory.into(), config_dir.into()));
        self
    }

    /// A session host may revoke all inherited tool clones without granting Apps authority.
    pub fn with_session_lease(mut self, token: tokio_util::sync::CancellationToken) -> Self {
        self.session_lease = Some(token);
        self
    }

    /// The host rechecks plugin/connection authority at resource-read time.
    /// A plugin-bound UI is disabled until this callback is supplied.
    pub fn with_app_authorizer(mut self, authorizer: Arc<dyn Fn() -> bool + Send + Sync>) -> Self {
        self.app_authorizer = Some(authorizer);
        self
    }

    fn app_source_authorized(&self) -> bool {
        if self
            .native_origin
            .as_ref()
            .is_some_and(|origin| !origin.is_live())
        {
            return false;
        }
        if self
            .session_lease
            .as_ref()
            .is_some_and(|lease| lease.is_cancelled())
        {
            return false;
        }
        if self
            .plugin_id
            .as_ref()
            .is_some_and(|plugin| self.private_values.contains(plugin))
        {
            return false;
        }
        if self.plugin_id.is_some() && self.app_authorizer.is_none() {
            return false;
        }
        if self
            .app_authorizer
            .as_ref()
            .is_some_and(|authorize| !authorize())
        {
            return false;
        }
        self.required_trust
            .as_ref()
            .is_none_or(|(directory, config)| {
                kcoder_config::FolderTrustStore::trust_all_from_environment()
                    || kcoder_config::FolderTrustStore::load(config).check(directory)
                        == kcoder_config::FolderTrust::Trusted
            })
    }

    /// Copy provenance, trust and private-value redaction into a dedicated Apps
    /// connection. The original model/terminal handle is never upgraded.
    pub async fn connect_for_app(
        &self,
        config: &crate::McpServerConfig,
        store: Option<Arc<crate::authorization_store::OAuthTokenStore>>,
        authorizer: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> anyhow::Result<(McpServerHandle, Vec<McpTool>)> {
        anyhow::ensure!(
            config.name == self.server_name && authorizer(),
            "MCP Apps source is no longer authorized"
        );
        let (handle, _) = crate::connect_server_for_apps_in(
            config,
            store,
            Arc::clone(&self.private_values),
            self.credential_context.as_ref(),
        )
        .await?;
        let definitions = handle.lock().await.list_tools().await?;
        anyhow::ensure!(authorizer(), "MCP Apps source changed while connecting");
        let mut tools = Vec::with_capacity(definitions.len());
        for definition in definitions {
            let mut tool = McpTool::new(&self.server_name, Arc::clone(&handle), definition);
            tool.plugin_id = self.plugin_id.clone();
            tool.required_trust = self.required_trust.clone();
            tool.app_authorizer = Some(Arc::clone(&authorizer));
            tool.session_lease = self.session_lease.clone();
            tool.credential_context = self.credential_context.clone();
            tools.push(tool.with_private_values(Arc::clone(&self.private_values))?);
        }
        Ok((handle, tools))
    }

    /// Read through this original Apps connection, never through a host URL/file API.
    pub async fn read_app_resource_result(
        &self,
        uri: &str,
        ctx: &ToolContext,
    ) -> anyhow::Result<Value> {
        anyhow::ensure!(
            ctx.inline_widgets_authorized(),
            "MCP Apps resource read requires presentation authority"
        );
        let mut client = tokio::select! { biased; _ = ctx.cancelled()=>return Err(crate::failure::interrupted(None,kcoder_types::mcp_failure::McpCallInterruptionReason::Cancelled,false)), client=self.handle.lock()=>client };
        anyhow::ensure!(
            client.workspace_allows(&ctx.state.cwd()),
            "MCP server is restricted to its source workspace"
        );
        anyhow::ensure!(
            client.apps_support_enabled() && self.app_source_authorized(),
            "MCP Apps source is no longer authorized"
        );
        ctx.verify_native_transport_authorization().await?;
        ctx.verify_native_resource_authorization(uri).await?;
        let mut value = client
            .read_resource_with_cancellation(uri, ctx.abort_token.as_ref())
            .await?;
        anyhow::ensure!(
            self.app_source_authorized(),
            "MCP Apps source authority was revoked"
        );
        self.private_values.json(&mut value);
        Ok(value)
    }

    /// The Engine must authorize and serialize this action before entry. Recheck
    /// live source and declared app visibility immediately before dispatch.
    pub async fn call_app_result(
        &self,
        input: Value,
        ctx: &ToolContext,
    ) -> anyhow::Result<crate::CallToolResult> {
        anyhow::ensure!(
            ctx.inline_widgets_authorized() && self.definition.visible_to_app(),
            "MCP App tool is unavailable to this client"
        );
        let mut client = tokio::select! {
            biased;
            _ = ctx.cancelled() => return Err(crate::failure::interrupted(None, kcoder_types::mcp_failure::McpCallInterruptionReason::Cancelled, false)),
            client = self.handle.lock() => client,
        };
        anyhow::ensure!(
            self.app_source_authorized(),
            "MCP Apps source authority was revoked"
        );
        let definitions = client
            .list_tools_with_cancellation(ctx.abort_token.as_ref())
            .await?;
        anyhow::ensure!(
            definitions.iter().any(|definition| {
                let mut schema = definition.input_schema.clone();
                self.private_values.json(&mut schema);
                definition.name == self.definition.name
                    && definition.visible_to_app()
                    && schema == self.definition.input_schema
            }),
            "MCP App tool visibility or schema changed; refresh the view before calling"
        );
        anyhow::ensure!(
            self.app_source_authorized(),
            "MCP Apps source authority was revoked"
        );
        ctx.verify_native_transport_authorization().await?;
        let result = client
            .call_tool_with_cancellation(&self.definition.name, input, ctx.abort_token.as_ref())
            .await?;
        let mut value = serde_json::to_value(result)?;
        self.private_values.json(&mut value);
        Ok(serde_json::from_value(value)?)
    }

    /// Attach the exact plugin identity supplied by the host contribution snapshot.
    pub fn with_plugin_source(mut self, plugin_id: impl Into<String>) -> Self {
        self.plugin_id = Some(plugin_id.into());
        self
    }
}

#[async_trait]
impl Tool for McpTool {
    fn is_app_visible(&self) -> bool {
        self.native_origin
            .as_ref()
            .is_none_or(|origin| origin.is_live())
            && self.definition.visible_to_app()
            && self
                .session_lease
                .as_ref()
                .is_none_or(|lease| !lease.is_cancelled())
    }

    fn is_model_visible(&self) -> bool {
        self.native_origin
            .as_ref()
            .is_none_or(|origin| origin.is_live())
            && self.definition.visible_to_model()
            && self
                .session_lease
                .as_ref()
                .is_none_or(|lease| !lease.is_cancelled())
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }
    fn name(&self) -> String {
        self.exposed_name.clone()
    }

    fn source(&self) -> ToolSource {
        match &self.plugin_id {
            Some(plugin) => ToolSource::Plugin {
                plugin: plugin.clone(),
                server: self.server_name.clone(),
                tool: self.definition.name.clone(),
            },
            None => ToolSource::Mcp {
                server: self.server_name.clone(),
                tool: self.definition.name.clone(),
            },
        }
    }

    fn description(&self) -> String {
        format!(
            "[MCP: {}::{}] {}",
            self.server_name, self.definition.name, self.definition.description
        )
    }

    fn input_schema(&self) -> Value {
        self.definition.input_schema.clone()
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let call = self.call_session(input, ctx);
        match &self.session_lease {
            Some(lease) => tokio::select! {
                biased;
                _ = lease.cancelled() => Ok(ToolOutput::error("Session MCP authority was revoked. If an operation was already dispatched its outcome may be unknown; reconcile before retrying.")),
                result = call => result,
            },
            None => call.await,
        }
    }
}

impl McpTool {
    async fn call_session(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let mut client = tokio::select! {
            biased;
            _ = ctx.cancelled() => return Ok(interruption_output(&crate::failure::interrupted(None, kcoder_types::mcp_failure::McpCallInterruptionReason::Cancelled, false))),
            client = self.handle.lock() => client,
        };
        if !client.workspace_allows(&ctx.state.cwd()) {
            return Ok(ToolOutput::error(
                "MCP server is restricted to its source workspace",
            ));
        }
        if self.app_authorizer.is_some() && !self.app_source_authorized() {
            return Ok(ToolOutput::error(
                "MCP Apps source authority was revoked; call refused",
            ));
        }
        // Check after acquiring the shared transport: a queued call must not
        // use a decision made before another client revoked folder trust.
        if let Some((directory, config_dir)) = &self.required_trust
            && !kcoder_config::FolderTrustStore::trust_all_from_environment()
            && kcoder_config::FolderTrustStore::load(config_dir).check(directory)
                != kcoder_config::FolderTrust::Trusted
        {
            return Ok(ToolOutput::error(
                "MCP project directory trust was revoked; call refused",
            ));
        }
        let verified = ctx.verify_native_transport_authorization().await;
        verified?;
        debug!(
            "calling MCP tool {}::{}",
            self.server_name, self.definition.name
        );

        let mut app_input = ctx.inline_widgets_authorized().then(|| input.clone());
        if let Some(value) = app_input.as_mut() {
            self.private_values.json(value);
        }
        match client
            .call_tool_with_cancellation(&self.definition.name, input, ctx.abort_token.as_ref())
            .await
        {
            Ok(result) => {
                // UI-only metadata is retained separately and never mirrored into model text.
                let ui = self.definition.ui_metadata().ok();
                let mut view = None;
                let mut ui_unavailable = false;
                if ctx.inline_widgets_authorized()
                    && client.apps_support_enabled()
                    && !result.is_error
                    && let Some(uri) = ui.as_ref().and_then(|ui| ui.resource_uri.as_deref())
                {
                    if self.app_source_authorized()
                        && ctx.verify_native_resource_authorization(uri).await.is_ok()
                    {
                        match client
                            .read_ui_resource(
                                &self.server_name,
                                self.plugin_id.as_deref(),
                                &self.definition.name,
                                uri,
                                result.structured_content.clone(),
                                result.meta.clone(),
                                ctx.abort_token.as_ref(),
                            )
                            .await
                        {
                            Ok(mut value) if self.app_source_authorized() => {
                                value
                                    .csp
                                    .connect_domains
                                    .retain(|origin| !self.private_values.contains(origin));
                                value
                                    .csp
                                    .resource_domains
                                    .retain(|origin| !self.private_values.contains(origin));
                                value
                                    .csp
                                    .frame_domains
                                    .retain(|origin| !self.private_values.contains(origin));
                                value
                                    .csp
                                    .base_uri_domains
                                    .retain(|origin| !self.private_values.contains(origin));
                                value.html = self.private_values.text(&value.html);
                                if let Some(data) = value.structured_content.as_mut() {
                                    self.private_values.json(data);
                                }
                                if let Some(data) = value.result_meta.as_mut() {
                                    self.private_values.json(data);
                                }
                                value.tool_input = app_input.clone();
                                value.tool_content = result
                                    .content
                                    .iter()
                                    .map(|block| {
                                        serde_json::to_value(block).expect("MCP content serializes")
                                    })
                                    .collect();
                                for block in &mut value.tool_content {
                                    self.private_values.json(block);
                                }
                                let input_bytes = value.tool_input.as_ref().map_or(0, |input| {
                                    serde_json::to_vec(input)
                                        .map_or(usize::MAX, |bytes| bytes.len())
                                });
                                let content_bytes = serde_json::to_vec(&value.tool_content)
                                    .map_or(usize::MAX, |bytes| bytes.len());
                                if input_bytes <= kcoder_types::mcp_apps::MCP_APP_DATA_MAX_BYTES
                                    && content_bytes <= 256 * 1024
                                    && serde_json::to_vec(&value).is_ok_and(|bytes| {
                                        bytes.len()
                                            <= kcoder_types::mcp_apps::MCP_APP_VIEW_MAX_BYTES
                                    })
                                {
                                    view = Some(value);
                                } else {
                                    ui_unavailable = true;
                                }
                            }
                            _ => ui_unavailable = true,
                        }
                    } else {
                        ui_unavailable = true;
                    }
                }
                let mut output = convert_result(result);
                if let Some(view) = view {
                    output
                        .execution_metadata
                        .push(kcoder_tools::ToolExecutionMetadata::McpApp(view));
                }
                if ui_unavailable {
                    output.content.push(kcoder_types::ContentBlock::Text { text: "The MCP tool returned its result, but its inline view is unavailable or no longer authorized. Do not repeat the external action to recreate the view.".into() });
                }
                for block in &mut output.content {
                    if let kcoder_types::ContentBlock::Text { text } = block {
                        *text = self.private_values.text(text);
                    }
                }
                Ok(output)
            }
            Err(e) => {
                if crate::failure::call_receipt(&e).is_some() {
                    return Ok(interruption_output(&e));
                }
                let safe_error = self.private_values.text(&e.to_string());
                error!(
                    "MCP tool {}::{} call failed: {}",
                    self.server_name, self.definition.name, safe_error
                );
                Ok(ToolOutput::error(format!(
                    "MCP server '{}' tool '{}' failed: {}",
                    self.server_name, self.definition.name, safe_error
                )))
            }
        }
    }
}

fn interruption_output(error: &anyhow::Error) -> ToolOutput {
    let receipt = crate::failure::call_receipt(error).expect("MCP interruption contains receipt");
    let mut value = serde_json::to_value(receipt).expect("MCP receipt serializes");
    let message = match receipt.status {
        kcoder_types::mcp_failure::McpCallStatus::NotSent => {
            "The MCP tool call was not sent. No external action was dispatched."
        }
        kcoder_types::mcp_failure::McpCallStatus::OutcomeUnknown => {
            "The MCP tool call may have executed. Cancellation is best effort and does not undo effects. Verify external state before any new action; do not automatically repeat this call."
        }
    };
    value["message"] = Value::String(message.into());
    ToolOutput::error(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct DisconnectedTransport;

    #[async_trait]
    impl crate::transport::McpTransport for DisconnectedTransport {
        async fn send(&mut self, _: &str) -> anyhow::Result<()> {
            anyhow::bail!("test transport must not be used during registration")
        }
        async fn recv(&mut self) -> anyhow::Result<Option<String>> {
            anyhow::bail!("test transport must not be used during registration")
        }
    }

    fn test_tool(server: &str, name: &str) -> McpTool {
        McpTool::new(
            server,
            Arc::new(Mutex::new(McpClient::with_transport(Box::new(
                DisconnectedTransport,
            )))),
            McpToolDefinition {
                meta: None,
                name: name.into(),
                description: name.into(),
                input_schema: serde_json::json!({"type": "object"}),
            },
        )
    }

    #[test]
    fn private_metadata_schema_and_text_are_scope_redacted() {
        let secret = "P09-foo-synthetic";
        let mut tool = test_tool("owned", "read");
        tool.definition.description = format!("ordinary details {secret}");
        tool.definition.input_schema = serde_json::json!({"type":"object","properties":{"FOO":{"type":"string","default":secret}}});
        let tool = tool
            .with_plugin_source("scope@owned")
            .with_private_values(PrivateValues::new([secret.into()]).unwrap())
            .unwrap();
        assert!(!tool.description().contains(secret));
        assert!(!tool.input_schema().to_string().contains(secret));
        assert!(tool.description().contains("ordinary details"));
    }

    #[tokio::test]
    async fn queued_mcp_call_checks_latest_trust_before_using_transport() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        let config = temp.path().join("profile");
        let mut trust = kcoder_config::FolderTrustStore::load(&config);
        trust.trust(&project).unwrap();
        let tool = test_tool("project", "read").with_folder_trust(&project, &config);
        let handle = Arc::clone(&tool.handle);
        let transport = handle.lock().await;
        let context = ToolContext::new(kcoder_state::AppState::new(&project));
        let call = tokio::spawn(async move { tool.call(serde_json::json!({}), &context).await });
        tokio::task::yield_now().await;
        trust.revoke(&project).unwrap();
        drop(transport);
        let output = call.await.unwrap().unwrap();
        assert!(output.is_error);
        assert!(
            serde_json::to_string(&output.content)
                .unwrap()
                .contains("trust was revoked")
        );
    }

    #[test]
    fn mcp_registration_preserves_unsanitized_source() {
        let tool = test_tool("docs / remote", "get / page");
        assert_eq!(
            tool.source(),
            kcoder_tools::ToolSource::Mcp {
                server: "docs / remote".into(),
                tool: "get / page".into()
            }
        );
    }

    #[test]
    fn sanitized_collisions_report_original_server_and_tool_identities() {
        let mut registry = kcoder_tools::ToolRegistry::new();
        registry
            .try_register(Arc::new(test_tool("docs a", "get/page")))
            .unwrap();
        let error = registry
            .try_register(Arc::new(test_tool("docs_a", "get_page")))
            .unwrap_err();
        assert_eq!(error.name, "mcp__docs_a__get_page");
        assert_eq!(
            error.existing,
            ToolSource::Mcp {
                server: "docs a".into(),
                tool: "get/page".into()
            }
        );
        assert_eq!(
            error.incoming,
            ToolSource::Mcp {
                server: "docs_a".into(),
                tool: "get_page".into()
            }
        );
        assert_eq!(
            registry.get(&error.name).unwrap().description(),
            "[MCP: docs a::get/page] get/page"
        );
    }

    #[test]
    fn plugin_contribution_keeps_plugin_identity_through_registration_and_filtering() {
        let tool = test_tool("plugin.docs.remote", "read").with_plugin_source("docs@market");
        let name = tool.name();
        let expected = ToolSource::Plugin {
            plugin: "docs@market".into(),
            server: "plugin.docs.remote".into(),
            tool: "read".into(),
        };
        let mut registry = kcoder_tools::ToolRegistry::new();
        registry.try_register(Arc::new(tool)).unwrap();
        let filtered = registry
            .clone()
            .filtered_to_names(std::slice::from_ref(&name));
        assert_eq!(filtered.source(&name), Some(&expected));
        assert!(
            filtered
                .filtered_out_by_patterns(&["mcp__*".into()])
                .get(&name)
                .is_none()
        );
    }
}
