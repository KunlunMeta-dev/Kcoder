//! One resident thread's foreground turn, interaction state, and cancellation.
use crate::background_delivery::clear_active_background_projection;
use crate::{BackgroundProjectionState, request_origin};
use kcoder_app_interactions::interaction_requests::{
    approval_response_timeout, resolve_server_response,
};
use kcoder_app_interactions::{
    AppServerPermissionPrompt, AppServerQuestioner, ApprovalContext, InteractionReceipts,
    InteractionReply, PendingApprovalResponses, PendingQuestionResponses, QuestionContext,
    QuestionSourceGuard,
};
use kcoder_app_protocol::{TurnSteerSettledParams, method};
use kcoder_desktop_recovery::DesktopGrantState;
use kcoder_engine::QueryEngine;
use kcoder_host_transport::protocol_io::{notification, send};
use kcoder_tools::UserQuestioner;
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{
    Arc, Mutex as StdMutex,
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
};
use std::time::Duration;
use tokio::sync::{Mutex, Notify, mpsc};
use tokio_util::sync::CancellationToken;

pub struct ActiveTurn {
    /// Accepted desktop intent, including startup before a desktop grant exists.
    pub desktop_owner: Option<kcoder_types::computer_use::DesktopOwner>,
    /// The actual accepted input's owner; never supplied through RPC data.
    pub input_owner: Option<std::sync::Weak<()>>,
    pub handle: tokio::task::JoinHandle<()>,
    pub cancel: CancellationToken,
    pub thread_id: String,
    pub turn_id: String,
    /// The original accepted attempt. Legacy automatic turns without a native
    /// attempt stay unverified for continuous-work dispatch.
    pub attempt: Option<kcoder_types::TurnAttemptIdentity>,
    /// Transport provenance is an observation, never a source authorization.
    // Read only by the attempt matcher, which has no production caller yet.
    #[cfg_attr(not(test), allow(dead_code))]
    pub origin: request_origin::RequestOrigin,
}

/// Original accepted intent retained until its input event or a stopped archive settles it.
/// This record grants no execution or source authority.
#[derive(Clone)]
pub struct AcceptedTurnInput {
    pub attempt: kcoder_types::TurnAttemptIdentity,
    pub message: Arc<kcoder_types::Message>,
}

/// Streamed text of the assistant message in progress, keyed by its attempt. Only the
/// newest bytes are retained; readers never hold this lock across an await.
#[derive(Default)]
struct LiveAssistantText {
    attempt: Option<kcoder_types::TurnAttemptIdentity>,
    text: String,
    truncated_front: bool,
}
const LIVE_ASSISTANT_BYTES: usize = 96 * 1024;

/// One owned per-thread maintenance operation (manual compaction or rollback).
///
/// It runs off the app-server dispatch loop. Its claim excludes turn
/// registration, another maintenance operation and idle eviction of the same
/// thread; it does not hold the activity gate, so other control requests and
/// other threads keep being served while it runs.
pub struct ThreadMaintenanceJob {
    id: uuid::Uuid,
    pub operation: kcoder_app_protocol::ThreadMaintenanceOperation,
    /// Interrupts only the cancellable phase (summary generation); a started
    /// commit protocol always completes.
    pub cancel: CancellationToken,
    pub handle: Option<tokio::task::JoinHandle<()>>,
}

/// Shared maintenance slot of one resident thread.
pub type ThreadMaintenanceSlot = Arc<StdMutex<Option<ThreadMaintenanceJob>>>;

/// Whether a maintenance operation currently owns the thread.
pub fn maintenance_active(slot: &StdMutex<Option<ThreadMaintenanceJob>>) -> bool {
    slot.lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .is_some()
}

/// The claim of one maintenance operation; returned by `try_begin_maintenance`.
pub struct MaintenanceClaim {
    pub id: uuid::Uuid,
    pub cancel: CancellationToken,
}

/// Foreground execution and interaction state for one resident thread.
///
/// These fields must remain one ownership unit with the thread runtime. Sharing
/// them at workspace scope would make turns on different threads reject each other
/// or route questions, approvals, and interrupts to the wrong turn.
#[derive(Clone)]
pub struct ResidentTurnState {
    pub desktop_grant: Arc<StdMutex<DesktopGrantState>>,
    /// Terminal answers and outstanding interactions of the owning connection.
    pub interaction_receipts: Arc<StdMutex<InteractionReceipts>>,
    pub accepting_turns: Arc<AtomicBool>,
    pub running: Arc<AtomicBool>,
    pub activity_gate: Arc<Mutex<()>>,
    pub pending_user_admissions: Arc<AtomicUsize>,
    pub active_turn: Arc<Mutex<Option<ActiveTurn>>>,
    accepted_input: Arc<StdMutex<Option<AcceptedTurnInput>>>,
    /// Read-only copy of the assistant text the current attempt has streamed so far.
    live_assistant: Arc<StdMutex<LiveAssistantText>>,
    pub question_context: Arc<StdMutex<Option<QuestionContext>>>,
    pub pending_questions: PendingQuestionResponses,
    pub approval_context: Arc<StdMutex<Option<ApprovalContext>>>,
    pub pending_approvals: PendingApprovalResponses,
    /// Maps Engine's in-process steer receipt to the durable async question whose
    /// State transition must be fanned out after the Engine confirms application.
    pub async_question_steers: Arc<StdMutex<HashMap<u64, String>>>,
    /// Plain user steers accepted by the running turn, keyed by Engine receipt.
    /// Settled (applied or dropped) exactly once by the turn's event loop.
    pub user_steers: Arc<StdMutex<HashMap<u64, PendingUserSteer>>>,
    pub user_steer_receipts: Arc<StdMutex<VecDeque<kcoder_app_protocol::TurnSteerReceipt>>>,
    /// Covers answer RPC admission windows before the turn has an Engine receipt.
    pub async_question_routes_in_flight: Arc<StdMutex<HashSet<String>>>,
    /// Holds Engine event projection until an async-answer RPC has returned its
    /// admission receipt, so a fast active turn cannot notify before ownership
    /// is transferred by the RPC response.
    pub async_question_response_gate: Arc<Mutex<()>>,
    pub permission_prompt: AppServerPermissionPrompt,
    pub user_questioner: Arc<dyn UserQuestioner>,
    /// Owned manual compaction/rollback of this thread, if one is running.
    pub maintenance: ThreadMaintenanceSlot,
}

/// An accepted steer that the turn has not yet applied.
pub struct PendingUserSteer {
    pub thread_id: String,
    pub turn_id: String,
    pub client_message_id: Option<String>,
    pub text: String,
    pub attachments: Option<kcoder_attachments::SteerAttachmentLease>,
}

impl PendingUserSteer {
    pub fn settled(self, steer_id: u64, dropped: bool) -> Value {
        if let Some(attachments) = self.attachments
            && let Err(error) = attachments.settle(!dropped)
        {
            tracing::warn!(%error, "steer attachment settlement cleanup incomplete");
        }
        let params = TurnSteerSettledParams {
            thread_id: self.thread_id,
            turn_id: self.turn_id,
            steer_id,
            client_message_id: self.client_message_id,
            text: dropped.then_some(self.text),
        };
        let method = if dropped {
            method::TURN_STEER_DROPPED
        } else {
            method::TURN_STEER_APPLIED
        };
        notification(method, serde_json::to_value(params).unwrap_or(Value::Null))
    }
}

impl ResidentTurnState {
    pub fn retain_accepted_input(
        &self,
        attempt: kcoder_types::TurnAttemptIdentity,
        message: Option<kcoder_types::Message>,
    ) {
        *self
            .accepted_input
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = message.map(|message| AcceptedTurnInput {
            attempt,
            message: Arc::new(message),
        });
    }

    /// Mirror streamed assistant text for read-only observers. Completed messages are
    /// committed to history, so each message boundary clears the mirror.
    pub fn observe_live_assistant(
        &self,
        attempt: &kcoder_types::TurnAttemptIdentity,
        event: &kcoder_engine::EngineEvent,
    ) {
        use kcoder_engine::EngineEvent;
        let delta = match event {
            EngineEvent::AssistantTextDelta(delta) => Some(delta.as_str()),
            EngineEvent::AssistantMessageStarted | EngineEvent::AssistantMessageDone => None,
            _ => return,
        };
        let mut live = self
            .live_assistant
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if delta.is_none() || live.attempt.as_ref() != Some(attempt) {
            live.text.clear();
            live.truncated_front = false;
            live.attempt = Some(attempt.clone());
        }
        let Some(delta) = delta else { return };
        live.text.push_str(delta);
        if live.text.len() > LIVE_ASSISTANT_BYTES {
            let mut cut = live.text.len() - LIVE_ASSISTANT_BYTES;
            while !live.text.is_char_boundary(cut) {
                cut += 1;
            }
            live.text.drain(..cut);
            live.truncated_front = true;
        }
    }

    /// The streamed text of `attempt`'s unfinished assistant message, if any.
    pub fn live_assistant_text(
        &self,
        attempt: &kcoder_types::TurnAttemptIdentity,
    ) -> Option<(String, bool)> {
        let live = self
            .live_assistant
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        (live.attempt.as_ref() == Some(attempt) && !live.text.is_empty())
            .then(|| (live.text.clone(), live.truncated_front))
    }

    pub fn accepted_input(&self) -> Option<AcceptedTurnInput> {
        self.accepted_input
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    pub fn clear_accepted_input(&self, attempt: &kcoder_types::TurnAttemptIdentity) {
        let mut input = self
            .accepted_input
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if input
            .as_ref()
            .is_some_and(|input| &input.attempt == attempt)
        {
            *input = None;
        }
    }

    pub fn record_user_steer(
        &self,
        steer: &PendingUserSteer,
        status: kcoder_app_protocol::TurnSteerReceiptStatus,
    ) {
        let Some(id) = &steer.client_message_id else {
            return;
        };
        let mut receipts = self
            .user_steer_receipts
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if let Some(receipt) = receipts.iter_mut().find(|r| r.client_message_id == *id) {
            receipt.status = status;
            return;
        }
        receipts.push_back(kcoder_app_protocol::TurnSteerReceipt {
            thread_id: steer.thread_id.clone(),
            turn_id: steer.turn_id.clone(),
            client_message_id: id.clone(),
            status,
        });
        while receipts.len() > 256 {
            receipts.pop_front();
        }
    }

    pub fn new(
        outbound_tx: mpsc::Sender<Value>,
        permission_mode: kcoder_config::PermissionMode,
        next_interaction_id: Arc<AtomicU64>,
        receipts: Arc<StdMutex<InteractionReceipts>>,
    ) -> Self {
        let pending_questions = Arc::new(StdMutex::new(HashMap::new()));
        let question_context = Arc::new(StdMutex::new(None));
        let pending_approvals = Arc::new(StdMutex::new(HashMap::new()));
        let approval_context = Arc::new(StdMutex::new(None));
        let approval_artifact_dir = Arc::new(StdMutex::new(None));
        let permission_prompt = AppServerPermissionPrompt {
            tool_call_id: None,
            tool_call_identity_enabled: false,
            mode: permission_mode,
            outbound_tx: outbound_tx.clone(),
            pending: Arc::clone(&pending_approvals),
            receipts: Arc::clone(&receipts),
            next_id: Arc::clone(&next_interaction_id),
            context: Arc::clone(&approval_context),
            artifact_dir: approval_artifact_dir,
            response_timeout: approval_response_timeout(),
        };
        let user_questioner: Arc<dyn UserQuestioner> = Arc::new(AppServerQuestioner {
            source_guard: None,
            outbound_tx,
            pending: Arc::clone(&pending_questions),
            receipts: Arc::clone(&receipts),
            next_id: next_interaction_id,
            context: Arc::clone(&question_context),
        });
        Self {
            desktop_grant: Arc::new(StdMutex::new(DesktopGrantState::default())),
            interaction_receipts: receipts,
            accepting_turns: Arc::new(AtomicBool::new(true)),
            running: Arc::new(AtomicBool::new(false)),
            activity_gate: Arc::new(Mutex::new(())),
            pending_user_admissions: Arc::new(AtomicUsize::new(0)),
            active_turn: Arc::new(Mutex::new(None)),
            accepted_input: Arc::new(StdMutex::new(None)),
            live_assistant: Arc::default(),
            question_context,
            pending_questions,
            approval_context,
            pending_approvals,
            async_question_steers: Arc::new(StdMutex::new(HashMap::new())),
            user_steers: Arc::new(StdMutex::new(HashMap::new())),
            user_steer_receipts: Arc::new(StdMutex::new(VecDeque::new())),
            async_question_routes_in_flight: Arc::new(StdMutex::new(HashSet::new())),
            async_question_response_gate: Arc::new(Mutex::new(())),
            permission_prompt,
            user_questioner,
            maintenance: Arc::new(StdMutex::new(None)),
        }
    }

    pub fn configure_for_engine(&mut self, engine: &QueryEngine) {
        // New sessions use the freshly loaded policy, not the bootstrap connection mode.
        self.permission_prompt.mode = engine
            .settings
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .permission_mode;
        *self
            .permission_prompt
            .artifact_dir
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(
            engine
                .session_storage_dir_for(&engine.session_id())
                .join("approval-decisions"),
        );
    }

    /// A resident runtime owns pending interactions and receipts, but the
    /// current input's authenticated route owns their delivery. Never reuse
    /// the creator's closed output pipe when another client starts a turn.
    pub fn interactions_for_input(
        &self,
        outbound_tx: mpsc::Sender<Value>,
        source_guard: Option<QuestionSourceGuard>,
    ) -> (AppServerPermissionPrompt, Arc<dyn UserQuestioner>) {
        let mut permission = self.permission_prompt.clone();
        permission.outbound_tx = outbound_tx.clone();
        let questioner = AppServerQuestioner {
            source_guard,
            outbound_tx,
            pending: self.pending_questions.clone(),
            receipts: self.interaction_receipts.clone(),
            next_id: self.permission_prompt.next_id.clone(),
            context: self.question_context.clone(),
        };
        (permission, Arc::new(questioner))
    }

    pub fn with_approval_tool_identity(mut self, enabled: bool) -> Self {
        self.permission_prompt.tool_call_identity_enabled = enabled;
        self
    }

    pub fn resolve_response(&self, response: &Value, require_binding: bool) -> InteractionReply {
        resolve_server_response(
            response,
            &self.pending_approvals,
            &self.pending_questions,
            &self.interaction_receipts,
            require_binding,
        )
    }

    pub fn clear_pending(&self) {
        self.pending_approvals
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        self.pending_questions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }

    /// Must be called under `activity_gate`. A second closed-state check covers the
    /// interleaving window between shutdown and scheduler CAS, preventing a turn from
    /// starting after its runtime has been removed.
    pub fn try_claim_turn(&self) -> bool {
        if !self.accepting_turns.load(Ordering::SeqCst)
            || self.maintenance_operation().is_some()
            || self
                .running
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
        {
            return false;
        }
        if self.accepting_turns.load(Ordering::SeqCst) {
            true
        } else {
            self.running.store(false, Ordering::SeqCst);
            false
        }
    }

    /// Claim an idle runtime and retain the activity gate until the caller publishes the active handle.
    ///
    /// A very fast turn may finish immediately after `tokio::spawn` returns and reset
    /// `running`. Releasing the gate before publishing its handle would let the
    /// background scheduler register a new turn in that window, only to have its handle
    /// overwritten by the old one. Returning an owned guard makes claim-to-publish one critical section.
    pub async fn claim_turn_registration(&self) -> Option<tokio::sync::OwnedMutexGuard<()>> {
        let guard = Arc::clone(&self.activity_gate).lock_owned().await;
        self.try_claim_turn().then_some(guard)
    }

    /// A request dispatcher must keep reading replies while an idle owner
    /// holds this gate across a peer authorization round trip.
    pub fn try_claim_turn_registration(&self) -> Option<tokio::sync::OwnedMutexGuard<()>> {
        let guard = Arc::clone(&self.activity_gate).try_lock_owned().ok()?;
        self.try_claim_turn().then_some(guard)
    }

    /// The running maintenance operation of this thread, if any.
    pub fn maintenance_operation(&self) -> Option<kcoder_app_protocol::ThreadMaintenanceOperation> {
        self.maintenance
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .map(|job| job.operation)
    }

    /// Claim this idle thread for one maintenance operation. Must be called
    /// under `activity_gate`, like turn registration, so a turn and a
    /// maintenance operation can never both be admitted.
    pub fn try_begin_maintenance(
        &self,
        operation: kcoder_app_protocol::ThreadMaintenanceOperation,
    ) -> Option<MaintenanceClaim> {
        if !self.accepting_turns.load(Ordering::SeqCst) || self.running.load(Ordering::SeqCst) {
            return None;
        }
        let mut slot = self
            .maintenance
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if slot.is_some() {
            return None;
        }
        let claim = MaintenanceClaim {
            id: uuid::Uuid::new_v4(),
            cancel: CancellationToken::new(),
        };
        *slot = Some(ThreadMaintenanceJob {
            id: claim.id,
            operation,
            cancel: claim.cancel.clone(),
            handle: None,
        });
        Some(claim)
    }

    /// Record the spawned task of a still-current claim. A task that already
    /// finished released its claim; its handle is simply dropped.
    pub fn attach_maintenance_handle(&self, id: uuid::Uuid, handle: tokio::task::JoinHandle<()>) {
        let mut slot = self
            .maintenance
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(job) = slot.as_mut().filter(|job| job.id == id) {
            job.handle = Some(handle);
        }
    }

    /// Release the claim `id`. Called by the operation itself under
    /// `activity_gate` once its result is final.
    pub fn finish_maintenance(&self, id: uuid::Uuid) {
        let mut slot = self
            .maintenance
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if slot.as_ref().is_some_and(|job| job.id == id) {
            *slot = None;
        }
    }

    /// Signal only an active compaction. An identity is required for the
    /// dedicated cancellation RPC; legacy unqualified interrupts pass None.
    pub fn cancel_compaction(&self, expected: Option<uuid::Uuid>) -> bool {
        let slot = self
            .maintenance
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(job) = slot.as_ref().filter(|job| {
            job.operation == kcoder_app_protocol::ThreadMaintenanceOperation::Compact
                && expected.is_none_or(|id| job.id == id)
        }) {
            job.cancel.cancel();
            return true;
        }
        false
    }

    /// Shutdown: cancel the cancellable phase and wait for the owned task to
    /// settle. A commit that already started is allowed to finish within `timeout`.
    pub async fn drain_maintenance(&self, timeout: Duration) {
        let handle = {
            let mut slot = self
                .maintenance
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            slot.as_mut().and_then(|job| {
                job.cancel.cancel();
                job.handle.take()
            })
        };
        if let Some(handle) = handle
            && tokio::time::timeout(timeout, handle).await.is_err()
        {
            tracing::warn!("thread maintenance did not settle before the shutdown deadline");
        }
    }

    pub fn stop_accepting_turns(&self) {
        self.accepting_turns.store(false, Ordering::SeqCst);
    }

    /// Publish the idle boundary under the same gate used by async-question
    /// admission and ordinary turn registration.
    pub async fn finish_turn_registration(&self) {
        let _gate = self.activity_gate.lock().await;
        self.clear_turn_registration();
    }

    /// Retain the admission gate until the terminal event is enqueued.
    pub async fn publish_turn_completion(
        &self,
        outbound: &mpsc::Sender<Value>,
        message: Value,
    ) -> anyhow::Result<()> {
        let _gate = self.activity_gate.lock().await;
        self.clear_turn_registration();
        send(outbound, message).await
    }

    fn clear_turn_registration(&self) {
        self.running.store(false, Ordering::SeqCst);
        self.async_question_steers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }

    pub fn resume_accepting_turns(&self) {
        self.accepting_turns.store(true, Ordering::SeqCst);
    }

    /// Inspect only the currently owned resident attempt. The caller must
    /// already hold the activity gate and separately validate work/source
    /// authority. A busy active-turn lock is unknown, never a match.
    // Only tests consult it until a production caller exists.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn try_matches_active_attempt(
        &self,
        expected: &kcoder_types::TurnAttemptIdentity,
        required_origin: Option<request_origin::RequestOrigin>,
    ) -> Option<bool> {
        if !self.accepting_turns.load(Ordering::SeqCst) || !self.running.load(Ordering::SeqCst) {
            return Some(false);
        }
        let active = self.active_turn.try_lock().ok()?;
        Some(active.as_ref().is_some_and(|active| {
            active.matches_attempt(expected)
                && required_origin.is_none_or(|origin| active.origin == origin)
                && !active.cancel.is_cancelled()
                && !active.handle.is_finished()
                && self.accepting_turns.load(Ordering::SeqCst)
                && self.running.load(Ordering::SeqCst)
        }))
    }

    pub fn clear_matching_turn(&self, thread_id: &str, turn_id: &str) {
        let clear_questions = {
            let mut context = self
                .question_context
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let matches = context.as_ref().is_some_and(|context| {
                context.thread_id == thread_id && context.turn_id == turn_id
            });
            if matches {
                *context = None;
            }
            matches
        };
        if clear_questions {
            self.pending_questions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clear();
            self.async_question_steers
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clear();
        }
        let clear_approvals = {
            let mut context = self
                .approval_context
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let matches = context.as_ref().is_some_and(|context| {
                context.thread_id == thread_id && context.turn_id == turn_id
            });
            if matches {
                *context = None;
            }
            matches
        };
        if clear_approvals {
            self.pending_approvals
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clear();
        }
    }

    pub fn clear_all_turn_state(&self) {
        self.clear_pending();
        self.async_question_steers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        *self
            .question_context
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        *self
            .approval_context
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        self.running.store(false, Ordering::SeqCst);
    }
}

impl ActiveTurn {
    pub fn matches(&self, thread_id: Option<&str>, turn_id: Option<&str>) -> bool {
        thread_id == Some(self.thread_id.as_str()) && turn_id == Some(self.turn_id.as_str())
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn matches_attempt(&self, expected: &kcoder_types::TurnAttemptIdentity) -> bool {
        self.matches(
            Some(expected.thread_id.as_str()),
            Some(expected.turn_id.as_str()),
        ) && self.attempt.as_ref() == Some(expected)
    }

    fn matches_execution(
        &self,
        thread_id: &str,
        turn_id: &str,
        attempt: Option<&kcoder_types::TurnAttemptIdentity>,
        task_id: tokio::task::Id,
    ) -> bool {
        self.matches(Some(thread_id), Some(turn_id))
            && self.attempt.as_ref() == attempt
            && self.handle.id() == task_id
    }
}

pub async fn cancel_active_turn_with_timeout(
    mut active: ActiveTurn,
    turn_state: &ResidentTurnState,
    background_projection: &Arc<Mutex<BackgroundProjectionState>>,
    followup_notify: &Notify,
    timeout: Duration,
) -> bool {
    let thread_id = active.thread_id.clone();
    let turn_id = active.turn_id.clone();
    let attempt = active.attempt.clone();
    // Keep an owned task reference until cleanup finishes so a task ID cannot
    // be reused after a forced abort and mistaken for this original handle.
    let task_identity = active.handle.abort_handle();
    let task_id = task_identity.id();
    active.cancel.cancel();
    {
        let _gate = turn_state.activity_gate.lock().await;
        let has_newer_turn = turn_state
            .active_turn
            .lock()
            .await
            .as_ref()
            .is_some_and(|current| {
                !current.matches_execution(&thread_id, &turn_id, attempt.as_ref(), task_id)
            });
        if !has_newer_turn {
            // Release this turn's interaction waiters first; otherwise question/approval
            // futures may prevent cooperative cancellation from finishing within the bound.
            turn_state.clear_pending();
            turn_state.clear_matching_turn(&thread_id, &turn_id);
        }
    }
    // A dropped/panicked turn cannot publish its normal terminal notification.
    let forced = match tokio::time::timeout(timeout, &mut active.handle).await {
        Ok(Ok(())) => false,
        Ok(Err(_)) => true,
        Err(_) => {
            active.handle.abort();
            let _ = active.handle.await;
            true
        }
    };
    let _gate = turn_state.activity_gate.lock().await;
    let mut current = turn_state.active_turn.lock().await;
    if current.as_ref().is_some_and(|active| {
        !active.matches_execution(&thread_id, &turn_id, attempt.as_ref(), task_id)
    }) {
        return forced;
    }
    if current.as_ref().is_some_and(|active| {
        active.matches_execution(&thread_id, &turn_id, attempt.as_ref(), task_id)
    }) {
        current.take();
    }
    drop(current);
    turn_state.clear_pending();
    turn_state.clear_matching_turn(&thread_id, &turn_id);
    clear_active_background_projection(background_projection, &thread_id, &turn_id).await;
    turn_state.running.store(false, Ordering::SeqCst);
    followup_notify.notify_waiters();
    forced
}

impl ResidentTurnState {
    pub fn pending_interaction_matches(
        &self,
        params: &kcoder_app_protocol::InteractionStatusReadParamsV1,
        mcp_app_pending_approvals: &PendingApprovalResponses,
    ) -> Option<bool> {
        // A busy lock is an incomplete snapshot, never evidence that an interaction resolved.
        use kcoder_app_protocol::InteractionStatusKindV1 as Kind;

        let mcp_app_is_pending = match params.kind {
            Kind::Approval => mcp_app_pending_approvals
                .try_lock()
                .ok()
                .map(|pending| pending.contains_key(&params.request_id)),
            Kind::Question => Some(false),
        };
        if mcp_app_is_pending == Some(true) {
            return Some(true);
        }

        let request_is_pending = match params.kind {
            Kind::Approval => self
                .pending_approvals
                .try_lock()
                .ok()?
                .contains_key(&params.request_id),
            Kind::Question => self
                .pending_questions
                .try_lock()
                .ok()?
                .contains_key(&params.request_id),
        };
        let context_matches = match params.kind {
            Kind::Approval => {
                self.approval_context
                    .try_lock()
                    .ok()?
                    .as_ref()
                    .is_some_and(|context| {
                        context.server_id == params.server_id
                            && context.thread_id == params.thread_id
                            && context.turn_id == params.turn_id
                    })
            }
            Kind::Question => {
                self.question_context
                    .try_lock()
                    .ok()?
                    .as_ref()
                    .is_some_and(|context| {
                        context.server_id == params.server_id
                            && context.thread_id == params.thread_id
                            && context.turn_id == params.turn_id
                    })
            }
        };
        let resident_match = request_is_pending && context_matches;
        if resident_match {
            return Some(true);
        }
        mcp_app_is_pending.map(|mcp_app_is_pending| mcp_app_is_pending || resident_match)
    }
}

#[cfg(test)]
mod terminal_registration_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn delayed_input_event_cannot_release_a_newer_accepted_input() {
        let (tx, _) = mpsc::channel(1);
        let state = ResidentTurnState::new(
            tx,
            kcoder_config::PermissionMode::Ask,
            Arc::new(AtomicU64::new(1)),
            Arc::new(StdMutex::new(InteractionReceipts::default())),
        );
        let old = kcoder_types::TurnAttemptIdentity {
            thread_id: "thread".into(),
            turn_id: "turn-1".into(),
            attempt_id: "old".into(),
        };
        let current = kcoder_types::TurnAttemptIdentity {
            attempt_id: "new".into(),
            ..old.clone()
        };
        state.retain_accepted_input(old.clone(), Some(kcoder_types::Message::user_text("old")));
        state.retain_accepted_input(
            current.clone(),
            Some(kcoder_types::Message::user_text("current")),
        );
        state.clear_accepted_input(&old);
        assert_eq!(state.accepted_input().unwrap().attempt, current);
        state.clear_accepted_input(&current);
        assert!(state.accepted_input().is_none());
    }

    #[tokio::test]
    async fn foreground_registration_never_waits_for_an_idle_authorization_owner() {
        let (outbound, _receiver) = mpsc::channel(4);
        let state = ResidentTurnState::new(
            outbound,
            kcoder_config::PermissionMode::Ask,
            Arc::new(AtomicU64::new(1)),
            Arc::new(StdMutex::new(InteractionReceipts::default())),
        );
        let idle = Arc::clone(&state.activity_gate).lock_owned().await;
        assert!(state.try_claim_turn_registration().is_none());
        assert!(!state.running.load(Ordering::SeqCst));
        drop(idle);
        let registration = state.try_claim_turn_registration().unwrap();
        assert!(state.running.load(Ordering::SeqCst));
        assert!(state.try_claim_turn_registration().is_none());
        drop(registration);
        state.finish_turn_registration().await;
    }

    #[tokio::test]
    async fn terminal_notice_cannot_race_the_next_turn_registration() {
        let (outbound, mut receiver) = mpsc::channel(1);
        let state = ResidentTurnState::new(
            outbound.clone(),
            kcoder_config::PermissionMode::Ask,
            Arc::new(AtomicU64::new(1)),
            Arc::new(StdMutex::new(InteractionReceipts::default())),
        );
        drop(state.claim_turn_registration().await.unwrap());
        outbound.send(json!({"blocked": true})).await.unwrap();
        let publishing = state.clone();
        let publisher = tokio::spawn(async move {
            publishing
                .publish_turn_completion(&outbound, json!({"method": "turn/completed"}))
                .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while state.running.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(state.activity_gate.try_lock().is_err());
        assert_eq!(receiver.recv().await.unwrap()["blocked"], true);
        assert_eq!(receiver.recv().await.unwrap()["method"], "turn/completed");
        publisher.await.unwrap().unwrap();
        let registration = state.claim_turn_registration().await;
        assert!(
            registration.is_some(),
            "a completed turn must accept the next input"
        );
        drop(registration);
        state.finish_turn_registration().await;
    }
}
