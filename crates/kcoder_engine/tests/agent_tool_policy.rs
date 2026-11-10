use anyhow::Result;
use kcoder_engine::agent_tool_policy::{resolve_agent_tool_names, resolve_agent_tool_policy};
use kcoder_types::integrations::office::OfficeAssistantDefinition;
use kcoder_types::integrations::office::OfficeAssistantSkill;

fn definition() -> OfficeAssistantDefinition {
    serde_json::from_value(serde_json::json!({
        "schemaVersion":1,"id":"expert","scope":"personal","title":"Expert",
        "description":"Configuration","language":"en","instructions":"Instructions",
        "inputSchema":{"type":"object"},"modelSelection":{"kind":"inherit_current"},
        "outputKinds":["document"],"acceptanceCriteria":["Review"],"externalSend":"deny"
    }))
    .unwrap()
}
fn names(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).into()).collect()
}
fn skill(content: &str, allowed: Option<Vec<String>>, enabled: bool) -> OfficeAssistantSkill {
    OfficeAssistantSkill {
        slug: "workflow".into(),
        title: "Workflow".into(),
        description: String::new(),
        content: content.into(),
        enabled,
        allowed_tools: allowed,
    }
}

#[test]
fn inheritance_explicit_empty_and_unknown_names_have_one_meaning() -> Result<()> {
    let mut expert = definition();
    let baseline = names(&["write", "read", "read"]);
    assert_eq!(
        resolve_agent_tool_names(&expert, &baseline)?,
        names(&["write", "read"])
    );
    expert.allowed_tools = Some(names(&["read", "not-authorized"]));
    assert_eq!(
        resolve_agent_tool_names(&expert, &baseline)?,
        names(&["read"])
    );
    expert.allowed_tools = Some(Vec::new());
    assert!(resolve_agent_tool_names(&expert, &baseline)?.is_empty());
    Ok(())
}

#[test]
fn frontmatter_and_explicit_skill_restrictions_share_aliases_and_loader_limits() -> Result<()> {
    let baseline = names(&["read", "write", "skill", "DiscoverSkills"]);
    let mut expert = definition();
    expert.skills = vec![skill("---\nallowed-tools: [Read]\n---\nRules", None, true)];
    let expected = names(&["read", "skill", "DiscoverSkills"]);
    assert_eq!(resolve_agent_tool_names(&expert, &baseline)?, expected);
    expert.skills[0].allowed_tools = Some(names(&["Write"]));
    assert_eq!(
        resolve_agent_tool_names(&expert, &baseline)?,
        names(&["write", "skill", "DiscoverSkills"])
    );
    expert.allowed_tools = Some(names(&["read"]));
    expert.skills[0].allowed_tools = Some(names(&["Read"]));
    assert_eq!(
        resolve_agent_tool_names(&expert, &baseline)?,
        names(&["read"])
    );
    expert.skills[0].allowed_tools = Some(Vec::new());
    assert!(resolve_agent_tool_names(&expert, &baseline)?.is_empty());
    Ok(())
}

#[test]
fn disabled_skills_do_not_filter_and_enabled_skills_intersect() -> Result<()> {
    let mut expert = definition();
    expert.skills = vec![skill("Rules", Some(names(&["read"])), false)];
    let baseline = names(&["read", "write"]);
    assert_eq!(resolve_agent_tool_names(&expert, &baseline)?, baseline);
    expert.skills[0].enabled = true;
    let mut second = skill("Rules", Some(names(&["write"])), true);
    second.slug = "second".into();
    expert.skills.push(second);
    assert!(resolve_agent_tool_names(&expert, &baseline)?.is_empty());
    Ok(())
}

#[test]
fn finite_native_baselines_cannot_be_expanded_by_experts_or_skills() -> Result<()> {
    let mut expert = definition();
    expert.allowed_tools = Some(names(&["OfficeRead", "bash"]));
    expert.skills = vec![skill("Rules", Some(names(&["OfficeRead", "bash"])), true)];
    assert_eq!(
        resolve_agent_tool_names(&expert, &names(&["OfficeRead"]))?,
        names(&["OfficeRead"])
    );
    assert!(resolve_agent_tool_names(&expert, &[])?.is_empty());
    Ok(())
}

#[test]
fn policy_explanation_matches_execution_without_turning_exclusions_into_grants() -> Result<()> {
    let mut expert = definition();
    expert.allowed_tools = Some(names(&["read", "write", "skill"]));
    expert.skills = vec![skill("---\nallowed-tools: [Read]\n---\nRules", None, true)];
    let baseline = names(&["read", "write", "bash", "skill"]);
    let policy = resolve_agent_tool_policy(&expert, &baseline)?;
    assert_eq!(
        policy.allowed_tools,
        resolve_agent_tool_names(&expert, &baseline)?
    );
    assert_eq!(policy.allowed_tools, names(&["read", "skill"]));
    assert!(policy.excluded_by_expert.contains("bash"));
    assert_eq!(policy.excluded_by_skills["write"], names(&["workflow"]));
    Ok(())
}

#[test]
fn real_engine_uses_resolved_policy_and_clearing_restores_the_task_baseline() -> Result<()> {
    use std::sync::Arc;
    struct NoCalls;
    impl kcoder_api::Provider for NoCalls {
        fn name(&self) -> &'static str {
            "owned-policy-probe"
        }
        fn stream_messages(
            &self,
            _: kcoder_types::MessagesRequest,
        ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
            panic!("Policy configuration must never call a model")
        }
    }
    let root = tempfile::tempdir()?;
    let mut settings = kcoder_config::Settings {
        history_enabled: false,
        ..Default::default()
    };
    settings.tools.luna.allowed = names(&["write", "skill", "DiscoverSkills"]);
    settings.tools.studio.kcoder = Some(names(&["write"]));
    settings.tools.studio.kworker = Some(names(&["write"]));
    settings.tools.disabled = names(&["glob"]);
    let task = kcoder_engine::QueryEngine::try_new_for_client_with_services(
        Arc::new(NoCalls),
        kcoder_state::AppState::new(root.path()),
        kcoder_tools::default_registry(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        root.path().into(),
        Some(true),
        kcoder_engine::WorkspaceRuntimeServices::new(root.path(), "owned-policy-probe"),
    )?;
    let mut expert = definition();
    expert.allowed_tools = Some(names(&["read", "write", "glob"]));
    expert.skills = vec![skill(
        "---\nallowed-tools: [Read, Glob]\n---\nRead only",
        None,
        true,
    )];
    for mode in [
        kcoder_types::StudioWorkMode::Kcoder,
        kcoder_types::StudioWorkMode::Kworker,
    ] {
        let ordinary =
            task.clone()
                .with_client_presentation(Some(kcoder_types::ClientPresentationV1 {
                    version: 1,
                    studio_work_mode: Some(mode),
                    inline_widgets: false,
                    isolated_widgets: false,
                }));
        assert!(ordinary.active_tool_registry().get("read").is_none());
        assert!(ordinary.active_tool_registry().get("write").is_some());
        let configured = ordinary
            .clone()
            .with_agent_definition_context(expert.clone())?;
        assert_eq!(configured.active_tool_registry().names(), names(&["read"]));
        let restricted = ordinary
            .clone()
            .with_native_tool_ceiling(&names(&["write"]))?
            .with_agent_definition_context(expert.clone())?;
        assert!(restricted.active_tool_registry().names().is_empty());
        assert!(std::sync::Arc::ptr_eq(
            &configured.active_tool_registry().get("read").unwrap(),
            &task.active_tool_registry().get("read").unwrap(),
        ));
        assert_eq!(configured.session_id(), task.session_id());
        let cleared = configured.without_agent_definition_context();
        assert_eq!(
            cleared.active_tool_registry().names(),
            ordinary.active_tool_registry().names()
        );

        let old_retry = ordinary
            .clone()
            .with_agent_definition_tool_snapshot(expert.clone(), None)?;
        assert!(old_retry.active_tool_registry().get("read").is_none());
        let mut inherited = definition();
        let pinned = ordinary.capture_expert_tool_selection(&inherited);
        assert_eq!(pinned, names(&["write", "skill", "DiscoverSkills"]));
        let retry =
            ordinary.with_agent_definition_tool_snapshot(inherited.clone(), Some(&pinned))?;
        assert!(retry.active_tool_registry().get("write").is_some());
        assert!(retry.active_tool_registry().get("read").is_none());
        inherited.allowed_tools = Some(vec![]);
        assert!(
            task.clone()
                .with_agent_definition_context(inherited)?
                .active_tool_registry()
                .names()
                .is_empty()
        );
    }
    assert!(task.state.messages().is_empty());
    Ok(())
}
