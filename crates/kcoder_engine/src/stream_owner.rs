//! Canonical ownership for actual independent turn streams. Native hosts
//! retain their original Accepted identity; terminal ledger writes are awaited.

use crate::{EngineEvent, QueryEngine, integrations::core::NativeEngineEventFrame};
use anyhow::{Context, Result, ensure};
use async_stream::stream;
use futures::{Stream, StreamExt};
use kcoder_state::{
    AppStateLifecycleIdentity, HistoryAppendScope, UserInputRejection, UserInputStart,
    turn_attempt_store::{
        TurnAttemptBeginOutcome, TurnAttemptCompletion, TurnAttemptRecord, TurnAttemptStore,
    },
};
use kcoder_types::{Message, TurnAttemptIdentity, TurnAttemptStatus};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    pin::Pin,
    sync::{Arc, atomic::Ordering},
    time::Duration,
};

pub(crate) struct StreamOwner {
    identity: TurnAttemptIdentity,
    scope: HistoryAppendScope,
    owner: AppStateLifecycleIdentity,
    attempt_directory: Option<PathBuf>,
    attempt: Option<Arc<TurnAttemptStore>>,
    explicit_turn: bool,
    initial_user_input: Option<Message>,
}
impl StreamOwner {
    /// Allocate only for a real independent stream. This is its canonical
    /// persisted attempt, never an observation fallback or a decoded selector.
    pub(crate) fn prepare(engine: &QueryEngine, main: bool) -> Result<Option<Self>> {
        Self::prepare_for_turn(engine, main, None)
    }
    pub(crate) fn prepare_for_turn(
        engine: &QueryEngine,
        main: bool,
        turn_id: Option<&str>,
    ) -> Result<Option<Self>> {
        ensure!(
            turn_id.is_none_or(|id| !id.trim().is_empty()),
            "turn_id_unavailable"
        );
        let existing = engine.state.current_history_attempt_identity();
        if let Some(current) = &existing {
            ensure!(
                turn_id.is_none_or(|id| id == current.turn_id),
                "foreground_turn_attempt_changed"
            );
        }
        if existing.is_none() && (!main || !engine.is_independent_discovery_session()) {
            ensure!(turn_id.is_none(), "automatic_turn_owner_unavailable");
            return Ok(None);
        }
        let own_attempt = existing.is_none();
        let identity = existing.unwrap_or_else(|| TurnAttemptIdentity {
            thread_id: engine.session_id(),
            turn_id: turn_id
                .map(str::to_owned)
                .unwrap_or_else(|| format!("foreground-turn-{}", uuid::Uuid::new_v4())),
            attempt_id: format!("foreground-attempt-{}", uuid::Uuid::new_v4()),
        });
        let scope = engine.state.history_attempt_scope(identity.clone())?;
        let owner = scope.lifecycle_identity();
        let attempt_directory =
            own_attempt.then(|| engine.session_storage_dir_for(&identity.thread_id));
        Ok(Some(Self {
            identity,
            scope,
            owner,
            attempt_directory,
            attempt: None,
            explicit_turn: turn_id.is_some(),
            initial_user_input: None,
        }))
    }
    pub(crate) fn with_initial_user_input(mut self, text: String) -> Self {
        self.initial_user_input = Some(Message::user_text(text));
        self
    }

    #[cfg(test)]
    pub(crate) fn identity(&self) -> &TurnAttemptIdentity {
        &self.identity
    }
    async fn begin(&mut self, engine: &QueryEngine) -> Result<()> {
        ensure!(
            self.owner.try_matches(&engine.state) == Some(true),
            "foreground_turn_owner_changed"
        );
        if let Some(current) = engine.state.current_history_attempt_identity() {
            if self.attempt_directory.is_some() && self.attempt.is_none() {
                // Some hosts construct outside the Accepted task scope and
                // poll inside it. Prefer that original canonical identity
                // before any independent ledger is created.
                ensure!(
                    !self.explicit_turn || self.identity.turn_id == current.turn_id,
                    "foreground_turn_attempt_changed"
                );
                self.scope = engine.state.history_attempt_scope(current.clone())?;
                self.owner = self.scope.lifecycle_identity();
                self.identity = current;
                self.attempt_directory = None;
            } else {
                ensure!(self.identity == current, "foreground_turn_attempt_changed");
            }
        }
        let Some(directory) = self.attempt_directory.clone() else {
            ensure!(
                self.initial_user_input.is_none(),
                "automatic_input_requires_independent_attempt"
            );
            return Ok(());
        };
        let messages = engine.state.messages();
        let context: Vec<&Message> = messages
            .iter()
            .chain(self.initial_user_input.iter())
            .collect();
        let record = TurnAttemptRecord {
            client_presentation: engine.client_presentation.clone(),
            version: 1,
            identity: self.identity.clone(),
            parent_attempt_id: None,
            retry_operation_id: None,
            accepted_at_ms: now_ms(),
            input_context_hash: format!("{:x}", Sha256::digest(serde_json::to_vec(&context)?)),
            request_fingerprint: None,
            retained_input: None,
            status: TurnAttemptStatus::Accepted,
            completion: None,
        };
        let store = tokio::task::spawn_blocking(move || -> Result<_> {
            let store = Arc::new(TurnAttemptStore::open(
                &directory,
                &record.identity.thread_id,
            )?);
            match store.begin(record.clone()) {
                Ok(TurnAttemptBeginOutcome::Created(_)) => Ok(store),
                Ok(TurnAttemptBeginOutcome::Existing(_)) => {
                    anyhow::bail!("foreground_turn_attempt_reused")
                }
                Err(error) => {
                    ensure!(
                        store.load(&record.identity)?.as_ref() == Some(&record),
                        "foreground_turn_acceptance_unknown"
                    );
                    tracing::debug!(reason = %error, "Original foreground acceptance reconciled");
                    Ok(store)
                }
            }
        })
        .await
        .context("foreground_turn_acceptance_worker_unavailable")??;
        self.attempt = Some(store);
        ensure!(
            self.owner.try_matches(&engine.state) == Some(true),
            "foreground_turn_owner_changed"
        );
        Ok(())
    }
    async fn commit_initial_user_input(
        &self,
        engine: &QueryEngine,
        mut message: Message,
    ) -> EngineEvent {
        if engine.input_persistence_failed.load(Ordering::Acquire)
            || !engine.native_turn_admission_ready()
        {
            return EngineEvent::Error("automatic_turn_input_owner_unavailable".into());
        }
        let cancel = engine.cancel_token();
        let mut delay = Duration::from_millis(5);
        let pending = loop {
            if cancel.is_cancelled() {
                return EngineEvent::StreamAborted {
                    reason: "cancelled by user".into(),
                };
            }
            let start = self
                .scope
                .clone()
                .run(async { engine.state.try_begin_user_input(&self.owner, message) })
                .await;
            match start {
                UserInputStart::Busy(returned) => {
                    message = returned;
                    tokio::select! {
                        biased;
                        _ = cancel.cancelled() => return EngineEvent::StreamAborted { reason: "cancelled by user".into() },
                        _ = tokio::time::sleep(delay) => {}
                    }
                    delay = (delay * 2).min(Duration::from_millis(250));
                }
                UserInputStart::Accepted(pending) => break pending,
                UserInputStart::Rejected { reason, .. }
                    if reason != UserInputRejection::HistoryFaulted =>
                {
                    return EngineEvent::Error("automatic_turn_input_rejected".into());
                }
                UserInputStart::Rejected { .. } | UserInputStart::Unknown { .. } => {
                    engine
                        .input_persistence_failed
                        .store(true, Ordering::Release);
                    return EngineEvent::Error("automatic_turn_input_unconfirmed".into());
                }
            }
        };
        // Admission already owns the write. Wait for its receipt even when
        // cancellation arrives, so the scheduler counts a committed input once.
        if pending.attempt() != Some(&self.identity) || pending.wait().await.is_err() {
            engine
                .input_persistence_failed
                .store(true, Ordering::Release);
            return EngineEvent::Error("automatic_turn_input_unconfirmed".into());
        }
        EngineEvent::UserMessageAdded
    }

    async fn finish(
        &self,
        engine: &QueryEngine,
        mut completion: TurnAttemptCompletion,
    ) -> Result<()> {
        let Some(store) = &self.attempt else {
            return Ok(());
        };
        ensure!(
            self.owner.try_matches(&engine.state) == Some(true),
            "foreground_turn_owner_changed"
        );
        let history_confirmed = engine.state.flush_history().await.is_ok();
        if !history_confirmed {
            completion.status = TurnAttemptStatus::Failed;
            completion.error = Some("foreground_turn_history_unconfirmed".into());
        }
        let identity = self.identity.clone();
        let store = store.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            match store.finish(&identity, completion.clone()) {
                Ok(_) => Ok(()),
                Err(_) => {
                    ensure!(
                        store.load(&identity)?.and_then(|record| record.completion)
                            == Some(completion),
                        "foreground_turn_completion_unknown"
                    );
                    Ok(())
                }
            }
        })
        .await
        .context("foreground_turn_completion_worker_unavailable")??;
        ensure!(history_confirmed, "foreground_turn_history_unconfirmed");
        Ok(())
    }
}

#[cfg(test)]
mod tests;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
fn terminal(
    event: &EngineEvent,
) -> Option<(
    TurnAttemptStatus,
    Option<kcoder_types::ProviderFailureDetails>,
)> {
    match event {
        EngineEvent::StreamAborted { .. } => Some((TurnAttemptStatus::Interrupted, None)),
        EngineEvent::ProviderFailed { details, .. } => {
            Some((TurnAttemptStatus::Failed, Some(details.clone())))
        }
        EngineEvent::Error(_) | EngineEvent::MaxTurnsReached { .. } => {
            Some((TurnAttemptStatus::Failed, None))
        }
        _ => None,
    }
}

pub(crate) fn wrap<'a>(
    engine: QueryEngine,
    mut inner: Pin<Box<dyn Stream<Item = NativeEngineEventFrame> + Send + 'a>>,
    prepared: Result<Option<StreamOwner>>,
) -> Pin<Box<dyn Stream<Item = NativeEngineEventFrame> + Send + 'a>> {
    Box::pin(stream! {
        let prepared = prepared.and_then(|owner| match owner {
            Some(owner) => Ok(Some(owner)),
            None => StreamOwner::prepare(&engine, false),
        });
        let owner = match prepared {
            Ok(owner) => owner,
            Err(_) => {
                yield engine.native_event_frame_with_epoch(EngineEvent::Error("foreground_turn_owner_unavailable".into()), None, &mut None);
                return;
            }
        };
        let Some(mut owner) = owner else {
            while let Some(frame) = inner.next().await { yield frame; }
            return;
        };
        if owner.begin(&engine).await.is_err() {
            yield engine.native_event_frame_with_epoch(EngineEvent::Error("foreground_turn_acceptance_unavailable".into()), None, &mut None);
            return;
        }
        let mut registration = match owner.scope.clone().run(engine.owned_turns.register(
            &engine.state, owner.identity.clone(), engine.cancel_token(),
        )).await {
            Ok(registration) => {
                registration.bind_wake_read(&engine);
                Some(registration)
            }
            Err(_) => {
                // Registration refuses an already cancelled token. That is the
                // user's interruption before any work started, not an
                // ownership failure, so it must settle as an aborted stream.
                let cancelled = engine.cancel_token().is_cancelled();
                let _ = owner.finish(&engine, TurnAttemptCompletion {
                    status: TurnAttemptStatus::Interrupted, finished_at_ms: now_ms(),
                    error: Some("foreground_turn_unstarted".into()), provider_failure: None,
                    partial_output: String::new(), partial_output_truncated: false,
                    committed_history_uuid: None,
                }).await;
                let event = if cancelled {
                    EngineEvent::StreamAborted { reason: "cancelled by user".into() }
                } else {
                    EngineEvent::Error("foreground_turn_owner_unavailable".into())
                };
                yield engine.native_event_frame_with_epoch(event, None, &mut None);
                return;
            }
        };
        if let Some(input) = owner.initial_user_input.take() {
            let event = owner.commit_initial_user_input(&engine, input).await;
            if let Some((status, _)) = terminal(&event) {
                if let Some(registration) = registration.take() { registration.finish().await; }
                let _ = owner.finish(&engine, TurnAttemptCompletion {
                    status, finished_at_ms: now_ms(),
                    error: Some("automatic_turn_input_not_confirmed".into()),
                    provider_failure: None, partial_output: String::new(),
                    partial_output_truncated: false, committed_history_uuid: None,
                }).await;
                yield engine.native_event_frame_with_epoch(event, None, &mut None);
                return;
            }
            // Count even a cancellation that arrived while the input committed.
            yield owner.scope.clone().run(async {
                engine.native_event_frame_with_epoch(event, None, &mut None)
            }).await;
        }
        let mut status = TurnAttemptStatus::Completed;
        let mut provider_failure = None;
        while let Some(frame) = owner.scope.clone().run(inner.next()).await {
            if let Some((terminal_status, failure)) = terminal(frame.event()) {
                status = terminal_status;
                provider_failure = failure;
                if let Some(registration) = registration.take() { registration.finish().await; }
            }
            yield frame;
        }
        if let Some(registration) = registration.take() { registration.finish().await; }
        if engine.cancel_token().is_cancelled() { status = TurnAttemptStatus::Interrupted; }
        let completion = TurnAttemptCompletion {
            status, finished_at_ms: now_ms(), error: None, provider_failure,
            partial_output: String::new(), partial_output_truncated: false,
            committed_history_uuid: None,
        };
        if owner.finish(&engine, completion).await.is_err() {
            yield engine.native_event_frame_with_epoch(EngineEvent::Error("foreground_turn_completion_unknown".into()), None, &mut None);
        }
        // Abandoning this stream only revokes its in-memory owner via Drop.
        // Its Accepted ledger stays unresolved; no detached task invents a
        // terminal result after the original host or lease has disappeared.
    })
}
