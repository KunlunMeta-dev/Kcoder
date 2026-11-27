use super::*;

pub(super) fn skill_review_runtime_config(settings: &Settings) -> (bool, usize) {
    if settings.training_mode {
        return (false, settings.auto_skill_review_interval.max(1));
    }
    let persistent_enabled = settings.skills.auto_skill_review_enabled;
    let enabled = settings.auto_skill_review_enabled || persistent_enabled;
    let interval = if persistent_enabled {
        settings.skills.auto_skill_review_interval
    } else {
        settings.auto_skill_review_interval
    };
    (enabled, interval.max(1))
}

/// Foreground idle time required before a background skill review.
pub(super) fn skill_review_idle_deadline(settings: &Settings) -> Duration {
    Duration::from_secs(
        settings
            .skills
            .auto_skill_review_idle_minutes
            .max(1)
            .saturating_mul(60),
    )
}

pub(super) fn record_loaded_skill_metadata(
    cwd: &Path,
    user_root: &Path,
    external_skill_dirs: &[PathBuf],
    registry: &SkillRegistry,
) {
    let skills = registry
        .iter_all()
        .map(|skill| (skill.name.clone(), skill.source.clone()))
        .collect::<Vec<_>>();
    if let Err(error) = kcoder_tools::skill_provenance::persist_loaded_skill_metadata(
        cwd,
        user_root,
        external_skill_dirs,
        &skills,
    ) {
        warn!(%error, "failed to persist loaded skill metadata transaction");
    }
}

/// Reset an `AtomicBool` lifecycle flag when the owning future completes,
/// errors, or is aborted. Background review/curator jobs use this so an
/// aborted task cannot leave its `*_running` flag stuck for the rest of the
/// engine's lifetime.
pub(super) struct ResetFlagOnDrop(pub(super) Arc<AtomicBool>);

impl Drop for ResetFlagOnDrop {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl QueryEngine {
    /// Count a completed main-thread turn's tool calls toward the next idle
    /// review. Never starts a review by itself.
    pub(super) fn record_skill_review_tool_calls(&self, recent_tools: &[String]) {
        if recent_tools.is_empty() {
            return;
        }
        let enabled = {
            let settings = recover_read_lock(&self.settings, "settings");
            skill_review_runtime_config(&settings).0
        };
        if enabled {
            self.auto_skill_review_schedule
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .record_tool_calls(recent_tools);
        }
    }

    /// Idle-poll step for the background skill review. Cheap in-memory gates
    /// run first; the transcript is read only once an idle episode is ready.
    pub(super) fn maybe_spawn_skill_review(&self) {
        if self.state.session_mode() == kcoder_state::SessionMode::WorkflowDraft {
            return;
        }
        if !self
            .workspace_persistence_mode
            .allows_implicit_project_writes()
            || self.tools.get("skill_manage").is_none()
        {
            return;
        }
        let (enabled, min_tool_calls, idle_deadline) = {
            let settings = recover_read_lock(&self.settings, "settings");
            let (enabled, interval) = skill_review_runtime_config(&settings);
            (enabled, interval, skill_review_idle_deadline(&settings))
        };
        if !enabled || self.auto_skill_review_running.load(Ordering::SeqCst) {
            return;
        }
        let episode =
            *recover_read_lock(&self.foreground_last_activity, "foreground_last_activity");
        let idle_for = crate::skill_curator_schedule::curator_foreground_idle(
            SystemTime::now(),
            episode,
            self.turn_driver_active(),
        );
        if !self
            .auto_skill_review_schedule
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .ready(episode, idle_for, idle_deadline, min_tool_calls)
        {
            return;
        }
        let Some(cache_safe) = self.cache_safe_snapshot() else {
            return;
        };

        // An empty or aborted final answer has nothing to review: skip this
        // idle episode but keep the accumulated activity for the next one.
        let messages = self.state.messages();
        if last_assistant_text(&messages).is_none_or(|text| text.trim().is_empty()) {
            self.auto_skill_review_schedule
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .skip_episode(episode);
            return;
        }

        if self.auto_skill_review_running.swap(true, Ordering::SeqCst) {
            return;
        }
        // Aborts (session replacement, goal stop) kill the spawned future at
        // an arbitrary await; the guard resets the flag on drop so the review
        // cannot be silently disabled for the rest of this engine's lifetime.
        let reset_on_drop = ResetFlagOnDrop(self.auto_skill_review_running.clone());
        let window = self
            .auto_skill_review_schedule
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .begin_review(episode, messages.len());

        // The fork receives the whole conversation; the prompt points it at
        // what changed since the previous review's cursor.
        let cache_safe = crate::agent::CacheSafeParams {
            fork_context_messages: messages.into(),
            active_skills: self.effective_active_skill_names(),
            snapshot_provider: cache_safe.snapshot_provider.clone(),
            snapshot_model: cache_safe.snapshot_model.clone(),
            context_history_anchor: cache_safe.context_history_anchor.clone(),
            full_context_compatible: cache_safe.full_context_compatible,
        };

        let evolution_mode = self.evolution_review_mode();
        let prompt = if evolution_mode.is_some() {
            crate::skill_review::build_evolution_skill_review_prompt(
                &window.tool_counts,
                window.reviewed_before,
                window.message_count,
            )
        } else {
            crate::skill_review::build_background_skill_review_prompt(
                &window.tool_counts,
                window.reviewed_before,
                window.message_count,
            )
        };
        let review_job_id = format!(
            "skill-review-{}",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let engine = self.clone();
        let description = format!(
            "{} after {} tool call(s): {}",
            crate::skill_review::INTERNAL_SKILL_REVIEW_PREFIX,
            window.tool_calls,
            crate::skill_review::summarize_tool_counts(&window.tool_counts)
        );
        let spawn_result = self.background_jobs.spawn(
            description,
            Box::pin(async move {
                let _reset_on_drop = reset_on_drop;
                let result = engine
                    .run_background_skill_review(cache_safe, prompt, review_job_id, evolution_mode)
                    .await;
                engine
                    .auto_skill_review_running
                    .store(false, Ordering::SeqCst);
                match result {
                    Ok(summary) => ToolOutput::text(summary),
                    Err(e) => {
                        warn!("background skill review failed: {}", e);
                        ToolOutput::error(format!("background skill review failed: {e}"))
                    }
                }
            }),
        );

        if let Err(e) = spawn_result {
            self.auto_skill_review_running
                .store(false, Ordering::SeqCst);
            warn!("failed to spawn background skill review: {}", e);
        }
    }

    pub(super) async fn run_background_skill_review(
        &self,
        cache_safe: crate::agent::CacheSafeParams,
        prompt: String,
        review_job_id: String,
        evolution_mode: Option<kcoder_types::evolution::EvolutionMode>,
    ) -> anyhow::Result<String> {
        // With self-evolution on, the review only records evidence and
        // proposals (plan section 13.1); otherwise Phase 0 tools apply.
        let (review_tools, session_allowed_tools) = match evolution_mode {
            Some(mode) => (
                crate::evolution::review_registry(&self.tools, self.evolution_review_context(mode)),
                crate::evolution::review_tool_names(),
            ),
            None => {
                let allowed = crate::agent::background_review_allowed_tools();
                (
                    crate::agent::filter_tools_by_names(&self.tools, &allowed),
                    vec![
                        "remember".to_string(),
                        "skill".to_string(),
                        "skill_manage".to_string(),
                        "DiscoverSkills".to_string(),
                    ],
                )
            }
        };
        let mut review_parent = self.clone();
        review_parent.request_class = crate::request_admission::RequestClass::SkillReview;
        let result = crate::agent::run_forked_agent_with_tools(
            &review_parent,
            &cache_safe,
            vec![Message::user_text(prompt)],
            crate::agent::SubagentContextOverrides {
                role_system_prompt: Some(
                    "You are KCoder's internal background skill reviewer. Inspect only the supplied reusable-skill evidence and use only the restricted skill/memory maintenance tools exposed to this run. Make narrowly scoped skill changes when the review request requires them; do not modify unrelated project files."
                        .to_string(),
                ),
                // This internal maintenance path is explicitly authorized for
                // only its already-filtered skill/memory tools. Parent deny
                // rules still win, and all other sub-agents retain the
                // non-interactive auto-deny prompt plus role-specific modes.
                permission_mode_if_parent_asks: Some(PermissionMode::Auto),
                session_allowed_tools,
                skill_review_job_id: Some(review_job_id),
                ..crate::agent::SubagentContextOverrides::default()
            },
            crate::skill_review::BACKGROUND_SKILL_REVIEW_MAX_TURNS,
            review_tools,
        )
        .await?;

        let external_skill_dirs = {
            let settings = recover_read_lock(&self.settings, "settings");
            settings.skills.external_dirs.clone()
        };
        let refreshed = recover_read_lock(&self.skill_registry, "skill_registry")
            .reload_with_external_dirs(&self.cwd, external_skill_dirs.iter());
        match refreshed {
            Ok(refreshed) => {
                *recover_write_lock(&self.skill_registry, "skill_registry") = refreshed;
            }
            Err(e) => warn!("failed to reload skills after background review: {}", e),
        }

        let summary = result.output_text.trim();
        if summary.is_empty() {
            Ok("Self-improvement review completed.".to_string())
        } else {
            Ok(format!("Self-improvement review: {summary}"))
        }
    }
}
