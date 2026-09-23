use super::*;

fn hours_to_duration(hours: u64) -> Duration {
    Duration::from_secs(hours.saturating_mul(60 * 60))
}

fn u64_to_i64_saturating(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

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

pub(super) fn record_loaded_skill_metadata(
    cwd: &Path,
    external_skill_dirs: &[PathBuf],
    registry: &SkillRegistry,
) {
    let skills = registry
        .iter_all()
        .map(|skill| (skill.name.clone(), skill.source.clone()))
        .collect::<Vec<_>>();
    if let Err(error) = kcoder_tools::skill_provenance::persist_loaded_skill_metadata(
        cwd,
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
struct ResetFlagOnDrop(Arc<AtomicBool>);

impl Drop for ResetFlagOnDrop {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl QueryEngine {
    pub(super) fn maybe_spawn_skill_review(&self, recent_tools: &[String]) {
        if !self
            .workspace_persistence_mode
            .allows_implicit_project_writes()
            || recent_tools.is_empty()
            || self.tools.get("skill_manage").is_none()
        {
            return;
        }

        let (enabled, interval) = {
            let settings = recover_read_lock(&self.settings, "settings");
            skill_review_runtime_config(&settings)
        };
        if !enabled {
            return;
        }

        let messages = self.state.messages();
        if !crate::skill_review::has_reusable_knowledge_signal(&messages) {
            return;
        }

        {
            let mut counter =
                recover_write_lock(&self.auto_skill_review_counter, "auto_skill_review_counter");
            *counter += recent_tools.len();
            if *counter < interval {
                return;
            }
            *counter = 0;
        }

        if self.auto_skill_review_running.swap(true, Ordering::SeqCst) {
            return;
        }
        // Aborts (session replacement, goal stop) kill the spawned future at
        // an arbitrary await; the guard resets the flag on drop so the review
        // cannot be silently disabled for the rest of this engine's lifetime.
        let reset_on_drop = ResetFlagOnDrop(self.auto_skill_review_running.clone());

        let Some(cache_safe) = self.cache_safe_snapshot() else {
            self.auto_skill_review_running
                .store(false, Ordering::SeqCst);
            return;
        };

        if last_assistant_text(&messages)
            .map(|text| text.trim().is_empty())
            .unwrap_or(true)
        {
            self.auto_skill_review_running
                .store(false, Ordering::SeqCst);
            return;
        }

        let cache_safe = crate::agent::CacheSafeParams {
            fork_context_messages: messages.into(),
            active_skills: recover_read_lock(&self.active_skills, "active_skills").clone(),
            snapshot_provider: cache_safe.snapshot_provider.clone(),
            snapshot_model: cache_safe.snapshot_model.clone(),
            full_context_compatible: cache_safe.full_context_compatible,
        };

        let prompt = crate::skill_review::build_background_skill_review_prompt(recent_tools);
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
            recent_tools.len(),
            crate::skill_review::summarize_tool_counts(recent_tools)
        );
        let spawn_result = self.background_jobs.spawn(
            description,
            Box::pin(async move {
                let _reset_on_drop = reset_on_drop;
                let result = engine
                    .run_background_skill_review(cache_safe, prompt, review_job_id)
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

    pub(super) fn maybe_spawn_auto_curator(&self) {
        if !self
            .workspace_persistence_mode
            .allows_implicit_project_writes()
            || self.tools.get("skill_curator").is_none()
        {
            return;
        }

        let (enabled, interval, min_idle, stale_after_days, archive_after_days, prune_builtins) = {
            let settings = recover_read_lock(&self.settings, "settings");
            (
                settings.skills.auto_curator_enabled,
                hours_to_duration(settings.skills.auto_curator_interval_hours.max(1)),
                hours_to_duration(settings.skills.auto_curator_min_idle_hours),
                u64_to_i64_saturating(settings.skills.stale_after_days),
                u64_to_i64_saturating(settings.skills.archive_after_days),
                settings.skills.prune_builtins,
            )
        };
        if !enabled {
            return;
        }

        if self.auto_curator_running.swap(true, Ordering::SeqCst) {
            return;
        }
        // Same abort-safety as the skill review: the curator sleeps for the
        // idle window inside the spawned future, so any session replacement
        // would otherwise strand the flag forever.
        let reset_on_drop = ResetFlagOnDrop(self.auto_curator_running.clone());

        let now = SystemTime::now();
        {
            let last_run = recover_read_lock(&self.auto_curator_last_run, "auto_curator_last_run");
            if last_run
                .and_then(|last| now.duration_since(last).ok())
                .is_some_and(|elapsed| elapsed < interval)
            {
                self.auto_curator_running.store(false, Ordering::SeqCst);
                return;
            }
        }

        let scheduled_after = now;
        let engine = self.clone();
        let description = format!(
            "{INTERNAL_SKILL_CURATOR_PREFIX} run after idle {}s",
            min_idle.as_secs()
        );
        let spawn_result = self.background_jobs.spawn(
            description,
            Box::pin(async move {
                let _reset_on_drop = reset_on_drop;
                if !min_idle.is_zero() {
                    tokio::time::sleep(min_idle).await;
                }

                let latest_activity = *recover_read_lock(
                    &engine.auto_curator_last_activity,
                    "auto_curator_last_activity",
                );
                if latest_activity > scheduled_after {
                    engine.auto_curator_running.store(false, Ordering::SeqCst);
                    return ToolOutput::text(
                        "Auto skill curator skipped because foreground activity resumed.",
                    );
                }

                *recover_write_lock(&engine.auto_curator_last_run, "auto_curator_last_run") =
                    Some(SystemTime::now());

                let (max_out, head_out, tail_out, max_subagents) = {
                    let settings = recover_read_lock(&engine.settings, "settings");
                    (
                        settings.max_tool_output_bytes,
                        settings.tool_output_head_bytes,
                        settings.tool_output_tail_bytes,
                        Some(effective_max_concurrent_subagents(&settings)),
                    )
                };
                let ctx = engine
                    .base_tool_context(max_out, head_out, tail_out, max_subagents)
                    .with_skill_mutation_actor(kcoder_skills::SkillMutationActor::AutoCurator {
                        session_id: engine.state.session_id(),
                        job_id: format!(
                            "auto-curator-{}",
                            SystemTime::now()
                                .duration_since(SystemTime::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_nanos()
                        ),
                    });
                let input = serde_json::json!({
                    "action": "run",
                    "stale_after_days": stale_after_days,
                    "archive_after_days": archive_after_days,
                    "include_non_agent_created": false,
                    "include_bundled": prune_builtins,
                });
                let output = match SkillCuratorTool.call(input, &ctx).await {
                    Ok(output) => output,
                    Err(error) => {
                        warn!("automatic skill curator failed: {}", error);
                        ToolOutput::error(format!("automatic skill curator failed: {error}"))
                    }
                };
                engine.auto_curator_running.store(false, Ordering::SeqCst);
                output
            }),
        );

        if let Err(e) = spawn_result {
            self.auto_curator_running.store(false, Ordering::SeqCst);
            warn!("failed to spawn automatic skill curator: {}", e);
        }
    }

    pub(super) async fn run_background_skill_review(
        &self,
        cache_safe: crate::agent::CacheSafeParams,
        prompt: String,
        review_job_id: String,
    ) -> anyhow::Result<String> {
        let allowed = crate::agent::background_review_allowed_tools();
        let review_tools = crate::agent::filter_tools_by_names(&self.tools, &allowed);
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
                session_allowed_tools: vec![
                    "remember".to_string(),
                    "skill".to_string(),
                    "skill_manage".to_string(),
                    "DiscoverSkills".to_string(),
                ],
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
        let refreshed = recover_read_lock(&self.skill_registry, "skill_registry").reload_with_external_dirs(&self.cwd, external_skill_dirs.iter());
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
