//! Bind a host reader to the actual Engine producing each ToolContext.
use crate::QueryEngine;
use kcoder_tools::{ToolRegistry, ToolSource, wiki::NativeWikiReadAccess};
use std::sync::Arc;

pub trait NativeWikiReadFactory: Send + Sync {
    /// Availability from the original host profile; execution still requires its live reader.
    fn current_knowledge_settings(&self) -> Option<kcoder_config::KnowledgeSettings> {
        None
    }
    fn bind(&self, actual: &QueryEngine) -> Arc<dyn NativeWikiReadAccess>;
}

fn inherit_reader(mut base: ToolRegistry, host: &ToolRegistry, enabled: bool) -> ToolRegistry {
    if !enabled || base.get("Wiki").is_some() {
        return base;
    }
    let Some(reader) = host.get("Wiki") else {
        return base;
    };
    if host.source("Wiki") != Some(&ToolSource::Builtin)
        || reader.as_ref().type_id() != std::any::TypeId::of::<kcoder_tools::wiki::WikiTool>()
    {
        return base;
    }
    // This is the exact registered host object, not a capability from settings.
    base.try_register(reader)
        .expect("missing Wiki name was checked");
    base
}
impl QueryEngine {
    pub(crate) fn inherit_registered_native_wiki_reader(&self, base: ToolRegistry) -> ToolRegistry {
        if self.subagent_tools_explicit || self.native_wiki_read_factory.is_none() {
            return base;
        }
        let host = self.active_tool_registry_for_mode(false);
        inherit_reader(base, &host, true)
    }

    pub fn with_native_wiki_read_factory(
        mut self,
        factory: Arc<dyn NativeWikiReadFactory>,
    ) -> Self {
        if self.native_wiki_read_factory.is_none() {
            self.native_wiki_read_factory = Some(factory);
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_child_inherits_only_actual_registered_host_reader_and_explicit_registry_stays_literal()
     {
        let host = ToolRegistry::new()
            .register(kcoder_tools::wiki::WikiTool)
            .register(kcoder_tools::wiki_manage::WikiManageTool);
        let inherited = inherit_reader(ToolRegistry::new(), &host, true);
        assert!(inherited.get("Wiki").is_some());
        assert!(inherited.get("WikiManage").is_none());
        assert!(
            inherit_reader(ToolRegistry::new(), &host, false)
                .names()
                .is_empty()
        );
        assert!(
            inherit_reader(ToolRegistry::new(), &ToolRegistry::new(), true)
                .names()
                .is_empty()
        );
        let removed = host.filtered_out_by_patterns(&["Wiki".into()]);
        assert!(
            inherit_reader(ToolRegistry::new(), &removed, true)
                .names()
                .is_empty()
        );
    }
}

#[cfg(test)]
mod engine_construction_tests {
    use super::*;
    use kcoder_state::SessionMode;
    use kcoder_tools::{ToolContext, ToolError, ToolOutput};
    struct Reader;
    impl NativeWikiReadAccess for Reader {
        fn read(&self, _: serde_json::Value, _: &ToolContext) -> Result<ToolOutput, ToolError> {
            Err(ToolError::Execution(
                "No actual resource authority in registry-only test".into(),
            ))
        }
    }
    struct Factory;
    impl NativeWikiReadFactory for Factory {
        fn current_knowledge_settings(&self) -> Option<kcoder_config::KnowledgeSettings> {
            Some(kcoder_config::KnowledgeSettings {
                enabled: true,
                ..Default::default()
            })
        }
        fn bind(&self, _: &QueryEngine) -> Arc<dyn NativeWikiReadAccess> {
            Arc::new(Reader)
        }
    }
    fn engine(root: &std::path::Path, native: bool, mode: SessionMode) -> QueryEngine {
        let path = root.join("settings.json");
        std::fs::write(&path,r#"{"knowledge":{"enabled":true,"retrieval_enabled":true,"organization_enabled":false}}"#).unwrap();
        let engine = crate::test_support::engine_builder::TestEngineBuilder::new(root)
            .tool_registry(ToolRegistry::new())
            .build_with_profile_directory()
            .with_settings_persistence_path(path)
            .with_turn_tools(
                ToolRegistry::new()
                    .register(kcoder_tools::wiki::WikiTool)
                    .register(kcoder_tools::wiki_manage::WikiManageTool),
            );
        if !mode.is_default() {
            engine
                .state
                .enter_session_mode_before_first_message(mode)
                .unwrap();
        }
        if native {
            engine.with_native_wiki_read_factory(Arc::new(Factory))
        } else {
            engine
        }
    }

    #[test]
    fn rebuilt_child_keeps_original_reader_without_inheriting_settings_write_target() {
        let root = tempfile::tempdir().unwrap();
        let parent = engine(root.path(), true, SessionMode::Default);
        let tools = parent.active_subagent_tools_for_mode(false);
        assert!(tools.get("Wiki").is_some());
        let child_root = tempfile::tempdir().unwrap();
        let child = crate::test_support::engine_builder::TestEngineBuilder::new(child_root.path())
            .tool_registry(tools)
            .build_with_profile_directory();
        // This test builder adds a writable test profile; the production child
        // constructor starts with no settings persistence target.
        *crate::recover_write_lock(
            &child.settings_persistence_target,
            "settings_persistence_target",
        ) = crate::SettingsPersistenceTarget::Disabled;
        let child = child.with_inherited_native_tool_ceiling(&parent);
        assert!(child.settings_persistence_path().is_none());
        assert!(child.active_tool_registry().get("Wiki").is_some());
        let disabled = child.with_native_tool_ceiling(&[]).unwrap();
        assert!(disabled.active_tool_registry().get("Wiki").is_none());
    }
    #[test]
    fn actual_engine_child_inheritance_honors_every_literal_host_and_native_boundary() {
        for mode in [SessionMode::Default, SessionMode::Orchestrate] {
            for arrangement in [false, true] {
                let root = tempfile::tempdir().unwrap();
                let default = engine(root.path(), true, mode);
                let inherited = default.active_subagent_tools_for_mode(arrangement);
                assert!(inherited.get("Wiki").is_some());
                assert!(inherited.get("WikiManage").is_none());
                let root = tempfile::tempdir().unwrap();
                let empty =
                    engine(root.path(), true, mode).with_subagent_tools(ToolRegistry::new());
                assert!(
                    empty
                        .active_subagent_tools_for_mode(arrangement)
                        .names()
                        .is_empty()
                );
                let root = tempfile::tempdir().unwrap();
                let restricted = engine(root.path(), true, mode)
                    .with_subagent_tools(ToolRegistry::new().register(kcoder_tools::TodoWriteTool));
                assert_eq!(
                    restricted
                        .active_subagent_tools_for_mode(arrangement)
                        .names(),
                    vec!["TodoWrite".to_string()]
                );
                let root = tempfile::tempdir().unwrap();
                let no_factory = engine(root.path(), false, mode);
                assert!(
                    no_factory
                        .active_subagent_tools_for_mode(arrangement)
                        .get("Wiki")
                        .is_none()
                );
                let root = tempfile::tempdir().unwrap();
                let removed = engine(root.path(), true, mode).with_turn_tools(ToolRegistry::new());
                assert!(
                    removed
                        .active_subagent_tools_for_mode(arrangement)
                        .get("Wiki")
                        .is_none()
                );
                let root = tempfile::tempdir().unwrap();
                let ceiling = engine(root.path(), true, mode)
                    .with_native_tool_ceiling(&[])
                    .unwrap();
                assert!(
                    ceiling
                        .active_subagent_tools_for_mode(arrangement)
                        .names()
                        .is_empty()
                );
            }
        }
    }
}
