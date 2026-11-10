//! Ordinary task selections apply only when no independent expert selection is installed.
use super::*;
use kcoder_types::StudioWorkMode;
impl QueryEngine {
    pub(super) fn studio_selected_tools(&self) -> Option<Vec<String>> {
        if self.agent_uses_own_tool_selection
            || self.is_arrangement_mode_active()
            || self.client_presentation.is_none()
            || self.state.session_mode() != kcoder_state::SessionMode::Default
            || self.subagent_system_prompt.is_some()
        {
            return None;
        }
        match self.effective_studio_work_mode() {
            StudioWorkMode::Kcoder => self.studio_tool_selection.kcoder.clone(),
            StudioWorkMode::Kworker => self.studio_tool_selection.kworker.clone(),
        }
    }
    pub(super) fn filter_task_tool_selection(&self, registry: ToolRegistry) -> ToolRegistry {
        let registry = match self.studio_selected_tools() {
            Some(allowed) => registry.filtered_to_names(&allowed),
            None => registry,
        };
        let settings = recover_read_lock(&self.settings, "settings");
        registry.filtered_out_by_patterns(&settings.tools.disabled)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::engine_builder::TestEngineBuilder;
    use kcoder_tools::{Tool, ToolContext, ToolError, ToolOutput, ToolSource};
    use kcoder_types::{ClientPresentationV1, StudioToolSelections};

    struct Probe(&'static str, bool);
    #[async_trait::async_trait]
    impl Tool for Probe {
        fn name(&self) -> String {
            self.0.into()
        }
        fn description(&self) -> String {
            "Deterministic selection boundary probe".into()
        }
        fn input_schema(&self) -> Value {
            serde_json::json!({"type":"object"})
        }
        fn source(&self) -> ToolSource {
            if self.1 {
                ToolSource::Mcp {
                    server: "fixture".into(),
                    tool: self.0.into(),
                }
            } else {
                ToolSource::Builtin
            }
        }
        async fn call(
            &self,
            _: Value,
            _: &ToolContext,
        ) -> std::result::Result<ToolOutput, ToolError> {
            Ok(ToolOutput::text("ok"))
        }
    }
    fn registry() -> ToolRegistry {
        ToolRegistry::new()
            .register(Probe("read", false))
            .register(Probe("write", false))
            .register(Probe("mcp_fixture_hidden", true))
    }
    fn selections() -> StudioToolSelections {
        StudioToolSelections {
            kcoder: Some(vec!["write".into()]),
            kworker: Some(vec![
                "read".into(),
                "tool_search".into(),
                "tool_execute".into(),
            ]),
        }
    }
    fn presentation(mode: StudioWorkMode) -> Option<ClientPresentationV1> {
        Some(ClientPresentationV1 {
            version: 1,
            studio_work_mode: Some(mode),
            inline_widgets: false,
            isolated_widgets: false,
        })
    }
    fn engine(root: &std::path::Path) -> QueryEngine {
        let mut settings = Settings::default();
        settings.tools.studio = selections();
        TestEngineBuilder::new(root)
            .settings(settings)
            .tool_registry(registry())
            .build_with_profile_directory()
    }
    #[tokio::test]
    async fn studio_tool_selection_modes_shrink_model_catalog_without_affecting_cli() {
        let root = tempfile::tempdir().unwrap();
        let cli = engine(root.path());
        for name in ["read", "write", "mcp_fixture_hidden"] {
            assert!(cli.active_tool_registry().get(name).is_some());
        }
        let coding = cli
            .clone()
            .with_client_presentation(presentation(StudioWorkMode::Kcoder));
        let worker = cli
            .clone()
            .with_client_presentation(presentation(StudioWorkMode::Kworker));
        assert_eq!(coding.active_tool_registry().names(), vec!["write"]);
        assert!(worker.active_tool_registry().get("read").is_some());
        assert!(worker.active_tool_registry().get("write").is_none());
        assert!(
            worker
                .active_tool_registry()
                .get("mcp_fixture_hidden")
                .is_none()
        );
        assert_eq!(
            coding
                .effective_tool_catalog()
                .await
                .into_iter()
                .map(|tool| tool.name)
                .collect::<Vec<_>>(),
            vec!["write"]
        );
        assert!(cli.active_tool_registry().get("read").is_some());
    }
    #[test]
    fn studio_tool_selection_empty_is_deny_all_but_specialized_sessions_keep_their_policy() {
        let root = tempfile::tempdir().unwrap();
        let mut coding =
            engine(root.path()).with_client_presentation(presentation(StudioWorkMode::Kcoder));
        coding.studio_tool_selection.kcoder = Some(vec![]);
        assert!(coding.active_tool_registry().names().is_empty());
        let child = coding
            .clone()
            .with_subagent_system_prompt(Some("Isolated child".into()));
        assert!(child.studio_selected_tools().is_none());
        assert!(child.active_tool_registry().get("read").is_some());
        let specialized = coding.clone().with_arrangement_mode(true);
        assert!(specialized.studio_selected_tools().is_none());
        assert!(!specialized.active_tool_registry().names().is_empty());
        coding
            .state
            .enter_orchestrate_before_first_message()
            .unwrap();
        assert!(coding.studio_selected_tools().is_none());
    }
    #[tokio::test]
    async fn studio_tool_selection_global_denials_and_deferred_discovery_cannot_restore_omitted_tools()
     {
        let root = tempfile::tempdir().unwrap();
        let mut coding =
            engine(root.path()).with_client_presentation(presentation(StudioWorkMode::Kcoder));
        coding.settings.write().unwrap().tools.disabled = vec!["write".into()];
        assert!(coding.active_tool_registry().get("write").is_none());
        assert!(coding.effective_tool_catalog().await.is_empty());
        coding.studio_tool_selection.kcoder = Some(vec!["absent".into()]);
        assert!(coding.active_tool_registry().names().is_empty());
        let worker =
            engine(root.path()).with_client_presentation(presentation(StudioWorkMode::Kworker));
        assert!(worker.active_tool_registry().get("tool_search").is_some());
        assert!(
            worker
                .deferred_tools_snapshot()
                .tools
                .get("mcp_fixture_hidden")
                .is_none()
        );
        assert!(
            worker
                .searchable_tools()
                .get("mcp_fixture_hidden")
                .is_none()
        );
        let no_discovery = worker.with_turn_tools(registry());
        let mut no_discovery = no_discovery;
        no_discovery.studio_tool_selection.kworker = Some(vec!["read".into()]);
        assert!(
            no_discovery
                .active_tool_registry()
                .get("tool_search")
                .is_none()
        );
        assert!(
            no_discovery
                .deferred_tools_snapshot()
                .tools
                .names()
                .is_empty()
        );
    }
    #[test]
    fn studio_tool_selection_constructor_snapshot_survives_host_settings_refresh() {
        let root = tempfile::tempdir().unwrap();
        let old =
            engine(root.path()).with_client_presentation(presentation(StudioWorkMode::Kcoder));
        let mut refreshed = Settings::default();
        refreshed.tools.studio.kcoder = Some(vec!["read".into()]);
        let old = old
            .with_host_plugin_runtime(
                refreshed.clone(),
                registry(),
                kcoder_plugins::EffectivePluginSnapshot::default(),
            )
            .unwrap();
        assert_eq!(old.active_tool_registry().names(), vec!["write"]);
        let new = TestEngineBuilder::new(root.path())
            .settings(refreshed)
            .tool_registry(registry())
            .build_with_profile_directory()
            .with_client_presentation(presentation(StudioWorkMode::Kcoder));
        assert_eq!(new.active_tool_registry().names(), vec!["read"]);
    }
}
