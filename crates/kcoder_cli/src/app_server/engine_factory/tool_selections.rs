//! Available model-tool metadata and defaults; enumeration starts no new runtime or tool.
use super::*;
use kcoder_app_protocol::{
    SelectableStudioTool, StudioModeToolSelection, ToolSelectionsResult, ToolSelectionsSaveParams,
};
use kcoder_tools::ToolSource;
use kcoder_types::StudioWorkMode;
#[path = "tool_selections/desktop.rs"]
mod desktop;
#[path = "tool_selections/resolution.rs"]
mod resolution;

impl AppServerEngineFactory {
    pub fn inherit_studio_tool_selection(&mut self, source: &QueryEngine) {
        // Forks inherit the source binding, not defaults reloaded after its creation.
        let selection = source.state.studio_tool_selection();
        self.bind_new_tool_selection = selection.is_some();
        self.base_settings.tools.studio = selection.unwrap_or_default();
    }

    pub fn studio_tool_selections(
        &self,
        save: Option<ToolSelectionsSaveParams>,
    ) -> Result<ToolSelectionsResult> {
        self.tool_selections(save, None)
    }

    pub fn read_studio_tool_selections(
        &self,
        params: &kcoder_app_protocol::ToolSelectionsReadParams,
    ) -> Result<ToolSelectionsResult> {
        let mut result = self.tool_selections(None, Some(params))?;
        if params.include_luna_baseline != Some(true) {
            result.luna_allowed_tools = None;
        }
        Ok(result)
    }

    fn tool_selections(
        &self,
        save: Option<ToolSelectionsSaveParams>,
        preview: Option<&kcoder_app_protocol::ToolSelectionsReadParams>,
    ) -> Result<ToolSelectionsResult> {
        let config = self
            .configuration
            .as_ref()
            .context("TOOL_SELECTION_UNAVAILABLE")?;
        let (loaded, profile, revision) = config.studio_tool_selection_loaded()?;
        let settings = &loaded.settings;
        let mut registry = crate::builtin_tools_for_profile(profile, settings);
        if profile != kcoder_config::ToolProfile::None {
            for tool in self.tools.all() {
                if tool.is_model_visible()
                    && !matches!(tool.source(), ToolSource::Builtin)
                    && registry.get(&tool.name()).is_none()
                {
                    registry = registry.register_arc(tool);
                }
            }
        }
        if matches!(
            profile,
            kcoder_config::ToolProfile::Full | kcoder_config::ToolProfile::Core
        ) {
            registry = registry
                .register(kcoder_tools::ShowWidgetTool::preview())
                .register(kcoder_tools::tool_search::ToolSearchTool)
                .register(kcoder_tools::tool_execute::ToolExecuteTool);
        }
        let allowed_by_config = registry.filtered_out_by_patterns(&settings.tools.disabled);
        let special = ["show_widget", "tool_search", "tool_execute"];
        let mut entries = registry
            .all()
            .into_iter()
            .filter(|tool| tool.is_model_visible())
            .map(|tool| {
                let name = tool.name();
                let file_surface = match name.as_str() {
                    "edit" => settings.tools.file_edit_tool == kcoder_config::FileEditSurface::Edit,
                    "apply_patch" => {
                        settings.tools.file_edit_tool == kcoder_config::FileEditSurface::ApplyPatch
                    }
                    _ => true,
                };
                let available = settings.model_capabilities.tools
                    && allowed_by_config.get(&name).is_some()
                    && file_surface;
                SelectableStudioTool {
                    supported_modes: if special.contains(&name.as_str()) {
                        vec![StudioWorkMode::Kworker]
                    } else {
                        vec![StudioWorkMode::Kcoder, StudioWorkMode::Kworker]
                    },
                    name: name.clone(),
                    ui: tool.ui_metadata(),
                    available,
                    unavailable_reason: if !settings.model_capabilities.tools {
                        Some("model_tools_disabled".into())
                    } else if !file_surface {
                        Some("inactive_edit_surface".into())
                    } else if !available {
                        Some("disabled_by_configuration".into())
                    } else {
                        None
                    },
                }
            })
            .collect::<Vec<_>>();
        let native_desktop = desktop::candidates(settings, cfg!(windows));
        let native_desktop_names = native_desktop
            .iter()
            .map(|entry| entry.name.clone())
            .collect::<std::collections::HashSet<_>>();
        for entry in native_desktop {
            if !entries.iter().any(|existing| existing.name == entry.name) {
                entries.push(entry);
            }
        }
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        let mut modes = Vec::new();
        for mode in [StudioWorkMode::Kcoder, StudioWorkMode::Kworker] {
            let names =
                default_allowed_tools(settings, mode, &entries, &registry, &native_desktop_names);
            modes.push(StudioModeToolSelection {
                mode,
                editable: super::super::session_configuration::tool_selection_editable(
                    &loaded, mode,
                ),
                allowed_tools: names,
            });
        }
        if let Some(save) = save {
            let previous = modes
                .iter()
                .find(|mode| mode.mode == save.mode)
                .context("TOOL_SELECTION_MODE_INVALID")?;
            for name in &save.allowed_tools {
                anyhow::ensure!(
                    previous.allowed_tools.contains(name)
                        || entries.iter().any(|entry| entry.name == *name
                            && entry.available
                            && entry.supported_modes.contains(&save.mode)),
                    "TOOL_SELECTION_UNKNOWN_OR_UNAVAILABLE"
                );
            }
            config.save_studio_tool_selection(&save)?;
            return self.studio_tool_selections(None);
        }
        let bounded = kcoder_types::tool_ui::bounded_tool_catalog(
            entries
                .iter()
                .map(|entry| kcoder_types::tool_ui::ToolCatalogEntry {
                    name: entry.name.clone(),
                    ui: entry.ui.clone(),
                })
                .collect(),
        );
        let total = entries.len();
        entries.retain(|entry| bounded.tools.iter().any(|kept| kept.name == entry.name));
        anyhow::ensure!(
            modes.iter().all(|mode| mode.allowed_tools.len() <= 1024)
                && settings.tools.luna.allowed.len() <= 1024,
            "TOOL_SELECTION_TOO_LARGE"
        );
        let resolution = preview
            .filter(|request| request.include_resolution == Some(true))
            .map(|request| {
                resolution::resolve(settings, request.preview_expert.as_ref(), &modes, &entries)
            })
            .transpose()?;
        Ok(ToolSelectionsResult {
            revision,
            modes,
            luna_allowed_tools: Some(settings.tools.luna.allowed.clone()),
            resolution,
            expert_tools_independent: preview
                .filter(|request| request.include_expert_tool_selection == Some(true))
                .map(|_| true),
            tools: entries,
            total,
            truncated: bounded.truncated,
        })
    }
}

/// Resolve defaults before the first edit; existing explicit selections remain authoritative.
fn default_allowed_tools(
    settings: &kcoder_config::Settings,
    mode: StudioWorkMode,
    entries: &[SelectableStudioTool],
    registry: &kcoder_tools::ToolRegistry,
    native_desktop_names: &std::collections::HashSet<String>,
) -> Vec<String> {
    let configured = match mode {
        StudioWorkMode::Kcoder => &settings.tools.studio.kcoder,
        StudioWorkMode::Kworker => &settings.tools.studio.kworker,
    };
    configured.clone().unwrap_or_else(|| {
        let defaults = kcoder_config::kworker_default_tool_names(&settings.tools.luna.allowed);
        let discovery_available = ["tool_search", "tool_execute"].iter().all(|name| {
            entries.iter().any(|entry| {
                entry.name == *name
                    && entry.available
                    && entry.supported_modes.contains(&StudioWorkMode::Kworker)
            })
        });
        entries
            .iter()
            .filter(|entry| {
                entry.available
                    && entry.supported_modes.contains(&mode)
                    && (mode == StudioWorkMode::Kcoder
                    || defaults.contains(&entry.name)
                    // Preserve the native tools eligible for authorized deferred discovery.
                    || (discovery_available && native_desktop_names.contains(&entry.name))
                    || registry.get(&entry.name).is_some_and(|tool| {
                        !matches!(tool.source(), ToolSource::Builtin)
                    }))
            })
            .map(|entry| entry.name.clone())
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_tools::DenyAllUserQuestioner;

    fn fixture(root: &std::path::Path) -> AppServerEngineFactory {
        for directory in ["project", "home"] {
            std::fs::create_dir_all(root.join(directory)).unwrap();
        }
        let settings = root.join("home/settings.json");
        std::fs::write(
            &settings,
            r#"{"tools":{"studio":{"kcoder":["read"],"kworker":[]}},"history_enabled":false}"#,
        )
        .unwrap();
        let mut factory = super::super::tests::configured_factory(
            &root.join("project"),
            &root.join("home"),
            &settings,
            None,
        );
        factory.base_settings = factory.current_settings().unwrap();
        factory
    }
    fn save(factory: &AppServerEngineFactory, names: Vec<String>) -> Result<ToolSelectionsResult> {
        let before = factory.studio_tool_selections(None)?;
        factory.studio_tool_selections(Some(ToolSelectionsSaveParams {
            mode: StudioWorkMode::Kcoder,
            allowed_tools: names,
            expected_revision: before.revision,
        }))
    }
    #[test]
    fn tool_selections_report_exact_luna_baseline_separately_from_studio_defaults() {
        let root = tempfile::tempdir().unwrap();
        let factory = fixture(root.path());
        for names in [vec!["bash", "UnlistedTool"], vec![]] {
            kcoder_config::update_settings_file(
                &root.path().join("home/settings.json"),
                |document| {
                    document["tools"]["luna"]["allowed"] = serde_json::json!(names);
                    Ok(())
                },
            )
            .unwrap();
            let result = factory.studio_tool_selections(None).unwrap();
            assert_eq!(
                result.luna_allowed_tools,
                Some(names.into_iter().map(String::from).collect())
            );
            assert_eq!(result.modes[0].allowed_tools, vec!["read"]);
            assert!(!root.path().join("project/history").exists());
        }
    }

    #[test]
    fn tool_selections_catalog_and_save_do_not_create_sessions_or_mutate_resident_snapshots() {
        let root = tempfile::tempdir().unwrap();
        let factory = fixture(root.path());
        let first = factory
            .create_new_thread(Arc::new(DenyAllUserQuestioner))
            .unwrap();
        let original = first.state.studio_tool_selection().unwrap();
        let catalog = factory.studio_tool_selections(None).unwrap();
        assert!(catalog.tools.iter().any(|tool| tool.name == "read"));
        assert_eq!(original.kcoder, Some(vec!["read".into()]));
        assert_eq!(original.kworker, Some(vec![]));
        assert!(!root.path().join("project/history").exists());
        let after = save(&factory, vec!["write".into()]).unwrap();
        assert_ne!(after.revision, catalog.revision);
        assert_eq!(first.state.studio_tool_selection(), Some(original.clone()));
        assert_eq!(first.settings.read().unwrap().tools.studio, original);
        let mut fresh = factory.clone();
        fresh.base_settings = fresh.current_settings().unwrap();
        let second = fresh
            .create_new_thread(Arc::new(DenyAllUserQuestioner))
            .unwrap();
        assert_eq!(
            second.state.studio_tool_selection().unwrap().kcoder,
            Some(vec!["write".into()])
        );
        assert_eq!(
            second.state.studio_tool_selection().unwrap().kworker,
            Some(vec![])
        );
    }
    #[test]
    fn tool_selections_cold_resume_retains_original_selection_and_legacy_stays_unbound() {
        let root = tempfile::tempdir().unwrap();
        let factory = fixture(root.path());
        let source = factory
            .create_new_thread(Arc::new(DenyAllUserQuestioner))
            .unwrap();
        let history = root.path().join(format!("{}.jsonl", source.session_id()));
        source.state.with_history_path(&history);
        source.state.add_message(kcoder_types::Message::user_text(
            "saved before settings changed",
        ));
        source.state.save_history().unwrap();
        save(&factory, vec!["write".into()]).unwrap();
        let mut fresh = factory.clone();
        fresh.base_settings = fresh.current_settings().unwrap();
        let (restored, _) = fresh
            .resume_thread(
                kcoder_state::prepare_session_resume(&history).unwrap(),
                Arc::new(DenyAllUserQuestioner),
            )
            .unwrap();
        assert_eq!(
            restored.state.studio_tool_selection(),
            source.state.studio_tool_selection()
        );
        assert_eq!(
            restored.settings.read().unwrap().tools.studio.kcoder,
            Some(vec!["read".into()])
        );
        let legacy_path = root.path().join("legacy.jsonl");
        let legacy = AppState::new(root.path());
        legacy.with_history_path(&legacy_path);
        legacy.add_message(kcoder_types::Message::user_text("legacy session"));
        legacy.save_history().unwrap();
        let (restored, _) = fresh
            .resume_thread(
                kcoder_state::prepare_session_resume(&legacy_path).unwrap(),
                Arc::new(DenyAllUserQuestioner),
            )
            .unwrap();
        assert!(restored.state.studio_tool_selection().is_none());
        assert_eq!(
            restored.settings.read().unwrap().tools.studio,
            Default::default()
        );
    }
    #[test]
    fn tool_selections_fork_inherits_bound_snapshot_and_does_not_upgrade_legacy_sources() {
        let root = tempfile::tempdir().unwrap();
        let factory = fixture(root.path());
        let source = factory
            .create_new_thread(Arc::new(DenyAllUserQuestioner))
            .unwrap();
        let bound = source.state.studio_tool_selection().unwrap();
        source.settings.write().unwrap().tools.studio.kcoder = Some(vec!["write".into()]);
        let fork = factory
            .create_ephemeral_thread(&source, vec![], Arc::new(DenyAllUserQuestioner))
            .unwrap();
        assert_eq!(fork.state.studio_tool_selection(), Some(bound.clone()));
        assert_eq!(fork.settings.read().unwrap().tools.studio, bound);
        let mut legacy_factory = factory.clone();
        legacy_factory.bind_new_tool_selection = false;
        legacy_factory.base_settings.tools.studio = Default::default();
        let legacy = legacy_factory
            .create_new_thread(Arc::new(DenyAllUserQuestioner))
            .unwrap();
        legacy.settings.write().unwrap().tools.studio.kcoder = Some(vec!["write".into()]);
        let fork = factory
            .create_ephemeral_thread(&legacy, vec![], Arc::new(DenyAllUserQuestioner))
            .unwrap();
        assert!(fork.state.studio_tool_selection().is_none());
        assert_eq!(
            fork.settings.read().unwrap().tools.studio,
            Default::default()
        );
    }

    #[test]
    fn tool_selections_catalog_reports_disabled_tools_and_rejects_new_unavailable_names() {
        let root = tempfile::tempdir().unwrap();
        let factory = fixture(root.path());
        kcoder_config::update_settings_file(&root.path().join("home/settings.json"), |document| {
            document["tools"]["disabled"] = serde_json::json!(["write"]);
            Ok(())
        })
        .unwrap();
        let before = factory.studio_tool_selections(None).unwrap();
        let write = before
            .tools
            .iter()
            .find(|tool| tool.name == "write")
            .unwrap();
        assert!(!write.available);
        assert_eq!(
            write.unavailable_reason.as_deref(),
            Some("disabled_by_configuration")
        );
        assert!(save(&factory, vec!["write".into()]).is_err());
        assert!(save(&factory, vec!["not_registered".into()]).is_err());
        assert_eq!(
            factory.studio_tool_selections(None).unwrap().revision,
            before.revision
        );
    }
}
