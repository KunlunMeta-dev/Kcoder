//! Retained original native emitters for finite resource reads and transport rechecks.
use super::*;
use crate::QueryEngine;
use kcoder_tools::{ToolContext, ToolError, ToolRegistry};
use std::sync::Arc;

pub struct NativeResourceAuthorizationRequest<'a> {
    pub emitter: &'a NativeToolEmitterWitness,
    pub uri: &'a str,
}
/// Kept only by the owning live App connection; no wire constructor exists.
pub struct NativeResourceReadAuthority {
    emitter: NativeToolEmitterWitness,
    authority: Option<Arc<dyn NativeToolAuthorization>>,
}
impl NativeResourceReadAuthority {
    pub fn emitter(&self) -> &NativeToolEmitterWitness {
        &self.emitter
    }
    pub async fn authorize(&self, uri: &str) -> Result<(), NativeToolAuthorizationError> {
        if let Some(authority) = &self.authority {
            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                authority.authorize_resource(&NativeResourceAuthorizationRequest {
                    emitter: &self.emitter,
                    uri,
                }),
            )
            .await
            .unwrap_or(Err(NativeToolAuthorizationError::Unavailable))
        } else {
            Ok(())
        }
    }
}
struct NativeResourceRecheck {
    reader: Arc<NativeResourceReadAuthority>,
    uri: String,
}
#[async_trait::async_trait]
impl kcoder_tools::NativeTransportAuthorization for NativeResourceRecheck {
    async fn verify_resource(&self, uri: &str) -> Result<(), ToolError> {
        if uri != self.uri {
            return Err(ToolError::Execution("NATIVE_RESOURCE_URI_CHANGED".into()));
        }
        self.verify().await
    }
    async fn verify(&self) -> Result<(), ToolError> {
        self.reader
            .authorize(&self.uri)
            .await
            .map_err(|error| ToolError::Execution(error.to_string()))
    }
}
impl NativeResourceReadAuthority {
    pub fn with_read_context(self: &Arc<Self>, context: ToolContext, uri: &str) -> ToolContext {
        context.with_native_transport_authorization(Arc::new(NativeResourceRecheck {
            reader: self.clone(),
            uri: uri.into(),
        }))
    }
}
struct NativeAppCallbackRecheck(Arc<NativeResourceReadAuthority>);
#[async_trait::async_trait]
impl kcoder_tools::NativeTransportAuthorization for NativeAppCallbackRecheck {
    async fn verify(&self) -> Result<(), ToolError> {
        self.0
            .authorize_app_callback()
            .await
            .map_err(|error| ToolError::Execution(error.to_string()))
    }
    async fn verify_resource(&self, uri: &str) -> Result<(), ToolError> {
        self.0
            .authorize(uri)
            .await
            .map_err(|error| ToolError::Execution(error.to_string()))
    }
}
impl NativeResourceReadAuthority {
    pub async fn authorize_app_callback(&self) -> Result<(), NativeToolAuthorizationError> {
        if let Some(authority) = &self.authority {
            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                authority.authorize_app_callback(&self.emitter),
            )
            .await
            .unwrap_or(Err(NativeToolAuthorizationError::Unavailable))
        } else {
            Ok(())
        }
    }
    pub fn with_app_callback_context(self: &Arc<Self>, context: ToolContext) -> ToolContext {
        context
            .with_native_transport_authorization(Arc::new(NativeAppCallbackRecheck(self.clone())))
    }
}
struct NativeDispatchRecheck {
    emitter: NativeToolEmitterWitness,
    authority: Arc<dyn NativeToolAuthorization>,
    input: serde_json::Value,
    without_sandbox: bool,
}
#[async_trait::async_trait]
impl kcoder_tools::NativeTransportAuthorization for NativeDispatchRecheck {
    async fn verify_resource(&self, uri: &str) -> Result<(), ToolError> {
        self.authority
            .authorize_resource(&NativeResourceAuthorizationRequest {
                emitter: &self.emitter,
                uri,
            })
            .await
            .map_err(|error| ToolError::Execution(error.to_string()))
    }
    async fn verify(&self) -> Result<(), ToolError> {
        let request = NativeToolAuthorizationRequest {
            execution: Some(self.emitter.execution()),
            emitter: Some(&self.emitter),
            session_id: self.emitter.execution().session_id(),
            tool_name: self.emitter.tool_name(),
            source: self.emitter.source().clone(),
            input: &self.input,
            read_only: self.emitter.tool().is_read_only(),
            without_sandbox: self.without_sandbox,
            phase: NativeToolAuthorizationPhase::Dispatch,
        };
        self.authority
            .authorize(&request)
            .await
            .map_err(|error| ToolError::Execution(error.to_string()))
    }
}
impl QueryEngine {
    pub fn native_resource_read_authority(
        &self,
        name: &str,
    ) -> Option<Arc<NativeResourceReadAuthority>> {
        Some(Arc::new(NativeResourceReadAuthority {
            emitter: self.native_tool_emitter_witness(name)?,
            authority: self.native_tool_authorization.clone(),
        }))
    }
    pub(crate) fn with_native_transport_recheck(
        &self,
        context: ToolContext,
        registry: &ToolRegistry,
        tool: &Arc<dyn kcoder_tools::Tool>,
        name: &str,
        input: &serde_json::Value,
        without_sandbox: bool,
    ) -> Result<ToolContext, NativeToolAuthorizationError> {
        let Some(authority) = &self.native_tool_authorization else {
            return Ok(context);
        };
        let emitter = self.capture_native_tool_emitter(registry, name, tool)?;
        Ok(
            context.with_native_transport_authorization(Arc::new(NativeDispatchRecheck {
                emitter,
                authority: authority.clone(),
                input: input.clone(),
                without_sandbox,
            })),
        )
    }
}

impl QueryEngine {
    pub(crate) fn inherit_resource_tools_for_general_child(
        &self,
        mut tools: ToolRegistry,
        kind: kcoder_tools::agent::AgentKind,
        arrangement_mode: bool,
    ) -> ToolRegistry {
        // Restricted roles and literal child registries keep their original
        // boundaries. Ordered MCP calls never acquire read-only/concurrency flags.
        if self.subagent_tools_explicit
            || arrangement_mode
            || kind != kcoder_tools::agent::AgentKind::General
        {
            return tools;
        }
        let Some(authority) = &self.native_tool_authorization else {
            return tools;
        };
        if let Ok(Some(hints)) = authority.inherited_resource_tools(&self.tools) {
            for tool in hints.into_iter().take(4096) {
                if !matches!(
                    tool.source(),
                    kcoder_tools::ToolSource::Mcp { .. } | kcoder_tools::ToolSource::Plugin { .. }
                ) || tools.get(&tool.name()).is_some()
                {
                    continue;
                }
                let Some(parent) = self.tools.get(&tool.name()) else {
                    continue;
                };
                if !Arc::ptr_eq(&parent, &tool)
                    || parent.source() != tool.source()
                    || parent.input_schema() != tool.input_schema()
                {
                    continue;
                }
                tools = tools.register_arc(tool);
            }
        }
        self.restrict_to_native_tool_ceiling(tools)
    }
}

#[cfg(test)]
mod child_catalog_tests {
    use super::*;
    use crate::test_support::engine_builder::TestEngineBuilder;
    use kcoder_tools::agent::AgentKind;
    use std::sync::atomic::{AtomicBool, Ordering};
    struct NoTransport;
    #[async_trait::async_trait]
    impl kcoder_mcp::McpTransport for NoTransport {
        async fn send(&mut self, _: &str) -> anyhow::Result<()> {
            anyhow::bail!("constructor test never sends")
        }
        async fn recv(&mut self) -> anyhow::Result<Option<String>> {
            Ok(None)
        }
    }
    struct ReviewedHints {
        original: Arc<dyn kcoder_tools::Tool>,
        live: AtomicBool,
    }
    #[async_trait::async_trait]
    impl NativeToolAuthorization for ReviewedHints {
        fn inherited_resource_tools(
            &self,
            _registered: &ToolRegistry,
        ) -> Result<Option<Vec<Arc<dyn kcoder_tools::Tool>>>, NativeToolAuthorizationError>
        {
            Ok(Some(if self.live.load(Ordering::SeqCst) {
                vec![self.original.clone()]
            } else {
                vec![]
            }))
        }
        async fn authorize(
            &self,
            _: &NativeToolAuthorizationRequest<'_>,
        ) -> Result<(), NativeToolAuthorizationError> {
            Err(NativeToolAuthorizationError::Denied)
        }
    }
    #[test]
    fn general_child_gets_only_actual_hint_and_literal_role_or_native_ceilings_stay_closed() {
        let temp = tempfile::tempdir().unwrap();
        let original: Arc<dyn kcoder_tools::Tool> = Arc::new(kcoder_mcp::McpTool::new(
            "original-source",
            Arc::new(tokio::sync::Mutex::new(
                kcoder_mcp::McpClient::with_transport(Box::new(NoTransport)),
            )),
            serde_json::from_value(
                serde_json::json!({"name":"read","inputSchema":{"type":"object"}}),
            )
            .unwrap(),
        ));
        let name = original.name();
        let mut parent = TestEngineBuilder::new(temp.path())
            .tool_registry(ToolRegistry::new().register_arc(original.clone()))
            .build_with_profile_directory();
        // Model the CLI's default builtin-only child registry. The builder
        // otherwise seeds both registries; this is not an explicit override.
        parent.subagent_tools = Arc::new(std::sync::RwLock::new(kcoder_tools::default_registry()));
        assert!(!parent.subagent_tools_explicit);
        let base = parent.active_subagent_tools_for_mode(false);
        assert!(
            parent
                .inherit_resource_tools_for_general_child(base.clone(), AgentKind::General, false)
                .get(&name)
                .is_none()
        );
        let hints = Arc::new(ReviewedHints {
            original: original.clone(),
            live: AtomicBool::new(true),
        });
        let parent = parent.with_native_tool_authorization(hints.clone());
        let inherited = parent.inherit_resource_tools_for_general_child(
            base.clone(),
            AgentKind::General,
            false,
        );
        assert!(
            inherited
                .get(&name)
                .is_some_and(|tool| Arc::ptr_eq(&tool, &original))
        );
        for literal in [
            ToolRegistry::new(),
            base.filtered_to_names(&["read".into()]),
        ] {
            let expected = literal.names();
            let explicit = parent.clone().with_subagent_tools(literal);
            let inherited = explicit.inherit_resource_tools_for_general_child(
                explicit.active_subagent_tools_for_mode(false),
                AgentKind::General,
                false,
            );
            assert_eq!(inherited.names(), expected);
        }
        let replacement: Arc<dyn kcoder_tools::Tool> = Arc::new(kcoder_mcp::McpTool::new(
            "original-source",
            Arc::new(tokio::sync::Mutex::new(
                kcoder_mcp::McpClient::with_transport(Box::new(NoTransport)),
            )),
            serde_json::from_value(
                serde_json::json!({"name":"read","inputSchema":{"type":"object"}}),
            )
            .unwrap(),
        ));
        let replaced = parent
            .clone()
            .with_turn_tools(ToolRegistry::new().register_arc(replacement));
        assert!(
            replaced
                .inherit_resource_tools_for_general_child(base.clone(), AgentKind::General, false)
                .get(&name)
                .is_none()
        );
        assert!(
            parent
                .inherit_resource_tools_for_general_child(base.clone(), AgentKind::Plan, false)
                .get(&name)
                .is_none()
        );
        assert!(
            parent
                .inherit_resource_tools_for_general_child(base.clone(), AgentKind::General, true)
                .get(&name)
                .is_none()
        );
        assert!(
            parent
                .clone()
                .with_native_tool_ceiling(&[])
                .unwrap()
                .inherit_resource_tools_for_general_child(base.clone(), AgentKind::General, false)
                .names()
                .is_empty()
        );
        hints.live.store(false, Ordering::SeqCst);
        assert!(
            parent
                .inherit_resource_tools_for_general_child(base, AgentKind::General, false)
                .get(&name)
                .is_none()
        );
    }
}
