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
) -> (String, HashSet<String>, usize, u64) {
    let available_tool_names = tool_defs
        .iter()
        .map(|definition| definition.name.clone())
        .collect::<HashSet<_>>();
    let plan_mode = engine.state.plan_mode();
    let suppress_user_elicitation = engine.permission_mode_suppresses_user_elicitation();
    let mut system_prompt = build_system_prompt(
        &engine.cwd,
        model,
        plan_mode.is_some(),
        engine.is_luna_mode_active(),
        suppress_user_elicitation,
        &available_tool_names,
    );
    system_prompt.push_str(&engine.skill_catalog_prompt(&available_tool_names));
    if engine.state.session_mode() == kcoder_state::SessionMode::WorkflowDraft {
        if let Some(id) = engine.state.workflow_definition_id() {
            system_prompt.push_str(&format!("\n\nWorkflow draft binding: {}\nRead and update this existing draft only. The user's conversation message is the design requirement; do not create another draft.", serde_json::json!({"id": id})));
        }
        system_prompt.push_str("\n\nThis is a workflow design session. Only WorkflowDraft is available. Prefer deterministic data nodes and executable result checks; follow the attached WorkflowDraft contract. Build new graphs incrementally, one node per call; read existing drafts before editing and use patch_nodes for atomic rewiring of several nodes. Switch nodes select named routes by first match or default; conditions/runIf support nested branches, and mergePolicy any joins alternative branches. Generation and editing do not run nodes. Do not claim code or agents were executed. Preserve the requested draft ID and use the latest revision returned by each edit. When the user asks to save or publish, call WorkflowDraft save directly in this conversation; a UI Save click is optional. Execution requires a normal conversation with Workflow available; this design session cannot run nodes.");
    }
    if let Some(role_prompt) = engine.subagent_system_prompt.as_deref() {
        system_prompt.push_str("\n\n## Sub-agent role\n");
        system_prompt.push_str(role_prompt);
    }
    if let Some(provenance) = engine.orchestrate_provenance() {
        system_prompt.push_str("\n\n");
        system_prompt.push_str(&arrangement_system_prompt(
            &available_tool_names,
            suppress_user_elicitation,
            provenance,
        ));
    }

    // Capture the completed parent transcript and active skills for
    // future forks. Runtime configuration is rebuilt from the live
    // parent when each child starts.
    {
        let params = crate::agent::CacheSafeParams {
            fork_context_messages: cache_context_messages,
            active_skills: active_skills.to_vec(),
            snapshot_provider: snapshot_provider.to_owned(),
            snapshot_model: snapshot_model.to_owned(),
            full_context_compatible,
        };
        *recover_write_lock(&engine.last_cache_safe_params, "last_cache_safe_params") =
            Some(Arc::new(params));
    }

    let (max_retries, base_delay_ms) = {
        let settings = recover_read_lock(&engine.settings, "settings");
        (settings.max_retries, settings.retry_base_delay_ms)
    };

    (
        system_prompt,
        available_tool_names,
        max_retries,
        base_delay_ms,
    )
}
