//! QueryEngine entry points of the evolution runtime: observer
//! installation, turn boundaries, the idle poll and the public API used by
//! hosts (app-server RPC, REPL).

use super::distill::{DistillInput, store_distill_result};
use super::model::EvolutionModelUnavailable;
use super::recording::EngineSkillObserver;
use super::turns::SettleContext;
use super::{
    ARTIFACT_SCAN_INTERVAL, EngineEvolutionHooks, EvolutionRuntime, JobRegistration, ScopeKind,
    now_ms,
};
use crate::request_admission::RequestClass;
use crate::{QueryEngine, recover_read_lock};
use kcoder_config::EvolutionStage;
use kcoder_evolution::{EvolutionStore, SignalWeights, distill_due};
use kcoder_tools::evolution_service::{
    EvolutionEngineHooks, SkillOriginResolver, skill_base_revision,
};
use kcoder_types::evolution::{
    EvolutionDisabledReason, EvolutionJobKind, EvolutionMode, OverlayContent, TargetKey, TargetType,
};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Instant;

/// Result of [`QueryEngine::request_evolution_distill`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DistillRequestOutcome {
    /// Queued; it runs at the next idle poll.
    Queued,
    /// Evolution, the target or its propose mode is not active.
    Disabled,
    /// The target is not a known skill of this session.
    UnknownTarget,
    /// The distill model cannot be used; nothing was queued.
    ModelUnavailable(String),
}

/// Clears the per-runtime job flag when a job ends or is aborted.
struct JobFlag(Arc<std::sync::atomic::AtomicBool>);

impl Drop for JobFlag {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl QueryEngine {
    fn evolution_settings(&self) -> kcoder_config::Settings {
        recover_read_lock(&self.settings, "settings").clone()
    }

    /// Foreground main or child sessions collect; internal forks (review,
    /// curator, evolution jobs) never do.
    fn evolution_foreground(&self) -> bool {
        self.request_class == RequestClass::Foreground
    }

    fn evolution_collecting(&self, settings: &kcoder_config::Settings) -> bool {
        super::collection_allowed(
            settings,
            self.state.session_mode() == kcoder_state::SessionMode::WorkflowDraft,
            self.evolution_foreground(),
        )
    }

    /// Observer installed into tool contexts of foreground engines.
    pub(crate) fn evolution_skill_observer(
        &self,
    ) -> Option<Arc<dyn kcoder_tools::skill_evolution::SkillEvolutionObserver>> {
        if !self.evolution_foreground() {
            return None;
        }
        Some(Arc::new(EngineSkillObserver {
            runtime: Arc::clone(&self.evolution),
            state: self.state.clone(),
            // A subagent records under its agent task id, which
            // `evolution/rate` with `subagentId` resolves; turns stay the
            // child conversation's own `turn-N`.
            thread_id: self
                .subagent_runtime_control
                .as_ref()
                .as_ref()
                .map(|control| control.agent_id.clone()),
            settings: Arc::clone(&self.settings),
            cwd: self.cwd.clone(),
            engine: self.clone(),
        }))
    }

    /// A subagent engine records into its parent's data root (an explicit
    /// host root such as a test profile is otherwise lost on the fork).
    pub(crate) fn inherit_evolution_data_root_from(&self, parent: &QueryEngine) {
        if let Some(root) = parent.evolution.explicit_data_root() {
            self.evolution.set_data_root(root);
        }
    }

    /// Use `root` as the evolution data root instead of the user
    /// configuration directory (hosts with an explicit profile, tests).
    pub fn set_evolution_data_root(&self, root: std::path::PathBuf) {
        self.evolution.set_data_root(root);
    }

    /// Attach the memory candidate review store project knowledge
    /// candidates are offered to.
    pub fn set_evolution_review_store(
        &self,
        store: Option<Arc<kcoder_memory::integrations::knowledge::MemoryReviewStore>>,
    ) {
        *self
            .evolution
            .review_store
            .write()
            .unwrap_or_else(|error| error.into_inner()) = store;
    }

    /// Management-service hooks backed by this engine (proposal acceptance
    /// for every implemented target type, job cancellation).
    pub fn evolution_hooks(&self) -> Arc<dyn EvolutionEngineHooks> {
        Arc::new(
            EngineEvolutionHooks::new(
                Some(Arc::clone(&self.memory_manager)),
                self.evolution
                    .review_store
                    .read()
                    .unwrap_or_else(|error| error.into_inner())
                    .clone(),
            )
            .with_workspace(self.cwd.clone())
            .with_engine(self.clone()),
        )
    }

    /// Why model jobs of this engine are paused, if they are.
    pub fn evolution_paused_reason(&self) -> Option<EvolutionDisabledReason> {
        self.evolution.lock_state().paused
    }

    /// Storage and scope diagnostics noted by this engine.
    pub fn evolution_diagnostics(&self) -> Vec<String> {
        self.evolution
            .lock_state()
            .diagnostics
            .iter()
            .cloned()
            .collect()
    }

    /// Cancel this engine's running evolution job (master or target switch
    /// off, data clear). Returns whether a job was cancelled.
    pub fn cancel_evolution_job(&self) -> bool {
        let Some(token) = self
            .evolution
            .lock_state()
            .job
            .as_ref()
            .map(|job| job.token.clone())
        else {
            return false;
        };
        token.cancel();
        true
    }

    /// Resolve the skill target `key` in this session's registry:
    /// `(scope, skill name, body, base revision)`.
    pub(crate) fn evolution_skill_target(
        &self,
        key: &TargetKey,
    ) -> Option<(ScopeKind, String, String, String)> {
        if key.target_type() != TargetType::Skill {
            return None;
        }
        let registry = recover_read_lock(&self.skill_registry, "skill_registry");
        let mut resolver = SkillOriginResolver::default();
        let candidate = registry
            .source_candidates()
            .into_iter()
            .filter(|candidate| candidate.effective && !candidate.removed)
            .find(|candidate| resolver.target_key(candidate).as_ref() == Some(key))?;
        let skill = registry.get(&candidate.name)?;
        Some((
            EvolutionRuntime::scope_of(key, candidate.layer == kcoder_skills::SkillLayer::Project),
            skill.name.clone(),
            skill.content.clone(),
            skill_base_revision(skill),
        ))
    }

    /// Mode governing the background review's writes: `None` while
    /// evolution is off (Phase 0 behaviour), otherwise the skill mode.
    pub(crate) fn evolution_review_mode(&self) -> Option<EvolutionMode> {
        let settings = self.evolution_settings();
        let enabled = settings.evolution.enabled
            && !settings.training_mode
            && self.state.session_mode() != kcoder_state::SessionMode::WorkflowDraft;
        enabled.then(|| settings.evolution.effective_mode(TargetType::Skill))
    }

    pub(crate) fn evolution_review_context(
        &self,
        mode: EvolutionMode,
    ) -> super::review::ReviewToolContext {
        let registry = recover_read_lock(&self.skill_registry, "skill_registry");
        let mut resolver = SkillOriginResolver::default();
        let skills = registry
            .source_candidates()
            .into_iter()
            .filter(|candidate| candidate.effective && !candidate.removed)
            .filter_map(|candidate| {
                let key = resolver.target_key(&candidate)?;
                Some((
                    candidate.name.clone(),
                    (key, candidate.layer == kcoder_skills::SkillLayer::Project),
                ))
            })
            .collect();
        super::review::ReviewToolContext {
            runtime: Arc::clone(&self.evolution),
            cwd: self.cwd.clone(),
            mode,
            ttl_days: self.evolution_settings().evolution.evidence_ttl_days,
            skills: Arc::new(skills),
            skill_manage: self.tools.get("skill_manage"),
        }
    }

    /// Manually request a distillation of `key` (the "organize feedback"
    /// action). The job still runs only from the idle poll.
    pub fn request_evolution_distill(&self, key: &TargetKey) -> DistillRequestOutcome {
        let settings = self.evolution_settings();
        if !self.evolution_collecting(&settings)
            || !super::target_active(&settings.evolution, key)
            || settings.evolution.effective_mode(key.target_type()) < EvolutionMode::Propose
        {
            return DistillRequestOutcome::Disabled;
        }
        if self.evolution_distill_target(key).is_none() {
            return DistillRequestOutcome::UnknownTarget;
        }
        if let Err(EvolutionModelUnavailable(reason)) =
            self.resolve_evolution_model(EvolutionStage::Distill)
        {
            return DistillRequestOutcome::ModelUnavailable(reason);
        }
        self.evolution
            .manual_distill
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(key.clone());
        DistillRequestOutcome::Queued
    }

    /// Global preferences appended to the per-turn memory context.
    pub(crate) fn with_evolution_preferences(&self, memory_text: String) -> String {
        let settings = self.evolution_settings();
        if !self.evolution_collecting(&settings)
            || !settings
                .evolution
                .targets
                .type_enabled(TargetType::Preference)
        {
            return memory_text;
        }
        let Some(store) = self.evolution.store(ScopeKind::User, &self.cwd) else {
            return memory_text;
        };
        let lines = super::recording::global_preference_lines(&store);
        if lines.is_empty() {
            return memory_text;
        }
        let mut text = if memory_text.trim().is_empty() {
            "# Memories".to_string()
        } else {
            memory_text
        };
        for line in lines {
            text.push('\n');
            text.push_str(&line);
        }
        text
    }

    /// A main-thread turn starts (outermost turn driver entry).
    pub(crate) fn evolution_turn_started(&self) {
        let settings = self.evolution_settings();
        if !self.evolution_collecting(&settings) {
            return;
        }
        let messages = self.state.messages();
        self.evolution.turn_started(
            &messages,
            &self.cwd,
            settings.evolution.signals.chat_corrections,
        );
        self.evolution_tool_turn_started(&messages);
        self.evolution_observe_runs();
        if settings.evolution.signals.artifact_edits {
            self.evolution.check_artifacts(&self.cwd, now_ms());
        }
    }

    /// The outermost main-thread turn driver ended, however the turn ended.
    pub(crate) fn evolution_turn_settled(&self) {
        let settings = self.evolution_settings();
        if !self.evolution_collecting(&settings) {
            return;
        }
        let messages = self.state.messages();
        let registry = Arc::clone(&self.skill_registry);
        let skill_body = move |name: &str| {
            registry
                .read()
                .unwrap_or_else(|error| error.into_inner())
                .get(name)
                .map(|skill| skill.content.clone())
        };
        self.evolution.turn_settled(SettleContext {
            messages: &messages,
            cwd: &self.cwd,
            cancelled: self.cancel_token.is_cancelled(),
            evidence_ttl_days: settings.evolution.evidence_ttl_days,
            procedure_enabled: settings.evolution.signals.procedure_results,
            artifacts_enabled: settings.evolution.signals.artifact_edits,
            skill_body: &skill_body,
        });
        self.evolution_tool_turn_settled();
        self.evolution_observe_runs();
    }

    fn evolution_pause(&self, reason: Option<EvolutionDisabledReason>) {
        self.evolution.lock_state().paused = reason;
    }

    /// Run the self-evolution idle step now. For hosts that keep an engine
    /// without an idle pump (an app-server workspace with no open thread)
    /// and must still carry out a requested distillation; never call it
    /// while a foreground turn of this engine is active.
    pub fn run_evolution_idle_step(&self) {
        self.poll_evolution();
    }

    /// Whether a manual distillation of `key` is still waiting or running.
    pub fn evolution_distill_pending(&self, key: &TargetKey) -> bool {
        self.evolution
            .manual_distill
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contains(key)
    }

    /// Idle-poll step: windows, artifact scans, then at most one model job
    /// (classification first, then distillation).
    pub(crate) fn poll_evolution(&self) {
        let settings = self.evolution_settings();
        if !self.evolution_collecting(&settings) {
            self.cancel_evolution_job();
            return;
        }
        // A switched-off target cancels its running job.
        let running_target = self
            .evolution
            .lock_state()
            .job
            .as_ref()
            .and_then(|job| job.target.clone());
        if let Some(target) = running_target
            && !super::target_active(&settings.evolution, &target)
        {
            self.cancel_evolution_job();
        }
        let now = now_ms();
        self.evolution.close_idle_windows(&self.cwd, false);
        self.evolution_tool_poll();
        self.evolution_observe_runs();
        if settings.evolution.signals.artifact_edits {
            let due = {
                let mut state = self.evolution.lock_state();
                let due = state
                    .last_artifact_scan
                    .is_none_or(|last| last.elapsed() >= ARTIFACT_SCAN_INTERVAL);
                if due {
                    state.last_artifact_scan = Some(Instant::now());
                }
                due
            };
            if due {
                for scope in [ScopeKind::User, ScopeKind::Project] {
                    if let Some(store) = self.evolution.store(scope, &self.cwd) {
                        self.evolution
                            .restore_artifacts(&store, scope, &self.cwd, now);
                    }
                }
                self.evolution.check_artifacts(&self.cwd, now);
            }
        }
        // Phase 4 (no model calls): restore persisted classifications,
        // decide canaries, start rollouts and compact journals.
        self.evolution.restore_classification_queue(&self.cwd);
        self.run_evolution_automation(&settings, false);
        self.maybe_compact_evolution(&settings, false);
        if self.evolution.consolidation_due() {
            let evolution = settings.evolution.clone();
            let enabled = move |key: &TargetKey| super::target_active(&evolution, key);
            for scope in [ScopeKind::User, ScopeKind::Project] {
                if let Some(store) = self.evolution.store(scope, &self.cwd) {
                    super::consolidate::propose_consolidations(
                        &store,
                        settings.evolution.effective_mode(TargetType::Skill),
                        &enabled,
                        now,
                    );
                }
            }
        }
        if self.evolution.job_running.load(Ordering::SeqCst)
            || tokio::runtime::Handle::try_current().is_err()
        {
            return;
        }
        let Some(user_store) = self.evolution.store(ScopeKind::User, &self.cwd) else {
            return;
        };
        let limit = settings.evolution.usage_limit.monthly_max_tokens;
        if user_store
            .read_state()
            .is_ok_and(|state| state.usage_limit_reached(now, limit))
        {
            self.evolution_pause(Some(EvolutionDisabledReason::UsageLimit));
            return;
        }
        let has_pending = !self.evolution.lock_state().pending.is_empty();
        if has_pending && settings.evolution.signals.chat_corrections {
            match self.resolve_evolution_model(EvolutionStage::Classifier) {
                Ok(model) => {
                    self.evolution_pause(None);
                    self.spawn_classification(&settings, &user_store, model);
                }
                Err(_) => self.evolution_pause(Some(EvolutionDisabledReason::ModelUnavailable)),
            }
            return;
        }
        if let Some((key, scope, store)) = self.next_distill_target(&settings) {
            match self.resolve_evolution_model(EvolutionStage::Distill) {
                Ok(model) => {
                    self.evolution_pause(None);
                    self.spawn_distill(&settings, key, scope, store, model);
                }
                Err(_) => self.evolution_pause(Some(EvolutionDisabledReason::ModelUnavailable)),
            }
            return;
        }
        self.spawn_pending_evaluation(&settings);
    }

    pub(crate) fn spawn_job(
        &self,
        kind: EvolutionJobKind,
        target: Option<TargetKey>,
        store: &EvolutionStore,
        job: impl FnOnce(tokio_util::sync::CancellationToken) -> futures::future::BoxFuture<'static, ()>,
    ) -> bool {
        let lease_name = match kind {
            EvolutionJobKind::Classify => "classify",
            EvolutionJobKind::Distill => "distill",
            EvolutionJobKind::Eval => "eval",
        };
        let Ok(Some(lease)) = store.try_job_lease(lease_name, target.as_ref()) else {
            return false;
        };
        if self.evolution.job_running.swap(true, Ordering::SeqCst) {
            return false;
        }
        let flag = JobFlag(Arc::clone(&self.evolution.job_running));
        let scope_root = store
            .path()
            .parent()
            .map(std::path::Path::to_path_buf)
            .unwrap_or_default();
        let (registration, token) = JobRegistration::register(kind, target.clone(), scope_root);
        self.evolution.lock_state().job = Some(super::RunningJob {
            token: token.clone(),
            target,
        });
        let future = job(token.clone());
        let runtime = Arc::clone(&self.evolution);
        tokio::spawn(async move {
            let _flag = flag;
            let _lease = lease;
            let _registration = registration;
            tokio::select! {
                biased;
                _ = token.cancelled() => {}
                _ = future => {}
            }
            runtime.lock_state().job = None;
        });
        true
    }

    fn spawn_classification(
        &self,
        settings: &kcoder_config::Settings,
        user_store: &Arc<EvolutionStore>,
        model: super::model::ResolvedModel,
    ) {
        let batch: Vec<_> = {
            let mut state = self.evolution.lock_state();
            let take = state.pending.len().min(super::classify::CLASSIFY_BATCH);
            state.pending.drain(..take).collect()
        };
        // Another engine may already have classified persisted items.
        let batch = self.evolution.still_queued(batch, &self.cwd);
        if batch.is_empty() {
            return;
        }
        let processed = batch.clone();
        let engine = self.clone();
        let ttl = settings.evolution.evidence_ttl_days;
        let requeue = batch.clone();
        let spawned = self.spawn_job(EvolutionJobKind::Classify, None, user_store, move |token| {
            Box::pin(async move {
                let runtime = Arc::clone(&engine.evolution);
                let cwd = engine.cwd.clone();
                match engine
                    .run_evolution_classification(&runtime, batch, model, &cwd, ttl)
                    .await
                {
                    Ok(()) => runtime.forget_classifications(&processed, &cwd),
                    Err(error) if !token.is_cancelled() => {
                        runtime.note_diagnostic(format!("classification failed: {error}"));
                    }
                    Err(_) => {}
                }
            })
        });
        if !spawned {
            self.evolution.lock_state().pending.splice(0..0, requeue);
        }
    }

    /// The first enabled skill, tool usage or run template target whose
    /// distillation is due, each type under its own effective mode.
    fn next_distill_target(
        &self,
        settings: &kcoder_config::Settings,
    ) -> Option<(TargetKey, ScopeKind, Arc<EvolutionStore>)> {
        let distillable = |key: &TargetKey| {
            matches!(
                key.target_type(),
                TargetType::Skill | TargetType::ToolUsage | TargetType::WorkflowTemplate
            ) && settings.evolution.effective_mode(key.target_type()) >= EvolutionMode::Propose
        };
        let weights = SignalWeights::from_settings(&settings.evolution.signals);
        let manual = self
            .evolution
            .manual_distill
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        for scope in [ScopeKind::User, ScopeKind::Project] {
            let Some(store) = self.evolution.store(scope, &self.cwd) else {
                continue;
            };
            let Ok(stats) = store.stats(&weights) else {
                continue;
            };
            let Ok(state) = store.read_state() else {
                continue;
            };
            let mut keys = stats.targets();
            keys.extend(manual.iter().cloned());
            for key in keys {
                if !distillable(&key) || !super::target_active(&settings.evolution, &key) {
                    continue;
                }
                let Some((target_scope, ..)) = self.evolution_distill_target(&key) else {
                    continue;
                };
                if target_scope != scope {
                    continue;
                }
                let cursor = state.distill.get(&key).cloned().unwrap_or_default();
                let due = distill_due(
                    stats
                        .observed_usages(&key)
                        .saturating_sub(cursor.observed_usages),
                    stats.conflicts(&key).saturating_sub(cursor.conflicts),
                    settings.evolution.distill_min_usages,
                    manual.contains(&key),
                );
                if due.is_some() {
                    return Some((key, scope, store));
                }
            }
        }
        None
    }

    fn spawn_distill(
        &self,
        settings: &kcoder_config::Settings,
        key: TargetKey,
        scope: ScopeKind,
        store: Arc<EvolutionStore>,
        model: super::model::ResolvedModel,
    ) {
        let engine = self.clone();
        let weights = SignalWeights::from_settings(&settings.evolution.signals);
        let job_store = Arc::clone(&store);
        let target = key.clone();
        self.spawn_job(
            EvolutionJobKind::Distill,
            Some(key.clone()),
            &store,
            move |token| {
                Box::pin(async move {
                    engine
                        .run_distill_job(target, scope, job_store, model, weights, token)
                        .await;
                })
            },
        );
    }

    async fn run_distill_job(
        &self,
        key: TargetKey,
        _scope: ScopeKind,
        store: Arc<EvolutionStore>,
        model: super::model::ResolvedModel,
        weights: SignalWeights,
        token: tokio_util::sync::CancellationToken,
    ) {
        let runtime = Arc::clone(&self.evolution);
        let now = now_ms();
        let Some((_, body, base_revision)) = self.evolution_distill_target(&key) else {
            return;
        };
        let Ok(stats) = store.stats(&weights) else {
            return;
        };
        let observed = stats.observed_usages(&key);
        let conflicts = stats.conflicts(&key);
        let cursor = store
            .read_state()
            .ok()
            .and_then(|state| state.distill.get(&key).cloned())
            .unwrap_or_default();
        if store.record_job_run("distill", None, now).is_err() {
            return;
        }
        let start_revision = store.read_state().map(|state| state.revision).unwrap_or(0);
        // Incremental: evidence observed before the previous run started
        // was already offered to it.
        let (samples, origins) = super::distill::gather_evidence_since(
            &store,
            &key,
            &cursor.user_edit_evidence,
            &cursor.review_findings,
            now,
            cursor.last_run_at_ms,
        );
        let finish_cursor = |store: &EvolutionStore| {
            let _ = store.update_state(|state| {
                let entry = state.distill.entry(key.clone()).or_default();
                entry.observed_usages = observed;
                entry.conflicts = conflicts;
                // The run's start: the next run skips evidence before it.
                entry.last_run_at_ms = Some(now);
                entry.user_edit_evidence.clear();
                entry.review_findings.clear();
            });
            runtime
                .manual_distill
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&key);
        };
        if samples.is_empty() {
            finish_cursor(&store);
            return;
        }
        let overlay = store
            .read_overlay(&key)
            .ok()
            .flatten()
            .and_then(|view| view.stable)
            .unwrap_or_default();
        let summary = stats
            .latest_bucket(&key, kcoder_types::evolution::Channel::Stable)
            .map(|(bucket, evidence)| {
                format!(
                    "revision {}: {} scored usages, mean {:.2}, {} conflicts, {} explicit negatives",
                    bucket.revision.label(),
                    evidence.observations,
                    evidence.posterior(kcoder_evolution::BetaPrior::default()).mean(),
                    evidence.conflicts,
                    evidence.explicit_negatives
                )
            })
            .unwrap_or_else(|| "no scored usages yet".into());
        let input = DistillInput {
            key: key.clone(),
            base_revision,
            body,
            overlay,
            samples,
            origins,
            stats_summary: summary,
        };
        let result = self.run_distill_fork(&input, &model).await;
        if let Some(user) = runtime.store(ScopeKind::User, &self.cwd) {
            let usage = result
                .as_ref()
                .map(|(_, usage)| usage.clone())
                .unwrap_or_default();
            let _ = user.record_model_usage(now_ms(), usage.input_tokens, usage.output_tokens);
        }
        let submission = match result {
            Ok((submission, _)) => submission,
            Err(error) => {
                runtime.note_diagnostic(format!("distillation failed: {error}"));
                return;
            }
        };
        // Discard unfinished results after a switch-off or a data clear.
        let settings = self.evolution_settings();
        let cleared = store
            .read_state()
            .map(|state| state.revision < start_revision)
            .unwrap_or(true);
        if token.is_cancelled()
            || cleared
            || !self.evolution_collecting(&settings)
            || !super::target_active(&settings.evolution, &key)
        {
            return;
        }
        let user_store = runtime.store(ScopeKind::User, &self.cwd);
        let project_store = runtime.store(ScopeKind::Project, &self.cwd);
        let project_enabled = settings
            .evolution
            .targets
            .type_enabled(TargetType::ProjectKnowledge);
        let preference_enabled = settings
            .evolution
            .targets
            .type_enabled(TargetType::Preference);
        store_distill_result(
            &runtime,
            &input,
            Some(submission).flatten(),
            &store,
            user_store.as_deref().filter(|_| preference_enabled),
            project_store.as_deref().filter(|_| project_enabled),
        );
        finish_cursor(&store);
    }
}

/// Record a user's edit of a target overlay as explicit evidence for the
/// next distillation (plan section 5.1). `before` and `after` are the
/// overlay contents around the edit; the evidence is redacted and bounded.
pub fn record_overlay_user_edit(
    store: &EvolutionStore,
    key: &TargetKey,
    before: &OverlayContent,
    after: &OverlayContent,
    evidence_ttl_days: u32,
) -> Result<Option<String>, kcoder_evolution::EvolutionError> {
    let removed: Vec<&str> = before
        .lessons
        .lines()
        .filter(|line| !after.lessons.contains(line.trim()))
        .collect();
    let added: Vec<&str> = after
        .lessons
        .lines()
        .filter(|line| !before.lessons.contains(line.trim()))
        .collect();
    if removed.is_empty() && added.is_empty() {
        return Ok(None);
    }
    let text = super::redacted_snippet(
        &format!(
            "overlay edited by the user\nremoved:\n{}\nadded:\n{}",
            removed.join("\n"),
            added.join("\n")
        ),
        3500,
    );
    let id = store.put_evidence(&text, now_ms(), evidence_ttl_days)?;
    store.update_state(|state| {
        let cursor = state.distill.entry(key.clone()).or_default();
        if !cursor.user_edit_evidence.contains(&id) {
            cursor.user_edit_evidence.push(id.clone());
        }
        let excess = cursor
            .user_edit_evidence
            .len()
            .saturating_sub(kcoder_evolution::USER_EDIT_EVIDENCE_MAX);
        cursor.user_edit_evidence.drain(..excess);
    })?;
    Ok(Some(id))
}
