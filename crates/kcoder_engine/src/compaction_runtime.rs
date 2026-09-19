use super::*;
use crate::context::tokens::StaticPrefixMeasurement;

#[derive(Debug, Default)]
pub(super) struct AutoCompactState {
    consecutive_failures: usize,
    /// Monotonic compaction-check sequence. A top-level user message resets the
    /// engine's internal `turn_count` to 1, so cooldown cannot depend directly on caller turn numbers.
    check_sequence: usize,
    last_compact_check_sequence: Option<usize>,
    /// Token counts of the last successful auto-compaction, kept so the turn
    /// loop can surface them as a user-visible notice (the lifecycle logs
    /// themselves stay at debug level).
    last_pre_compact_tokens: usize,
    last_post_compact_tokens: usize,
    /// Background "prefire" summary (pass-1 of the two-pass scheme): produced
    /// while the conversation is still below the threshold so the threshold
    /// pass only has to summarize the newer delta.
    prefire_note: Option<crate::context::PrefireNote>,
    prefire_in_flight: bool,
    prefire_idle_reserved: Arc<AtomicBool>,
    prefire_scope: Arc<()>,
    prefire_job: Option<PrefireJob>,
    /// Set when the last compaction consumed the prefire note; surfaced in the
    /// user-visible notice, then cleared.
    prefire_was_used: bool,
    /// System/tools static-prefix fingerprint computed before the previous send.
    last_static_prefix_fingerprint: Option<u64>,
    /// Local estimate of the system/tools static prefix in the most recent complete request.
    last_static_prefix_tokens: Option<usize>,
    /// Failure from the most recent automatic compaction check; cleared after one event-loop read.
    last_failure: Option<(String, Option<crate::context::CompactionFailureDetails>)>,
    /// Protocol diagnostic recovered by a repair retry and waiting to enter the event stream.
    recovered_protocol_diagnostics: Vec<crate::context::CompactionFailureDetails>,
    /// Recovered summary-provider retry waiting to enter the event stream.
    recovered_provider_retries: Vec<crate::ProviderRetryDetails>,
}

#[derive(Debug)]
struct PrefireJob {
    token: Arc<()>,
    abort: Option<tokio::task::AbortHandle>,
}

pub(crate) struct PrefireIdleReservation {
    reserved: Arc<AtomicBool>,
    committed: bool,
}

impl PrefireIdleReservation {
    pub(crate) fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for PrefireIdleReservation {
    fn drop(&mut self) {
        if !self.committed {
            self.reserved.store(false, Ordering::SeqCst);
        }
    }
}

impl AutoCompactState {
    fn cancel_prefire(&mut self) -> Option<PrefireJob> {
        // Replacing the identity invalidates both prepared work and late results.
        self.prefire_scope = Arc::new(());
        self.prefire_in_flight = false;
        self.prefire_note = None;
        self.prefire_job.take()
    }
}

/// Only engine clones own this lease; background futures must never retain it.
pub(super) struct PrefireOwner {
    state: Arc<RwLock<AutoCompactState>>,
}

impl PrefireOwner {
    pub(super) fn new(state: Arc<RwLock<AutoCompactState>>) -> Self {
        Self { state }
    }

    pub(super) fn cancel(&self) {
        let job = recover_write_lock(&self.state, "auto_compact_state").cancel_prefire();
        if let Some(abort) = job.and_then(|job| job.abort) {
            abort.abort();
        }
    }
}

impl Drop for PrefireOwner {
    fn drop(&mut self) {
        self.cancel();
    }
}

struct PrefireTaskGuard {
    state: std::sync::Weak<RwLock<AutoCompactState>>,
    token: Arc<()>,
}

impl PrefireTaskGuard {
    fn is_current(&self, state: &AutoCompactState) -> bool {
        state
            .prefire_job
            .as_ref()
            .is_some_and(|job| Arc::ptr_eq(&job.token, &self.token))
    }
}

impl Drop for PrefireTaskGuard {
    fn drop(&mut self) {
        if let Some(state) = self.state.upgrade() {
            let mut state = recover_write_lock(&state, "auto_compact_state");
            if self.is_current(&state) {
                let job = state.prefire_job.take();
                state.prefire_in_flight = false;
                drop(state);
                drop(job);
            }
        }
    }
}

impl QueryEngine {
    pub(crate) fn try_reserve_prefire_idle(&self) -> Option<PrefireIdleReservation> {
        let state = self.auto_compact_state.try_write().ok()?;
        if state.prefire_in_flight
            || state.prefire_job.is_some()
            || state.prefire_idle_reserved.load(Ordering::SeqCst)
        {
            return None;
        }
        state.prefire_idle_reserved.store(true, Ordering::SeqCst);
        Some(PrefireIdleReservation {
            reserved: Arc::clone(&state.prefire_idle_reserved),
            committed: false,
        })
    }
    pub(crate) fn prefire_resource_registered(&self) -> Option<bool> {
        self.auto_compact_state
            .try_read()
            .ok()
            .map(|state| state.prefire_in_flight || state.prefire_job.is_some())
    }
    pub(super) fn note_static_prefix(
        &self,
        request: &MessagesRequest,
    ) -> (bool, StaticPrefixMeasurement) {
        let measurement = self.tool_serialization_cache.measure(request);
        let fingerprint = measurement.fingerprint();
        let mut state = recover_write_lock(&self.auto_compact_state, "auto_compact_state");
        let changed = state.last_static_prefix_fingerprint != Some(fingerprint);
        state.last_static_prefix_fingerprint = Some(fingerprint);
        state.last_static_prefix_tokens = Some(measurement.padded_tokens());
        (changed, measurement)
    }

    /// Ignore stale usage anchors for messages reordered by Session Memory, then add the most recently known static prefix.
    fn projected_full_context_tokens(&self, messages: &[Message]) -> usize {
        let static_tokens = recover_read_lock(&self.auto_compact_state, "auto_compact_state")
            .last_static_prefix_tokens;
        match static_tokens {
            Some(static_tokens) => static_tokens
                .saturating_add(TokenCounter::estimate_messages_without_usage(messages)),
            None => TokenCounter::count(messages),
        }
    }
    /// Force a full context compaction regardless of current token count.
    ///
    /// Used by the `/compact` slash command.
    pub async fn compact_conversation(&self) -> Result<crate::context::CompactionResult> {
        self.perform_compaction_with_trigger(true, true, false)
            .await
            .map_err(|e| {
                warn!("manual full compaction failed: {}", e);
                e
            })
    }

    /// Token counts (pre, post) of the last successful auto-compaction, for
    /// surfacing compaction lifecycle in user-visible notices.
    pub fn last_auto_compact_tokens(&self) -> (usize, usize) {
        let state = recover_read_lock(&self.auto_compact_state, "auto_compact_state");
        (
            state.last_pre_compact_tokens,
            state.last_post_compact_tokens,
        )
    }

    /// Whether the last auto-compaction consumed a background prefire note
    /// (two-pass scheme); reading the flag clears it for the next notice.
    pub fn take_prefire_used_flag(&self) -> bool {
        let mut state = recover_write_lock(&self.auto_compact_state, "auto_compact_state");
        std::mem::take(&mut state.prefire_was_used)
    }

    /// Take the latest automatic compaction failure so later subturns do not report the same diagnostic repeatedly.
    pub fn take_auto_compact_failure(
        &self,
    ) -> Option<(String, Option<crate::context::CompactionFailureDetails>)> {
        recover_write_lock(&self.auto_compact_state, "auto_compact_state")
            .last_failure
            .take()
    }

    pub fn take_recovered_compaction_diagnostics(
        &self,
    ) -> Vec<crate::context::CompactionFailureDetails> {
        std::mem::take(
            &mut recover_write_lock(&self.auto_compact_state, "auto_compact_state")
                .recovered_protocol_diagnostics,
        )
    }

    pub fn take_recovered_compaction_provider_retries(&self) -> Vec<crate::ProviderRetryDetails> {
        std::mem::take(
            &mut recover_write_lock(&self.auto_compact_state, "auto_compact_state")
                .recovered_provider_retries,
        )
    }

    /// Compact conversation history when it grows too long.
    ///
    /// Implements a layered strategy similar to KCoder:
    /// 1. Persist oversized tool results to disk (replace with preview).
    /// 2. Micro-compact stale tool results from whitelisted tools.
    /// 3. If still over budget, summarize older API rounds while preserving the
    ///    most recent turns and tool context.
    ///
    /// Returns `true` if a full compaction was performed.
    pub async fn maybe_compact_conversation(&self, turn_count: usize) -> bool {
        if recover_read_lock(&self.settings, "settings").training_mode {
            return false;
        }
        {
            let mut state = recover_write_lock(&self.auto_compact_state, "auto_compact_state");
            state.last_failure = None;
            state.recovered_protocol_diagnostics.clear();
            state.recovered_provider_retries.clear();
        }
        let check_sequence = {
            let mut state = recover_write_lock(&self.auto_compact_state, "auto_compact_state");
            state.check_sequence = state.check_sequence.saturating_add(1);
            state.check_sequence
        };
        let budget = {
            let settings = recover_read_lock(&self.settings, "settings");
            ContextBudget::from_settings(&settings)
        };
        let current_messages = self.state.messages();
        let model_visible_messages = messages_after_latest_compact_boundary(&current_messages);
        let current_tokens = TokenCounter::count(&model_visible_messages);

        // Threshold check: current messages exceed the auto-compact threshold.
        let over_threshold = current_tokens > budget.auto_compact_threshold();
        let hard = current_tokens >= budget.hard_input_limit();

        // The circuit breaker may suppress soft-compaction cost but must never bypass a true hard-limit condition.
        let breaker_open = {
            let state = recover_read_lock(&self.auto_compact_state, "auto_compact_state");
            state.consecutive_failures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
        };
        if breaker_open && !hard {
            warn!(
                "auto-compact skipped: circuit breaker open after {} consecutive failures",
                MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
            );
            return false;
        }

        if !over_threshold {
            // Below the threshold but within the prefire lead window: warm the
            // pass-1 summary in the background so the threshold pass later
            // only summarizes the delta (grok-style two-pass compaction).
            self.maybe_prefire_compaction(&budget, current_tokens).await;
            return false;
        }

        let turns_since_previous_compact = {
            let state = recover_read_lock(&self.auto_compact_state, "auto_compact_state");
            state
                .last_compact_check_sequence
                .map(|last| check_sequence.saturating_sub(last))
        };
        if !hard
            && let Some(turns_since) = turns_since_previous_compact
            && turns_since < AUTOCOMPACT_COOLDOWN_TURNS
        {
            debug!(
                "auto-compact skipped: previous compaction was {} turn(s) ago",
                turns_since
            );
            return false;
        }

        debug!(
            "auto-compact triggered at turn {}: {} tokens (prefire {}, soft {}, hard {})",
            turn_count,
            current_tokens,
            budget.prefire_threshold(),
            budget.auto_compact_threshold(),
            budget.hard_input_limit()
        );

        match self
            // An automatic hard trigger still runs inexpensive tool-storage and micro
            // layers first. If they reduce actual context below soft, do not force a summary-model call.
            .perform_compaction_with_trigger(false, false, hard)
            .await
        {
            Ok(mut result) => {
                for details in &mut result.protocol_diagnostics {
                    details.phase = if hard {
                        "auto_hard".to_string()
                    } else {
                        "auto_full".to_string()
                    };
                }
                if !result.did_compact {
                    debug!("auto-compact skipped: no older conversation segment available");
                    return false;
                }
                {
                    let mut state =
                        recover_write_lock(&self.auto_compact_state, "auto_compact_state");
                    if result.post_compact_tokens > budget.auto_compact_threshold()
                        && result.post_compact_tokens >= result.pre_compact_tokens
                    {
                        state.consecutive_failures += 1;
                        warn!(
                            "auto-compact did not reduce context ({} -> {} tokens)",
                            result.pre_compact_tokens, result.post_compact_tokens
                        );
                    } else {
                        state.consecutive_failures = 0;
                    }
                    state.last_compact_check_sequence = Some(check_sequence);
                    state.last_pre_compact_tokens = result.pre_compact_tokens;
                    state.last_post_compact_tokens = result.post_compact_tokens;
                    state.prefire_was_used = result.used_prefire;
                    state.last_failure = None;
                    state.recovered_protocol_diagnostics = result.protocol_diagnostics;
                    state.recovered_provider_retries = result.provider_retries;
                }
                debug!(
                    "auto-compacted conversation: {} -> {} tokens",
                    result.pre_compact_tokens, result.post_compact_tokens
                );
                true
            }
            Err(e) => {
                warn!("auto-compact failed: {}", e);
                let mut details = crate::context::compact::compaction_protocol_details(&e);
                if let Some(details) = details.as_mut() {
                    details.phase = if hard {
                        "auto_hard".to_string()
                    } else {
                        "auto_full".to_string()
                    };
                }
                {
                    let mut state =
                        recover_write_lock(&self.auto_compact_state, "auto_compact_state");
                    state.consecutive_failures += 1;
                    state.last_failure = Some((e.to_string(), details));
                }
                false
            }
        }
    }

    /// Apply the reference cold-cache optimization once at the beginning of a
    /// main-thread user turn. Sub-agents are intentionally excluded because
    /// their short-lived contexts do not represent an idle resumable session.
    pub(super) fn maybe_apply_time_based_micro_compact(&self) -> usize {
        let settings = {
            recover_read_lock(&self.settings, "settings")
                .time_based_micro_compact
                .clone()
        };
        let config = TimeBasedMicroCompactConfig {
            enabled: settings.enabled,
            gap_threshold_minutes: settings.gap_threshold_minutes,
            keep_recent: settings.keep_recent,
            ..TimeBasedMicroCompactConfig::default()
        };

        let mut messages = self.state.messages();
        let model_visible_start = latest_compact_boundary(&messages)
            .map(|boundary| boundary.summary_index)
            .unwrap_or(0);
        let result = apply_time_based_micro_compact(
            &mut messages[model_visible_start..],
            &config,
            self.state.last_assistant_message_timestamp_ms(),
            current_time_millis(),
        );
        let cleared = result.cleared_tool_use_ids.len();
        if cleared > 0 {
            debug!(
                "time-based micro-compact cleared {} stale tool result(s) after a {} minute gap threshold; kept {} recent result(s)",
                cleared,
                settings.gap_threshold_minutes,
                settings.keep_recent.max(1)
            );
            self.state
                .mark_read_tool_results_compacted(&messages, &result.cleared_tool_use_ids);
            self.state.set_messages_preserving_history_ids(messages);
        }
        cleared
    }

    /// Warm the pass-1 summary in the background while the conversation is
    /// below the threshold but within one lead window of it. When the
    /// threshold is later crossed, the compaction only summarizes the delta
    /// newer than this note instead of re-reading the whole prefix.
    async fn maybe_prefire_compaction(&self, budget: &ContextBudget, current_tokens: usize) {
        let scope = Arc::clone(
            &recover_read_lock(&self.auto_compact_state, "auto_compact_state").prefire_scope,
        );
        let threshold = budget.auto_compact_threshold();
        let prefire_line = budget.prefire_threshold();
        if current_tokens <= prefire_line || threshold == 0 {
            return;
        }
        // When Session Memory is updating or an existing snapshot should reduce the
        // window below soft, prefire would summarize the same prefix again and is skipped.
        if self.session_memory_update_running.load(Ordering::SeqCst)
            || self.session_memory_projected_below_soft(budget).await
        {
            debug!("prefire skipped: session memory is pending or projected below soft limit");
            return;
        }
        {
            let state = recover_read_lock(&self.auto_compact_state, "auto_compact_state");
            if state.prefire_idle_reserved.load(Ordering::SeqCst)
                || state.prefire_in_flight
                || state.prefire_note.is_some()
                || state.consecutive_failures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
            {
                return;
            }
        }

        let messages = self.state.messages();
        let model_visible = messages_after_latest_compact_boundary(&messages);
        let split = crate::context::compact::split_for_compaction(&model_visible);
        if split.old.is_empty() {
            return;
        }

        let (model, summary_max_tokens) = {
            let settings = recover_read_lock(&self.settings, "settings");
            (
                settings
                    .summary_model
                    .clone()
                    .filter(|model| !model.trim().is_empty())
                    .unwrap_or_else(|| settings.model.clone()),
                settings.summary_max_tokens.max(1),
            )
        };
        let provider = self.current_provider();
        let debug_id = self.state.session_id();
        let budget_copy = *budget;
        let usage_state = self.state.clone();
        let token = Arc::new(());
        {
            let mut state = recover_write_lock(&self.auto_compact_state, "auto_compact_state");
            if !Arc::ptr_eq(&state.prefire_scope, &scope)
                || state.prefire_idle_reserved.load(Ordering::SeqCst)
                || state.prefire_in_flight
                || state.prefire_note.is_some()
                || state.consecutive_failures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
            {
                return;
            }
            // Reserve before spawn: even synchronous shutdown can find its token.
            state.prefire_job = Some(PrefireJob {
                token: Arc::clone(&token),
                abort: None,
            });
            state.prefire_in_flight = true;
        }
        // Construct outside the future so cancellation before its first poll cleans up too.
        let guard = PrefireTaskGuard {
            state: Arc::downgrade(&self.auto_compact_state),
            token: Arc::clone(&token),
        };
        let (start, ready) = tokio::sync::oneshot::channel();
        // A closed runtime may synchronously drop the future inside spawn.
        // Never hold the cleanup lock here, and gate provider work on registration.
        let handle = tokio::spawn(async move {
            let guard = guard;
            if ready.await.is_err() {
                return;
            }
            let covered = split.old.len();
            let compactor = ConversationCompactor::new(provider, budget_copy)
                .with_request_class(crate::request_admission::RequestClass::Prefire)
                .with_usage_tracking(usage_state);
            let outcome = compactor
                .summarize_old_messages(
                    &split.old,
                    &model,
                    summary_max_tokens,
                    None,
                    Some(&debug_id),
                )
                .await;
            // Hash the immutable source outside the lifecycle lock.
            let outcome =
                outcome.map(|summary| crate::context::PrefireNote::new(&split.old, summary));
            let Some(state_handle) = guard.state.upgrade() else {
                return;
            };
            let mut state = recover_write_lock(&state_handle, "auto_compact_state");
            if !guard.is_current(&state) {
                return;
            }
            match outcome {
                Ok(note) => {
                    debug!(
                        "background prefire compaction completed: {} messages pre-summarized",
                        covered
                    );
                    state.prefire_note = Some(note);
                }
                Err(error) => {
                    debug!("background prefire compaction failed (will use full pass): {error}");
                }
            }
        });
        {
            let mut state = recover_write_lock(&self.auto_compact_state, "auto_compact_state");
            let reservation = state
                .prefire_job
                .as_mut()
                .filter(|job| Arc::ptr_eq(&job.token, &token));
            let Some(job) = reservation else {
                drop(state);
                handle.abort();
                return;
            };
            job.abort = Some(handle.abort_handle());
        }
        // A closed receiver means the task guard is already reclaiming the reservation.
        let _ = start.send(());
    }

    async fn session_memory_projected_below_soft(&self, budget: &ContextBudget) -> bool {
        let settings = {
            recover_read_lock(&self.settings, "settings")
                .session_memory
                .clone()
        };
        if !settings.enabled || !settings.compact_enabled {
            return false;
        }
        let messages = self.state.messages();
        let snapshot = self.state.session_memory();
        let path = snapshot
            .as_ref()
            .map(|value| value.summary_path.clone())
            .or_else(|| self.state.session_memory_summary_path());
        let Some(path) = path else {
            return false;
        };
        let Ok(summary) = fs::read_to_string(path) else {
            return false;
        };
        if summary.trim().is_empty()
            || summary.trim() == DEFAULT_SESSION_MEMORY_TEMPLATE.trim()
            || !session_memory_has_required_sections(&summary)
        {
            return false;
        }
        build_session_memory_compaction_plan(
            &summary,
            &messages,
            &settings,
            snapshot.as_ref().map(|value| value.updated_message_count),
        )
        .is_some_and(|plan| {
            self.projected_full_context_tokens(&plan.messages) <= budget.auto_compact_threshold()
        })
    }

    /// Shared compaction pipeline used by both manual and auto-compact.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) async fn perform_compaction(
        &self,
        force: bool,
    ) -> Result<crate::context::CompactionResult> {
        self.perform_compaction_with_trigger(force, force, false)
            .await
    }

    /// Run layered compaction while treating soft-check bypass and manual user initiation as independent decisions.
    pub(super) async fn perform_compaction_with_trigger(
        &self,
        force: bool,
        manual_trigger: bool,
        emergency_split: bool,
    ) -> Result<crate::context::CompactionResult> {
        self.perform_compaction_with_trigger_and_cancel(
            force,
            manual_trigger,
            emergency_split,
            None,
        )
        .await
    }

    pub(super) async fn perform_compaction_with_trigger_and_cancel(
        &self,
        force: bool,
        manual_trigger: bool,
        emergency_split: bool,
        summary_cancel: Option<CancellationToken>,
    ) -> Result<crate::context::CompactionResult> {
        self.perform_compaction_with_recovery_deadline(
            force,
            manual_trigger,
            emergency_split,
            summary_cancel,
            crate::recovery_deadline::RecoveryDeadline::default(),
        )
        .await
    }

    pub(super) async fn perform_compaction_with_recovery_deadline(
        &self,
        force: bool,
        manual_trigger: bool,
        emergency_split: bool,
        summary_cancel: Option<CancellationToken>,
        deadline: crate::recovery_deadline::RecoveryDeadline,
    ) -> Result<crate::context::CompactionResult> {
        let (model, budget, active_skills, session_memory_settings) = {
            let settings = recover_read_lock(&self.settings, "settings");
            let skills = recover_read_lock(&self.active_skills, "active_skills");
            (
                settings.model.clone(),
                ContextBudget::from_settings(&settings),
                skills.clone(),
                settings.session_memory.clone(),
            )
        };
        let storage = ToolResultStorage::new(self.session_dir());

        let mut messages = self.state.messages();
        let boundary_suffix_start = latest_compact_boundary(&messages)
            .map(|boundary| boundary.suffix_start)
            .unwrap_or(0);
        let mut compactable_suffix = messages.split_off(boundary_suffix_start);
        // Extract bounded attachments before tool storage or micro-compaction rewrites
        // bodies. Otherwise Read results become cleared placeholders before full
        // compaction, leaving the model without content and causing it to reread the
        // entire large file and trigger compaction again.
        let bounded_file_attachments =
            collect_recent_file_attachments(&compactable_suffix, 4, &self.state.cwd());
        let before_storage = TokenCounter::count(&compactable_suffix);

        // Phase 1: enforce per-tool and per-message result storage caps.
        if let Err(e) = storage.enforce_on_messages(&mut compactable_suffix).await {
            warn!("tool result storage enforcement failed: {}", e);
        }
        let after_storage = TokenCounter::count(&compactable_suffix);
        debug!(
            layer = "tool_storage",
            pre_tokens = before_storage,
            post_tokens = after_storage,
            tokens_freed = before_storage.saturating_sub(after_storage),
            "context compaction layer completed"
        );

        // Phase 2 tries micro-compaction on a candidate copy. Commit that cleanup only
        // when inexpensive layers suffice. If a full summary is still required, retain
        // original old ToolResults so the summary provider can read the evidence, then
        // replace old segments only after the summary commits successfully.
        let mut micro_compacted_suffix = compactable_suffix.clone();
        let micro_result =
            apply_micro_compact(&mut micro_compacted_suffix, &MicroCompactConfig::default());
        let after_micro = TokenCounter::count(&micro_compacted_suffix);
        debug!(
            layer = "threshold_micro_compact",
            pre_tokens = after_storage,
            post_tokens = after_micro,
            tokens_freed = after_storage.saturating_sub(after_micro),
            "context compaction layer completed"
        );

        let mut micro_compacted_messages = messages.clone();
        micro_compacted_messages.extend(micro_compacted_suffix);
        let micro_visible_messages =
            messages_after_latest_compact_boundary(&micro_compacted_messages);
        let post_micro_tokens = TokenCounter::count(&micro_visible_messages);
        let mut semantic_messages = messages.clone();
        semantic_messages.extend(compactable_suffix);
        let semantic_visible_messages = messages_after_latest_compact_boundary(&semantic_messages);
        let pre_compact_tokens = TokenCounter::count(&semantic_visible_messages);

        // Phase 3: full compaction if the cheap candidate remains over budget
        // (or a manual `/compact` explicitly requested a summary).
        if !force
            && !ContextManager::needs_compaction(
                &micro_visible_messages,
                budget.auto_compact_threshold(),
            )
        {
            self.state.mark_read_tool_results_compacted(
                &micro_compacted_messages,
                &micro_result.cleared_tool_use_ids,
            );
            self.state
                .set_messages_and_save_history(micro_compacted_messages)
                .await?;
            return Ok(crate::context::CompactionResult {
                messages: self.state.messages(),
                summary: String::new(),
                pre_compact_tokens,
                post_compact_tokens: post_micro_tokens,
                did_compact: false,
                used_prefire: false,
                protocol_diagnostics: Vec::new(),
                provider_retries: Vec::new(),
            });
        }

        // The micro candidate is used only to assess inexpensive layers. A full
        // summary must use storage-protected semantic bodies that micro-compaction has not cleared.
        messages = semantic_messages;

        let (pre_instructions, pre_error) = self
            .run_compact_hooks(kcoder_hooks::HookEvent::PreCompact, None)
            .await;
        if let Some(error) = pre_error {
            return Err(anyhow::anyhow!(
                "PreCompact hook blocked compaction: {}",
                error
            ));
        }

        let has_custom_compact_instructions = pre_instructions
            .as_deref()
            .map(str::trim)
            .is_some_and(|instructions| !instructions.is_empty());
        if session_memory_settings.enabled
            && session_memory_settings.compact_enabled
            && !has_custom_compact_instructions
        {
            if deadline.is_active() {
                let cancel = summary_cancel
                    .clone()
                    .unwrap_or_else(|| self.cancel_token());
                // This only observes the shared update; dropping the wait must
                // not cancel that task or interrupt any later commit protocol.
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => anyhow::bail!("reactive compaction cancelled by user"),
                    _ = deadline.elapsed() => anyhow::bail!(crate::recovery_deadline::DEADLINE_ERROR),
                    _ = self.wait_for_session_memory_update_before_compact() => {},
                }
            } else {
                self.wait_for_session_memory_update_before_compact().await;
            }
            let session_memory_snapshot = self.state.session_memory();
            let memory_path = session_memory_snapshot
                .as_ref()
                .map(|snapshot| snapshot.summary_path.clone())
                .unwrap_or_else(|| {
                    self.state.session_memory_summary_path().unwrap_or_else(|| {
                        kcoder_state::session_memory_summary_path(
                            &self.cwd,
                            &self.state.session_id(),
                        )
                    })
                });
            match fs::read_to_string(&memory_path) {
                Ok(summary)
                    if !summary.trim().is_empty()
                        && summary.trim() != DEFAULT_SESSION_MEMORY_TEMPLATE.trim()
                        && session_memory_has_required_sections(&summary) =>
                {
                    if let Some(plan) = build_session_memory_compaction_plan(
                        &summary,
                        &messages,
                        &session_memory_settings,
                        session_memory_snapshot
                            .as_ref()
                            .map(|snapshot| snapshot.updated_message_count),
                    ) {
                        let post_compact_tokens =
                            self.projected_full_context_tokens(&plan.messages);
                        if post_compact_tokens > budget.auto_compact_threshold() {
                            warn!(
                                "session-memory compact would still exceed context threshold ({} > {}); falling back to summary compact",
                                post_compact_tokens,
                                budget.auto_compact_threshold()
                            );
                        } else {
                            let covered_message_count = session_memory_rebased_message_count(
                                &plan,
                                &session_memory_snapshot,
                                &messages,
                            );
                            let mut result = crate::context::CompactionResult {
                                messages: plan.messages,
                                summary: format!("Session memory compact:\n{}", summary.trim()),
                                pre_compact_tokens,
                                post_compact_tokens,
                                did_compact: true,
                                used_prefire: false,
                                protocol_diagnostics: Vec::new(),
                                provider_retries: Vec::new(),
                            };

                            let (post_instructions, post_error) = self
                                .run_compact_hooks(kcoder_hooks::HookEvent::PostCompact, None)
                                .await;
                            if let Some(error) = post_error {
                                return Err(anyhow::anyhow!(
                                    "PostCompact hook blocked compaction: {}",
                                    error
                                ));
                            }

                            let attachments = PostCompactAttachments {
                                memory_text: String::new(),
                                active_skills: active_skills.clone(),
                                project_md_digest: String::new(),
                                plan_mode_instructions: self.state.plan_mode(),
                                post_compact_instructions: post_instructions,
                                orchestrate_context: if self.state.session_mode().is_orchestrate() {
                                    let settings =
                                        recover_read_lock(&self.settings, "settings").clone();
                                    crate::orchestrate::input::post_compact_context(
                                        &self.cwd, &settings,
                                    )
                                    .ok()
                                    .flatten()
                                } else {
                                    None
                                },
                            };
                            let mut attachment_messages = attachments.into_messages();
                            attachment_messages.extend(bounded_file_attachments.clone());
                            if !attachment_messages.is_empty() {
                                let mut messages_with_attachments = result.messages.clone();
                                messages_with_attachments.extend(attachment_messages);
                                let tokens_with_attachments =
                                    self.projected_full_context_tokens(&messages_with_attachments);
                                if tokens_with_attachments > budget.auto_compact_threshold() {
                                    warn!(
                                        "session-memory compact attachments would exceed context threshold ({} > {}); skipping attachment reinjection",
                                        tokens_with_attachments,
                                        budget.auto_compact_threshold()
                                    );
                                } else {
                                    result.messages = messages_with_attachments;
                                    result.post_compact_tokens = tokens_with_attachments;
                                }
                            }

                            if result.post_compact_tokens > budget.auto_compact_threshold() {
                                warn!(
                                    "session-memory compact would still exceed context threshold ({} > {}); falling back to summary compact",
                                    result.post_compact_tokens,
                                    budget.auto_compact_threshold()
                                );
                            } else {
                                self.attach_transcript_path_to_compact_summary(
                                    &mut result.messages,
                                );
                                result.post_compact_tokens =
                                    self.projected_full_context_tokens(&result.messages);
                                self.rebase_session_memory_snapshot_after_compact(
                                    session_memory_snapshot.as_ref(),
                                    covered_message_count,
                                    result.post_compact_tokens,
                                );
                                let transcript_event =
                                    Self::compaction_transcript_event(manual_trigger, &result);
                                self.state
                                    .set_messages_after_compaction(
                                        result.messages.clone(),
                                        transcript_event,
                                    )
                                    .await?;
                                self.prefire_owner.cancel();
                                return Ok(result);
                            }
                        }
                    }
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => warn!(
                    "failed to read session-memory summary {:?}: {}",
                    memory_path, error
                ),
            }
        }

        let (summary_model, _, summary_max_tokens, summary_provider) = self.summary_runtime()?;
        let compactor = ConversationCompactor::new(summary_provider, budget)
            .with_usage_tracking(self.state.clone());
        let prefire_note = {
            let mut state = recover_write_lock(&self.auto_compact_state, "auto_compact_state");
            state.prefire_note.take()
        };
        let compact = compactor.compact(
            CompactionRequest {
                messages: messages.clone(),
                model,
                summary_model,
                summary_max_tokens,
                custom_instructions: pre_instructions,
                debug_session_id: Some(self.state.session_id()),
                prefire: prefire_note,
                emergency_split,
            },
            pre_compact_tokens,
        );
        // Only summary generation is interruptible. Once it finishes, preserve
        // the complete commit protocol, including post-flush sidecar persistence.
        let result = match summary_cancel {
            Some(cancel) => tokio::select! {
                biased;
                _ = cancel.cancelled() => Err(anyhow::anyhow!("reactive compaction cancelled by user")),
                _ = deadline.elapsed() => Err(anyhow::anyhow!(crate::recovery_deadline::DEADLINE_ERROR)),
                result = compact => result,
            },
            None => tokio::select! {
                biased;
                _ = deadline.elapsed() => Err(anyhow::anyhow!(crate::recovery_deadline::DEADLINE_ERROR)),
                result = compact => result,
            },
        };
        match result {
            Ok(mut result) => {
                if result.did_compact {
                    let session_memory_snapshot = self.state.session_memory();
                    let (post_instructions, post_error) = self
                        .run_compact_hooks(kcoder_hooks::HookEvent::PostCompact, None)
                        .await;
                    if let Some(error) = post_error {
                        return Err(anyhow::anyhow!(
                            "PostCompact hook blocked compaction: {}",
                            error
                        ));
                    }

                    // Re-inject essential context lost across the boundary.
                    let attachments = PostCompactAttachments {
                        memory_text: String::new(),
                        active_skills,
                        project_md_digest: String::new(),
                        plan_mode_instructions: self.state.plan_mode(),
                        post_compact_instructions: post_instructions,
                        orchestrate_context: if self.state.session_mode().is_orchestrate() {
                            let settings = recover_read_lock(&self.settings, "settings").clone();
                            crate::orchestrate::input::post_compact_context(&self.cwd, &settings)
                                .ok()
                                .flatten()
                        } else {
                            None
                        },
                    };
                    let mut attachment_messages = attachments.into_messages();
                    attachment_messages.extend(bounded_file_attachments);
                    if !attachment_messages.is_empty() {
                        let mut with_attachments = result.messages.clone();
                        with_attachments.extend(attachment_messages);
                        let with_attachment_tokens = TokenCounter::count(&with_attachments);
                        if with_attachment_tokens > budget.auto_compact_threshold() {
                            warn!(
                                "traditional compact attachments would exceed context threshold ({} > {}); skipping attachment reinjection",
                                with_attachment_tokens,
                                budget.auto_compact_threshold()
                            );
                        } else {
                            result.messages = with_attachments;
                            result.post_compact_tokens = with_attachment_tokens;
                        }
                    }
                    self.attach_transcript_path_to_compact_summary(&mut result.messages);
                    result.post_compact_tokens = TokenCounter::count(&result.messages);
                    self.rebase_session_memory_snapshot_after_compact(
                        session_memory_snapshot.as_ref(),
                        0,
                        result.post_compact_tokens,
                    );
                }

                if result.did_compact {
                    self.state
                        .set_messages_after_compaction(
                            result.messages.clone(),
                            Self::compaction_transcript_event(manual_trigger, &result),
                        )
                        .await?;
                } else {
                    self.state
                        .set_messages_and_save_history(result.messages.clone())
                        .await?;
                }
                Ok(result)
            }
            Err(e) => Err(e),
        }
    }

    fn compaction_transcript_event(
        force: bool,
        result: &crate::context::CompactionResult,
    ) -> CompactionTranscriptEvent {
        CompactionTranscriptEvent {
            trigger: if force {
                CompactionTrigger::Manual
            } else {
                CompactionTrigger::Auto
            },
            pre_tokens: result.pre_compact_tokens,
            post_tokens: result.post_compact_tokens,
            summary: result.summary.clone(),
        }
    }

    fn attach_transcript_path_to_compact_summary(&self, messages: &mut [Message]) {
        let Some(transcript_path) = self.state.history_path() else {
            return;
        };
        let Some(Message::User { content }) = messages.first_mut() else {
            return;
        };
        let Some(ContentBlock::Text { text }) = content.first_mut() else {
            return;
        };
        let is_compact_summary = text.starts_with(COMPACT_CONTINUATION_PREFIX)
            || text.starts_with(crate::context::compact::COMPACT_BOUNDARY_MARKER);
        if !is_compact_summary || text.contains("read the full transcript at:") {
            return;
        }
        let hint = format!(
            "\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: {}",
            transcript_path.display()
        );
        if let Some(index) = text.find("\n\nRecent messages are preserved verbatim.") {
            text.insert_str(index, &hint);
        } else {
            text.push_str(&hint);
        }
    }

    fn rebase_session_memory_snapshot_after_compact(
        &self,
        snapshot: Option<&SessionMemorySnapshot>,
        updated_message_count: usize,
        updated_model_tokens: usize,
    ) {
        let Some(snapshot) = snapshot else {
            return;
        };
        self.state.set_session_memory(SessionMemorySnapshot::new(
            snapshot.summary_path.clone(),
            updated_message_count,
            updated_model_tokens,
            snapshot.update_count,
            snapshot.source.clone(),
        ));
    }
}

fn session_memory_rebased_message_count(
    plan: &SessionMemoryCompactionPlan,
    snapshot: &Option<SessionMemorySnapshot>,
    original_messages: &[Message],
) -> usize {
    let Some(snapshot) = snapshot.as_ref() else {
        return 1;
    };
    let preserved_absolute_start = plan.suffix_start.saturating_add(plan.preserved_start);
    let covered_preserved = snapshot
        .updated_message_count
        .saturating_sub(preserved_absolute_start)
        .min(
            original_messages
                .len()
                .saturating_sub(preserved_absolute_start),
        );
    1 + covered_preserved
}

#[cfg(test)]
#[path = "tests/compaction_runtime_unit.rs"]
mod tests;
