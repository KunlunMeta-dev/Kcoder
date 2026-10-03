//! Stream response within the shared engine ownership boundary.

use super::*;

impl QueryEngine {
    pub(super) fn run_turn_stream_with_cancel_and_max_turns<'a, P: PermissionPrompt>(
        &self,
        prompt: &'a P,
        cancel_token: CancellationToken,
        max_turns: usize,
        finish_reminder: Option<SubagentFinishReminder>,
        prepared_steer_session: Option<TurnSteerSession>,
    ) -> Pin<Box<dyn Stream<Item = EngineEvent> + Send + 'a>> {
        let engine = self.clone().with_cancel_token(cancel_token);
        let is_main_thread = finish_reminder.is_none() && engine.subagent_system_prompt.is_none();
        let moa_turn = if finish_reminder.is_none() {
            engine.take_moa_for_next_turn()
        } else {
            None
        };
        let turn_steer_session = if is_main_thread {
            prepared_steer_session.or_else(|| engine.begin_turn_steering())
        } else {
            None
        };
        Box::pin(stream! {
                    if engine.input_persistence_failed.load(Ordering::Acquire) {
                        yield EngineEvent::Error("Input durability is uncertain; reload this session before continuing.".into());
                        return;
                    }
                    engine.note_foreground_activity();
                    let missing_context_limits = {
                        let settings = recover_read_lock(&engine.settings, "settings");
                        settings.context_window_tokens.is_none() || settings.context_output_headroom.is_none()
                    };
                    if missing_context_limits {
                        yield EngineEvent::Error("Active model context limits are unavailable; configure a Provider before starting a turn.".into());
                        return;
                    }
                    if let Some(goal) = engine.state.goal().filter(|goal| goal.status.is_active()) {
                        engine.state.record_goal_turn_start(&goal.goal_id);
                    }
                    let memory_query = latest_real_user_text(&engine.state);
                    if is_main_thread {
                        engine.inject_trusted_orchestrate_fleet_delta();
                    }
                    let mut turn_count = 1usize;
                    let max_turns = max_turns.max(1);
                    let mut moa_turn = moa_turn;
                    let mut finish_reminder = finish_reminder.map(|reminder| {
                        SubagentFinishReminderState::new(reminder, max_turns)
                    });
                    let mut recent_tools: Vec<String> = Vec::new();
                    let mut touched_paths: Vec<String> = Vec::new();
                    let mut checked_time_based_micro_compact = false;
                    let mut todo_updated_this_turn = false;
                    let mut todo_idle_reminder_sent = false;
                    // Set once the active goal's token budget trips mid-stream: the
                    // in-flight response may finish within a bounded grace, but no
                    // further API call may start in this turn.
                    let mut goal_budget_grace_tokens: Option<u64> = None;
                    // Tracks consecutive assistant messages that carried no visible
                    // text and no tool calls; each triggers a bounded continuation
                    // nudge instead of letting the turn (and a headless session)
                    // silently complete mid-task.
                    let mut consecutive_empty_responses = 0usize;
                    let mut last_response_was_empty = false;
                    // Doom-loop tracking: consecutive identical (name, input) tool
                    // calls across sub-turns. Per-tool limits come from settings so
                    // legitimate polling tools can opt out without source changes.
                    let mut doom_streak: (Option<String>, usize, bool) = (None, 0, false);
        // In dont-ask mode, aggregate related permission denials by capability so the model cannot blindly retry under another tool name.
                    let mut permission_denial_streak: (Option<String>, usize) = (None, 0);
                    // Consecutive 429 streak for the dedicated smaller retry budget.
                    let mut rate_limit_streak = 0usize;
                    // Optional wall-clock turn budget (soft deadline): at ~90% the
                    // model is nudged once to wrap up with its current best result;
                    // at 100% the turn ends at the next sub-turn boundary instead of
                    // being killed mid-flight by an external timeout. When a single
                    // long response consumed the whole budget so the nudge never
                    // fired, the model gets exactly one bounded closing sub-turn to
                    // land deliverables before the turn ends.
                    let turn_started_at = Instant::now();
                    let max_duration = {
                        let settings = recover_read_lock(&engine.settings, "settings");
                        settings.max_duration_secs.map(std::time::Duration::from_secs)
                    };
                    let (doom_loop_settings, permission_denial_limit, stop_on_permission_denial) = {
                        let settings = recover_read_lock(&engine.settings, "settings");
                        (
                            settings.tool_limits.doom_loop.clone(),
                            settings
                                .tool_limits
                                .permission_denials
                                .consecutive_limit
                                .max(1),
                            settings.permission_mode == kcoder_config::PermissionMode::DontAsk,
                        )
                    };
                    let wrap_up_notice_at = max_duration.map(|d| d.mul_f32(0.9));
                    let mut duration_wrap_up_injected = false;
                    let mut duration_final_subturn_granted = false;
                    let mut hard_gate_compactions = 0usize;
                    let mut reactive_compact_retries = 0usize;
                    // Request rebuilds after compaction share the same retry budget.
                    let mut attempt = 0usize;
                    let mut recovery_disable_reasoning = false;
                    // Published output remains unsafe to replay across retries and request rebuilds.
                    let mut provider_output_published = false;
                    let mut recovery_deadline = recovery_deadline::RecoveryDeadline::default();
                    let mut recovery_record = recovery_record::RecoveryRecord::default();
                    let mut turn_steer_session = turn_steer_session;
                    let mut can_drain_turn_steers = false;
                    let mut terminal_verdict_prompt_injected = false;
                    let mut subagent_deliveries_ready_for_next_request = false;
                    // Main-thread turns own background delivery claims while the
                    // stream is alive; host watch loops check `turn_driver_active()`
                    // and stay idle. Sub-agent turns (is_main_thread == false) never
                    // set the signal, so a long-running background agent cannot mask
                    // the parent's watchers.
                    let _turn_driver_guard = is_main_thread
                        .then(|| crate::turn_driver::TurnDriverActiveGuard::new(&engine));

                    'turn_loop: loop {
                        tokio::select! {
                            biased;
                            _ = engine.cancel_token().cancelled_owned() => {
                                recovery_record.stop(RecoveryOutcome::Cancelled);
                                yield EngineEvent::StreamAborted { reason: "cancelled by user".into() };
                                return;
                            }
                            _ = recovery_deadline.elapsed() => {
                                recovery_record.stop(RecoveryOutcome::DeadlineExceeded);
                                yield EngineEvent::Error(recovery_deadline::DEADLINE_ERROR.into());
                                return;
                            }
                            _ = recovery_record.ensure_started(&engine.state) => {}
                        }
                        if let Some(event) = recovery_deadline.stop_event(&engine.cancel_token()) {
                            recovery_record.stopped(&event);
                            yield event;
                            break;
                        }
                        if engine.is_cancelled() {
                            yield EngineEvent::StreamAborted {
                                reason: "cancelled by user".into(),
                            };
                            break;
                        }
                        match engine.prepare_subagent_safe_boundary() {
                            Ok(Some(mode)) => {
                                yield EngineEvent::StreamAborted {
                                    reason: format!("agent_control:{mode}"),
                                };
                                break;
                            }
                            Ok(None) => {}
                            Err(error) => {
                                yield EngineEvent::Error(format!(
                                    "failed to apply sub-agent control at safe boundary: {error:#}"
                                ));
                                break;
                            }
                        }
                        if subagent_deliveries_ready_for_next_request {
                            subagent_deliveries_ready_for_next_request = false;
                        } else {
                            match engine
                                .apply_pending_subagent_deliveries_at_safe_boundary()
                                .await
                            {
                                Ok(applied) => {
                                    for steer in applied {
                                        yield EngineEvent::SubagentSteerApplied {
                                            agent_id: steer.agent_id,
                                            message_id: steer.message_id,
                                            queue_depth: steer.queue_depth,
                                        };
                                    }
                                }
                                Err(error) => {
                                    yield EngineEvent::Error(format!(
                                        "failed to apply queued sub-agent message at safe boundary: {error:#}"
                                    ));
                                    break;
                                }
                            }
                        }

                        if let (Some(limit), Some(warn_at)) = (max_duration, wrap_up_notice_at) {
                            let elapsed = turn_started_at.elapsed();
                            if elapsed >= limit {
                                if !duration_wrap_up_injected {
                                    // The budget is exhausted but the wrap-up nudge
                                    // never fired (a single long response consumed it
                                    // whole). Inject a final wrap-up nudge and fall
                                    // through so the model gets exactly one bounded
                                    // closing sub-turn to land deliverables; the next
                                    // boundary check ends the turn unconditionally.
                                    duration_wrap_up_injected = true;
                                    duration_final_subturn_granted = true;
                                    yield EngineEvent::SystemNotice(
                                        "Max duration reached; sending one final wrap-up nudge before ending the turn."
                                            .to_string(),
                                    );
                                    engine.state.add_message(Message::runtime_text(
                                        "<system-reminder>The time budget for this task is now fully exhausted. This is your LAST action window. Your wrap-up must preserve every original task constraint. If the task is read-only or forbids file changes, do not create or modify any file; return the best incomplete summary in the assistant answer instead. Only when the user explicitly required an output path and file writes are permitted, immediately write the current best version of that deliverable there. Do not start any new investigation or refinement. After this response the turn ends unconditionally.</system-reminder>",
                                    ));
                                } else {
                                    // Hard point of the soft deadline: stop at this
                                    // sub-turn boundary (the tools of the response that
                                    // just finished have already run) instead of being
                                    // killed mid-flight by an external timeout.
                                    yield EngineEvent::SystemNotice(
                                        "Max duration reached; ending the turn gracefully at a tool boundary."
                                            .to_string(),
                                    );
                                    yield EngineEvent::StreamAborted {
                                        reason: "max_duration".to_string(),
                                    };
                                    break;
                                }
                            }
                            if elapsed >= warn_at && !duration_wrap_up_injected {
                                duration_wrap_up_injected = true;
                                yield EngineEvent::SystemNotice(
                                    "Max duration is almost exhausted; wrap-up nudge sent.".to_string(),
                                );
                                engine.state.add_message(Message::runtime_text(
                                    "<system-reminder>The time budget for this task is almost exhausted (about 10% left). Your wrap-up must preserve every original task constraint. If the task is read-only or forbids file changes, do not create or modify any file; return the best incomplete summary in the assistant answer instead. Only when the user explicitly required an output path and file writes are permitted, write the current best version of that deliverable before any other action. Then give a brief final summary of what is done and what remains. Do not start any new investigation.</system-reminder>",
                                ));
                                continue;
                            }
                        }

                        if goal_budget_grace_tokens.is_some() {
                            yield EngineEvent::SystemNotice(
                                "Goal token budget exhausted; no further API calls will start this turn."
                                    .to_string(),
                            );
                            break;
                        }

                        if let Some(reminder) = finish_reminder.as_mut()
                            && let Some(message) = reminder.message_for_turn(turn_count, max_turns)
                        {
                            engine.state.add_message(Message::runtime_text(message));
                        }

        // Goal Pro model escalation: after verifier rejections reach a threshold, switch
        // the primary model by rung before the next provider request while preserving history.
                        if is_main_thread
                            && let Some(notice) = engine.maybe_escalate_goal_model()
                        {
                            engine.state.add_message(Message::runtime_text(format!(
                                "<system-reminder>{notice}</system-reminder>"
                            )));
                            yield EngineEvent::SystemNotice(notice);
                        }

                        let terminal_verdict_turn = engine
                            .terminal_verdict_turn
                            .load(Ordering::SeqCst)
                            && turn_count == max_turns;
                        if terminal_verdict_turn && !terminal_verdict_prompt_injected {
                            terminal_verdict_prompt_injected = true;
                            engine.state.add_message(Message::runtime_text(
                                "[system][verifier_final_verdict] This is the final internal verifier turn. Only the VerifierVote tool is available. Stop investigating and decide from the evidence already collected. Apply this order: PASS when a successful focused candidate-side functional check demonstrates the requested repair, the implementation audit found no gap, and every nonzero broader check was proven baseline-only by the exact same command, raw exit code, and normalized failure evidence; a proven baseline-only failure must not cause FAIL or FLAKY. FAIL for a real implementation gap or a candidate-only/new failure relative to the baseline. FLAKY only when required tests or dependencies were unavailable, the exact candidate/baseline comparison could not be obtained or paired, or no successful candidate-side functional check demonstrated the repair. Submit the decision by calling VerifierVote exactly once: verdict is pass, fail, or flaky; summary is a required one-sentence conclusion; fail and flaky must include a non-empty rejection_reason with the concrete gap and the work the main agent must still do. If the vote fails validation, fix the input and call VerifierVote again. Only when tool calls are unavailable in this environment, the first non-empty line must be exactly PASS, FAIL, or FLAKY, followed by a concise evidence report.",
                            ));
                        }

                        // Incorporate any background jobs that finished while we were not
                        // streaming, and notify listeners.
                        for event in engine.drain_background_jobs_with_hooks().await {
                            yield event;
                        }

        // New input enters context only after a complete provider response and all tools
        // it requested. Never drain before the first request, which would silently merge
        // the turn's initial input with steering that arrived later into one sample.
                        if can_drain_turn_steers {
                            let steers = turn_steer_session
                                .as_ref()
                                .map(TurnSteerSession::drain_pending)
                                .unwrap_or_default();
                            for id in engine.apply_turn_steers(steers) {
                                yield EngineEvent::TurnSteerApplied { id };
                            }
                        }

                        // Recovery rebuilds already compacted this request; do not launch
                        // independent background maintenance inside its absolute deadline.
                        let did_auto_compact = !recovery_deadline.is_active()
                            && engine.maybe_compact_conversation(turn_count).await;
                        for details in engine.take_recovered_compaction_provider_retries() {
                            yield EngineEvent::ProviderRetry(details);
                        }
                        for details in engine.take_recovered_compaction_diagnostics() {
                            yield EngineEvent::CompactionRecovered { details };
                        }
                        let auto_compact_failure = if did_auto_compact {
                            None
                        } else {
                            engine.take_auto_compact_failure()
                        };

        // Cold-session cleanup must run only after token-pressure compaction. Otherwise
        // it replaces old tool results with placeholders before a full summary can see
        // the original evidence. Preserve evidence after a failed full summary as well,
        // allowing the next turn to retry.
                        if is_main_thread && !checked_time_based_micro_compact {
                            checked_time_based_micro_compact = true;
                            if !did_auto_compact && auto_compact_failure.is_none() {
                                engine.maybe_apply_time_based_micro_compact();
                            }
                        }
                        if did_auto_compact {
                            // Surface the compaction in the event stream so JSON and
                            // TUI consumers can observe the lifecycle without
                            // enabling debug logs.
                            let (pre, post) = engine.last_auto_compact_tokens();
                            let prefire_note = if engine.take_prefire_used_flag() {
                                " (background prefire reused)"
                            } else {
                                ""
                            };
                            yield EngineEvent::SystemNotice(format!(
                                "Context auto-compacted: {pre} -> {post} tokens{prefire_note}"
                            ));
                        } else if let Some((error, details)) = auto_compact_failure {
                            yield EngineEvent::CompactionFailed { error, details };
                        }
                        engine.activate_superpowers_root_skill();
                        engine.activate_matching_skills(&touched_paths);
                        engine.inject_active_skill_user_context();
                        let memory_text = {
                            let settings = recover_read_lock(&engine.settings, "settings");
                            engine.memory_manager.to_prompt_text_with_options(
                                memory_query.as_deref(),
                                &recent_tools,
                                20,
                                settings.memory.legacy_prompt_enabled,
                            )
                        };
                        engine.inject_relevant_memory_user_context(&memory_text);

                        // Keep canonical histories shared through request assembly.
                        // Only the established repair path materializes damaged sequences.
                        let background_runs_in_request = engine.state.background_runs_in_current_messages();
                        let (raw_messages_snapshot, _) = engine.state.shared_messages_with_revision();
                        let (mut messages_snapshot, repaired_state) =
                            message_repair::prepare_shared_request_messages(raw_messages_snapshot);
                        if let Some(repaired_state) = repaired_state {
                            debug!(
                                "repaired tool_use/tool_result message ordering before provider request"
                            );
                            engine.state.set_messages(repaired_state);
                        }
                        engine.prepend_project_user_context(&mut messages_snapshot);

                        let (mut model, mut max_tokens, reasoning_effort, active_skills) = {
                            let settings = recover_read_lock(&engine.settings, "settings");
                            let skills = recover_read_lock(&engine.active_skills, "active_skills");
                            (
                                settings.model.clone(),
                                settings.max_tokens.unwrap_or(4096),
                                settings
                                    .model_capabilities
                                    .reasoning
                                    .then(|| settings.model_reasoning_effort.clone())
                                    .flatten(),
                                skills.clone(),
                            )
                        };

                        // The fork snapshot below contains the configured parent's
                        // transcript before any one-shot MoA reference context is
                        // appended. Bind it to that parent runtime now; an MoA
                        // aggregator may replace `model` and `provider_for_turn` only
                        // for this request and must not become the transcript owner.
                        let snapshot_provider = engine.provider_name();
                        let snapshot_model = model.clone();

                        let cache_context_messages = messages_snapshot.clone();
                        let mut provider_for_turn = engine.current_provider();
                        if let Some(turn) = moa_turn.as_ref() {
                            let references = if recovery_deadline.is_active() {
                                // The batch directly owns its FuturesUnordered, queued
                                // semaphore waits and streams; dropping it leaves no workers.
                                tokio::select! {
                                    biased;
                                    _ = engine.cancel_token().cancelled_owned() => {
                                        recovery_record.stop(RecoveryOutcome::Cancelled);
                                        yield EngineEvent::StreamAborted { reason: "cancelled by user".into() };
                                        return;
                                    }
                                    _ = recovery_deadline.elapsed() => {
                                        recovery_record.stop(RecoveryOutcome::DeadlineExceeded);
                                        yield EngineEvent::Error(recovery_deadline::DEADLINE_ERROR.into());
                                        return;
                                    }
                                    batch = engine.collect_moa_reference_batch(turn, &messages_snapshot) => batch,
                                }
                            } else {
                                engine.collect_moa_reference_batch(turn, &messages_snapshot).await
                            };
                            match references {
                                Ok(batch) => {
                                    match build_moa_provider(&batch.settings, &batch.aggregator, engine.client_model_configuration.as_deref()) {
                                        Ok(provider) => {
                                            let reference_count = batch.references.len();
                                            for reference in &batch.references {
                                                yield EngineEvent::MoaReference {
                                                    label: reference.label.clone(),
                                                    text: reference.text.clone(),
                                                    index: reference.index + 1,
                                                    count: reference_count,
                                                };
                                            }
                                            let aggregator = moa_model_label(&batch.aggregator);
                                            let context = moa_reference_context(
                                                &batch.preset_name,
                                                &batch.aggregator,
                                                &batch.references,
                                                !engine.tool_definitions_for_request(terminal_verdict_turn).await.is_empty(),
                                            );
                                            messages_snapshot = append_moa_context(messages_snapshot, &context);
                                            model = batch.aggregator.model.clone();
                                            // The preset's aggregator output cap was
                                            // previously dead config; honor it now.
                                            if let Some(moa_max_tokens) = batch.aggregator_max_tokens {
                                                max_tokens = moa_max_tokens;
                                            }
                                            provider_for_turn = provider;
                                            yield EngineEvent::MoaAggregating { aggregator };
                                        }
                                        Err(error) => {
                                            moa_turn = None;
                                            yield EngineEvent::SystemNotice(format!(
                                                "MoA skipped: failed to build aggregator provider: {}",
                                                error
                                            ));
                                        }
                                    }
                                }
                                Err(error) => {
                                    moa_turn = None;
                                    yield EngineEvent::SystemNotice(format!(
                                        "MoA skipped: {}",
                                        error
                                    ));
                                }
                            }
                        }

                        // Render routing only after the final request capability filter.
                        let tool_defs = engine.tool_definitions_for_request(terminal_verdict_turn).await;
                        let (system_prompt, available_tool_names, max_retries, base_delay_ms) =
                            request_assembly::prepare_request_context(
                                &engine, &model, &tool_defs, cache_context_messages,
                                &active_skills, &snapshot_provider, &snapshot_model, moa_turn.is_none(),
                            );

                        let mut pending_tool_uses: Vec<(String, String, serde_json::Value)> = Vec::new();
                        let mut deferred_background_events: Vec<BackgroundJobEvent> = Vec::new();
                        let mut response_started = false;
                        let provider_transport_started_at = Instant::now();
                        let training_mode =
                            recover_read_lock(&engine.settings, "settings").training_mode;
        // Build the request once outside the retry loop. Training mode also carries the
        // agent depth so the rollout adapter can decide whether to capture sub-agent trajectories.
                        let base_request = MessagesRequest::new_shared(model.clone(), messages_snapshot)
                            .with_path_first_tools(engine.tool_path_previews && !training_mode)
                            .with_system(system_prompt.clone())
                            .with_tools(tool_defs)
                            .with_max_tokens(max_tokens)
                            .with_reasoning_effort(reasoning_effort.clone())
                            .with_debug_session_id(engine.state.session_id());
                        let base_request = if training_mode {
                            base_request.with_trajectory_agent_depth(engine.agent_depth())
                        } else {
                            base_request
                        };
                        let budget = {
                            let settings = recover_read_lock(&engine.settings, "settings");
                            ContextBudget::from_settings(&settings)
                        };
                        let (static_prefix_changed, static_prefix_measurement) = engine.note_static_prefix(&base_request);
                        let local_count =
                            TokenCounter::count_request_with_static_prefix(&base_request, static_prefix_changed, &static_prefix_measurement);
                        let should_calibrate =
                            !training_mode && local_count.tokens >= budget.prefire_threshold();
                        let request_count = if should_calibrate {
                            let count = if recovery_deadline.is_active() {
                                tokio::select! {
                                    biased;
                                    _ = engine.cancel_token().cancelled_owned() => {
                                        recovery_record.stop(RecoveryOutcome::Cancelled);
                                        yield EngineEvent::StreamAborted { reason: "cancelled by user".into() };
                                        return;
                                    }
                                    _ = recovery_deadline.elapsed() => {
                                        recovery_record.stop(RecoveryOutcome::DeadlineExceeded);
                                        yield EngineEvent::Error(recovery_deadline::DEADLINE_ERROR.into());
                                        return;
                                    }
                                    count = provider_for_turn.count_tokens(base_request.clone()) => count,
                                }
                            } else {
                                provider_for_turn.count_tokens(base_request.clone()).await
                            };
                            match count {
                                Ok(Some(tokens)) => TokenCount {
                                    tokens,
                                    source: TokenCountSource::ProviderExact,
                                },
                                Ok(None) => local_count,
                                Err(error) => {
                                    debug!("provider count-tokens calibration failed; using local estimate: {error}");
                                    local_count
                                }
                            }
                        } else {
                            local_count
                        };
                        engine.record_session_request_measurement(request_count, &budget,
                            turn_steer_session.as_ref().map(|session| session.turn_id), turn_count);
                        debug!(
                            token_count_source = ?request_count.source,
                            full_request_tokens = request_count.tokens,
                            prefire_limit = budget.prefire_threshold(),
                            soft_compact_limit = budget.auto_compact_threshold(),
                            hard_input_limit = budget.hard_input_limit(),
                            "complete request token preflight"
                        );
                        if request_count.tokens > budget.hard_input_limit() {
                            if training_mode {
                                recovery_record.stop(RecoveryOutcome::PolicyRejected);
                                yield EngineEvent::Error(format!(
                                    "Context request blocked before sending: estimated {} tokens exceeds the hard input limit {}. Training mode forbids model-based compaction because it would create an extra trajectory request.",
                                    request_count.tokens,
                                    budget.hard_input_limit()
                                ));
                                return;
                            }
                            if hard_gate_compactions >= 1 {
                                recovery_record.stop(RecoveryOutcome::BudgetRejected);
                                yield EngineEvent::Error(format!(
                                    "Context request blocked before sending: estimated {} tokens exceeds the hard input limit {} after emergency compaction. Split the current request or increase the model context configuration.",
                                    request_count.tokens,
                                    budget.hard_input_limit()
                                ));
                                return;
                            }
                            hard_gate_compactions += 1;
                            recovery_record.begin(RecoveryDecision::Compact);
                            let compaction = engine
                                .perform_compaction_with_recovery_deadline(
                                    true, false, true,
                                    recovery_deadline.is_active().then(|| engine.cancel_token()),
                                    recovery_deadline,
                                ).await;
                            recovery_record.compact_result(compaction.as_ref().map(|r| r.did_compact).map_err(|_| ()));
                            if let Some(event) = recovery_deadline.stop_event(&engine.cancel_token()) {
                                recovery_record.stopped(&event);
                                yield event;
                                return;
                            }
                            match compaction {
                                Ok(result) if result.did_compact => {
                                    yield EngineEvent::SystemNotice(format!(
                                        "Context emergency-compacted before sending: {} -> {} tokens",
                                        result.pre_compact_tokens, result.post_compact_tokens
                                    ));
                                    continue 'turn_loop;
                                }
                                Ok(_) => {
                                    yield EngineEvent::Error(format!(
                                        "Context request blocked before sending: estimated {} tokens exceeds the hard input limit {}, and the current user request cannot be compacted safely.",
                                        request_count.tokens,
                                        budget.hard_input_limit()
                                    ));
                                    return;
                                }
                                Err(error) => {
                                    yield EngineEvent::Error(format!(
                                        "Context request blocked before sending: emergency compaction failed: {error}"
                                    ));
                                    return;
                                }
                            }
                        }
                        let mut diagnostic_requests = attempt_diagnostic_requests::AttemptDiagnosticRequests::new(base_request);
                        recovery_deadline.start(
                            recover_read_lock(&engine.settings, "settings")
                                .recovery.provider.total_timeout_ms,
                        );
                        'api_attempt: loop {
                            pending_tool_uses.clear();

                            let permit = tokio::select! {
                                biased;
                                _ = engine.cancel_token().cancelled_owned() => {
                                    recovery_record.stop(RecoveryOutcome::Cancelled);
                                    yield EngineEvent::StreamAborted {
                                        reason: "cancelled by user".into(),
                                    };
                                    return;
                                }
                                _ = recovery_deadline.elapsed() => {
                                    recovery_record.stop(RecoveryOutcome::DeadlineExceeded);
                                    yield EngineEvent::Error(recovery_deadline::DEADLINE_ERROR.into());
                                    return;
                                }
                                admitted = request_admission::acquire(&provider_for_turn, engine.request_class) => {
                                    match admitted {
                                        Ok(permit) => permit,
                                        Err(error) => {
                                            yield EngineEvent::Error(format!("Internal maintenance request skipped: {error}"));
                                            return;
                                        }
                                    }
                                }
                            };
                            let attempt_diagnostic_request = diagnostic_requests.select(recovery_disable_reasoning);
                            if recovery_disable_reasoning {
                                recovery_record.complete(RecoveryOutcome::ReasoningDisabled);
                            }
                            let request = attempt_diagnostic_request.request().clone();
                            let mut capture = tokio::select! {
                                biased;
                                _ = engine.cancel_token().cancelled_owned() => {
                                    recovery_record.stop(RecoveryOutcome::Cancelled);
                                    drop(permit);
                                    yield EngineEvent::StreamAborted {
                                        reason: "cancelled by user".into(),
                                    };
                                    return;
                                }
                                _ = recovery_deadline.elapsed() => {
                                    recovery_record.stop(RecoveryOutcome::DeadlineExceeded);
                                    drop(permit);
                                    yield EngineEvent::Error(recovery_deadline::DEADLINE_ERROR.into());
                                    return;
                                }
                                capture = engine.state.begin_llm_exchange(attempt_diagnostic_request, false) => capture,
                            };
                            let request_started_at = Instant::now();
                            let mut first_token_at: Option<Instant> = None;
                            let mut last_token_at: Option<Instant> = None;

                            if let Some(event) = recovery_deadline.stop_event(&engine.cancel_token()) {
                                recovery_record.stopped(&event);
                                drop(permit);
                                if let EngineEvent::Error(message) | EngineEvent::StreamAborted { reason: message } = &event {
                                    capture.finish(Some(message));
                                }
                                yield event;
                                return;
                            }

                            recovery_record.invoke();
                            yield EngineEvent::ToolInputReset;
                            let mut path_previews = path_preview_runtime::PathPreviewRuntime::new(
                                engine.tool_path_previews && !terminal_verdict_turn,
                            );
                            let mut stream = match provider_for_turn.stream_messages(request) {
                                Ok(s) => permit.wrap(timed_stream(s, graded_idle_timeout(DEFAULT_STREAM_IDLE_TIMEOUT, attempt))),
                                Err(e) => {
                                    drop(permit);
                                    recovery_record.complete(RecoveryOutcome::Failed);
                                    capture.finish_with_summary(e.safe_summary());
                                    if !training_mode && !recovery_disable_reasoning && attempt < max_retries
                                        && can_downgrade_thinking(&e, provider_for_turn.as_ref())
                                    {
                                        attempt += 1;
                                        recovery_disable_reasoning = true;
                                        recovery_record.begin(RecoveryDecision::DowngradeThinking);
                                        yield EngineEvent::SystemNotice("Optional reasoning disabled for this request only; retrying with the same model and history.".into());
                                        continue 'api_attempt;
                                    }
                                    if is_prompt_too_long_provider_error(&e) && (training_mode || reactive_compact_retries != 0) {
                                        recovery_record.begin(RecoveryDecision::Compact);
                                        recovery_record.complete(RecoveryOutcome::PolicyRejected);
                                    }
                                    if !training_mode
                                        && is_prompt_too_long_provider_error(&e)
                                        && reactive_compact_retries == 0
                                    {
                                        reactive_compact_retries = 1;
                                        recovery_record.begin(RecoveryDecision::Compact);
                                        let compaction = engine
                                            .perform_compaction_with_recovery_deadline(
                                                true, false, true,
                                                recovery_deadline.is_active().then(|| engine.cancel_token()),
                                                recovery_deadline,
                                            ).await;
                                        recovery_record.compact_result(compaction.as_ref().map(|r| r.did_compact).map_err(|_| ()));
                                        if let Some(event) = recovery_deadline.stop_event(&engine.cancel_token()) {
                                            recovery_record.stopped(&event);
                                            yield event;
                                            return;
                                        }
                                        match compaction {
                                            Ok(result) if result.did_compact => {
                                                yield EngineEvent::SystemNotice(format!(
                                                    "Provider rejected the context; reactive compact completed: {} -> {} tokens. Retrying once.",
                                                    result.pre_compact_tokens, result.post_compact_tokens
                                                ));
                                                continue 'turn_loop;
                                            }
                                            Ok(_) | Err(_) => {}
                                        }
                                    }
                                    if is_retryable_api_error(&e) {
                                        if is_rate_limit_api_error(&e) {
                                            rate_limit_streak += 1;
                                        } else {
                                            rate_limit_streak = 0;
                                        }
                                    }
                                    if attempt < max_retries
                                        && is_retryable_api_error(&e)
                                        && rate_limit_streak <= RATE_LIMIT_MAX_RETRIES
                                    {
                                        attempt += 1;
                                        let reason = retry_error_summary(&e);
                                        let delay = api_server_retry_after(&e)
                                            .map(|after| backoff_delay(base_delay_ms, attempt as u32).max(after))
                                            .unwrap_or_else(|| backoff_delay(base_delay_ms, attempt as u32));
                                        recovery_record.begin(RecoveryDecision::RetryWait);
                                        yield EngineEvent::ProviderRetry(provider_retry_details(
                                            &e,
                                            "main",
                                            provider_for_turn.name(),
                                            &model,
                                            attempt,
                                            max_retries,
                                            reason.clone(),
                                            delay,
                                            request_started_at,
                                            turn_started_at,
                                            provider_transport_started_at,
                                            first_token_at,
                                            last_token_at,
                                        ));
                                        warn!(
                                            "provider stream start failed; retry {}/{} in {:?}: {}",
                                            attempt, max_retries, delay, reason
                                        );
                                        if let Some(event) = recovery_deadline.backoff(engine.cancel_token(), delay).await {
                                            recovery_record.stopped(&event);
                                            yield event;
                                            return;
                                        }
                                        recovery_record.complete(RecoveryOutcome::WaitCompleted);
                                        continue 'api_attempt;
                                    }
                                    if is_retryable_api_error(&e) {
                                        recovery_record.rejected(attempt >= max_retries || rate_limit_streak > RATE_LIMIT_MAX_RETRIES);
                                    }
                                    let provider = provider_for_turn.name();
                                    error!("failed to start {} provider stream: {}", provider, e);
                                    let details = retry_policy::provider_failure_details(&e, response_started || provider_output_published || turn_count > 1);
                                    recovery_record.provider_failed(&details);
                                    yield EngineEvent::ProviderFailed { message: provider_error_message(provider, &e), details };
                                    return;
                                }
                            };

                            let mut current_blocks: Vec<ContentBlock> = Vec::new();
                            let mut current_tool_use_partials: HashMap<usize, String> = HashMap::new();
                            let mut current_tool_use_chars: HashMap<usize, usize> = HashMap::new();
                            let mut current_tool_use_reported_chars: HashMap<usize, usize> = HashMap::new();
                            let mut current_write_preview_reported_chars: HashMap<usize, usize> =
                                HashMap::new();
                            let mut current_usage: Option<Usage> = None;
                            let mut attempt_response_begun = false;
                            // All same-request recovery shares this attempt-local response boundary.
                            let mut reasoning_recovery_pre_response = true;
                            let mut response_completed = false;
                            let mut open_tool_blocks = HashSet::new();
                            let mut rejected_terminal_tools = Vec::new();
                            // Some gateways stream text deltas without a well-formed
                            // text block start; those deltas are still user-visible
                            // output and must count when judging a response "empty".
                            let mut saw_visible_text_delta = false;

                            'stream_loop: loop {
                                let event = tokio::select! {
                                    biased;
                                    _ = engine.cancel_token().cancelled_owned() => {
                                        recovery_record.stop(RecoveryOutcome::Cancelled);
                                        drop(stream);
                                        for event in path_previews.clear() {
                                            yield event;
                                        }
                                        capture.finish(Some("cancelled by user"));
                                        yield EngineEvent::StreamAborted {
                                            reason: "cancelled by user".into(),
                                        };
                                        return;
                                    }
                                    _ = recovery_deadline.elapsed(), if !response_completed => {
                                        recovery_record.stop(RecoveryOutcome::DeadlineExceeded);
                                        drop(stream);
                                        for event in path_previews.clear() {
                                            yield event;
                                        }
                                        capture.finish(Some(recovery_deadline::DEADLINE_ERROR));
                                        yield EngineEvent::Error(recovery_deadline::DEADLINE_ERROR.into());
                                        return;
                                    }
                                    event = stream.next() => event,
                                    bg = async { engine.background_job_rx.lock().await.recv().await } => {
                                        match bg {
                                            Ok(bg_event) => {
                                                // IMPORTANT: do not break 'stream_loop here.
                                                // The previous implementation truncated the
                                                // in-flight assistant response as soon as a
                                                // background job landed, which produced
                                                // incomplete tool_use JSON and forced the
                                                // model to retry. Defer the event instead
                                                // and let the API stream finish naturally;
                                                // we drain deferred events after the
                                                // assistant message is committed and after
                                                // tool_results are appended, preserving the
                                                // Anthropic tool_use/tool_result invariant.
                                                deferred_background_events.push(bg_event);
                                                // Drain anything else already buffered.
                                                deferred_background_events.extend(engine.drain_background_events());
                                                // Continue the loop so we keep reading from
                                                // the API stream.
                                                continue;
                                            }
                                            // Lagged: we fell behind the broadcast queue.
                                            // Catch up from AppState and continue.
                                            Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                                                tracing::debug!(
                                                    "engine background subscriber lagged, skipped {skipped} events"
                                                );
                                                deferred_background_events.extend(engine.drain_background_events());
                                                continue;
                                            }
                                            Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                                                // Channel is gone — there's nothing more to
                                                // wait for; continue draining the stream
                                                // until the provider closes it.
                                                continue;
                                            }
                                        }
                                    }
                                };
                                let Some(event) = event else {
                                    break 'stream_loop;
                                };
                                if let Ok(event) = &event {
                                    if !matches!(event,
                                        StreamEvent::Ping | StreamEvent::Error { .. }
                                        | StreamEvent::MessageDelta { delta: kcoder_types::MessageDeltaFields { stop_reason: None, stop_sequence: None, .. } }
                                    ) {
                                        reasoning_recovery_pre_response = false;
                                        provider_output_published = true;
                                    }
                                    if stream_event_is_model_progress(event) {
                                        let now = Instant::now();
                                        first_token_at.get_or_insert(now);
                                        last_token_at = Some(now);
                                    }
                                    capture.observe(event);
                                }
                                if matches!(
                                    &event,
                                    Err(_) | Ok(StreamEvent::Error { .. } | StreamEvent::MessageStop)
                                ) {
                                    for event in path_previews.clear() {
                                        yield event;
                                    }
                                }
                                match event {
                                    Ok(StreamEvent::MessageStart { message }) => {
                                        if attempt_response_begun {
                                            for event in path_previews.clear() {
                                                yield event;
                                            }
                                            let error_text =
                                                "provider protocol error: duplicate message_start in one response"
                                                    .to_string();
                                            drop(stream);
                                            capture.finish(Some(&error_text));
                                            yield EngineEvent::Error(error_text);
                                            return;
                                        }
                                        attempt_response_begun = true;
                                        current_blocks.clear();
                                        current_tool_use_partials.clear();
                                        current_tool_use_chars.clear();
                                        current_tool_use_reported_chars.clear();
                                        current_write_preview_reported_chars.clear();
                                        open_tool_blocks.clear();
                                        rejected_terminal_tools.clear();
                                        saw_visible_text_delta = false;
                                        if let Some(usage) = message.usage.as_ref()
                                            && let Some((reason, cancelled_subagents)) =
                                                engine.charge_stream_usage(None, usage)
                                        {
                                            drop(stream);
                                            for event in path_previews.clear() {
                                                yield event;
                                            }
                                            capture.finish(Some(&reason));
                                            let cancellation_note = if cancelled_subagents > 0 {
                                                format!(
                                                    " Cancelled {cancelled_subagents} running sub-agent(s)."
                                                )
                                            } else {
                                                String::new()
                                            };
                                            yield EngineEvent::SystemNotice(format!(
                                                "{reason}.{cancellation_note} Use `/goal clear` before starting a new goal."
                                            ));
                                            yield EngineEvent::StreamAborted { reason };
                                            return;
                                        }
                                        current_usage = message.usage;
                                        if !response_started {
                                            response_started = true;
                                            yield EngineEvent::AssistantMessageStarted;
                                        }
                                    }
                                    Ok(StreamEvent::ContentBlockStart {
                                        index,
                                        content_block,
                                    }) => {
                                        attempt_response_begun = true;
                                        if !response_started {
                                            response_started = true;
                                            yield EngineEvent::AssistantMessageStarted;
                                        }
                                        // Standard block-start frames may already contain text.
                                        // Forward it once; the block itself retains that content for history.
                                        match &content_block {
                                            ContentBlock::Text { text } if !text.is_empty() => {
                                                saw_visible_text_delta |= !text.trim().is_empty();
                                                yield EngineEvent::AssistantTextDelta(text.clone());
                                            }
                                            ContentBlock::Thinking { thinking, .. } if !thinking.is_empty() => {
                                                yield EngineEvent::AssistantThinkingDelta(thinking.clone());
                                            }
                                            _ => {}
                                        }
                                        let streamed_tool_identity = match &content_block {
                                            ContentBlock::ToolUse { id, name, .. } => {
                                                Some((id.clone(), name.clone()))
                                            }
                                            _ => None,
                                        };
                                        for event in path_previews.start(
                                            index,
                                            streamed_tool_identity.as_ref().map(|(id, name)| (id.as_str(), name.as_str())),
                                        ) {
                                            yield event;
                                        }
                                        if streamed_tool_identity.is_some() {
                                            open_tool_blocks.insert(index);
                                        }
                                        let block = match content_block {
                                            ContentBlock::ToolUse { name, .. }
                                                if terminal_verdict_turn
                                                    && name != kcoder_tools::VERIFIER_VOTE_TOOL_NAME =>
                                            {
                                                rejected_terminal_tools.push(name);
        // A provider may ignore an empty tool list and reuse historical tool_use blocks.
        // The terminal verdict turn retains only text placeholders and never queues
        // those calls for execution. VerifierVote is the sole exception because the
        // terminal verdict must be submitted through it.
                                                ContentBlock::Text {
                                                    text: String::new(),
                                                }
                                            }
                                            ContentBlock::ToolUse { id, name, .. } => {
                                                current_tool_use_partials.insert(index, String::new());
                                                current_tool_use_chars.insert(index, 0);
                                                current_tool_use_reported_chars.insert(index, 0);
                                                current_write_preview_reported_chars.insert(index, 0);
                                                ContentBlock::ToolUse {
                                                    id,
                                                    name,
                                                    input: serde_json::Value::Object(serde_json::Map::new()),
                                                }
                                            }
                                            ContentBlock::Text { text } => {
                                                ContentBlock::Text { text }
                                            }
                                            ContentBlock::Thinking { thinking, signature } => {
                                                ContentBlock::Thinking {
                                                    thinking,
                                                    signature,
                                                }
                                            }
                                            other => other,
                                        };
                                        put_stream_content_block(&mut current_blocks, index, block);
                                        if !terminal_verdict_turn
                                            && let Some((id, name)) = streamed_tool_identity
                                        {
                                            // Some Anthropic-compatible gateways announce the tool block
                                            // immediately but buffer its JSON deltas. Surface the phase
                                            // transition now instead of leaving the UI on stale thinking.
                                            yield EngineEvent::ToolInputProgress { id, name, chars: 0 };
                                        }
                                    }
                                    Ok(StreamEvent::ContentBlockDelta { index, delta }) => {
                                        match delta {
                                            ContentDelta::TextDelta { text } => {
                                                if let Some(ContentBlock::Text { text: existing }) =
                                                    current_blocks.get_mut(index)
                                                {
                                                    existing.push_str(&text);
                                                }
                                                if !text.trim().is_empty() {
                                                    saw_visible_text_delta = true;
                                                }
                                                yield EngineEvent::AssistantTextDelta(text);
                                            }
                                            ContentDelta::ThinkingDelta { thinking } => {
                                                if let Some(ContentBlock::Thinking {
                                                    thinking: existing,
                                                    ..
                                                }) = current_blocks.get_mut(index)
                                                {
                                                    existing.push_str(&thinking);
                                                }
                                                yield EngineEvent::AssistantThinkingDelta(thinking);
                                            }
                                            ContentDelta::SignatureDelta { signature } => {
                                                if let Some(ContentBlock::Thinking {
                                                    signature: existing,
                                                    ..
                                                }) = current_blocks.get_mut(index)
                                                {
                                                    existing.push_str(&signature);
                                                }
                                            }
                                            ContentDelta::InputJsonDelta { partial_json } => {
        // The terminal turn accumulates input only for VerifierVote. JSON partials for
        // other tools are discarded with the ContentBlockStart shim because their blocks
        // have already been replaced with empty text.
                                                if terminal_verdict_turn {
                                                    let is_vote = matches!(
                                                        current_blocks.get(index),
                                                        Some(ContentBlock::ToolUse { name, .. })
                                                            if name == kcoder_tools::VERIFIER_VOTE_TOOL_NAME
                                                    );
                                                    if !is_vote {
                                                        continue 'stream_loop;
                                                    }
                                                }
                                                let chars = current_tool_use_chars.entry(index).or_default();
                                                *chars = chars.saturating_add(partial_json.chars().count());
                                                let chars = *chars;
                                                current_tool_use_partials
                                                    .entry(index)
                                                    .or_default()
                                                    .push_str(&partial_json);
                                                let tool_identity =
                                                    current_blocks.get(index).and_then(|block| match block {
                                                        ContentBlock::ToolUse { id, name, .. } => {
                                                            Some((id.clone(), name.clone()))
                                                        }
                                                        _ => None,
                                                    });
                                                let reported = current_tool_use_reported_chars
                                                    .entry(index)
                                                    .or_default();
                                                if let Some((id, _)) = tool_identity.as_ref() {
                                                    for event in path_previews.push(index, id, &partial_json) {
                                                        yield event;
                                                    }
                                                }
                                                let should_report = chars > 0
                                                    && (*reported == 0
                                                        || chars.saturating_sub(*reported)
                                                            >= TOOL_INPUT_PROGRESS_STEP_CHARS);
                                                if should_report {
                                                    *reported = chars;
                                                }
                                                if should_report
                                                    && let Some((id, name)) = tool_identity.as_ref() {
                                                        let id = id.clone();
                                                        let name = name.clone();
                                                        yield EngineEvent::ToolInputProgress { id, name, chars };
                                                    }
                                                if let Some((id, name)) = tool_identity
                                                    && name.eq_ignore_ascii_case("write")
                                                {
                                                    let preview_reported =
                                                        current_write_preview_reported_chars
                                                            .entry(index)
                                                            .or_default();
                                                    let should_preview = chars > 0
                                                        && (*preview_reported == 0
                                                            || chars.saturating_sub(*preview_reported)
                                                                >= WRITE_INPUT_PREVIEW_STEP_CHARS);
                                                    if should_preview {
                                                        *preview_reported = chars;
                                                        if let Some(preview) = current_tool_use_partials
                                                            .get(&index)
                                                            .and_then(|partial| {
                                                                WriteInputPreview::from_partial_json(partial)
                                                            })
                                                        {
                                                            yield EngineEvent::ToolInputPreview {
                                                                id,
                                                                preview,
                                                            };
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    Ok(StreamEvent::ContentBlockStop { index }) => {
                                        let Some(block) = current_blocks.get_mut(index) else {
                                            continue;
                                        };
                                        open_tool_blocks.remove(&index);
                                        if let ContentBlock::ToolUse { id, name, .. } = block {
                                            let id = id.clone();
                                            let name = name.clone();
                                            let partial =
                                                current_tool_use_partials.remove(&index).unwrap_or_default();
                                            current_tool_use_chars.remove(&index);
                                            current_tool_use_reported_chars.remove(&index);
                                            current_write_preview_reported_chars.remove(&index);
                                            let input = if partial.is_empty() {
                                                serde_json::Value::Object(serde_json::Map::new())
                                            } else {
                                                serde_json::from_str(&partial).unwrap_or_else(|e| {
                                                    warn!(
                                                        "failed to parse tool arguments for {}: {}",
                                                        name, e
                                                    );
                                                    serde_json::Value::Object(serde_json::Map::new())
                                                })
                                            };
                                            debug!(
                                                "final tool input for {}: {}",
                                                name,
                                                tool_input_log_summary(&input)
                                            );
                                            for event in path_previews.finish(index, &id, &input) {
                                                yield event;
                                            }
                                            *block = ContentBlock::ToolUse {
                                                id: id.clone(),
                                                name: name.clone(),
                                                input: input.clone(),
                                            };
                                            for path in collect_touched_paths(&input, &engine.cwd) {
                                                if !touched_paths.contains(&path) {
                                                    touched_paths.push(path);
                                                }
                                            }
                                            // Doom-loop detection (main thread only):
                                            // track consecutive identical (name, input) calls.
                                            if is_main_thread {
                                                let doom_loop_limit =
                                                    doom_loop_limit_for_tool(&name, &doom_loop_settings);
                                                let fingerprint = format!(
                                                    "{}:{}",
                                                    name,
                                                    serde_json::to_string(&input).unwrap_or_default()
                                                );
                                                if doom_streak.0.as_deref() == Some(fingerprint.as_str()) {
                                                    doom_streak.1 += 1;
                                                } else {
                                                    doom_streak = (Some(fingerprint), 1, doom_streak.2);
                                                }
                                                if doom_loop_limit.is_some()
                                                    && doom_streak.1 == 3
                                                    && !doom_streak.2
                                                {
                                                    doom_streak.2 = true;
                                                    engine.state.add_message(Message::runtime_text(format!(
                                                        "<system-reminder>You have now made the exact same tool call (`{name}` with identical input) 3 times in a row. This is almost certainly a loop, not progress. Change strategy NOW: vary the parameters, use a different tool, or write the results you already have to the required output path before doing anything else. If the task cannot be advanced further, summarize the current state and stop.</system-reminder>"
                                                    )));
                                                }
                                                if doom_loop_limit.is_some_and(|limit| doom_streak.1 >= limit) {
                                                    let reason = format!(
                                                        "doom loop detected: tool `{name}` was called {} times in a row with identical input; the turn was stopped to avoid burning the budget",
                                                        doom_streak.1
                                                    );
                                                    drop(stream);
                                                    for event in path_previews.clear() {
                                                        yield event;
                                                    }
                                                    capture.finish(Some(&reason));
                                                    engine.state.add_message(Message::runtime_text(format!(
                                                        "<system-reminder>{reason}. Deliver what you have now instead of retrying.</system-reminder>"
                                                    )));
                                                    yield EngineEvent::StreamAborted { reason };
                                                    return;
                                                }
                                            }
                                            pending_tool_uses.push((id, name, input));
                                        }
                                    }
                                    Ok(StreamEvent::MessageDelta { delta }) => {
                                        if let Some(usage) = delta.usage {
                                            // Providers report usage cumulatively
                                            // within a response (Gemini sends running
                                            // totals per chunk); charge only the
                                            // increment over the largest snapshot
                                            // already merged for this response.
                                            let delta_tokens = UsageAccumulator::usage_total(
                                                &usage_increment(current_usage.as_ref(), &usage),
                                            );
                                            let budget_trip = engine
                                                .charge_stream_usage(current_usage.as_ref(), &usage);
                                            merge_stream_usage(&mut current_usage, usage);
                                            if let Some(grace_used) = goal_budget_grace_tokens.as_mut() {
                                                // The budget already tripped: the rest
                                                // of this response runs on the bounded
                                                // wrap-up grace. Beyond the grace,
                                                // hard-abort but still preserve
                                                // everything streamed so far.
                                                *grace_used = grace_used.saturating_add(delta_tokens);
                                                if *grace_used > GOAL_BUDGET_GRACE_TOKENS {
                                                    let reason = format!(
                                                        "Goal token budget grace exhausted ({grace_used} tokens beyond the budget)"
                                                    );
                                                    drop(stream);
                                                    for event in path_previews.clear() {
                                                        yield event;
                                                    }
                                                    capture.finish(Some(&reason));
                                                    preserve_partial_turn_message(
                                                        &engine,
                                                        &current_blocks,
                                                        &current_usage,
                                                        &pending_tool_uses,
                                                        "turn truncated: goal token budget exhausted",
                                                    );
                                                    yield EngineEvent::SystemNotice(format!(
                                                        "{reason}. The partial response was preserved. Use `/goal clear` before starting a new goal."
                                                    ));
                                                    yield EngineEvent::StreamAborted { reason };
                                                    return;
                                                }
                                            } else if let Some((reason, cancelled_subagents)) = budget_trip
                                            {
                                                // Budget tripped mid-response: let the
                                                // in-flight response finish within a
                                                // bounded grace so the model can wrap
                                                // up (and record a verdict) instead of
                                                // losing work it already paid for. The
                                                // sub-turn boundary check stops any
                                                // further API calls in this turn.
                                                goal_budget_grace_tokens = Some(0);
                                                let cancellation_note = if cancelled_subagents > 0 {
                                                    format!(
                                                        " Cancelled {cancelled_subagents} running sub-agent(s)."
                                                    )
                                                } else {
                                                    String::new()
                                                };
                                                yield EngineEvent::SystemNotice(format!(
                                                    "{reason}.{cancellation_note} Finishing the current response within a {GOAL_BUDGET_GRACE_TOKENS}-token grace; no further API calls will start. Use `/goal clear` before starting a new goal."
                                                ));
                                            }
                                        }
                                    }
                                    Ok(StreamEvent::MessageStop) => {
                                        if !open_tool_blocks.is_empty() {
                                            let error_text = format!(
                                                "provider protocol error: message_stop arrived before content_block_stop for block(s) {:?}",
                                                open_tool_blocks
                                            );
                                            capture.finish(Some(&error_text));
                                            yield EngineEvent::Error(error_text);
                                            return;
                                        }
                                        // Preserve trailing usage/error accounting under the
                                        // existing completed-stream idle watchdog. Generation
                                        // finished; the recovery deadline must not fail it.
                                        response_completed = true;
                                        recovery_record.complete(RecoveryOutcome::Success);
                                        let response_has_visible_text = saw_visible_text_delta
                                            || current_blocks.iter().any(
                                                |block| matches!(block, ContentBlock::Text { text } if !text.trim().is_empty()),
                                            );
                                        let response_has_visible_text = if terminal_verdict_turn
                                            && !rejected_terminal_tools.is_empty()
                                            && !pending_tool_uses.iter().any(|(_, name, _)| {
                                                name == kcoder_tools::VERIFIER_VOTE_TOOL_NAME
                                            })
                                        {
                                            let report = terminal_verifier_tool_rejection_report(
                                                &current_blocks,
                                                &rejected_terminal_tools,
                                            );
                                            current_blocks.clear();
                                            current_blocks.push(ContentBlock::Text {
                                                text: report.clone(),
                                            });
                                            yield EngineEvent::SystemNotice(
                                                "Verifier provider requested a disabled tool on the final verdict turn; the request was ignored."
                                                    .to_string(),
                                            );
                                            yield EngineEvent::AssistantTextDelta(report);
                                            true
                                        } else {
                                            response_has_visible_text
                                        };
                                        if pending_tool_uses.is_empty()
                                            && engine.state.session_mode()
                                                == kcoder_state::SessionMode::Orchestrate
                                        {
                                            let advisory = {
                                                let settings =
                                                    recover_read_lock(&engine.settings, "settings");
                                                orchestrate::input::assistant_completion_advisory(
                                                    &engine.cwd,
                                                    &settings,
                                                )
                                            };
                                            if let Some(advisory) = advisory {
        // Diagnostics travel through host metadata and the TUI side channel. They are
        // not written to the assistant transcript and do not trigger another provider sample.
                                                yield EngineEvent::HookMessage {
                                                    text: advisory,
                                                    is_error: false,
                                                };
                                            }
                                        }
                                        if !current_blocks.is_empty() {
                                            for (id, name, input) in &pending_tool_uses {
                                                yield EngineEvent::ToolUseStarted {
                                                    id: id.clone(),
                                                    name: name.clone(),
                                                    input: input.clone(),
                                                };
                                            }
                                            engine.state.add_message(Message::Assistant {
                                                content: current_blocks.clone(),
                                                usage: current_usage.clone(),
                                            });
                                            yield EngineEvent::AssistantMessageDone;
                                            current_blocks.clear();
                                            current_usage = None;
                                        }
                                        if pending_tool_uses.is_empty() {
                                            // A message with no visible text and no
                                            // tool calls (e.g. thinking-only) must not
                                            // silently complete the turn; the no-tools
                                            // branch below nudges the model instead.
                                            last_response_was_empty = !response_has_visible_text;
                                        } else {
                                            last_response_was_empty = false;
                                            consecutive_empty_responses = 0;
                                        }
                                    }
                                    Ok(StreamEvent::Error { error }) => {
                                        recovery_record.complete(RecoveryOutcome::Failed);
                                        let error_text = error.safe_summary();
                                        let api_error = kcoder_api::ApiErrorKind::Api {
                                            error_type: error.error_type.clone(),
                                            message: error.message.clone(),
                                        };
                                        capture.finish_with_summary(api_error.safe_summary());
                                        if is_prompt_too_long_provider_error(&api_error) && (training_mode || reactive_compact_retries != 0 || !reasoning_recovery_pre_response) {
                                            recovery_record.begin(RecoveryDecision::Compact);
                                            recovery_record.complete(RecoveryOutcome::PolicyRejected);
                                        }
                                        if !training_mode
                                            && is_prompt_too_long_provider_error(&api_error)
                                            && reactive_compact_retries == 0
                                            && reasoning_recovery_pre_response
                                        {
                                            reactive_compact_retries = 1;
                                            recovery_record.begin(RecoveryDecision::Compact);
                                            let compaction = engine
                                                .perform_compaction_with_recovery_deadline(
                                                    true, false, true,
                                                    recovery_deadline.is_active().then(|| engine.cancel_token()),
                                                    recovery_deadline,
                                                ).await;
                                            recovery_record.compact_result(compaction.as_ref().map(|r| r.did_compact).map_err(|_| ()));
                                            if let Some(event) = recovery_deadline.stop_event(&engine.cancel_token()) {
                                                recovery_record.stopped(&event);
                                                yield event;
                                                return;
                                            }
                                            match compaction {
                                                Ok(result) if result.did_compact => {
                                                    yield EngineEvent::SystemNotice(format!(
                                                        "Provider rejected the context; reactive compact completed: {} -> {} tokens. Retrying once.",
                                                        result.pre_compact_tokens, result.post_compact_tokens
                                                    ));
                                                    continue 'turn_loop;
                                                }
                                                Ok(_) | Err(_) => {}
                                            }
                                        }
                                        if is_retryable_api_error(&api_error) {
                                            if is_rate_limit_api_error(&api_error) {
                                                rate_limit_streak += 1;
                                            } else {
                                                rate_limit_streak = 0;
                                            }
                                        }
                                        if reasoning_recovery_pre_response && attempt < max_retries
                                            && is_retryable_api_error(&api_error)
                                            && rate_limit_streak <= RATE_LIMIT_MAX_RETRIES
                                        {
                                            attempt += 1;
                                            let reason = retry_error_summary(&api_error);
                                            let delay = api_server_retry_after(&api_error)
                                                .map(|after| {
                                                    backoff_delay(base_delay_ms, attempt as u32).max(after)
                                                })
                                                .unwrap_or_else(|| {
                                                    backoff_delay(base_delay_ms, attempt as u32)
                                                });
                                            recovery_record.begin(RecoveryDecision::RetryWait);
                                            yield EngineEvent::ProviderRetry(provider_retry_details(
                                                &api_error,
                                                "main",
                                                provider_for_turn.name(),
                                                &model,
                                                attempt,
                                                max_retries,
                                                reason.clone(),
                                                delay,
                                                request_started_at,
                                                turn_started_at,
                                                provider_transport_started_at,
                                                first_token_at,
                                                last_token_at,
                                            ));
                                            warn!(
                                                "provider API error retry {}/{} in {:?}: {}",
                                                attempt, max_retries, delay, reason
                                            );
                                            if let Some(event) = recovery_deadline.backoff(engine.cancel_token(), delay).await {
                                                recovery_record.stopped(&event);
                                                yield event;
                                                return;
                                            }
                                            recovery_record.complete(RecoveryOutcome::WaitCompleted);
                                            continue 'api_attempt;
                                        }
                                        if is_retryable_api_error(&api_error) {
                                            recovery_record.rejected(attempt >= max_retries || rate_limit_streak > RATE_LIMIT_MAX_RETRIES);
                                        }
                                        error!("{}", error.safe_summary());
                                        let details = retry_policy::provider_failure_details(&api_error, response_started || provider_output_published || turn_count > 1);
                                        recovery_record.provider_failed(&details);
                                        let message = match details.category {
                                            kcoder_types::ProviderFailureCategory::AuthenticationError | kcoder_types::ProviderFailureCategory::Forbidden => format!("{error_text}. Check API key and provider permissions."),
                                            kcoder_types::ProviderFailureCategory::ModelOrRoute => format!("{error_text}. Check model name and provider endpoint."),
                                            kcoder_types::ProviderFailureCategory::InvalidParameter => format!("{error_text}. Check request parameters."),
                                            kcoder_types::ProviderFailureCategory::ContextLengthExceeded => format!("{error_text}. Reduce the input or start a new conversation."),
                                            _ => error_text,
                                        };
                                        yield EngineEvent::ProviderFailed { message, details };
                                        return;
                                    }
                                    Ok(_) => {}
                                    Err(e) => {
                                        recovery_record.complete(RecoveryOutcome::Failed);
                                        let msg = e.to_string();
                                        let is_stream_idle = e.non_http_error_class()
                                            == Some(kcoder_api::NonHttpErrorClass::StreamIdleTimeout);
                                        capture.finish_with_summary(e.safe_summary());
                                        if !training_mode && reasoning_recovery_pre_response
                                            && !recovery_disable_reasoning && attempt < max_retries
                                            && can_downgrade_thinking(&e, provider_for_turn.as_ref())
                                        {
                                            attempt += 1;
                                            recovery_disable_reasoning = true;
                                            recovery_record.begin(RecoveryDecision::DowngradeThinking);
                                            yield EngineEvent::SystemNotice("Optional reasoning disabled for this request only; retrying with the same model and history.".into());
                                            continue 'api_attempt;
                                        }
                                        if http_recovery_action(&e) == Some(HttpRecoveryAction::CompactNow) && (training_mode || reactive_compact_retries != 0 || !reasoning_recovery_pre_response) {
                                            recovery_record.begin(RecoveryDecision::Compact);
                                            recovery_record.complete(RecoveryOutcome::PolicyRejected);
                                        }
                                        if !training_mode
                                            && reasoning_recovery_pre_response
                                            && reactive_compact_retries == 0
                                            && http_recovery_action(&e) == Some(HttpRecoveryAction::CompactNow)
                                        {
                                            reactive_compact_retries = 1;
                                            recovery_record.begin(RecoveryDecision::Compact);
                                            let compaction = engine
                                                .perform_compaction_with_recovery_deadline(
                                                    true, false, true, Some(engine.cancel_token()),
                                                    recovery_deadline,
                                                )
                                                .await;
                                            recovery_record.compact_result(compaction.as_ref().map(|r| r.did_compact).map_err(|_| ()));
                                            if engine.is_cancelled() {
                                                recovery_record.stop(RecoveryOutcome::Cancelled);
                                                if let Err(error) = &compaction {
                                                    warn!("reactive compaction ended with an error during cancellation: {error}");
                                                }
                                                yield EngineEvent::StreamAborted {
                                                    reason: "cancelled by user".into(),
                                                };
                                                return;
                                            }
                                            if let Some(event) = recovery_deadline.stop_event(&engine.cancel_token()) {
                                                recovery_record.stopped(&event);
                                                yield event;
                                                return;
                                            }
                                            match compaction {
                                                Ok(result) if result.did_compact => {
                                                    yield EngineEvent::SystemNotice(format!(
                                                        "Provider rejected the context; reactive compact completed: {} -> {} tokens. Retrying once.",
                                                        result.pre_compact_tokens, result.post_compact_tokens
                                                    ));
                                                    continue 'turn_loop;
                                                }
                                                Ok(_) | Err(_) => {}
                                            }
                                        }
                                        if is_retryable_api_error(&e) {
                                            if is_rate_limit_api_error(&e) {
                                                rate_limit_streak += 1;
                                            } else {
                                                rate_limit_streak = 0;
                                            }
                                        }
                                        if reasoning_recovery_pre_response && attempt < max_retries
                                            && is_retryable_api_error(&e)
                                            && rate_limit_streak <= RATE_LIMIT_MAX_RETRIES
                                        {
                                            attempt += 1;
                                            let reason = retry_error_summary(&e);
                                            let idle_note = if is_stream_idle {
                                                Some(
                                                    graded_idle_timeout(DEFAULT_STREAM_IDLE_TIMEOUT, attempt)
                                                        .as_secs(),
                                                )
                                            } else {
                                                None
                                            };
                                            let delay = api_server_retry_after(&e)
                                                .map(|after| {
                                                    backoff_delay(base_delay_ms, attempt as u32).max(after)
                                                })
                                                .unwrap_or_else(|| {
                                                    backoff_delay(base_delay_ms, attempt as u32)
                                                });
                                            let mut details = provider_retry_details(
                                                &e,
                                                "main",
                                                provider_for_turn.name(),
                                                &model,
                                                attempt,
                                                max_retries,
                                                reason.clone(),
                                                delay,
                                                request_started_at,
                                                turn_started_at,
                                                provider_transport_started_at,
                                                first_token_at,
                                                last_token_at,
                                            );
                                            if let Some(seconds) = idle_note {
                                                details.reason.push_str(&format!(
                                                    "; next idle tolerance={}s",
                                                    seconds
                                                ));
                                            }
                                            recovery_record.begin(RecoveryDecision::RetryWait);
                                            yield EngineEvent::ProviderRetry(details);
                                            warn!(
                                                "stream error retry {}/{} in {:?}: {}",
                                                attempt, max_retries, delay, reason
                                            );
                                            if let Some(event) = recovery_deadline.backoff(engine.cancel_token(), delay).await {
                                                recovery_record.stopped(&event);
                                                yield event;
                                                return;
                                            }
                                            recovery_record.complete(RecoveryOutcome::WaitCompleted);
                                            continue 'api_attempt;
                                        }
                                        if is_retryable_api_error(&e) {
                                            recovery_record.rejected(attempt >= max_retries || rate_limit_streak > RATE_LIMIT_MAX_RETRIES);
                                        }
                                        let provider = engine.provider_name();
                                        let details = retry_policy::provider_failure_details(&e, response_started || provider_output_published || turn_count > 1);
                                        recovery_record.provider_failed(&details);
                                        let message = if is_stream_idle {
                                            format!(
                                                "{} provider stream idle: {}. Try again or increase the idle timeout.",
                                                provider, msg
                                            )
                                        } else {
                                            error!("{} provider stream error: {}", provider, e);
                                            provider_error_message(&provider, &e)
                                        };
                                        yield EngineEvent::ProviderFailed { message, details };
                                        return;
                                    }
                                }
                            }
                            drop(stream);
                            for event in path_previews.clear() {
                                yield event;
                            }
                            capture.finish(None);
                            recovery_record.success();
                            if !background_runs_in_request.is_empty()
                                && let Err(error) = engine.state.flush_history().await.and_then(|()| engine.state.acknowledge_background_runs_in_parent(&background_runs_in_request))
                            {
                                tracing::warn!(%error, "parent response background acknowledgement remains pending");
                            }
                            // A successful stream breaks any consecutive-429 streak so
                            // the smaller rate-limit budget only applies to genuine
                            // back-to-back rate limiting.
                            rate_limit_streak = 0;
                            // A successful response starts a fresh budget for the next request.
                            attempt = 0;
                            recovery_disable_reasoning = false;
                            recovery_deadline = recovery_deadline::RecoveryDeadline::default();
                            break 'api_attempt;
                        }

                        // Run Stop hooks before executing any tools.
                        let (stop_events, stop_continuation) = engine.run_stop_hooks().await;
                        for ev in stop_events {
                            yield ev;
                        }
                        if stop_continuation {
                            break;
                        }

                        // No tools requested: the turn is complete, unless we have deferred
                        // background events that need to be fed back to the model.
                        if pending_tool_uses.is_empty() {
                            let events = std::mem::take(&mut deferred_background_events);
                            if !events.is_empty() {
                                let before_delivery = engine.state.shared_messages_with_revision().1;
                                for event in events {
                                    for event in engine.apply_background_event_with_hooks(event).await {
                                        yield event;
                                    }
                                }
                                if engine.state.shared_messages_with_revision().1 != before_delivery {
                                    can_drain_turn_steers = true;
                                    continue;
                                }
                            }

        // A response without tools is also a safety boundary. If the user submits
        // steering while the model streams, continue the same turn after finishing the
        // current assistant message.
                            let steers = turn_steer_session
                                .as_ref()
                                .map(TurnSteerSession::drain_pending)
                                .unwrap_or_default();
                            if !steers.is_empty() {
                                for id in engine.apply_turn_steers(steers) {
                                    yield EngineEvent::TurnSteerApplied { id };
                                }
                                can_drain_turn_steers = true;
                                continue;
                            }
                            match engine
                                .apply_pending_subagent_deliveries_at_safe_boundary()
                                .await
                            {
                                Ok(applied) if !applied.is_empty() => {
                                    for steer in applied {
                                        yield EngineEvent::SubagentSteerApplied {
                                            agent_id: steer.agent_id,
                                            message_id: steer.message_id,
                                            queue_depth: steer.queue_depth,
                                        };
                                    }
                                    can_drain_turn_steers = true;
                                    subagent_deliveries_ready_for_next_request = true;
                                    continue;
                                }
                                Ok(_) => {}
                                Err(error) => {
                                    yield EngineEvent::Error(format!(
                                        "failed to apply queued sub-agent message at final safe boundary: {error:#}"
                                    ));
                                    break;
                                }
                            }
                            if last_response_was_empty {
                                // The model finished a response with no visible text
                                // and no tool calls (e.g. thinking-only). Treating
                                // that as completion would silently end headless
                                // sessions mid-task, so nudge it to continue within a
                                // bounded limit instead.
                                if consecutive_empty_responses >= EMPTY_RESPONSE_NUDGE_LIMIT {
                                    yield EngineEvent::SystemNotice(format!(
                                        "Model returned {} consecutive empty responses (no text, no tool calls); ending the turn.",
                                        consecutive_empty_responses
                                    ));
                                } else {
                                    consecutive_empty_responses += 1;
                                    yield EngineEvent::SystemNotice(format!(
                                        "Model returned an empty response (no text, no tool calls); nudging it to continue ({consecutive_empty_responses}/{EMPTY_RESPONSE_NUDGE_LIMIT})."
                                    ));
                                    engine.state.add_message(Message::runtime_text(EMPTY_RESPONSE_NUDGE));
                                    can_drain_turn_steers = true;
                                    continue;
                                }
                            }
                            if is_main_thread
                                && let Some(reminder) = engine.todo_idle_update_reminder(
                                    todo_updated_this_turn,
                                    todo_idle_reminder_sent,
                                )
                            {
                                todo_idle_reminder_sent = true;
                                engine.state.add_message(Message::runtime_text(reminder));
                                can_drain_turn_steers = true;
                                continue;
                            }

        // Closing and the final drain must share one lock. New input after closure
        // receives NoActiveTurn explicitly and is retained by the caller for the next turn.
                            let boundary = turn_steer_session
                                .as_mut()
                                .map(TurnSteerSession::finish_or_drain)
                                .unwrap_or(TurnSteerBoundary::Finished);
                            if let TurnSteerBoundary::Pending(steers) = boundary {
                                for id in engine.apply_turn_steers(steers) {
                                    yield EngineEvent::TurnSteerApplied { id };
                                }
                                can_drain_turn_steers = true;
                                continue;
                            }
                            if is_main_thread
                                && let Some(fingerprint) =
                                    goal_continuation::goal_progress_fingerprint(&recent_tools, &touched_paths)
                                && let Some(goal) =
                                    engine.state.record_goal_progress_fingerprint(&fingerprint)
                                && goal.stall_count >= 2
                            {
                                tracing::info!(
                                    goal_id = %goal.goal_id,
                                    stall_count = goal.stall_count,
                                    "goal progress fingerprint repeated"
                                );
                            }
                            engine.maybe_spawn_session_memory_update(turn_count, &recent_tools);
                            engine.maybe_extract_memories(&recent_tools).await;
                            engine.maybe_spawn_skill_review(&recent_tools);
                            engine.maybe_spawn_auto_curator();
                            if duration_final_subturn_granted {
                                yield EngineEvent::StreamAborted {
                                    reason: "max_duration".to_string(),
                                };
                            }
                            break;
                        }

                        // Execute pending tools concurrently and feed the results back
                        // to the model in a single user message. TUI result events are
                        // yielded as soon as each tool completes, while the final
                        // tool_result blocks stay in the order the assistant requested
                        // them.
                        let storage = ToolResultStorage::new(engine.session_dir());
                        let (max_out, head_out, tail_out) = {
                            let s = recover_read_lock(&engine.settings, "settings");
                            (
                                s.max_tool_output_bytes,
                                s.tool_output_head_bytes,
                                s.tool_output_tail_bytes,
                            )
                        };
                        let tool_count = pending_tool_uses.len();
                        let pending_tool_meta: Vec<(String, String)> = pending_tool_uses
                            .iter()
                            .map(|(id, name, _)| (id.clone(), name.clone()))
                            .collect();
                        let tool_items: Vec<ToolUseItem> = pending_tool_uses
                            .into_iter()
                            .enumerate()
                            .map(|(index, (id, name, input))| ToolUseItem {
                                index,
                                id,
                                name,
                                input,
                            })
                            .collect();
                        let arrangement_mode = engine.is_arrangement_mode_active();
                        // A provider may emit unsolicited tool calls even when tools were
                        // omitted. Execute only names attached to this exact request, not
                        // a later live capability/profile configuration. Existing runtime
                        // permission checks may further restrict this immutable allowset.
                        let request_tool_names = available_tool_names.iter().cloned().collect::<Vec<_>>();
                        let active_tools = Arc::new(engine.active_tool_registry_for_mode(arrangement_mode)
                            .filtered_to_names(&request_tool_names));
                        let groups = partition_tool_uses(tool_items, active_tools.as_ref());

                        let mut tool_result_blocks: Vec<Option<ContentBlock>> =
                            (0..tool_count).map(|_| None).collect();
                        let mut tool_user_context: Vec<Option<Vec<ContentBlock>>> =
                            (0..tool_count).map(|_| None).collect();
                        let mut background_result_deliveries = Vec::new();
                        let mut cancelled_during_tools = false;
                        let mut completed_tool_calls: Vec<(String, bool)> = Vec::new();
                        let mut permission_denial_outcomes: Vec<Option<String>> =
                            (0..tool_count).map(|_| None).collect();

                        let run_tool_item = |item: ToolUseItem| {
                            let engine = engine.clone();
                            let storage = storage.clone();
                            let active_tools = active_tools.clone();
                            async move {
                                let ToolUseItem {
                                    index,
                                    id,
                                    name,
                                    input,
                                } = item;
                                match engine
                                    .execute_tool_with_registry(
                                        &id,
                                        &name,
                                        input,
                                        prompt,
                                        active_tools.as_ref(),
                                        arrangement_mode,
                                    )
                                    .await
                                {
                                    Ok((mut output, decision, _modified_input, hook_events)) => {
                                        let is_error =
                                            output.is_error || decision == PermissionDecision::Deny;
                                        let permission_denied = hook_events
                                            .iter()
                                            .any(|event| matches!(event, EngineEvent::ToolDenied { .. }));

                                        // Defense in depth: even if a tool returned a
                                        // multi-megabyte payload without going through
                                        // `ctx.truncate`, cap it here before any of it
                                        // reaches the TUI / next API request.
                                        if max_out > 0 {
                                            let (new_blocks, infos) =
                                                kcoder_tools::truncate_tool_output(
                                                    &output.content,
                                                    max_out,
                                                    head_out,
                                                    tail_out,
                                                );
                                            if !infos.is_empty() {
                                                debug!(
                                                    "tool {} returned {} bytes of output; truncated to {} bytes",
                                                    name,
                                                    infos[0].original_bytes,
                                                    infos[0].kept_bytes
                                                );
                                            }
                                            output.content = new_blocks;
                                        }

                                        // Clone the content so we can keep `output`
                                        // intact for the result event emitted after
                                        // all tools finish.
                                        let mut content = output.content.clone();

                                        // Persist very large tool results to disk and
                                        // replace them with a preview reference.
                                        if let Err(e) =
                                            storage.enforce_tool_result(&name, &id, &mut content).await
                                        {
                                            warn!(
                                                "failed to enforce tool result storage for {}: {}",
                                                name, e
                                            );
                                        }

                                        let user_context = output.user_context.clone();
                                        Ok((
                                            index,
                                            id,
                                            name,
                                            output,
                                            hook_events,
                                            content,
                                            user_context,
                                            is_error,
                                            permission_denied,
                                        ))
                                    }
                                    Err(e) => {
                                        error!("tool {} execution failed: {}", name, e);
                                        Err((index, id, name, e))
                                    }
                                }
                            }
                        };

                        'tool_groups: for group in groups {
                            if group.sequential {
                                for item in group.items {
                                    recent_tools.push(item.name.clone());
                                    let result = tokio::select! {
                                        biased;
                                        _ = engine.cancel_token().cancelled_owned() => {
                                            cancelled_during_tools = true;
                                            yield EngineEvent::StreamAborted {
                                                reason: "cancelled by user".into(),
                                            };
                                            break 'tool_groups;
                                        }
                                        result = run_tool_item(item) => result,
                                    };
                                    match result {
                                        Ok((index, id, name, output, hook_events, content, user_context, is_error, permission_denied)) => {
                                            completed_tool_calls.push((name.clone(), is_error));
                                            if permission_denied {
                                                permission_denial_outcomes[index] =
                                                    Some(permission_capability_class(&name));
                                            }
                                            for ev in hook_events {
                                                yield ev;
                                            }
                                            background_result_deliveries.extend(output.execution_metadata.iter().filter_map(|metadata| match metadata {
                                                kcoder_tools::ToolExecutionMetadata::BackgroundResultDelivery { run } => Some(run.clone()),
                                                _ => None,
                                            }));
                                            yield EngineEvent::ToolResult {
                                                id: id.clone(),
                                                name: name.clone(),
                                                output: output.clone(),
                                            };
                                            tool_result_blocks[index] = Some(ContentBlock::ToolResult {
                                                tool_use_id: id,
                                                content,
                                                is_error: Some(is_error),
                                            });
                                            tool_user_context[index] = Some(user_context);
                                        }
                                        Err((index, id, name, e)) => {
                                            completed_tool_calls.push((name.clone(), true));
                                            let output = ToolOutput::error(format!("Error: {}", e));
                                            background_result_deliveries.extend(output.execution_metadata.iter().filter_map(|metadata| match metadata {
                                                kcoder_tools::ToolExecutionMetadata::BackgroundResultDelivery { run } => Some(run.clone()),
                                                _ => None,
                                            }));
                                            yield EngineEvent::ToolResult {
                                                id: id.clone(),
                                                name: name.clone(),
                                                output: output.clone(),
                                            };
                                            tool_result_blocks[index] = Some(ContentBlock::ToolResult {
                                                tool_use_id: id,
                                                content: output.content,
                                                is_error: Some(true),
                                            });
                                        }
                                    }
                                }
                            } else {
                                for item in &group.items {
                                    recent_tools.push(item.name.clone());
                                }
                                let mut tool_futures: FuturesUnordered<_> =
                                    group.items.into_iter().map(&run_tool_item).collect();
                                while let Some(result) = tokio::select! {
                                    biased;
                                    _ = engine.cancel_token().cancelled_owned() => {
                                        cancelled_during_tools = true;
                                        yield EngineEvent::StreamAborted {
                                            reason: "cancelled by user".into(),
                                        };
                                        break 'tool_groups;
                                    }
                                    result = tool_futures.next() => result,
                                } {
                                    match result {
                                        Ok((index, id, name, output, hook_events, content, user_context, is_error, permission_denied)) => {
                                            completed_tool_calls.push((name.clone(), is_error));
                                            if permission_denied {
                                                permission_denial_outcomes[index] =
                                                    Some(permission_capability_class(&name));
                                            }
                                            for ev in hook_events {
                                                yield ev;
                                            }
                                            background_result_deliveries.extend(output.execution_metadata.iter().filter_map(|metadata| match metadata {
                                                kcoder_tools::ToolExecutionMetadata::BackgroundResultDelivery { run } => Some(run.clone()),
                                                _ => None,
                                            }));
                                            yield EngineEvent::ToolResult {
                                                id: id.clone(),
                                                name: name.clone(),
                                                output: output.clone(),
                                            };
                                            tool_result_blocks[index] = Some(ContentBlock::ToolResult {
                                                tool_use_id: id,
                                                content,
                                                is_error: Some(is_error),
                                            });
                                            tool_user_context[index] = Some(user_context);
                                        }
                                        Err((index, id, name, e)) => {
                                            completed_tool_calls.push((name.clone(), true));
                                            let output = ToolOutput::error(format!("Error: {}", e));
                                            background_result_deliveries.extend(output.execution_metadata.iter().filter_map(|metadata| match metadata {
                                                kcoder_tools::ToolExecutionMetadata::BackgroundResultDelivery { run } => Some(run.clone()),
                                                _ => None,
                                            }));
                                            yield EngineEvent::ToolResult {
                                                id: id.clone(),
                                                name: name.clone(),
                                                output: output.clone(),
                                            };
                                            tool_result_blocks[index] = Some(ContentBlock::ToolResult {
                                                tool_use_id: id,
                                                content: output.content,
                                                is_error: Some(true),
                                            });
                                        }
                                    }
                                }
                            }
                        }

                        if cancelled_during_tools {
                            for (index, block) in tool_result_blocks.iter_mut().enumerate() {
                                if block.is_some() {
                                    continue;
                                }
                                let Some((id, name)) = pending_tool_meta.get(index).cloned() else {
                                    continue;
                                };
                                let output =
                                    ToolOutput::error("Tool call was interrupted by the user.".to_string());
                                yield EngineEvent::ToolResult {
                                    id: id.clone(),
                                    name,
                                    output: output.clone(),
                                };
                                *block = Some(ContentBlock::ToolResult {
                                    tool_use_id: id,
                                    content: output.content,
                                    is_error: Some(true),
                                });
                            }
                        }
                        let mut permission_denial_limit_reached = None;
                        if stop_on_permission_denial && !cancelled_during_tools {
                            for capability in permission_denial_outcomes {
                                let Some(capability) = capability else {
                                    continue;
                                };
                                if permission_denial_streak.0.as_deref() == Some(capability.as_str()) {
                                    permission_denial_streak.1 += 1;
                                } else {
                                    permission_denial_streak = (Some(capability.clone()), 1);
                                }
                                if permission_denial_streak.1 >= permission_denial_limit {
                                    permission_denial_limit_reached = Some((
                                        capability,
                                        permission_denial_streak.1,
                                    ));
                                    break;
                                }
                            }
                        }
                        let tool_result_blocks: Vec<ContentBlock> =
                            tool_result_blocks.into_iter().flatten().collect();
                        let todo_update_reminder = if cancelled_during_tools {
                            None
                        } else {
                            engine.todo_update_reminder_after_tools(&completed_tool_calls)
                        };
                        if completed_tool_calls
                            .iter()
                            .any(|(name, is_error)| name == "TodoWrite" && !*is_error)
                        {
                            todo_updated_this_turn = true;
                        }

                        // Append a user message containing all tool results so the model can continue.
                        let tool_result_message = Message::User { content: tool_result_blocks, origin: kcoder_types::MessageOrigin::Runtime };
                        if background_result_deliveries.is_empty() {
                            engine.state.add_message(tool_result_message);
                        } else {
                            let message_id = uuid::Uuid::new_v4().to_string();
                            if let Err(error) = engine.state.reserve_background_result_delivery(&background_result_deliveries, &message_id) {
                                yield EngineEvent::StreamAborted { reason: format!("background_result_reservation_failed: {error:#}") };
                                break;
                            }
                            if let Err(error) = engine.state.commit_message_with_uuid(tool_result_message, &message_id).await {
                                let _ = engine.state.release_background_result_delivery(&background_result_deliveries, &message_id);
                                yield EngineEvent::StreamAborted { reason: format!("background_result_persistence_failed: {error:#}") };
                                break;
                            }
                            for run in &background_result_deliveries {
                                if let Err(error) = engine.state.confirm_background_result_delivery(run, &message_id) {
                                    tracing::warn!(run_id = %run.run_id, %error, "background result receipt remains pending");
                                }
                            }
                        }
                        for content in tool_user_context.into_iter().flatten() {
                            if !content.is_empty() {
                                engine.state.add_message(Message::User { content, origin: kcoder_types::MessageOrigin::Runtime });
                            }
                        }
                        if let Some(reminder) = todo_update_reminder {
                            engine.state.add_message(Message::runtime_text(reminder));
                        }

                        if cancelled_during_tools {
                            break;
                        }

                        if let Some((capability, count)) = permission_denial_limit_reached {
                            yield EngineEvent::SystemNotice(format!(
                                "Unattended permission guard stopped the tool loop after {count} consecutive `{capability}` denials. Minimum capability required: {}.",
                                permission_capability_hint(&capability)
                            ));
                            yield EngineEvent::StreamAborted {
                                reason: format!("permission_denial_limit:{capability}"),
                            };
                            break;
                        }

                        // Now that tool results are in place, apply any background events that
                        // arrived while streaming. They come after the tool_result pair so the
                        // tool_use/tool_result invariant is preserved.
                        let events = std::mem::take(&mut deferred_background_events);
                        for event in events {
                            for event in engine.apply_background_event_with_hooks(event).await {
                                yield event;
                            }
                        }

        // Steering may be consumed before the next provider cycle because the complete
        // tool_result batch is already in state and protocol adjacency remains intact.
                        can_drain_turn_steers = true;

        // Once the runtime accepts VerifierVote, end the verifier session at the current
        // tool-batch boundary. Actions after a vote only consume turns and dilute verdict
        // semantics. Preserve the recorded tool trace unchanged and apply machine gates
        // to the complete trace as usual.
                        if engine.terminal_verdict_turn.load(Ordering::SeqCst)
                            && (recover_read_lock(
                                &engine.verifier_vote_channel,
                                "verifier_vote_channel",
                            )
                            .as_ref()
                            .is_some_and(|channel| channel.recorded_vote().is_some())
                                || recover_read_lock(
                                    &engine.review_vote_channel,
                                    "review_vote_channel",
                                )
                                .as_ref()
                                .is_some_and(|channel| channel.recorded_vote().is_some()))
                        {
                            break;
                        }

                        // Recursion boundary: turn count increments only when tool
                        // results are about to be sent back to the API.
                        let next_turn_count = turn_count + 1;
                        if next_turn_count > max_turns {
                            yield EngineEvent::MaxTurnsReached {
                                max_turns,
                                turn_count: next_turn_count,
                            };
                            break;
                        }
                        turn_count = next_turn_count;
                    }
                })
    }
}
