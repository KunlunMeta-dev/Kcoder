//! Assemble request routing and the next fork snapshot after the final tool filter.
//!
//! This synchronous phase contains no awaits or events. The stream driver calls it
//! at the original boundary, retaining ownership of retries and cancellation.
use super::*;

#[allow(clippy::too_many_arguments)]
pub(super) fn prepare_request_context(
    engine: &QueryEngine,
    model: &str,
    tool_defs: &[kcoder_types::ToolDefinition],
    cache_context_messages: kcoder_types::SharedMessages,
    active_skills: &[String],
    snapshot_provider: &str,
    snapshot_model: &str,
    full_context_compatible: bool,
    cache_lifecycle: &kcoder_state::AppStateLifecycleIdentity,
    reviewed_memory: Option<&str>,
) -> (String, HashSet<String>, usize, u64) {
    let available_tool_names = tool_defs
        .iter()
        .map(|definition| definition.name.clone())
        .collect::<HashSet<_>>();
    let prompt_tool_names = engine.prompt_capability_tool_names(&available_tool_names);
    let plan_mode = engine.state.plan_mode();
    let suppress_user_elicitation = engine.permission_mode_suppresses_user_elicitation();
    let sections = crate::prompt_runtime::build_system_prompt_sections_for_work_mode(
        &engine.cwd,
        model,
        plan_mode.is_some(),
        engine.is_luna_mode_active(),
        suppress_user_elicitation,
        &prompt_tool_names,
        engine.effective_studio_work_mode(),
    );
    // Cache-stable prefix: mode, tools, skills and role sections only.
    let mut system_prompt = sections.stable;
    engine.append_agent_definition_instructions(&mut system_prompt);
    system_prompt.push_str(&engine.skill_catalog_prompt(&available_tool_names));
    system_prompt.push_str(crate::project_knowledge_prompt::project_knowledge_prompt(
        &available_tool_names,
    ));
    let workflow_draft_session =
        engine.state.session_mode() == kcoder_state::SessionMode::WorkflowDraft;
    if workflow_draft_session {
        system_prompt.push_str("\n\nThis is a workflow design session. Only WorkflowDraft is available; this session cannot run nodes, so do not claim code or agents were executed. Preserve the requested draft ID. When the user asks to save or publish, call WorkflowDraft save directly in this conversation; a UI Save click is optional. Execution requires a normal conversation with Workflow available.");
    }
    if let Some(role_prompt) = engine.subagent_system_prompt.as_deref() {
        system_prompt.push_str("\n\n## Sub-agent role\n");
        system_prompt.push_str(role_prompt);
    }
    if let Some(provenance) = engine.orchestrate_provenance() {
        system_prompt.push_str("\n\n");
        system_prompt.push_str(&arrangement_system_prompt(
            &prompt_tool_names,
            suppress_user_elicitation,
            provenance,
        ));
    }
    if engine.effective_studio_work_mode() == kcoder_types::StudioWorkMode::Kworker {
        system_prompt.push_str("\n\n");
        system_prompt.push_str(&crate::studio_presentation::kworker_capability_prompt(
            &available_tool_names,
        ));
    }
    if let Some(prompt) = crate::tool_search_runtime::tool_discovery_prompt(&available_tool_names) {
        system_prompt.push_str("\n\n");
        system_prompt.push_str(&prompt);
    }

    // Per-session tail in a fixed order, from the least to the most volatile.
    system_prompt.push_str("\n\n");
    system_prompt.push_str(&sections.session);
    if workflow_draft_session && let Some(id) = engine.state.workflow_definition_id() {
        system_prompt.push_str(&format!("\n\nWorkflow draft binding: {}\nRead and update this existing draft only. The user's conversation message is the design requirement; do not create another draft.", serde_json::json!({"id": id})));
    }
    if let Some(prompt) = engine.channel_turn_prompt() {
        system_prompt.push_str(&prompt);
    }
    if cache_context_messages
        .iter()
        .any(kcoder_types::Message::has_peer_agent_metadata)
    {
        system_prompt.push_str(kcoder_api::peer_messages::PEER_AGENT_MESSAGE_POLICY);
    }
    if let Some(memory) = reviewed_memory {
        system_prompt.push_str("\n\n");
        system_prompt.push_str(memory);
    }

    // Capture the completed parent transcript and active skills for
    // future forks. Runtime configuration is rebuilt from the live
    // parent when each child starts.
    {
        let context_history_anchor = engine.state.context_history_anchor(&cache_context_messages);
        let params = crate::agent::CacheSafeParams {
            fork_context_messages: cache_context_messages,
            active_skills: active_skills.to_vec(),
            snapshot_provider: snapshot_provider.to_owned(),
            snapshot_model: snapshot_model.to_owned(),
            context_history_anchor,
            full_context_compatible,
        };
        let params = Arc::new(params);
        *recover_write_lock(&engine.last_cache_safe_params, "last_cache_safe_params") =
            Some(Arc::clone(&params));
        if let Ok(mut binding) = engine.side_question_cache_binding.try_write() {
            *binding = Some(crate::forking::SideQuestionCacheBinding {
                owner: cache_lifecycle.clone(),
                snapshot: Arc::downgrade(&params),
            });
        }
    }

    let (max_retries, base_delay_ms) = {
        let settings = recover_read_lock(&engine.settings, "settings");
        (
            if engine.native_input_only() {
                0
            } else {
                settings.max_retries
            },
            settings.retry_base_delay_ms,
        )
    };

    (
        system_prompt,
        available_tool_names,
        max_retries,
        base_delay_ms,
    )
}
