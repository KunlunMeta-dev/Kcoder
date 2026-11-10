//! Static selection eligibility is independent from desktop authorization/readiness.
use kcoder_app_protocol::SelectableStudioTool;
use kcoder_config::Settings;
use kcoder_tools::ToolRegistry;
use kcoder_types::StudioWorkMode;

pub(super) fn candidates(settings: &Settings, windows: bool) -> Vec<SelectableStudioTool> {
    if !windows || !kcoder_plugins::computer_use_policy_allows(&settings.plugins) {
        return Vec::new();
    }
    kcoder_mcp::desktop_tool::desktop_tool_candidates()
        .into_iter()
        .map(|candidate| {
            let disabled =
                ToolRegistry::name_is_disabled(&candidate.name, &settings.tools.disabled);
            let available = settings.model_capabilities.tools && !disabled;
            SelectableStudioTool {
                name: candidate.name,
                ui: candidate.ui,
                supported_modes: vec![StudioWorkMode::Kcoder, StudioWorkMode::Kworker],
                available,
                unavailable_reason: if !settings.model_capabilities.tools {
                    Some("model_tools_disabled".into())
                } else if disabled {
                    Some("disabled_by_configuration".into())
                } else {
                    None
                },
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn static_desktop_candidates_respect_platform_plugin_and_existing_disabled_patterns() {
        let mut settings = Settings::default();
        assert!(candidates(&settings, false).is_empty());
        let entries = candidates(&settings, true);
        assert_eq!(entries.len(), kcoder_computer_use::policy::TOOLS.len());
        assert!(entries.iter().all(|entry| entry.available));
        let one = entries[0].name.clone();
        settings.tools.disabled = vec![one.clone()];
        assert!(
            !candidates(&settings, true)
                .iter()
                .find(|entry| entry.name == one)
                .unwrap()
                .available
        );
        settings.tools.disabled = vec!["mcp__kcoder_computer_use__*".into()];
        assert!(
            candidates(&settings, true)
                .iter()
                .all(|entry| !entry.available)
        );
        settings.plugins.runtime.enabled = false;
        assert!(candidates(&settings, true).is_empty());
    }
    #[test]
    fn static_desktop_model_capability_is_not_a_permission_or_grant() {
        let mut settings = Settings::default();
        settings.model_capabilities.tools = false;
        assert!(
            candidates(&settings, true)
                .iter()
                .all(|entry| !entry.available
                    && entry.unavailable_reason.as_deref() == Some("model_tools_disabled"))
        );
    }
}

#[cfg(test)]
mod selection_tests {
    use super::*;
    use std::collections::HashSet;
    #[test]
    fn first_ordinary_toggle_preserves_late_desktop_candidates_but_explicit_off_stays_off() {
        let mut settings = Settings::default();
        let mut entries = candidates(&settings, true);
        let native = entries
            .iter()
            .map(|entry| entry.name.clone())
            .collect::<HashSet<_>>();
        entries.push(SelectableStudioTool {
            name: "read".into(),
            ui: kcoder_types::tool_ui::ToolUiMetadata::fallback("read"),
            available: true,
            supported_modes: vec![StudioWorkMode::Kcoder, StudioWorkMode::Kworker],
            unavailable_reason: None,
        });
        for name in ["tool_search", "tool_execute"] {
            entries.push(SelectableStudioTool {
                name: name.into(),
                ui: kcoder_types::tool_ui::ToolUiMetadata::fallback(name),
                available: true,
                supported_modes: vec![StudioWorkMode::Kworker],
                unavailable_reason: None,
            });
        }
        let registry = ToolRegistry::new();
        for mode in [StudioWorkMode::Kcoder, StudioWorkMode::Kworker] {
            let names =
                super::super::default_allowed_tools(&settings, mode, &entries, &registry, &native);
            assert!(native.iter().all(|name| names.contains(name)));
            // An ordinary switch edit must not erase the late-bound capability ceiling.
            let mut saved = names
                .into_iter()
                .filter(|name| name != "read")
                .collect::<Vec<_>>();
            let screenshot = kcoder_mcp::desktop_tool::desktop_tool_model_name("Screenshot");
            saved.retain(|name| name != &screenshot);
            match mode {
                StudioWorkMode::Kcoder => settings.tools.studio.kcoder = Some(saved.clone()),
                StudioWorkMode::Kworker => settings.tools.studio.kworker = Some(saved.clone()),
            }
            assert_eq!(
                super::super::default_allowed_tools(&settings, mode, &entries, &registry, &native),
                saved
            );
            assert!(!saved.contains(&screenshot));
            match mode {
                StudioWorkMode::Kcoder => settings.tools.studio.kcoder = Some(vec![]),
                StudioWorkMode::Kworker => settings.tools.studio.kworker = Some(vec![]),
            }
            assert!(
                super::super::default_allowed_tools(&settings, mode, &entries, &registry, &native)
                    .is_empty()
            );
        }
    }
    #[test]
    fn global_disabled_desktop_is_not_seeded_into_a_new_selection() {
        let mut settings = Settings::default();
        settings.tools.disabled = vec!["mcp__kcoder_computer_use__*".into()];
        let entries = candidates(&settings, true);
        let native = entries
            .iter()
            .map(|entry| entry.name.clone())
            .collect::<HashSet<_>>();
        for mode in [StudioWorkMode::Kcoder, StudioWorkMode::Kworker] {
            assert!(
                super::super::default_allowed_tools(
                    &settings,
                    mode,
                    &entries,
                    &ToolRegistry::new(),
                    &native
                )
                .is_empty()
            );
        }
    }
}

#[cfg(test)]
mod discovery_tests {
    use super::*;
    #[test]
    fn worker_without_discovery_preserves_only_native_names_already_in_its_luna_policy() {
        let mut settings = Settings::default();
        let entries = candidates(&settings, true);
        let native = entries.iter().map(|entry| entry.name.clone()).collect();
        assert!(
            super::super::default_allowed_tools(
                &settings,
                StudioWorkMode::Kworker,
                &entries,
                &ToolRegistry::new(),
                &native
            )
            .is_empty()
        );
        let chosen = kcoder_mcp::desktop_tool::desktop_tool_model_name("Snapshot");
        settings.tools.luna.allowed.push(chosen.clone());
        assert_eq!(
            super::super::default_allowed_tools(
                &settings,
                StudioWorkMode::Kworker,
                &entries,
                &ToolRegistry::new(),
                &native
            ),
            vec![chosen]
        );
    }
}
