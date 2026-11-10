//! Pure next-session catalog projection. No resources, sessions or permissions are loaded.
use anyhow::Result;
use kcoder_app_protocol::{
    ResolvedStudioTool, SelectableStudioTool, StudioModeToolSelection, StudioToolResolution,
    ToolSelectionRestriction, ToolSelectionRestrictionSource as Source,
};
use kcoder_types::integrations::office::OfficeAssistantDefinition;

pub(super) fn resolve(
    settings: &kcoder_config::Settings,
    expert: Option<&OfficeAssistantDefinition>,
    modes: &[StudioModeToolSelection],
    tools: &[SelectableStudioTool],
) -> Result<Vec<StudioToolResolution>> {
    let selection = expert.map(|definition| {
        kcoder_engine::agent_tool_policy::task_expert_tool_selection(
            definition,
            &settings.tools.luna.allowed,
        )
    });
    let policy = expert
        .zip(selection)
        .map(|(definition, selection)| {
            kcoder_engine::agent_tool_policy::resolve_agent_tool_policy(definition, selection)
        })
        .transpose()?;
    Ok(modes
        .iter()
        .map(|mode| StudioToolResolution {
            mode: mode.mode,
            tools: tools
                .iter()
                .map(|tool| {
                    let mut restrictions = Vec::new();
                    let mut restrict = |source, skill| {
                        restrictions.push(ToolSelectionRestriction { source, skill });
                    };
                    if expert.is_none() && !mode.allowed_tools.contains(&tool.name) {
                        restrict(Source::ModeSelection, None);
                    }
                    if !tool.supported_modes.contains(&mode.mode) {
                        restrict(Source::UnsupportedMode, None);
                    }
                    if !tool.available {
                        let source = match tool.unavailable_reason.as_deref() {
                            Some("model_tools_disabled") => Source::ModelToolsDisabled,
                            Some("inactive_edit_surface") => Source::InactiveEditSurface,
                            _ => Source::DisabledByConfiguration,
                        };
                        restrict(source, None);
                    }
                    if let Some((definition, selection)) = expert.zip(selection)
                        && !selection.contains(&tool.name)
                    {
                        restrict(
                            if definition.allowed_tools.is_some() {
                                Source::ExpertSelection
                            } else {
                                Source::LunaBaseline
                            },
                            None,
                        );
                    }
                    if let Some(policy) = &policy
                        && let Some(skills) = policy.excluded_by_skills.get(&tool.name)
                    {
                        for skill in skills {
                            restrict(Source::SkillSelection, Some(skill.clone()));
                        }
                    }
                    ResolvedStudioTool {
                        name: tool.name.clone(),
                        effective: restrictions.is_empty(),
                        restrictions,
                    }
                })
                .collect(),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::{StudioWorkMode, tool_ui::ToolUiMetadata};

    fn fixture() -> (
        kcoder_config::Settings,
        Vec<StudioModeToolSelection>,
        Vec<SelectableStudioTool>,
    ) {
        let mut settings = kcoder_config::Settings::default();
        settings.tools.luna.allowed = vec!["read".into(), "write".into(), "bash".into()];
        let modes = vec![
            StudioModeToolSelection {
                mode: StudioWorkMode::Kcoder,
                editable: true,
                allowed_tools: vec!["read".into(), "write".into()],
            },
            StudioModeToolSelection {
                mode: StudioWorkMode::Kworker,
                editable: true,
                allowed_tools: vec!["bash".into()],
            },
        ];
        let tools = ["read", "write", "bash", "outside"]
            .into_iter()
            .map(|name| SelectableStudioTool {
                name: name.into(),
                ui: ToolUiMetadata::fallback(name),
                available: true,
                supported_modes: vec![StudioWorkMode::Kcoder, StudioWorkMode::Kworker],
                unavailable_reason: None,
            })
            .collect();
        (settings, modes, tools)
    }
    fn expert() -> OfficeAssistantDefinition {
        serde_json::from_value(serde_json::json!({
            "schemaVersion":1,"id":"expert","scope":"personal","title":"Expert",
            "description":"Preview","language":"en","instructions":"Instructions",
            "inputSchema":{"type":"object"},"modelSelection":{"kind":"inherit_current"},
            "outputKinds":["document"],"acceptanceCriteria":["Review"],"externalSend":"deny",
            "allowedTools":["read","write","outside"],"skills":[{
                "slug":"read-only","title":"Read only","description":"Read only","content":"---\nallowed-tools: [Read, outside]\n---\nRules","enabled":true
            }]
        })).unwrap()
    }
    #[test]
    fn custom_expert_selection_replaces_mode_defaults_and_luna_but_not_skill_or_global_limits()
    -> Result<()> {
        let (settings, modes, mut tools) = fixture();
        let mut definition = expert();
        let preview = resolve(&settings, Some(&definition), &modes, &tools)?;
        for mode in &preview {
            assert!(mode.tools[0].effective);
            assert!(!mode.tools[1].effective);
            assert_eq!(mode.tools[1].restrictions[0].source, Source::SkillSelection);
            assert_eq!(
                mode.tools[1].restrictions[0].skill.as_deref(),
                Some("read-only")
            );
            assert_eq!(
                mode.tools[2].restrictions[0].source,
                Source::ExpertSelection
            );
            assert!(mode.tools[3].effective);
        }
        definition.allowed_tools = None;
        let inherited = resolve(&settings, Some(&definition), &modes, &tools)?;
        assert!(inherited[1].tools[0].effective);
        assert_eq!(
            inherited[1].tools[3].restrictions[0].source,
            Source::LunaBaseline
        );

        definition.allowed_tools = Some(vec!["outside".into()]);
        tools[3].available = false;
        tools[3].unavailable_reason = Some("disabled_by_configuration".into());
        let blocked = resolve(&settings, Some(&definition), &modes, &tools)?;
        assert!(!blocked[0].tools[3].effective);
        assert_eq!(
            blocked[0].tools[3].restrictions[0].source,
            Source::DisabledByConfiguration
        );
        Ok(())
    }
    #[test]
    fn removing_expert_keeps_mode_defaults_and_empty_policies_never_restore_tools() -> Result<()> {
        let (mut settings, modes, mut tools) = fixture();
        let plain = resolve(&settings, None, &modes, &tools)?;
        assert!(plain[0].tools[1].effective);
        assert!(plain[1].tools[2].effective);
        let mut expert = expert();
        expert.allowed_tools = Some(vec![]);
        assert!(
            resolve(&settings, Some(&expert), &modes, &tools)?
                .iter()
                .flat_map(|m| &m.tools)
                .all(|tool| !tool.effective)
        );
        expert.allowed_tools = None;
        settings.tools.luna.allowed.clear();
        assert!(
            resolve(&settings, Some(&expert), &modes, &tools)?
                .iter()
                .flat_map(|m| &m.tools)
                .all(|tool| !tool.effective)
        );
        tools[0].available = false;
        tools[0].unavailable_reason = Some("model_tools_disabled".into());
        let disabled = resolve(&settings, None, &modes, &tools)?;
        assert!(!disabled[0].tools[0].effective);
        assert!(
            disabled[0].tools[0]
                .restrictions
                .iter()
                .any(|r| r.source == Source::ModelToolsDisabled)
        );
        Ok(())
    }
}
