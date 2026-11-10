//! Nonblocking admission and one-use observation of one original user input.
use crate::history_flusher::{
    HistoryFlusherCommand, HistoryFlusherQueue, MessageCommitConfirmation, MessageCommitOutcome,
    NativeHistoryRowReceipt, OwnedSlot, SlotError, start_history_flusher,
    take_reclaimable_owned_slots, try_insert_owned_slot,
};
use crate::history_store::HistorySource;
use crate::{AppState, AppStateLifecycleIdentity, HistoryEntry, MessageRevision};
use anyhow::{Context, ensure};
use kcoder_types::{Message, MessageOrigin, SharedMessages, TurnAttemptIdentity};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;
use tokio::sync::{Mutex as AsyncMutex, oneshot};

#[cfg(test)]
#[path = "user_input_commit/tests.rs"]
mod tests;

const MAX_OBSERVED_MESSAGES: usize = 131_072;
const MAX_INPUT_OWNERS: usize = 128;

/// Busy and Rejected preserve the original input without admitting it.
/// Unknown preserves the input for display, but it must not be re-enqueued.
/// Accepted and Unknown with a pending handle are returned only after the
/// original ticket has entered a pre-reserved process-local owner slot.
/// Neither the owner nor its ticket survives a forced process termination.
pub enum UserInputStart {
    Busy(Message),
    Rejected {
        message: Message,
        reason: UserInputRejection,
        error: String,
    },
    Unknown {
        message: Message,
        error: String,
        uuid: String,
        attempt: Option<TurnAttemptIdentity>,
        pending: Option<PendingUserInput>,
    },
    Accepted(PendingUserInput),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UserInputRejection {
    InvalidMessage,
    StateUnavailable,
    LifecycleChanged,
    HistoryFaulted,
    HistoryUnbound,
    HistoryTooLarge,
    IdentityConflict,
    WriterUnavailable,
    OwnerCapacity,
    OwnerUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UserInputCommit {
    Durable,
    Ephemeral,
}

/// Observation of the original entry's writer reply and in-memory identity.
/// A process-local owner retains the original ticket when this handle is
/// dropped. This is not a persistent receipt or held-file authorization.
pub struct PendingUserInput {
    uuid: String,
    attempt: Option<TurnAttemptIdentity>,
    slot: Arc<InputOwnerSlot>,
    result: Option<oneshot::Receiver<Result<UserInputCommit, String>>>,
}

/// A successfully observed original input which can be rechecked before a
/// later model request. This is not a held-file or provider-dispatch lease.
#[derive(Clone)]
pub struct CommittedUserInput {
    outcome: UserInputCommit,
    original: Arc<OriginalInput>,
}

#[derive(Clone)]
pub(crate) struct WeakCommittedUserInput {
    outcome: UserInputCommit,
    original: Weak<OriginalInput>,
}

impl WeakCommittedUserInput {
    pub(crate) fn upgrade(&self) -> Option<CommittedUserInput> {
        Some(CommittedUserInput {
            outcome: self.outcome,
            original: self.original.upgrade()?,
        })
    }
}

impl CommittedUserInput {
    pub fn outcome(&self) -> UserInputCommit {
        self.outcome
    }
    pub fn uuid(&self) -> &str {
        &self.original.uuid
    }
    pub fn attempt(&self) -> Option<&TurnAttemptIdentity> {
        self.original.attempt.as_ref()
    }

    /// Check whether a shared request still contains this exact committed
    /// message allocation, not merely another message with equal text.
    pub fn is_shared_in(&self, messages: &SharedMessages) -> bool {
        self.original_message().is_some_and(|original| {
            messages
                .iter()
                .any(|message| std::ptr::eq(message, original))
        })
    }

    /// Compare the committed input with the host's original accepted message.
    pub fn matches_original(&self, message: &Message) -> bool {
        self.original_message() == Some(message)
    }

    pub(crate) fn original_message(&self) -> Option<&Message> {
        self.original.expected.get(self.original.position)
    }

    pub(crate) fn belongs_to_live_state(&self, state: &AppState) -> bool {
        self.original.lifecycle.try_matches(state) == Some(true)
    }

    pub(crate) fn claim_initial_work(&self) -> bool {
        self.original
            .initial_work_claimed
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    pub(crate) fn downgrade(&self) -> WeakCommittedUserInput {
        WeakCommittedUserInput {
            outcome: self.outcome,
            original: Arc::downgrade(&self.original),
        }
    }

    /// `Ok(false)` means a State lock is busy; an error means the original
    /// identity, message, or writer fence can no longer be confirmed.
    pub fn try_is_current(&self) -> anyhow::Result<bool> {
        self.original.try_validate_current()
    }

    /// Verify that this durable receipt belongs to the supplied State and
    /// lifecycle, and proves the exact identified user message now in State.
    pub fn try_is_current_for(
        &self,
        state: &AppState,
        owner: &AppStateLifecycleIdentity,
        expected_uuid: &str,
        expected_message: &Message,
    ) -> anyhow::Result<bool> {
        if self.outcome != UserInputCommit::Durable
            || self.original.uuid != expected_uuid
            || !owner.same_lifecycle(&self.original.lifecycle)
        {
            return Ok(false);
        }
        if !matches!(owner.try_matches(state), Some(true)) {
            return Ok(false);
        }
        let Some(original_message) = self.original.expected.get(self.original.position) else {
            return Ok(false);
        };
        if original_message != expected_message {
            return Ok(false);
        }
        self.original.try_validate_current()
    }

    /// Take process-local evidence from the original writer at most once.
    /// This is neither a current-owner check nor authority to dispatch work.
    /// None means that no receipt is retained or it was already taken.
    pub fn try_take_native_row_receipt(&self) -> anyhow::Result<Option<NativeHistoryRowReceipt>> {
        let mut reply = self
            .original
            .reply
            .try_lock()
            .map_err(|_| anyhow::anyhow!("original input receipt is busy"))?;
        match &mut *reply {
            WriterReply::Confirmed(confirmation) => Ok(confirmation.take_receipt()),
            WriterReply::Waiting(_) => anyhow::bail!("original input receipt is pending"),
            WriterReply::Unknown(error) => anyhow::bail!("{error}"),
        }
    }
}

struct OriginalInput {
    state: AppState,
    lifecycle: AppStateLifecycleIdentity,
    uuid: String,
    attempt: Option<TurnAttemptIdentity>,
    expected: SharedMessages,
    position: usize,
    path: Option<PathBuf>,
    source: Option<HistorySource>,
    queue: Option<(Arc<HistoryFlusherQueue>, u64)>,
    reply: AsyncMutex<WriterReply>,
    // Shared by every clone; a possibly submitted Work must never be replayed.
    initial_work_claimed: AtomicBool,
}

enum WriterReply {
    Waiting(oneshot::Receiver<anyhow::Result<MessageCommitConfirmation>>),
    Confirmed(Box<MessageCommitConfirmation>),
    Unknown(String),
}

struct InputOwnerSlot {
    intent: OnceLock<InputIntent>,
    original: OnceLock<Arc<OriginalInput>>,
    released: AtomicBool,
    stopped: AtomicBool,
    observer_alive: AtomicBool,
    success_settled: AtomicBool,
    retain_unknown: AtomicBool,
    #[cfg(test)]
    owner_id: OnceLock<tokio::task::Id>,
}

struct InputIntent {
    lifecycle: AppStateLifecycleIdentity,
    uuid: String,
    attempt: Option<TurnAttemptIdentity>,
    message: Message,
}

static OWNERS: [OwnedSlot<Arc<InputOwnerSlot>>; MAX_INPUT_OWNERS] =
    [const { OwnedSlot::new() }; MAX_INPUT_OWNERS];

static IDENTIFIED_OWNERS: OnceLock<std::sync::Mutex<HashMap<String, Weak<InputOwnerSlot>>>> =
    OnceLock::new();

fn identified_owner_registry() -> &'static std::sync::Mutex<HashMap<String, Weak<InputOwnerSlot>>> {
    IDENTIFIED_OWNERS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn register_identified_owner(uuid: &str, slot: &Arc<InputOwnerSlot>) -> Result<(), SlotError> {
    let mut owners = identified_owner_registry()
        .try_lock()
        .map_err(|_| SlotError::Unavailable)?;
    owners.retain(|_, owner| owner.strong_count() > 0);
    if owners.get(uuid).and_then(Weak::upgrade).is_some() {
        return Err(SlotError::Busy);
    }
    owners.insert(uuid.to_owned(), Arc::downgrade(slot));
    Ok(())
}

fn lookup_identified_owner(uuid: &str) -> anyhow::Result<Option<Arc<InputOwnerSlot>>> {
    let mut owners = identified_owner_registry()
        .try_lock()
        .map_err(|_| anyhow::anyhow!("identified input owner registry is busy or unavailable"))?;
    let owner = owners.get(uuid).and_then(Weak::upgrade);
    if owner.is_none() {
        owners.remove(uuid);
    }
    Ok(owner)
}

fn is_canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|uuid| {
        uuid.to_string() == value
            && uuid.get_version_num() == 5
            && uuid.as_bytes()[8] & 0xc0 == 0x80
    })
}

fn is_original_user_message(message: &Message) -> bool {
    matches!(
        message,
        Message::User {
            origin: MessageOrigin::User,
            ..
        }
    )
}

#[cfg(test)]
thread_local! {
    static FAIL_OWNER_RESERVATION: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn reserve_owner() -> Result<Arc<InputOwnerSlot>, SlotError> {
    #[cfg(test)]
    if FAIL_OWNER_RESERVATION.with(std::cell::Cell::get) {
        return Err(SlotError::Full);
    }
    reserve_from(&OWNERS)
}

/// Mark an owner released and drop every released owner from the process
/// ring at once. A released slot only stays in the ring until reuse, and its
/// original ticket owns a State clone: keeping it would pin a disposed
/// thread's State (and an ephemeral thread's private storage) indefinitely.
/// Holders that still need the ticket keep their own `Arc`.
fn release_owner(slot: &InputOwnerSlot) {
    slot.released.store(true, Ordering::Release);
    let reclaimed =
        take_reclaimable_owned_slots(&OWNERS, |owner| owner.released.load(Ordering::Acquire));
    drop(reclaimed);
}

fn reserve_from(
    owners: &[OwnedSlot<Arc<InputOwnerSlot>>],
) -> Result<Arc<InputOwnerSlot>, SlotError> {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    try_insert_owned_slot(
        owners,
        NEXT.fetch_add(1, Ordering::Relaxed),
        |slot| slot.released.load(Ordering::Acquire),
        || {
            let slot = Arc::new(InputOwnerSlot {
                intent: OnceLock::new(),
                original: OnceLock::new(),
                released: AtomicBool::new(false),
                stopped: AtomicBool::new(false),
                observer_alive: AtomicBool::new(true),
                success_settled: AtomicBool::new(false),
                retain_unknown: AtomicBool::new(false),
                #[cfg(test)]
                owner_id: OnceLock::new(),
            });
            (Arc::clone(&slot), slot)
        },
    )
}

struct InputOwnerGuard {
    slot: Arc<InputOwnerSlot>,
    finished: bool,
}

impl Drop for InputOwnerGuard {
    fn drop(&mut self) {
        if !self.finished {
            self.slot.stopped.store(true, Ordering::Release);
        }
    }
}

struct InputReservation {
    slot: Arc<InputOwnerSlot>,
    attached: bool,
}

impl Drop for InputReservation {
    fn drop(&mut self) {
        if !self.attached {
            release_owner(&self.slot);
        }
    }
}

impl AppState {
    /// Never waits for a State lock. The caller owns the previously captured
    /// lifecycle and the original message until this returns Accepted.
    pub fn try_begin_user_input(
        &self,
        owner: &AppStateLifecycleIdentity,
        message: Message,
    ) -> UserInputStart {
        self.try_begin_user_input_inner(owner, message, |_| {}, |_| {})
    }

    /// Admit one internally identified asynchronous answer using the UUID
    /// derived by State from its durable delivery claim. Callers must not pass
    /// a client-supplied identifier. Reconciliation should first use
    /// `find_committed_user_input_identified` so a retained original ticket or
    /// durable row is observed before any new admission is attempted.
    pub fn try_begin_user_input_identified(
        &self,
        owner: &AppStateLifecycleIdentity,
        message: Message,
        expected_uuid: &str,
    ) -> UserInputStart {
        if !is_canonical_uuid(expected_uuid) {
            return UserInputStart::Rejected {
                message,
                reason: UserInputRejection::IdentityConflict,
                error: "identified input UUID is invalid".into(),
            };
        }
        self.try_begin_user_input_with_identity_inner(
            owner,
            message,
            Some(expected_uuid),
            |_| {},
            |_| {},
        )
    }

    /// Reconcile one identified input before retrying admission. A durable
    /// result is returned only after the original in-process ticket settles or
    /// the exact UUID/session/message row is observed under the history source
    /// mutation lock. `None` means no receipt is currently proven; errors keep
    /// an unknown result unknown and must not be treated as permission to
    /// replay a different side effect.
    pub async fn find_committed_user_input_identified(
        &self,
        owner: &AppStateLifecycleIdentity,
        expected_uuid: &str,
        expected_message: &Message,
    ) -> anyhow::Result<Option<CommittedUserInput>> {
        anyhow::ensure!(
            is_canonical_uuid(expected_uuid),
            "identified input UUID is invalid"
        );
        anyhow::ensure!(
            is_original_user_message(expected_message),
            "original user input required"
        );
        anyhow::ensure!(
            matches!(owner.try_matches(self), Some(true)),
            "identified input lifecycle is not current for this State"
        );

        let mut original_ticket_unknown = None;
        if let Some(slot) = lookup_identified_owner(expected_uuid)? {
            let intent = slot
                .intent
                .get()
                .context("identified input owner intent is unavailable")?;
            anyhow::ensure!(
                intent.uuid == expected_uuid && &intent.message == expected_message,
                "identified input UUID conflicts with a different in-process message"
            );
            if owner.same_lifecycle(&intent.lifecycle) {
                if let Some(original) = slot.original.get().cloned() {
                    anyhow::ensure!(
                        original.uuid == expected_uuid
                            && original.lifecycle.same_lifecycle(owner)
                            && original
                                .expected
                                .get(original.position)
                                .is_some_and(|message| message == expected_message),
                        "identified input ticket does not match its original owner and message"
                    );
                    match original.wait().await {
                        Ok(UserInputCommit::Durable) => {
                            return Ok(Some(CommittedUserInput {
                                outcome: UserInputCommit::Durable,
                                original,
                            }));
                        }
                        Ok(UserInputCommit::Ephemeral) => {
                            anyhow::bail!("identified input has no durable history receipt");
                        }
                        Err(error) => original_ticket_unknown = Some(format!("{error:#}")),
                    }
                }
                if !slot.released.load(Ordering::Acquire) {
                    anyhow::bail!("identified input original ticket is still being admitted");
                }
            } else {
                // A new State lifecycle may reconcile only after the old
                // process-local owner has positively settled. The current
                // State still has to re-read the exact durable history row
                // below; an unknown or live old ticket remains unresolved.
                anyhow::ensure!(
                    slot.success_settled.load(Ordering::Acquire),
                    "identified input ticket belongs to a different or unresolved State lifecycle"
                );
            }
        }

        let (original, source, queue, session_id) = {
            let inner = match self.inner.try_read() {
                Ok(inner) => inner,
                Err(std::sync::TryLockError::WouldBlock) => {
                    anyhow::bail!("identified input State is busy; receipt remains unknown")
                }
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    anyhow::bail!("identified input State is unavailable")
                }
            };
            anyhow::ensure!(
                owner.matches_locked(self, &inner),
                "identified input lifecycle changed"
            );
            anyhow::ensure!(
                inner.history_write_fault.is_none(),
                "identified input history is faulted"
            );
            anyhow::ensure!(
                inner.message_history_ids.len() == inner.messages.len(),
                "identified input history identities are incomplete"
            );
            let mut position = None;
            for (index, identity) in inner.message_history_ids.iter().enumerate() {
                if identity.as_deref() == Some(expected_uuid) {
                    anyhow::ensure!(
                        position.replace(index).is_none(),
                        "identified input UUID is ambiguous in State"
                    );
                }
            }
            if let Some(position) = position {
                anyhow::ensure!(
                    inner.messages.get(position) == Some(expected_message),
                    "identified input UUID conflicts with different State message content"
                );
            }
            let Some(path) = inner.history_path.clone() else {
                anyhow::ensure!(
                    inner.history_source.is_none() && inner.history_flusher.is_none(),
                    "identified input history binding is incomplete"
                );
                if let Some(error) = original_ticket_unknown.as_deref() {
                    anyhow::bail!("identified input original ticket remains unknown: {error}");
                }
                return Ok(None);
            };
            let source = inner
                .history_source
                .clone()
                .context("identified input history source is missing")?;
            let queue = inner
                .history_flusher
                .as_ref()
                .map(|flusher| (Arc::clone(&flusher.queue), flusher.queue.current_epoch()));
            if let Some((queue, _)) = &queue {
                anyhow::ensure!(
                    !queue.worker_is_unknown() && !queue.worker_is_stopped(),
                    "identified input history writer is unknown"
                );
            }
            let lifecycle = owner.clone();
            let uuid = expected_uuid.to_owned();
            let session_id = inner.session_id.clone();
            let original = position.map(|position| {
                let attempt = inner.history_attempts.get(expected_uuid);
                Arc::new(OriginalInput {
                    state: self.clone(),
                    lifecycle,
                    uuid,
                    attempt,
                    expected: inner.messages.clone(),
                    position,
                    path: Some(path),
                    source: Some(source.clone()),
                    queue: queue.clone(),
                    initial_work_claimed: AtomicBool::new(true),
                    reply: AsyncMutex::new(WriterReply::Confirmed(Box::new(
                        MessageCommitConfirmation::committed(None),
                    ))),
                })
            });
            (original, source, queue.map(|(queue, _)| queue), session_id)
        };
        let found = crate::history_flusher::inspect_identified_history(
            source,
            queue,
            expected_uuid.to_owned(),
            session_id,
            expected_message.clone(),
        )
        .await?;
        if !found {
            if let Some(error) = original_ticket_unknown.as_deref() {
                anyhow::bail!(
                    "identified input original ticket remains unknown and no durable row was found: {error}"
                );
            }
            return Ok(None);
        }
        let Some(original) = original else {
            anyhow::bail!(
                "identified input is durable in history but absent from current State; reload the session before acknowledging"
            );
        };
        anyhow::ensure!(
            original.try_validate_current()?,
            "identified input changed while its durable receipt was observed"
        );
        Ok(Some(CommittedUserInput {
            outcome: UserInputCommit::Durable,
            original,
        }))
    }

    fn try_begin_user_input_inner(
        &self,
        owner: &AppStateLifecycleIdentity,
        message: Message,
        after_mutation: impl FnOnce(&Arc<InputOwnerSlot>),
        before_send: impl FnOnce(&Arc<InputOwnerSlot>),
    ) -> UserInputStart {
        self.try_begin_user_input_with_identity_inner(
            owner,
            message,
            None,
            after_mutation,
            before_send,
        )
    }

    fn try_begin_user_input_with_identity_inner(
        &self,
        owner: &AppStateLifecycleIdentity,
        message: Message,
        expected_uuid: Option<&str>,
        after_mutation: impl FnOnce(&Arc<InputOwnerSlot>),
        before_send: impl FnOnce(&Arc<InputOwnerSlot>),
    ) -> UserInputStart {
        if !is_original_user_message(&message) {
            return UserInputStart::Rejected {
                message,
                reason: UserInputRejection::InvalidMessage,
                error: "original user input required".into(),
            };
        }
        let mut inner = match self.inner.try_write() {
            Ok(inner) => inner,
            Err(std::sync::TryLockError::WouldBlock) => return UserInputStart::Busy(message),
            Err(std::sync::TryLockError::Poisoned(_)) => {
                return UserInputStart::Rejected {
                    message,
                    reason: UserInputRejection::StateUnavailable,
                    error: "input state unavailable".into(),
                };
            }
        };
        if !owner.matches_locked(self, &inner) {
            return UserInputStart::Rejected {
                message,
                reason: UserInputRejection::LifecycleChanged,
                error: "input lifecycle changed".into(),
            };
        }
        if let Some(fault) = &inner.history_write_fault {
            return UserInputStart::Rejected {
                message,
                reason: UserInputRejection::HistoryFaulted,
                error: format!("history persistence is faulted: {fault}"),
            };
        }
        if inner.message_history_ids.len() != inner.messages.len() {
            return UserInputStart::Rejected {
                message,
                reason: UserInputRejection::HistoryUnbound,
                error: "input history identities are incomplete".into(),
            };
        }
        if inner.message_history_ids.len() >= MAX_OBSERVED_MESSAGES {
            return UserInputStart::Rejected {
                message,
                reason: UserInputRejection::HistoryTooLarge,
                error: "input history identity observation exceeds its budget".into(),
            };
        }
        let uuid = expected_uuid
            .map(str::to_owned)
            .unwrap_or_else(crate::generate_transcript_uuid);
        let mut existing_position = None;
        for (position, identity) in inner.message_history_ids.iter().enumerate() {
            if identity.as_deref() == Some(uuid.as_str())
                && existing_position.replace(position).is_some()
            {
                return UserInputStart::Rejected {
                    message,
                    reason: UserInputRejection::IdentityConflict,
                    error: "input history identity is already ambiguous".into(),
                };
            }
        }
        if let Some(position) = existing_position {
            let exact_message = inner.messages.get(position) == Some(&message);
            return UserInputStart::Rejected {
                message,
                reason: UserInputRejection::IdentityConflict,
                error: if exact_message {
                    "identified input is already present; reconcile its original receipt".into()
                } else {
                    "identified input UUID is bound to different message content".into()
                },
            };
        }
        if let Some(path) = inner.history_path.clone() {
            let Some(source) = inner.history_source.clone() else {
                return UserInputStart::Rejected {
                    message,
                    reason: UserInputRejection::HistoryUnbound,
                    error: "input history source is missing".into(),
                };
            };
            if inner.history_flusher.as_ref().is_some_and(|flusher| {
                flusher.is_closed() && flusher.queue.initial_start_failure().is_some()
            }) {
                // No command was accepted by the failed startup; retrying its
                // owner registration cannot replay an input.
                inner.history_flusher = None;
            }
            if inner.history_flusher.is_none() {
                let Ok(handle) = tokio::runtime::Handle::try_current() else {
                    return UserInputStart::Rejected {
                        message,
                        reason: UserInputRejection::WriterUnavailable,
                        error: "input history writer runtime is unavailable".into(),
                    };
                };
                inner.history_flusher = Some(start_history_flusher(handle, path, source));
            }
            if inner
                .history_flusher
                .as_ref()
                .is_some_and(|flusher| flusher.is_closed())
            {
                let failure = inner
                    .history_flusher
                    .as_ref()
                    .and_then(|flusher| flusher.queue.initial_start_failure());
                if failure == Some(SlotError::Busy) {
                    return UserInputStart::Busy(message);
                }
                return UserInputStart::Rejected {
                    message,
                    reason: if failure == Some(SlotError::Full) {
                        UserInputRejection::OwnerCapacity
                    } else {
                        UserInputRejection::WriterUnavailable
                    },
                    error: "input history writer is unavailable".into(),
                };
            }
        } else if inner.history_flusher.is_some() || inner.history_source.is_some() {
            return UserInputStart::Rejected {
                message,
                reason: UserInputRejection::HistoryUnbound,
                error: "input history binding is incomplete".into(),
            };
        }
        // Reserve both the retained receipt slot and the runtime supervisor
        // before changing the user message or submitting its writer command.
        let slot = match reserve_owner() {
            Ok(slot) => slot,
            Err(SlotError::Busy) => return UserInputStart::Busy(message),
            Err(error) => {
                return UserInputStart::Rejected {
                    message,
                    reason: match error {
                        SlotError::Full => UserInputRejection::OwnerCapacity,
                        _ => UserInputRejection::OwnerUnavailable,
                    },
                    error: format!("original input owner unavailable: {error:?}"),
                };
            }
        };
        let mut reservation = InputReservation {
            slot: Arc::clone(&slot),
            attached: false,
        };
        let (start_owner, ready) = oneshot::channel::<()>();
        let (completed, result) = oneshot::channel::<Result<UserInputCommit, String>>();
        let owner_slot = Arc::clone(&slot);
        let guard = InputOwnerGuard {
            slot: Arc::clone(&slot),
            finished: false,
        };
        let future = async move {
            let mut guard = guard;
            if ready.await.is_err() {
                if owner_slot.intent.get().is_some() || owner_slot.original.get().is_some() {
                    owner_slot.stopped.store(true, Ordering::Release);
                } else {
                    release_owner(&owner_slot);
                }
                guard.finished = true;
                return;
            }
            let Some(original) = owner_slot.original.get().cloned() else {
                owner_slot.stopped.store(true, Ordering::Release);
                guard.finished = true;
                let _ = completed.send(Err("original input ticket is unavailable".into()));
                return;
            };
            let outcome = original.wait().await.map_err(|error| format!("{error:#}"));
            if outcome.is_ok() {
                owner_slot.success_settled.store(true, Ordering::SeqCst);
                if !owner_slot.observer_alive.load(Ordering::SeqCst)
                    && !owner_slot.retain_unknown.load(Ordering::Acquire)
                {
                    release_owner(&owner_slot);
                }
            } else {
                owner_slot.stopped.store(true, Ordering::Release);
                owner_slot.retain_unknown.store(true, Ordering::Release);
            }
            guard.finished = true;
            let _ = completed.send(outcome);
        };
        let _owner_id = match crate::history_flusher::spawn_input_owner(future) {
            Ok(id) => id,
            Err(SlotError::Busy) => return UserInputStart::Busy(message),
            Err(error) => {
                return UserInputStart::Rejected {
                    message,
                    reason: match error {
                        SlotError::Full => UserInputRejection::OwnerCapacity,
                        _ => UserInputRejection::OwnerUnavailable,
                    },
                    error: format!("original input owner unavailable: {error:?}"),
                };
            }
        };
        #[cfg(test)]
        let _ = slot.owner_id.set(_owner_id);
        if slot.stopped.load(Ordering::Acquire) {
            return UserInputStart::Rejected {
                message,
                reason: UserInputRejection::OwnerUnavailable,
                error: "original input owner stopped before admission".into(),
            };
        }
        let intended_attempt = crate::history_append_context::current(self, &inner);
        let intent = InputIntent {
            lifecycle: owner.clone(),
            uuid: uuid.clone(),
            attempt: intended_attempt.clone(),
            message: message.clone(),
        };
        if slot.intent.set(intent).is_err() {
            // Never release a slot whose identity cannot be established.
            reservation.attached = true;
            return UserInputStart::Rejected {
                message,
                reason: UserInputRejection::OwnerUnavailable,
                error: "original input owner intent is unavailable".into(),
            };
        }
        if expected_uuid.is_some() {
            match register_identified_owner(&uuid, &slot) {
                Ok(()) => {}
                Err(SlotError::Busy) => return UserInputStart::Busy(message),
                Err(error) => {
                    return UserInputStart::Rejected {
                        message,
                        reason: UserInputRejection::OwnerUnavailable,
                        error: format!("identified input owner unavailable: {error:?}"),
                    };
                }
            }
        }
        // From this point, unwinding or any unconfirmed step must retain the
        // original intent even before its writer receipt is installed.
        reservation.attached = true;
        let timestamp_ms = crate::now_millis();
        let parent_uuid = inner.last_history_uuid.clone();
        inner.conversation_started = true;
        inner.session_updated_at_ms = inner.session_updated_at_ms.max(timestamp_ms);
        inner.last_history_uuid = Some(uuid.clone());
        inner.message_revision = MessageRevision::default();
        inner.messages.push(message.clone());
        inner.message_history_ids.push(Some(uuid.clone()));
        after_mutation(&slot);
        Self::truncate_messages(&mut inner);
        let attempt = crate::history_append_context::record_append(self, &mut inner, &uuid, true);
        crate::history_append_context::remember(&mut inner, &uuid, attempt.clone());
        let Some(intent) = slot.intent.get() else {
            return UserInputStart::Unknown {
                message,
                error: "original input owner intent is missing".into(),
                uuid,
                attempt,
                pending: None,
            };
        };
        if intent.uuid != uuid
            || intent.attempt != attempt
            || !intent.lifecycle.matches_locked(self, &inner)
            || !matches!(
                &intent.message,
                Message::User {
                    origin: MessageOrigin::User,
                    ..
                }
            )
        {
            return UserInputStart::Unknown {
                message,
                error: "original input owner intent changed".into(),
                uuid,
                attempt,
                pending: None,
            };
        }
        let Some(position) = inner.message_history_ids.len().checked_sub(1) else {
            return UserInputStart::Unknown {
                message,
                error: "original input was not retained".into(),
                uuid,
                attempt,
                pending: None,
            };
        };
        if inner.message_history_ids[position].as_deref() != Some(uuid.as_str()) {
            return UserInputStart::Unknown {
                message,
                error: "original input identity was not retained".into(),
                uuid,
                attempt,
                pending: None,
            };
        }
        let expected = inner.messages.clone();
        let path = inner.history_path.clone();
        let source = inner.history_source.clone();
        let entry = HistoryEntry {
            web_sources: Vec::new(),
            history_attempt: attempt.clone(),
            session_id: inner.session_id.clone(),
            timestamp_ms,
            uuid: Some(uuid.clone()),
            parent_uuid,
            message,
        };
        let (queue, done, reply) = if let Some(flusher) = inner.history_flusher.as_ref() {
            let (done, reply) = oneshot::channel();
            (
                Some((Arc::clone(&flusher.queue), flusher.queue.current_epoch())),
                Some(done),
                Some(reply),
            )
        } else {
            (None, None, None)
        };
        let original = Arc::new(OriginalInput {
            state: self.clone(),
            lifecycle: owner.clone(),
            uuid: uuid.clone(),
            attempt: attempt.clone(),
            expected,
            position,
            path,
            source,
            queue,
            initial_work_claimed: AtomicBool::new(false),
            reply: AsyncMutex::new(match reply {
                Some(reply) => WriterReply::Waiting(reply),
                None => WriterReply::Confirmed(Box::new(MessageCommitConfirmation::ephemeral())),
            }),
        });
        if slot.original.set(Arc::clone(&original)).is_err() {
            // The slot is freshly allocated; any violation keeps this input
            // unknown rather than replacing another owner's receipt.
            return UserInputStart::Unknown {
                message: original
                    .expected
                    .get(position)
                    .expect("captured input exists")
                    .clone(),
                error: "original input owner slot is unavailable".into(),
                uuid,
                attempt,
                pending: None,
            };
        }
        reservation.attached = true;
        let pending = PendingUserInput {
            uuid: uuid.clone(),
            attempt: attempt.clone(),
            slot,
            result: Some(result),
        };
        let submit_error =
            if let (Some(flusher), Some(done)) = (inner.history_flusher.as_ref(), done) {
                if pending.slot.stopped.load(Ordering::Acquire) {
                    Some("input owner stopped before writer submission")
                } else {
                    let command = if expected_uuid.is_some() {
                        HistoryFlusherCommand::EntryWithIdentifiedCommit { entry, done }
                    } else {
                        HistoryFlusherCommand::EntryWithCommit { entry, done }
                    };
                    before_send(&pending.slot);
                    match flusher.send_queued(command) {
                        Ok(epoch)
                            if original
                                .queue
                                .as_ref()
                                .is_some_and(|(_, expected)| *expected == epoch) =>
                        {
                            None
                        }
                        Ok(_) => Some("input writer epoch changed during submission"),
                        Err(_) => Some("input writer stopped before accepting the original entry"),
                    }
                }
            } else {
                None
            };
        let owner_stopped = start_owner.send(()).is_err();
        if owner_stopped || submit_error.is_some() {
            return UserInputStart::Unknown {
                message: original
                    .expected
                    .get(position)
                    .expect("captured input exists")
                    .clone(),
                error: submit_error
                    .unwrap_or("original input owner stopped during handoff")
                    .into(),
                uuid,
                attempt,
                pending: Some(pending),
            };
        }
        UserInputStart::Accepted(pending)
    }
}

impl PendingUserInput {
    pub fn uuid(&self) -> &str {
        &self.uuid
    }
    pub fn attempt(&self) -> Option<&TurnAttemptIdentity> {
        self.attempt.as_ref()
    }

    /// Indicates only that the process-local original ticket slot is retained.
    pub fn ticket_is_retained(&self) -> bool {
        self.slot.original.get().is_some()
    }

    /// Waiting is observational. Losing this future never reissues its entry;
    /// the pre-reserved owner retains the original ticket until settlement.
    pub async fn wait(self) -> anyhow::Result<UserInputCommit> {
        Ok(self.wait_with_witness().await?.outcome())
    }

    pub async fn wait_with_witness(mut self) -> anyhow::Result<CommittedUserInput> {
        let receiver = self
            .result
            .take()
            .context("original input observation is unavailable")?;
        let owner_outcome = match receiver.await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(error)) => {
                self.slot.retain_unknown.store(true, Ordering::Release);
                anyhow::bail!("{error}");
            }
            Err(_) => {
                self.slot.retain_unknown.store(true, Ordering::Release);
                anyhow::bail!("input owner stopped; the original ticket remains unknown");
            }
        };
        let Some(original) = self.slot.original.get().cloned() else {
            self.slot.retain_unknown.store(true, Ordering::Release);
            anyhow::bail!("original input ticket is unavailable");
        };
        let observed = match original.wait().await {
            Ok(observed) => observed,
            Err(error) => {
                self.slot.retain_unknown.store(true, Ordering::Release);
                return Err(error);
            }
        };
        if observed != owner_outcome {
            self.slot.retain_unknown.store(true, Ordering::Release);
            anyhow::bail!("original input outcome changed");
        }
        release_owner(&self.slot);
        Ok(CommittedUserInput {
            outcome: observed,
            original,
        })
    }
}

impl Drop for PendingUserInput {
    fn drop(&mut self) {
        self.slot.observer_alive.store(false, Ordering::SeqCst);
        if self.slot.success_settled.load(Ordering::SeqCst)
            && !self.slot.retain_unknown.load(Ordering::Acquire)
        {
            release_owner(&self.slot);
        }
    }
}

impl OriginalInput {
    async fn wait(&self) -> anyhow::Result<UserInputCommit> {
        let outcome = {
            let mut reply = self.reply.lock().await;
            if let WriterReply::Waiting(receiver) = &mut *reply {
                *reply = match receiver.await {
                    Ok(Ok(confirmation)) => WriterReply::Confirmed(Box::new(confirmation)),
                    Ok(Err(error)) => WriterReply::Unknown(format!("{error:#}")),
                    Err(_) => WriterReply::Unknown("original input writer reply was lost".into()),
                };
            }
            match &*reply {
                WriterReply::Confirmed(confirmation) => match confirmation.outcome() {
                    MessageCommitOutcome::Committed => UserInputCommit::Durable,
                    MessageCommitOutcome::Ephemeral => UserInputCommit::Ephemeral,
                },
                WriterReply::Unknown(error) => anyhow::bail!("{error}"),
                WriterReply::Waiting(_) => unreachable!(),
            }
        };
        let mut delay = Duration::from_millis(5);
        loop {
            if self.try_validate_current()? {
                return Ok(outcome);
            }
            futures_timer::Delay::new(delay).await;
            delay = delay.saturating_mul(2).min(Duration::from_millis(250));
        }
    }

    fn try_validate_current(&self) -> anyhow::Result<bool> {
        let first = match self.state.inner.try_read() {
            Ok(inner) => inner,
            Err(std::sync::TryLockError::WouldBlock) => return Ok(false),
            Err(std::sync::TryLockError::Poisoned(_)) => anyhow::bail!("input state unavailable"),
        };
        let position = self.check_identity(&first)?;
        let current = first.messages.clone();
        let revision = first.message_revision.clone();
        drop(first);
        let actual = current.get(position).context("original input is missing")?;
        let expected = self
            .expected
            .get(self.position)
            .context("captured input is missing")?;
        ensure!(
            std::ptr::eq(actual, expected) || actual == expected,
            "original input content changed"
        );

        let second = match self.state.inner.try_read() {
            Ok(inner) => inner,
            Err(std::sync::TryLockError::WouldBlock) => return Ok(false),
            Err(std::sync::TryLockError::Poisoned(_)) => anyhow::bail!("input state unavailable"),
        };
        if second.message_revision != revision || self.check_identity(&second)? != position {
            return Ok(false);
        }
        Ok(true)
    }

    fn check_identity(&self, inner: &crate::AppStateInner) -> anyhow::Result<usize> {
        ensure!(
            self.lifecycle.matches_locked(&self.state, inner),
            "input lifecycle changed"
        );
        ensure!(
            inner.history_path == self.path,
            "input history source changed"
        );
        match (&self.source, &inner.history_source) {
            (None, None) => {}
            (Some(original), Some(current)) => ensure!(
                original.shares_binding(current),
                "input history binding changed"
            ),
            _ => anyhow::bail!("input history binding changed"),
        }
        match (&self.queue, &inner.history_flusher) {
            (Some((original, epoch)), Some(current)) => {
                ensure!(
                    Arc::ptr_eq(original, &current.queue) && original.current_epoch() == *epoch,
                    "input writer epoch changed"
                );
                ensure!(
                    !original.worker_is_unknown() && !original.worker_is_stopped(),
                    "input writer stopped"
                );
            }
            (None, None) => {}
            _ => anyhow::bail!("input writer changed"),
        }
        ensure!(
            inner.messages.len() == inner.message_history_ids.len(),
            "input identity metadata is incomplete"
        );
        ensure!(
            inner.message_history_ids.len() <= MAX_OBSERVED_MESSAGES,
            "input identity observation exceeds its budget"
        );
        let mut found = None;
        for (position, id) in inner.message_history_ids.iter().enumerate() {
            if id.as_deref() == Some(self.uuid.as_str()) {
                ensure!(found.is_none(), "input identity is ambiguous");
                found = Some(position);
            }
        }
        ensure!(
            inner.history_attempts.get(&self.uuid) == self.attempt,
            "input attempt changed"
        );
        found.context("original input is no longer retained")
    }
}
