//! Register only a real host's independent-session discovery, preserving role and tool filters.
use super::*;

impl QueryEngine {
    /// Session kind only; the host still verifies current access and ownership.
    pub fn is_independent_discovery_session(&self) -> bool {
        self.agent_depth() == 0
            && self.subagent_system_prompt.is_none()
            && !self.is_arrangement_mode_active()
            && self.state.session_mode() == kcoder_state::SessionMode::Default
            && !self.native_input_requires_source_admission()
    }
    /// The original app-server owns the reader. This installs no peer-message sender.
    pub fn with_session_discovery_host(
        mut self,
        host: Arc<dyn kcoder_tools::session_discovery::SessionDiscoveryHost>,
    ) -> Result<Self> {
        let discovery = kcoder_tools::session_discovery::ListSessionsTool::new(host);
        self.session_host_tools.read = discovery.read_tool();
        self.session_host_tools.discovery = Some(discovery);
        let tools = self.compose_session_host_tools(self.tools.clone())?;
        Ok(self.with_turn_tools(tools))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::engine_builder::TestEngineBuilder;
    use kcoder_tools::session_discovery::{SessionDiscoveryCall, SessionDiscoveryHost};
    struct Host;
    #[async_trait::async_trait]
    impl SessionDiscoveryHost for Host {
        async fn list(
            &self,
            _: SessionDiscoveryCall,
            _: Option<String>,
        ) -> std::result::Result<Value, ToolError> {
            Ok(serde_json::json!({"targets":[]}))
        }
    }
    #[test]
    fn host_discovery_preserves_disabled_profiles_and_delegation_boundaries() {
        let root = tempfile::tempdir().unwrap();
        for profile in [
            kcoder_config::ToolProfile::None,
            kcoder_config::ToolProfile::Nano,
        ] {
            let mut settings = Settings::default();
            settings.tools.profile = profile;
            let engine = TestEngineBuilder::new(root.path())
                .settings(settings)
                .build_with_profile_directory()
                .with_session_discovery_host(Arc::new(Host))
                .unwrap();
            assert!(engine.active_tool_registry().get("ListSessions").is_none());
        }
        let mut settings = Settings::default();
        settings.tools.disabled = vec!["ListSessions".into()];
        let engine = TestEngineBuilder::new(root.path())
            .settings(settings)
            .build_with_profile_directory()
            .with_session_discovery_host(Arc::new(Host))
            .unwrap();
        assert!(engine.active_tool_registry().get("ListSessions").is_none());
        let engine = TestEngineBuilder::new(root.path())
            .build_with_profile_directory()
            .with_agent_depth(1)
            .with_session_discovery_host(Arc::new(Host))
            .unwrap();
        assert!(engine.active_tool_registry().get("ListSessions").is_none());
    }
    #[test]
    fn a_real_host_adds_discovery_only_and_refreshes_its_schema_cache() {
        let root = tempfile::tempdir().unwrap();
        let engine = TestEngineBuilder::new(root.path()).build_with_profile_directory();
        assert!(engine.active_tool_registry().get("ListSessions").is_none());
        let engine = engine.with_session_discovery_host(Arc::new(Host)).unwrap();
        assert!(engine.active_tool_registry().get("ListSessions").is_some());
        assert!(
            engine
                .tool_definitions
                .iter()
                .any(|tool| tool.name == "ListSessions")
        );
        assert!(
            engine
                .active_tool_registry()
                .get("SendSessionMessage")
                .is_none()
        );
        let engine = engine.with_session_discovery_host(Arc::new(Host)).unwrap();
        assert_eq!(
            engine
                .tool_definitions
                .iter()
                .filter(|tool| tool.name == "ListSessions")
                .count(),
            1
        );
    }
}

#[cfg(test)]
mod refresh_tests {
    use super::*;
    use crate::test_support::engine_builder::TestEngineBuilder;
    use kcoder_tools::session_discovery::{SessionDiscoveryCall, SessionDiscoveryHost};
    struct Host;
    #[async_trait::async_trait]
    impl SessionDiscoveryHost for Host {
        async fn list(
            &self,
            _: SessionDiscoveryCall,
            _: Option<String>,
        ) -> std::result::Result<Value, ToolError> {
            Ok(serde_json::json!({"targets":[]}))
        }
    }
    #[test]
    fn host_recomposition_keeps_original_owner_and_never_restores_disabled_discovery() {
        let root = tempfile::tempdir().unwrap();
        let source = TestEngineBuilder::new(root.path())
            .build_with_profile_directory()
            .with_session_discovery_host(Arc::new(Host))
            .unwrap();
        let id = source.session_id();
        let storage = source.client_storage_root();
        for disabled in [false, true] {
            let mut settings = Settings::default();
            if disabled {
                settings.tools.disabled.push("ListSessions".into());
            }
            let refreshed = source
                .clone()
                .with_host_plugin_runtime(
                    settings,
                    ToolRegistry::new(),
                    kcoder_plugins::EffectivePluginSnapshot::default(),
                )
                .unwrap()
                .with_session_discovery_host(Arc::new(Host))
                .unwrap();
            assert_eq!(refreshed.session_id(), id);
            assert_eq!(refreshed.client_storage_root(), storage);
            assert!(refreshed.state.shares_state_with(&source.state));
            assert_eq!(
                refreshed
                    .active_tool_registry()
                    .get("ListSessions")
                    .is_some(),
                !disabled
            );
            assert!(source.active_tool_registry().get("ListSessions").is_some());
        }
    }
}

#[cfg(test)]
mod read_tests {
    use super::*;
    use crate::test_support::engine_builder::TestEngineBuilder;
    use kcoder_tools::session_discovery::{SessionDiscoveryCall, SessionDiscoveryHost};
    struct ReadHost;
    #[async_trait::async_trait]
    impl SessionDiscoveryHost for ReadHost {
        async fn list(
            &self,
            _: SessionDiscoveryCall,
            _: Option<String>,
        ) -> std::result::Result<Value, ToolError> {
            Ok(serde_json::json!({"targets":[]}))
        }
        fn supports_read(&self) -> bool {
            true
        }
    }
    #[test]
    fn read_session_follows_list_sessions_availability_and_its_own_disable() {
        let root = tempfile::tempdir().unwrap();
        let engine = TestEngineBuilder::new(root.path())
            .build_with_profile_directory()
            .with_session_discovery_host(Arc::new(ReadHost))
            .unwrap();
        let tools = engine.active_tool_registry();
        let list = tools.get("ListSessions").unwrap();
        let read = tools.get("ReadSession").unwrap();
        assert!(read.is_read_only());
        let list: &dyn std::any::Any = list.as_ref();
        let read: &dyn std::any::Any = read.as_ref();
        let list = list
            .downcast_ref::<kcoder_tools::session_discovery::ListSessionsTool>()
            .unwrap();
        let read = read
            .downcast_ref::<kcoder_tools::session_read::ReadSessionTool>()
            .unwrap();
        assert!(list.read_tool().unwrap().same_contribution(read));
        let mut settings = Settings::default();
        settings.tools.disabled = vec!["ReadSession".into()];
        let engine = TestEngineBuilder::new(root.path())
            .settings(settings)
            .build_with_profile_directory()
            .with_session_discovery_host(Arc::new(ReadHost))
            .unwrap();
        assert!(engine.active_tool_registry().get("ReadSession").is_none());
        assert!(engine.active_tool_registry().get("ListSessions").is_some());
        let engine = TestEngineBuilder::new(root.path())
            .build_with_profile_directory()
            .with_agent_depth(1)
            .with_session_discovery_host(Arc::new(ReadHost))
            .unwrap();
        assert!(engine.active_tool_registry().get("ReadSession").is_none());
        let engine = TestEngineBuilder::new(root.path())
            .build_with_profile_directory()
            .with_session_discovery_host(Arc::new(tests_host()))
            .unwrap();
        assert!(engine.active_tool_registry().get("ListSessions").is_some());
        assert!(
            engine.active_tool_registry().get("ReadSession").is_none(),
            "hosts without read verification do not expose ReadSession"
        );
    }
    struct ListOnly;
    #[async_trait::async_trait]
    impl SessionDiscoveryHost for ListOnly {
        async fn list(
            &self,
            _: SessionDiscoveryCall,
            _: Option<String>,
        ) -> std::result::Result<Value, ToolError> {
            Ok(serde_json::json!({"targets":[]}))
        }
    }
    fn tests_host() -> ListOnly {
        ListOnly
    }
}
