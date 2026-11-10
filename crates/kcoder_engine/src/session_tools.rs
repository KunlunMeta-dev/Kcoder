//! Host-owned session tools are runtime contributions, never settings or history.
use super::*;

pub(super) struct SessionToolContributions {
    tools: ToolRegistry,
    revoked: CancellationToken,
}

impl SessionToolContributions {
    pub(super) fn revoke(&self) {
        self.revoked.cancel();
    }

    pub(super) fn merge(
        &self,
        mut baseline: ToolRegistry,
        settings: &Settings,
    ) -> Result<ToolRegistry> {
        if !self.revoked.is_cancelled() && !baseline.names().is_empty() {
            for tool in self.tools.all() {
                baseline.try_register(tool)?;
            }
        }
        Ok(baseline.filtered_out_by_patterns(&settings.tools.disabled))
    }
}

impl Drop for SessionToolContributions {
    fn drop(&mut self) {
        self.revoke();
    }
}

impl QueryEngine {
    /// Attach explicit external tools to a fresh host session. The token revokes
    /// every clone on session replacement; the host owns connection cleanup.
    pub fn with_session_tools(
        mut self,
        tools: ToolRegistry,
        revoked: CancellationToken,
    ) -> Result<Self> {
        anyhow::ensure!(
            self.session_tool_contributions.is_none(),
            "Session tools already attached"
        );
        anyhow::ensure!(
            !revoked.is_cancelled(),
            "Session tool authority is already revoked"
        );
        anyhow::ensure!(
            tools
                .all()
                .iter()
                .all(|tool| matches!(tool.source(), kcoder_tools::ToolSource::Mcp { .. })),
            "Session contributions must retain an MCP source"
        );
        let contributions = Arc::new(SessionToolContributions { tools, revoked });
        let registry = contributions.merge(
            self.tools.clone(),
            &recover_read_lock(&self.settings, "settings"),
        )?;
        let subagents = contributions.merge(
            self.subagent_tools(),
            &recover_read_lock(&self.settings, "settings"),
        )?;
        self = self.with_turn_tools(registry);
        self.subagent_tools = Arc::new(RwLock::new(subagents));
        self.session_tool_contributions = Some(contributions);
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::engine_builder::TestEngineBuilder;
    use kcoder_tools::{FileReadTool, Tool, ToolContext, ToolError, ToolOutput, ToolSource};
    use serde_json::json;

    struct External;
    #[async_trait::async_trait]
    impl Tool for External {
        fn name(&self) -> String {
            "mcp__host__echo".into()
        }
        fn source(&self) -> ToolSource {
            ToolSource::Mcp {
                server: "host".into(),
                tool: "echo".into(),
            }
        }
        fn description(&self) -> String {
            "Session fixture".into()
        }
        fn input_schema(&self) -> Value {
            json!({"type":"object"})
        }
        async fn call(
            &self,
            _: Value,
            _: &ToolContext,
        ) -> std::result::Result<ToolOutput, ToolError> {
            Ok(ToolOutput::text("fixture"))
        }
    }

    #[tokio::test]
    async fn session_contributions_survive_host_refresh_without_restoring_disabled_tools() {
        let root = tempfile::tempdir().unwrap();
        let token = CancellationToken::new();
        let engine = TestEngineBuilder::new(root.path())
            .tool_registry(ToolRegistry::new().register(FileReadTool))
            .build_with_profile_directory()
            .with_session_tools(ToolRegistry::new().register(External), token.clone())
            .unwrap();
        let settings = recover_read_lock(&engine.settings, "settings").clone();
        assert!(
            !serde_json::to_string(&settings)
                .unwrap()
                .contains("mcp__host__echo")
        );
        let refreshed = engine
            .clone()
            .with_host_plugin_runtime(
                settings.clone(),
                ToolRegistry::new().register(FileReadTool),
                Default::default(),
            )
            .unwrap();
        assert_eq!(
            refreshed.tools.source("mcp__host__echo"),
            Some(&ToolSource::Mcp {
                server: "host".into(),
                tool: "echo".into()
            })
        );
        assert!(refreshed.subagent_tools().get("mcp__host__echo").is_some());
        let mut disabled = settings.clone();
        disabled.tools.disabled.push("mcp__host__*".into());
        let restricted = refreshed
            .clone()
            .with_host_plugin_runtime(
                disabled,
                ToolRegistry::new().register(FileReadTool),
                Default::default(),
            )
            .unwrap();
        assert!(restricted.tools.get("mcp__host__echo").is_none());
        let none = refreshed
            .clone()
            .with_host_plugin_runtime(settings, ToolRegistry::new(), Default::default())
            .unwrap();
        assert!(none.tools.names().is_empty());
        assert!(!token.is_cancelled());
        engine.prepare_session_replacement();
        assert!(token.is_cancelled());
    }

    #[tokio::test]
    async fn dropping_the_last_session_owner_revokes_retained_tool_handles() {
        let root = tempfile::tempdir().unwrap();
        let token = CancellationToken::new();
        let engine = TestEngineBuilder::new(root.path())
            .tool_registry(ToolRegistry::new().register(FileReadTool))
            .build_with_profile_directory()
            .with_session_tools(ToolRegistry::new().register(External), token.clone())
            .unwrap();
        let retained = engine.tools.clone();
        let peer = engine.clone();
        drop(engine);
        assert!(!token.is_cancelled());
        drop(peer);
        assert!(token.is_cancelled());
        assert!(retained.get("mcp__host__echo").is_some());
    }
}
