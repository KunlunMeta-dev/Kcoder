//! Turn entry within the shared engine ownership boundary.

use super::*;
mod input_owner;
use input_owner::InputAdmissionGuard;
#[cfg(test)]
#[path = "turn_entry/async_question_tests.rs"]
mod async_question_tests;
#[cfg(test)]
#[path = "turn_entry/side_question_tests.rs"]
mod side_question_tests;

pub(super) type AsyncQuestionDeliveryClaim =
    kcoder_types::async_user_questions::AsyncQuestionDeliveryClaim;

pub(super) async fn commit_async_question_answer(
    engine: &QueryEngine,
    owner: &kcoder_state::AppStateLifecycleIdentity,
    claim: &AsyncQuestionDeliveryClaim,
) -> Result<(kcoder_state::CommittedUserInput, Vec<EngineEvent>), Vec<EngineEvent>> {
    commit_async_question_answer_inner(engine, owner, claim, None).await
}

async fn commit_async_question_answer_with_guard(
    engine: &QueryEngine,
    owner: &kcoder_state::AppStateLifecycleIdentity,
    claim: &AsyncQuestionDeliveryClaim,
    input_guard: &mut InputAdmissionGuard,
) -> Result<(kcoder_state::CommittedUserInput, Vec<EngineEvent>), Vec<EngineEvent>> {
    commit_async_question_answer_inner(engine, owner, claim, Some(input_guard)).await
}

async fn commit_async_question_answer_inner(
    engine: &QueryEngine,
    owner: &kcoder_state::AppStateLifecycleIdentity,
    claim: &AsyncQuestionDeliveryClaim,
    mut input_guard: Option<&mut InputAdmissionGuard>,
) -> Result<(kcoder_state::CommittedUserInput, Vec<EngineEvent>), Vec<EngineEvent>> {
    let mut events = Vec::new();
    if !engine.user_interaction_round_is_attended() {
        let reason = "the current channel round is unattended; async answers cannot be delivered in this round";
        let _ = engine
            .state
            .mark_async_question_delivery_failed(owner, claim, reason);
        return Err(vec![EngineEvent::Error(reason.into())]);
    }
    let fail_unknown = |reason: String| {
        let _ = engine
            .state
            .mark_async_question_delivery_unknown(owner, claim, &reason);
        vec![EngineEvent::Error(format!(
            "Async answer delivery is uncertain: {reason}. No model request was sent."
        ))]
    };

    match engine
        .state
        .find_committed_user_input_identified(owner, &claim.message_id, &claim.message)
        .await
    {
        Ok(Some(committed)) if committed.outcome() == kcoder_state::UserInputCommit::Durable => {
            if let Err(error) = engine
                .state
                .mark_async_question_context_applied(owner, claim, &committed)
            {
                return Err(fail_unknown(format!(
                    "could not acknowledge committed async answer: {error:#}"
                )));
            }
            return Ok((committed, events));
        }
        Ok(Some(_)) => {
            return Err(fail_unknown(
                "identified async answer has no durable history receipt".into(),
            ));
        }
        Ok(None) => {}
        Err(error) => {
            return Err(fail_unknown(format!(
                "history receipt lookup failed: {error:#}"
            )));
        }
    }

    let prompt_text = claim.message.preview(usize::MAX);
    let (hook_events, modified_text, blocking_error) =
        engine.run_user_prompt_submit_hooks(&prompt_text).await;
    events.extend(hook_events);
    let delivery_error = if let Some(error) = blocking_error {
        Some(format!(
            "user prompt submit hook blocked the async answer: {error}"
        ))
    } else if modified_text
        .as_deref()
        .is_some_and(|modified| modified != prompt_text)
    {
        Some("user prompt submit hook changed the durable async answer; the original answer is retained and was not delivered".to_string())
    } else {
        None
    };
    if let Some(error) = delivery_error {
        let _ = engine
            .state
            .mark_async_question_delivery_failed(owner, claim, &error);
        events.push(EngineEvent::HookMessage {
            text: error.clone(),
            is_error: true,
        });
        events.push(EngineEvent::Error(error));
        return Err(events);
    }

    let cancel = engine.cancel_token();
    let mut delay = Duration::from_millis(5);
    loop {
        if cancel.is_cancelled() {
            let _ = engine.state.mark_async_question_delivery_failed(
                owner,
                claim,
                "cancelled before identified input admission",
            );
            events.push(EngineEvent::StreamAborted {
                reason: "cancelled by user".into(),
            });
            return Err(events);
        }

        if let Some(guard) = input_guard.as_deref_mut() {
            guard.arm();
        }
        let start = match engine.state.try_begin_async_question_delivery(owner, claim) {
            Ok(start) => start,
            Err(error) => {
                if let Some(guard) = input_guard.as_deref_mut() {
                    guard.disarm();
                }
                return Err(fail_unknown(format!(
                    "async answer claim could not be validated before input admission: {error:#}"
                )));
            }
        };
        match start {
            kcoder_state::UserInputStart::Busy(_) => {
                if let Some(guard) = input_guard.as_deref_mut() {
                    guard.disarm();
                }
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => {
                        let _ = engine.state.mark_async_question_delivery_failed(
                            owner,
                            claim,
                            "cancelled before identified input admission",
                        );
                        events.push(EngineEvent::StreamAborted {
                            reason: "cancelled by user".into(),
                        });
                        return Err(events);
                    }
                    _ = tokio::time::sleep(delay) => {}
                }
                delay = delay.saturating_mul(2).min(Duration::from_millis(250));
            }
            kcoder_state::UserInputStart::Rejected { error, .. } => {
                if let Some(guard) = input_guard.as_deref_mut() {
                    guard.disarm();
                }
                match engine
                    .state
                    .find_committed_user_input_identified(owner, &claim.message_id, &claim.message)
                    .await
                {
                    Ok(Some(committed))
                        if committed.outcome() == kcoder_state::UserInputCommit::Durable =>
                    {
                        if let Err(mark_error) = engine
                            .state
                            .mark_async_question_context_applied(owner, claim, &committed)
                        {
                            return Err(fail_unknown(format!(
                                "could not acknowledge reconciled async answer: {mark_error:#}"
                            )));
                        }
                        return Ok((committed, events));
                    }
                    Ok(Some(_)) => {
                        return Err(fail_unknown(
                            "identified async answer has no durable history receipt".into(),
                        ));
                    }
                    Ok(None) => {
                        let _ = engine
                            .state
                            .mark_async_question_delivery_failed(owner, claim, &error);
                        events.push(EngineEvent::Error(format!(
                            "The async answer was not submitted: {error}"
                        )));
                        return Err(events);
                    }
                    Err(receipt_error) => {
                        return Err(fail_unknown(format!(
                            "identified history reconciliation failed: {receipt_error:#}"
                        )));
                    }
                }
            }
            kcoder_state::UserInputStart::Unknown {
                error,
                pending: None,
                ..
            } => {
                let _ = engine
                    .state
                    .mark_async_question_delivery_unknown(owner, claim, &error);
                engine
                    .input_persistence_failed
                    .store(true, Ordering::Release);
                events.push(EngineEvent::Error(
                    "Async answer input durability is uncertain; no model request was sent. Reload this session before continuing."
                        .into(),
                ));
                return Err(events);
            }
            kcoder_state::UserInputStart::Unknown {
                error: _,
                pending: Some(pending),
                ..
            }
            | kcoder_state::UserInputStart::Accepted(pending) => {
                if !pending.ticket_is_retained() {
                    let _ = engine.state.mark_async_question_delivery_unknown(
                        owner,
                        claim,
                        "identified input ticket was not retained",
                    );
                    engine
                        .input_persistence_failed
                        .store(true, Ordering::Release);
                    events.push(EngineEvent::Error(
                        "Async answer input durability is uncertain; no model request was sent. Reload this session before continuing."
                            .into(),
                    ));
                    return Err(events);
                }
                let settled = tokio::select! {
                    biased;
                    result = pending.wait_with_witness() => Some(result),
                    _ = cancel.cancelled() => None,
                };
                let Some(settled) = settled else {
                    let _ = engine.state.mark_async_question_delivery_unknown(
                        owner,
                        claim,
                        "cancelled while the original input ticket was settling",
                    );
                    engine
                        .input_persistence_failed
                        .store(true, Ordering::Release);
                    events.push(EngineEvent::StreamAborted {
                        reason: "cancelled by user".into(),
                    });
                    return Err(events);
                };
                let committed = match settled {
                    Ok(committed)
                        if committed.outcome() == kcoder_state::UserInputCommit::Durable =>
                    {
                        committed
                    }
                    Ok(_) => {
                        let _ = engine.state.mark_async_question_delivery_unknown(
                            owner,
                            claim,
                            "identified answer was only committed ephemerally",
                        );
                        engine
                            .input_persistence_failed
                            .store(true, Ordering::Release);
                        events.push(EngineEvent::Error(
                            "The async answer has no durable history receipt; no model request was sent."
                                .into(),
                        ));
                        return Err(events);
                    }
                    Err(error) => {
                        let _ = engine.state.mark_async_question_delivery_unknown(
                            owner,
                            claim,
                            &format!("original input receipt is unknown: {error:#}"),
                        );
                        engine
                            .input_persistence_failed
                            .store(true, Ordering::Release);
                        events.push(EngineEvent::Error(
                            "Async answer input durability is uncertain; no model request was sent. Reload this session before continuing."
                                .into(),
                        ));
                        return Err(events);
                    }
                };
                if let Err(error) = engine
                    .state
                    .mark_async_question_context_applied(owner, claim, &committed)
                {
                    if let Some(guard) = input_guard.as_deref_mut() {
                        guard.disarm();
                    }
                    return Err(fail_unknown(format!(
                        "could not acknowledge durable async answer: {error:#}"
                    )));
                }
                return Ok((committed, events));
            }
        }
    }
}

impl QueryEngine {
    /// Answer one isolated `/btw` side question without mutating the main
    /// conversation or exposing tools to the side request.
    ///
    /// The preferred context is the cache-safe snapshot captured for the
    /// current provider/model. Before the first request boundary, or after a
    /// runtime switch, fall back to a repaired compact-aware snapshot of the
    /// live conversation. The caller owns cancellation so dismissing the side
    /// question never cancels the main turn.
    pub async fn run_side_question(
        &self,
        question: &str,
        cancel_token: CancellationToken,
    ) -> anyhow::Result<String> {
        let owner = match self.state.current_scoped_lifecycle_identity() {
            kcoder_state::ScopedLifecycleIdentity::Matching(owner) => Some(owner),
            kcoder_state::ScopedLifecycleIdentity::Absent => {
                self.state.try_inspection_lifecycle_identity()
            }
            kcoder_state::ScopedLifecycleIdentity::Foreign => {
                anyhow::bail!("side question belongs to another session")
            }
        }
        .context("side question session is busy")?;
        self.run_side_question_for_lifecycle(question, &owner, cancel_token)
            .await
    }

    /// Use the host's original lifecycle when a side question was queued
    /// before asynchronous input preparation or session switching.
    pub async fn run_side_question_for_lifecycle(
        &self,
        question: &str,
        owner: &kcoder_state::AppStateLifecycleIdentity,
        cancel_token: CancellationToken,
    ) -> anyhow::Result<String> {
        let question = question.trim();
        if question.is_empty() {
            anyhow::bail!("side question must not be empty");
        }
        anyhow::ensure!(!cancel_token.is_cancelled(), "cancelled by user");
        let input_gate = Arc::clone(&self.input_session_end_gate)
            .try_write_owned()
            .map_err(|_| anyhow::anyhow!("input confirmation is still in progress"))?;
        anyhow::ensure!(
            !self.input_persistence_failed.load(Ordering::Acquire),
            "input confirmation is unknown"
        );
        let snapshot = self
            .state
            .try_capture_side_question_snapshot(owner)?
            .context("side question session is busy")?;
        // Only the original read-only State snapshot is captured under this
        // gate. Profile reads and Provider work must not hold it.
        drop(input_gate);

        let (model, max_tokens, reasoning_effort) = {
            let settings = recover_read_lock(&self.settings, "settings");
            (
                settings.model.clone(),
                settings
                    .max_tokens
                    .unwrap_or(kcoder_types::DEFAULT_MODEL_OUTPUT_TOKENS),
                settings
                    .model_capabilities
                    .reasoning
                    .then(|| settings.model_reasoning_effort.clone())
                    .flatten(),
            )
        };
        let provider_name = self.provider_name();
        let mut messages: kcoder_types::SharedMessages = self
            .side_question_cache_snapshot(snapshot.owner())
            .filter(|snapshot| {
                snapshot.full_context_compatible
                    && snapshot.snapshot_provider == provider_name
                    && snapshot.snapshot_model == model
            })
            .map(|snapshot| snapshot.fork_context_messages.clone())
            .unwrap_or_else(|| {
                message_repair::prepare_shared_request_messages(snapshot.messages()).0
            });
        self.prepend_project_user_context(&mut messages)?;
        self.project_skill_messages(&mut messages);
        self.project_tool_discovery_messages(&mut messages);
        messages.push(Message::user_text(format_side_question_prompt(question)));

        let mut system_prompt = build_side_question_system_prompt_for_work_mode(
            &self.cwd,
            &model,
            self.effective_studio_work_mode(),
        );
        self.apply_agent_definition_identity(&mut system_prompt);

        let request = MessagesRequest::new_shared(model, messages)
            .with_system(system_prompt)
            // Deliberately omit tool definitions. `/btw` is one informational
            // response, not a second agentic loop.
            .with_max_tokens(max_tokens)
            .with_reasoning_effort(reasoning_effort)
            .with_debug_session_id(snapshot.session_id().to_owned());
        anyhow::ensure!(!cancel_token.is_cancelled(), "cancelled by user");
        match snapshot.try_is_current(&self.state)? {
            Some(true) => {}
            Some(false) => anyhow::bail!("side question session changed before dispatch"),
            None => anyhow::bail!("side question session is busy"),
        }
        let response = collect_provider_text(self.current_provider(), request, cancel_token)
            .await?
            .trim()
            .to_string();
        if response.is_empty() {
            anyhow::bail!("no response received for side question");
        }
        Ok(response)
    }

    /// Append a user message and run a single turn as a live event stream.
    ///
    /// Prompt-submit hooks and memory prompt recording happen before the model
    /// turn begins, preserving the semantics of [`Self::submit_message`] while
    /// allowing headless and UI callers to consume progress immediately.
    pub fn submit_message_stream<'a, P: PermissionPrompt>(
        &'a self,
        text: impl Into<String>,
        permissions: &'a P,
    ) -> Pin<Box<dyn Stream<Item = EngineEvent> + Send + 'a>> {
        let text = text.into();
        self.submit_message_content_stream(Message::user_text(text.clone()), text, permissions)
    }

    /// Append a user message with structured content and run one live event stream.
    /// Prompt text is used for UserPromptSubmit hooks and memory records, while
    /// structured blocks such as images are preserved for the provider request.
    pub fn submit_message_content_stream<'a, P: PermissionPrompt>(
        &'a self,
        message: Message,
        prompt_text: impl Into<String>,
        permissions: &'a P,
    ) -> Pin<Box<dyn Stream<Item = EngineEvent> + Send + 'a>> {
        self.submit_message_content_stream_with_prompt(message, prompt_text, permissions)
    }

    /// Stream the same turn using a permission prompt held by the host.
    pub fn submit_message_content_stream_with_prompt<'a>(
        &'a self,
        message: Message,
        prompt_text: impl Into<String>,
        permissions: &'a dyn PermissionPrompt,
    ) -> Pin<Box<dyn Stream<Item = EngineEvent> + Send + 'a>> {
        self.submit_message_content_stream_inner(
            message,
            prompt_text.into(),
            permissions,
            None,
            None,
        )
    }

    /// Append a user message and continue it through the normal prompt hooks and
    /// persistence path while applying a steering session created by the host.
    /// The session is passed into the model turn only after the user message is
    /// durably accepted; if admission fails, dropping it returns unconsumed
    /// steering input to its owner.
    pub fn submit_message_content_stream_with_steering<'a, P: PermissionPrompt>(
        &'a self,
        message: Message,
        prompt_text: impl Into<String>,
        permissions: &'a P,
        steer_session: TurnSteerSession,
    ) -> Pin<Box<dyn Stream<Item = EngineEvent> + Send + 'a>> {
        self.submit_message_content_stream_inner(
            message,
            prompt_text.into(),
            permissions,
            Some(steer_session),
            None,
        )
    }

    /// Submit a State-owned async-question answer as a regular user message
    /// while preserving its stable transcript UUID and the normal turn path.
    /// The receipt ID is returned through `TurnSteerApplied` only after State
    /// confirms both the durable input and its context-applied ledger update.
    pub fn submit_async_question_answer_stream_with_steering<'a, P: PermissionPrompt>(
        &'a self,
        claim: kcoder_types::async_user_questions::AsyncQuestionDeliveryClaim,
        receipt_id: u64,
        permissions: &'a P,
        steer_session: TurnSteerSession,
    ) -> Pin<Box<dyn Stream<Item = EngineEvent> + Send + 'a>> {
        self.submit_async_question_answer_stream_with_prompt(
            claim,
            receipt_id,
            permissions,
            steer_session,
        )
    }

    /// Stream the same turn using a permission prompt held by the host.
    pub fn submit_async_question_answer_stream_with_prompt<'a>(
        &'a self,
        claim: kcoder_types::async_user_questions::AsyncQuestionDeliveryClaim,
        receipt_id: u64,
        permissions: &'a dyn PermissionPrompt,
        steer_session: TurnSteerSession,
    ) -> Pin<Box<dyn Stream<Item = EngineEvent> + Send + 'a>> {
        let prompt_text = claim.message.preview(usize::MAX);
        self.submit_message_content_stream_inner(
            claim.message.clone(),
            prompt_text,
            permissions,
            Some(steer_session),
            Some((claim, receipt_id)),
        )
    }

    fn submit_message_content_stream_inner<'a>(
        &'a self,
        message: Message,
        prompt_text: String,
        permissions: &'a dyn PermissionPrompt,
        mut prepared_steer_session: Option<TurnSteerSession>,
        mut async_question_delivery: Option<(
            kcoder_types::async_user_questions::AsyncQuestionDeliveryClaim,
            u64,
        )>,
    ) -> Pin<Box<dyn Stream<Item = EngineEvent> + Send + 'a>> {
        Box::pin(stream! {
            if self.input_persistence_failed.load(Ordering::Acquire) {
                yield EngineEvent::Error("Input durability is uncertain; reload this session before sending another message.".into());
                return;
            }
            if self.cancel_token.is_cancelled() {
                yield EngineEvent::StreamAborted { reason: "cancelled by user".into() };
                return;
            }
            let Some(mut input_guard) = input_owner::InputAdmissionGuard::try_start(
                &self.input_session_end_gate,
                &self.input_persistence_failed,
            ) else {
                yield EngineEvent::Error("The session is closing or its previous input is unconfirmed; your message was not submitted.".into());
                return;
            };
            // Studio supplies the exact native Accepted attempt through its
            // task scope. Other hosts capture the currently active lifecycle
            // without blocking before any prompt hook or input mutation.
            let owner = match self.state.current_scoped_lifecycle_identity() {
                kcoder_state::ScopedLifecycleIdentity::Matching(owner) => Some(owner),
                kcoder_state::ScopedLifecycleIdentity::Absent => self.state.try_inspection_lifecycle_identity(),
                kcoder_state::ScopedLifecycleIdentity::Foreign => {
                    yield EngineEvent::Error("The original input belongs to a different session; your message was not submitted.".into());
                    return;
                }
            };
            let Some(owner) = owner else {
                yield EngineEvent::Error("The session is busy; your message was not submitted. Please try again.".into());
                return;
            };
            match input_owner::wait_for_owner(&self.state, &owner, &self.cancel_token).await {
                input_owner::OwnerObservation::Current => {}
                input_owner::OwnerObservation::Cancelled => {
                    yield EngineEvent::StreamAborted { reason: "cancelled by user".into() };
                    return;
                }
                _ => {
                    yield EngineEvent::Error("The original session is no longer available; your message was not submitted.".into());
                    return;
                }
            }
            if let Some((claim, _)) = async_question_delivery.as_ref()
                && !self.user_interaction_round_is_attended()
            {
                let reason = "the current channel round is unattended; async answers cannot be delivered in this round";
                let _ = self.state.mark_async_question_delivery_failed(&owner, claim, reason);
                yield EngineEvent::Error(reason.into());
                return;
            }
            // This API submits a new user turn. Raw run_turn_stream callers may
            // be continuing a failed turn and must retain their semantic snapshot.
            if let Err(error) = self.prepare_client_model_for_turn(None, false) {
                if let Some((claim, _)) = async_question_delivery.as_ref() {
                    let _ = self.state.mark_async_question_delivery_failed(
                        &owner,
                        claim,
                        &format!("cannot prepare selected model: {error}"),
                    );
                }
                yield EngineEvent::Error(format!("Cannot prepare selected model: {error}"));
                return;
            }
            let async_question_receipt =
                async_question_delivery.as_ref().map(|(_, receipt_id)| *receipt_id);
            let (committed, prompt_text) = if let Some((claim, _)) = async_question_delivery.take() {
                let prompt_text = claim.message.preview(usize::MAX);
                let committed = match commit_async_question_answer_with_guard(
                    self,
                    &owner,
                    &claim,
                    &mut input_guard,
                )
                .await
                {
                    Ok((committed, events)) => {
                        for event in events {
                            yield event;
                        }
                        committed
                    }
                    Err(events) => {
                        for event in events {
                            yield event;
                        }
                        return;
                    }
                };
                (committed, prompt_text)
            } else {
            let (hook_events, modified_text, blocking_error) =
                self.run_user_prompt_submit_hooks(&prompt_text).await;
            for event in hook_events {
                yield event;
            }

            if let Some(error) = blocking_error {
                yield EngineEvent::HookMessage {
                    text: error.clone(),
                    is_error: true,
                };
                yield EngineEvent::Error(format!("user prompt submit hook blocked the turn: {error}"));
                return;
            }

            let text = modified_text.unwrap_or(prompt_text);
            let prompt_text = text.clone();
            let mut message = Self::replace_user_message_text(message, text)
                .with_origin(kcoder_types::MessageOrigin::User);
            let mut delay = std::time::Duration::from_millis(5);
            let notice = futures_timer::Delay::new(std::time::Duration::from_secs(1));
            tokio::pin!(notice);
            let mut notice_sent = false;
            let pending = loop {
                if self.cancel_token.is_cancelled() {
                    yield EngineEvent::StreamAborted { reason: "cancelled by user".into() };
                    return;
                }
                input_guard.arm();
                match self.state.try_begin_user_input(&owner, message) {
                    kcoder_state::UserInputStart::Busy(returned) => {
                        input_guard.disarm();
                        message = returned;
                        let retry = futures_timer::Delay::new(delay);
                        tokio::pin!(retry);
                        tokio::select! {
                            biased;
                            _ = self.cancel_token.cancelled() => {
                                yield EngineEvent::StreamAborted { reason: "cancelled by user".into() };
                                return;
                            }
                            _ = &mut notice, if !notice_sent => {
                                notice_sent = true;
                                yield EngineEvent::SystemNotice("Saving your message…".into());
                            }
                            _ = &mut retry => {}
                        }
                        delay = delay.saturating_mul(2).min(std::time::Duration::from_millis(250));
                    }
                    kcoder_state::UserInputStart::Rejected { reason, .. } => {
                        input_guard.disarm();
                        let notice = match reason {
                            kcoder_state::UserInputRejection::HistoryTooLarge =>
                                "This session has too much active history to safely submit another message. Compact it or start a new session.",
                            kcoder_state::UserInputRejection::LifecycleChanged =>
                                "The original session changed; your message was not submitted.",
                            kcoder_state::UserInputRejection::HistoryFaulted => {
                                self.input_persistence_failed.store(true, Ordering::Release);
                                "Input durability is uncertain; no model request was sent. Reload this session before continuing."
                            }
                            _ => "The message was not submitted because its original session or history writer is unavailable. Please try again.",
                        };
                        yield EngineEvent::Error(notice.into());
                        return;
                    }
                    kcoder_state::UserInputStart::Unknown { .. } => {
                        self.input_persistence_failed.store(true, Ordering::Release);
                        yield EngineEvent::Error("Input durability is uncertain; no model request was sent. Reload this session before continuing.".into());
                        return;
                    }
                    kcoder_state::UserInputStart::Accepted(pending) => break pending,
                }
            };
            let waiting = pending.wait_with_witness();
            tokio::pin!(waiting);
            let committed = tokio::select! {
                biased;
                result = &mut waiting => Some(result),
                _ = self.cancel_token.cancelled() => None,
                _ = &mut notice, if !notice_sent => {
                    yield EngineEvent::SystemNotice("Saving your message…".into());
                    tokio::select! {
                        biased;
                        result = &mut waiting => Some(result),
                        _ = self.cancel_token.cancelled() => None,
                    }
                }
            };
            let Some(committed) = committed else {
                // The process-owned input ticket continues; cancellation does
                // not establish that the original write did not happen.
                self.input_persistence_failed.store(true, Ordering::Release);
                yield EngineEvent::StreamAborted { reason: "cancelled by user".into() };
                return;
            };
            let committed = match committed {
                Ok(committed) => committed,
                Err(_) => {
                    self.input_persistence_failed.store(true, Ordering::Release);
                    yield EngineEvent::Error("Input durability is uncertain; no model request was sent. Reload this session before continuing.".into());
                    return;
                }
            };
                (committed, prompt_text)
            };
            input_guard.disarm();
            drop(input_guard);
            match input_owner::wait_for_input(&committed, &self.cancel_token).await {
                input_owner::OwnerObservation::Current => {}
                input_owner::OwnerObservation::Cancelled => {
                    yield EngineEvent::StreamAborted { reason: "cancelled by user".into() };
                    return;
                }
                _ => {
                    yield EngineEvent::Error("The original session changed before the input was acknowledged.".into());
                    return;
                }
            }
            let prompt_number = self.next_memory_prompt_number();
            crate::continuous_work::input_handoff::publish(&committed);
            yield EngineEvent::UserMessageAdded;
            if let Some(id) = async_question_receipt {
                yield EngineEvent::TurnSteerApplied { id };
            }

            match input_owner::wait_for_input(&committed, &self.cancel_token).await {
                input_owner::OwnerObservation::Current => {}
                input_owner::OwnerObservation::Cancelled => {
                    yield EngineEvent::StreamAborted { reason: "cancelled by user".into() };
                    return;
                }
                _ => {
                    yield EngineEvent::Error("The original session changed before the model request; no model request was sent.".into());
                    return;
                }
            }
            self.record_user_prompt(prompt_number, &prompt_text);

            let mut turn_stream = self.run_turn_stream_with_cancel_and_max_turns(
                permissions,
                self.cancel_token(),
                MAX_AGENT_TURNS,
                None,
                prepared_steer_session.take(),
            );
            while let Some(event) = turn_stream.next().await {
                yield event;
            }
        })
    }

    /// Append a user message and run a single turn, returning all engine events.
    pub async fn submit_message<P: PermissionPrompt>(
        &self,
        text: impl Into<String>,
        permissions: &P,
    ) -> Vec<EngineEvent> {
        self.submit_message_stream(text, permissions)
            .collect()
            .await
    }

    pub(super) fn replace_user_message_text(message: Message, text: String) -> Message {
        match message {
            Message::User {
                mut content,
                origin,
            } => {
                if let Some(block) = content
                    .iter_mut()
                    .find(|block| matches!(block, ContentBlock::Text { .. }))
                {
                    *block = ContentBlock::Text { text };
                } else {
                    content.insert(0, ContentBlock::Text { text });
                }
                Message::User { content, origin }
            }
            Message::Assistant { .. } => Message::user_text(text),
        }
    }

    /// Run a single turn and return a stream of engine events.
    ///
    /// The caller is responsible for having already added the user message to
    /// [`AppState`]. This stream yields text deltas, tool-use events, tool
    /// results, and terminal events as they happen.
    ///
    /// When a tool call fails (bad arguments, execution error, or permission
    /// denied), the engine automatically re-invokes the model with the error
    /// result so it can correct itself, up to the configured retry limit.
    pub fn run_turn_stream<'a, P: PermissionPrompt>(
        &self,
        prompt: &'a P,
    ) -> Pin<Box<dyn Stream<Item = EngineEvent> + Send + 'a>> {
        self.run_turn_stream_with_prompt(prompt)
    }

    /// Run the regular turn loop with a permission prompt held by the host.
    pub fn run_turn_stream_with_prompt<'a>(
        &self,
        prompt: &'a dyn PermissionPrompt,
    ) -> Pin<Box<dyn Stream<Item = EngineEvent> + Send + 'a>> {
        self.run_turn_stream_with_cancel_and_max_turns(
            prompt,
            self.cancel_token.clone(),
            MAX_AGENT_TURNS,
            None,
            None,
        )
    }

    /// Run a single turn with a caller-provided cancellation token.
    ///
    /// This allows the UI to cancel an individual turn without affecting the
    /// global engine cancellation state.
    pub fn run_turn_stream_with_cancel<'a, P: PermissionPrompt>(
        &self,
        prompt: &'a P,
        cancel_token: CancellationToken,
    ) -> Pin<Box<dyn Stream<Item = EngineEvent> + Send + 'a>> {
        self.run_turn_stream_with_cancel_and_max_turns(
            prompt,
            cancel_token,
            MAX_AGENT_TURNS,
            None,
            None,
        )
    }

    /// Run a regular turn using a steering session created by the caller before task scheduling.
    pub fn run_turn_stream_with_cancel_and_steering<'a, P: PermissionPrompt>(
        &self,
        prompt: &'a P,
        cancel_token: CancellationToken,
        steer_session: TurnSteerSession,
    ) -> Pin<Box<dyn Stream<Item = EngineEvent> + Send + 'a>> {
        self.run_turn_stream_with_cancel_and_max_turns(
            prompt,
            cancel_token,
            MAX_AGENT_TURNS,
            None,
            Some(steer_session),
        )
    }

    /// Execute a user-entered shell command through the normal tool pipeline.
    ///
    /// This is used by TUI `!cmd` prompts. It deliberately reuses
    /// `execute_tool` so permissions, hooks, sandbox escalation, output limits,
    /// and lifecycle events stay aligned with model-initiated shell tools.
    pub async fn run_user_shell_command<P: PermissionPrompt>(
        &self,
        command: String,
        prompt: &P,
        cancel_token: CancellationToken,
    ) -> Vec<EngineEvent> {
        let engine = self.clone().with_cancel_token(cancel_token.clone());
        let tool_name = if cfg!(windows) { "PowerShell" } else { "bash" };
        let tool_id = format!("user-shell-{}", monotonic_millis());
        let input = serde_json::json!({
            "command": command,
            "description": "User shell command",
        });

        let mut events = vec![EngineEvent::ToolUseStarted {
            id: tool_id.clone(),
            name: tool_name.to_string(),
            input: input.clone(),
        }];
        let result = tokio::select! {
            biased;
            _ = cancel_token.cancelled() => {
                events.push(EngineEvent::StreamAborted {
                    reason: "cancelled by user".into(),
                });
                events.push(EngineEvent::ToolResult {
                    id: tool_id.clone(),
                    name: tool_name.to_string(),
                    output: ToolOutput::error("Tool call was interrupted by the user."),
                });
                return events;
            }
            result = engine.execute_tool(&tool_id, tool_name, input, prompt) => result,
        };

        match result {
            Ok((output, _decision, _modified_input, hook_events)) => {
                events.extend(hook_events);
                events.push(EngineEvent::ToolResult {
                    id: tool_id,
                    name: tool_name.to_string(),
                    output,
                });
            }
            Err(error) => {
                events.push(EngineEvent::ToolResult {
                    id: tool_id,
                    name: tool_name.to_string(),
                    output: ToolOutput::error(format!("Error: {error}")),
                });
            }
        }
        events
    }

    /// Run a single turn with an explicit maximum number of model/tool cycles.
    ///
    /// This is primarily used by forked sub-agents, whose caller-provided
    /// `max_turns` must be enforced instead of the main-loop safeguard.
    pub fn run_turn_stream_with_max_turns<'a, P: PermissionPrompt>(
        &self,
        prompt: &'a P,
        max_turns: usize,
    ) -> Pin<Box<dyn Stream<Item = EngineEvent> + Send + 'a>> {
        self.run_turn_stream_with_cancel_and_max_turns(
            prompt,
            self.cancel_token.clone(),
            max_turns,
            None,
            None,
        )
    }

    /// Native hosts retain the actual producer frame instead of reconstructing
    /// a task-local identity in a later collector. This starts the same turn loop.
    pub fn run_native_turn_stream_with_max_turns<'a, P: PermissionPrompt>(
        &self,
        prompt: &'a P,
        max_turns: usize,
    ) -> Pin<Box<dyn Stream<Item = crate::integrations::core::NativeEngineEventFrame> + Send + 'a>>
    {
        self.run_native_turn_stream_with_cancel_and_max_turns(
            prompt,
            self.cancel_token.clone(),
            max_turns,
            None,
            None,
        )
    }

    #[cfg(test)]
    pub(crate) fn run_turn_stream_with_subagent_finish_reminders<'a, P: PermissionPrompt>(
        &self,
        prompt: &'a P,
        max_turns: usize,
        agent_id: impl Into<String>,
    ) -> Pin<Box<dyn Stream<Item = EngineEvent> + Send + 'a>> {
        Box::pin(
            self.run_native_turn_stream_with_subagent_finish_reminders(prompt, max_turns, agent_id)
                .map(crate::integrations::core::NativeEngineEventFrame::into_event),
        )
    }

    pub(crate) fn run_native_turn_stream_with_subagent_finish_reminders<'a, P: PermissionPrompt>(
        &self,
        prompt: &'a P,
        max_turns: usize,
        agent_id: impl Into<String>,
    ) -> Pin<Box<dyn Stream<Item = crate::integrations::core::NativeEngineEventFrame> + Send + 'a>>
    {
        self.run_native_turn_stream_with_cancel_and_max_turns(
            prompt,
            self.cancel_token.clone(),
            max_turns,
            Some(SubagentFinishReminder::new(agent_id.into())),
            None,
        )
    }
}
