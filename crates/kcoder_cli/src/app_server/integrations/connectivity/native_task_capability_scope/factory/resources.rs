//! Current resource grants on the already owned Main and original native source.
use super::*;
use serde::Deserialize;

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
    reference: IntegrationTaskResourceRef,
    source_resource_ref: IntegrationTaskResourceRef,
}

impl NativeTaskCapabilityScopeFactory {
    async fn resource_uris(
        &self,
        context: &NativeIntegrationContext,
        binding: &IntegrationTaskResourceBinding,
    ) -> Result<Vec<String>> {
        self.verify(context)?;
        binding.validate()?;
        let host = self
            .resource_host
            .lock()
            .map_err(|_| anyhow::anyhow!("TASK_RESOURCE_MAIN_UNAVAILABLE"))?
            .upgrade()
            .context("TASK_RESOURCE_MAIN_UNAVAILABLE")?;
        let value = host
            .task_resource_fact(context, &binding.connection_ref, &binding.resource_refs)
            .await?;
        let selected: Selected = serde_json::from_value(value)?;
        ensure!(
            !selected.native_namespace_id.is_empty()
                && !selected.application_kind.is_empty()
                && selected.connection_id == binding.connection_ref.id
                && selected.connection_revision == binding.connection_ref.revision
                && selected.resources.len() == binding.resource_refs.len(),
            "TASK_RESOURCE_GRANT_CHANGED"
        );
        let facts = self.current_sources(context)?;
        let catalog = NativeConnectivitySourceCatalog::observe(context)?
            .context("TASK_RESOURCE_CATALOG_UNAVAILABLE")?;
        let selector = catalog.resolve_choice(context, &binding.source, &facts)?;
        ensure!(
            selector.server == selected.source.name && selector.plugin == selected.source.plugin_id,
            "TASK_RESOURCE_SOURCE_OR_ACCOUNT_CHANGED"
        );
        let mut uris = Vec::with_capacity(selected.resources.len());
        for (expected, actual) in binding.resource_refs.iter().zip(selected.resources) {
            ensure!(
                actual.reference == *expected
                    && actual.source_resource_ref.kind == expected.kind
                    && !actual.source_resource_ref.id.is_empty()
                    && actual.source_resource_ref.id.len() <= 4096
                    && !actual.source_resource_ref.revision.is_empty(),
                "TASK_RESOURCE_GRANT_CHANGED"
            );
            super::super::super::application_task::verify_resource_revision(
                &binding.source,
                &actual.source_resource_ref.revision,
            )?;
            uris.push(actual.source_resource_ref.id);
        }
        self.verify(context)?;
        Ok(uris)
    }
    pub(super) async fn check_current_resource_bindings(
        &self,
        context: &NativeIntegrationContext,
        bindings: &[IntegrationTaskResourceBinding],
    ) -> Result<()> {
        ensure!(
            bindings.len() <= MAX_TASK_CAPABILITY_SOURCES,
            "TASK_RESOURCE_BINDING_LIMIT"
        );
        let mut seen = std::collections::BTreeSet::new();
        for binding in bindings {
            ensure!(
                seen.insert((
                    binding.source.source_ref.id.clone(),
                    binding.connection_ref.id.clone()
                )),
                "TASK_RESOURCE_DUPLICATE_CONNECTION"
            );
            self.resource_uris(context, binding).await?;
        }
        self.verify(context)
    }
    pub(super) async fn check_resource_uri(
        &self,
        context: &NativeIntegrationContext,
        bindings: &[IntegrationTaskResourceBinding],
        choice: &IntegrationTaskCapabilitySourceChoice,
        uri: &str,
    ) -> Result<bool> {
        ensure!(
            !uri.is_empty() && uri.len() <= 4096,
            "TASK_RESOURCE_URI_INVALID"
        );
        for binding in bindings.iter().filter(|binding| &binding.source == choice) {
            if self
                .resource_uris(context, binding)
                .await?
                .iter()
                .any(|allowed| allowed == uri)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

impl NativeTaskCapabilityScopeFactory {
    pub(super) async fn resource_uri(
        &self,
        context: &NativeIntegrationContext,
        bindings: &[IntegrationTaskResourceBinding],
        selector: &super::super::super::NativeMcpSourceSelector,
        uri: &str,
    ) -> Result<bool> {
        let facts = self.current_sources(context)?;
        let catalog = NativeConnectivitySourceCatalog::observe(context)?
            .context("TASK_RESOURCE_CATALOG_UNAVAILABLE")?;
        for binding in bindings {
            if catalog
                .resolve_choice(context, &binding.source, &facts)
                .is_ok_and(|current| &current == selector)
                && self
                    .check_resource_uri(
                        context,
                        std::slice::from_ref(binding),
                        &binding.source,
                        uri,
                    )
                    .await?
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
    pub(super) async fn resource_tool(
        &self,
        context: &NativeIntegrationContext,
        bindings: &[IntegrationTaskResourceBinding],
        request: &NativeToolAuthorizationRequest<'_>,
    ) -> Result<bool> {
        use kcoder_tools::{Tool, ToolSource};
        let emitter = request
            .emitter
            .context("TASK_RESOURCE_NATIVE_TOOL_REQUIRED")?;
        let proxy = emitter
            .downcast_tool::<crate::app_server::mcp_apps_tool::McpPresentationTool>()
            .map(|proxy| proxy.native_source_reader())
            .transpose()?;
        let original = proxy.as_ref().map_or(emitter, |reader| reader.emitter());
        let actual = original
            .downcast_tool::<kcoder_mcp::McpTool>()
            .context("TASK_RESOURCE_TOOL_SEMANTICS_UNAVAILABLE")?;
        let (selector, raw) = match actual.source() {
            ToolSource::Mcp { server, tool } => (
                super::super::super::NativeMcpSourceSelector {
                    server,
                    plugin: None,
                },
                tool,
            ),
            ToolSource::Plugin {
                server,
                plugin,
                tool,
            } => (
                super::super::super::NativeMcpSourceSelector {
                    server,
                    plugin: Some(plugin),
                },
                tool,
            ),
            _ => anyhow::bail!("TASK_RESOURCE_NATIVE_TOOL_REQUIRED"),
        };
        let configs = self.configuration.current_mcp_servers()?;
        let matching = configs
            .iter()
            .filter(|entry| {
                entry.config.name == selector.server && entry.plugin_id == selector.plugin
            })
            .collect::<Vec<_>>();
        ensure!(
            matching.len() == 1,
            "TASK_RESOURCE_CURRENT_SOURCE_UNAVAILABLE"
        );
        let rule = matching[0]
            .config
            .policy
            .task_resource_reads
            .get(&raw)
            .context("TASK_RESOURCE_TOOL_SEMANTICS_UNAVAILABLE")?;
        let origin = actual
            .native_origin()
            .context("TASK_RESOURCE_NATIVE_TOOL_REQUIRED")?;
        ensure!(
            origin.private_config().policy.task_resource_reads.get(&raw) == Some(rule),
            "TASK_RESOURCE_TOOL_POLICY_CHANGED"
        );
        let schema = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&actual.input_schema())?)
        );
        let uri = rule
            .resource_uri(&schema, request.input)
            .context("TASK_RESOURCE_TOOL_INPUT_DENIED")?;
        self.resource_uri(context, bindings, &selector, uri).await
    }
}

impl NativeTaskCapabilityScopeFactory {
    pub(super) fn inherited_reviewed_resource_tools(
        &self,
        context: &NativeIntegrationContext,
        bindings: &[IntegrationTaskResourceBinding],
        registered: &kcoder_tools::ToolRegistry,
    ) -> Result<Vec<Arc<dyn kcoder_tools::Tool>>> {
        self.verify(context)?;
        if bindings.is_empty() {
            return Ok(Vec::new());
        }
        let current = self.current_sources(context)?;
        let catalog = NativeConnectivitySourceCatalog::observe(context)?
            .context("TASK_RESOURCE_CATALOG_UNAVAILABLE")?;
        let entries = self
            .sources
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("TASK_CAPABILITY_SCOPE_REGISTRY_UNAVAILABLE"))?;
        let mut tools = Vec::new();
        for entry in entries.iter() {
            let Some(tool) = entry.tool.upgrade() else {
                continue;
            };
            let Some(parent) = registered.get(&tool.name()) else {
                continue;
            };
            let parent_matches = matches_original_parent(&tool, &parent);
            if !parent_matches {
                continue;
            }
            let actual: &dyn std::any::Any = tool.as_ref();
            let Some(actual) = actual.downcast_ref::<kcoder_mcp::McpTool>() else {
                continue;
            };
            let Some(origin) = entry.origin.upgrade() else {
                continue;
            };
            if !actual
                .native_origin()
                .is_some_and(|candidate| Arc::ptr_eq(candidate, &origin))
                || !origin.matches_profile(context.profile()?)?
            {
                continue;
            }
            let raw = match tool.source() {
                kcoder_tools::ToolSource::Mcp { tool, .. }
                | kcoder_tools::ToolSource::Plugin { tool, .. } => tool,
                _ => continue,
            };
            let Some(rule) = origin.private_config().policy.task_resource_reads.get(&raw) else {
                continue;
            };
            if !reviewed_schema_matches(actual, rule)? {
                continue;
            }
            let selected = bindings.iter().any(|binding| {
                catalog
                    .resolve_choice(context, &binding.source, &current)
                    .is_ok()
                    && catalog
                        .resolve_choice(
                            context,
                            &binding.source,
                            std::slice::from_ref(entry.source.as_ref()),
                        )
                        .is_ok()
            });
            if selected {
                tools.push(tool);
            }
        }
        self.verify(context)?;
        Ok(tools)
    }
}

fn matches_original_parent(
    original: &Arc<dyn kcoder_tools::Tool>,
    parent: &Arc<dyn kcoder_tools::Tool>,
) -> bool {
    if Arc::ptr_eq(parent, original) {
        return true;
    }
    let actual: &dyn std::any::Any = parent.as_ref();
    actual
        .downcast_ref::<crate::app_server::mcp_apps_tool::McpPresentationTool>()
        .and_then(|proxy| proxy.native_source_reader().ok())
        .is_some_and(|reader| reader.emitter().matches_tool(original))
}
fn reviewed_schema_matches(
    actual: &kcoder_mcp::McpTool,
    rule: &kcoder_types::McpTaskResourceReadRule,
) -> Result<bool> {
    use kcoder_tools::Tool;
    let schema = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&actual.input_schema())?)
    );
    Ok(rule.schema_sha256 == schema
        && rule.input_template.is_object()
        && rule
            .input_template
            .pointer(&rule.uri_input_pointer)
            .is_some_and(serde_json::Value::is_null))
}
#[cfg(test)]
mod child_hint_tests {
    use super::*;
    use kcoder_tools::Tool;
    struct NoTransport;
    #[async_trait::async_trait]
    impl kcoder_mcp::McpTransport for NoTransport {
        async fn send(&mut self, _: &str) -> Result<()> {
            anyhow::bail!("catalog test never sends")
        }
        async fn recv(&mut self) -> Result<Option<String>> {
            Ok(None)
        }
    }
    fn tool(schema: serde_json::Value) -> Arc<dyn Tool> {
        Arc::new(kcoder_mcp::McpTool::new("original-source",Arc::new(tokio::sync::Mutex::new(
            kcoder_mcp::McpClient::with_transport(Box::new(NoTransport)))),serde_json::from_value(
                serde_json::json!({"name":"read","inputSchema":schema,"annotations":{"readOnlyHint":true}})).unwrap()))
    }
    #[test]
    fn child_hint_requires_original_object_and_reviewed_schema_not_server_readonly_annotation() {
        let schema = serde_json::json!({"type":"object","properties":{"uri":{"type":"string"}}});
        let original = tool(schema.clone());
        let same_name = tool(schema.clone());
        assert!(matches_original_parent(&original, &original));
        assert!(!matches_original_parent(&original, &same_name));
        let rule = kcoder_types::McpTaskResourceReadRule {
            schema_sha256: format!("{:x}", Sha256::digest(serde_json::to_vec(&schema).unwrap())),
            uri_input_pointer: "/uri".into(),
            input_template: serde_json::json!({"uri":null}),
        };
        let actual: &dyn std::any::Any = original.as_ref();
        assert!(
            reviewed_schema_matches(actual.downcast_ref::<kcoder_mcp::McpTool>().unwrap(), &rule)
                .unwrap()
        );
        let changed =
            tool(serde_json::json!({"type":"object","properties":{"send":{"type":"boolean"}}}));
        let actual: &dyn std::any::Any = changed.as_ref();
        assert!(
            !reviewed_schema_matches(actual.downcast_ref::<kcoder_mcp::McpTool>().unwrap(), &rule)
                .unwrap()
        );
        assert!(!original.is_read_only());
    }
}
