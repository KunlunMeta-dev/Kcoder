//! Agent context; state ownership is retained by the agent facade.

use super::*;

pub(super) fn resolve_subagent_abort_token(
    parent_token: CancellationToken,
    overrides: &SubagentContextOverrides,
) -> CancellationToken {
    overrides
        .abort_token
        .as_ref()
        .map(CancellationToken::child_token)
        .unwrap_or_else(|| {
            if overrides.share_abort_controller {
                parent_token.child_token()
            } else {
                CancellationToken::new()
            }
        })
}

pub(super) fn generate_agent_id(parent: &QueryEngine) -> anyhow::Result<String> {
    if let Some(registry) = parent.state.short_id_registry() {
        return kcoder_state::short_id::reserve_short_id(&registry);
    }
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    Ok(format!("agent-{}", ts))
}

impl SubagentContext {
    pub fn from_parent(
        parent: &QueryEngine,
        state: AppState,
        overrides: SubagentContextOverrides,
    ) -> anyhow::Result<Self> {
        Ok(Self::from_parent_with_agent_id(
            parent,
            state,
            overrides,
            generate_agent_id(parent)?,
        ))
    }

    pub fn from_parent_with_agent_id(
        parent: &QueryEngine,
        state: AppState,
        overrides: SubagentContextOverrides,
        agent_id: String,
    ) -> Self {
        let abort_token = resolve_subagent_abort_token(parent.cancel_token(), &overrides);
        let (
            mut external_skill_dirs,
            trust_external_skills,
            skill_guard_policy,
            auto_lessons_learned,
        ) = {
            let settings = crate::recover_read_lock(&parent.settings, "settings");
            (
                settings.skills.external_dirs.clone(),
                settings.skills.trust_external,
                SkillGuardPolicy {
                    enabled: settings.skills.guard.enabled,
                    block_high_risk: settings.skills.guard.block_high_risk,
                    block_medium_risk_for_community: settings
                        .skills
                        .guard
                        .block_medium_risk_for_community,
                },
                settings.skills.auto_lessons_learned,
            )
        };

        external_skill_dirs.extend(parent.plugin_snapshot().skill_roots.iter().cloned());
        external_skill_dirs.sort();
        external_skill_dirs.dedup();
        let arrangement_mode = overrides
            .arrangement_mode
            .unwrap_or_else(|| parent.is_arrangement_mode_active());
        let depth = parent.agent_depth().saturating_add(1);
        let mut tool_context = ToolContext::new(state.clone())
            .with_file_edit_surface(parent.file_edit_surface)
            .with_memory_manager(Arc::clone(&parent.memory_manager))
            .with_memory_store(Arc::clone(&parent.memory_store))
            .with_skill_registry(Arc::clone(&parent.skill_registry))
            .with_skill_registry_generation(Arc::clone(&parent.skill_registry_generation))
            .with_active_skills(Arc::clone(&parent.active_skills))
            .with_external_skill_dirs(external_skill_dirs)
            .with_trust_external_skills(trust_external_skills)
            .with_skill_guard_policy(skill_guard_policy)
            .with_auto_lessons_learned(auto_lessons_learned)
            .with_abort_token(abort_token)
            .with_agent_runtime_identity(parent.provider_name(), parent.model_name())
            .with_user_questioner(parent.effective_user_questioner())
            .with_agent_depth(depth)
            .with_allowed_write_paths(overrides.allowed_write_paths.clone())
            .with_allowed_shell_prefixes(overrides.scoped_allowed_shell_prefixes.clone())
            .with_block_shell_file_mutation(overrides.block_shell_file_mutation)
            .with_block_dependency_mutation(overrides.block_dependency_mutation)
            .with_shell_isolation_root(overrides.shell_isolation_root.clone())
            .with_verifier_test_policy(
                overrides.verifier_minimum_test_scope,
                overrides.verifier_require_raw_exit_code,
            )
            .with_verifier_behavior_delta(overrides.verifier_require_behavior_delta)
            .with_verifier_baseline_root(overrides.verifier_baseline_root.clone())
            .with_verifier_vote_channel(overrides.verifier_vote_channel.clone())
            .with_review_vote_channel(overrides.review_vote_channel.clone())
            .with_arrangement_mode(arrangement_mode)
            .with_lifecycle_hooks(Arc::new(crate::EngineLifecycleHookEmitter::new(
                parent.clone(),
            )));
        if let Some(job_id) = overrides.skill_review_job_id.as_ref() {
            tool_context = tool_context.with_skill_mutation_actor(
                kcoder_skills::SkillMutationActor::BackgroundReview {
                    session_id: state.session_id(),
                    job_id: job_id.clone(),
                    agent_id: agent_id.clone(),
                    tool_call_id: "pending".to_string(),
                },
            );
        }

        let mut permissions = crate::recover_read_lock(&parent.permissions, "permissions").clone();
        if permissions.mode == PermissionMode::Ask
            && let Some(mode) = overrides.permission_mode_if_parent_asks
        {
            permissions.mode = mode;
        }
        permissions
            .session_allowed
            .extend(overrides.session_allowed_tools.iter().cloned());
        permissions
            .session_allowed_shell_prefixes
            .extend(overrides.session_allowed_shell_prefixes.iter().cloned());

        Self {
            agent_id,
            depth,
            state,
            tool_context,
            permissions,
            overrides,
        }
    }
}
