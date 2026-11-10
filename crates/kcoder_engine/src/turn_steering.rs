//! Turn steering within the shared engine ownership boundary.

use super::*;

pub(super) struct TurnSteerApplyOutcome {
    pub(super) applied: Vec<u64>,
    pub(super) blocked: bool,
    pub(super) events: Vec<EngineEvent>,
}

/// An owner-bound receipt for steering inputs that never entered history.
#[derive(Debug, Clone)]
pub struct TurnSteerSettlement {
    mailbox: Arc<Mutex<TurnSteerMailbox>>,
    turn_id: u64,
    undrained: Arc<Mutex<Vec<u64>>>,
}

impl TurnSteerSettlement {
    /// Close this turn's mailbox and return only inputs never drained for commit.
    /// Receipts remain available if the turn stream was dropped first.
    pub fn close(&self) -> Vec<u64> {
        let mut mailbox = self
            .mailbox
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut undrained = self
            .undrained
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if mailbox
            .active
            .as_ref()
            .is_some_and(|active| active.turn_id == self.turn_id)
            && let Some(active) = mailbox.active.take()
        {
            undrained.extend(active.pending.into_iter().map(|steer| steer.id));
        }
        std::mem::take(&mut *undrained)
    }
}

impl std::fmt::Display for TurnSteerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoActiveTurn => formatter.write_str("no active regular turn accepts steering"),
            Self::QueueFull { max } => write!(formatter, "turn steer queue is full ({max})"),
            Self::TemporarilyUnavailable => {
                formatter.write_str("turn steer owner is temporarily unavailable")
            }
            Self::SessionChanged => formatter.write_str("turn steer session changed"),
        }
    }
}

impl std::error::Error for TurnSteerError {}

impl TurnSteerSession {
    /// Keep the negative receipt accessible to the host after this stream ends.
    pub fn settlement(&self) -> TurnSteerSettlement {
        TurnSteerSettlement {
            mailbox: Arc::clone(&self.mailbox),
            turn_id: self.turn_id,
            undrained: Arc::clone(&self.undrained),
        }
    }

    pub(super) fn drain_pending(&self) -> Vec<PendingTurnSteer> {
        let mut mailbox = self
            .mailbox
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Some(active) = mailbox
            .active
            .as_mut()
            .filter(|active| active.turn_id == self.turn_id)
        else {
            return Vec::new();
        };
        active.pending.drain(..).collect()
    }

    /// Atomically finish a turn at the final-response boundary, preventing input
    /// from being accepted after an empty check and then never consumed. If new
    /// input is found while holding the lock, return it to the same turn.
    pub(super) fn finish_or_drain(&mut self) -> TurnSteerBoundary {
        let mut mailbox = self
            .mailbox
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Some(active) = mailbox
            .active
            .as_mut()
            .filter(|active| active.turn_id == self.turn_id)
        else {
            self.closed = true;
            return TurnSteerBoundary::Finished;
        };
        if !active.pending.is_empty() {
            return TurnSteerBoundary::Pending(active.pending.drain(..).collect());
        }
        mailbox.active = None;
        self.closed = true;
        TurnSteerBoundary::Finished
    }
}

impl Drop for TurnSteerSession {
    fn drop(&mut self) {
        if self.closed {
            return;
        }
        let mut mailbox = self
            .mailbox
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if mailbox
            .active
            .as_ref()
            .is_some_and(|active| active.turn_id == self.turn_id)
            && let Some(active) = mailbox.active.take()
        {
            self.undrained
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .extend(active.pending.into_iter().map(|steer| steer.id));
        }
    }
}

impl QueryEngine {
    pub(super) fn note_foreground_activity(&self) {
        *recover_write_lock(
            &self.auto_curator_last_activity,
            "auto_curator_last_activity",
        ) = SystemTime::now();
    }

    /// Signal the engine to stop as soon as it reaches a cancellation check
    /// point.
    pub fn cancel(&self) {
        self.cancel_token.cancel();
    }

    /// Collapse the remaining wait of running wait-style tools (Sleep, wait) to
    /// a short grace period without cancelling the turn. Waking a tool this way
    /// is one-shot: it never affects waits that start later.
    pub fn shorten_waiting_tools(&self) {
        self.shorten_signal.notify_waiters();
    }

    /// True while a main-thread turn stream is alive on this engine. Host
    /// watch loops must not flush background events while this is set: the
    /// turn loop owns completion-notification delivery in that window.
    pub fn turn_driver_active(&self) -> bool {
        self.turn_driver_signal.active()
    }

    /// Atomically close the active regular-turn steering mailbox at a terminal
    /// boundary and return IDs that were accepted but not yet consumed by the
    /// turn. Hosts should call this as soon as they observe a terminal event,
    /// before publishing that event or awaiting any other gate. A subsequent
    /// enqueue then returns `NoActiveTurn`, allowing the host to route the
    /// durable input through ordinary idle-turn admission.
    ///
    /// Returned async-question IDs are known not to have reached the history
    /// commit path: only drained steers can be committed. Hosts may therefore
    /// safely mark those specific claims failed and report the updated record.
    pub fn close_active_turn_steering(&self) -> Vec<u64> {
        let mut mailbox = self
            .turn_steer_mailbox
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Some(active) = mailbox.active.take() else {
            return Vec::new();
        };
        active.pending.into_iter().map(|steer| steer.id).collect()
    }

    pub(crate) fn turn_driver_signal(&self) -> &turn_driver::TurnDriverSignal {
        &self.turn_driver_signal
    }

    pub(super) fn is_cancelled(&self) -> bool {
        self.cancel_token.is_cancelled()
    }

    pub fn cancel_token(&self) -> CancellationToken {
        self.cancel_token.clone()
    }

    /// Queue user input for the current regular turn. It is written to the session
    /// only after the current provider response and its complete tool batch, and
    /// never splits a tool_use/tool_result pair.
    pub fn enqueue_turn_steer(
        &self,
        id: u64,
        message: Message,
    ) -> std::result::Result<(), TurnSteerError> {
        let owner = self
            .state
            .try_inspection_lifecycle_identity()
            .ok_or(TurnSteerError::TemporarilyUnavailable)?;
        match self.try_enqueue_turn_steer_for_lifecycle(&owner, id, message) {
            GuardedTurnSteer::Queued => Ok(()),
            GuardedTurnSteer::Busy => Err(TurnSteerError::TemporarilyUnavailable),
            GuardedTurnSteer::OwnerChanged => Err(TurnSteerError::SessionChanged),
            GuardedTurnSteer::NoActiveTurn => Err(TurnSteerError::NoActiveTurn),
            GuardedTurnSteer::QueueFull { max } => Err(TurnSteerError::QueueFull { max }),
        }
    }

    /// Queue a steer only while its original State lifecycle is current.
    /// The mailbox is never waited on while holding the State lock.
    pub fn try_enqueue_turn_steer_for_lifecycle(
        &self,
        owner: &kcoder_state::AppStateLifecycleIdentity,
        id: u64,
        message: Message,
    ) -> GuardedTurnSteer {
        self.try_enqueue_turn_steer_with_delivery(owner, id, message, None)
    }

    /// Queue a State-owned asynchronous question answer with its stable history
    /// identity. The State outbox remains authoritative until the turn confirms
    /// the identified input commit and acknowledges it as context-applied.
    pub fn try_enqueue_async_question_delivery(
        &self,
        owner: &kcoder_state::AppStateLifecycleIdentity,
        id: u64,
        claim: &kcoder_types::async_user_questions::AsyncQuestionDeliveryClaim,
    ) -> GuardedTurnSteer {
        if !self.user_interaction_round_is_attended() {
            return GuardedTurnSteer::OwnerChanged;
        }
        self.try_enqueue_turn_steer_with_delivery(
            owner,
            id,
            claim.message.clone(),
            Some(claim.clone()),
        )
    }

    fn try_enqueue_turn_steer_with_delivery(
        &self,
        owner: &kcoder_state::AppStateLifecycleIdentity,
        id: u64,
        message: Message,
        async_question_delivery: Option<
            kcoder_types::async_user_questions::AsyncQuestionDeliveryClaim,
        >,
    ) -> GuardedTurnSteer {
        match self.state.try_with_lifecycle(owner, || {
            let Ok(mut mailbox) = self.turn_steer_mailbox.try_lock() else {
                return GuardedTurnSteer::Busy;
            };
            let Some(active) = mailbox.active.as_mut() else {
                return GuardedTurnSteer::NoActiveTurn;
            };
            if !active.owner.same_lifecycle(owner) {
                return GuardedTurnSteer::OwnerChanged;
            }
            if active.pending.len() >= TURN_STEER_QUEUE_MAX {
                return GuardedTurnSteer::QueueFull {
                    max: TURN_STEER_QUEUE_MAX,
                };
            }
            active.pending.push_back(PendingTurnSteer {
                id,
                message,
                owner: owner.clone(),
                async_question_delivery,
            });
            GuardedTurnSteer::Queued
        }) {
            kcoder_state::TryLifecycleAccess::Busy => GuardedTurnSteer::Busy,
            kcoder_state::TryLifecycleAccess::Changed
            | kcoder_state::TryLifecycleAccess::Unavailable => GuardedTurnSteer::OwnerChanged,
            kcoder_state::TryLifecycleAccess::Current(result) => result,
        }
    }

    /// Register the steering mailbox before scheduling an asynchronous turn task.
    /// The TUI uses this handle to eliminate races from rapid submissions before
    /// the task receives its first poll.
    pub fn begin_turn_steering(&self) -> Option<TurnSteerSession> {
        let owner = self.state.try_inspection_lifecycle_identity()?;
        match self.state.try_with_lifecycle(&owner, || {
            let Ok(mut mailbox) = self.turn_steer_mailbox.try_lock() else {
                return None;
            };
            if mailbox.active.is_some() {
                warn!(
                    "another regular turn is already active; steering disabled for concurrent turn"
                );
                return None;
            }
            mailbox.next_turn_id = mailbox.next_turn_id.wrapping_add(1).max(1);
            let turn_id = mailbox.next_turn_id;
            mailbox.active = Some(ActiveTurnSteers {
                turn_id,
                pending: VecDeque::new(),
                owner: owner.clone(),
            });
            Some(TurnSteerSession {
                mailbox: Arc::clone(&self.turn_steer_mailbox),
                turn_id,
                closed: false,
                undrained: Arc::new(Mutex::new(Vec::new())),
            })
        }) {
            kcoder_state::TryLifecycleAccess::Current(session) => session,
            kcoder_state::TryLifecycleAccess::Busy
            | kcoder_state::TryLifecycleAccess::Changed
            | kcoder_state::TryLifecycleAccess::Unavailable => None,
        }
    }

    pub(super) async fn apply_turn_steers(
        &self,
        steers: Vec<PendingTurnSteer>,
    ) -> TurnSteerApplyOutcome {
        let mut applied = Vec::new();
        let mut events = Vec::new();
        for steer in steers {
            let owner = steer.owner;
            let mut message = steer.message;
            let async_question_delivery = steer.async_question_delivery;
            if let Some(claim) = async_question_delivery.as_ref() {
                match super::turn_entry::commit_async_question_answer(self, &owner, claim).await {
                    Ok((_committed, delivery_events)) => {
                        events.extend(delivery_events);
                        applied.push(steer.id);
                        continue;
                    }
                    Err(delivery_events) => {
                        events.extend(delivery_events);
                        return TurnSteerApplyOutcome {
                            applied,
                            blocked: true,
                            events,
                        };
                    }
                }
            }
            loop {
                if self.cancel_token().is_cancelled() {
                    return TurnSteerApplyOutcome {
                        applied,
                        blocked: true,
                        events,
                    };
                }
                let start = self.state.try_begin_user_input(&owner, message);
                match start {
                    kcoder_state::UserInputStart::Busy(returned) => {
                        message = returned;
                        tokio::select! {
                            biased;
                            _ = self.cancel_token().cancelled_owned() => return TurnSteerApplyOutcome { applied, blocked: true, events },
                            _ = tokio::time::sleep(Duration::from_millis(80)) => {},
                        }
                    }
                    kcoder_state::UserInputStart::Accepted(pending) => {
                        if !pending.ticket_is_retained() {
                            return TurnSteerApplyOutcome {
                                applied,
                                blocked: true,
                                events,
                            };
                        }
                        let settled = tokio::select! {
                            biased;
                            _ = self.cancel_token().cancelled_owned() => None,
                            outcome = pending.wait() => Some(outcome),
                        };
                        match settled {
                            Some(Ok(_)) if !self.cancel_token().is_cancelled() => {
                                applied.push(steer.id);
                                break;
                            }
                            _ => {
                                return TurnSteerApplyOutcome {
                                    applied,
                                    blocked: true,
                                    events,
                                };
                            }
                        }
                    }
                    kcoder_state::UserInputStart::Rejected { .. }
                    | kcoder_state::UserInputStart::Unknown { .. } => {
                        return TurnSteerApplyOutcome {
                            applied,
                            blocked: true,
                            events,
                        };
                    }
                }
            }
        }
        TurnSteerApplyOutcome {
            applied,
            blocked: false,
            events,
        }
    }
}

#[cfg(test)]
mod guarded_tests {
    use super::*;
    use futures::StreamExt;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn isolated_engine(
        cwd: &std::path::Path,
        provider: Arc<dyn kcoder_api::Provider>,
    ) -> QueryEngine {
        crate::isolated_test_profile::require_isolated_profile().expect("private test profile");
        let temp = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let canonical_workspace = std::fs::canonicalize(cwd).unwrap();
        assert!(
            canonical_workspace.starts_with(&temp) && canonical_workspace != temp,
            "workspace must belong to this test"
        );
        let workspace = cwd.to_path_buf();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&workspace, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let directory = kcoder_config::PrivateDirectory::open_existing(&workspace).unwrap();
        directory.verify_private_directory().unwrap();
        directory
            .open_child(std::ffi::OsStr::new("test-config"), true)
            .unwrap();
        std::fs::create_dir_all(workspace.join(".kcoder/skills")).unwrap();
        std::fs::create_dir_all(workspace.join(".kcoder/specs")).unwrap();
        std::fs::write(
            workspace.join(".kcoder/specs/config.yaml"),
            "schema: kcoder-spec-driven-superpowers\n",
        )
        .unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(workspace.join("AGENTS.md"))
            .unwrap();
        let settings = crate::test_support::engine_builder::fixture_settings();
        QueryEngine::new_with_plugin_snapshot(
            provider,
            kcoder_state::AppState::new(&workspace),
            kcoder_tools::ToolRegistry::new(),
            kcoder_permissions::PermissionEngine::from_settings(&settings),
            settings,
            kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
            kcoder_skills::SkillRegistry::default(),
            Arc::new(kcoder_tools::DenyAllUserQuestioner),
            workspace.clone(),
            kcoder_plugins::EffectivePluginSnapshot::default(),
        )
        .with_settings_persistence_path(workspace.join("test-config/settings.json"))
    }

    struct WaitingProvider {
        calls: Arc<AtomicUsize>,
        started: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    }

    impl kcoder_api::Provider for WaitingProvider {
        fn name(&self) -> &'static str {
            "guarded-steer-fixture"
        }

        fn stream_messages(
            &self,
            _: kcoder_types::MessagesRequest,
        ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let started = self.started.clone();
            let release = self.release.clone();
            Ok(Box::pin(async_stream::stream! {
                started.notify_one();
                release.notified().await;
                yield Ok(kcoder_types::StreamEvent::MessageStop);
            }))
        }
    }

    #[tokio::test]
    async fn dropped_turn_returns_only_undrained_steers_without_closing_next_turn() {
        if crate::isolated_test_profile::run_or_reexec(concat!(
            module_path!(),
            "::dropped_turn_returns_only_undrained_steers_without_closing_next_turn"
        )) {
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let engine = isolated_engine(
            root.path(),
            Arc::new(crate::test_support::providers::EmptyProvider),
        );
        let owner = engine.state.inspection_lifecycle_identity();
        let session = engine.begin_turn_steering().unwrap();
        let settlement = session.settlement();
        assert_eq!(
            engine.try_enqueue_turn_steer_for_lifecycle(&owner, 1, Message::user_text("drained")),
            GuardedTurnSteer::Queued
        );
        assert_eq!(session.drain_pending().len(), 1);
        assert_eq!(
            engine.try_enqueue_turn_steer_for_lifecycle(&owner, 2, Message::user_text("pending")),
            GuardedTurnSteer::Queued
        );
        drop(session);

        let next = engine.begin_turn_steering().unwrap();
        assert_eq!(settlement.close(), vec![2]);
        assert!(settlement.close().is_empty());
        assert_eq!(
            engine.try_enqueue_turn_steer_for_lifecycle(&owner, 3, Message::user_text("next")),
            GuardedTurnSteer::Queued
        );
        assert_eq!(next.drain_pending().len(), 1);
    }

    #[tokio::test]
    async fn terminal_boundary_closes_steering_before_idle_admission() {
        if crate::isolated_test_profile::run_or_reexec(concat!(
            module_path!(),
            "::terminal_boundary_closes_steering_before_idle_admission"
        )) {
            return;
        }
        crate::isolated_test_profile::require_isolated_profile()
            .expect("an explicitly isolated test profile is required");
        let root = tempfile::tempdir().unwrap();
        let engine = isolated_engine(
            root.path(),
            Arc::new(crate::test_support::providers::EmptyProvider),
        );
        let owner = engine.state.inspection_lifecycle_identity();
        let mut session = engine.begin_turn_steering().unwrap();
        assert_eq!(
            engine.try_enqueue_turn_steer_for_lifecycle(
                &owner,
                77,
                Message::user_text("accepted before terminal boundary"),
            ),
            GuardedTurnSteer::Queued
        );
        let claim = kcoder_types::async_user_questions::AsyncQuestionDeliveryClaim {
            question_id: "question-terminal-race".into(),
            submission_id: "submission-terminal-race".into(),
            claim_id: "claim-terminal-race".into(),
            message_id: "stable-terminal-race-uuid".into(),
            revision: 1,
            message: Message::user_text("Answers to your questions:\nChoice: A"),
        };
        assert_eq!(
            engine.try_enqueue_async_question_delivery(&owner, 79, &claim),
            GuardedTurnSteer::Queued
        );

        // This is the host's terminal-event edge. Queued-but-not-drained work
        // is returned for safe failure reconciliation, and later admissions
        // cannot target the stream that is about to be dropped.
        assert_eq!(engine.close_active_turn_steering(), vec![77, 79]);
        assert_eq!(
            engine.try_enqueue_turn_steer_for_lifecycle(
                &owner,
                78,
                Message::user_text("after terminal boundary"),
            ),
            GuardedTurnSteer::NoActiveTurn
        );
        assert!(matches!(
            session.finish_or_drain(),
            TurnSteerBoundary::Finished
        ));
        assert!(engine.state.messages().is_empty());
        assert!(engine.begin_turn_steering().is_some());
    }

    #[tokio::test]
    async fn guarded_steer_is_not_consumed_after_session_replacement() {
        if crate::isolated_test_profile::run_or_reexec(concat!(
            module_path!(),
            "::guarded_steer_is_not_consumed_after_session_replacement"
        )) {
            return;
        }
        crate::isolated_test_profile::require_isolated_profile()
            .expect("an explicitly isolated test profile is required");
        let root = tempfile::tempdir().unwrap();
        let engine = isolated_engine(
            root.path(),
            Arc::new(crate::test_support::providers::EmptyProvider),
        );
        let owner = engine.state.inspection_lifecycle_identity();
        let session = engine.begin_turn_steering().unwrap();
        assert_eq!(
            engine.try_enqueue_turn_steer_for_lifecycle(
                &owner,
                1,
                Message::user_text("old session")
            ),
            GuardedTurnSteer::Queued
        );
        engine.state.start_new_session().unwrap();
        let replacement = engine.state.inspection_lifecycle_identity();
        assert_eq!(
            engine.try_enqueue_turn_steer_for_lifecycle(
                &replacement,
                8,
                Message::user_text("new input")
            ),
            GuardedTurnSteer::OwnerChanged
        );
        assert!(matches!(
            engine.enqueue_turn_steer(7, Message::user_text("new public input")),
            Err(TurnSteerError::SessionChanged)
        ));
        let result = engine.apply_turn_steers(session.drain_pending()).await;
        assert!(result.blocked);
        assert!(result.applied.is_empty());
        assert!(engine.state.messages().is_empty());
        assert_eq!(
            engine.try_enqueue_turn_steer_for_lifecycle(&owner, 2, Message::user_text("stale")),
            GuardedTurnSteer::OwnerChanged
        );
    }

    #[tokio::test]
    async fn guarded_steer_does_not_wait_for_the_mailbox_and_preserves_normal_consumption() {
        if crate::isolated_test_profile::run_or_reexec(concat!(
            module_path!(),
            "::guarded_steer_does_not_wait_for_the_mailbox_and_preserves_normal_consumption"
        )) {
            return;
        }
        crate::isolated_test_profile::require_isolated_profile()
            .expect("an explicitly isolated test profile is required");
        let root = tempfile::tempdir().unwrap();
        let engine = isolated_engine(
            root.path(),
            Arc::new(crate::test_support::providers::EmptyProvider),
        );
        let owner = engine.state.inspection_lifecycle_identity();
        let session = engine.begin_turn_steering().unwrap();
        let held = engine.turn_steer_mailbox.lock().unwrap();
        assert_eq!(
            engine.try_enqueue_turn_steer_for_lifecycle(&owner, 3, Message::user_text("busy")),
            GuardedTurnSteer::Busy
        );
        drop(held);
        assert_eq!(
            engine.try_enqueue_turn_steer_for_lifecycle(&owner, 4, Message::user_text("current")),
            GuardedTurnSteer::Queued
        );
        let result = engine.apply_turn_steers(session.drain_pending()).await;
        assert!(!result.blocked);
        assert_eq!(result.applied, vec![4]);
        assert_eq!(engine.state.messages(), vec![Message::user_text("current")]);
    }

    #[tokio::test]
    async fn async_question_steer_retains_the_state_claim_and_stable_message_id() {
        if crate::isolated_test_profile::run_or_reexec(concat!(
            module_path!(),
            "::async_question_steer_retains_the_state_claim_and_stable_message_id"
        )) {
            return;
        }
        crate::isolated_test_profile::require_isolated_profile()
            .expect("an explicitly isolated test profile is required");
        let root = tempfile::tempdir().unwrap();
        let engine = isolated_engine(
            root.path(),
            Arc::new(crate::test_support::providers::EmptyProvider),
        );
        engine
            .state
            .bind_channel_task_source(kcoder_types::agent_definition::ChannelTaskSource {
                owner: kcoder_types::integrations::core::IntegrationOwner {
                    account_id: "test-account".into(),
                    target_id: "test-target".into(),
                    workspace_id: kcoder_types::integrations::core::IntegrationNullable::Null,
                    organization_id: None,
                },
                channel_id: "same-task-channel".into(),
            })
            .unwrap();
        let owner = engine.state.inspection_lifecycle_identity();
        let session = engine.begin_turn_steering().unwrap();
        let claim = kcoder_types::async_user_questions::AsyncQuestionDeliveryClaim {
            question_id: "question-1".into(),
            submission_id: "submission-1".into(),
            claim_id: "claim-1".into(),
            message_id: "stable-transcript-uuid-1".into(),
            revision: 3,
            message: Message::user_text("Answers to your questions:\nApproach: A"),
        };

        let unattended_round = engine.clone().with_unattended_input();
        assert!(!unattended_round.user_interaction_round_is_attended());
        assert_eq!(
            unattended_round.try_enqueue_async_question_delivery(&owner, 40, &claim),
            GuardedTurnSteer::OwnerChanged
        );

        // The same State and active turn remain interactive through the Web
        // Engine candidate. The durable channel source marker is not a gate.
        assert!(engine.state.channel_task_source().is_some());
        assert!(engine.user_interaction_round_is_attended());
        assert_eq!(
            engine.try_enqueue_async_question_delivery(&owner, 41, &claim),
            GuardedTurnSteer::Queued
        );
        let pending = session.drain_pending();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, 41);
        assert_eq!(pending[0].message, claim.message);
        assert_eq!(
            pending[0]
                .async_question_delivery
                .as_ref()
                .map(|claim| claim.message_id.as_str()),
            Some("stable-transcript-uuid-1")
        );
    }

    #[tokio::test]
    async fn stale_steer_stops_the_turn_before_another_provider_request() {
        if crate::isolated_test_profile::run_or_reexec(concat!(
            module_path!(),
            "::stale_steer_stops_the_turn_before_another_provider_request"
        )) {
            return;
        }
        crate::isolated_test_profile::require_isolated_profile()
            .expect("an explicitly isolated test profile is required");
        let root = tempfile::tempdir().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let engine = isolated_engine(
            root.path(),
            Arc::new(WaitingProvider {
                calls: calls.clone(),
                started: started.clone(),
                release: release.clone(),
            }),
        );
        engine.state.add_message(Message::user_text("initial"));
        let owner = engine.state.inspection_lifecycle_identity();
        let steering = engine.begin_turn_steering().unwrap();
        let run = engine.clone();
        let task = tokio::spawn(async move {
            run.run_turn_stream_with_cancel_and_steering(
                &kcoder_permissions::AutoDenyPrompt,
                CancellationToken::new(),
                steering,
            )
            .collect::<Vec<_>>()
            .await
        });
        tokio::time::timeout(Duration::from_secs(3), started.notified())
            .await
            .unwrap();
        assert_eq!(
            engine.try_enqueue_turn_steer_for_lifecycle(&owner, 9, Message::user_text("old steer")),
            GuardedTurnSteer::Queued
        );
        engine.state.start_new_session().unwrap();
        release.notify_one();
        let events = tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(events.iter().any(|event| matches!(event, EngineEvent::Error(message) if message.contains("original session"))));
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, EngineEvent::TurnSteerApplied { id: 9 }))
        );
        assert!(engine.state.messages().is_empty());
    }
}
